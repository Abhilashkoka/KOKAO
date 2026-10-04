import { ObjectStorageService } from "./objectStorage";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Transform } from "node:stream";

const storage = new ObjectStorageService();
const exec = promisify(execFile);
export const VIDEO_UPLOAD_MAX_BYTES = 300 * 1024 * 1024;

/** Bounded local staging avoids whole-file buffers and never downloads arbitrary URLs. */
export async function stageVideo(path: string, tenantId: number, platform: string, prepareAudio = false) {
  const file = await storage.getObjectEntityFile(path, tenantId);
  const [metadata] = await file.getMetadata();
  let size = Number(metadata.size);
  if (!Number.isSafeInteger(size) || size <= 0 || size > VIDEO_UPLOAD_MAX_BYTES) throw new Error("Native uploads support videos up to 300 MB. Export a smaller MP4.");
  const dir = await mkdtemp(join(tmpdir(), "library-upload-"));
  let localPath = join(dir, "video.mp4");
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    let bytes = 0;
    await pipeline(file.createReadStream(), new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        callback(bytes > VIDEO_UPLOAD_MAX_BYTES ? new Error("Video exceeds 300 MB.") : null, chunk);
      },
    }), createWriteStream(localPath), { signal: AbortSignal.timeout(120_000) });
    if ((await stat(localPath)).size !== size) throw new Error("Video changed during upload preparation. Try again.");
    const { stdout } = await exec("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", localPath], { timeout: 20_000, maxBuffer: 200_000 });
    const probe = JSON.parse(stdout);
    const video = probe.streams?.find((s: any) => s.codec_type === "video");
    let audio = probe.streams?.find((s: any) => s.codec_type === "audio");
    let normalized = false;
    const duration = Number(probe.format?.duration);
    const [numerator, denominator = 1] = String(video?.avg_frame_rate ?? "0").split("/").map(Number);
    const fps = numerator / denominator;
    if (!video || !Number.isFinite(duration) || duration <= 0 || !probe.format?.format_name?.includes("mp4") || !["h264", "hevc"].includes(video.codec_name)) throw new Error("Use an MP4 video encoded as H.264 or HEVC.");
    if (platform !== "youtube") {
      if (duration < 3 || duration > (platform === "facebook" ? 90 : 900) || fps < (platform === "facebook" ? 24 : 23) || fps > 60) throw new Error(platform === "facebook" ? "Facebook Reels require 3–90 seconds and 24–60 fps." : "Instagram Reels require 3–900 seconds and 23–60 fps.");
      const incompatibleAudio = (stream: any) => stream && (stream.codec_name !== "aac" || Number(stream.sample_rate) > 48000 || stream.channels > 2);
      if (incompatibleAudio(audio) && prepareAudio) {
        const converted = join(dir, "reel.mp4");
        // Stream-copy the picture: no cropping, regeneration or visual quality loss.
        // Persist this derivative before any provider write, never re-encode on resume.
        await exec("ffmpeg", ["-nostdin", "-y", "-v", "error", "-i", localPath,
          "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy",
          "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "128k",
          "-movflags", "+faststart", converted], { timeout: 120_000, maxBuffer: 200_000 });
        const checked = await exec("ffprobe", ["-v", "error", "-show_streams", "-of", "json", converted], { timeout: 20_000, maxBuffer: 200_000 });
        audio = JSON.parse(checked.stdout).streams?.find((s: any) => s.codec_type === "audio");
        if (!audio) throw new Error("Could not prepare the Reel audio. The original video is unchanged.");
        size = (await stat(converted)).size;
        if (size <= 0 || size > VIDEO_UPLOAD_MAX_BYTES) throw new Error("Prepared Reel exceeds the 300 MB upload limit.");
        localPath = converted;
        normalized = true;
      }
      if (incompatibleAudio(audio)) throw new Error("Meta Reels require AAC audio, at most 48 kHz and two channels.");
      if (video.pix_fmt !== "yuv420p" || (video.field_order && !["progressive", "unknown"].includes(video.field_order))) throw new Error("Meta Reels require progressive 4:2:0 video.");
      if (platform === "facebook" && (video.width < 540 || video.height < 960 || Math.abs(video.width / video.height - 9 / 16) > 0.01)) throw new Error("Facebook Reel uploads require a 9:16 portrait video of at least 540 × 960 pixels.");
      if (platform === "instagram" && (video.width > 1920 || video.width / video.height > 10 || video.width / video.height < 0.01 || Number(video.bit_rate) > 25_000_000)) throw new Error("Instagram Reel dimensions or bitrate are unsupported; use width ≤1920 and bitrate ≤25 Mbps.");
    }
    let videoPath = path;
    if (normalized) {
      const url = await storage.getObjectEntityUploadURL(tenantId);
      const body = createReadStream(localPath);
      try {
        const response = await fetch(url, {
          method: "PUT", headers: { "Content-Type": "video/mp4", "Content-Length": String(size) },
          body: body as any, duplex: "half", signal: AbortSignal.timeout(120_000),
        } as RequestInit);
        if (!response.ok) throw new Error("Could not save the compatible Reel. Please try again.");
        await response.body?.cancel();
        videoPath = storage.normalizeObjectEntityPath(url);
      } finally { body.destroy(); }
    }
    return { localPath, size, cleanup, videoPath };
  } catch (error) {
    await cleanup();
    throw error;
  }
}