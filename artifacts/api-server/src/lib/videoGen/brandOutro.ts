import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrandKitPayload } from "@workspace/db";
import { ObjectStorageService } from "../objectStorage";
import { runFfmpeg } from "./slideshow";

const exec = promisify(execFile);
const storage = new ObjectStorageService();
export const MAX_OUTRO_CLIP_BYTES = 40 * 1024 * 1024;
const MAX_LOGO_BYTES = 10 * 1024 * 1024;
const VIDEO_MIMES = new Set(["video/mp4", "video/webm"]);
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);

function hasVideoContainerSignature(bytes: Buffer, mime: string): boolean {
  if (mime === "video/mp4") {
    // ISO BMFF starts with a bounded ftyp box; QuickTime "qt  " is not MP4.
    const boxSize = bytes.length >= 12 ? bytes.readUInt32BE(0) : 0;
    return boxSize >= 12 && boxSize <= bytes.length &&
      bytes.toString("ascii", 4, 8) === "ftyp" &&
      bytes.toString("ascii", 8, 12) !== "qt  ";
  }
  // WebM's EBML magic and DocType are both needed; Matroska is not WebM.
  return mime === "video/webm" && bytes.length >= 16 &&
    bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) &&
    bytes.subarray(0, Math.min(bytes.length, 512)).includes(Buffer.from("webm"));
}

export interface BrandOutroSnapshot {
  clipSha256?: string;
  schemaVersion: 1;
  enabled: boolean;
  mode: "preset" | "upload";
  preset: "fade" | "zoom" | "slide";
  durationSeconds: number;
  backgroundColor: string;
  logoPath: string | null;
  clipPath: string | null;
}

export const DISABLED_BRAND_OUTRO: BrandOutroSnapshot = Object.freeze({
  schemaVersion: 1, enabled: false, mode: "preset", preset: "fade",
  durationSeconds: 3, backgroundColor: "#000000", logoPath: null, clipPath: null,
});

export function canonicalTenantObjectPath(path: string, tenantId: number): string {
  if (!Number.isInteger(tenantId) || tenantId <= 0 ||
      !new RegExp(`^/objects/${tenantId}/[A-Za-z0-9_./-]+$`).test(path) ||
      path.split("/").some((part) => part === "." || part === "..") ||
      path.includes("//")) {
    throw new Error("Outro assets must be canonical tenant-owned object paths.");
  }
  return path;
}

/** Existing brand-logo uploads save their serving URL rather than their raw object path. */
function canonicalPrimaryLogoPath(path: string, tenantId: number): string {
  const objectPath = path.startsWith("/api/storage/objects/")
    ? path.slice("/api/storage".length)
    : path;
  return canonicalTenantObjectPath(objectPath, tenantId);
}

export function validateBrandOutroSettings(
  settings: BrandKitPayload["video_outro"],
  tenantId: number,
  logoPath: string | null,
): BrandOutroSnapshot {
  if (!settings) return DISABLED_BRAND_OUTRO;
  if (typeof settings.enabled !== "boolean" ||
      !["preset", "upload"].includes(settings.mode) ||
      !["fade", "zoom", "slide"].includes(settings.preset) ||
      !Number.isFinite(settings.duration_seconds) ||
      settings.duration_seconds < 2 || settings.duration_seconds > 5 ||
      !/^#[0-9a-fA-F]{6}$/.test(settings.background_color) ||
      (settings.clip_path !== null && typeof settings.clip_path !== "string")) {
    throw new Error("Invalid brand video outro settings.");
  }
  if (!settings.enabled) return DISABLED_BRAND_OUTRO;
  const clipPath = settings.clip_path ? canonicalTenantObjectPath(settings.clip_path, tenantId) : null;
  if (settings.enabled && settings.mode === "upload" && !clipPath) {
    throw new Error("An uploaded outro clip is required.");
  }
  if (settings.enabled && settings.mode === "preset" && !logoPath) {
    throw new Error("A tenant-owned primary logo is required for a preset outro.");
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    enabled: settings.enabled,
    mode: settings.mode,
    preset: settings.preset,
    durationSeconds: settings.duration_seconds,
    backgroundColor: settings.background_color.toUpperCase(),
    logoPath: settings.mode === "preset" && logoPath ? canonicalPrimaryLogoPath(logoPath, tenantId) : null,
    clipPath,
  });
}

async function probe(path: string): Promise<{
  duration: number; width: number; height: number; hasAudio: boolean; format: string;
}> {
  let stdout: string;
  try {
    ({ stdout } = await exec("ffprobe", [
      "-v", "error", "-show_entries", "format=duration,format_name:stream=codec_type,width,height",
      "-of", "json", path,
    ], { timeout: 15_000, maxBuffer: 1_000_000 }));
  } catch {
    throw new Error("Outro video could not be decoded.");
  }
  const data = JSON.parse(stdout) as {
    format?: { duration?: string; format_name?: string };
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
  };
  const video = data.streams?.find((s) => s.codec_type === "video");
  const duration = Number(data.format?.duration);
  if (!video?.width || !video.height || !Number.isFinite(duration) || duration <= 0) {
    throw new Error("Outro video could not be decoded.");
  }
  return {
    duration, width: video.width, height: video.height,
    hasAudio: !!data.streams?.some((s) => s.codec_type === "audio"),
    format: data.format?.format_name ?? "",
  };
}

