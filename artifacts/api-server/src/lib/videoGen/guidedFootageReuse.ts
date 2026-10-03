import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { VideoJobOptions } from "@workspace/db";
import { runFfmpeg } from "./slideshow";

type Plan = NonNullable<VideoJobOptions["guidedFootageReuse"]>;
const exec = promisify(execFile);

/**
 * Only explicit references to this story's completed output qualify. Ordinary
 * laptop shots, reference photos and unrelated video mentions do not.
 * Freeze at enqueue, not at recovery, so changing this parser cannot reinterpret
 * an already funded job.
 */
export function planGuidedFootageReuse(guided: VideoJobOptions["guidedStory"]): Plan {
  const scenes: Plan["scenes"] = [];
  if (!guided) return { version: 1, scenes };
  let previous: string | null = null;
  for (const scene of guided.script.scenes) {
    const direction = scene.visualDirection;
    const ownOutput = /\b(?:finished|completed|rendered|generated|resulting)\s+(?:[\w'-]+\s+){0,2}(?:reel|video)\b/i.test(direction);
    const endCard = /\b(?:end[\s-]?card|outro|closing\s+card)\b/i.test(direction);
    const preview = /\b(?:still|thumbnail|preview)\b/i.test(direction);
    const playback = /\b(?:plays?|playing|playback|full[\s-]?screen)\b/i.test(direction);
    if (ownOutput && ((endCard && preview) || (!endCard && playback))) {
      if (!previous) throw new Error(`Scene ${scene.id} requests footage from the finished story before any footage exists. Move it after a story scene.`);
      if (scene.lines.some(line => line.kind === "dialogue" || line.ownerRoleId != null)) {
        throw new Error(`Scene ${scene.id} replays earlier footage but contains on-camera dialogue. Use off-screen narration for a reel preview.`);
      }
      const logoName = direction.match(/\b([\p{L}\p{N}][\p{L}\p{N}&_-]*)\s+logo\b/u)?.[1];
      const website = direction.match(/\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|in|org|net|io|ai|co)\b/i)?.[0] ?? null;
      scenes.push({
        sceneId: scene.id,
        sourceSceneId: previous,
        kind: endCard ? "end_card" : "reel",
        title: logoName && !/^(?:the|a|our|your|brand|company)$/i.test(logoName) ? logoName : guided.script.title,
        website,
        logoPath: guided.visuals?.logo?.path ?? null,
      });
      // An end-card thumbnail must come from the composed reel, not the raw
      // provider clip whose pixels are deliberately discarded.
      if (!endCard) previous = scene.id;
    } else if (!endCard) {
      previous = scene.id;
    }
  }
  return { version: 1, scenes };
}

export function validateGuidedFootageReuse(plan: Plan, ids: string[]) {
  if (plan.version !== 1) throw new Error("Unsupported frozen footage-reuse version.");
  const seen = new Set<string>();
  for (const item of plan.scenes) {
    const target = ids.indexOf(item.sceneId);
    const source = ids.indexOf(item.sourceSceneId);
    if (seen.has(item.sceneId) || source < 0 || target <= source ||
        !["reel", "end_card"].includes(item.kind)) {
      throw new Error("The saved reel-preview footage links no longer match the story. Start a new video.");
    }
    seen.add(item.sceneId);
  }
}

const xml = (text: string) => text.replace(/[&<>"']/g, char =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!);

async function probe(path: string) {
  const { stdout } = await exec("ffprobe", [
    "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height",
    "-of", "json", path,
  ], { timeout: 30_000 });
  const data = JSON.parse(stdout);
  const video = data.streams?.find((stream: { codec_type: string }) => stream.codec_type === "video");
  const duration = Number(data.format?.duration);
  if (!video?.width || !video?.height || !Number.isFinite(duration) || duration <= 0 || duration > 120) {
    throw new Error("Saved reel-preview footage could not be verified.");
  }
  return { width: video.width as number, height: video.height as number, duration };
}

/**
 * Never deliver the provider's invented reel/thumbnail pixels. The target clip
 * is retained solely as the approved scene's native narration/audio carrier;
 * external narration is still mixed by the normal downstream compositor.
 * Raw provider checkpoints remain immutable, so resume reapplies this exactly
 * once before final composition. Source audio is never copied.
 */
export async function composeGuidedFootageReuse(params: {
  plan?: Plan;
  sceneIds: string[];
  clips: Buffer[];
  load: (path: string) => Promise<Buffer>;
}): Promise<Buffer[]> {
  if (!params.plan?.scenes.length) return params.clips;
  validateGuidedFootageReuse(params.plan, params.sceneIds);
  const clips = [...params.clips];
  const ordered = [...params.plan.scenes].sort((a, b) =>
    params.sceneIds.indexOf(a.sceneId) - params.sceneIds.indexOf(b.sceneId));
  for (const item of ordered) {
    const targetIndex = params.sceneIds.indexOf(item.sceneId);
    const sourceIndex = params.sceneIds.indexOf(item.sourceSceneId);
    if (!clips[targetIndex]?.length || !clips[sourceIndex]?.length) {
      throw new Error("Saved footage for a reel preview is missing. No substitute will be generated.");
    }
    const dir = await mkdtemp(join(tmpdir(), "guided-reel-reuse-"));
    try {
      await Promise.all([
        writeFile(join(dir, "source.mp4"), clips[sourceIndex]),
        writeFile(join(dir, "target.mp4"), clips[targetIndex]),
      ]);
      const [source, target] = await Promise.all([
        probe(join(dir, "source.mp4")), probe(join(dir, "target.mp4")),
      ]);
      const ratio = Math.min(1, 1920 / Math.max(target.width, target.height));
      const width = Math.max(2, Math.round(target.width * ratio / 2) * 2);
      const height = Math.max(2, Math.round(target.height * ratio / 2) * 2);
      const fit = (w: number, h: number) =>
        `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p`;
      let args: string[];
      if (item.kind === "reel") {
        args = ["-i", "source.mp4", "-i", "target.mp4", "-filter_complex",
          `[0:v]${fit(width, height)},tpad=stop_mode=clone:stop_duration=${target.duration},trim=duration=${target.duration},setpts=PTS-STARTPTS[v]`,
          "-map", "[v]", "-map", "1:a?"];
      } else {
        // Deterministic card: literal approved brand text / uploaded logo, not
        // an AI-invented logo or a newly synthesized doctor's face.
        const fontSize = Math.max(16, Math.round(width * 0.075));
        const title = xml(item.title.slice(0, 100));
        const card = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#111827"/><text x="50%" y="19%" text-anchor="middle" font-family="DejaVu Sans" font-size="${fontSize}" fill="white" textLength="${Math.min(width * .82, item.title.length * fontSize * .55)}" lengthAdjust="spacingAndGlyphs">${item.logoPath ? "" : title}</text><text x="50%" y="30%" text-anchor="middle" font-family="DejaVu Sans" font-size="${Math.round(fontSize * .5)}" fill="white">${xml(item.website ?? "")}</text></svg>`);
        let background = sharp(card);
        if (item.logoPath) {
          const logo = await sharp(await params.load(item.logoPath))
            .resize(Math.round(width * .6), Math.round(height * .17), { fit: "inside" }).png().toBuffer();
          const metadata = await sharp(logo).metadata();
          background = background.composite([{ input: logo, left: Math.round((width - metadata.width!) / 2), top: Math.round(height * .07) }]);
        }
        await background.png().toFile(join(dir, "card.png"));
        await runFfmpeg(["-y", "-ss", String(Math.max(0, source.duration - .25)), "-i", "source.mp4",
          "-frames:v", "1", "still.png"], dir, 60_000);
        const insetW = Math.round(width * .70 / 2) * 2;
        const insetH = Math.round(height * .48 / 2) * 2;
        args = ["-loop", "1", "-framerate", "30", "-i", "card.png", "-i", "target.mp4",
          "-loop", "1", "-framerate", "30", "-i", "still.png", "-filter_complex",
          `[2:v]${fit(insetW, insetH)}[inset];[0:v][inset]overlay=x=(W-w)/2:y=H*0.40:shortest=1,format=yuv420p[v]`,
          "-map", "[v]", "-map", "1:a?"];
      }
      await runFfmpeg(["-y", ...args, "-t", String(target.duration), "-c:v", "libx264",
        "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "copy",
        "-movflags", "+faststart", "result.mp4"], dir, 300_000);
      clips[targetIndex] = await readFile(join(dir, "result.mp4"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  return clips;
}