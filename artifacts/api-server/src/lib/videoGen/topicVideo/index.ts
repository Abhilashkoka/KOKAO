import {
  db,
  tenantsTable,
  type VideoStoryboard,
  type VideoStoryboardScene,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../../logger";
import { VideoGenProviderError, type VideoAspect } from "../types";
import { generateTopicScript } from "./script";
import {
  splitIntoSentences,
  synthesizeNarration,
  type NarrationCue,
  type NarrationVoice,
} from "./narration";
import {
  stockCandidates,
  stockNotConfiguredError,
  collectStockCandidates,
  downloadStockClip,
  type StockSourceChoice,
  type StockClip,
} from "./stockSources";
import { composeTopicVideo, sceneDurations } from "./compose";
import { gateRenderPlan } from "../planGate";
import { isFeatureEnabled } from "../../featureFlags";
import {
  CHARACTER_SCENES_PER_PARAGRAPH,
  groupCuesIntoScenes,
  planSceneVisuals,
  generateCharacterSceneClips,
  generateSceneKeyframes,
  animateSceneKeyframes,
  type ScriptScene,
  type ScenePlanEntry,
} from "./characterScenes";
import { assignClipsToScenes } from "./visionRank";
import {
  AI_BROLL_SCENES_PER_PARAGRAPH,
  generateBrollClips,
  generateBrollStills,
  planBrollVisuals,
  stillsToClips,
} from "./aiBroll";
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
/** Other stock sources to try when the first one comes back empty. */
const STOCK_FALLBACK_LIMIT = 2;

export interface TopicVideoParams {
  tenantId: number;
  topic: string;
  aspectRatio: VideoAspect;
  voice: NarrationVoice;
  stockSource: StockSourceChoice;
  subtitles: boolean;
  /** "classic" sentence subtitles (default) or "dynamic" word-group captions. */
  captionStyle?: "classic" | "dynamic";
  paragraphCount: number;
  music?: Buffer | null;
  /** "stock" (default), "character" (locked-character AI scenes), or "ai"
   * (fully generated b-roll — owned imagery, no licensing questions). */
  visualsSource?: "stock" | "character" | "ai";
  characterId?: number | null;
  outfitId?: number | null;
  wardrobeNotes?: string | null;
  /** Brand-voice hint injected into the script prompt (brand kit). */
  brandVoice?: string | null;
  /** Structural guidance from a reference video (style profile). */
  referenceStyle?: string | null;
  /** Caption stroke accent ("0xRRGGBB") from the brand kit. */
  accentColor?: string | null;
  /** Brand logo bytes to watermark top-right. */
  watermark?: Buffer | null;
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
  const sources = (await stockCandidates(stockSource)).slice(0, 1 + STOCK_FALLBACK_LIMIT);
  if (sources.length === 0) throw stockNotConfiguredError(stockSource);
  const wanted = Math.max(1, Math.min(MAX_STOCK_CLIPS, neededScenes));

  const { def, clips: candidates } = await collectStockCandidates(
    sources,
    searchTerms,
    aspect,
    () => checkDeadline(startedAt),
  );
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

/** How many scenes a script of this many paragraphs is cut into. */
function sceneCountFor(perParagraph: number, paragraphCount: number): number {
  return perParagraph * Math.min(Math.max(Math.trunc(paragraphCount) || 1, 1), 3);
}

/**
 * Steps 1-2, shared by the straight-through render and the storyboard plan:
 * the tenant's model writes a script, then it is voiced sentence by sentence.
 * Voicing before anything visual is what lets a storyboard show exact scene
 * lengths instead of word-count estimates — the recording already exists, so
 * the cut points are measured rather than predicted.
 */
async function writeAndVoiceScript(params: {
  tenantId: number;
  topic: string;
  voice: NarrationVoice;
  paragraphCount: number;
  brandVoice?: string | null;
  referenceStyle?: string | null;
  startedAt: number;
  deadlineMs: number;
  onStage?: (stage: string) => void;
}): Promise<{
  tenantAiModel: string;
  model: string;
  searchTerms: string[];
  narration: Awaited<ReturnType<typeof synthesizeNarration>>;
}> {
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
    topic: params.topic,
    paragraphCount: params.paragraphCount,
    brandVoice: params.brandVoice ?? null,
    referenceStyle: params.referenceStyle ?? null,
  });
  checkDeadline(params.startedAt, params.deadlineMs);

  // 2) Sentence-level narration with exact timings.
  const sentences = splitIntoSentences(script);
  if (sentences.length === 0) {
    throw new VideoGenProviderError("The AI returned an empty script. Please try again.");
  }
  params.onStage?.("Voicing the narration");
  const narration = await synthesizeNarration(sentences, params.voice);
  checkDeadline(params.startedAt, params.deadlineMs);

  return { tenantAiModel: tenant.aiModel, model, searchTerms, narration };
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

  const { tenantAiModel, model, searchTerms, narration } = await writeAndVoiceScript({
    tenantId: params.tenantId,
    topic,
    voice: params.voice,
    paragraphCount: params.paragraphCount,
    brandVoice: params.brandVoice ?? null,
    referenceStyle: params.referenceStyle ?? null,
    startedAt,
    deadlineMs,
    onStage: params.onStage,
  });

  // 3) Visuals: locked-character AI scenes, generated b-roll, or stock.
  let clips: Buffer[];
  let sceneMap = null;
  let provider: string;
  if (aiMode) {
    params.onStage?.("Creating AI imagery");
    const scenes = groupCuesIntoScenes(
      narration.cues,
      narration.totalDurationSec,
      sceneCountFor(AI_BROLL_SCENES_PER_PARAGRAPH, params.paragraphCount),
    );
    const generated = await generateBrollClips({
      tenantAiModel,
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
      tenantAiModel,
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
        tenantAiModel,
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

  // 3b) Pre-render plan gate: score the cut rhythm while it is still cheap to
  // change, repair held shots, and refuse a plan recutting cannot save.
  const plannedScenes =
    sceneMap && sceneMap.length > 0
      ? sceneMap
      : sceneDurations(narration.cues, narration.totalDurationSec).map((durationSec, i) => ({
          clipIndex: i % clips.length,
          durationSec,
        }));
  // Gated by the Plan Gate kill switch (fail-open): when off, plans render
  // exactly as they did before the gate existed — no repair, no refusal.
  const planGateEnabled = await isFeatureEnabled("planGate").catch(() => true);
  const gate = planGateEnabled
    ? gateRenderPlan({
        scenes: plannedScenes,
        clipCount: clips.length,
        // AI b-roll animates generated stills; stock and character clips move.
        stillImagery: aiMode,
        cueStartsSec: narration.cues.map((cue) => cue.startSec),
        totalDurationSec: narration.totalDurationSec,
        subtitles: params.subtitles,
      })
    : null;
  if (gate?.blocked) {
    throw new VideoGenProviderError(gate.blocked);
  }
  if (gate && gate.warnings.length > 0) {
    logger.warn(
      {
        topic,
        visualsSource: params.visualsSource ?? "stock",
        risk: gate.risk,
        revised: gate.revised,
        warnings: gate.warnings,
      },
      "pre-render plan gate flagged the scene layout",
    );
  }

  // 4) Compose.
  params.onStage?.("Composing the video");
  const buffer = await composeTopicVideo({
    clips,
    narrationWav: narration.wav,
    cues: narration.cues,
    totalDurationSec: narration.totalDurationSec,
    aspectRatio: params.aspectRatio,
    subtitles: params.subtitles,
    captionStyle: params.captionStyle ?? "classic",
    accentColor: params.accentColor ?? null,
    watermark: params.watermark ?? null,
    music: params.music ?? null,
    sceneMap: gate ? gate.scenes : (sceneMap ?? null),
  });
  return { buffer, provider, model, durationSec: narration.totalDurationSec };
}

/** Resolve the character and the costume plan for a set of narration scenes.
 * Shared by the straight-through character render and the storyboard plan. */
async function planCharacterScenes(params: {
  tenantId: number;
  tenantAiModel: string;
  topic: string;
  characterId: number;
  outfitId: number | null;
  wardrobeNotes: string;
  scenes: ScriptScene[];
}): Promise<{
  detail: NonNullable<Awaited<ReturnType<typeof getCharacterDetail>>>;
  plan: ScenePlanEntry[];
}> {
  const detail = await getCharacterDetail(params.tenantId, params.characterId);
  if (!detail) {
    throw new VideoGenProviderError("The selected character no longer exists.");
  }
  const lockedOutfit = resolveOutfit(detail, params.outfitId);
  if (!lockedOutfit) {
    throw new VideoGenProviderError("The selected outfit no longer exists.");
  }
  const plan = await planSceneVisuals({
    tenantAiModel: params.tenantAiModel,
    topic: params.topic,
    character: detail.character,
    outfits: detail.outfits,
    lockedOutfitId: lockedOutfit.id,
    wardrobeNotes: params.wardrobeNotes,
    scenes: params.scenes,
  });
  return { detail, plan };
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
  cues: NarrationCue[];
  totalDurationSec: number;
}): Promise<{
  clips: Buffer[];
  sceneMap: import("./compose").SceneSegment[];
  provider: string;
}> {
  const scenes = groupCuesIntoScenes(
    params.cues,
    params.totalDurationSec,
    sceneCountFor(CHARACTER_SCENES_PER_PARAGRAPH, params.paragraphCount),
  );
  const { detail, plan } = await planCharacterScenes({ ...params, scenes });
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

/* ------------------------------------------------------------------------- *
 * Storyboard: the same pipeline, cut in half at its cheapest point.
 *
 * The plan half writes the script, voices it, cuts it into scenes, plans each
 * scene's prompt and generates ONE still per scene. Those stills are not
 * throwaway previews — they are the exact images the render half animates, so
 * a reviewed video generates no image twice. Only the expensive step
 * (image-to-video, or the Ken Burns encode) waits behind the user's approval.
 * ------------------------------------------------------------------------- */

/** Scene lengths come from the voiced narration, so they cannot be edited
 * without desyncing the audio. Kept as a named constant because the PATCH
 * route and the studio both key off it. */
const NARRATION_TIMELINE_LOCKED = true;

export interface StoryboardPlanParams {
  tenantId: number;
  topic: string;
  aspectRatio: VideoAspect;
  voice: NarrationVoice;
  paragraphCount: number;
  /** Only "character" and "ai" plan reviewable scenes; stock renders straight
   * through (its visuals are searched, not prompted). */
  visualsSource: "character" | "ai";
  characterId?: number | null;
  outfitId?: number | null;
  wardrobeNotes?: string | null;
  brandVoice?: string | null;
  referenceStyle?: string | null;
  /** Persists narration audio and preview stills to tenant storage. */
  upload: (bytes: Buffer, contentType: string) => Promise<string>;
  onStage?: (stage: string) => void;
}

/** Plan a topic video and stop: everything up to (but not including) the
 * expensive per-scene generation. */
export async function planTopicStoryboard(
  params: StoryboardPlanParams,
): Promise<VideoStoryboard> {
  const startedAt = Date.now();
  const characterMode = params.visualsSource === "character";
  const deadlineMs = characterMode
    ? CHARACTER_VIDEO_TOTAL_DEADLINE_MS
    : AI_BROLL_TOTAL_DEADLINE_MS;
  const topic = params.topic.trim();
  if (!topic) {
    throw new VideoGenProviderError("A topic is required.");
  }

  const { tenantAiModel, model, narration } = await writeAndVoiceScript({
    tenantId: params.tenantId,
    topic,
    voice: params.voice,
    paragraphCount: params.paragraphCount,
    brandVoice: params.brandVoice ?? null,
    referenceStyle: params.referenceStyle ?? null,
    startedAt,
    deadlineMs,
    onStage: params.onStage,
  });

  const scenes = groupCuesIntoScenes(
    narration.cues,
    narration.totalDurationSec,
    sceneCountFor(
      characterMode ? CHARACTER_SCENES_PER_PARAGRAPH : AI_BROLL_SCENES_PER_PARAGRAPH,
      params.paragraphCount,
    ),
  );

  params.onStage?.("Sketching the storyboard");
  let visuals: string[];
  let outfitIds: (number | null)[];
  let stills: Buffer[];
  let provider: string;
  if (characterMode) {
    const { detail, plan } = await planCharacterScenes({
      tenantId: params.tenantId,
      tenantAiModel,
      topic,
      characterId: params.characterId ?? 0,
      outfitId: params.outfitId ?? null,
      wardrobeNotes: params.wardrobeNotes ?? "",
      scenes,
    });
    checkDeadline(startedAt, deadlineMs);
    visuals = plan.map((entry) => entry.visual);
    outfitIds = plan.map((entry) => entry.outfitId);
    stills = await generateSceneKeyframes({
      tenantId: params.tenantId,
      character: detail.character,
      outfits: detail.outfits,
      plan,
      aspectRatio: params.aspectRatio,
    });
    provider = "openai";
  } else {
    visuals = await planBrollVisuals({ tenantAiModel, topic, scenes });
    outfitIds = scenes.map(() => null);
    checkDeadline(startedAt, deadlineMs);
    const generated = await generateBrollStills({
      prompts: visuals,
      aspectRatio: params.aspectRatio,
    });
    stills = generated.images;
    provider = generated.provider;
  }
  checkDeadline(startedAt, deadlineMs);

  params.onStage?.("Saving the storyboard");
  const audioPath = await params.upload(narration.wav, "audio/wav");
  const previewPaths = await Promise.all(
    stills.map((still) =>
      // A preview that fails to upload leaves the scene without a thumbnail
      // rather than sinking a plan the user could still have approved.
      params.upload(still, "image/png").catch((err) => {
        logger.warn({ err }, "storyboard preview upload failed");
        return null;
      }),
    ),
  );

  return {
    version: 1,
    visualsSource: params.visualsSource,
    timelineLocked: NARRATION_TIMELINE_LOCKED,
    model,
    provider,
    regenerations: 0,
    narration: {
      audioPath,
      totalDurationSec: narration.totalDurationSec,
      cues: narration.cues.map((cue) => ({
        text: cue.text,
        startSec: cue.startSec,
        endSec: cue.endSec,
      })),
    },
    scenes: scenes.map((scene, i) => ({
      id: `s${i + 1}`,
      text: scene.text,
      visual: visuals[i] ?? scene.text,
      durationSec: scene.durationSec,
      previewPath: previewPaths[i] ?? null,
      outfitId: outfitIds[i] ?? null,
    })),
  };
}

/** Render an approved storyboard: animate the stills the plan already made,
 * then compose against the narration it already voiced. */
export async function renderTopicStoryboard(params: {
  storyboard: VideoStoryboard;
  aspectRatio: VideoAspect;
  subtitles: boolean;
  captionStyle?: "classic" | "dynamic";
  music?: Buffer | null;
  accentColor?: string | null;
  watermark?: Buffer | null;
  /** Reads narration audio and preview stills back from tenant storage. */
  load: (objectPath: string) => Promise<Buffer>;
  onStage?: (stage: string) => void;
}): Promise<TopicVideoResult> {
  const startedAt = Date.now();
  const board = params.storyboard;
  const characterMode = board.visualsSource === "character";
  const deadlineMs = characterMode
    ? CHARACTER_VIDEO_TOTAL_DEADLINE_MS
    : AI_BROLL_TOTAL_DEADLINE_MS;
  if (board.scenes.length === 0) {
    throw new VideoGenProviderError("This storyboard has no scenes.");
  }
  // Topic videos are cut against a recording; the other engines voice nothing
  // and carry a null narration, so they never reach this renderer.
  const narration = board.narration;
  if (!narration) {
    throw new VideoGenProviderError("This storyboard has no narration to cut against.");
  }

  params.onStage?.("Loading your storyboard");
  const narrationWav = await params.load(narration.audioPath);
  const stills = await Promise.all(
    board.scenes.map(async (scene) => {
      if (!scene.previewPath) return null;
      return params.load(scene.previewPath).catch(() => null);
    }),
  );
  if (stills.some((still) => still === null)) {
    // The plan's stills ARE the render's inputs, so a missing one cannot be
    // worked around here — regenerating it would silently change the frame the
    // user approved. The runner refunds and the user can start again.
    throw new VideoGenProviderError(
      "Some storyboard images are no longer available. Please start a new video.",
    );
  }
  checkDeadline(startedAt, deadlineMs);

  const scenes: ScriptScene[] = board.scenes.map((scene, i) => ({
    firstCue: i,
    lastCue: i,
    durationSec: scene.durationSec,
    text: scene.text,
  }));

  let clips: Buffer[];
  let sceneMap;
  let provider = board.provider ?? "ai";
  if (characterMode) {
    params.onStage?.("Filming your character");
    const animated = await animateSceneKeyframes({
      keyframes: stills as Buffer[],
      plan: board.scenes.map((scene) => ({
        visual: scene.visual,
        outfitId: scene.outfitId ?? 0,
      })),
      scenes,
      aspectRatio: params.aspectRatio,
    });
    clips = animated.clips;
    sceneMap = animated.sceneMap;
    provider = animated.provider;
  } else {
    params.onStage?.("Animating your storyboard");
    const rendered = await stillsToClips({
      images: stills as Buffer[],
      scenes,
      aspectRatio: params.aspectRatio,
    });
    clips = rendered.clips;
    sceneMap = rendered.sceneMap;
  }
  checkDeadline(startedAt, deadlineMs);

  const cues = narration.cues;
  const planGateEnabled = await isFeatureEnabled("planGate").catch(() => true);
  const gate = planGateEnabled
    ? gateRenderPlan({
        scenes: sceneMap,
        clipCount: clips.length,
        stillImagery: !characterMode,
        cueStartsSec: cues.map((cue) => cue.startSec),
        totalDurationSec: narration.totalDurationSec,
        subtitles: params.subtitles,
      })
    : null;
  if (gate?.blocked) {
    throw new VideoGenProviderError(gate.blocked);
  }
  if (gate && gate.warnings.length > 0) {
    logger.warn(
      { visualsSource: board.visualsSource, risk: gate.risk, warnings: gate.warnings },
      "pre-render plan gate flagged the approved storyboard",
    );
  }

  params.onStage?.("Composing the video");
  const buffer = await composeTopicVideo({
    clips,
    narrationWav,
    cues,
    totalDurationSec: narration.totalDurationSec,
    aspectRatio: params.aspectRatio,
    subtitles: params.subtitles,
    captionStyle: params.captionStyle ?? "classic",
    accentColor: params.accentColor ?? null,
    watermark: params.watermark ?? null,
    music: params.music ?? null,
    sceneMap: gate ? gate.scenes : sceneMap,
  });
  return { buffer, provider, model: board.model ?? "", durationSec: narration.totalDurationSec };
}

/** Regenerate one scene's preview still from an edited prompt. Returns the new
 * /objects/... path. Character scenes stay identity-anchored on their outfit's
 * reference photo, exactly as the plan phase generated them. */
export async function regenerateStoryboardPreview(params: {
  tenantId: number;
  storyboard: VideoStoryboard;
  scene: VideoStoryboardScene;
  aspectRatio: VideoAspect;
  characterId?: number | null;
  upload: (bytes: Buffer, contentType: string) => Promise<string>;
}): Promise<string> {
  if (params.storyboard.visualsSource === "character") {
    const detail = await getCharacterDetail(params.tenantId, params.characterId ?? 0);
    if (!detail) {
      throw new VideoGenProviderError("The selected character no longer exists.");
    }
    const [still] = await generateSceneKeyframes({
      tenantId: params.tenantId,
      character: detail.character,
      outfits: detail.outfits,
      plan: [
        {
          visual: params.scene.visual,
          // resolveOutfit falls back to the default outfit, so a wardrobe entry
          // deleted since planning cannot strand the scene.
          outfitId: resolveOutfit(detail, params.scene.outfitId)?.id ?? 0,
        },
      ],
      aspectRatio: params.aspectRatio,
    });
    return params.upload(still!, "image/png");
  }
  const { images } = await generateBrollStills({
    prompts: [params.scene.visual],
    aspectRatio: params.aspectRatio,
  });
  return params.upload(images[0]!, "image/png");
}
