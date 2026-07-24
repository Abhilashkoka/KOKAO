import { spawn } from "child_process";
import { logger } from "../logger";
import { probeDurationSec } from "./slideshow";

/**
 * Pick where in a background-music track playback should START, so the video
 * gets the musical part instead of a long quiet intro (idea from
 * OpenMontage's audio-energy stage, reimplemented on ffmpeg's ebur128
 * loudness meter — no AGPL code). Strictly fail-soft: any hiccup returns 0
 * and the track simply plays from the top, exactly as before.
 */

const ANALYZE_TIMEOUT_MS = 45_000;
/** Momentary loudness within this many dB of the track's own peak = "active". */
const ACTIVE_WINDOW_DB = 12;
/** Lead-in kept before the detected active moment (so it doesn't slam in). */
const LEAD_IN_SEC = 1.0;
/** Offsets smaller than this aren't worth cutting the intro for. */
const MIN_USEFUL_OFFSET_SEC = 1.5;
/** ebur128 prints ~10 lines/sec; cap the buffer for very long uploads. */
const MAX_STDERR_BYTES = 4_000_000;

/** Full ebur128 stderr timeline for a track, or null on any failure. */
function ebur128Stderr(musicFile: string, cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn("ffmpeg", ["-i", musicFile, "-af", "ebur128", "-f", "null", "-"], { cwd });
    } catch {
      resolve(null);
      return;
    }
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve(null);
    }, ANALYZE_TIMEOUT_MS);
    proc.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += chunk.toString();
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? stderr : null);
    });
    proc.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/** Parse "t: <sec> ... M: <dB>" momentary-loudness samples from ebur128 logs. */
export function parseEbur128Timeline(stderr: string): { t: number; m: number }[] {
  const samples: { t: number; m: number }[] = [];
  const re = /t:\s*([\d.]+)\s+TARGET:[^\n]*?M:\s*(-?[\d.]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stderr)) !== null) {
    const t = Number.parseFloat(match[1]!);
    const m = Number.parseFloat(match[2]!);
    if (Number.isFinite(t) && Number.isFinite(m)) samples.push({ t, m });
  }
  return samples;
}

/** Offset choice given a loudness timeline (pure; exported for tests). */
export function chooseOffsetFromTimeline(
  samples: { t: number; m: number }[],
  musicDurationSec: number,
  windowSec: number,
): number {
  if (samples.length === 0) return 0;
  let peak = -Infinity;
  for (const sample of samples) if (sample.m > peak) peak = sample.m;
  if (!Number.isFinite(peak)) return 0;
  const threshold = peak - ACTIVE_WINDOW_DB;
  const first = samples.find((sample) => sample.m >= threshold);
  if (!first) return 0;
  let offset = Math.max(0, first.t - LEAD_IN_SEC);
  // Keep the whole video inside the remaining track.
  offset = Math.min(offset, Math.max(0, musicDurationSec - windowSec));
  return offset >= MIN_USEFUL_OFFSET_SEC ? offset : 0;
}

/**
 * Seconds to seek into `musicFile` before playback, given the video runs
 * `windowSec`. Returns 0 (play from the top) whenever analysis fails, the
 * track already starts strong, or the track is too short to skip anything.
 */
export async function pickMusicStartOffsetSec(
  musicFile: string,
  cwd: string,
  windowSec: number,
): Promise<number> {
  try {
    const musicDur = await probeDurationSec(musicFile, cwd);
    if (musicDur === null || musicDur <= windowSec + MIN_USEFUL_OFFSET_SEC) return 0;
    const stderr = await ebur128Stderr(musicFile, cwd);
    if (!stderr) return 0;
    return chooseOffsetFromTimeline(parseEbur128Timeline(stderr), musicDur, windowSec);
  } catch (error) {
    logger.warn({ err: error }, "Music energy analysis failed; playing from the top");
    return 0;
  }
}
