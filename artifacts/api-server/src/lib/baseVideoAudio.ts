import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFfmpeg } from "./videoGen/slideshow";

const EXTRACTION_TIMEOUT_MS = 2 * 60 * 1000;

export class BaseVideoAudioExtractionError extends Error {
  constructor(message = "The video has no usable audio track.") {
    super(message);
    this.name = "BaseVideoAudioExtractionError";
  }
}

/**
 * Extract the first audio track from a saved base video into a compact,
 * provider-friendly mono MP3. All files are temporary and removed after the
 * resulting bytes have been read.
 */
export async function extractVoiceSampleFromVideo(video: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "brand-video-audio-"));
  const inputPath = join(dir, "source-video");
  const outputPath = join(dir, "voice-sample.mp3");
  try {
    await writeFile(inputPath, video);
    await runFfmpeg(
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        inputPath,
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        "44100",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "128k",
        outputPath,
      ],
      dir,
      EXTRACTION_TIMEOUT_MS,
    );
    const audio = await readFile(outputPath);
    if (audio.length === 0) throw new BaseVideoAudioExtractionError();
    return audio;
  } catch (error) {
    if (error instanceof BaseVideoAudioExtractionError) throw error;
    throw new BaseVideoAudioExtractionError();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}