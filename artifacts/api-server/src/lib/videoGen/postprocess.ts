import { spawn } from "child_process";
import { writeFile, readFile, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { pickMusicStartOffsetSec } from "./musicOffset";
import { runFfmpeg, probeDurationSec } from "./slideshow";
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

/** Whether the file has at least one audio stream (ffprobe; false on failure). */
function probeHasAudio(file: string, cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(
      "ffprobe",
      ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "csv=p=0", file],
      { cwd },
    );
    let out = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve(false);
    }, 30_000);
    proc.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 && out.trim().length > 0);
    });
    proc.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/**
 * Mix a background-music bed under an AI-generated clip (text-to-video /
 * animate-photo). The bed loops to cover the clip, starts past any quiet
 * intro, is ducked beneath the clip's own audio when one exists, and fades
 * out at the end.
 *
 * Fail-soft like normalizeVideo: any error returns the ORIGINAL clip — a
 * music hiccup must never fail a generation that already cost money.
 */
export async function mixMusicIntoVideo(video: Buffer, music: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "kokao-music-mix-"));
  try {
    await writeFile(join(dir, "in.mp4"), video);
    await writeFile(join(dir, "music"), music);
    const durationSec = await probeDurationSec("in.mp4", dir);
    if (!durationSec) return video;
    const hasAudio = await probeHasAudio("in.mp4", dir);
    const seekSec = await pickMusicStartOffsetSec("music", dir, durationSec);
    const fadeDur = Math.min(1.5, durationSec / 2);
    const fadeStart = Math.max(durationSec - fadeDur, 0);
    const bed =
      `[1:a]volume=${hasAudio ? "0.25" : "0.4"},` +
      `afade=t=out:st=${fadeStart.toFixed(3)}:d=${fadeDur.toFixed(3)}`;
    const filter = hasAudio
      ? `${bed}[bed];[0:a][bed]amix=inputs=2:duration=first:dropout_transition=2[aout]`
      : `${bed}[aout]`;
    const args = ["-y", "-i", "in.mp4"];
    if (seekSec > 0) args.push("-ss", seekSec.toFixed(3));
    args.push(
      "-stream_loop", "-1", "-i", "music",
      "-filter_complex", filter,
      "-map", "0:v:0", "-map", "[aout]",
      "-c:v", "copy",
      "-c:a", "aac", "-b:a", "128k",
      "-t", durationSec.toFixed(3),
      "-movflags", "+faststart",
      "out.mp4",
    );
    await runFfmpeg(args, dir);
    const out = await readFile(join(dir, "out.mp4"));
    return out.length > 0 ? out : video;
  } catch (error) {
    logger.warn({ err: error }, "Music mix failed; delivering the clip without music");
    return video;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
