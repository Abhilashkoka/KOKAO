import { spawn } from "child_process";
import { writeFile, readFile, mkdtemp, rm, access } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { ASPECT_DIMENSIONS, VideoGenProviderError, type VideoAspect } from "./types";

/**
 * Deterministic photo-slideshow encoder built on the system ffmpeg binary
 * (the same binary lib/integrations-openai-ai-server already spawns for audio
 * conversion). No AI cost: photos in, an H.264 MP4 with crossfades — and
 * optionally a burned-in caption and background music — out.
 */

export const MAX_SLIDESHOW_IMAGES = 20;
export const MIN_SLIDE_SECONDS = 1;
export const MAX_SLIDE_SECONDS = 10;

/** Crossfade length between slides. */
const TRANSITION_SEC = 0.5;
const FPS = 30;

/** Kill a runaway encode well before the HTTP/job layer gives up on it. */
const FFMPEG_TIMEOUT_MS = 5 * 60 * 1000;

export interface SlideshowInput {
  /** Ordered photo bytes (PNG/JPEG/WebP). 1..MAX_SLIDESHOW_IMAGES entries. */
  images: Buffer[];
  aspectRatio: VideoAspect;
  /** Seconds each photo is on screen (clamped to 1..10). */
  slideDurationSec: number;
  /** Optional caption burned into the bottom of the video. */
  overlayText?: string | null;
  /** Optional background music (mp3/m4a/wav bytes), faded out at the end. */
  music?: Buffer | null;
}

function sniffImageExt(buffer: Buffer): string {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50) return "png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return "jpg";
  if (buffer.length >= 12 && buffer.toString("ascii", 8, 12) === "WEBP") return "webp";
  return "png";
}

/** First available fontfile for drawtext; overlay is skipped when none exists. */
export async function findFontFile(): Promise<string | null> {
  const candidates = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
    "/usr/share/fonts/noto/NotoSans-Bold.ttf",
  ];
  for (const path of candidates) {
    try {
      await access(path);
      return path;
    } catch {
      // try next
    }
  }
  return null;
}

/** Read a media file's duration (seconds) via ffprobe. Returns null on failure. */
export function probeDurationSec(file: string, cwd: string): Promise<number | null> {
  return new Promise((resolve) => {
    const proc = spawn(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        file,
      ],
      { cwd },
    );
    let out = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve(null);
    }, 30_000);
    proc.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      const value = Number.parseFloat(out.trim());
      resolve(code === 0 && Number.isFinite(value) && value > 0 ? value : null);
    });
    proc.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

export function runFfmpeg(args: string[], cwd: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { cwd });
    let stderrTail = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new VideoGenProviderError("Slideshow encoding timed out."));
    }, FFMPEG_TIMEOUT_MS);
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else
        reject(
          new VideoGenProviderError(
            `ffmpeg exited with code ${code}: ${stderrTail.slice(-300)}`,
          ),
        );
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new VideoGenProviderError(
          `Failed to start ffmpeg (is it installed?): ${err.message}`,
        ),
      );
    });
  });
}

