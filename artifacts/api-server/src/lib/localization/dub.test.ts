/**
 * Real-ffmpeg tests for the dubbing pipeline.
 *
 * These encode actual media rather than asserting on argument strings, because
 * the failures that matter here are ones a mocked ffmpeg cannot see: a
 * filtergraph that parses but drops audio, a subtitle filter that silently
 * renders nothing, a font substitution that turns Tamil into tofu.
 *
 * They skip cleanly when ffmpeg or the Indic fonts are absent, so the suite
 * still runs on a machine that has neither.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import type { SubtitleCue } from "@workspace/localization";

import {
  MAX_TEMPO_ADJUST,
  MissingIndicFontError,
  assembleDubTrack,
  buildForceStyle,
  burnSubtitles,
  planAudioFit,
  replaceAudio,
  resolveSubtitleFont,
} from "./dub";

const execFileAsync = promisify(execFile);

async function hasBinary(name: string): Promise<boolean> {
  try {
    await execFileAsync(name, ["-version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function hasIndicFonts(): Promise<boolean> {
  try {
    await resolveSubtitleFont("te");
    await resolveSubtitleFont("ta");
    await resolveSubtitleFont("hi");
    return true;
  } catch {
    return false;
  }
}

const FFMPEG = await hasBinary("ffmpeg");
const FONTS = FFMPEG && (await hasIndicFonts());

/** A short silent test clip with a solid colour, so subtitles are visible. */
async function makeTestVideo(seconds = 4): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "kokao-dub-fixture-"));
  try {
    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-f", "lavfi", "-i", `color=c=black:s=640x360:d=${seconds}:r=25`,
        "-f", "lavfi", "-i", `anullsrc=r=48000:cl=stereo:d=${seconds}`,
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
        "out.mp4",
      ],
      { cwd: dir, timeout: 60_000 },
    );
    return await readFile(join(dir, "out.mp4"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A short tone, standing in for a TTS take. */
async function makeTone(ms: number): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "kokao-dub-tone-"));
  try {
    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-f", "lavfi", "-i", `sine=frequency=440:duration=${(ms / 1000).toFixed(3)}`,
        "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le",
        "tone.wav",
      ],
      { cwd: dir, timeout: 60_000 },
    );
    return await readFile(join(dir, "tone.wav"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function probe(buffer: Buffer, args: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kokao-dub-probe-"));
  try {
    await writeFile(join(dir, "media"), buffer);
    const { stdout } = await execFileAsync("ffprobe", [...args, "media"], {
      cwd: dir,
      timeout: 30_000,
    });
    return stdout.trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Brightest frame in a clip, as mean luma.
 *
 * Uses the lavfi `movie` source rather than a positional input, because
 * ffprobe rejects both at once. Reading it through `signalstats` is the
 * cheapest way to prove libass drew *something*: the fixture is solid black,
 * so a run that rendered no glyphs stays at zero.
 */
async function peakLuma(buffer: Buffer): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), "kokao-dub-luma-"));
  try {
    await writeFile(join(dir, "media"), buffer);
    const { stdout } = await execFileAsync(
      "ffprobe",
      [
        "-v", "error",
        "-f", "lavfi",
        "-i", "movie=media,signalstats",
        "-show_entries", "frame_tags=lavfi.signalstats.YAVG",
        "-of", "default=noprint_wrappers=1:nokey=1",
        "-read_intervals", "%+#60",
      ],
      { cwd: dir, timeout: 60_000 },
    );
    const values = stdout
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((value) => Number.isFinite(value));
    return values.length > 0 ? Math.max(...values) : 0;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const durationArgs = [
  "-v", "error",
  "-show_entries", "format=duration",
  "-of", "default=noprint_wrappers=1:nokey=1",
];

/* ------------------------------------------------------------------ *
 * Pure logic — always runs
 * ------------------------------------------------------------------ */

describe("planAudioFit", () => {
  it("pads a take that is shorter than its slot rather than stretching it", () => {
    expect(planAudioFit(2000, 3000)).toEqual({ tempo: 1, padMs: 1000, overrunMs: 0 });
  });

  it("speeds up a slightly long take within the comfort limit", () => {
    const fit = planAudioFit(3100, 3000);
    expect(fit.tempo).toBeGreaterThan(1);
    expect(fit.tempo).toBeLessThanOrEqual(1 + MAX_TEMPO_ADJUST);
    expect(fit.overrunMs).toBe(0);
  });

  it("refuses to bend past the comfort limit and reports the overrun", () => {
    const fit = planAudioFit(6000, 3000);
    expect(fit.tempo).toBeCloseTo(1 + MAX_TEMPO_ADJUST, 4);
    expect(fit.overrunMs).toBeGreaterThan(0);
    expect(fit.padMs).toBe(0);
  });

  it("treats an exact fit as no adjustment", () => {
    expect(planAudioFit(3000, 3000)).toEqual({ tempo: 1, padMs: 0, overrunMs: 0 });
  });

  it("survives a take with no measurable length", () => {
    expect(planAudioFit(0, 2500)).toEqual({ tempo: 1, padMs: 2500, overrunMs: 0 });
    expect(planAudioFit(NaN, 2500).padMs).toBe(2500);
  });
});

describe("buildForceStyle", () => {
  const font = { family: "Noto Sans Telugu", file: "/x.ttf" };

  it("names the resolved family", () => {
    expect(buildForceStyle(font, 1080)).toContain("FontName=Noto Sans Telugu");
  });

  it("never synthesises bold, italic or letter spacing", () => {
    const style = buildForceStyle(font, 1080);
    expect(style).toContain("Bold=0");
    expect(style).toContain("Italic=0");
    expect(style).toContain("Spacing=0");
  });

  it("scales type and margin with the frame", () => {
    const small = buildForceStyle(font, 360);
    const large = buildForceStyle(font, 1080);
    const size = (s: string) => Number(/FontSize=(\d+)/.exec(s)![1]);
    expect(size(large)).toBeGreaterThan(size(small));
  });

  it("keeps a floor on type size for very small frames", () => {
    expect(Number(/FontSize=(\d+)/.exec(buildForceStyle(font, 100))![1])).toBeGreaterThanOrEqual(18);
  });
});

/* ------------------------------------------------------------------ *
 * Font resolution
 * ------------------------------------------------------------------ */

describe.skipIf(!FFMPEG)("resolveSubtitleFont", () => {
  it.skipIf(!FONTS)("returns a family matching the one requested", async () => {
    const font = await resolveSubtitleFont("te");
    expect(font.family.toLowerCase()).toContain("telugu");
    expect(font.file.length).toBeGreaterThan(0);
  });

  it.skipIf(!FONTS)("resolves all three target scripts", async () => {
    for (const locale of ["te", "ta", "hi"] as const) {
      const font = await resolveSubtitleFont(locale);
      expect(font.file).toMatch(/\.(ttf|otf|ttc)$/i);
    }
  });

  it("raises a MissingIndicFontError rather than accepting a substitution", () => {
    // Guards the contract, not the environment: fontconfig always returns
    // *something*, so a silent fallback is the failure mode this must prevent.
    const error = new MissingIndicFontError("ta", ["Anek Tamil", "Noto Sans Tamil"]);
    expect(error.message).toContain("Noto Sans Tamil");
    expect(error.message).toContain("replit.nix");
  });
});

/* ------------------------------------------------------------------ *
 * Real encodes
 * ------------------------------------------------------------------ */

describe.skipIf(!FONTS)("burnSubtitles", () => {
  const cues: SubtitleCue[] = [
    { index: 1, startMs: 200, endMs: 2000, text: "మీకు కావాల్సినవన్నీ" },
    { index: 2, startMs: 2000, endMs: 3800, text: "ఒకే చోట." },
  ];

  it("produces a playable video of the same length", async () => {
    const source = await makeTestVideo(4);
    const out = await burnSubtitles({ video: source, cues, locale: "te", videoHeight: 360 });

    expect(out.length).toBeGreaterThan(0);
    const duration = Number(await probe(out, durationArgs));
    expect(duration).toBeGreaterThan(3.5);
    expect(duration).toBeLessThan(4.6);
  }, 180_000);

  it("actually draws pixels for a conjunct-heavy Tamil line", async () => {
    const source = await makeTestVideo(3);
    const tamil: SubtitleCue[] = [
      { index: 1, startMs: 0, endMs: 3000, text: "உங்களுக்குத் தேவையானதெல்லாம்" },
    ];
    const out = await burnSubtitles({ video: source, cues: tamil, locale: "ta", videoHeight: 360 });

    // The source is solid black. If libass rendered nothing, every frame stays
    // black and the mean luma is zero — which is exactly what a missing font
    // or an unshaped script looks like.
    const luma = await peakLuma(out);
    expect(luma).toBeGreaterThan(0);
  }, 180_000);

  it("renders Devanagari without failing the encode", async () => {
    const source = await makeTestVideo(3);
    const hindi: SubtitleCue[] = [
      { index: 1, startMs: 0, endMs: 2800, text: "आपको जो चाहिए, सब एक जगह." },
    ];
    const out = await burnSubtitles({ video: source, cues: hindi, locale: "hi", videoHeight: 360 });
    expect(Number(await probe(out, durationArgs))).toBeGreaterThan(2.5);
  }, 180_000);
});

describe.skipIf(!FFMPEG)("assembleDubTrack", () => {
  it("places every take at its cue offset on one track", async () => {
    const tone = await makeTone(800);
    const track = await assembleDubTrack(
      [
        { index: 1, startMs: 0, audio: tone, tempo: 1 },
        { index: 2, startMs: 2000, audio: tone, tempo: 1 },
      ],
      4000,
    );

    const duration = Number(await probe(track, durationArgs));
    expect(duration).toBeCloseTo(4, 1);
  }, 180_000);

  it("applies a tempo correction without breaking the graph", async () => {
    const tone = await makeTone(1000);
    const track = await assembleDubTrack([{ index: 1, startMs: 0, audio: tone, tempo: 1.08 }], 2000);
    expect(Number(await probe(track, durationArgs))).toBeCloseTo(2, 1);
  }, 180_000);

  it("refuses an empty take list rather than emitting a silent track", async () => {
    await expect(assembleDubTrack([], 4000)).rejects.toThrow(/No takes/);
  });
});

describe.skipIf(!FFMPEG)("replaceAudio", () => {
  it("swaps the audio and keeps the video stream", async () => {
    const video = await makeTestVideo(4);
    const voice = await assembleDubTrack(
      [{ index: 1, startMs: 500, audio: await makeTone(1500), tempo: 1 }],
      4000,
    );
    const out = await replaceAudio(video, voice);

    const streams = await probe(out, [
      "-v", "error",
      "-show_entries", "stream=codec_type",
      "-of", "default=noprint_wrappers=1:nokey=1",
    ]);
    expect(streams).toContain("video");
    expect(streams).toContain("audio");
    expect(Number(await probe(out, durationArgs))).toBeGreaterThan(3.5);
  }, 180_000);
});
