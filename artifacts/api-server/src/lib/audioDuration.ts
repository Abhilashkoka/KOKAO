import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * A deliberately conservative reservation when synthesized duration cannot
 * exist until after the provider call. Real narration is normally 2-3 words
 * (10-15 non-space characters) per second; reserve against the slower of 1.5
 * words or 8 characters per second, then settle from returned audio.
 */
export function conservativeSpeechDurationSeconds(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const characters = text.replace(/\s/g, "").length;
  return Math.max(0.001, words / 1.5, characters / 8);
}

/**
 * Hard application upper bound for synthesized speech delivery.
 *
 * KOKAO reserves four times its deliberately slow speech estimate, with a
 * 30-second floor for short prompts. Meter enforcement rejects provider audio
 * above this bound before callers can deliver it, making settlement
 * refund-only even though duration is unknowable before synthesis.
 */
export function speechDurationReservationSeconds(text: string): number {
  return audioDurationReservationSeconds(conservativeSpeechDurationSeconds(text));
}

/** Hard delivery bound when an estimated source duration, not text, is known. */
export function audioDurationReservationSeconds(estimatedSeconds: number): number {
  const estimate = Number.isFinite(estimatedSeconds) ? Math.max(0, estimatedSeconds) : 0;
  return Math.max(30, estimate * 4);
}

/**
 * Read duration from the WAV container rather than from total file size.
 * RIFF permits metadata chunks before data, so fixed offset 40 is not reliable.
 */
export function wavDurationSeconds(buffer: Buffer): number | null {
  if (
    buffer.length < 12 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WAVE"
  ) {
    return null;
  }
  let byteRate: number | null = null;
  let dataBytes: number | null = null;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const declaredSize = buffer.readUInt32LE(offset + 4);
    const availableSize = Math.min(declaredSize, Math.max(0, buffer.length - offset - 8));
    if (id === "fmt " && availableSize >= 12) {
      byteRate = buffer.readUInt32LE(offset + 8 + 8);
    } else if (id === "data") {
      dataBytes = availableSize;
    }
    if (byteRate !== null && dataBytes !== null) break;
    offset += 8 + declaredSize + (declaredSize % 2);
  }
  if (!byteRate || dataBytes === null) return null;
  const duration = dataBytes / byteRate;
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

/**
 * Probe encoded audio using ffprobe, which reads the container/codec timeline.
 * Returns null when the local media tool cannot identify a finite duration.
 */
export async function probeAudioDurationSeconds(
  buffer: Buffer,
  filename: string,
): Promise<number | null> {
  const wavDuration = wavDurationSeconds(buffer);
  if (wavDuration !== null) return wavDuration;

  const dir = await mkdtemp(join(tmpdir(), "kokao-audio-duration-"));
  const safeName = basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_") || "audio";
  try {
    const path = join(dir, safeName);
    await writeFile(path, buffer);
    const { stdout } = await execFileAsync(
      "ffprobe",
      [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        path,
      ],
      { timeout: 10_000, maxBuffer: 64 * 1024 },
    );
    const duration = Number(stdout.trim());
    return Number.isFinite(duration) && duration >= 0 ? duration : null;
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}