/**
 * The ffmpeg half of video localization: burning Indic subtitles and fitting a
 * dubbed voice track to a locked cut.
 *
 * Two things here are not obvious and are the reason this is a separate module
 * rather than a few lines inside the job runner.
 *
 * 1. Subtitles go through libass, never drawtext. The existing caption
 *    compositor uses `drawtext`, which renders through libfreetype with no
 *    complex-script shaping: Telugu and Tamil conjuncts come out reordered or
 *    broken, and Devanagari matras detach from the shirorekha. The `subtitles`
 *    filter runs libass, which shapes through HarfBuzz and applies bidi via
 *    FriBidi. For Latin the two look identical, which is exactly why the bug
 *    survives review.
 *
 * 2. Fonts are resolved by explicit family and then verified. fontconfig never
 *    fails — `fc-match ":lang=ta"` happily returns FreeSans, which nominally
 *    covers Tamil and renders it badly. Asking for a family and checking what
 *    came back is the only way to know a real Indic face was used, so a
 *    missing font fails the render loudly instead of shipping tofu.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { localePolicy, toSrt, type SubtitleCue, type TargetLocale } from "@workspace/localization";

import { encodeBudgetMs, probeDurationSec, runFfmpeg } from "../videoGen/slideshow";
import { VideoGenProviderError } from "../videoGen/types";
import { parseWav } from "../videoGen/topicVideo/narration";
import { speakIndicCue } from "../videoGen/topicVideo/tts";
import type { NarrationVoice } from "../videoGen/topicVideo/narration";

const execFileAsync = promisify(execFile);

/** Thrown when the host is missing a usable font for the target script. */
export class MissingIndicFontError extends Error {
  constructor(locale: TargetLocale, candidates: readonly string[]) {
    super(
      `No font installed for ${localePolicy(locale).label}. Install one of: ${candidates.join(", ")}. ` +
        `On Replit, add pkgs.noto-fonts to replit.nix.`,
    );
    this.name = "MissingIndicFontError";
  }
}

/** Normalise a fontconfig family string for comparison. */
function familyKey(value: string): string {
  return value.split(",")[0]!.trim().toLowerCase();
}

export interface ResolvedFont {
  family: string;
  file: string;
}

/**
 * Find a real font for the locale's script.
 *
 * Walks the locale's candidate families in preference order and accepts the
 * first one fontconfig returns *by that name*. A mismatch means fontconfig
 * substituted a fallback, which is the failure this function exists to catch.
 */
export async function resolveSubtitleFont(locale: TargetLocale): Promise<ResolvedFont> {
  const candidates = localePolicy(locale).fontCandidates;

  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync(
        "fc-match",
        ["-f", "%{family}|%{file}", candidate],
        { timeout: 5000 },
      );
      const [family, file] = stdout.split("|");
      if (!family || !file) continue;
      if (familyKey(family) === familyKey(candidate)) {
        return { family: candidate, file: file.trim() };
      }
    } catch {
      // fontconfig missing entirely: fall through to the error below.
      break;
    }
  }

  throw new MissingIndicFontError(locale, candidates);
}

/* ------------------------------------------------------------------ *
 * Fitting a spoken take to its slot
 * ------------------------------------------------------------------ */

/**
 * How far the playback rate may be bent to make a take fit.
 *
 * Beyond about 8% a listener hears it as rushed or draggy even when they
 * cannot say why, and a rushed dub is the loudest possible signal that a video
 * was localized rather than made. Anything that needs more than this is
 * reported as an overrun for a human to fix by cutting a word.
 */
export const MAX_TEMPO_ADJUST = 0.08;

export interface AudioFit {
  /** atempo factor to apply. 1 means leave it alone. */
  tempo: number;
  /** Silence to append after the take, in milliseconds. */
  padMs: number;
  /**
   * Milliseconds the take still exceeds its slot by after bending the tempo
   * as far as it may go. Non-zero means the line is too long and needs a word
   * cut — the pipeline surfaces it rather than silently letting cues collide.
   */
  overrunMs: number;
}

