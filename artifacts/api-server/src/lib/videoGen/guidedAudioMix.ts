import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  GuidedStoryAudioChoices,
  GuidedStoryAudioPlacement,
  GuidedStoryReferenceLibrary,
  GuidedStoryScript,
  VideoJobOptions,
} from "@workspace/db";
import { referenceDigest } from "./topicVideo/referenceImages";
import { VideoGenProviderError } from "./types";

/**
 * Local finishing for Guided Story uploads: footage that covers a scene's
 * picture, and music / voiceover / sound effects mixed over the render.
 * Everything here is ffmpeg on the worker — no provider call, no charge.
 */

const exec = promisify(execFile);
export const MAX_GUIDED_AUDIO_PLACEMENTS = 12;
const FINISH_TIMEOUT_MS = 5 * 60_000;

export class GuidedAudioChoicesError extends Error {}

type AudioUse = "music" | "voiceover" | "sfx";
const AUDIO_USES: readonly string[] = ["music", "voiceover", "sfx"];

function finite(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? Math.round(value * 100) / 100
    : null;
}

/** Validate a client's placement list against the draft's uploads and scenes. */
export function validateGuidedAudioChoices(
  input: unknown,
  context: {
    references: GuidedStoryReferenceLibrary | null;
    script: GuidedStoryScript | null;
  },
): GuidedStoryAudioChoices | null {
  if (input === null) return null;
  const raw = input as { items?: unknown };
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.items)) {
    throw new GuidedAudioChoicesError("Audio placement must be a list.");
  }
  if (raw.items.length > MAX_GUIDED_AUDIO_PLACEMENTS) {
    throw new GuidedAudioChoicesError(`Place at most ${MAX_GUIDED_AUDIO_PLACEMENTS} audio clips.`);
  }
  const sceneIds = new Set(context.script?.scenes.map((scene) => scene.id) ?? []);
  const items: GuidedStoryAudioPlacement[] = [];
  for (const entry of raw.items) {
    const item = (entry ?? {}) as Record<string, unknown>;
    const ref = context.references?.items.find((candidate) => candidate.id === item.referenceId);
    if (!ref || !AUDIO_USES.includes(ref.use)) {
      throw new GuidedAudioChoicesError("Only music, voiceover and sound-effect uploads can be placed.");
    }
    const sceneId = item.sceneId == null ? null : String(item.sceneId);
    if (sceneId !== null && !sceneIds.has(sceneId)) {
      throw new GuidedAudioChoicesError(`@${ref.handle} is placed on a scene that is not in the script.`);
    }
    const startSeconds = finite(item.startSeconds ?? 0, 0, 600);
    const endSeconds = item.endSeconds == null ? null : finite(item.endSeconds, 0, 600);
    const volume = finite(item.volume ?? 1, 0, 1.5);
    if (startSeconds === null || volume === null || (item.endSeconds != null && endSeconds === null)) {
      throw new GuidedAudioChoicesError(`@${ref.handle} has an invalid start, end or volume.`);
    }
    if (endSeconds !== null && endSeconds <= startSeconds) {
      throw new GuidedAudioChoicesError(`@${ref.handle} must end after it starts.`);
    }
    items.push({
      referenceId: ref.id,
      sceneId,
      startSeconds,
      endSeconds,
      volume,
      duckUnderSpeech: ref.use === "music" ? item.duckUnderSpeech !== false : false,
      replaceGeneratedAudio: ref.use === "voiceover" ? item.replaceGeneratedAudio !== false : false,
    });
  }
  return { version: 1, items };
}

/** Drop placements whose upload or anchor scene disappeared. */
export function pruneGuidedAudioChoices(
  choices: GuidedStoryAudioChoices,
  context: { references: GuidedStoryReferenceLibrary | null; script: GuidedStoryScript | null },
): GuidedStoryAudioChoices | null {
  const refIds = new Set(
    (context.references?.items ?? []).filter((ref) => AUDIO_USES.includes(ref.use)).map((ref) => ref.id),
  );
  const sceneIds = new Set(context.script?.scenes.map((scene) => scene.id) ?? []);
  const items = choices.items.filter(
    (item) => refIds.has(item.referenceId) && (item.sceneId === null || sceneIds.has(item.sceneId)),
  );
  return items.length ? { version: 1, items } : null;
}

export interface GuidedFinishingPlan {
  version: 1;
  footage: Array<{ handle: string; path: string; sha256: string; startSec: number; endSec: number }>;
  layers: Array<{
    handle: string;
    use: AudioUse;
    path: string;
    sha256: string;
    startSec: number;
    endSec: number | null;
    volume: number;
    duck: boolean;
    replace: boolean;
  }>;
  /** Presenter face bubble over footage scenes; absent on older plans. */
  faceBubble?: { corner: "bottom_right" | "bottom_left" | "top_right" | "top_left" } | null;
}

