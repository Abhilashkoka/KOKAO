import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import type {
  SmartEditAttempt,
  SmartEditBox,
  SmartEditState,
  SmartEditType,
  SmartEditVersion,
  VideoGeneration,
} from "@workspace/db";
import { creditsMilliFor, MILLI } from "../creditRates";
import { ObjectStorageService } from "../objectStorage";

/**
 * Smart Edit.
 *
 * A finished video is never edited in place. The user marks a time range (and
 * optionally a box on the frame) and says what should change; we cut only that
 * range out, regenerate it on its own, show it for approval, and only then
 * stitch it back into a NEW version. The user can repeat this on any part, as
 * often as they like; every approved edit builds on the current version and
 * earlier versions stay restorable.
 */

export const SMART_EDIT_TYPES: readonly SmartEditType[] = ["change", "remove", "outfit", "dialogue", "regenerate"];
export const SMART_EDIT_MIN_SECONDS = 1;
export const SMART_EDIT_MAX_SECONDS = 12;
/** Approved versions kept besides the original. */
export const SMART_EDIT_KEEP_VERSIONS = 10;
const KEEP_EDIT_ATTEMPTS = 40;
const MAX_BASE_VIDEO_BYTES = 250 * 1024 * 1024;
const FFMPEG_TIMEOUT_MS = 4 * 60_000;

const exec = promisify(execFile);
const storage = new ObjectStorageService();

export class SmartEditInputError extends Error {}

export interface SmartEditRequest {
  type: SmartEditType;
  startSec: number;
  endSec: number;
  box: SmartEditBox | null;
  instruction: string;
  dialogueText: string | null;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/** Normalize and validate an edit request against the video's length. */
export function validateSmartEditRequest(
  input: {
    type?: unknown;
    startSec?: unknown;
    endSec?: unknown;
    box?: unknown;
    instruction?: unknown;
    dialogueText?: unknown;
  },
  videoDurationSec: number,
): SmartEditRequest {
  const type = input.type as SmartEditType;
  if (!SMART_EDIT_TYPES.includes(type)) throw new SmartEditInputError("Choose what kind of edit to make.");
  const startSec = Number(input.startSec);
  const endSec = Number(input.endSec);
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec < 0 || endSec <= startSec) {
    throw new SmartEditInputError("Set a start and an end on the timeline.");
  }
  if (endSec > videoDurationSec + 0.05) throw new SmartEditInputError("The end is past the end of the video.");
  const length = Math.min(endSec, videoDurationSec) - startSec;
  if (length < SMART_EDIT_MIN_SECONDS - 0.01) throw new SmartEditInputError(`Select at least ${SMART_EDIT_MIN_SECONDS} second.`);
  if (length > SMART_EDIT_MAX_SECONDS + 0.01) {
    throw new SmartEditInputError(`Select at most ${SMART_EDIT_MAX_SECONDS} seconds per edit. Split longer changes into several edits.`);
  }
  let box: SmartEditBox | null = null;
  if (input.box != null) {
    const raw = input.box as Record<string, unknown>;
    const values = ["x", "y", "width", "height"].map((key) => Number(raw[key]));
    if (values.some((value) => !Number.isFinite(value))) throw new SmartEditInputError("The marked area is invalid.");
    let [x, y, width, height] = values as [number, number, number, number];
    x = Math.min(1, Math.max(0, x));
    y = Math.min(1, Math.max(0, y));
    width = Math.min(1 - x, Math.max(0, width));
    height = Math.min(1 - y, Math.max(0, height));
    if (width < 0.02 || height < 0.02) throw new SmartEditInputError("Drag a larger box around the area to edit.");
    const r4 = (value: number) => Math.round(value * 10_000) / 10_000;
    box = { x: r4(x), y: r4(y), width: r4(width), height: r4(height) };
  }
  if (type === "remove" && !box) throw new SmartEditInputError("Drag a box around what should be removed.");
  const instruction = typeof input.instruction === "string" ? input.instruction.replace(/\s+/g, " ").trim().slice(0, 600) : "";
  const dialogueText = typeof input.dialogueText === "string" ? input.dialogueText.replace(/\s+/g, " ").trim().slice(0, 600) : "";
  if (type === "dialogue") {
    if (dialogueText.length < 2) throw new SmartEditInputError("Type the new line to be spoken.");
  } else if (type !== "remove" && type !== "regenerate" && instruction.length < 3) {
    throw new SmartEditInputError("Describe the change in a few words.");
  }
  return {
    type,
    startSec: round2(startSec),
    endSec: round2(Math.min(endSec, videoDurationSec)),
    box,
    instruction,
    dialogueText: type === "dialogue" ? dialogueText : null,
  };
}