/** Work out how to fit a take of `actualMs` into a slot of `targetMs`. */
export function planAudioFit(actualMs: number, targetMs: number): AudioFit {
  if (!Number.isFinite(actualMs) || actualMs <= 0 || targetMs <= 0) {
    return { tempo: 1, padMs: Math.max(0, Math.round(targetMs)), overrunMs: 0 };
  }

  if (actualMs <= targetMs) {
    // Shorter than the slot: never slow a read down to fill silence, just let
    // the silence sit. A stretched read sounds worse than a natural pause.
    return { tempo: 1, padMs: Math.round(targetMs - actualMs), overrunMs: 0 };
  }

  const needed = actualMs / targetMs;
  const tempo = Math.min(needed, 1 + MAX_TEMPO_ADJUST);
  const fittedMs = actualMs / tempo;
  const overrunMs = Math.max(0, Math.round(fittedMs - targetMs));

  return {
    tempo: Number(tempo.toFixed(4)),
    padMs: overrunMs > 0 ? 0 : Math.round(targetMs - fittedMs),
    overrunMs,
  };
}

/* ------------------------------------------------------------------ *
 * Subtitle burn-in
 * ------------------------------------------------------------------ */

export interface BurnSubtitlesInput {
  /** Source video bytes. */
  video: Buffer;
  cues: readonly SubtitleCue[];
  locale: TargetLocale;
  /** Rendered height, used to scale the type. Defaults to 1080. */
  videoHeight?: number;
}

/**
 * Build the libass `force_style` string.
 *
 * The values that matter for Indic: a real family for the script, and enough
 * line spacing that marks above and below the baseline are not clipped. The
 * 1.1 leading that suits a Latin caption cuts the top off Devanagari matras
 * and the bottom off Tamil vowel signs.
 */
export function buildForceStyle(font: ResolvedFont, videoHeight: number): string {
  const fontSize = Math.max(18, Math.round(videoHeight * 0.045));
  return [
    `FontName=${font.family}`,
    `FontSize=${fontSize}`,
    "PrimaryColour=&H00FFFFFF",
    "OutlineColour=&H90000000",
    "BorderStyle=3",
    "Outline=2",
    "Shadow=0",
    "Alignment=2",
    `MarginV=${Math.round(videoHeight * 0.06)}`,
    // Never synthesise bold or italic: faux styling smears conjuncts.
    "Bold=0",
    "Italic=0",
    // No letter spacing — it pulls conjunct ligatures apart.
    "Spacing=0",
  ].join(",");
}

/**
 * Burn subtitles into a video with libass.
 *
 * Runs in a temp directory with plain relative filenames because the
 * `subtitles` filter takes a filename inside a filtergraph string, where
 * colons and backslashes in an absolute path need double escaping and get it
 * wrong on some paths.
 */