/** Render an MP4 slideshow from photos. Returns the encoded video bytes. */
export async function renderSlideshow(input: SlideshowInput): Promise<Buffer> {
  const count = input.images.length;
  if (count < 1 || count > MAX_SLIDESHOW_IMAGES) {
    throw new VideoGenProviderError(
      `Slideshow needs 1-${MAX_SLIDESHOW_IMAGES} images (got ${count}).`,
    );
  }
  const slideSec = Math.min(
    MAX_SLIDE_SECONDS,
    Math.max(MIN_SLIDE_SECONDS, input.slideDurationSec),
  );
  const { width, height } = ASPECT_DIMENSIONS[input.aspectRatio];

  const dir = await mkdtemp(join(tmpdir(), "kokao-slideshow-"));
  try {
    const args: string[] = ["-y"];

    // One looped still input per slide.
    for (let i = 0; i < count; i++) {
      const name = `slide_${String(i).padStart(3, "0")}.${sniffImageExt(input.images[i]!)}`;
      await writeFile(join(dir, name), input.images[i]!);
      args.push("-loop", "1", "-t", String(slideSec), "-i", name);
    }
    const musicIndex = count;
    if (input.music && input.music.length > 0) {
      await writeFile(join(dir, "music"), input.music);
      args.push("-i", "music");
    }

    // Normalize every slide to the target frame with a gentle Ken Burns
    // move (alternating zoom in / zoom out per slide), then chain
    // crossfades. Photos are cover-cropped — same fill rule as the topic
    // video composer — instead of letterboxed, and the zoompan works on a
    // 2x supersampled frame so the motion is smooth rather than steppy.
    const filters: string[] = [];
    const superW = width * 2;
    const superH = height * 2;
    const zoomSpan = 0.08; // 8% total move per slide
    const frames = Math.max(1, Math.round(slideSec * FPS));
    const zoomStep = (zoomSpan / frames).toFixed(6);
    for (let i = 0; i < count; i++) {
      const zoomExpr =
        i % 2 === 0
          ? `min(1+${zoomStep}*on,${(1 + zoomSpan).toFixed(3)})` // zoom in
          : `max(${(1 + zoomSpan).toFixed(3)}-${zoomStep}*on,1.001)`; // zoom out
      filters.push(
        `[${i}:v]scale=${superW}:${superH}:force_original_aspect_ratio=increase,` +
          `crop=${superW}:${superH},` +
          `zoompan=z='${zoomExpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':` +
          `d=1:s=${width}x${height}:fps=${FPS},` +
          `setsar=1,format=yuv420p[v${i}]`,
      );
    }
    let chainLabel = "v0";
    for (let i = 1; i < count; i++) {
      const out = i === count - 1 ? "xfaded" : `chain${i}`;
      const offset = (i * (slideSec - TRANSITION_SEC)).toFixed(3);
      filters.push(
        `[${chainLabel}][v${i}]xfade=transition=fade:duration=${TRANSITION_SEC}:offset=${offset}[${out}]`,
      );
      chainLabel = out;
    }
    if (count === 1) {
      filters.push(`[v0]copy[xfaded]`);
    }

    const totalSec = count * slideSec - (count - 1) * TRANSITION_SEC;
    let videoOut = "xfaded";
    const fontFile = input.overlayText?.trim() ? await findFontFile() : null;
    if (input.overlayText?.trim() && fontFile) {
      // textfile= sidesteps drawtext's brittle inline-escaping rules: the
      // caption is written verbatim to a file ffmpeg reads back, so colons,
      // quotes, commas, and brackets in user text can never break the graph.
      await writeFile(join(dir, "overlay.txt"), input.overlayText.trim().slice(0, 120));
      filters.push(
        `[xfaded]drawtext=fontfile=${fontFile}:textfile=overlay.txt:` +
          `fontcolor=white:fontsize=${Math.round(height / 18)}:` +
          `box=1:boxcolor=black@0.45:boxborderw=18:` +
          `x=(w-text_w)/2:y=h-text_h-${Math.round(height / 12)}[titled]`,
      );
      videoOut = "titled";
    }

    args.push("-filter_complex", filters.join(";"), "-map", `[${videoOut}]`);

    if (input.music && input.music.length > 0) {
      const fadeStart = Math.max(0, totalSec - 1.5).toFixed(3);
      args.push(
        "-map",
        `${musicIndex}:a`,
        "-af",
        `afade=t=out:st=${fadeStart}:d=1.5`,
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-shortest",
      );
    } else {
      args.push("-an");
    }

    args.push(
      "-t",
      totalSec.toFixed(3),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "out.mp4",
    );

    await runFfmpeg(args, dir);
    return await readFile(join(dir, "out.mp4"));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Extract a PNG poster frame from a video (used for library thumbnails).
 * Grabs a frame ~1s in (past fade-ins) at up to 1080px wide so grid
 * thumbnails and share previews stay sharp; falls back to the first frame
 * for very short clips. */
export async function extractPosterFrame(video: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "kokao-poster-"));
  try {
    await writeFile(join(dir, "in.mp4"), video);
    const grab = (seekSec: number) =>
      runFfmpeg(
        [
          "-y",
          "-ss",
          seekSec.toFixed(2),
          "-i",
          "in.mp4",
          "-frames:v",
          "1",
          "-vf",
          "scale='min(1080,iw)':-2",
          "poster.png",
        ],
        dir,
      );
    try {
      await grab(1.0);
    } catch {
      await grab(0);
    }
    return await readFile(join(dir, "poster.png"));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
