import { spawn } from "child_process";
import { writeFile, readFile, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { logger } from "../logger";
import { probeDurationSec } from "./slideshow";
import { VideoGenProviderError } from "./types";

/**
 * Post-render QA gate: every video is verified BEFORE it is uploaded and the
 * job marked succeeded (idea from OpenMontage's final-review stage,
 * reimplemented — no AGPL code). A video that fails the gate fails the job,
 * which flows into the existing credit-refund path — so a tenant is never
 * charged for a black, silent, truncated, or unplayable file.
 *
 * The gate is deliberately conservative: hard checks (decodability) are
 * strict, judgement checks (darkness, silence) only fail when the evidence is
 * unambiguous, and infrastructure hiccups inside a sub-check pass the video
 * rather than fail it.
 */

export interface VideoQaExpectations {
  /** Duration the pipeline aimed for; drifting more than 25% fails the gate. */
  expectedDurationSec?: number | null;
  /** Sanity floor (provider clips must be at least this long). */
  minDurationSec?: number;
  /** Whether an audible audio track is required (narrated videos). */
  expectAudio?: boolean;
  /** Job label used in error messages/logs. */
  label?: string;
}

/** Allowed relative drift between expected and rendered duration. */
const MAX_DURATION_DRIFT = 0.25;
/** Frames sampled across the timeline for the darkness check. */
const DARK_SAMPLE_POINTS = [0.15, 0.4, 0.6, 0.85];
/** signalstats YAVG below this reads as "essentially black" (16 = video black). */
const DARK_YAVG_THRESHOLD = 18;
/** volumedetect mean_volume below this reads as "silent". */
const SILENCE_MEAN_VOLUME_DB = -50;
/** Per-subcheck ffmpeg timeout. */
const SUBCHECK_TIMEOUT_MS = 60_000;

/** Run ffmpeg capturing stderr (volumedetect reports there). Never throws. */
function runFfmpegCapture(
  args: string[],
  cwd: string,
): Promise<{ code: number | null; stderr: string } | null> {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn("ffmpeg", args, { cwd });
    } catch {
      resolve(null);
      return;
    }
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve(null);
    }, SUBCHECK_TIMEOUT_MS);
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8000);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
    proc.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/** YAVG of one frame at `seekSec`, or null when it cannot be measured. */
async function frameLuma(dir: string, seekSec: number, index: number): Promise<number | null> {
  const statsFile = `stats_${index}.txt`;
  const result = await runFfmpegCapture(
    [
      "-y",
      "-ss",
      seekSec.toFixed(3),
      "-i",
      "out.mp4",
      "-frames:v",
      "1",
      "-vf",
      `signalstats,metadata=print:file=${statsFile}`,
      "-f",
      "null",
      "-",
    ],
    dir,
  );
  if (!result || result.code !== 0) return null;
  try {
    const stats = await readFile(join(dir, statsFile), "utf8");
    const match = stats.match(/signalstats\.YAVG=([\d.]+)/);
    return match ? Number.parseFloat(match[1]!) : null;
  } catch {
    return null;
  }
}

/**
 * Verify a rendered video against expectations. Throws VideoGenProviderError
 * (user-visible message, triggers the refund path) when the video is broken.
 */
