import { writeFile, readFile, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { runFfmpeg } from "./slideshow";
import { ASPECT_DIMENSIONS, type VideoAspect } from "./types";
import { logger } from "../logger";

/**
 * Normalize a raw AI provider clip to the aspect ratio and resolution the
 * user actually asked for. Providers routinely ignore the request: WAN-fast
 * outputs 480-720p, MiniMax has no aspect parameter at all, and Veo is
 * 16:9-first — so without this pass a 9:16 reel request could ship as a
 * landscape 720p clip. Cover-crop + upscale to the canonical frame, 30fps,
 * H.264 yuv420p with faststart; audio (rare, but some models emit it) is
 * kept and normalized for platform loudness.
 *
 * Fail-soft: any error returns the ORIGINAL buffer — a normalization hiccup
 * must never fail a generation that already cost money.
 */
export async function normalizeVideo(video: Buffer, aspectRatio: VideoAspect): Promise<Buffer> {
  const { width, height } = ASPECT_DIMENSIONS[aspectRatio];
  const dir = await mkdtemp(join(tmpdir(), "kokao-normalize-"));
  try {
    await writeFile(join(dir, "in.mp4"), video);
    await runFfmpeg(
      [
        "-y",
        "-i",
        "in.mp4",
        "-vf",
        `scale=${width}:${height}:force_original_aspect_ratio=increase,` +
          `crop=${width}:${height},setsar=1,fps=30,format=yuv420p`,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        "out.mp4",
      ],
      dir,
    );
    const out = await readFile(join(dir, "out.mp4"));
    return out.length > 0 ? out : video;
  } catch (error) {
    logger.warn({ err: error }, "Video normalization failed; delivering the raw provider clip");
    return video;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
