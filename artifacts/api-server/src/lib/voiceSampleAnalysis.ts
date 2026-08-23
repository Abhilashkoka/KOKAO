import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Server-side voice-sample quality analysis.
 *
 * Mirrors the web app's Web Audio `analyzeVoiceSample` heuristics (duration,
 * RMS loudness, clipping, steady background noise) so files picked on mobile —
 * where no client-side decoder exists — get the same pre-clone warning.
 *
 * Decoding uses the system ffmpeg binary (already relied on by the video
 * pipeline). Analysis is strictly fail-open: any decode/analysis failure
 * returns null and must never block the upload/clone flow.
 */

// ── Thresholds (mirror artifacts/socialforge brand-kits analyzeVoiceSample) ──
export const VOICE_SAMPLE_MIN_SECONDS = 20;
export const VOICE_SAMPLE_MAX_SECONDS = 90;
const MIN_RMS = 0.01;
const CLIP_THRESHOLD = 0.985;
const MAX_CLIP_RATIO = 0.01;
const MAX_NOISE_RATIO = 0.25;
const MIN_NOISE_FLOOR_RMS = 0.02;

const DECODE_SAMPLE_RATE = 16_000;
const FFMPEG_DECODE_TIMEOUT_MS = 30_000;

export type VoiceSampleIssue =
  | "too-short"
  | "too-long"
  | "too-quiet"
  | "clipped"
  | "noisy";

/**
 * Pure heuristics over decoded mono PCM. Exported separately so the scoring
 * can be unit-tested without spawning ffmpeg.
 */
export function analyzeVoicePcm(
  data: Float32Array,
  sampleRate: number,
): VoiceSampleIssue[] {
  const issues: VoiceSampleIssue[] = [];
  if (data.length === 0 || sampleRate <= 0) return issues;

  const duration = data.length / sampleRate;
  if (duration < VOICE_SAMPLE_MIN_SECONDS) issues.push("too-short");
  else if (duration > VOICE_SAMPLE_MAX_SECONDS) issues.push("too-long");

  // Sample at a stride so even long files stay cheap to scan (same cap as web).
  const stride = Math.max(1, Math.floor(data.length / 200_000));
  let sum = 0;
  let count = 0;
  let clippedCount = 0;
  const sampled: number[] = [];
  for (let i = 0; i < data.length; i += stride) {
    const v = data[i]!;
    sum += v * v;
    if (Math.abs(v) >= CLIP_THRESHOLD) clippedCount++;
    count++;
    sampled.push(v);
  }
  const rms = count > 0 ? Math.sqrt(sum / count) : 0;
  if (rms < MIN_RMS) {
    issues.push("too-quiet");
  } else if (count > 0 && clippedCount / count > MAX_CLIP_RATIO) {
    issues.push("clipped");
  } else {
    // Noise-floor heuristic: split the scan into short windows and compare the
    // quietest stretches (pauses = room noise) against the loudest (speech).
    const WINDOW_COUNT = 50;
    const windowSize = Math.floor(sampled.length / WINDOW_COUNT);
    if (windowSize >= 4) {
      const windowRms: number[] = [];
      for (let w = 0; w < WINDOW_COUNT; w++) {
        let wSum = 0;
        const start = w * windowSize;
        for (let i = start; i < start + windowSize; i++) {
          wSum += sampled[i]! * sampled[i]!;
        }
        windowRms.push(Math.sqrt(wSum / windowSize));
      }
      const sorted = [...windowRms].sort((a, b) => a - b);
      const tail = Math.max(1, Math.floor(WINDOW_COUNT * 0.2));
      const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
      const noiseFloor = mean(sorted.slice(0, tail));
      const speechLevel = mean(sorted.slice(-tail));
      if (
        speechLevel >= MIN_RMS &&
        noiseFloor >= MIN_NOISE_FLOOR_RMS &&
        noiseFloor / speechLevel > MAX_NOISE_RATIO
      ) {
        issues.push("noisy");
      }
    }
  }

  return issues;
}

/**
 * Decode an audio file's bytes to mono Float32 PCM via ffmpeg.
 *
 * The bytes are written to a temp file first — several container formats
 * (notably m4a with a trailing moov atom) cannot be decoded from a pipe.
 * Returns null when ffmpeg cannot decode the input.
 */
export async function decodeVoiceSampleToPcm(bytes: Buffer): Promise<Float32Array | null> {
  const dir = await mkdtemp(join(tmpdir(), "voice-check-"));
  const inputPath = join(dir, "sample");
  try {
    await writeFile(inputPath, bytes);
    const pcm = await new Promise<Buffer | null>((resolve) => {
      const proc = spawn("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        inputPath,
        "-vn",
        "-ac",
        "1",
        "-ar",
        String(DECODE_SAMPLE_RATE),
        "-f",
        "f32le",
        "pipe:1",
      ]);
      const chunks: Buffer[] = [];
      let settled = false;
      const settle = (value: Buffer | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        settle(null);
      }, FFMPEG_DECODE_TIMEOUT_MS);
      proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      proc.stderr.resume(); // drain so the process never blocks on stderr
      proc.on("error", () => settle(null));
      proc.on("close", (code) =>
        settle(code === 0 ? Buffer.concat(chunks) : null),
      );
    });
    if (!pcm || pcm.length < 4) return null;
    // Align to whole 4-byte floats; copy so the view owns its buffer.
    const floatCount = Math.floor(pcm.length / 4);
    const out = new Float32Array(floatCount);
    for (let i = 0; i < floatCount; i++) out[i] = pcm.readFloatLE(i * 4);
    return out;
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Decode + analyze an uploaded voice sample. Returns the quality issues, or
 * null when the file could not be decoded/analyzed (fail-open — the caller
 * must treat null as "no warning").
 */
export async function analyzeVoiceSampleBuffer(
  bytes: Buffer,
): Promise<VoiceSampleIssue[] | null> {
  try {
    const pcm = await decodeVoiceSampleToPcm(bytes);
    if (!pcm || pcm.length === 0) return null;
    return analyzeVoicePcm(pcm, DECODE_SAMPLE_RATE);
  } catch {
    return null;
  }
}

/** ffmpeg-decoded duration for billing; null means it could not be measured. */
export async function measureVoiceSampleDurationMs(bytes: Buffer): Promise<number | null> {
  const pcm = await decodeVoiceSampleToPcm(bytes);
  if (!pcm) return null;
  return Math.round((pcm.length / DECODE_SAMPLE_RATE) * 1000);
}
