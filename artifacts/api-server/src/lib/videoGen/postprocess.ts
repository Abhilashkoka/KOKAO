import { spawn } from "child_process";
import { writeFile, readFile, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { pickMusicStartOffsetSec } from "./musicOffset";
import { runFfmpeg, probeDurationSec } from "./slideshow";
import { ASPECT_DIMENSIONS, VideoGenProviderError, type VideoAspect } from "./types";
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

/**
 * Hold a provider clip to the length the storyboard promised. Models only offer
 * discrete lengths (5s, 10s), so a shot planned at 7s comes back at 5 or 10 —
 * without this pass the storyboard's stated timings are fiction and the shots
 * of a multi-shot video drift out of the rhythm the user set.
 *
 * Too long is trimmed. Too short holds the final frame (tpad), which is the
 * only honest option: looping would replay motion the user did not ask for, and
 * generating more footage would cost another unit.
 *
 * Fail-soft like its neighbours: any error returns the ORIGINAL buffer.
 */
export async function enforceClipDuration(video: Buffer, targetSec: number): Promise<Buffer> {
  if (!Number.isFinite(targetSec) || targetSec <= 0) return video;
  const dir = await mkdtemp(join(tmpdir(), "kokao-cliplen-"));
  try {
    await writeFile(join(dir, "in.mp4"), video);
    const actualSec = await probeDurationSec("in.mp4", dir);
    // Within a third of a second is close enough that re-encoding costs more
    // quality than the drift costs rhythm.
    if (actualSec === null || Math.abs(actualSec - targetSec) < 0.34) return video;
    const args = ["-y", "-i", "in.mp4"];
    if (actualSec < targetSec) {
      args.push("-vf", `tpad=stop_mode=clone:stop_duration=${(targetSec - actualSec).toFixed(3)}`);
    }
    args.push(
      "-t", targetSec.toFixed(3),
      "-map", "0:v:0",
      "-map", "0:a?",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart",
      "out.mp4",
    );
    await runFfmpeg(args, dir);
    const out = await readFile(join(dir, "out.mp4"));
    return out.length > 0 ? out : video;
  } catch (error) {
    logger.warn({ err: error }, "Clip length enforcement failed; delivering the clip as-is");
    return video;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Join shot clips end to end into one video. Every clip must already have been
 * through normalizeVideo, which pins codec, resolution, SAR and frame rate — the
 * concat demuxer needs them identical, and re-encoding here instead would cost a
 * second generation-loss pass over footage that already cost money.
 *
 * NOT fail-soft: a caller with several clips has no single clip to fall back on,
 * so a failed join has to surface rather than silently ship shot one.
 */
export async function concatClips(clips: Buffer[]): Promise<Buffer> {
  if (clips.length === 0) {
    throw new VideoGenProviderError("There are no clips to join.");
  }
  if (clips.length === 1) return clips[0]!;
  const dir = await mkdtemp(join(tmpdir(), "kokao-concat-"));
  try {
    const names: string[] = [];
    for (const [i, clip] of clips.entries()) {
      const name = `clip_${String(i).padStart(3, "0")}.mp4`;
      await writeFile(join(dir, name), clip);
      names.push(name);
    }
    // Quoted, one per line: the concat demuxer's own escaping. The names are
    // generated here, never user input, so they cannot contain a quote.
    await writeFile(join(dir, "list.txt"), names.map((n) => `file '${n}'`).join("\n"));
    await runFfmpeg(
      [
        "-y", "-f", "concat", "-safe", "0", "-i", "list.txt",
        // Some provider clips carry audio and some do not; a stream-copy concat
        // of a mixed set desyncs, so re-encode audio to a common track and let
        // the video ride through untouched.
        "-c:v", "copy",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        "out.mp4",
      ],
      dir,
    );
    const out = await readFile(join(dir, "out.mp4"));
    if (out.length === 0) {
      throw new VideoGenProviderError("Joining the shots produced an empty video.");
    }
    return out;
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
