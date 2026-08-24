import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { concatClips, mixMusicIntoVideo } from "./postprocess";
import { encodeBudgetMs, runFfmpeg } from "./slideshow";
import { probeDurationSec } from "./slideshow";
import { VideoGenProviderError } from "./types";

const execFileAsync = promisify(execFile);
const familyKey = (value: string) => value.split(",")[0]!.trim().toLowerCase();

export class MissingCharacterDialogueFontError extends VideoGenProviderError {
  constructor(candidates: readonly string[]) {
    super(`No required subtitle font is installed. Install one of: ${candidates.join(", ")}.`);
    this.name = "MissingCharacterDialogueFontError";
  }
}

/** Reject fontconfig substitution: it otherwise turns unsupported scripts into tofu. */
export async function resolveExactFont(candidates: readonly string[]): Promise<{ family: string; file: string }> {
  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync("fc-match", ["-f", "%{family}|%{file}", candidate], { timeout: 5_000 });
      const [family, file] = stdout.split("|");
      if (family && file && familyKey(family) === familyKey(candidate)) {
        return { family: candidate, file: file.trim() };
      }
    } catch {
      break;
    }
  }
  throw new MissingCharacterDialogueFontError(candidates);
}

const timestamp = (seconds: number) => {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
};

export async function composeCharacterDialogue(input: {
  clips: Buffer[];
  scenes: Array<{ text: string; narrationDurationSec: number }>;
  fontCandidates: string[];
  direction: "ltr" | "rtl";
  music?: Buffer | null;
}): Promise<{ buffer: Buffer; durationSec: number }> {
  if (!input.clips.length || input.clips.length !== input.scenes.length) {
    throw new VideoGenProviderError("Character dialogue scene clips are incomplete.");
  }
  const font = await resolveExactFont(input.fontCandidates);
  const joined = await concatClips(input.clips);
  const durationSec = input.scenes.reduce((sum, scene) => sum + scene.narrationDurationSec, 0);
  const dir = await mkdtemp(join(tmpdir(), "kokao-character-dialogue-"));
  try {
    await writeFile(join(dir, "in.mp4"), joined);
    let start = 0;
    const srt = input.scenes.map((scene, index) => {
      const end = start + scene.narrationDurationSec;
      // libass shapes complex scripts and applies bidi. textfile/SRT also avoids shell escaping.
      const alignment = input.direction === "rtl" ? "{\\an2}" : "{\\an2}";
      const item = `${index + 1}\n${timestamp(start)} --> ${timestamp(end)}\n${alignment}${scene.text}\n`;
      start = end;
      return item;
    }).join("\n");
    await writeFile(join(dir, "captions.srt"), srt);
    const escapedFont = font.file.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
    await runFfmpeg([
      "-y", "-i", "in.mp4", "-vf",
      `subtitles=captions.srt:fontsdir=${escapedFont.substring(0, escapedFont.lastIndexOf("/"))}:force_style='FontName=${font.family},FontSize=24,Outline=2,Alignment=2'`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-movflags", "+faststart", "subtitled.mp4",
    ], dir, encodeBudgetMs(durationSec));
    const subtitled = await readFile(join(dir, "subtitled.mp4"));
    return { buffer: input.music ? await mixMusicIntoVideo(subtitled, input.music) : subtitled, durationSec };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Measure provider PCM/WAV output; estimates must never drive billing or timing. */
export async function probeNarrationWavDurationSec(wav: Buffer): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), "kokao-narration-probe-"));
  try {
    await writeFile(join(dir, "narration.wav"), wav);
    const duration = await probeDurationSec("narration.wav", dir);
    if (!duration || duration <= 0) throw new VideoGenProviderError("Generated narration has no measurable duration.");
    return duration;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Character dialogue subtitles use narration-derived offsets, so unlike the
 * general fail-soft clip helper this always re-encodes and verifies the exact
 * timeline before a scene can be checkpointed.
 */
export async function trimCharacterDialogueClipStrict(video: Buffer, targetSec: number): Promise<Buffer> {
  if (!Number.isFinite(targetSec) || targetSec <= 0) {
    throw new VideoGenProviderError("Character dialogue narration has an invalid duration.");
  }
  const dir = await mkdtemp(join(tmpdir(), "kokao-character-dialogue-trim-"));
  try {
    await writeFile(join(dir, "in.mp4"), video);
    await runFfmpeg([
      "-y", "-i", "in.mp4", "-t", targetSec.toFixed(3),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-c:a", "aac", "-movflags", "+faststart", "trimmed.mp4",
    ], dir, encodeBudgetMs(targetSec));
    const durationSec = await probeDurationSec("trimmed.mp4", dir);
    if (!durationSec || Math.abs(durationSec - targetSec) > 0.1) {
      throw new VideoGenProviderError(
        `Character dialogue clip timing drifted from narration (${durationSec?.toFixed(3) ?? "unknown"}s vs ${targetSec.toFixed(3)}s).`,
      );
    }
    return await readFile(join(dir, "trimmed.mp4"));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}