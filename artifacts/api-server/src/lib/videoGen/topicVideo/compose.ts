import { writeFile, readFile, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { runFfmpeg, findFontFile } from "../slideshow";
import { ASPECT_DIMENSIONS, VideoGenProviderError, type VideoAspect } from "../types";
import type { NarrationCue } from "./narration";

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
/** Keep music clearly under the narration, per MoneyPrinterTurbo's default. */
const MUSIC_VOLUME = 0.2;
const MUSIC_FADE_SEC = 1.5;

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
  const scenes: SceneSegment[] =
    input.sceneMap && input.sceneMap.length > 0
      ? input.sceneMap
      : sceneDurations(input.cues, input.totalDurationSec).map((durationSec, i) => ({
          clipIndex: i % input.clips.length,
          durationSec,
        }));
  for (const scene of scenes) {
    if (scene.clipIndex < 0 || scene.clipIndex >= input.clips.length) {
      throw new VideoGenProviderError("Scene map references a missing clip.");
    }
  }

  const dir = await mkdtemp(join(tmpdir(), "kokao-topic-video-"));
  try {
    for (let i = 0; i < input.clips.length; i++) {
      await writeFile(join(dir, `clip_${i}.mp4`), input.clips[i]!);
    }
    await writeFile(join(dir, "narration.wav"), input.narrationWav);
    const hasMusic = !!input.music && input.music.length > 0;
    if (hasMusic) {
      await writeFile(join(dir, "music"), input.music!);
    }

    // 1) One identically-encoded segment per scene, looping short sources.
    const frame =
      `scale=${width}:${height}:force_original_aspect_ratio=increase,` +
      `crop=${width}:${height},setsar=1,fps=${FPS},format=yuv420p`;
    for (let i = 0; i < scenes.length; i++) {
      await runFfmpeg(
        [
          "-y",
          "-stream_loop",
          "-1",
          "-i",
          `clip_${scenes[i]!.clipIndex}.mp4`,
          "-t",
          scenes[i]!.durationSec.toFixed(3),
          "-vf",
          frame,
          "-an",
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "23",
          `seg_${String(i).padStart(3, "0")}.mp4`,
        ],
        dir,
      );
    }
    const concatList = scenes
      .map((_, i) => `file 'seg_${String(i).padStart(3, "0")}.mp4'`)
      .join("\n");
    await writeFile(join(dir, "list.txt"), concatList);

    // 2) Final pass: concat scenes, burn subtitles, mix narration + music.
    const fontFile = input.subtitles ? await findFontFile() : null;
    const fontSize = Math.round(height / 18);
    const maxCharsPerLine = Math.max(Math.floor((width * 0.88) / (fontSize * 0.56)), 8);
    const strokeWidth = Math.max(2, Math.round(fontSize / 24));

    const videoFilters: string[] = [];
    if (fontFile) {
      for (let i = 0; i < input.cues.length; i++) {
        const cue = input.cues[i]!;
        // textfile= sidesteps drawtext's brittle inline-escaping rules (same
        // trick as the slideshow caption).
        await writeFile(
          join(dir, `cue_${String(i).padStart(3, "0")}.txt`),
          wrapSubtitleText(cue.text, maxCharsPerLine),
        );
        const start = cue.startSec.toFixed(3);
        // Hold each subtitle until the next one appears so text never
        // flickers off during the inter-sentence pause.
        const end = (
          i + 1 < input.cues.length ? input.cues[i + 1]!.startSec : input.totalDurationSec
        ).toFixed(3);
        videoFilters.push(
          `drawtext=fontfile=${fontFile}:textfile=cue_${String(i).padStart(3, "0")}.txt:` +
            `fontcolor=white:fontsize=${fontSize}:borderw=${strokeWidth}:bordercolor=black:` +
            `line_spacing=${Math.round(fontSize / 5)}:` +
            `x=(w-text_w)/2:y=h-text_h-${Math.round(height / 8)}:` +
            `enable='between(t,${start},${end})'`,
        );
      }
    }
    const videoChain =
      videoFilters.length > 0 ? `[0:v]${videoFilters.join(",")}[vout]` : `[0:v]null[vout]`;

    const audioChain = hasMusic
      ? `[2:a]volume=${MUSIC_VOLUME},` +
        `afade=t=out:st=${Math.max(0, input.totalDurationSec - MUSIC_FADE_SEC).toFixed(3)}:` +
        `d=${MUSIC_FADE_SEC}[bgm];` +
        `[1:a][bgm]amix=inputs=2:duration=first:normalize=0[aout]`
      : `[1:a]anull[aout]`;

    // The filtergraph can exceed argv comfort with many cues; feed it from a
    // script file instead.
    await writeFile(join(dir, "filters.txt"), `${videoChain};${audioChain}`);

    const args = ["-y", "-f", "concat", "-safe", "0", "-i", "list.txt", "-i", "narration.wav"];
    if (hasMusic) args.push("-stream_loop", "-1", "-i", "music");
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
