import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  VideoJobOptions,
  VideoStoryboard,
  VideoStoryboardScene,
} from "@workspace/db";

import { computeImageCostPaise, usageAccountingParams } from "../aiCost";
import { generateBrollStills, stillToClip } from "./topicVideo/aiBroll";
import {
  downloadStockClip,
  searchStockClips,
  stockCandidates,
  stockNotConfiguredError,
  type StockClip,
  type StockSourceChoice,
} from "./topicVideo/stockSources";
import { splitIntoSentences } from "./topicVideo/narration";
import {
  BEAT_PLANNER_TEMPLATE_BLOCKS,
  planBeats,
  type NarrationLine,
  type PlannedBeat,
} from "./beatPlanner";
import { compositeBroll } from "./brollOverlay";
import { extractPosterFrame, probeDurationSec } from "./slideshow";
import { VideoGenProviderError, type VideoAspect } from "./types";
import { getTextGenClient } from "../textGen";
import { loadActiveCasePrompt } from "../promptKit";
import type { TranscriptSegment } from "../asr/types";

export type PresenterBrollSnapshot = NonNullable<VideoJobOptions["presenterBroll"]>;
type PresenterBeat = PresenterBrollSnapshot["beats"][number];
type ResolvedSource = {
  bytes: Buffer;
  contentType: "video/mp4" | "image/png";
  assetKind: "video" | "image";
  provider: string;
  model?: string;
  costPaise?: number | null;
};

const MIN_PRESENTER_DURATION_SEC = 3;
const MAX_PRESENTER_DURATION_SEC = 10 * 60;
const MAX_PRESENTER_BEATS = 24;

export class PresenterBrollInputError extends Error {}