/** Frame edits each type needs (the box drives an image inpaint). */
export function smartEditFrameEdits(request: Pick<SmartEditRequest, "type" | "box">, withEndFrame: boolean): number {
  if (request.type === "dialogue" || request.type === "regenerate") return 0;
  return withEndFrame ? 2 : 1;
}

export interface SmartEditQuote {
  credits: number;
  lines: Array<{ rateKey: string; quantity: number; credits: number }>;
}

/** Credits for one attempt, from the same rate card the meter charges. */
export async function quoteSmartEdit(
  request: Pick<SmartEditRequest, "type" | "box" | "startSec" | "endSec" | "dialogueText">,
  withEndFrame: boolean,
): Promise<SmartEditQuote> {
  const seconds = Math.max(3, Math.ceil(request.endSec - request.startSec));
  const lines: SmartEditQuote["lines"] = [];
  const add = async (rateKey: string, quantity: number) => {
    const milli = (await creditsMilliFor(rateKey, quantity)) ?? 0;
    lines.push({ rateKey, quantity, credits: Math.round(milli) / MILLI });
  };
  const frames = smartEditFrameEdits(request, withEndFrame);
  if (frames) await add("image_edit", frames);
  if (request.type === "dialogue") {
    const speechSeconds = Math.max(1, Math.ceil(((request.dialogueText ?? "").split(/\s+/).filter(Boolean).length) / 2.5));
    await add("voice", speechSeconds);
    await add("lipsync", Math.max(seconds, speechSeconds));
  } else {
    await add("video", seconds);
  }
  return { credits: Math.round(lines.reduce((sum, line) => sum + line.credits, 0) * MILLI) / MILLI, lines };
}

/** What the image model is told to do inside the box. */
export function smartEditFramePrompt(request: Pick<SmartEditRequest, "type" | "instruction">): string {
  const keep = "Keep everything outside the transparent region exactly as it is, including faces, lighting, colour grade, grain and perspective.";
  switch (request.type) {
    case "remove":
      return "Erase whatever is in the transparent region and continue the surrounding scene through it. Do not add any new object, person, text or decoration. " + keep;
    case "outfit":
      return `Change only the clothing in the transparent region to: ${request.instruction}. Keep the person's face, hair, body, pose and identity unchanged. ${keep}`;
    default:
      return `${request.instruction}. ${keep} The change must look like part of the original photograph.`;
  }
}

/** What the video model is told when regenerating the cut. Owner text is quoted data. */
export function smartEditClipPrompt(params: {
  request: Pick<SmartEditRequest, "type" | "instruction">;
  sceneVisual: string | null;
  hasEndFrame: boolean;
}): string {
  const { request } = params;
  const continuity = params.hasEndFrame
    ? "Start exactly on the first frame and end exactly on the last frame."
    : "Start exactly on the first frame.";
  const change =
    request.type === "regenerate"
      ? request.instruction
        ? `Re-shoot this moment with this direction: "${request.instruction}".`
        : "Re-shoot this moment with the same action and framing."
      : request.type === "remove"
        ? "The removed object stays gone for the whole shot."
        : `Keep this change visible and consistent for the whole shot: "${request.instruction}".`;
  return [
    change,
    params.sceneVisual ? `Scene: ${params.sceneVisual.slice(0, 600)}` : null,
    continuity,
    "Keep the same people, faces, clothing, setting, lighting and camera framing as the first frame. Natural, continuous motion; no cuts, no text, no new people.",
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 1900);
}

/** A source-sized PNG where the box (or the whole frame) is transparent. */
export async function smartEditMask(width: number, height: number, box: SmartEditBox | null): Promise<Buffer> {
  if (!box) {
    return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  }
  const left = Math.max(0, Math.floor(box.x * width));
  const top = Math.max(0, Math.floor(box.y * height));
  const w = Math.max(1, Math.min(width - left, Math.ceil(box.width * width)));
  const h = Math.max(1, Math.min(height - top, Math.ceil(box.height * height)));
  // dest-out removes the destination wherever the source is opaque.
  const hole = await sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } })
    .png()
    .toBuffer();
  return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } })
    .composite([{ input: hole, left, top, blend: "dest-out" }])
    .png()
    .toBuffer();
}