export async function burnSubtitles(input: BurnSubtitlesInput): Promise<Buffer> {
  const font = await resolveSubtitleFont(input.locale);
  const height = input.videoHeight ?? 1080;
  const dir = await mkdtemp(join(tmpdir(), "kokao-dub-subs-"));

  try {
    await writeFile(join(dir, "in.mp4"), input.video);
    await writeFile(join(dir, "subs.srt"), toSrt(input.cues), "utf8");

    const lastEndMs = input.cues.reduce((max, cue) => Math.max(max, cue.endMs), 0);
    const style = buildForceStyle(font, height);

    await runFfmpeg(
      [
        "-y",
        "-i",
        "in.mp4",
        "-vf",
        `subtitles=subs.srt:force_style='${style}'`,
        "-c:a",
        "copy",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "out.mp4",
      ],
      dir,
      encodeBudgetMs(lastEndMs / 1000),
    );

    const { readFile } = await import("node:fs/promises");
    return await readFile(join(dir, "out.mp4"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ *
 * Assembling the dubbed voice track
 * ------------------------------------------------------------------ */

export interface DubTake {
  /** Cue this take belongs to. */
  index: number;
  /** Where the line starts in the finished video. */
  startMs: number;
  /** WAV bytes as returned by the TTS provider. */
  audio: Buffer;
  /** Playback rate correction from `planAudioFit`. */
  tempo: number;
}

/**
 * Lay every take onto one silent track at its cue offset.
 *
 * `adelay` positions each take and `amix` sums them. The takes do not overlap
 * — the fitter guarantees that — so summing is placement rather than mixing,
 * and `normalize=0` keeps each line at the level it was recorded instead of
 * quietly attenuating everything by the number of inputs.
 */
export async function assembleDubTrack(
  takes: readonly DubTake[],
  totalMs: number,
): Promise<Buffer> {
  if (takes.length === 0) throw new Error("No takes to assemble.");

  const dir = await mkdtemp(join(tmpdir(), "kokao-dub-track-"));
  try {
    const args: string[] = ["-y"];
    const filters: string[] = [];

    for (const [i, take] of takes.entries()) {
      const name = `take${i}.wav`;
      await writeFile(join(dir, name), take.audio);
      args.push("-i", name);

      const delay = Math.max(0, Math.round(take.startMs));
      const tempoStep = take.tempo !== 1 ? `atempo=${take.tempo},` : "";
      filters.push(`[${i}:a]${tempoStep}adelay=${delay}|${delay}[a${i}]`);
    }

    const inputs = takes.map((_, i) => `[a${i}]`).join("");
    filters.push(`${inputs}amix=inputs=${takes.length}:normalize=0:dropout_transition=0[mixed]`);
    // `-t` truncates but never extends, so a track whose last take ends before
    // the video does would come out short and drag the mux with it. `apad`
    // runs the tail out with silence; `-t` then cuts it to the exact length.
    filters.push("[mixed]apad[out]");

    args.push(
      "-filter_complex",
      filters.join(";"),
      "-map",
      "[out]",
      "-t",
      (Math.max(1, totalMs) / 1000).toFixed(3),
      "-ar",
      "48000",
      "-ac",
      "2",
      "-c:a",
      "pcm_s16le",
      "out.wav",
    );

    await runFfmpeg(args, dir, encodeBudgetMs(totalMs / 1000));
    const { readFile } = await import("node:fs/promises");
    return await readFile(join(dir, "out.wav"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Swap a video's audio for the dubbed track.
 *
 * The original audio is discarded rather than ducked. Music and dialogue
 * cannot be separated after the fact, so keeping the original under the dub
 * means the English is audible underneath — acceptable on a muted social feed,
 * not on anything anyone actually listens to. A workspace that wants its music
 * bed back supplies it as a separate stem.
 */
export async function replaceAudio(video: Buffer, audio: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "kokao-dub-mux-"));
  try {
    await writeFile(join(dir, "in.mp4"), video);
    await writeFile(join(dir, "voice.wav"), audio);

    await runFfmpeg(
      [
        "-y",
        "-i",
        "in.mp4",
        "-i",
        "voice.wav",
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "copy",
        // Pad the voice track with silence and let `-shortest` cut at the end
        // of the picture, so the output is exactly as long as the video no
        // matter how the dub landed. (Safe here in a way it is not with a
        // music bed: there is nothing behind the voice to lose.)
        "-af",
        "apad",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-shortest",
        "-movflags",
        "+faststart",
        "out.mp4",
      ],
      dir,
    );

    const { readFile } = await import("node:fs/promises");
    return await readFile(join(dir, "out.mp4"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ *
 * Localized dub orchestration
 * ------------------------------------------------------------------ */

/**
 * A single approved cue with its locked slot timings and exact text.
 * Must not be reworded, split, or reordered by the pipeline.
 */
export interface ApprovedDubCue {
  index: number;
  startMs: number;
  endMs: number;
  /** Exact approved text. Passed verbatim to TTS. */
  text: string;
}

/**
 * Thrown when a cue still overruns its slot by more than the 8% tempo cap
 * allows. The message is user-actionable: it names the cue and the overrun so
 * a human can trim a word.
 */
export class CueOverrunError extends Error {
  constructor(cueIndex: number, overrunMs: number) {
    super(
      `Cue ${cueIndex} is ${overrunMs} ms too long even after an 8% speed-up. ` +
        `Shorten the corresponding source line, then localize and review it again.`,
    );
    this.name = "CueOverrunError";
  }
}

/** User-correctable mismatch between the approved track and uploaded source. */
export class LocalizedDubInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalizedDubInputError";
  }
}

async function probeSourceVideoDurationMs(video: Buffer): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), "localized-dub-probe-"));
  try {
    await writeFile(join(dir, "source-video"), video);
    const durationSec = await probeDurationSec("source-video", dir);
    if (!durationSec) {
      throw new LocalizedDubInputError(
        "The source video could not be read. Please upload a valid MP4, MOV, or WebM video.",
      );
    }
    return durationSec * 1000;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Injectable dependencies for the dub orchestration — makes testing
 * straightforward without spawning ffmpeg or calling TTS.
 */
export interface DubOrchestrationDeps {
  /** Probe source duration before any TTS or rendering work. */
  probeSourceDurationMs?: (video: Buffer) => Promise<number>;
  /** Speak one cue and return WAV bytes. Defaults to speakIndicCue. */
  speakCue?: (text: string, voice: NarrationVoice) => Promise<Buffer>;
  /** Parse WAV bytes and return duration in ms. Defaults to parseWav. */
  parseWavDurationMs?: (buf: Buffer) => number;
  /** Assemble takes into a dub track. Defaults to assembleDubTrack. */
  assembleTakes?: (takes: readonly DubTake[], totalMs: number) => Promise<Buffer>;
  /** Replace audio in video. Defaults to replaceAudio. */
  replaceVideoAudio?: (video: Buffer, audio: Buffer) => Promise<Buffer>;
  /** Burn subtitles into video. Defaults to burnSubtitles. */
  burnCues?: (input: BurnSubtitlesInput) => Promise<Buffer>;
}

/**
 * Dub a source video with a pre-approved, fully timed localized track.
 *
 * Pipeline:
 * 1. Speak every cue independently using the EXACT approved text (never
 *    rephrased, split, or reordered).
 * 2. Parse each WAV to measure actual duration in ms.
 * 3. planAudioFit against each locked cue slot (startMs…endMs).
 * 4. If any cue still overruns after the 8% tempo cap, throw CueOverrunError.
 * 5. Assemble all takes onto one dub track.
 * 6. Replace the source video's audio with the dub track.
 * 7. Burn the cues as libass subtitles.
 *
 * @param video   Source video bytes.
 * @param track   Pre-approved localized track (locale, voice, cues).
 * @param deps    Injectable deps for testing.
 * @returns       The dubbed and subtitled MP4 bytes.
 */
export async function orchestrateLocalizedDub(
  video: Buffer,
  track: {
    locale: TargetLocale;
    voice: NarrationVoice;
    cues: readonly ApprovedDubCue[];
  },
  deps: DubOrchestrationDeps = {},
): Promise<Buffer> {
  const probeSourceDuration = deps.probeSourceDurationMs ?? probeSourceVideoDurationMs;
  const speakFn = deps.speakCue ?? ((text, voice) => speakIndicCue(text, voice));
  const parseDurationMs =
    deps.parseWavDurationMs ?? ((buf: Buffer) => parseWav(buf).durationSec * 1000);
  const assembleFn = deps.assembleTakes ?? assembleDubTrack;
  const replaceAudioFn = deps.replaceVideoAudio ?? replaceAudio;
  const burnFn = deps.burnCues ?? burnSubtitles;

  const lastCue = track.cues[track.cues.length - 1]!;
  const sourceDurationMs = await probeSourceDuration(video);
  if (!Number.isFinite(sourceDurationMs) || sourceDurationMs <= 0) {
    throw new LocalizedDubInputError(
      "The source video could not be read. Please upload a valid MP4, MOV, or WebM video.",
    );
  }
  // A small tolerance covers container rounding without allowing a track from
  // a different cut to trigger TTS or a long encode.
  if (lastCue.endMs > sourceDurationMs + 250) {
    throw new LocalizedDubInputError(
      `Cue ${lastCue.index} ends after the source video. ` +
        "Upload the matching source cut or localize the video again.",
    );
  }

  const takes: DubTake[] = [];
  for (const cue of track.cues) {
    const slotMs = cue.endMs - cue.startMs;
    // Speak the EXACT approved text — never rephrase or split.
    const wavBytes = await speakFn(cue.text, track.voice);
    const actualMs = parseDurationMs(wavBytes);
    if (!Number.isFinite(actualMs) || actualMs <= 0) {
      throw new VideoGenProviderError("Text-to-speech returned empty audio.");
    }
    const fit = planAudioFit(actualMs, slotMs);
    if (fit.overrunMs > 0) {
      throw new CueOverrunError(cue.index, fit.overrunMs);
    }
    takes.push({
      index: cue.index,
      startMs: cue.startMs,
      audio: wavBytes,
      tempo: fit.tempo,
    });
  }

  // Total track length runs to the end of the last cue.
  const totalMs = lastCue.endMs;

  const dubTrack = await assembleFn(takes, totalMs);
  const dubbed = await replaceAudioFn(video, dubTrack);

  // Map approved cues to the SubtitleCue shape expected by burnSubtitles.
  const subtitleCues: SubtitleCue[] = track.cues.map((c) => ({
    index: c.index,
    startMs: c.startMs,
    endMs: c.endMs,
    text: c.text,
  }));

  return burnFn({ video: dubbed, cues: subtitleCues, locale: track.locale });
}
