import { describe, it, expect } from "vitest";
import { renderSlideshow, extractPosterFrame, MAX_SLIDESHOW_IMAGES } from "./slideshow";
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