function words(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

/**
 * The presenter take has no transcript timecodes, so align the submitted
 * script proportionally by word count. The final boundary is pinned to the
 * probed media duration to prevent accumulated rounding drift.
 */
export function proportionalNarrationLines(script: string, durationMs: number): NarrationLine[] {
  let chunks = splitIntoSentences(script).filter((text) => text.trim().length > 0);
  if (chunks.length < 2) {
    const allWords = words(script);
    const targetChunks = Math.max(2, Math.min(12, Math.round(durationMs / 7_000)));
    const perChunk = Math.max(1, Math.ceil(allWords.length / targetChunks));
    chunks = [];
    for (let i = 0; i < allWords.length; i += perChunk) {
      chunks.push(allWords.slice(i, i + perChunk).join(" "));
    }
  }
  if (chunks.length === 0) {
    throw new PresenterBrollInputError(
      "The presenter template needs the script spoken in the take.",
    );
  }

  const weights = chunks.map((text) => Math.max(1, words(text).length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let elapsedWeight = 0;
  return chunks.map((text, index) => {
    const startMs = Math.round((elapsedWeight / totalWeight) * durationMs);
    elapsedWeight += weights[index]!;
    const endMs =
      index === chunks.length - 1
        ? durationMs
        : Math.round((elapsedWeight / totalWeight) * durationMs);
    return { index: index + 1, startMs, endMs, text };
  });
}

function normalizedWords(text: string): string[] {
  return text
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function tokenEditDistance(left: string[], right: string[]): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(
        current[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length] ?? left.length;
}

/**
 * Verify that the declared script is actually what the presenter says, then
 * pin those exact script chunks to ASR segment timing. This avoids confidently
 * burning unrelated captions over a take whose audio does not match the form.
 */
export function alignPresenterNarration(params: {
  script: string;
  durationMs: number;
  transcriptText: string;
  segments?: TranscriptSegment[];
}): NarrationLine[] {
  const scriptWords = normalizedWords(params.script);
  const transcriptWords = normalizedWords(params.transcriptText);
  if (scriptWords.length === 0 || transcriptWords.length === 0) {
    throw new PresenterBrollInputError(
      "We could not hear the submitted script in the presenter video. Upload a take with clear speech.",
    );
  }
  const distanceRatio =
    tokenEditDistance(scriptWords, transcriptWords) /
    Math.max(scriptWords.length, transcriptWords.length);
  if (distanceRatio > 0.45) {
    throw new PresenterBrollInputError(
      "The submitted script does not closely match the presenter video. Use the script spoken in that take.",
    );
  }

  const timedWords = (params.segments ?? [])
    .filter(
      (segment) =>
        segment.startMs >= 0 &&
        segment.endMs > segment.startMs &&
        segment.startMs < params.durationMs,
    )
    .flatMap((segment) => {
      const count = normalizedWords(segment.text).length;
      if (count === 0) return [];
      const endMs = Math.min(params.durationMs, segment.endMs);
      const span = endMs - segment.startMs;
      return Array.from({ length: count }, (_, index) => ({
        startMs: Math.round(segment.startMs + (span * index) / count),
        endMs: Math.round(segment.startMs + (span * (index + 1)) / count),
      }));
    });
  if (timedWords.length === 0) {
    throw new PresenterBrollInputError(
      "We could not time the speech in the presenter video. Upload a take with clear, continuous speech.",
    );
  }

  const chunks = proportionalNarrationLines(params.script, params.durationMs);
  const weights = chunks.map((line) => normalizedWords(line.text).length);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let elapsedWeight = 0;
  return chunks.map((line, index) => {
    const startIndex = Math.min(
      timedWords.length - 1,
      Math.floor((elapsedWeight / totalWeight) * timedWords.length),
    );
    elapsedWeight += weights[index]!;
    const endExclusive =
      index === chunks.length - 1
        ? timedWords.length
        : Math.max(
            startIndex + 1,
            Math.round((elapsedWeight / totalWeight) * timedWords.length),
          );
    return {
      ...line,
      startMs: timedWords[startIndex]!.startMs,
      endMs: timedWords[Math.min(timedWords.length, endExclusive) - 1]!.endMs,
    };
  });
}

function fallbackBeats(lines: NarrationLine[], durationMs: number): PlannedBeat[] {
  const usable = lines.slice(0, -1);
  if (usable.length === 0) {
    const line = lines[0]!;
    const endMs = Math.max(
      Math.min(durationMs - 1_500, 8_000),
      Math.min(durationMs, 4_000),
    );
    if (endMs <= 0) return [];
    return [{
      startMs: 0,
      endMs,
      query: words(line.text).slice(0, 4).join(" ") || "presenter explainer",
      kind: "lifestyle",
      opacity: 0.55,
      lineIndexes: [line.index],
    }];
  }

  const beats: PlannedBeat[] = [];
  let group: NarrationLine[] = [];
  for (const line of usable) {
    const projectedEnd = line.endMs;
    if (group.length > 0 && projectedEnd - group[0]!.startMs > 12_000) {
      const text = group.map((entry) => entry.text).join(" ");
      beats.push({
        startMs: group[0]!.startMs,
        endMs: group.at(-1)!.endMs,
        query: words(text).slice(0, 4).join(" "),
        kind: "lifestyle",
        opacity: 0.55,
        lineIndexes: group.map((entry) => entry.index),
      });
      group = [];
    }
    group.push(line);
  }
  if (group.length > 0) {
    const text = group.map((entry) => entry.text).join(" ");
    beats.push({
      startMs: group[0]!.startMs,
      endMs: group.at(-1)!.endMs,
      query: words(text).slice(0, 4).join(" "),
      kind: "lifestyle",
      opacity: 0.55,
      lineIndexes: group.map((entry) => entry.index),
    });
  }
  return beats;
}

async function planPresenterBeats(params: {
  tenantAiModel: string;
  lines: NarrationLine[];
  durationMs: number;
}): Promise<{ beats: PlannedBeat[]; notes: string[] }> {
  const textGen = await getTextGenClient(params.tenantAiModel);
  const active = await loadActiveCasePrompt("video_broll_beats").catch(() => null);
  const templateBlocks = active
    ? [...active.inheritedBlocks, ...active.version.contentSnapshot]
    : BEAT_PLANNER_TEMPLATE_BLOCKS;
  const planned = await planBeats({
    lines: params.lines,
    client: textGen.client,
    model: textGen.model,
    templateBlocks,
    requestParams: usageAccountingParams(textGen.provider),
  });
  if (planned.beats.length > 0) return { beats: planned.beats, notes: planned.notes };
  return {
    beats: fallbackBeats(params.lines, params.durationMs),
    notes: [...planned.notes, "Used deterministic beat grouping because the planner returned no usable beats."],
  };
}

function evenlyBoundBeats(beats: PlannedBeat[]): PlannedBeat[] {
  if (beats.length <= MAX_PRESENTER_BEATS) return beats;
  const selected = Array.from({ length: MAX_PRESENTER_BEATS }, (_, index) =>
    Math.round((index * (beats.length - 1)) / (MAX_PRESENTER_BEATS - 1)),
  );
  return selected.map((index) => beats[index]!);
}

export async function probePresenterDurationMs(presenterVideo: Buffer): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), "kokao-presenter-probe-"));
  try {
    await writeFile(join(dir, "presenter.mp4"), presenterVideo);
    const durationSec = await probeDurationSec("presenter.mp4", dir);
    if (durationSec === null || durationSec < MIN_PRESENTER_DURATION_SEC) {
      throw new PresenterBrollInputError("The presenter video must be at least 3 seconds long.");
    }
    if (durationSec > MAX_PRESENTER_DURATION_SEC) {
      throw new PresenterBrollInputError(
        "Presenter templates support videos up to 10 minutes long.",
      );
    }
    return Math.round(durationSec * 1000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Plan before funding. The exact persisted beat count is what videoJobUnits
 * reserves for generated presenter B-roll, so a long take can never fan out
 * into unreserved provider work.
 */
export async function planPresenterBrollTimeline(params: {
  script: string;
  tenantAiModel: string;
  durationMs: number;
  lines?: NarrationLine[];
}): Promise<PresenterBrollSnapshot> {
  const lines =
    params.lines ?? proportionalNarrationLines(params.script, params.durationMs);
  const planned = await planPresenterBeats({
    tenantAiModel: params.tenantAiModel,
    lines,
    durationMs: params.durationMs,
  });
  const beats = evenlyBoundBeats(planned.beats);
  if (beats.length === 0) {
    throw new PresenterBrollInputError(
      "The script did not contain enough material to plan B-roll.",
    );
  }
  return {
    version: 1,
    durationMs: params.durationMs,
    lines,
    beats: beats.map((beat, index) => ({
      id: `pb${index + 1}`,
      ...beat,
      assetPath: null,
      previewPath: null,
      assetKind: "video",
      provider: null,
    })),
    notes:
      planned.beats.length > beats.length
        ? [...planned.notes, `Limited the presenter plan to ${MAX_PRESENTER_BEATS} B-roll beats.`]
        : planned.notes,
  };
}

async function resolveStockBeat(params: {
  beat: PlannedBeat;
  aspectRatio: VideoAspect;
  stockSource: StockSourceChoice;
  usedUrls: Set<string>;
}): Promise<{ bytes: Buffer; contentType: string; kind: "video"; provider: string }> {
  const sources = await stockCandidates(params.stockSource);
  if (sources.length === 0) throw stockNotConfiguredError(params.stockSource);
  for (const source of sources) {
    const clips: StockClip[] = await searchStockClips(
      source.def,
      source.apiKey,
      params.beat.query,
      params.aspectRatio,
    ).catch((): StockClip[] => []);
    const clip = clips.find((candidate) => !params.usedUrls.has(candidate.url)) ?? clips[0];
    if (!clip) continue;
    params.usedUrls.add(clip.url);
    return {
      bytes: await downloadStockClip(clip),
      contentType: "video/mp4",
      kind: "video",
      provider: clip.provider,
    };
  }
  throw new VideoGenProviderError(
    `No usable B-roll footage was found for "${params.beat.query}". Try a broader script or AI imagery.`,
  );
}

async function resolveGeneratedBeat(params: {
  beat: PlannedBeat;
  aspectRatio: VideoAspect;
  animate: boolean;
  motionIndex: number;
}): Promise<ResolvedSource> {
  const generated = await generateBrollStills({
    prompts: [params.beat.query],
    aspectRatio: params.aspectRatio,
  });
  const image = generated.images[0];
  if (!image) throw new VideoGenProviderError("A generated presenter B-roll image was empty.");
  const bytes = params.animate
    ? await stillToClip(
        image,
        Math.max(0.5, (params.beat.endMs - params.beat.startMs) / 1000),
        params.aspectRatio,
        params.motionIndex % 2 === 0,
      )
    : image;
  return {
    bytes,
    contentType: params.animate ? "video/mp4" : "image/png",
    assetKind: params.animate ? "video" : "image",
    provider: generated.provider,
    model: generated.model,
    costPaise: await computeImageCostPaise({
      provider: generated.provider,
      model: generated.model,
    }).catch(() => null),
  };
}

async function resolveAsset(params: {
  beat: PlannedBeat;
  aspectRatio: VideoAspect;
  visualsSource: string;
  stockSource: StockSourceChoice;
  usedStockUrls: Set<string>;
  motionIndex: number;
}): Promise<ResolvedSource> {
  if (params.visualsSource === "ai" || params.visualsSource === "ai_video") {
    return resolveGeneratedBeat({
      beat: params.beat,
      aspectRatio: params.aspectRatio,
      animate: params.visualsSource === "ai_video",
      motionIndex: params.motionIndex,
    });
  }

  const asset = await resolveStockBeat({
    beat: params.beat,
    aspectRatio: params.aspectRatio,
    stockSource: params.stockSource,
    usedUrls: params.usedStockUrls,
  });
  return {
    bytes: asset.bytes,
    contentType: "video/mp4",
    assetKind: "video",
    provider: asset.provider,
  };
}

async function persistBeat(params: {
  snapshot: PresenterBrollSnapshot;
  index: number;
  beat: PlannedBeat;
  replaceAsset: boolean;
  aspectRatio: VideoAspect;
  visualsSource: string;
  stockSource: StockSourceChoice;
  usedStockUrls: Set<string>;
  upload: (bytes: Buffer, contentType: string) => Promise<string>;
  load: (objectPath: string) => Promise<Buffer>;
  onCheckpoint: (snapshot: PresenterBrollSnapshot) => Promise<void>;
}): Promise<PresenterBrollSnapshot> {
  let snapshot = params.snapshot;
  let current = snapshot.beats[params.index];
  if (!current) throw new VideoGenProviderError("A presenter B-roll beat is missing.");
  let freshBytes: Buffer | null = null;

  if (params.replaceAsset || !current.assetPath) {
    const source = await resolveAsset({
      beat: params.beat,
      aspectRatio: params.aspectRatio,
      visualsSource: params.visualsSource,
      stockSource: params.stockSource,
      usedStockUrls: params.usedStockUrls,
      motionIndex: params.index,
    });
    freshBytes = source.bytes;
    if (source.model) {
      const eventIndex = (snapshot.providerEvents?.length ?? 0) + 1;
      snapshot = {
        ...snapshot,
        providerEvents: [
          ...(snapshot.providerEvents ?? []),
          {
            eventId: `presenter-broll:${current.id}:${eventIndex}`,
            provider: source.provider,
            model: source.model,
            durationSec: null,
            requestBytes: Buffer.byteLength(params.beat.query),
            label: `presenter_broll_${current.id}_${eventIndex}`,
            costPaise: source.costPaise ?? null,
          },
        ],
      };
      // Persist the paid event before storage work. If upload fails, partial
      // settlement still retains the provider call that already completed.
      await params.onCheckpoint(snapshot);
    }
    const assetPath = await params.upload(source.bytes, source.contentType);
    const beats = snapshot.beats.map((beat, index) =>
      index === params.index
        ? {
            ...beat,
            ...params.beat,
            assetPath,
            previewPath: source.assetKind === "image" ? assetPath : null,
            assetKind: source.assetKind,
            provider: source.provider,
          }
        : beat,
    );
    snapshot = { ...snapshot, beats };
    await params.onCheckpoint(snapshot);
    current = snapshot.beats[params.index]!;
  }

  if (current.previewPath) return snapshot;
  if (!current.assetPath) {
    throw new VideoGenProviderError("A presenter B-roll asset could not be persisted.");
  }
  if (current.assetKind === "image") {
    const assetPath = current.assetPath;
    const beats = snapshot.beats.map((beat, index) =>
      index === params.index ? { ...beat, previewPath: assetPath } : beat,
    );
    snapshot = { ...snapshot, beats };
    await params.onCheckpoint(snapshot);
    return snapshot;
  }

  const videoBytes = freshBytes ?? (await params.load(current.assetPath));
  const previewPath = await params.upload(await extractPosterFrame(videoBytes), "image/png");
  const beats = snapshot.beats.map((beat, index) =>
    index === params.index ? { ...beat, previewPath } : beat,
  );
  snapshot = { ...snapshot, beats };
  await params.onCheckpoint(snapshot);
  return snapshot;
}

export async function resolvePresenterBrollAssets(params: {
  snapshot: PresenterBrollSnapshot;
  aspectRatio: VideoAspect;
  visualsSource: string;
  stockSource: StockSourceChoice;
  upload: (bytes: Buffer, contentType: string) => Promise<string>;
  load: (objectPath: string) => Promise<Buffer>;
  onStage: (stage: string) => void;
  onCheckpoint: (snapshot: PresenterBrollSnapshot) => Promise<void>;
}): Promise<PresenterBrollSnapshot> {
  let snapshot = params.snapshot;
  params.onStage(
    params.visualsSource === "stock" ? "Finding B-roll footage" : "Generating B-roll assets",
  );
  const usedStockUrls = new Set<string>();
  for (const [index, beat] of snapshot.beats.entries()) {
    if (beat.assetPath && beat.previewPath) continue;
    snapshot = await persistBeat({
      snapshot,
      index,
      beat,
      replaceAsset: false,
      aspectRatio: params.aspectRatio,
      visualsSource: params.visualsSource,
      stockSource: params.stockSource,
      usedStockUrls,
      upload: params.upload,
      load: params.load,
      onCheckpoint: params.onCheckpoint,
    });
  }
  return snapshot;
}

export function presenterStoryboard(snapshot: PresenterBrollSnapshot): VideoStoryboard {
  return {
    version: 1,
    presenterBroll: true,
    visualsSource: "prompt",
    timelineLocked: true,
    durationBounds: null,
    model: null,
    provider: snapshot.beats[0]?.provider ?? null,
    regenerations: 0,
    narration: null,
    scenes: snapshot.beats.map((beat) => ({
      id: beat.id,
      // The presenter's recorded audio is immutable. Keep this empty so the
      // generic storyboard editor exposes only the B-roll query, never a text
      // field whose edit could not change what the presenter already said.
      text: "",
      visual: beat.query,
      durationSec: (beat.endMs - beat.startMs) / 1000,
      previewPath: beat.previewPath,
      outfitId: null,
    })),
  };
}

/** Deterministic, provider-free B-roll plan for a generated Character Story.
 * Scene IDs stay aligned so visual direction and supporting B-roll can be
 * reviewed independently before any narration/image/video provider work. */
export function characterStoryPresenterBroll(
  storyboard: VideoStoryboard,
): PresenterBrollSnapshot {
  let cursorMs = 0;
  const lines = storyboard.scenes.map((scene, index) => {
    const startMs = cursorMs;
    cursorMs += Math.max(1, Math.round(scene.durationSec * 1000));
    return { index: index + 1, startMs, endMs: cursorMs, text: scene.text };
  });
  return {
    version: 1,
    durationMs: cursorMs,
    lines,
    beats: storyboard.scenes.map((scene, index) => ({
      id: scene.id,
      startMs: lines[index]!.startMs,
      endMs: lines[index]!.endMs,
      query: scene.brollVisual?.trim() || scene.text.split(/\s+/u).slice(0, 8).join(" "),
      kind: "lifestyle",
      opacity: 0.55,
      lineIndexes: [index + 1],
      assetPath: null,
      previewPath: null,
      assetKind: "video",
      provider: null,
    })),
    providerEvents: [],
    notes: [],
  };
}

export function unaccountedPresenterBrollEvents(
  snapshot: PresenterBrollSnapshot | null | undefined,
) {
  return (snapshot?.providerEvents ?? []).filter((event) => !event.accounted);
}

export async function syncReviewedPresenterBroll(params: {
  snapshot: PresenterBrollSnapshot;
  storyboard: VideoStoryboard;
  aspectRatio: VideoAspect;
  visualsSource: string;
  stockSource: StockSourceChoice;
  upload: (bytes: Buffer, contentType: string) => Promise<string>;
  load: (objectPath: string) => Promise<Buffer>;
  onStage: (stage: string) => void;
  onCheckpoint?: (snapshot: PresenterBrollSnapshot) => Promise<void>;
}): Promise<PresenterBrollSnapshot> {
  if (params.storyboard.scenes.length !== params.snapshot.beats.length) {
    throw new VideoGenProviderError("Presenter B-roll review cannot add or remove timed beats.");
  }
  const changed: { index: number; beat: PlannedBeat }[] = [];
  for (const [index, current] of params.snapshot.beats.entries()) {
    const scene = params.storyboard.scenes.find((candidate) => candidate.id === current.id);
    if (!scene) throw new VideoGenProviderError("A timed presenter B-roll beat is missing.");
    const query = scene.visual.trim();
    if (!query) throw new VideoGenProviderError("Every presenter B-roll beat needs a visual.");
    if (query !== current.query) changed.push({ index, beat: { ...current, query } });
  }
  if (changed.length === 0) return params.snapshot;

  params.onStage("Refreshing edited B-roll");
  let snapshot = params.snapshot;
  const usedStockUrls = new Set<string>();
  for (const entry of changed) {
    snapshot = await persistBeat({
      snapshot,
      index: entry.index,
      beat: entry.beat,
      replaceAsset: true,
      aspectRatio: params.aspectRatio,
      visualsSource: params.visualsSource,
      stockSource: params.stockSource,
      usedStockUrls,
      upload: params.upload,
      load: params.load,
      onCheckpoint: params.onCheckpoint ?? (async () => {}),
    });
  }
  return snapshot;
}

export async function renderPresenterBroll(params: {
  presenterVideo: Buffer;
  snapshot: PresenterBrollSnapshot;
  aspectRatio: VideoAspect;
  subtitles: boolean;
  captionStyle: "classic" | "dynamic";
  accentColor?: string | null;
  watermark?: Buffer | null;
  load: (objectPath: string, assetKind: "video" | "image") => Promise<Buffer>;
  onStage: (stage: string) => void;
}): Promise<Buffer> {
  const dimensions =
    params.aspectRatio === "16:9"
      ? { width: 1280, height: 720 }
      : params.aspectRatio === "1:1"
        ? { width: 720, height: 720 }
        : { width: 720, height: 1280 };
  const dir = await mkdtemp(join(tmpdir(), "kokao-presenter-render-"));
  try {
    const beats = [];
    for (const [index, beat] of params.snapshot.beats.entries()) {
      if (!beat.assetPath) {
        throw new VideoGenProviderError("A presenter B-roll asset is not ready.");
      }
      const assetPath = beat.assetPath;
      const extension = beat.assetKind === "image" ? "png" : "mp4";
      const file = join(dir, `beat-${index}.${extension}`);
      await writeFile(file, await params.load(assetPath, beat.assetKind));
      beats.push({
        file,
        still: beat.assetKind === "image",
        startMs: beat.startMs,
        endMs: beat.endMs,
        opacity: beat.opacity,
      });
    }
    params.onStage("Compositing presenter and B-roll");
    return await compositeBroll({
      baseVideo: params.presenterVideo,
      beats,
      width: dimensions.width,
      height: dimensions.height,
      durationMs: params.snapshot.durationMs,
      captions: params.subtitles ? params.snapshot.lines : [],
      captionStyle: params.captionStyle,
      accentColor: params.accentColor,
      watermark: params.watermark,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function presenterSceneForId(
  storyboard: VideoStoryboard,
  sceneId: string,
): VideoStoryboardScene | null {
  return storyboard.scenes.find((scene) => scene.id === sceneId) ?? null;
}