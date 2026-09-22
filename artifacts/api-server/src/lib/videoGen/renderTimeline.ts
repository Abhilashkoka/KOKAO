import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeDurationSec, runFfmpeg } from "./slideshow";
import { VideoGenProviderError } from "./types";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function measuredSceneTimeline(sceneIds: string[], durations: number[]) {
  const timeline = renderedTimeline(durations, durations);
  if (sceneIds.length !== timeline.length) throw new VideoGenProviderError("Rendered scene identities are incomplete.");
  return { version: 1 as const, scenes: timeline.map((scene, index) => ({
    sceneId: sceneIds[index]!, startSec: scene.startSec, endSec: scene.endSec,
  })) };
}

/** Rendering metadata only. Never mutate approved plans or provider billing receipts. */
export function renderedTimeline(planned: number[], actual: number[]) {
  if (planned.length !== actual.length || [...planned, ...actual].some((n) => !Number.isFinite(n) || n <= 0)) {
    throw new VideoGenProviderError("Cannot establish the complete generated-clip timeline.");
  }
  let plannedStart = 0;
  let startSec = 0;
  return planned.map((duration, index) => {
    const entry = { plannedStart, plannedEnd: plannedStart + duration, startSec, endSec: startSec + actual[index]!, durationSec: actual[index]! };
    plannedStart += duration;
    startSec = entry.endSec;
    return entry;
  });
}

export function rebaseRenderedCues<T extends { startSec: number; endSec: number }>(
  cues: T[], timeline: ReturnType<typeof renderedTimeline>,
): T[] {
  return cues.map((cue) => {
    const scene = timeline.find((entry) => cue.startSec >= entry.plannedStart && cue.startSec < entry.plannedEnd);
    if (!scene || cue.endSec - scene.plannedStart > scene.durationSec + 0.04) {
      throw new VideoGenProviderError("The complete narration does not fit this generated scene. Footage and speech will not be shortened or sped up automatically.");
    }
    const offset = scene.startSec - scene.plannedStart;
    return { ...cue, startSec: cue.startSec + offset, endSec: cue.endSec + offset };
  });
}

export async function actualClipDuration(video: Buffer): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), "kokao-actual-clip-"));
  try {
    await writeFile(join(dir, "clip.mp4"), video);
    const duration = await probeDurationSec("clip.mp4", dir);
    if (!duration || !Number.isFinite(duration)) throw new VideoGenProviderError("Generated clip duration could not be measured; refusing to trim it to an estimate.");
    return duration;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Restore unsynced original frames after a shorter paid sync result. No redispatch. */
export async function preserveLipSyncTail(synced: Buffer, base: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "kokao-sync-tail-"));
  try {
    await writeFile(join(dir, "sync.mp4"), synced);
    await writeFile(join(dir, "base.mp4"), base);
    const probe = async (file: string) => {
      const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", file], { cwd: dir, timeout: 30_000 });
      return JSON.parse(stdout).streams as Array<{ codec_type: string; width?: number; height?: number; duration?: string }>;
    };
    const streams = await probe("sync.mp4");
    const dimensions = streams.find((stream) => stream.codec_type === "video");
    if (!dimensions?.width || !dimensions.height) throw new VideoGenProviderError("Cannot measure lip-sync output dimensions.");
    const baseStreams = await probe("base.mp4");
    // Use picture duration, not a longer audio/container duration: otherwise
    // audio padding can hide missing frames in a shortened sync result.
    const syncSec = Number(dimensions.duration) || await actualClipDuration(synced);
    const baseSec = Number(baseStreams.find((stream) => stream.codec_type === "video")?.duration) || await actualClipDuration(base);
    if (syncSec >= baseSec - 0.02) return synced;
    const hasAudio = streams.some((stream) => stream.codec_type === "audio");
    const baseHasAudio = baseStreams.some((stream) => stream.codec_type === "audio");
    const tailSec = baseSec - syncSec;
    const audio = hasAudio
      ? `;[0:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=${syncSec}[ha];` +
        (baseHasAudio
          ? `[1:a]atrim=start=${syncSec},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=${tailSec}[ta]`
          : `anullsrc=r=48000:cl=stereo,atrim=duration=${tailSec}[ta]`) +
        ";[ha][ta]concat=n=2:v=0:a=1[a]"
      : "";
    await runFfmpeg([
      "-y", "-i", "sync.mp4", "-i", "base.mp4",
      "-filter_complex",
      `[0:v]setpts=PTS-STARTPTS,setsar=1,fps=30,format=yuv420p[h];[1:v]trim=start=${syncSec},setpts=PTS-STARTPTS,scale=${dimensions.width}:${dimensions.height},setsar=1,fps=30,format=yuv420p[t];[h][t]concat=n=2:v=1:a=0[v]${audio}`,
      "-map", "[v]", ...(hasAudio ? ["-map", "[a]", "-c:a", "aac"] : ["-an"]),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-movflags", "+faststart", "out.mp4",
    ], dir);
    return await readFile(join(dir, "out.mp4"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}