type GuidedSnapshot = NonNullable<VideoJobOptions["guidedStory"]>;

/** Scene windows in the finished video's seconds. */
export function guidedSceneWindows(
  script: GuidedStoryScript,
  actualDurationSec: number,
  renderedTimeline?: VideoJobOptions["renderedTimeline"],
): Map<string, { startSec: number; endSec: number }> {
  const windows = new Map<string, { startSec: number; endSec: number }>();
  if (renderedTimeline?.scenes.length) {
    for (const scene of renderedTimeline.scenes) {
      windows.set(scene.sceneId, { startSec: scene.startSec, endSec: scene.endSec });
    }
  }
  const runtime = script.runtimeSeconds > 0 ? script.runtimeSeconds : 1;
  // Renders rarely land on the planned milliseconds; scale the plan to fit.
  const scale = actualDurationSec > 0 ? Math.min(1.5, Math.max(0.5, actualDurationSec / runtime)) : 1;
  for (const scene of script.scenes) {
    if (windows.has(scene.id)) continue;
    windows.set(scene.id, {
      startSec: (scene.startMs / 1000) * scale,
      endSec: (scene.endMs / 1000) * scale,
    });
  }
  return windows;
}

/**
 * Freeze-time plan from the job snapshot. Uploads with no explicit placement
 * get sensible defaults: music under the whole video, a voiceover from the
 * start. Sound effects play only where the user placed them.
 */
export function planGuidedFinishing(
  snapshot: GuidedSnapshot | null | undefined,
  actualDurationSec: number,
  renderedTimeline?: VideoJobOptions["renderedTimeline"],
): GuidedFinishingPlan | null {
  const library = snapshot?.references;
  if (!snapshot || !library?.items.length) return null;
  const windows = guidedSceneWindows(snapshot.script, actualDurationSec, renderedTimeline);
  const footage: GuidedFinishingPlan["footage"] = [];
  for (const scene of snapshot.script.scenes) {
    for (const id of scene.referenceIds ?? []) {
      const ref = library.items.find((item) => item.id === id);
      const window = windows.get(scene.id);
      if (ref?.use === "footage" && window) {
        footage.push({ handle: ref.handle, path: ref.path, sha256: ref.sha256, startSec: window.startSec, endSec: window.endSec });
      }
    }
  }
  const placements = snapshot.audioChoices?.items ?? [];
  const layers: GuidedFinishingPlan["layers"] = [];
  for (const ref of library.items) {
    if (!AUDIO_USES.includes(ref.use)) continue;
    const use = ref.use as AudioUse;
    const own = placements.filter((item) => item.referenceId === ref.id);
    const effective: GuidedStoryAudioPlacement[] = own.length
      ? own
      : use === "music"
        ? [{ referenceId: ref.id, sceneId: null, startSeconds: 0, endSeconds: null, volume: 0.3, duckUnderSpeech: true, replaceGeneratedAudio: false }]
        : use === "voiceover"
          ? [{ referenceId: ref.id, sceneId: null, startSeconds: 0, endSeconds: null, volume: 1, duckUnderSpeech: false, replaceGeneratedAudio: true }]
          : [];
    for (const item of effective) {
      const anchor = item.sceneId ? windows.get(item.sceneId)?.startSec ?? null : 0;
      if (anchor === null) continue;
      layers.push({
        handle: ref.handle,
        use,
        path: ref.path,
        sha256: ref.sha256,
        startSec: anchor + item.startSeconds,
        endSec: item.endSeconds === null ? null : anchor + item.endSeconds,
        volume: item.volume,
        duck: use === "music" && item.duckUnderSpeech,
        replace: use === "voiceover" && item.replaceGeneratedAudio,
      });
    }
  }
  const faceBubble = snapshot.promoOverlays?.faceBubble?.enabled && footage.length
    ? { corner: snapshot.promoOverlays.faceBubble.corner }
    : null;
  return footage.length || layers.length
    ? { version: 1, footage, layers, ...(faceBubble ? { faceBubble } : {}) }
    : null;
}