/** Check storage metadata AND the actual container before a version can reference the clip. */
export async function verifyBrandOutroAssets(payload: BrandKitPayload, tenantId: number): Promise<void> {
  const settings = payload.video_outro;
  if (!settings) return;
  const logo = payload.logos.primary?.url ?? null;
  const snapshot = validateBrandOutroSettings(settings, tenantId, logo);
  if (!snapshot.enabled) return;
  const path = snapshot.mode === "upload" ? snapshot.clipPath! : snapshot.logoPath!;
  const file = await storage.getObjectEntityFile(path, tenantId);
  const [metadata] = await file.getMetadata();
  const size = Number(metadata.size);
  const mime = String(metadata.contentType ?? "").split(";")[0]!.trim().toLowerCase();
  const isVideo = snapshot.mode === "upload";
  if (!Number.isSafeInteger(size) || size < 1 ||
      size > (isVideo ? MAX_OUTRO_CLIP_BYTES : MAX_LOGO_BYTES) ||
      !(isVideo ? VIDEO_MIMES : IMAGE_MIMES).has(mime)) {
    throw new Error(isVideo ? "Outro clip must be an MP4/WebM under 40 MB." : "Primary logo must be a PNG/JPEG/WebP under 10 MB.");
  }
  const [bytes] = await file.download();
  if (bytes.length !== size) throw new Error("Outro asset size changed while validating.");
  if (isVideo && !hasVideoContainerSignature(bytes, mime)) {
    throw new Error("Outro clip content does not match its MP4/WebM type.");
  }
  const dir = await mkdtemp(join(tmpdir(), "brand-outro-validate-"));
  try {
    const input = join(dir, isVideo ? "clip" : "logo");
    await writeFile(input, bytes);
    if (isVideo) {
      const info = await probe(input);
      if (info.duration < 1 || info.duration > 10 ||
          info.width > 4096 || info.height > 4096 ||
          !(mime === "video/mp4" ? info.format.includes("mp4") || info.format.includes("mov") : info.format.includes("webm"))) {
        throw new Error("Outro clip must be a valid MP4/WebM, 1–10 seconds, at most 4096 pixels per side.");
      }
    } else {
      const sharp = (await import("sharp")).default;
      const image = await sharp(bytes).metadata();
      if (!image.width || !image.height || image.width > 4096 || image.height > 4096 ||
          !({ "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" } as Record<string, string>)[mime] ||
          image.format !== ({ "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" } as Record<string, string>)[mime]) {
        throw new Error("Primary logo must be a valid PNG/JPEG/WebP image.");
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Freeze the active version's settings and canonical storage paths at job creation. */
export async function resolveBrandOutroSnapshot(
  tenantId: number, brandKitId: number | null | undefined,
): Promise<BrandOutroSnapshot> {
  if (!brandKitId) return DISABLED_BRAND_OUTRO;
  const { loadActivePayload } = await import("../brandKit/service");
  const active = await loadActivePayload(tenantId, brandKitId);
  if (!active) return DISABLED_BRAND_OUTRO;
  return validateBrandOutroSettings(active.payload.video_outro, tenantId, active.payload.logos.primary?.url ?? null);
}

async function readAsset(path: string, tenantId: number, maxBytes: number): Promise<Buffer> {
  canonicalTenantObjectPath(path, tenantId);
  const file = await storage.getObjectEntityFile(path, tenantId);
  const [metadata] = await file.getMetadata();
  const size = Number(metadata.size);
  if (!Number.isSafeInteger(size) || size < 1 || size > maxBytes) throw new Error("Brand outro asset exceeds the permitted size.");
  const [bytes] = await file.download();
  if (bytes.length !== size) throw new Error("Brand outro asset size changed.");
  return bytes;
}

/** Read only: validate the exact clip the user is about to approve. */
export async function inspectBrandOutroClip(snapshot: BrandOutroSnapshot, tenantId: number) {
  if (snapshot.mode !== "upload" || !snapshot.clipPath) throw new Error("An uploaded brand animation is required.");
  const bytes = await readAsset(snapshot.clipPath, tenantId, MAX_OUTRO_CLIP_BYTES);
  const dir = await mkdtemp(join(tmpdir(), "brand-ending-probe-"));
  try {
    await writeFile(join(dir, "clip"), bytes);
    const info = await probe(join(dir, "clip"));
    if (info.duration < 1 || info.duration > 10) throw new Error("Brand animation must be 1–10 seconds long.");
    return { duration: info.duration, hasAudio: info.hasAudio, sha256: createHash("sha256").update(bytes).digest("hex") };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Check before paid generation as well as composition; do not silently swap an approved clip. */
export async function verifyFrozenBrandOutro(snapshot: BrandOutroSnapshot | undefined, tenantId: number) {
  if (!snapshot?.enabled || !snapshot.clipSha256) return;
  if (!snapshot.clipPath) throw new Error("The approved brand animation is missing.");
  const bytes = await readAsset(snapshot.clipPath, tenantId, MAX_OUTRO_CLIP_BYTES);
  if (createHash("sha256").update(bytes).digest("hex") !== snapshot.clipSha256) {
    throw new Error("The approved brand animation changed. Review it again before starting a new video.");
  }
}

/** Append the outro, preserving source audio and adding silence only when a track is absent. */
export async function applyBrandOutro(input: Buffer, snapshot: BrandOutroSnapshot, tenantId: number): Promise<Buffer> {
  if (!snapshot.enabled) return input;
  const dir = await mkdtemp(join(tmpdir(), "brand-outro-render-"));
  try {
    await writeFile(join(dir, "source.mp4"), input);
    const source = await probe(join(dir, "source.mp4"));
    const ratio = Math.min(1, 1920 / Math.max(source.width, source.height));
    const width = Math.max(2, Math.round(source.width * ratio / 2) * 2);
    const height = Math.max(2, Math.round(source.height * ratio / 2) * 2);
    const isUpload = snapshot.mode === "upload";
    const path = isUpload ? snapshot.clipPath : snapshot.logoPath;
    if (!path) throw new Error("Brand outro asset is missing.");
    const asset = await readAsset(path, tenantId, isUpload ? MAX_OUTRO_CLIP_BYTES : MAX_LOGO_BYTES);
    if (snapshot.clipSha256 && createHash("sha256").update(asset).digest("hex") !== snapshot.clipSha256) {
      throw new Error("The approved brand animation changed. Review it again before starting a new video.");
    }
    await writeFile(join(dir, isUpload ? "outro.webm" : "logo.png"), asset);
    const outro = isUpload ? await probe(join(dir, "outro.webm")) : null;
    if (outro && (outro.duration < 1 || outro.duration > 10)) throw new Error("Outro clip must be 1–10 seconds.");
    const duration = outro?.duration ?? snapshot.durationSeconds;
    const args = ["-y", "-i", "source.mp4"];
    if (isUpload) args.push("-i", "outro.webm");
    else args.push("-loop", "1", "-framerate", "30", "-t", String(duration), "-i", "logo.png");
    args.push("-f", "lavfi", "-t", String(source.duration + duration + 1), "-i", "anullsrc=r=48000:cl=stereo");
    const silenceInput = 2;
    const fit = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${snapshot.backgroundColor},setsar=1,fps=30,format=yuv420p,setpts=PTS-STARTPTS`;
    const sourceAudio = source.hasAudio ? "[0:a:0]" : `[${silenceInput}:a]`;
    const outroAudio = outro?.hasAudio ? "[1:a:0]" : `[${silenceInput}:a]`;
    const logoWidth = Math.round(width * 0.55 / 2) * 2;
    const logoHeight = Math.round(height * 0.55 / 2) * 2;
    const animation = snapshot.preset === "fade"
      ? `fade=t=in:st=0:d=0.7:alpha=1`
      : snapshot.preset === "zoom"
        ? `scale=w='iw*(0.8+0.2*min(t/0.8,1))':h='ih*(0.8+0.2*min(t/0.8,1))':eval=frame`
        : "null";
    const overlayY = snapshot.preset === "slide" ? "max((H-h)/2,H*(1-t/0.8))" : "(H-h)/2";
    const graph = [
      `[0:v:0]${fit}[first]`,
      isUpload
        ? `[1:v:0]${fit}[last]`
        : `[1:v:0]scale=${logoWidth}:${logoHeight}:force_original_aspect_ratio=decrease,format=rgba,${animation}[logo];color=c=${snapshot.backgroundColor}:s=${width}x${height}:r=30:d=${duration}[bg];[bg][logo]overlay=x='(W-w)/2':y='${overlayY}':shortest=1,format=yuv420p[last_raw];[last_raw]fps=30,setsar=1,setpts=PTS-STARTPTS[last]`,
      `${sourceAudio}aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,apad,atrim=duration=${source.duration}[a0]`,
      `${outroAudio}aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,apad,atrim=duration=${duration}[a1]`,
      "[first][a0][last][a1]concat=n=2:v=1:a=1[v][a]",
    ].join(";");
    await runFfmpeg([
      ...args, "-filter_complex", graph, "-map", "[v]", "-map", "[a]",
      "-t", String(source.duration + duration + 0.2), "-c:v", "libx264",
      "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "result.mp4",
    ], dir, Math.min(1_800_000, Math.max(300_000, (source.duration + duration) * 15_000)));
    const result = await readFile(join(dir, "result.mp4"));
    if (!result.length) throw new Error("Brand outro render produced no output.");
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}