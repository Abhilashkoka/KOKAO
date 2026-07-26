import { describe, it, expect } from "vitest";
import { readFile, writeFile, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  renderSlideshow,
  extractPosterFrame,
  buildSlideshowArgs,
  probeDurationSec,
  runFfmpeg,
  MAX_SLIDESHOW_IMAGES,
} from "./slideshow";
import { VideoGenProviderError } from "./types";

/**
 * These tests exercise the REAL system ffmpeg binary (the same one the audio
 * transcription pipeline spawns), so a green run proves the encoder works in
 * this environment, not just that the argument list looks right.
 */

// 1x1 red PNG.
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function isMp4(buffer: Buffer): boolean {
  return buffer.length > 12 && buffer.toString("ascii", 4, 8) === "ftyp";
}

function isPng(buffer: Buffer): boolean {
  return buffer.length > 8 && buffer[0] === 0x89 && buffer.toString("ascii", 1, 4) === "PNG";
}

/** The options ffmpeg applies to the input named `file`: everything between the
 * previous input's filename and this input's own `-i`. */
function inputOptions(args: string[], file: string): string[] {
  const at = args.findIndex((arg, i) => arg === "-i" && args[i + 1] === file);
  expect(at, `no "-i ${file}" in the argument list`).toBeGreaterThan(-1);
  let start = 1; // past the leading "-y"
  for (let i = at - 1; i >= 0; i--) {
    if (args[i] === "-i") {
      start = i + 2;
      break;
    }
  }
  return args.slice(start, at);
}

/** Args from the filtergraph on, i.e. the ones that apply to the output file. */
function outputOptions(args: string[]): string[] {
  return args.slice(args.indexOf("-filter_complex"));
}

