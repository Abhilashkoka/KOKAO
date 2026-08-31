import { writeFile, readFile, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "child_process";
import { runFfmpeg, probeDurationSec } from "./slideshow";
import { logger } from "../logger";

/**
 * Prepare an uploaded base video for the lip-sync model.
 *
 * Two things went wrong in production and both are fixed here, in one
 * re-encode:
 *
 * 1. LENGTH. The runner used to hand the model whatever the upload was and
 *    whatever the narration turned out to be. Nothing probed either, so a
 *    script that ran long past the footage left the tail unsynced, and a short
 *    one left footage the audio never reached. Now the video is trimmed to the
 *    narration, or holds its last frame to reach it, and a script that runs
 *    absurdly past the footage is refused by the caller instead of rendered.
 *
 * 2. FACE PIXELS. The lip-sync model works on a small square crop around the
 *    face. On a 480p upload that crop is starved before the model even starts,
 *    and the synced mouth comes back with a fraction of the surrounding skin's
 *    detail. Sources below MIN_SYNC_HEIGHT are upscaled first so the crop has
 *    something to work with.
 *
 * Aspect is deliberately NOT normalized — padding someone's own footage would
 * only shrink them, which is the same reason the runner never did it.
 */

/** Below this height the model's face crop is starved; upscale first. */
export const MIN_SYNC_HEIGHT = 720;
/**
 * Below this, upscaling cannot save it — there is no mouth detail to enlarge,
 * and the result is worth neither the money nor the wait. Refused instead.
 */
export const MIN_USABLE_HEIGHT = 240;
/** Never blow a source up by more than this — past it we are inventing pixels. */
const MAX_UPSCALE = 2;
/** Length difference small enough that a re-encode costs more than it fixes. */
const LENGTH_TOLERANCE_SEC = 0.2;
/**
 * How far the narration may outrun the footage before we refuse. Past this the
 * result is a frozen frame staring at the viewer, which is worse than an
 * honest error asking for a shorter script.
 */
export const MAX_TAIL_HOLD_SEC = 2.5;
/**
 * Quality floor for the re-encode. Higher than the pipeline's usual 20: this
 * file is the INPUT to a generative model, so compression artifacts around the
 * mouth become artifacts in the output.
 */
const SOURCE_CRF = "18";

export type LipSyncLengthFit = "exact" | "trimmed" | "padded";

export interface LipSyncSource {
  video: { buffer: Buffer; mimeType: string };
  /** Height the model will actually see. */
  height: number | null;
  /** Scale factor applied to the source (1 = untouched). */
  upscale: number;
  sourceDurationSec: number | null;
  /** How the video was fitted to the narration. */
  fit: LipSyncLengthFit;
  /**
   * True when the narration outruns the footage by more than MAX_TAIL_HOLD_SEC.
   * The caller decides what to tell the user — this module only measures.
   */
  excessive: boolean;
  /** Seconds the narration exceeds the footage by (0 when it does not). */
  overrunSec: number;
  /**
   * True when the source is below MIN_USABLE_HEIGHT — too small for any lip
   * sync worth shipping. As with `excessive`, this module only measures; the
   * caller decides.
   */
  tooSmall: boolean;
}

/** Video height in pixels, or null when it cannot be read. */
export function probeHeight(file: string, cwd: string): Promise<number | null> {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(
        "ffprobe",
        [
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-show_entries",
          "stream=height",
          "-of",
          "default=noprint_wrappers=1:nokey=1",
          file,
        ],
        { cwd },
      );
    } catch {
      resolve(null);
      return;
    }
    let out = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    proc.on("close", () => {
      const height = Number.parseInt(out.trim(), 10);
      resolve(Number.isFinite(height) && height > 0 ? height : null);
    });
    proc.on("error", () => resolve(null));
  });
}

/**
 * Fit an uploaded base video to the narration and give the model enough face
 * pixels to work with.
 *
 * Fail-soft on measurement: if the source cannot be probed we return it
 * untouched rather than fail a job the model might still handle. NOT fail-soft
 * on the re-encode — a half-transformed source is worse than the original, so
 * a failed encode returns the original too.
 */
export async function prepareLipSyncSource(
  video: { buffer: Buffer; mimeType: string },
  narrationDurationSec: number,
): Promise<LipSyncSource> {
  const untouched: LipSyncSource = {
    video,
    height: null,
    upscale: 1,
    sourceDurationSec: null,
    fit: "exact",
    excessive: false,
    overrunSec: 0,
    tooSmall: false,
  };
  if (!Number.isFinite(narrationDurationSec) || narrationDurationSec <= 0) return untouched;

  const dir = await mkdtemp(join(tmpdir(), "kokao-lipsrc-"));
  try {
    await writeFile(join(dir, "in.mp4"), video.buffer);
    const sourceDurationSec = await probeDurationSec("in.mp4", dir);
    const height = await probeHeight("in.mp4", dir);
    if (sourceDurationSec === null) {
      logger.warn("Base video duration could not be probed; syncing it unprepared");
      return { ...untouched, height };
    }

    // Hopeless resolution is refused before the model is called, not after:
    // the job fails into the existing refund path having spent nothing.
    if (height !== null && height < MIN_USABLE_HEIGHT) {
      return { ...untouched, height, sourceDurationSec, tooSmall: true };
    }

    const overrunSec = Math.max(0, narrationDurationSec - sourceDurationSec);
    const excessive = overrunSec > MAX_TAIL_HOLD_SEC;
    const delta = narrationDurationSec - sourceDurationSec;
    const fit: LipSyncLengthFit =
      Math.abs(delta) <= LENGTH_TOLERANCE_SEC ? "exact" : delta > 0 ? "padded" : "trimmed";

    // Refusal is the caller's call, but there is no point spending an encode on
    // a job it is about to reject.
    if (excessive) {
      return { ...untouched, height, sourceDurationSec, fit, excessive, overrunSec };
    }

    const upscale =
      height !== null && height < MIN_SYNC_HEIGHT
        ? Math.min(MAX_UPSCALE, MIN_SYNC_HEIGHT / height)
        : 1;
    if (fit === "exact" && upscale === 1) {
      return { ...untouched, height, sourceDurationSec, fit };
    }

    const filters: string[] = [];
    if (fit === "padded") {
      filters.push(`tpad=stop_mode=clone:stop_duration=${delta.toFixed(3)}`);
    }
    if (upscale > 1) {
      // -2 keeps the width even (h264 requires it) and preserves the aspect,
      // so the framing the uploader chose survives untouched.
      filters.push(`scale=-2:${Math.round((height ?? 0) * upscale)}:flags=lanczos`);
    }

    const args = ["-y", "-i", "in.mp4"];
    if (filters.length > 0) args.push("-vf", filters.join(","));
    args.push(
      "-t",
      narrationDurationSec.toFixed(3),
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      SOURCE_CRF,
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      "out.mp4",
    );
    await runFfmpeg(args, dir);
    const out = await readFile(join(dir, "out.mp4"));
    if (out.length === 0) return { ...untouched, height, sourceDurationSec, fit };

    const preparedHeight = height === null ? null : Math.round(height * upscale);
    logger.debug(
      { fit, upscale, sourceDurationSec, narrationDurationSec, height, preparedHeight },
      "Prepared base video for lip sync",
    );
    return {
      video: { buffer: out, mimeType: "video/mp4" },
      height: preparedHeight,
      upscale,
      sourceDurationSec,
      fit,
      excessive: false,
      overrunSec,
      tooSmall: false,
    };
  } catch (error) {
    logger.warn({ err: error }, "Base video preparation failed; syncing the upload as-is");
    return untouched;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