async function probe(file: string): Promise<{ durationSec: number; width: number; height: number; hasAudio: boolean }> {
  const { stdout } = await exec(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", file],
    { timeout: 20_000, maxBuffer: 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
  };
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  return {
    durationSec: Number(parsed.format?.duration) || 0,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    hasAudio: (parsed.streams ?? []).some((stream) => stream.codec_type === "audio"),
  };
}

const t = (value: number) => value.toFixed(3);

/**
 * Circular presenter cam in a corner, shown only during footage scenes.
 *
 * The face is cropped from the render underneath the footage: with the face
 * bubble on, the script has the presenter speak those lines on camera in a
 * close-up, so the crop is lip-synced to the voice. A thin white ring keeps it
 * readable over busy screen recordings. Exported for tests.
 */
export function faceBubbleFilters(params: {
  source: string;
  under: string;
  output: string;
  width: number;
  height: number;
  corner: NonNullable<GuidedFinishingPlan["faceBubble"]>["corner"];
  windows: Array<{ startSec: number; endSec: number }>;
}): string[] {
  const shortEdge = Math.min(params.width, params.height);
  const size = Math.max(64, Math.round((shortEdge * 0.34) / 2) * 2);
  const margin = Math.round(shortEdge * 0.045);
  const right = params.corner.endsWith("right");
  const top = params.corner.startsWith("top");
  const x = right ? params.width - size - margin : margin;
  // Clear of the platform's top bar; bottom corners end above the lower-third
  // text band so the bubble never sits on the on-screen offer line.
  const y = top ? Math.round(params.height * 0.12) : Math.round(params.height * 0.62) - size;
  const ring = Math.max(3, Math.round(size * 0.025));
  const inside = `lte(hypot(X-W/2,Y-H/2),W/2)`;
  const onRing = `gt(hypot(X-W/2,Y-H/2),W/2-${ring})`;
  const enable = params.windows.map((w) => `between(t,${t(w.startSec)},${t(w.endSec)})`).join("+");
  return [
    `[${params.source}]crop=w='min(iw,ih)*0.62':h='min(iw,ih)*0.62':x='(iw-ow)/2':y='(ih-oh)*0.3',scale=${size}:${size},format=yuva444p,` +
      `geq=lum='if(${onRing},235,lum(X,Y))':cb='if(${onRing},128,cb(X,Y))':cr='if(${onRing},128,cr(X,Y))':a='if(${inside},255,0)'[bub]`,
    `[${params.under}][bub]overlay=${x}:${y}:enable='${enable}'[${params.output}]`,
  ];
}

/** The ffmpeg arguments for a plan. Exported for tests. */
export function guidedFinishingArgs(params: {
  plan: GuidedFinishingPlan;
  base: { file: string; durationSec: number; width: number; height: number; hasAudio: boolean };
  footageFiles: string[];
  layerFiles: string[];
  output: string;
}): string[] {
  const { plan, base } = params;
  const D = base.durationSec;
  const args = ["-y", "-v", "error", "-i", base.file];
  for (const file of params.footageFiles) args.push("-stream_loop", "-1", "-i", file);
  for (const file of params.layerFiles) args.push("-i", file);
  const filters: string[] = [];
  let videoLabel = "0:v";
  const footage = plan.footage.filter((item) => item.startSec < D);
  const bubble = plan.faceBubble && footage.length ? plan.faceBubble : null;
  if (bubble) {
    // Keep an untouched copy of the render: during a footage scene it holds
    // the presenter speaking on camera, which becomes the bubble.
    filters.push("[0:v]split=2[basev][bubsrc]");
    videoLabel = "basev";
  }
  footage.forEach((item, index) => {
    const input = 1 + plan.footage.indexOf(item);
    const end = Math.min(item.endSec, D);
    const length = Math.max(0.1, end - item.startSec);
    filters.push(
      `[${input}:v]scale=${base.width}:${base.height}:force_original_aspect_ratio=increase,crop=${base.width}:${base.height},setsar=1,fps=30,trim=duration=${t(length)},setpts=PTS-STARTPTS+${t(item.startSec)}/TB[fv${index}]`,
      `[${videoLabel}][fv${index}]overlay=eof_action=pass:enable='between(t,${t(item.startSec)},${t(end)})'[v${index}]`,
    );
    videoLabel = `v${index}`;
  });
  if (bubble) {
    filters.push(...faceBubbleFilters({
      source: "bubsrc",
      under: videoLabel,
      output: "vbub",
      width: base.width,
      height: base.height,
      corner: bubble.corner,
      windows: footage.map((item) => ({ startSec: item.startSec, endSec: Math.min(item.endSec, D) })),
    }));
    videoLabel = "vbub";
  }
  const replaceWindows = plan.layers
    .filter((layer) => layer.replace && layer.startSec < D)
    .map((layer) => `between(t,${t(layer.startSec)},${t(Math.min(layer.endSec ?? D, D))})`);
  filters.push(
    `${base.hasAudio ? "[0:a]" : `anullsrc=r=48000:cl=stereo,atrim=duration=${t(D)},`}aresample=48000,aformat=channel_layouts=stereo${
      replaceWindows.length ? `,volume=0:enable='${replaceWindows.join("+")}'` : ""
    }[base]`,
  );
  const layers = plan.layers.filter((layer) => layer.startSec < D);
  const ducked = layers.filter((layer) => layer.duck).length;
  filters.push(
    ducked
      ? `[base]asplit=${ducked + 1}[mixbase]${Array.from({ length: ducked }, (_v, i) => `[sc${i}]`).join("")}`
      : "[base]anull[mixbase]",
  );
  const mixInputs = ["[mixbase]"];
  let duckIndex = 0;
  layers.forEach((layer) => {
    const input = 1 + params.footageFiles.length + plan.layers.indexOf(layer);
    const length = Math.max(0.1, Math.min(layer.endSec ?? D, D) - layer.startSec);
    const delayMs = Math.round(layer.startSec * 1000);
    const label = `l${input}`;
    filters.push(
      `[${input}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=${t(length)},asetpts=PTS-STARTPTS,volume=${layer.volume.toFixed(2)},adelay=${delayMs}|${delayMs}[${label}]`,
    );
    if (layer.duck) {
      filters.push(`[${label}][sc${duckIndex}]sidechaincompress=threshold=0.02:ratio=10:attack=20:release=500[${label}d]`);
      duckIndex += 1;
      mixInputs.push(`[${label}d]`);
    } else {
      mixInputs.push(`[${label}]`);
    }
  });
  filters.push(
    `${mixInputs.join("")}amix=inputs=${mixInputs.length}:duration=first:normalize=0,alimiter=limit=0.95[aout]`,
  );
  args.push("-filter_complex", filters.join(";"));
  args.push("-map", footage.length ? `[${videoLabel}]` : "0:v", "-map", "[aout]");
  args.push(
    ...(footage.length ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"] : ["-c:v", "copy"]),
    "-c:a", "aac", "-b:a", "192k", "-t", t(D), "-movflags", "+faststart", params.output,
  );
  return args;
}

const EXT_FOR_SNIFF = (bytes: Buffer): string => {
  const head = bytes.subarray(0, 12);
  if (head.subarray(4, 8).toString("latin1") === "ftyp") return "mp4";
  if (head.subarray(0, 4).toString("latin1") === "RIFF") return "wav";
  if (head.subarray(0, 4).toString("latin1") === "OggS") return "ogg";
  if (head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "webm";
  if (head.subarray(0, 3).toString("latin1") === "ID3" || (head[0] === 0xff && (head[1]! & 0xe0) === 0xe0)) return "mp3";
  return "bin";
};

/**
 * Apply a finishing plan to a rendered video. Every upload's bytes are checked
 * against the hash frozen at enqueue; a changed file fails the job before the
 * final upload rather than mixing in content the user never approved.
 */
export async function applyGuidedFinishing(params: {
  buffer: Buffer;
  plan: GuidedFinishingPlan;
  load: (path: string) => Promise<Buffer>;
}): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "kokao-guided-finish-"));
  try {
    const baseFile = join(dir, "base.mp4");
    await writeFile(baseFile, params.buffer);
    const base = await probe(baseFile);
    if (!base.durationSec || !base.width || !base.height) {
      throw new VideoGenProviderError("The rendered video could not be read for final mixing.");
    }
    const fetchVerified = async (item: { handle: string; path: string; sha256: string }, name: string) => {
      const bytes = await params.load(item.path).catch(() => null);
      if (!bytes || referenceDigest(bytes) !== item.sha256) {
        throw new VideoGenProviderError(
          `The upload @${item.handle} changed or was removed after this story was approved. Upload it again and start a new attempt.`,
        );
      }
      const file = join(dir, `${name}.${EXT_FOR_SNIFF(bytes)}`);
      await writeFile(file, bytes);
      return file;
    };
    const footageFiles: string[] = [];
    for (const [index, item] of params.plan.footage.entries()) footageFiles.push(await fetchVerified(item, `footage-${index}`));
    const layerFiles: string[] = [];
    for (const [index, item] of params.plan.layers.entries()) layerFiles.push(await fetchVerified(item, `audio-${index}`));
    const output = join(dir, "finished.mp4");
    try {
      await exec(
        "ffmpeg",
        guidedFinishingArgs({ plan: params.plan, base: { file: baseFile, ...base }, footageFiles, layerFiles, output }),
        { timeout: FINISH_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      );
    } catch (error) {
      const detail = (error as { stderr?: string }).stderr?.slice(-400) ?? "";
      throw new VideoGenProviderError(`Mixing your uploads into the video failed. ${detail}`.trim());
    }
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