/** A real WAV of the given length, via the same ffmpeg the encoder uses. */
async function synthesizeToneWav(seconds: number): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "kokao-tone-"));
  try {
    await runFfmpeg(
      ["-y", "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, "tone.wav"],
      dir,
    );
    return await readFile(join(dir, "tone.wav"));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** A WAV that opens cleanly but whose PCM payload is missing — the RIFF and
 * data-chunk headers with nothing behind them, i.e. what an interrupted upload
 * leaves in storage. ffprobe reports no duration and the demuxer yields no
 * packets. */
async function headerOnlyWav(): Promise<Buffer> {
  const wav = await synthesizeToneWav(1);
  const dataAt = wav.indexOf("data", 0, "ascii");
  expect(dataAt, "synthesized WAV has no data chunk").toBeGreaterThan(-1);
  return wav.subarray(0, dataAt + 8);
}

async function durationOf(video: Buffer): Promise<number | null> {
  const dir = await mkdtemp(join(tmpdir(), "kokao-probe-"));
  try {
    await writeFile(join(dir, "v.mp4"), video);
    return await probeDurationSec("v.mp4", dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

describe("buildSlideshowArgs", () => {
  const base = {
    slideSec: 4,
    width: 1080,
    height: 1920,
    overlayFontFile: null,
    musicDurationSec: null,
  };

  it("pins every still input to the pipeline frame rate", () => {
    // Without -framerate the image demuxer runs at its 25fps default while the
    // filter chain retimes to 30, so each slide is ~17% short and the Ken
    // Burns zoom under-travels by the same fraction.
    const args = buildSlideshowArgs({
      ...base,
      slideNames: ["slide_000.png", "slide_001.jpg"],
      musicSeekSec: null,
    });
    expect(inputOptions(args, "slide_000.png")).toEqual([
      "-framerate",
      "30",
      "-loop",
      "1",
      "-t",
      "4",
    ]);
    expect(inputOptions(args, "slide_001.jpg")).toEqual([
      "-framerate",
      "30",
      "-loop",
      "1",
      "-t",
      "4",
    ]);
  });

  it("loops a short music bed enough to cover the video, without -shortest", () => {
    const args = buildSlideshowArgs({
      ...base,
      slideNames: ["slide_000.png", "slide_001.png"],
      musicSeekSec: 0,
      musicDurationSec: 3,
    });
    // 2 slides x 4s minus one 0.5s crossfade = 7.5s, so a 3s bed needs
    // ceil(7.5/3) = 3 extra plays. -stream_loop is an INPUT option, so it has
    // to precede this input's -i.
    expect(inputOptions(args, "music")).toEqual(["-stream_loop", "3"]);
    // -shortest would re-truncate the video back to one play of the bed.
    expect(args).not.toContain("-shortest");
    const output = outputOptions(args);
    expect(output[output.indexOf("-t") + 1]).toBe("7.500");
  });

  it("never loops a bed whose length ffprobe could not read", () => {
    // An infinitely looped input that decodes to no packets restarts the
    // demuxer forever without ever producing the frame that -t would bound, so
    // the encode runs until FFMPEG_TIMEOUT_MS and the job fails as a timeout.
    const args = buildSlideshowArgs({
      ...base,
      slideNames: ["slide_000.png"],
      musicSeekSec: 0,
      musicDurationSec: null,
    });
    expect(inputOptions(args, "music")).toEqual([]);
    expect(args).not.toContain("-stream_loop");
  });

  it("leaves a bed that already covers the video unlooped, keeping its seek", () => {
    const args = buildSlideshowArgs({
      ...base,
      slideNames: ["slide_000.png"],
      musicSeekSec: 12.5,
      musicDurationSec: 60,
    });
    expect(inputOptions(args, "music")).toEqual(["-ss", "12.500"]);
  });

  it("clamps the slide duration for the inputs and the output bound alike", () => {
    // The stills, the zoom step and -t all have to describe one timeline: a
    // per-input -t of 30s under an output bound computed from the 10s clamp
    // would compose a timeline the encoder then truncates.
    const args = buildSlideshowArgs({
      ...base,
      slideSec: 30,
      slideNames: ["slide_000.png", "slide_001.png", "slide_002.png"],
      musicSeekSec: null,
    });
    expect(inputOptions(args, "slide_000.png")).toEqual([
      "-framerate",
      "30",
      "-loop",
      "1",
      "-t",
      "10",
    ]);
    const output = outputOptions(args);
    expect(output[output.indexOf("-t") + 1]).toBe("29.000");
  });
});

describe("renderSlideshow", () => {
  it("encodes multiple photos into a faststart MP4 with crossfades", async () => {
    const video = await renderSlideshow({
      images: [PNG_1PX, PNG_1PX, PNG_1PX],
      aspectRatio: "1:1",
      slideDurationSec: 1,
    });
    expect(isMp4(video)).toBe(true);
    expect(video.length).toBeGreaterThan(1000);
  }, 120_000);

  it("encodes a single photo (no crossfade chain) with a burned-in caption", async () => {
    const video = await renderSlideshow({
      images: [PNG_1PX],
      aspectRatio: "9:16",
      slideDurationSec: 1,
      overlayText: "Hello: it's a 100% 'test', [ok]",
    });
    expect(isMp4(video)).toBe(true);
  }, 120_000);

  it("clamps the per-slide duration instead of failing on out-of-range values", async () => {
    const video = await renderSlideshow({
      images: [PNG_1PX],
      aspectRatio: "1:1",
      slideDurationSec: 0, // clamped up to the 1s minimum
    });
    expect(isMp4(video)).toBe(true);
  }, 120_000);

  it("runs the full intended length when the music bed is shorter than the video", async () => {
    // -shortest against an unlooped bed truncated the render to the track: a
    // 1s bed under a 5s slideshow produced a 1s file, an 80% drift that the
    // QA gate (25% max) then failed — refunding after the whole render.
    const video = await renderSlideshow({
      images: [PNG_1PX, PNG_1PX, PNG_1PX],
      aspectRatio: "1:1",
      slideDurationSec: 2, // 3 x 2s - 2 x 0.5s crossfade = 5s
      music: await synthesizeToneWav(1),
    });
    expect(isMp4(video)).toBe(true);
    const duration = await durationOf(video);
    expect(duration).not.toBeNull();
    expect(duration!).toBeGreaterThan(4.9);
    expect(duration!).toBeLessThan(5.1);
  }, 180_000);

  it("finishes on a music file that opens but decodes to nothing", async () => {
    // A truncated upload is bytes the tenant chose from their library, and
    // /ai/generate-video validates musicPath by object-key prefix only. Under
    // an infinite -stream_loop this render never terminated; the timeout is
    // deliberately far below FFMPEG_TIMEOUT_MS so a regression shows up as a
    // failing test in seconds rather than a five-minute stall.
    const video = await renderSlideshow({
      images: [PNG_1PX, PNG_1PX, PNG_1PX],
      aspectRatio: "1:1",
      slideDurationSec: 2,
      music: await headerOnlyWav(),
    });
    expect(isMp4(video)).toBe(true);
    // The slideshow still runs its full length — it simply has no music.
    const duration = await durationOf(video);
    expect(duration).not.toBeNull();
    expect(duration!).toBeGreaterThan(4.9);
    expect(duration!).toBeLessThan(5.1);
  }, 60_000);

  it("lands on the expected duration rather than 25/30ths of it", async () => {
    // The 25fps image-demuxer default cost every still ~17%: this render came
    // out at 4.67s instead of 5s — inside the drift gate, so it shipped short.
    const video = await renderSlideshow({
      images: [PNG_1PX, PNG_1PX, PNG_1PX],
      aspectRatio: "1:1",
      slideDurationSec: 2,
    });
    const duration = await durationOf(video);
    expect(duration).not.toBeNull();
    expect(duration!).toBeGreaterThan(4.9);
    expect(duration!).toBeLessThan(5.1);
  }, 180_000);

  it("rejects an empty or oversized photo set without spawning ffmpeg", async () => {
    await expect(
      renderSlideshow({ images: [], aspectRatio: "1:1", slideDurationSec: 3 }),
    ).rejects.toBeInstanceOf(VideoGenProviderError);
    await expect(
      renderSlideshow({
        images: Array.from({ length: MAX_SLIDESHOW_IMAGES + 1 }, () => PNG_1PX),
        aspectRatio: "1:1",
        slideDurationSec: 3,
      }),
    ).rejects.toBeInstanceOf(VideoGenProviderError);
  });
});

describe("extractPosterFrame", () => {
  it("pulls a PNG poster from an encoded video", async () => {
    const video = await renderSlideshow({
      images: [PNG_1PX, PNG_1PX],
      aspectRatio: "16:9",
      slideDurationSec: 1,
    });
    const poster = await extractPosterFrame(video);
    expect(isPng(poster)).toBe(true);
  }, 120_000);
});
