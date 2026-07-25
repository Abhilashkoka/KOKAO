import { writeFile, readFile, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { pickMusicStartOffsetSec } from "../musicOffset";
import { runFfmpeg, findFontFile, probeDurationSec } from "../slideshow";
import { ASPECT_DIMENSIONS, VideoGenProviderError, type VideoAspect } from "../types";
import type { NarrationCue } from "./narration";
import { buildCaptionChunks } from "./wordTimings";

/**
 * Final assembly for the Topic to Video engine, on the same system ffmpeg the
 * slideshow encoder uses. Composition rules are ported from
 * MoneyPrinterTurbo (MIT, app/services/video.py): stock clips are
 * cover-cropped to the target frame and cut per narration sentence; subtitles
 * are burned white-on-stroke near the bottom; background music ducks under
 * the voice (0.2 vs 1.0) and fades out at the end.
 *
 * Each sentence becomes one scene: its clip segment is preprocessed to an
 * identically-encoded MP4 (looping the source if it runs short), the segments
 * are concat-demuxed, and one final pass burns subtitles and mixes audio.
 */

const FPS = 30;
/**
 * Music level BEFORE ducking. Sidechain compression (keyed on the narration)
 * pulls it well below the voice while someone is speaking, so this can sit
 * higher than the old static 0.2 and fill the pauses instead of being
 * inaudible throughout.
 */
const MUSIC_VOLUME = 0.45;
const MUSIC_FADE_SEC = 1.5;
/** Dip-to-black length on scene cuts (skipped on very short scenes). */
const SCENE_FADE_SEC = 0.2;

/** An explicit visual scene: which clip plays, for how long. */
export interface SceneSegment {
  /** Index into `clips`. */
  clipIndex: number;
  durationSec: number;
}

export interface ComposeInput {
  /** Source clips. Cycled per sentence, unless `sceneMap` dictates scenes. */
  clips: Buffer[];
  /** Complete narration track (WAV). */
  narrationWav: Buffer;
  /** Sentence timings within the narration track, in order. */
  cues: NarrationCue[];
  /** Full output duration (narration + trailing pause). */
  totalDurationSec: number;
  aspectRatio: VideoAspect;
  /** Burn per-sentence subtitles (skipped if no usable font is installed). */
  subtitles: boolean;
  /**
   * "classic" (default): one sentence at a time near the bottom.
   * "dynamic": big 2-3 word groups timed to the narration — the short-form
   * social style. Ignored when `subtitles` is false.
   */
  captionStyle?: "classic" | "dynamic";
  /** Brand accent for the caption stroke, as an ffmpeg color ("0xRRGGBB");
   * null/omitted keeps the default black stroke. */
  accentColor?: string | null;
  /** Brand logo bytes (PNG/JPEG) overlaid top-right at ~7% height. */
  watermark?: Buffer | null;
  /** Optional background music bytes. */
  music?: Buffer | null;
  /**
   * Optional explicit scene layout (character videos: one AI clip per scene,
   * spanning several sentences). When omitted, one scene per cue cycling
   * through `clips` — the stock-footage behavior.
   */
  sceneMap?: SceneSegment[] | null;
}

/**
 * Wrap subtitle text into short centered lines. Space-separated languages
 * wrap on words; scripts without spaces fall back to hard character wraps.
 */
export function wrapSubtitleText(text: string, maxCharsPerLine: number): string {
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (word.length > maxCharsPerLine) {
      if (current) {
        lines.push(current);
        current = "";
      }
      for (let i = 0; i < word.length; i += maxCharsPerLine) {
        const piece = word.slice(i, i + maxCharsPerLine);
        if (piece.length === maxCharsPerLine) lines.push(piece);
        else current = piece;
      }
      continue;
    }
    if (current && (current + " " + word).length > maxCharsPerLine) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines.join("\n");
}

/**
 * Break up back-to-back repeats of the same footage (diversity idea from
 * OpenMontage's MMR selection, reimplemented): when two adjacent scenes would
 * show the same clip, the second swaps to the least-used clip that differs
 * from both neighbors. Deterministic, and a no-op with a single clip.
 */
export function diversifySceneClips(scenes: SceneSegment[], clipCount: number): SceneSegment[] {
  if (clipCount <= 1) return scenes;
  const out = scenes.map((scene) => ({ ...scene }));
  for (let i = 1; i < out.length; i++) {
    if (out[i]!.clipIndex !== out[i - 1]!.clipIndex) continue;
    const prev = out[i - 1]!.clipIndex;
    const next = i + 1 < out.length ? out[i + 1]!.clipIndex : -1;
    const counts = new Array<number>(clipCount).fill(0);
    for (const scene of out) counts[scene.clipIndex] = (counts[scene.clipIndex] ?? 0) + 1;
    let best = -1;
    let bestPenalty = Infinity;
    for (let c = 0; c < clipCount; c++) {
      if (c === prev) continue;
      const penalty = (c === next ? 1000 : 0) + (counts[c] ?? 0);
      if (penalty < bestPenalty) {
        best = c;
        bestPenalty = penalty;
      }
    }
    if (best !== -1) out[i]!.clipIndex = best;
  }
  return out;
}

/** Scene lengths: each sentence owns the track up to the next sentence. */
export function sceneDurations(cues: NarrationCue[], totalDurationSec: number): number[] {
  return cues.map((cue, i) => {
    const end = i + 1 < cues.length ? cues[i + 1]!.startSec : totalDurationSec;
    return Math.max(end - cue.startSec, 0.2);
  });
}

/** Render the final MP4. Returns the encoded video bytes. */
export async function composeTopicVideo(input: ComposeInput): Promise<Buffer> {
  if (input.clips.length === 0) {
    throw new VideoGenProviderError("No stock footage available to compose the video.");
  }
  if (input.cues.length === 0) {
    throw new VideoGenProviderError("No narration to compose the video around.");
  }
  const { width, height } = ASPECT_DIMENSIONS[input.aspectRatio];
  const rawScenes: SceneSegment[] =
    input.sceneMap && input.sceneMap.length > 0
      ? input.sceneMap
      : sceneDurations(input.cues, input.totalDurationSec).map((durationSec, i) => ({
          clipIndex: i % input.clips.length,
          durationSec,
        }));
  for (const scene of rawScenes) {
    if (scene.clipIndex < 0 || scene.clipIndex >= input.clips.length) {
      throw new VideoGenProviderError("Scene map references a missing clip.");
    }
  }
  const scenes = diversifySceneClips(rawScenes, input.clips.length);

  const dir = await mkdtemp(join(tmpdir(), "kokao-topic-video-"));
  try {
    for (let i = 0; i < input.clips.length; i++) {
      await writeFile(join(dir, `clip_${i}.mp4`), input.clips[i]!);
    }
    await writeFile(join(dir, "narration.wav"), input.narrationWav);
    const hasMusic = !!input.music && input.music.length > 0;
    let musicSeekSec = 0;
    if (hasMusic) {
      await writeFile(join(dir, "music"), input.music!);
      // Skip a long quiet intro so the bed is musical from the first second
      // (fail-soft: 0 = play from the top, the old behavior).
      musicSeekSec = await pickMusicStartOffsetSec("music", dir, input.totalDurationSec);
    }

    // Probe each clip's duration once so scenes can seek into a DIFFERENT
    // part of the footage instead of always replaying from t=0 (which made
    // reused clips feel like a loop). Probe failure just disables seeking.
    const clipDurations = new Map<number, number | null>();
    for (const scene of scenes) {
      if (!clipDurations.has(scene.clipIndex)) {
        clipDurations.set(
          scene.clipIndex,
          await probeDurationSec(`clip_${scene.clipIndex}.mp4`, dir),
        );
      }
    }

    // 1) One identically-encoded segment per scene. Long sources are seeked
    // into (golden-ratio spread per scene, deterministic); short sources
    // loop as before. Cuts get a subtle dip-to-black so scene changes read
    // as intentional edits rather than jumps.
    const frame =
      `scale=${width}:${height}:force_original_aspect_ratio=increase,` +
      `crop=${width}:${height},setsar=1,fps=${FPS},format=yuv420p`;
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i]!;
      const clipDur = clipDurations.get(scene.clipIndex) ?? null;
      const spare = clipDur !== null ? clipDur - scene.durationSec : 0;
      const canSeek = clipDur !== null && spare > 0.5;
      const seekSec = canSeek ? ((i * 0.618034) % 1) * (spare - 0.25) : 0;

      const fades: string[] = [];
      if (scene.durationSec > SCENE_FADE_SEC * 4) {
        if (i > 0) fades.push(`fade=t=in:st=0:d=${SCENE_FADE_SEC}`);
        if (i < scenes.length - 1) {
          fades.push(
            `fade=t=out:st=${(scene.durationSec - SCENE_FADE_SEC).toFixed(3)}:d=${SCENE_FADE_SEC}`,
          );
        }
      }

      const args = ["-y"];
      if (canSeek) args.push("-ss", seekSec.toFixed(3));
      else args.push("-stream_loop", "-1");
      args.push(
        "-i",
        `clip_${scene.clipIndex}.mp4`,
        "-t",
        scene.durationSec.toFixed(3),
        "-vf",
        [frame, ...fades].join(","),
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        `seg_${String(i).padStart(3, "0")}.mp4`,
      );
      await runFfmpeg(args, dir);
    }
    const concatList = scenes
      .map((_, i) => `file 'seg_${String(i).padStart(3, "0")}.mp4'`)
      .join("\n");
    await writeFile(join(dir, "list.txt"), concatList);

    // 2) Final pass: concat scenes, burn subtitles, mix narration + music.
    const fontFile = input.subtitles ? await findFontFile() : null;
    const dynamicCaptions = input.captionStyle === "dynamic";
    // Dynamic captions are the big short-form style: larger type, heavier
    // stroke, sitting higher so they read as the focal point.
    const fontSize = Math.round(height / (dynamicCaptions ? 13 : 18));
    const maxCharsPerLine = Math.max(Math.floor((width * 0.88) / (fontSize * 0.56)), 8);
    const strokeWidth = Math.max(2, Math.round(fontSize / (dynamicCaptions ? 14 : 24)));
    const yExpr = dynamicCaptions
      ? `(h-text_h)*0.72`
      : `h-text_h-${Math.round(height / 8)}`;

    // One drawtext per caption entry: whole sentences (classic) or timed
    // 2-3 word groups (dynamic).
    const captionEntries: { text: string; startSec: number }[] = dynamicCaptions
      ? buildCaptionChunks(input.cues).map((chunk) => ({
          text: chunk.text,
          startSec: chunk.startSec,
        }))
      : input.cues.map((cue) => ({ text: cue.text, startSec: cue.startSec }));

    const videoFilters: string[] = [];
    if (fontFile) {
      for (let i = 0; i < captionEntries.length; i++) {
        const entry = captionEntries[i]!;
        // textfile= sidesteps drawtext's brittle inline-escaping rules (same
        // trick as the slideshow caption).
        await writeFile(
          join(dir, `cue_${String(i).padStart(3, "0")}.txt`),
          wrapSubtitleText(entry.text, maxCharsPerLine),
        );
        const start = entry.startSec.toFixed(3);
        // Hold each caption until the next one appears so text never
        // flickers off during pauses.
        const end = (
          i + 1 < captionEntries.length
            ? captionEntries[i + 1]!.startSec
            : input.totalDurationSec
        ).toFixed(3);
        videoFilters.push(
          `drawtext=fontfile=${fontFile}:textfile=cue_${String(i).padStart(3, "0")}.txt:` +
            `fontcolor=white:fontsize=${fontSize}:borderw=${strokeWidth}:` +
            `bordercolor=${input.accentColor ?? "black"}:` +
            `line_spacing=${Math.round(fontSize / 5)}:` +
            `x=(w-text_w)/2:y=${yExpr}:` +
            `enable='between(t,${start},${end})'`,
        );
      }
    }

    // Brand watermark: small logo top-right at ~7% frame height, 85% opacity
    // (top-right keeps clear of both caption styles).
    const hasWatermark = !!input.watermark && input.watermark.length > 0;
    if (hasWatermark) {
      await writeFile(join(dir, "logo.png"), input.watermark!);
    }
    const watermarkIndex = 2 + (hasMusic ? 1 : 0);
    const watermarkPad = Math.round(height / 45);
    const baseChain =
      videoFilters.length > 0 ? `[0:v]${videoFilters.join(",")}` : `[0:v]null`;
    const videoChain = hasWatermark
      ? `${baseChain}[vbase];` +
        `[${watermarkIndex}:v]scale=-1:${Math.round(height * 0.07)},format=rgba,` +
        `colorchannelmixer=aa=0.85[wm];` +
        `[vbase][wm]overlay=W-w-${watermarkPad}:${watermarkPad}[vout]`
      : `${baseChain}[vout]`;

    // Audio: the narration is loudness-normalized to a spoken-word target,
    // the music is genuinely DUCKED under speech via sidechain compression
    // (keyed on the narration, so it swells back in the pauses), and the
    // final mix is normalized to the ~-14 LUFS social platforms expect.
    const narrationNorm = "loudnorm=I=-16:TP=-1.5:LRA=11";
    const mixNorm = "loudnorm=I=-14:TP=-1.5:LRA=11";
    const musicFade =
      `afade=t=out:st=${Math.max(0, input.totalDurationSec - MUSIC_FADE_SEC).toFixed(3)}:` +
      `d=${MUSIC_FADE_SEC}`;
    const audioChain = hasMusic
      ? `[1:a]${narrationNorm},asplit=2[nar][narkey];` +
        `[2:a]volume=${MUSIC_VOLUME},${musicFade}[bgm];` +
        `[bgm][narkey]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[duck];` +
        `[nar][duck]amix=inputs=2:duration=first:normalize=0,${mixNorm}[aout]`
      : `[1:a]${mixNorm}[aout]`;

    // The filtergraph can exceed argv comfort with many cues; feed it from a
    // script file instead.
    await writeFile(join(dir, "filters.txt"), `${videoChain};${audioChain}`);

    const args = ["-y", "-f", "concat", "-safe", "0", "-i", "list.txt", "-i", "narration.wav"];
    if (hasMusic) {
      args.push("-stream_loop", "-1");
      if (musicSeekSec > 0) args.push("-ss", musicSeekSec.toFixed(3));
      args.push("-i", "music");
    }
    if (hasWatermark) args.push("-i", "logo.png");
    args.push(
      "-filter_complex_script",
      "filters.txt",
      "-map",
      "[vout]",
      "-map",
      "[aout]",
      "-t",
      input.totalDurationSec.toFixed(3),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      "out.mp4",
    );
    await runFfmpeg(args, dir);
    return await readFile(join(dir, "out.mp4"));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
