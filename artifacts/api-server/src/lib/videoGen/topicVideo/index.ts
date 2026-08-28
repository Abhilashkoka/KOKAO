import {
  db,
  tenantsTable,
  type VideoStoryboard,
  type VideoStoryboardScene,
  type VideoTemplateRuntimeSettings,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../../logger";
import { VideoGenProviderError, type VideoAspect } from "../types";
import type { PromptVariantKey } from "@workspace/db";
import { generateTopicScript, narrationSentenceWordBounds } from "./script";
import {
  splitIntoSentences,
  buildWav,
  parseWav,
  synthesizeNarration,
  type NarrationCue,
  type NarrationVoice,
} from "./narration";
import type { ClonedVoiceRef } from "../../voiceClone";
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
import type { SuppliedPlan } from "./suppliedPlan";
import {
  AI_BROLL_SCENES_PER_PARAGRAPH,
  animateBrollStills,
  generateBrollClips,
  generateBrollStills,
  planBrollVisuals,
  stillsToClips,
} from "./aiBroll";
import {
  characterDetailFromSnapshot,
  getCharacterDetail,
  resolveOutfit,
} from "../../characters";
import type { ResolvedModelOptions } from "../modelCatalog";
import type { Cinematography } from "../cinematography";
import { appendCreativeFragment } from "../creativeBrief";

export { NARRATION_VOICES, resolveNarrationVoice, type NarrationVoice } from "./narration";
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
  /** Resolved long-form settings. Null/absent preserves legacy behavior. */
  templateRuntime?: VideoTemplateRuntimeSettings | null;
  music?: Buffer | null;
  /** "stock" (default), "character" (locked-character AI scenes), "ai"
   * (fully generated b-roll — owned imagery, no licensing questions), or
   * "ai_video" (the same generated b-roll animated into real AI motion
   * clips). */
  visualsSource?: "stock" | "character" | "ai" | "ai_video";
  characterId?: number | null;
  outfitId?: number | null;
  wardrobeNotes?: string | null;
  characterSnapshot?: import("@workspace/db").VideoJobOptions["characterSnapshot"];
  /** Brand-voice hint injected into the script prompt (brand kit). */
  brandVoice?: string | null;
  /** Cloned brand voice for narration (already kill-switch gated by the caller);
   * stock voices remain the whole-track fallback. */
  clonedVoice?: ClonedVoiceRef | null;
  /** Structural guidance from a reference video (style profile). */
  referenceStyle?: string | null;
  /** Treatment-only fragment compiled from the enqueue-time creative brief. */
  creativeVisualGuidance?: string | null;
  /** Prompt Kit script variant; null keeps the flow's base prompt. */
  scriptVariant?: PromptVariantKey | null;
  /** Caption stroke accent ("0xRRGGBB") from the brand kit. */
  accentColor?: string | null;
  /** Brand logo bytes to watermark top-right. */
  watermark?: Buffer | null;
  /** Reuse a saved AI scene plan instead of planning fresh ("ai" and
   * "character" visuals only; validated at the route). */
  suppliedPlan?: SuppliedPlan | null;
  /** Job-level camera-move preset applied to every animated scene
   * (lib/videoGen/motionPresets.ts). Null = the governed default. */
  motionPreset?: string | null;
  /** Job-level optics; null = nothing added to the prompt. */
  cinematography?: Cinematography | null;
  /** Job-level sampling seed; null = the provider's choice. */
  seed?: number | null;
  /** Picked catalog model and its resolved flags; omitted = platform default. */
  modelOptions?: ResolvedModelOptions;
  /** Live progress reporting ("Writing the script", ...); optional. */
  onStage?: (stage: string) => void;
  onCheckpoint?: (args: { sceneIndex: number; buffer: Buffer; provider: string; model: string; durationSec: number }) => Promise<void>;
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

/** The raw plan to hand a planner, or null when the supplied plan targets the
 * other flow. Flow mismatches are rejected at the route; this guard keeps a
 * stale options row from ever steering the wrong planner. */
function suppliedPlanRawFor(
  suppliedPlan: SuppliedPlan | null,
  flow: SuppliedPlan["flow"],
): unknown {
  return suppliedPlan && suppliedPlan.flow === flow ? suppliedPlan.raw : undefined;
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

export function plannedSceneCount(
  runtime: VideoTemplateRuntimeSettings | null | undefined,
  totalDurationSec: number,
  legacyCount: number,
): number {
  if (!runtime) return legacyCount;
  const idealDuration =
    (runtime.minSceneDurationSeconds + runtime.maxSceneDurationSeconds) / 2;
  const ideal = Math.round(totalDurationSec / idealDuration);
  const minimumForDuration = Math.ceil(totalDurationSec / runtime.maxSceneDurationSeconds);
  const maximumForDuration = Math.max(
    1,
    Math.floor(totalDurationSec / runtime.minSceneDurationSeconds),
  );
  // Never manufacture more work than the persisted/reserved cap. Callers
  // validate feasibility against real cue boundaries before visual providers.
  return Math.min(
    runtime.maxSceneCount,
    Math.max(runtime.minSceneCount, minimumForDuration, Math.min(maximumForDuration, ideal)),
  );
}

/**
 * Partition measured narration at cue boundaries while honoring the template's
 * exact scene-duration and scene-count bounds. A dynamic program is used
 * instead of equal-duration slicing so a short final cue can be combined with
 * its neighbor when that produces a valid timeline.
 */
export function groupNarrationCuesIntoScenes(
  cues: NarrationCue[],
  totalDurationSec: number,
  runtime: VideoTemplateRuntimeSettings | null | undefined,
  legacyCount: number,
): ScriptScene[] {
  const preferredCount = plannedSceneCount(runtime, totalDurationSec, legacyCount);
  if (!runtime || cues.length === 0) {
    return groupCuesIntoScenes(cues, totalDurationSec, preferredCount);
  }

  const cueEnds = cues.map((cue, i) =>
    i + 1 < cues.length ? cues[i + 1]!.startSec : totalDurationSec,
  );
  const minimumCount = Math.max(1, runtime.minSceneCount);
  const maximumCount = Math.min(cues.length, runtime.maxSceneCount);
  const candidateCounts = Array.from(
    { length: Math.max(0, maximumCount - minimumCount + 1) },
    (_, i) => minimumCount + i,
  ).sort((a, b) => Math.abs(a - preferredCount) - Math.abs(b - preferredCount));

  for (const count of candidateCounts) {
    const idealDuration = totalDurationSec / count;
    const costs = Array.from({ length: count + 1 }, () =>
      Array<number>(cues.length + 1).fill(Number.POSITIVE_INFINITY),
    );
    const previous = Array.from({ length: count + 1 }, () =>
      Array<number>(cues.length + 1).fill(-1),
    );
    costs[0]![0] = 0;

    for (let scene = 1; scene <= count; scene++) {
      for (let end = scene; end <= cues.length; end++) {
        for (let start = scene - 1; start < end; start++) {
          const priorCost = costs[scene - 1]![start]!;
          if (!Number.isFinite(priorCost)) continue;
          const durationSec = cueEnds[end - 1]! - cues[start]!.startSec;
          if (
            durationSec < runtime.minSceneDurationSeconds ||
            durationSec > runtime.maxSceneDurationSeconds
          ) {
            continue;
          }
          const cost = priorCost + Math.pow(durationSec - idealDuration, 2);
          if (cost < costs[scene]![end]!) {
            costs[scene]![end] = cost;
            previous[scene]![end] = start;
          }
        }
      }
    }

    if (!Number.isFinite(costs[count]![cues.length]!)) continue;
    const ranges: Array<{ start: number; end: number }> = [];
    let end = cues.length;
    for (let scene = count; scene > 0; scene--) {
      const start = previous[scene]![end]!;
      ranges.push({ start, end });
      end = start;
    }
    ranges.reverse();
    return ranges.map(({ start, end }) => ({
      firstCue: start,
      lastCue: end - 1,
      durationSec: cueEnds[end - 1]! - cues[start]!.startSec,
      text: cues.slice(start, end).map((cue) => cue.text).join(" "),
    }));
  }

  throw new VideoGenProviderError(
    `The voiced script cannot satisfy the template's ${runtime.minSceneDurationSeconds}-${runtime.maxSceneDurationSeconds} second scene bounds at complete narration boundaries.`,
  );
}

/** Split a spoken segment at clauses, then words, without dropping text. */
export function splitNarrationSegment(text: string, maximumWords: number): string[] {
  const words = text.trim().split(/\s+/u).filter(Boolean);
  if (words.length <= maximumWords) return words.length ? [words.join(" ")] : [];
  const clauses = text
    .trim()
    .split(/(?<=[,;:])\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  const out: string[] = [];
  let pending: string[] = [];
  const flush = () => {
    if (pending.length) out.push(pending.join(" "));
    pending = [];
  };
  for (const clause of clauses) {
    const clauseWords = clause.split(/\s+/u).filter(Boolean);
    if (clauseWords.length > maximumWords) {
      flush();
      const partCount = Math.ceil(clauseWords.length / maximumWords);
      const baseSize = Math.floor(clauseWords.length / partCount);
      let remainder = clauseWords.length % partCount;
      let offset = 0;
      while (offset < clauseWords.length) {
        const size = baseSize + (remainder > 0 ? 1 : 0);
        remainder = Math.max(0, remainder - 1);
        out.push(clauseWords.slice(offset, offset + size).join(" "));
        offset += size;
      }
    } else if (pending.length + clauseWords.length > maximumWords) {
      flush();
      pending = clauseWords;
    } else {
      pending.push(...clauseWords);
    }
  }
  flush();
  return out;
}

/** Prepare complete TTS units that fit the configured maximum scene duration. */
export function prepareNarrationSegments(
  script: string,
  runtime: VideoTemplateRuntimeSettings | null | undefined,
): string[] {
  const sentences = splitIntoSentences(script);
  if (!runtime) return sentences;
  const { maxWords: maximumWords } = narrationSentenceWordBounds(runtime);
  const segments = sentences.flatMap((sentence) => splitNarrationSegment(sentence, maximumWords));
  const estimatedLimitWords = Math.floor(
    (runtime.maxDurationSeconds * runtime.speakingRateWpm) / 60,
  );
  const selected: string[] = [];
  let words = 0;
  for (const segment of segments) {
    const segmentWords = segment.split(/\s+/u).filter(Boolean).length;
    if (words + segmentWords > estimatedLimitWords) break;
    selected.push(segment);
    words += segmentWords;
  }
  if (selected.length === 0) {
    throw new VideoGenProviderError(
      "The template duration is too short to include a complete narration segment. Increase the maximum duration or scene duration.",
    );
  }
  return selected;
}

/** Cap at a full cue boundary: audio and captions always end on the same text. */
export function capNarrationCompleteCues(
  narration: Awaited<ReturnType<typeof synthesizeNarration>>,
  maximumSec: number,
): Awaited<ReturnType<typeof synthesizeNarration>> {
  if (narration.totalDurationSec <= maximumSec) return narration;
  const complete = narration.cues.filter((cue) => cue.endSec <= maximumSec);
  const last = complete.at(-1);
  if (!last) {
    throw new VideoGenProviderError(
      "The first narration segment exceeds this template's maximum duration. Use shorter scene segments or a longer maximum duration.",
    );
  }
  const parsed = parseWav(narration.wav);
  const frameBytes = parsed.format.blockAlign;
  const wantedBytes =
    Math.floor((last.endSec * parsed.format.byteRate) / frameBytes) * frameBytes;
  return {
    wav: buildWav(parsed.format, parsed.pcm.subarray(0, wantedBytes)),
    cues: complete,
    totalDurationSec: last.endSec,
  };
}

function scenesWithinRuntimeBounds(
  scenes: ScriptScene[],
  runtime: VideoTemplateRuntimeSettings | null | undefined,
): void {
  if (!runtime) return;
  if (scenes.length < runtime.minSceneCount || scenes.length > runtime.maxSceneCount) {
    throw new VideoGenProviderError(
      `The voiced script yields ${scenes.length} scenes, outside this template's ${runtime.minSceneCount}-${runtime.maxSceneCount} scene range.`,
    );
  }
  const invalid = scenes.find(
    (scene) =>
      scene.durationSec < runtime.minSceneDurationSeconds ||
      scene.durationSec > runtime.maxSceneDurationSeconds,
  );
  if (invalid) {
    throw new VideoGenProviderError(
      `The voiced script cannot satisfy the template's ${runtime.minSceneDurationSeconds}-${runtime.maxSceneDurationSeconds} second scene bounds at complete narration boundaries.`,
    );
  }
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
  templateRuntime?: VideoTemplateRuntimeSettings | null;
  brandVoice?: string | null;
  /** Cloned brand voice for narration (already kill-switch gated by the caller);
   * stock voices remain the whole-track fallback. */
  clonedVoice?: ClonedVoiceRef | null;
  referenceStyle?: string | null;
  /** Prompt Kit script variant; null keeps the flow's base prompt. */
  scriptVariant?: PromptVariantKey | null;
  startedAt: number;
  deadlineMs: number;
  onStage?: (stage: string) => void;
}): Promise<{
  tenantAiModel: string;
  model: string;
  searchTerms: string[];
  verificationFindings: string[];
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
  const { script, searchTerms, model, verificationFindings } = await generateTopicScript({
    tenantAiModel: tenant.aiModel,
    topic: params.topic,
    paragraphCount: params.paragraphCount,
    runtime: params.templateRuntime ?? null,
    brandVoice: params.brandVoice ?? null,
    referenceStyle: params.referenceStyle ?? null,
    variant: params.scriptVariant ?? null,
    tenantId: params.tenantId,
  });
  checkDeadline(params.startedAt, params.deadlineMs);

  // 2) Sentence-level narration with exact timings.
  const sentences = prepareNarrationSegments(script, params.templateRuntime);
  if (sentences.length === 0) {
    throw new VideoGenProviderError("The AI returned an empty script. Please try again.");
  }
  params.onStage?.("Voicing the narration");
  const spoken = await synthesizeNarration(sentences, params.voice, {
    clonedVoice: params.clonedVoice ?? null,
    billing: { tenantId: params.tenantId, refKind: "topicVideo" },
  });
  const narration = params.templateRuntime
    ? capNarrationCompleteCues(spoken, params.templateRuntime.maxDurationSeconds)
    : spoken;
  checkDeadline(params.startedAt, params.deadlineMs);

  return { tenantAiModel: tenant.aiModel, model, searchTerms, verificationFindings, narration };
}

export async function generateTopicVideo(params: TopicVideoParams): Promise<TopicVideoResult> {
  const startedAt = Date.now();
  const characterMode = params.visualsSource === "character";
  const aiMode = params.visualsSource === "ai" || params.visualsSource === "ai_video";
  // Animated b-roll runs image-to-video per scene, so it shares the character
  // deadline rather than the stills-only one.
  const animatedBroll = params.visualsSource === "ai_video";
  const deadlineMs =
    characterMode || animatedBroll
      ? CHARACTER_VIDEO_TOTAL_DEADLINE_MS
      : aiMode
        ? AI_BROLL_TOTAL_DEADLINE_MS
        : TOPIC_VIDEO_TOTAL_DEADLINE_MS;
  const topic = params.topic.trim();
  if (!topic) {
    throw new VideoGenProviderError("A topic is required.");
  }

  const { tenantAiModel, model, searchTerms, verificationFindings, narration } = await writeAndVoiceScript({
    tenantId: params.tenantId,
    topic,
    voice: params.voice,
    paragraphCount: params.paragraphCount,
    templateRuntime: params.templateRuntime ?? null,
    brandVoice: params.brandVoice ?? null,
    clonedVoice: params.clonedVoice ?? null,
    referenceStyle: params.referenceStyle ?? null,
    scriptVariant: params.scriptVariant ?? null,
    startedAt,
    deadlineMs,
    onStage: params.onStage,
  });
  if (verificationFindings.length > 0) {
    throw new VideoGenProviderError(
      "The generated script contains claims that require verification. Start a storyboard review and revise those claims before rendering.",
    );
  }

  // 3) Visuals: locked-character AI scenes, generated b-roll, or stock.
  let clips: Buffer[];
  let sceneMap = null;
  let provider: string;
  if (aiMode) {
    params.onStage?.("Creating AI imagery");
    const scenes = groupNarrationCuesIntoScenes(
      narration.cues,
      narration.totalDurationSec,
      params.templateRuntime,
      sceneCountFor(AI_BROLL_SCENES_PER_PARAGRAPH, params.paragraphCount),
    );
    scenesWithinRuntimeBounds(scenes, params.templateRuntime);
    const generated = await generateBrollClips({
      tenantAiModel,
      topic,
      scenes,
      aspectRatio: params.aspectRatio,
      tenantId: params.tenantId,
      suppliedPlan: suppliedPlanRawFor(params.suppliedPlan ?? null, "broll"),
      animate: animatedBroll,
      motionPreset: params.motionPreset ?? null,
      cinematography: params.cinematography ?? null,
      seed: params.seed ?? null,
      modelOptions: params.modelOptions,
      creativeVisualGuidance: params.creativeVisualGuidance ?? null,
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
      characterSnapshot: params.characterSnapshot,
      paragraphCount: params.paragraphCount,
      templateRuntime: params.templateRuntime ?? null,
      aspectRatio: params.aspectRatio,
      cues: narration.cues,
      totalDurationSec: narration.totalDurationSec,
      suppliedPlan: suppliedPlanRawFor(params.suppliedPlan ?? null, "character"),
      creativeVisualGuidance: params.creativeVisualGuidance ?? null,
    });
    clips = generated.clips;
    sceneMap = generated.sceneMap;
    provider = generated.provider;
  } else {
    params.onStage?.("Finding the right footage");
    const stockScenes = params.templateRuntime
      ? groupNarrationCuesIntoScenes(
          narration.cues,
          narration.totalDurationSec,
          params.templateRuntime,
          narration.cues.length,
        )
      : null;
    if (stockScenes) scenesWithinRuntimeBounds(stockScenes, params.templateRuntime);
    const stock = await gatherStockClips(
      params.stockSource,
      searchTerms,
      params.aspectRatio,
      stockScenes?.length ?? narration.cues.length,
      startedAt,
      {
        tenantAiModel,
        topic,
        sceneTexts: stockScenes?.map((scene) => scene.text) ?? narration.cues.map((cue) => cue.text),
      },
    );
    clips = stock.clips;
    provider = stock.provider;
    // A successful ranking pins each sentence to its best-matching clip.
    if (stock.sceneToClip) {
      const durations = stockScenes
        ? stockScenes.map((scene) => scene.durationSec)
        : sceneDurations(narration.cues, narration.totalDurationSec);
      sceneMap = durations.map(
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
        // Ken Burns b-roll encodes generated stills; stock, character, and
        // animated b-roll clips genuinely move.
        stillImagery: aiMode && !animatedBroll,
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
  /** A saved/edited plan reused instead of asking the model. */
  suppliedPlan?: unknown;
  characterSnapshot?: import("@workspace/db").VideoJobOptions["characterSnapshot"];
}): Promise<{
  detail: NonNullable<Awaited<ReturnType<typeof getCharacterDetail>>>;
  plan: ScenePlanEntry[];
  rawPlan: unknown | null;
}> {
  const detail = params.characterSnapshot
    ? characterDetailFromSnapshot(params.tenantId, params.characterSnapshot)
    : await getCharacterDetail(params.tenantId, params.characterId);
  if (!detail) {
    throw new VideoGenProviderError("The selected character no longer exists.");
  }
  const lockedOutfit = resolveOutfit(detail, params.outfitId);
  if (!lockedOutfit) {
    throw new VideoGenProviderError("The selected outfit no longer exists.");
  }
  const { plan, rawPlan } = await planSceneVisuals({
    tenantAiModel: params.tenantAiModel,
    topic: params.topic,
    tenantId: params.tenantId,
    character: detail.character,
    outfits: detail.outfits,
    lockedOutfitId: lockedOutfit.id,
    wardrobeNotes: params.wardrobeNotes,
    scenes: params.scenes,
    suppliedPlan: params.suppliedPlan,
  });
  return { detail, plan, rawPlan };
}

/** Script scenes → wardrobe plan → identity-locked clips, for character mode. */
async function generateCharacterStoryClips(params: {
  tenantId: number;
  tenantAiModel: string;
  topic: string;
  characterId: number;
  outfitId: number | null;
  wardrobeNotes: string;
  characterSnapshot?: import("@workspace/db").VideoJobOptions["characterSnapshot"];
  paragraphCount: number;
  templateRuntime?: VideoTemplateRuntimeSettings | null;
  aspectRatio: VideoAspect;
  cues: NarrationCue[];
  totalDurationSec: number;
  /** A saved/edited plan reused instead of asking the model. */
  suppliedPlan?: unknown;
  /** Job-level camera-move preset; null = the governed default. */
  motionPreset?: string | null;
  /** Job-level optics; null = nothing added to the prompt. */
  cinematography?: Cinematography | null;
  /** Job-level sampling seed; null = the provider's choice. */
  seed?: number | null;
  /** Picked catalog model and its resolved flags; omitted = platform default. */
  modelOptions?: ResolvedModelOptions;
  /** Treatment-only fragment; appended after each planned scene subject. */
  creativeVisualGuidance?: string | null;
}): Promise<{
  clips: Buffer[];
  sceneMap: import("./compose").SceneSegment[];
  provider: string;
}> {
  const scenes = groupNarrationCuesIntoScenes(
    params.cues,
    params.totalDurationSec,
    params.templateRuntime,
    sceneCountFor(CHARACTER_SCENES_PER_PARAGRAPH, params.paragraphCount),
  );
  scenesWithinRuntimeBounds(scenes, params.templateRuntime);
  const planned = await planCharacterScenes({ ...params, scenes });
  const detail = planned.detail;
  const plan = planned.plan.map((entry) => ({
    ...entry,
    visual: appendCreativeFragment(entry.visual, params.creativeVisualGuidance ?? null),
  }));
  const generated = await generateCharacterSceneClips({
    tenantId: params.tenantId,
    character: detail.character,
    outfits: detail.outfits,
    plan,
    scenes,
    aspectRatio: params.aspectRatio,
    motionPreset: params.motionPreset ?? null,
    cinematography: params.cinematography ?? null,
    seed: params.seed ?? null,
    modelOptions: params.modelOptions,
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
  templateRuntime?: VideoTemplateRuntimeSettings | null;
  /** Only "character", "ai", and "ai_video" plan reviewable scenes; stock
   * renders straight through (its visuals are searched, not prompted). */
  visualsSource: "character" | "ai" | "ai_video";
  characterId?: number | null;
  outfitId?: number | null;
  wardrobeNotes?: string | null;
  characterSnapshot?: import("@workspace/db").VideoJobOptions["characterSnapshot"];
  /** Treatment-only fragment compiled from the enqueue-time creative brief. */
  creativeVisualGuidance?: string | null;
  brandVoice?: string | null;
  /** Cloned brand voice for narration (already kill-switch gated by the caller);
   * stock voices remain the whole-track fallback. */
  clonedVoice?: ClonedVoiceRef | null;
  referenceStyle?: string | null;
  /** Prompt Kit script variant; null keeps the flow's base prompt. */
  scriptVariant?: PromptVariantKey | null;
  /** Reuse a saved AI scene plan instead of planning fresh (validated at the
   * route; must match visualsSource). */
  suppliedPlan?: SuppliedPlan | null;
  /** Keep templates preview-less until their planned visual work is funded. */
  materializePreviews?: boolean;
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
  // Both b-roll flavours share the plan half (script → narration → stills);
  // only the render half after approval differs.
  const topic = params.topic.trim();
  if (!topic) {
    throw new VideoGenProviderError("A topic is required.");
  }

  // Character Story review is deliberately planning-only. The script and
  // scene directions are useful to review, while narration, keyframes, music,
  // and video generation all wait until approval.
  if (characterMode) {
    const tenant = (
      await db
        .select()
        .from(tenantsTable)
        .where(eq(tenantsTable.id, params.tenantId))
        .limit(1)
    )[0];
    if (!tenant) throw new VideoGenProviderError("Tenant not found.");

    params.onStage?.("Writing the script");
    const { script, model, verificationFindings } = await generateTopicScript({
      tenantAiModel: tenant.aiModel,
      topic,
      paragraphCount: params.paragraphCount,
      runtime: params.templateRuntime ?? null,
      brandVoice: params.brandVoice ?? null,
      referenceStyle: params.referenceStyle ?? null,
      variant: params.scriptVariant ?? null,
      tenantId: params.tenantId,
    });
    const sentences = prepareNarrationSegments(script, params.templateRuntime);
    if (sentences.length === 0) {
      throw new VideoGenProviderError("The AI returned an empty script. Please try again.");
    }
    let cursor = 0;
    const maximumSec = params.templateRuntime?.maxDurationSeconds ?? Number.POSITIVE_INFINITY;
    const estimatedCues: NarrationCue[] = sentences.flatMap((text) => {
      const startSec = cursor;
      const durationSec = Math.max(1.2, (text.match(/\S+/gu)?.length ?? 1) / 2.4);
      if (startSec >= maximumSec) return [];
      cursor = Math.min(maximumSec, cursor + durationSec);
      return [{ text, startSec, endSec: cursor }];
    });
    const scenes = groupNarrationCuesIntoScenes(
      estimatedCues,
      cursor,
      params.templateRuntime,
      sceneCountFor(CHARACTER_SCENES_PER_PARAGRAPH, params.paragraphCount),
    );
    scenesWithinRuntimeBounds(scenes, params.templateRuntime);
    params.onStage?.("Planning the storyboard");
    const { plan, rawPlan } = await planCharacterScenes({
      tenantId: params.tenantId,
      tenantAiModel: tenant.aiModel,
      topic,
      characterId: params.characterId ?? 0,
      outfitId: params.outfitId ?? null,
      wardrobeNotes: params.wardrobeNotes ?? "",
      scenes,
      suppliedPlan: suppliedPlanRawFor(params.suppliedPlan ?? null, "character"),
      characterSnapshot: params.characterSnapshot,
    });
    return {
      version: 1,
      mode: "character_story",
      visualsSource: "character",
      timelineLocked: false,
      durationBounds: null,
      model,
      provider: null,
      regenerations: 0,
      narration: null,
      verificationFindings,
      scenes: scenes.map((scene, index) => ({
        id: `s${index + 1}`,
        text: scene.text,
        visual: appendCreativeFragment(
          plan[index]?.visual ?? scene.text,
          params.creativeVisualGuidance ?? null,
        ),
        durationSec: scene.durationSec,
        previewPath: null,
        outfitId: plan[index]?.outfitId ?? null,
      })),
      aiPlan:
        rawPlan == null
          ? null
          : { flow: "character", raw: rawPlan, capturedAt: new Date().toISOString() },
    };
  }

  const { tenantAiModel, model, narration, verificationFindings } = await writeAndVoiceScript({
    tenantId: params.tenantId,
    topic,
    voice: params.voice,
    paragraphCount: params.paragraphCount,
    templateRuntime: params.templateRuntime ?? null,
    brandVoice: params.brandVoice ?? null,
    clonedVoice: params.clonedVoice ?? null,
    referenceStyle: params.referenceStyle ?? null,
    scriptVariant: params.scriptVariant ?? null,
    startedAt,
    deadlineMs,
    onStage: params.onStage,
  });

  const scenes = groupNarrationCuesIntoScenes(
    narration.cues,
    narration.totalDurationSec,
    params.templateRuntime,
    sceneCountFor(
      characterMode ? CHARACTER_SCENES_PER_PARAGRAPH : AI_BROLL_SCENES_PER_PARAGRAPH,
      params.paragraphCount,
    ),
  );
  scenesWithinRuntimeBounds(scenes, params.templateRuntime);

  params.onStage?.("Sketching the storyboard");
  let visuals: string[];
  let outfitIds: (number | null)[];
  let stills: Buffer[];
  let provider: string | null;
  /** The AI's untouched planning reply, persisted on the board for audit. */
  let aiPlan: VideoStoryboard["aiPlan"] = null;
  {
    const { prompts, rawPlan } = await planBrollVisuals({
      tenantAiModel,
      topic,
      scenes,
      tenantId: params.tenantId,
      suppliedPlan: suppliedPlanRawFor(params.suppliedPlan ?? null, "broll"),
    });
    visuals = prompts.map((prompt) =>
      appendCreativeFragment(prompt, params.creativeVisualGuidance ?? null),
    );
    if (rawPlan != null) {
      aiPlan = { flow: "broll", raw: rawPlan, capturedAt: new Date().toISOString() };
    }
    outfitIds = scenes.map(() => null);
    checkDeadline(startedAt, deadlineMs);
    if (params.materializePreviews !== false) {
      const generated = await generateBrollStills({
        prompts: visuals,
        aspectRatio: params.aspectRatio,
      });
      stills = generated.images;
      provider = generated.provider;
    } else {
      stills = scenes.map(() => Buffer.alloc(0));
      provider = null;
    }
  }
  checkDeadline(startedAt, deadlineMs);

  params.onStage?.("Saving the storyboard");
  const audioPath = await params.upload(narration.wav, "audio/wav");
  const previewPaths = await Promise.all(
    stills.map((still) =>
      still.length === 0
        ? Promise.resolve(null)
        :
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
    mode: "standard",
    visualsSource: params.visualsSource,
    timelineLocked: NARRATION_TIMELINE_LOCKED,
    model,
    provider,
    regenerations: 0,
    narration: {
      audioPath,
      totalDurationSec: narration.totalDurationSec,
      provider: narration.provider,
      model: narration.model,
      accountingMode: narration.accountingMode,
      costPaise: narration.costPaise,
      cues: narration.cues.map((cue) => ({
        text: cue.text,
        startSec: cue.startSec,
        endSec: cue.endSec,
      })),
    },
    verificationFindings,
    scenes: scenes.map((scene, i) => ({
      id: `s${i + 1}`,
      text: scene.text,
      visual: visuals[i] ?? scene.text,
      durationSec: scene.durationSec,
      previewPath: previewPaths[i] ?? null,
      outfitId: outfitIds[i] ?? null,
    })),
    aiPlan,
  };
}

/** After approval, materialize the narration and exact keyframes represented
 * by a planning-only Character Story board. */
export async function prepareCharacterStoryStoryboard(params: {
  tenantId: number;
  storyboard: VideoStoryboard;
  characterId: number;
  selectedOutfitId: number;
  characterSnapshot?: import("@workspace/db").VideoJobOptions["characterSnapshot"];
  voice: NarrationVoice;
  clonedVoice?: ClonedVoiceRef | null;
  aspectRatio: VideoAspect;
  upload: (bytes: Buffer, contentType: string) => Promise<string>;
  onCheckpoint?: (storyboard: VideoStoryboard) => Promise<void>;
  /** Durable receipt hook, invoked for every successful provider attempt. */
  onKeyframeProviderSuccess?: (args: {
    sceneIndex: number;
    attemptIndex: number;
    result: import("../../imageGen/types").ImageGenResult;
  }) => Promise<void>;
  /** Uploads only the image selected after duplicate analysis. */
  uploadKeyframe?: (args: {
    sceneIndex: number;
    result: import("../../imageGen/types").ImageGenResult;
  }) => Promise<string>;
  onStage?: (stage: string) => void;
}): Promise<VideoStoryboard> {
  const board = params.storyboard;
  if (board.mode !== "character_story" || board.visualsSource !== "character") {
    return board;
  }
  if (board.narration && board.scenes.every((scene) => scene.previewPath)) return board;

  let prepared = board;
  if (!prepared.narration) {
    params.onStage?.("Voicing the approved script");
    const sentences: string[] = [];
    const ranges: { first: number; last: number }[] = [];
    for (const scene of prepared.scenes) {
      const chunks = splitIntoSentences(scene.text);
      if (chunks.length === 0) {
        throw new VideoGenProviderError("A Character Story scene has no script to record.");
      }
      ranges.push({ first: sentences.length, last: sentences.length + chunks.length - 1 });
      sentences.push(...chunks);
    }
    const narration = await synthesizeNarration(sentences, params.voice, {
      clonedVoice: params.clonedVoice ?? null,
      billing: { tenantId: params.tenantId, refKind: "videoStoryboard" },
    });
    const cueDurations = sceneDurations(narration.cues, narration.totalDurationSec);
    const audioPath = await params.upload(narration.wav, "audio/wav");
    prepared = {
      ...prepared,
      timelineLocked: true,
      narration: {
        audioPath,
        totalDurationSec: narration.totalDurationSec,
        cues: narration.cues,
      },
      scenes: prepared.scenes.map((scene, index) => {
        const range = ranges[index]!;
        let durationSec = 0;
        for (let cue = range.first; cue <= range.last; cue++) {
          durationSec += cueDurations[cue] ?? 0;
        }
        return { ...scene, durationSec: Math.max(durationSec, 0.2) };
      }),
    };
    // Narration is a paid, reusable checkpoint. Persist it before keyframe
    // generation so a later frame failure never speaks the script twice.
    await params.onCheckpoint?.(prepared);
  }

  const detail = params.characterSnapshot
    ? characterDetailFromSnapshot(params.tenantId, params.characterSnapshot)
    : await getCharacterDetail(params.tenantId, params.characterId);
  if (!detail) throw new VideoGenProviderError("The selected character no longer exists.");
  const fallbackOutfit = resolveOutfit(detail, params.selectedOutfitId);
  if (!fallbackOutfit) throw new VideoGenProviderError("The selected character has no outfit.");
  const plan: ScenePlanEntry[] = prepared.scenes.map((scene) => ({
    visual: scene.visual,
    outfitId:
      scene.outfitId && detail.outfits.some((outfit) => outfit.id === scene.outfitId)
        ? scene.outfitId
        : fallbackOutfit.id,
  }));
  params.onStage?.("Creating the approved character frames");
  const missingSceneIndices = prepared.scenes
    .map((scene, index) => scene.previewPath ? -1 : index)
    .filter((index) => index >= 0);
  const stills = await generateSceneKeyframes({
    tenantId: params.tenantId,
    character: detail.character,
    outfits: detail.outfits,
    plan: missingSceneIndices.map((index) => plan[index]!),
    aspectRatio: params.aspectRatio,
    onProviderSuccess: params.onKeyframeProviderSuccess
      ? async ({ sceneIndex, attemptIndex, result }) => {
          const originalIndex = missingSceneIndices[sceneIndex]!;
          await params.onKeyframeProviderSuccess!({
            sceneIndex: originalIndex,
            attemptIndex,
            result,
          });
        }
      : undefined,
  });
  const generatedPaths = await Promise.all(stills.map((still, generatedIndex) => {
    const sceneIndex = missingSceneIndices[generatedIndex]!;
    return params.uploadKeyframe
      ? params.uploadKeyframe({ sceneIndex, result: still })
      : params.upload(still.buffer, "image/png");
  }));
  const previewPaths = prepared.scenes.map((scene, index) =>
    scene.previewPath ?? generatedPaths[missingSceneIndices.indexOf(index)] ?? null,
  );

  return {
    ...prepared,
    timelineLocked: true,
    provider: "openai",
    scenes: prepared.scenes.map((scene, index) => ({
      ...scene,
      previewPath: previewPaths[index] ?? null,
      outfitId: plan[index]!.outfitId,
    })),
  };
}

/** Whitespace-insensitive text comparison for edit detection. */
function normalizeNarrationText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Re-record the narration of a storyboard whose scene texts were edited (or
 * whose scene list grew) during review. Returns the storyboard with a fresh
 * recording, new cues and recomputed scene lengths — or null when the scene
 * texts still match the stored recording, so the approve path stays free for
 * untouched boards. Unedited boards compare equal because the planner built
 * each scene's text by joining its cues.
 */
export async function refreshEditedNarration(params: {
  tenantId?: number;
  storyboard: VideoStoryboard;
  voice: NarrationVoice;
  clonedVoice?: ClonedVoiceRef | null;
  upload: (bytes: Buffer, contentType: string) => Promise<string>;
  onStage?: (stage: string) => void;
  maxSceneDurationSec?: (scene: VideoStoryboard["scenes"][number]) => number | null;
}): Promise<VideoStoryboard | null> {
  const board = params.storyboard;
  const narration = board.narration;
  if (!narration || board.scenes.length === 0) return null;
  const sceneText = normalizeNarrationText(board.scenes.map((s) => s.text).join(" "));
  const cueText = normalizeNarrationText(narration.cues.map((c) => c.text).join(" "));
  if (sceneText === cueText) return null;

  params.onStage?.("Re-recording the narration");
  // Chunk each scene's text exactly the way the planner does, remembering
  // which chunks belong to which scene so the new cue timings can be summed
  // back into per-scene lengths.
  const sentences: string[] = [];
  const ranges: { first: number; last: number }[] = [];
  for (const scene of board.scenes) {
    const chunks = splitIntoSentences(scene.text);
    if (chunks.length === 0) {
      throw new VideoGenProviderError("A scene has no narration text to record.");
    }
    ranges.push({ first: sentences.length, last: sentences.length + chunks.length - 1 });
    sentences.push(...chunks);
  }
  const recorded = await synthesizeNarration(sentences, params.voice, {
    clonedVoice: params.clonedVoice ?? null,
    billing:
      params.tenantId !== undefined
        ? { tenantId: params.tenantId, refKind: "videoStoryboard" }
        : null,
  });
  const durations = sceneDurations(recorded.cues, recorded.totalDurationSec);
  const sceneDurationSec = ranges.map((range) => {
    let durationSec = 0;
    for (let cue = range.first; cue <= range.last; cue++) {
      durationSec += durations[cue] ?? 0;
    }
    return Math.max(durationSec, 0.2);
  });
  for (const [index, scene] of board.scenes.entries()) {
    const max = params.maxSceneDurationSec?.(scene);
    if (max != null && sceneDurationSec[index]! > max + 0.1) {
      throw new VideoGenProviderError(
        `Hybrid ${scene.hybridRole ?? "story"} exceeds its template timing limit after narration was voiced.`,
      );
    }
  }
  const audioPath = await params.upload(recorded.wav, "audio/wav");
  return {
    ...board,
    narration: {
      audioPath,
      totalDurationSec: recorded.totalDurationSec,
      cues: recorded.cues.map((cue) => ({
        text: cue.text,
        startSec: cue.startSec,
        endSec: cue.endSec,
      })),
      provider: recorded.provider,
      model: recorded.model,
      accountingMode: recorded.accountingMode,
      costPaise: recorded.costPaise,
    },
    scenes: board.scenes.map((scene, i) => ({ ...scene, durationSec: sceneDurationSec[i]! })),
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
  /** Job-level camera-move preset applied to every animated scene. */
  motionPreset?: string | null;
  /** Job-level optics; null = nothing added to the prompt. */
  cinematography?: Cinematography | null;
  /** Job-level sampling seed; null = the provider's choice. */
  seed?: number | null;
  /** Picked catalog model and its resolved flags; omitted = platform default. */
  modelOptions?: ResolvedModelOptions;
  /** Reads narration audio and preview stills back from tenant storage. */
  load: (objectPath: string) => Promise<Buffer>;
  onStage?: (stage: string) => void;
  onCheckpoint?: (args: {
    sceneIndex: number;
    buffer: Buffer;
    provider: string;
    model: string;
    durationSec: number;
  }) => Promise<void>;
}): Promise<TopicVideoResult> {
  const startedAt = Date.now();
  const board = params.storyboard;
  const characterMode = board.visualsSource === "character";
  const animatedBroll = board.visualsSource === "ai_video";
  const deadlineMs =
    characterMode || animatedBroll
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
  const savedClips = await Promise.all(
    board.scenes.map((scene) =>
      scene.providerCheckpoint?.path
        ? params.load(scene.providerCheckpoint.path).catch(() => null)
        : Promise.resolve(null),
    ),
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
      motionPreset: params.motionPreset ?? null,
      cinematography: params.cinematography ?? null,
      seed: params.seed ?? null,
      modelOptions: params.modelOptions,
      savedClips,
      onCheckpoint: params.onCheckpoint,
    });
    clips = animated.clips;
    sceneMap = animated.sceneMap;
    provider = animated.provider;
  } else if (animatedBroll) {
    // Animated AI b-roll: image-to-video per approved still, exactly the
    // frames the storyboard previewed (mirrors the character resume path).
    params.onStage?.("Animating your storyboard");
    const animated = await animateBrollStills({
      images: stills as Buffer[],
      visuals: board.scenes.map((scene) => scene.visual),
      scenes,
      aspectRatio: params.aspectRatio,
      motionPreset: params.motionPreset ?? null,
      cinematography: params.cinematography ?? null,
      seed: params.seed ?? null,
      modelOptions: params.modelOptions,
      savedClips,
      onCheckpoint: params.onCheckpoint,
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
        stillImagery: !characterMode && !animatedBroll,
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
  selectedOutfitId?: number | null;
  characterSnapshot?: import("@workspace/db").VideoJobOptions["characterSnapshot"];
  upload: (bytes: Buffer, contentType: string) => Promise<string>;
  priorImages?: Buffer[];
  onProviderSuccess?: (args: {
    attemptIndex: number;
    result: import("../../imageGen/types").ImageGenResult;
  }) => Promise<void>;
  uploadGenerated?: (result: import("../../imageGen/types").ImageGenResult) => Promise<string>;
}): Promise<string> {
  if (params.storyboard.visualsSource === "character") {
    const detail = params.characterSnapshot
      ? characterDetailFromSnapshot(params.tenantId, params.characterSnapshot)
      : await getCharacterDetail(params.tenantId, params.characterId ?? 0);
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
          // Unknown or implicit changes fall back to the enqueue-time selected
          // outfit, never whichever outfit happens to be default now.
          outfitId:
            resolveOutfit(detail, params.scene.outfitId)?.id ??
            resolveOutfit(detail, params.selectedOutfitId)?.id ??
            0,
        },
      ],
      aspectRatio: params.aspectRatio,
      onProviderSuccess: params.onProviderSuccess
        ? async ({ attemptIndex, result }) => {
            await params.onProviderSuccess!({ attemptIndex, result });
          }
        : undefined,
    });
    return params.uploadGenerated
      ? params.uploadGenerated(still!)
      : params.upload(still!.buffer, "image/png");
  }
  const generated = await generateBrollStills({
    prompts: [params.scene.visual],
    aspectRatio: params.aspectRatio,
    priorImages: params.priorImages,
    onProviderSuccess: params.onProviderSuccess
      ? async ({ attemptIndex, result }) => {
          await params.onProviderSuccess!({ attemptIndex, result });
        }
      : undefined,
  });
  return params.uploadGenerated
    ? params.uploadGenerated(generated.results[0]!)
    : params.upload(generated.images[0]!, "image/png");
}