export async function verifyRenderedVideo(
  video: Buffer,
  expectations: VideoQaExpectations = {},
): Promise<{ durationSec: number }> {
  const label = expectations.label ?? "video";
  const dir = await mkdtemp(join(tmpdir(), "kokao-qa-"));
  try {
    await writeFile(join(dir, "out.mp4"), video);

    // 1) Decodability + duration. A file ffprobe cannot read is undeliverable.
    const durationSec = await probeDurationSec("out.mp4", dir);
    if (durationSec === null) {
      throw new VideoGenProviderError(
        "The rendered video failed quality checks (unplayable file). You were not charged — please try again.",
      );
    }

    // 2) Sanity floor for provider clips.
    if (expectations.minDurationSec && durationSec < expectations.minDurationSec) {
      throw new VideoGenProviderError(
        `The rendered video failed quality checks (only ${durationSec.toFixed(1)}s long). You were not charged — please try again.`,
      );
    }

    // 3) Duration drift vs what the pipeline aimed for (truncated encodes).
    const expected = expectations.expectedDurationSec;
    if (expected && expected > 0) {
      const drift = Math.abs(durationSec - expected) / expected;
      if (drift > MAX_DURATION_DRIFT) {
        throw new VideoGenProviderError(
          `The rendered video failed quality checks (${durationSec.toFixed(1)}s instead of ~${expected.toFixed(0)}s). You were not charged — please try again.`,
        );
      }
    }

    // 4) All-black output (a dead visual chain still encodes fine). Fades mean
    // single dark frames are normal — only ALL sampled frames dark fails.
    const lumas: (number | null)[] = [];
    for (let i = 0; i < DARK_SAMPLE_POINTS.length; i++) {
      lumas.push(await frameLuma(dir, DARK_SAMPLE_POINTS[i]! * durationSec, i));
    }
    const measured = lumas.filter((l): l is number => l !== null);
    if (measured.length > 0 && measured.every((l) => l < DARK_YAVG_THRESHOLD)) {
      throw new VideoGenProviderError(
        "The rendered video failed quality checks (picture is black throughout). You were not charged — please try again.",
      );
    }

    // 5) Silent narration (TTS returned nothing / mix dropped the voice).
    if (expectations.expectAudio) {
      const result = await runFfmpegCapture(
        ["-i", "out.mp4", "-vn", "-af", "volumedetect", "-f", "null", "-"],
        dir,
      );
      if (result) {
        const match = result.stderr.match(/mean_volume:\s*(-?[\d.]+)\s*dB/);
        const meanDb = match ? Number.parseFloat(match[1]!) : null;
        // No audio stream at all → ffmpeg errors and prints no mean_volume.
        const silent = meanDb === null || meanDb < SILENCE_MEAN_VOLUME_DB;
        if (silent) {
          throw new VideoGenProviderError(
            "The rendered video failed quality checks (audio track is silent). You were not charged — please try again.",
          );
        }
      }
    }

    logger.debug({ label, durationSec }, "Video passed post-render QA");
    return { durationSec };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Stricter gate for local repair output. In addition to the normal visual and
 * audio checks, require independently decodable audio/video streams beginning
 * at the same origin and enough duration to contain the final persisted cue.
 */
export async function verifyRepairedVideo(
  video: Buffer,
  expectations: {
    expectedDurationSec: number;
    finalNarrationEndSec: number;
    label?: string;
  },
): Promise<{ durationSec: number }> {
  const verified = await verifyRenderedVideo(video, {
    expectedDurationSec: expectations.expectedDurationSec,
    expectAudio: true,
    minDurationSec: 0.5,
    label: expectations.label ?? "repaired video",
  });
  const dir = await mkdtemp(join(tmpdir(), "kokao-repair-qa-"));
  try {
    await writeFile(join(dir, "out.mp4"), video);
    const result = await new Promise<{ code: number | null; stdout: string } | null>((resolve) => {
      let proc;
      try {
        proc = spawn(
          "ffprobe",
          [
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,start_time",
            "-of",
            "json",
            "out.mp4",
          ],
          { cwd: dir },
        );
      } catch {
        resolve(null);
        return;
      }
      let stdout = "";
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve(null);
      }, SUBCHECK_TIMEOUT_MS);
      proc.stdout.on("data", (chunk: Buffer) => {
        stdout = (stdout + chunk.toString()).slice(-16_000);
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout });
      });
      proc.on("error", () => {
        clearTimeout(timer);
        resolve(null);
      });
    });
    if (!result || result.code !== 0) {
      throw new VideoGenProviderError(
        "The repaired video could not be inspected. The original video is still available.",
      );
    }
    const parsed = JSON.parse(result.stdout) as {
      streams?: Array<{ codec_type?: string; start_time?: string }>;
    };
    const videoStream = parsed.streams?.find((stream) => stream.codec_type === "video");
    const audioStream = parsed.streams?.find((stream) => stream.codec_type === "audio");
    if (!videoStream || !audioStream) {
      throw new VideoGenProviderError(
        "The repaired video is missing a valid audio or video stream. The original video is still available.",
      );
    }
    const videoStart = Number(videoStream.start_time ?? 0);
    const audioStart = Number(audioStream.start_time ?? 0);
    if (
      !Number.isFinite(videoStart) ||
      !Number.isFinite(audioStart) ||
      Math.abs(videoStart) > 0.1 ||
      Math.abs(audioStart) > 0.1 ||
      Math.abs(videoStart - audioStart) > 0.1
    ) {
      throw new VideoGenProviderError(
        "The repaired video's audio and picture do not start together. The original video is still available.",
      );
    }
    if (verified.durationSec + 0.05 < expectations.finalNarrationEndSec) {
      throw new VideoGenProviderError(
        "The repaired video does not contain the complete saved narration. The original video is still available.",
      );
    }
    const durationTolerance = Math.max(0.25, expectations.expectedDurationSec * 0.02);
    if (Math.abs(verified.durationSec - expectations.expectedDurationSec) > durationTolerance) {
      throw new VideoGenProviderError(
        "The repaired video's duration does not match the saved timeline. The original video is still available.",
      );
    }
    return verified;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
