import { db, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../../logger";
import { VideoGenProviderError, type VideoAspect } from "../types";
import { generateTopicScript } from "./script";
import { splitIntoSentences, synthesizeNarration, type NarrationVoice } from "./narration";
import {
  resolveStockSource,
  searchStockClips,
  downloadStockClip,
  type StockSourceChoice,
  type StockClip,
} from "./stockSources";
import { composeTopicVideo, sceneDurations } from "./compose";
import {
  CHARACTER_SCENES_PER_PARAGRAPH,
  groupCuesIntoScenes,
  planSceneVisuals,
  generateCharacterSceneClips,
} from "./characterScenes";
import { assignClipsToScenes } from "./visionRank";
import { AI_BROLL_SCENES_PER_PARAGRAPH, generateBrollClips } from "./aiBroll";
import { getCharacterDetail, resolveOutfit } from "../../characters";

export { NARRATION_VOICES, type NarrationVoice } from "./narration";
export {
  STOCK_SOURCES,
  getStockSourceDef,
  isStockSourceConfigured,
  getStockKeySource,
  setStoredStockKey,
  clearStoredStockKey,
  type StockSourceChoice,
  type StockSourceDef,
  type StockKeySource,
} from "./stockSources";

/**
 * Topic to Video: topic → AI script → stock footage → TTS narration →
 * subtitles → one composed MP4. The pipeline design is ported from
 * MoneyPrinterTurbo (MIT, https://github.com/harry0703/MoneyPrinterTurbo),
 * reimplemented natively on this codebase's textGen routing, OpenAI audio
 * integration, and ffmpeg composition.
 */

/** Overall wall-clock budget for one topic video (LLM + TTS + downloads + encode). */
export const TOPIC_VIDEO_TOTAL_DEADLINE_MS = 10 * 60 * 1000;
/** Character videos generate every scene with AI, so they get a longer leash. */
export const CHARACTER_VIDEO_TOTAL_DEADLINE_MS = 25 * 60 * 1000;
/** AI b-roll generates one image per scene — between the two. */
export const AI_BROLL_TOTAL_DEADLINE_MS = 15 * 60 * 1000;

/** Distinct stock clips to download; scenes cycle through them. */
const MAX_STOCK_CLIPS = 6;

export interface TopicVideoParams {
  tenantId: number;
  topic: string;
  aspectRatio: VideoAspect;
  voice: NarrationVoice;
  stockSource: StockSourceChoice;
  subtitles: boolean;
  paragraphCount: number;
  music?: Buffer | null;
  /** "stock" (default), "character" (locked-character AI scenes), or "ai"
   * (fully generated b-roll — owned imagery, no licensing questions). */
  visualsSource?: "stock" | "character" | "ai";
  characterId?: number | null;
  outfitId?: number | null;
  wardrobeNotes?: string | null;
  /** Live progress reporting ("Writing the script", ...); optional. */
  onStage?: (stage: string) => void;
}

export interface TopicVideoResult {
  buffer: Buffer;
  /** The stock source that supplied the footage. */
  provider: string;
  /** The text model that wrote the script. */
  model: string;
  /** Narration length the composition was built around (QA gate reference). */
  durationSec: number;
}

function checkDeadline(startedAt: number, deadlineMs = TOPIC_VIDEO_TOTAL_DEADLINE_MS): void {
  if (Date.now() - startedAt > deadlineMs) {
    throw new VideoGenProviderError(
      "Topic video generation timed out. Try a shorter length, or try again.",
    );
  }
}

/**
 * Gather up to MAX_STOCK_CLIPS distinct clips, round-robining across search
 * terms so the footage follows the script's visual order. Search or download
 * failures for one term never sink the job while any clip is available.
 */
async function gatherStockClips(
  stockSource: StockSourceChoice,
  searchTerms: string[],
  aspect: VideoAspect,
  neededScenes: number,
  startedAt: number,
  ranking: { tenantAiModel: string; topic: string; sceneTexts: string[] } | null,
): Promise<{ clips: Buffer[]; provider: string; sceneToClip: number[] | null }> {
  const { def, apiKey } = await resolveStockSource(stockSource);
  const wanted = Math.max(1, Math.min(MAX_STOCK_CLIPS, neededScenes));

  const perTerm: StockClip[][] = [];
  for (const term of searchTerms) {
    checkDeadline(startedAt);
    try {
      perTerm.push(await searchStockClips(def, apiKey, term, aspect));
    } catch (err) {
      logger.warn({ err, term, source: def.id }, "stock search failed for term");
      perTerm.push([]);
    }
  }

  // Interleave: first candidate of each term, then second of each, ...
  const seenUrls = new Set<string>();
  const candidates: StockClip[] = [];
  const deepest = Math.max(0, ...perTerm.map((list) => list.length));
  for (let depth = 0; depth < deepest; depth++) {
    for (const list of perTerm) {
      const clip = list[depth];
      if (clip && !seenUrls.has(clip.url)) {
        seenUrls.add(clip.url);
        candidates.push(clip);
      }
    }
  }
  if (candidates.length === 0) {
    throw new VideoGenProviderError(
      `No stock footage found on ${def.label} for this topic. Try rephrasing it.`,
    );
  }

  // Vision ranking: one call maps every scene to the candidate whose actual
  // FOOTAGE fits it best (thumbnails shown to the tenant's vision model).
  // Strictly fail-soft — null keeps the interleaved search order.
  const assignment = ranking
    ? await assignClipsToScenes({
        tenantAiModel: ranking.tenantAiModel,
        topic: ranking.topic,
        sceneTexts: ranking.sceneTexts,
        candidates,
      })
    : null;

  // Download order: the ranked picks (unique, first-appearance order) when
  // ranking succeeded, else the interleaved search order.
  const downloadOrder: number[] = [];
  if (assignment) {
    for (const index of assignment.sceneToCandidate) {
      if (!downloadOrder.includes(index)) downloadOrder.push(index);
    }
  } else {
    candidates.forEach((_, index) => downloadOrder.push(index));
  }

  const clips: Buffer[] = [];
  const slotByCandidate = new Map<number, number>();
  for (const candidateIndex of downloadOrder) {
    if (clips.length >= wanted) break;
    checkDeadline(startedAt);
    try {
      clips.push(await downloadStockClip(candidates[candidateIndex]!));
      slotByCandidate.set(candidateIndex, clips.length - 1);
    } catch (err) {
      logger.warn(
        { err, url: candidates[candidateIndex]!.url },
        "stock clip download failed; trying next",
      );
    }
  }
  if (clips.length === 0) {
    throw new VideoGenProviderError(
      `Could not download any stock footage from ${def.label}. Please try again.`,
    );
  }

  // Per-scene clip slots; scenes whose ranked pick failed to download cycle
  // through what DID download, matching the old behavior.
  const sceneToClip = assignment
    ? assignment.sceneToCandidate.map(
        (candidateIndex, i) => slotByCandidate.get(candidateIndex) ?? i % clips.length,
      )
    : null;
  return { clips, provider: def.id, sceneToClip };
}

export async function generateTopicVideo(params: TopicVideoParams): Promise<TopicVideoResult> {
  const startedAt = Date.now();
  const characterMode = params.visualsSource === "character";
  const aiMode = params.visualsSource === "ai";
  const deadlineMs = characterMode
    ? CHARACTER_VIDEO_TOTAL_DEADLINE_MS
    : aiMode
      ? AI_BROLL_TOTAL_DEADLINE_MS
      : TOPIC_VIDEO_TOTAL_DEADLINE_MS;
  const topic = params.topic.trim();
  if (!topic) {
    throw new VideoGenProviderError("A topic is required.");
  }

  const tenant = (
    await db.select().from(tenantsTable).where(eq(tenantsTable.id, params.tenantId)).limit(1)
  )[0];
  if (!tenant) {
    throw new VideoGenProviderError("Tenant not found.");
  }

  // 1) Script + ordered stock search terms in one completion.
  params.onStage?.("Writing the script");
  const { script, searchTerms, model } = await generateTopicScript({
    tenantAiModel: tenant.aiModel,
    topic,
    paragraphCount: params.paragraphCount,
  });
  checkDeadline(startedAt, deadlineMs);

  // 2) Sentence-level narration with exact timings.
  const sentences = splitIntoSentences(script);
  if (sentences.length === 0) {
    throw new VideoGenProviderError("The AI returned an empty script. Please try again.");
  }
  params.onStage?.("Voicing the narration");
  const narration = await synthesizeNarration(sentences, params.voice);
  checkDeadline(startedAt, deadlineMs);

  // 3) Visuals: locked-character AI scenes, generated b-roll, or stock.
  let clips: Buffer[];
  let sceneMap = null;
  let provider: string;
  if (aiMode) {
    params.onStage?.("Creating AI imagery");
    const sceneCount =
      AI_BROLL_SCENES_PER_PARAGRAPH *
      Math.min(Math.max(Math.trunc(params.paragraphCount) || 1, 1), 3);
    const scenes = groupCuesIntoScenes(
      narration.cues,
      narration.totalDurationSec,
      sceneCount,
    );
    const generated = await generateBrollClips({
      tenantAiModel: tenant.aiModel,
      topic,
      scenes,
      aspectRatio: params.aspectRatio,
    });
    clips = generated.clips;
    sceneMap = generated.sceneMap;
    provider = generated.provider;
  } else if (characterMode) {
    params.onStage?.("Filming your character");
    const generated = await generateCharacterStoryClips({
      tenantId: params.tenantId,
      tenantAiModel: tenant.aiModel,
      topic,
      characterId: params.characterId ?? 0,
      outfitId: params.outfitId ?? null,
      wardrobeNotes: params.wardrobeNotes ?? "",
      paragraphCount: params.paragraphCount,
      aspectRatio: params.aspectRatio,
      cues: narration.cues,
      totalDurationSec: narration.totalDurationSec,
    });
    clips = generated.clips;
    sceneMap = generated.sceneMap;
    provider = generated.provider;
  } else {
    params.onStage?.("Finding the right footage");
    const stock = await gatherStockClips(
      params.stockSource,
      searchTerms,
      params.aspectRatio,
      narration.cues.length,
      startedAt,
      {
        tenantAiModel: tenant.aiModel,
        topic,
        sceneTexts: narration.cues.map((cue) => cue.text),
      },
    );
    clips = stock.clips;
    provider = stock.provider;
    // A successful ranking pins each sentence to its best-matching clip.
    if (stock.sceneToClip) {
      sceneMap = sceneDurations(narration.cues, narration.totalDurationSec).map(
        (durationSec, i) => ({
          clipIndex: stock.sceneToClip![i] ?? i % clips.length,
          durationSec,
        }),
      );
    }
  }
  checkDeadline(startedAt, deadlineMs);

  // 4) Compose.
  params.onStage?.("Composing the video");
  const buffer = await composeTopicVideo({
    clips,
    narrationWav: narration.wav,
    cues: narration.cues,
    totalDurationSec: narration.totalDurationSec,
    aspectRatio: params.aspectRatio,
    subtitles: params.subtitles,
    music: params.music ?? null,
    sceneMap,
  });
  return { buffer, provider, model, durationSec: narration.totalDurationSec };
}

/** Script scenes → wardrobe plan → identity-locked clips, for character mode. */
async function generateCharacterStoryClips(params: {
  tenantId: number;
  tenantAiModel: string;
  topic: string;
  characterId: number;
  outfitId: number | null;
  wardrobeNotes: string;
  paragraphCount: number;
  aspectRatio: VideoAspect;
  cues: import("./narration").NarrationCue[];
  totalDurationSec: number;
}): Promise<{
  clips: Buffer[];
  sceneMap: import("./compose").SceneSegment[];
  provider: string;
}> {
  const detail = await getCharacterDetail(params.tenantId, params.characterId);
  if (!detail) {
    throw new VideoGenProviderError("The selected character no longer exists.");
  }
  const lockedOutfit = resolveOutfit(detail, params.outfitId);
  if (!lockedOutfit) {
    throw new VideoGenProviderError("The selected outfit no longer exists.");
  }
  const sceneCount =
    CHARACTER_SCENES_PER_PARAGRAPH *
    Math.min(Math.max(Math.trunc(params.paragraphCount) || 1, 1), 3);
  const scenes = groupCuesIntoScenes(params.cues, params.totalDurationSec, sceneCount);
  const plan = await planSceneVisuals({
    tenantAiModel: params.tenantAiModel,
    topic: params.topic,
    character: detail.character,
    outfits: detail.outfits,
    lockedOutfitId: lockedOutfit.id,
    wardrobeNotes: params.wardrobeNotes,
    scenes,
  });
  const generated = await generateCharacterSceneClips({
    tenantId: params.tenantId,
    character: detail.character,
    outfits: detail.outfits,
    plan,
    scenes,
    aspectRatio: params.aspectRatio,
  });
  return { clips: generated.clips, sceneMap: generated.sceneMap, provider: generated.provider };
}