/** Bring an edited frame back to the exact source frame size. */
export async function fitFrame(buffer: Buffer, width: number, height: number): Promise<Buffer> {
  return sharp(buffer).resize(width, height, { fit: "fill" }).png().toBuffer();
}

export interface VideoProbe {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
}

export async function probeVideoFile(file: string): Promise<VideoProbe> {
  const { stdout } = await exec(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height,r_frame_rate", "-of", "json", file],
    { timeout: 20_000, maxBuffer: 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; width?: number; height?: number; r_frame_rate?: string }>;
  };
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  const [num, den] = (video?.r_frame_rate ?? "30/1").split("/").map(Number);
  const fps = num && den ? num / den : 30;
  return {
    durationSec: Number(parsed.format?.duration) || 0,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    fps: Number.isFinite(fps) && fps > 1 && fps <= 120 ? Math.round(fps * 1000) / 1000 : 30,
    hasAudio: (parsed.streams ?? []).some((stream) => stream.codec_type === "audio"),
  };
}

export async function probeVideoBuffer(buffer: Buffer): Promise<VideoProbe> {
  const dir = await mkdtemp(join(tmpdir(), "kokao-smart-probe-"));
  try {
    const file = join(dir, "in.mp4");
    await writeFile(file, buffer);
    return await probeVideoFile(file);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function ffmpeg(args: string[]): Promise<void> {
  try {
    await exec("ffmpeg", ["-y", "-v", "error", ...args], { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    const detail = (error as { stderr?: string }).stderr?.slice(-300) ?? "";
    throw new Error(`Video processing failed. ${detail}`.trim());
  }
}

export interface SmartEditCut {
  clip: Buffer;
  startFrame: Buffer;
  endFrame: Buffer;
  probe: VideoProbe;
}

/** Cut [start, end) out of a video (frame-accurate) plus its first and last frames. */
export async function cutSmartEditSegment(video: Buffer, startSec: number, endSec: number): Promise<SmartEditCut> {
  const dir = await mkdtemp(join(tmpdir(), "kokao-smart-cut-"));
  try {
    const input = join(dir, "in.mp4");
    await writeFile(input, video);
    const probe = await probeVideoFile(input);
    const end = Math.min(endSec, probe.durationSec);
    const length = Math.max(0.1, end - startSec);
    const clip = join(dir, "cut.mp4");
    await ffmpeg([
      "-ss", startSec.toFixed(3), "-i", input, "-t", length.toFixed(3),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
      ...(probe.hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : ["-an"]),
      "-movflags", "+faststart", clip,
    ]);
    const first = join(dir, "first.png");
    const last = join(dir, "last.png");
    await ffmpeg(["-ss", startSec.toFixed(3), "-i", input, "-frames:v", "1", first]);
    await ffmpeg(["-ss", Math.max(startSec, end - 1 / probe.fps).toFixed(3), "-i", input, "-frames:v", "1", last]);
    return {
      clip: await readFile(clip),
      startFrame: await readFile(first),
      endFrame: await readFile(last),
      probe,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const t = (value: number) => value.toFixed(3);

/** ffmpeg arguments for re-stitching. Exported for tests. */
export function smartEditStitchArgs(params: {
  base: VideoProbe;
  clipHasAudio: boolean;
  startSec: number;
  endSec: number;
  /** Length the new clip occupies in the result. */
  clipSec: number;
  audio: "original" | "clip";
  output: string;
}): string[] {
  const { base, startSec, audio } = params;
  const endSec = Math.min(params.endSec, base.durationSec);
  const W = base.width;
  const H = base.height;
  const fps = base.fps;
  const norm = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${fps},format=yuv420p`;
  const filters: string[] = [];
  const videoParts: string[] = [];
  const hasHead = startSec > 0.01;
  const hasTail = endSec < base.durationSec - 0.01;
  // An input pad can feed only one filter: split the base for head and tail.
  const baseVideoUses = Number(hasHead) + Number(hasTail);
  const baseVideo = baseVideoUses === 2 ? ["[bv0]", "[bv1]"] : ["[0:v]", "[0:v]"];
  if (baseVideoUses === 2) filters.push("[0:v]split=2[bv0][bv1]");
  if (hasHead) {
    filters.push(`${baseVideo[0]}trim=start=0:end=${t(startSec)},setpts=PTS-STARTPTS,${norm}[vpre]`);
    videoParts.push("[vpre]");
  }
  // The new clip is held on its last frame if short, and trimmed if long.
  filters.push(
    `[1:v]${norm},tpad=stop_mode=clone:stop_duration=${t(params.clipSec)},trim=duration=${t(params.clipSec)},setpts=PTS-STARTPTS[vmid]`,
  );
  videoParts.push("[vmid]");
  if (hasTail) {
    filters.push(`${baseVideo[hasHead ? 1 : 0]}trim=start=${t(endSec)},setpts=PTS-STARTPTS,${norm}[vpost]`);
    videoParts.push("[vpost]");
  }
  filters.push(`${videoParts.join("")}concat=n=${videoParts.length}:v=1:a=0[v]`);
  const map = ["-map", "[v]"];
  if (audio === "original") {
    // Same length as before: the original soundtrack stays perfectly in sync.
    if (base.hasAudio) map.push("-map", "0:a");
  } else {
    const fmt = "aresample=48000,aformat=channel_layouts=stereo";
    const audioParts: string[] = [];
    const baseAudio = base.hasAudio && baseVideoUses === 2 ? ["[ba0]", "[ba1]"] : ["[0:a]", "[0:a]"];
    if (base.hasAudio && baseVideoUses === 2) filters.push("[0:a]asplit=2[ba0][ba1]");
    if (hasHead) {
      filters.push(
        base.hasAudio
          ? `${baseAudio[0]}atrim=start=0:end=${t(startSec)},asetpts=PTS-STARTPTS,${fmt},afade=t=out:st=${t(Math.max(0, startSec - 0.03))}:d=0.03[apre]`
          : `anullsrc=r=48000:cl=stereo,atrim=duration=${t(startSec)}[apre]`,
      );
      audioParts.push("[apre]");
    }
    filters.push(
      params.clipHasAudio
        ? `[1:a]${fmt},apad,atrim=duration=${t(params.clipSec)},asetpts=PTS-STARTPTS,afade=t=in:d=0.03[amid]`
        : `anullsrc=r=48000:cl=stereo,atrim=duration=${t(params.clipSec)}[amid]`,
    );
    audioParts.push("[amid]");
    if (hasTail) {
      filters.push(
        base.hasAudio
          ? `${baseAudio[hasHead ? 1 : 0]}atrim=start=${t(endSec)},asetpts=PTS-STARTPTS,${fmt},afade=t=in:d=0.03[apost]`
          : `anullsrc=r=48000:cl=stereo,atrim=duration=${t(base.durationSec - endSec)}[apost]`,
      );
      audioParts.push("[apost]");
    }
    filters.push(`${audioParts.join("")}concat=n=${audioParts.length}:v=0:a=1[a]`);
    map.push("-map", "[a]");
  }
  return [
    "-filter_complex", filters.join(";"),
    ...map,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", params.output,
  ];
}

/**
 * Replace [start, end) of `base` with `clip`. With original audio the result
 * keeps the exact length; with the clip's audio (a rewritten line) the
 * timeline follows the new clip.
 */
export async function stitchSmartEdit(params: {
  base: Buffer;
  clip: Buffer;
  startSec: number;
  endSec: number;
  audio: "original" | "clip";
}): Promise<{ video: Buffer; thumbnail: Buffer; durationSec: number }> {
  const dir = await mkdtemp(join(tmpdir(), "kokao-smart-stitch-"));
  try {
    const baseFile = join(dir, "base.mp4");
    const clipFile = join(dir, "clip.mp4");
    const output = join(dir, "out.mp4");
    await writeFile(baseFile, params.base);
    await writeFile(clipFile, params.clip);
    const base = await probeVideoFile(baseFile);
    const clip = await probeVideoFile(clipFile);
    if (!base.width || !base.height || !base.durationSec) throw new Error("The current video could not be read.");
    if (!clip.durationSec) throw new Error("The regenerated clip could not be read.");
    const rangeSec = Math.min(params.endSec, base.durationSec) - params.startSec;
    const clipSec = params.audio === "original" ? rangeSec : Math.max(0.5, clip.durationSec);
    await ffmpeg(["-i", baseFile, "-i", clipFile, ...smartEditStitchArgs({
      base,
      clipHasAudio: clip.hasAudio,
      startSec: params.startSec,
      endSec: params.endSec,
      clipSec,
      audio: params.audio,
      output,
    })]);
    const thumb = join(dir, "thumb.png");
    await ffmpeg(["-ss", Math.min(params.startSec + 0.2, Math.max(0, base.durationSec - 0.1)).toFixed(3), "-i", output, "-frames:v", "1", thumb]);
    const result = await probeVideoFile(output);
    return { video: await readFile(output), thumbnail: await readFile(thumb), durationSec: result.durationSec };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Read a tenant object with a size cap. */
export async function loadTenantVideo(path: string, tenantId: number, maxBytes = MAX_BASE_VIDEO_BYTES): Promise<Buffer> {
  if (!path.startsWith(`/objects/${tenantId}/`) || /[\\%?#]/.test(path) || path.includes("..")) {
    throw new SmartEditInputError("This video is not stored in your workspace.");
  }
  const file = await storage.getObjectEntityFile(path, tenantId);
  const [metadata] = await file.getMetadata();
  if (Number(metadata.size ?? 0) > maxBytes) throw new SmartEditInputError("This video is too large to edit.");
  const [buffer] = await file.download();
  return buffer;
}

/** The version every new edit starts from; the original when nothing was approved yet. */
export function smartEditCurrentVersion(state: SmartEditState | null | undefined): SmartEditVersion | null {
  if (!state) return null;
  return [state.original, ...state.versions].find((version) => version.id === state.currentVersionId) ?? state.original;
}

/** The path a finished job currently plays, honouring Smart Edit versions. */
export function smartEditCurrentPath(job: Pick<VideoGeneration, "videoPath" | "options">): string | null {
  const state = job.options?.smartEdit;
  if (!state || state.currentVersionId === state.original.id) return null;
  return smartEditCurrentVersion(state)?.path ?? null;
}

/** First Smart Edit on a job: the original render becomes version "v0". */
export function initialSmartEditState(job: Pick<VideoGeneration, "videoPath" | "thumbnailPath">, durationSec: number): SmartEditState {
  const original: SmartEditVersion = {
    id: "v0",
    path: job.videoPath!,
    thumbnailPath: job.thumbnailPath ?? null,
    durationSec,
    createdAt: new Date().toISOString(),
    editId: null,
    label: "Original",
  };
  return { version: 1, original, versions: [], currentVersionId: original.id, edits: [] };
}

export function newSmartEditId(): string {
  return `e_${randomUUID().slice(0, 12)}`;
}

/** Record an attempt, keeping the history bounded. */
export function withSmartEditAttempt(state: SmartEditState, attempt: SmartEditAttempt): SmartEditState {
  const edits = [...state.edits.filter((edit) => edit.id !== attempt.id), attempt].slice(-KEEP_EDIT_ATTEMPTS);
  return { ...state, edits };
}

/**
 * Add an approved version and make it current. Restoring an old version and
 * then editing branches from it; the newest SMART_EDIT_KEEP_VERSIONS stay.
 */
export function withSmartEditVersion(state: SmartEditState, version: SmartEditVersion): SmartEditState {
  const versions = [...state.versions, version].slice(-SMART_EDIT_KEEP_VERSIONS);
  return { ...state, versions, currentVersionId: version.id };
}

export function nextSmartEditVersionId(state: SmartEditState): string {
  const numbers = [state.original, ...state.versions].map((version) => Number(version.id.slice(1)) || 0);
  return `v${Math.max(0, ...numbers) + 1}`;
}

export function smartEditTypeLabel(type: SmartEditType): string {
  return {
    change: "Change",
    remove: "Remove",
    outfit: "Outfit",
    dialogue: "New line",
    regenerate: "Re-shoot",
  }[type];
}

/** What the live status of an attempt is, given its child job. */
export function smartEditAttemptStatus(
  attempt: SmartEditAttempt,
  child: Pick<VideoGeneration, "status" | "videoPath" | "error"> | null,
): "generating" | "ready" | "failed" | "approved" | "discarded" {
  if (attempt.status === "approved" || attempt.status === "discarded") return attempt.status;
  if (attempt.error && !child) return "failed";
  if (!child) return "generating";
  if (child.status === "succeeded" && child.videoPath) return "ready";
  if (["failed", "cancelled", "canceled", "rejected"].includes(child.status)) return "failed";
  return "generating";
}
