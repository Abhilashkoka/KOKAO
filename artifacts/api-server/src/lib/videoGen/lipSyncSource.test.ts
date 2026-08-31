import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { renderSlideshow, probeDurationSec, runFfmpeg } from "./slideshow";
import {
  prepareLipSyncSource,
  probeHeight,
  MIN_SYNC_HEIGHT,
  MAX_TAIL_HOLD_SEC,
  MIN_USABLE_HEIGHT,
} from "./lipSyncSource";

// 1x1 red PNG — the slideshow renderer scales it to the requested aspect.
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * Build a real clip of roughly `seconds` length to stand in for an upload.
 * `height` shrinks it first, so a test can produce the phone-camera 480p case
 * the renderer would never make on its own.
 */
async function fakeUpload(
  seconds: number,
  height?: number,
): Promise<{ buffer: Buffer; mimeType: string }> {
  let buffer = await renderSlideshow({
    images: [PNG_1PX],
    aspectRatio: "16:9",
    slideDurationSec: seconds,
  });
  if (height) {
    const dir = await mkdtemp(join(tmpdir(), "kokao-shrink-"));
    try {
      await writeFile(join(dir, "big.mp4"), buffer);
      await runFfmpeg(
        [
          "-y", "-i", "big.mp4",
          "-vf", `scale=-2:${height}`,
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
          "-an", "small.mp4",
        ],
        dir,
      );
      buffer = await readFile(join(dir, "small.mp4"));
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  return { buffer, mimeType: "video/mp4" };
}

/** Measure a buffer the way the pipeline does, via a scratch dir. */
async function measure(buffer: Buffer): Promise<{ durationSec: number | null; height: number | null }> {
  const dir = await mkdtemp(join(tmpdir(), "kokao-lipsrc-test-"));
  try {
    await writeFile(join(dir, "m.mp4"), buffer);
    return {
      durationSec: await probeDurationSec("m.mp4", dir),
      height: await probeHeight("m.mp4", dir),
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

describe("prepareLipSyncSource", () => {
  it("trims footage that outruns the narration", async () => {
    const upload = await fakeUpload(4);
    const prepared = await prepareLipSyncSource(upload, 2);
    expect(prepared.fit).toBe("trimmed");
    expect(prepared.excessive).toBe(false);
    const { durationSec } = await measure(prepared.video.buffer);
    expect(durationSec).not.toBeNull();
    expect(Math.abs(durationSec! - 2)).toBeLessThan(0.35);
  }, 180_000);

  it("holds the last frame when the narration runs slightly long", async () => {
    const upload = await fakeUpload(2);
    const prepared = await prepareLipSyncSource(upload, 3.5);
    expect(prepared.fit).toBe("padded");
    expect(prepared.excessive).toBe(false);
    const { durationSec } = await measure(prepared.video.buffer);
    expect(durationSec).not.toBeNull();
    // The whole point: the model now receives video for every second of voice.
    expect(Math.abs(durationSec! - 3.5)).toBeLessThan(0.35);
  }, 180_000);

  it("flags a narration that runs far past the footage instead of freezing on it", async () => {
    const upload = await fakeUpload(2);
    const prepared = await prepareLipSyncSource(upload, 2 + MAX_TAIL_HOLD_SEC + 3);
    expect(prepared.excessive).toBe(true);
    expect(prepared.overrunSec).toBeGreaterThan(MAX_TAIL_HOLD_SEC);
    // Nothing was spent re-encoding a job the caller is about to refuse.
    expect(prepared.video.buffer.equals(upload.buffer)).toBe(true);
  }, 180_000);

  it("upscales a source too small for the model's face crop", async () => {
    // 478p, the shape of the real production sample that came back soft.
    const upload = await fakeUpload(2, 478);
    const before = await measure(upload.buffer);
    expect(before.height).not.toBeNull();
    expect(before.height!).toBeLessThan(MIN_SYNC_HEIGHT);

    const prepared = await prepareLipSyncSource(upload, 2);
    expect(prepared.upscale).toBeGreaterThan(1);
    const after = await measure(prepared.video.buffer);
    expect(after.height!).toBeGreaterThan(before.height!);
  }, 180_000);

  it("leaves a matching, high-enough source untouched", async () => {
    // 1080p and already the right length: nothing to fix, so nothing is spent.
    const upload = await fakeUpload(2);
    const { durationSec, height } = await measure(upload.buffer);
    expect(height!).toBeGreaterThanOrEqual(MIN_SYNC_HEIGHT);
    const prepared = await prepareLipSyncSource(upload, durationSec ?? 2);
    expect(prepared.fit).toBe("exact");
    expect(prepared.upscale).toBe(1);
    expect(prepared.video.buffer.equals(upload.buffer)).toBe(true);
  }, 180_000);

  it("returns the upload untouched when the narration length is unusable", async () => {
    const upload = await fakeUpload(1);
    const prepared = await prepareLipSyncSource(upload, 0);
    expect(prepared.video.buffer.equals(upload.buffer)).toBe(true);
    expect(prepared.fit).toBe("exact");
  }, 60_000);

  it("survives a buffer that is not a video at all", async () => {
    const junk = { buffer: Buffer.from("not a video"), mimeType: "video/mp4" };
    const prepared = await prepareLipSyncSource(junk, 3);
    // Fail-soft: an unprobeable upload is passed through for the model to judge.
    expect(prepared.video.buffer.equals(junk.buffer)).toBe(true);
  }, 60_000);
});

describe("prepareLipSyncSource resolution guard", () => {
  it("flags a source too small to sync at all", async () => {
    const upload = await fakeUpload(2, 144);
    const prepared = await prepareLipSyncSource(upload, 2);
    expect(prepared.tooSmall).toBe(true);
    expect(prepared.height!).toBeLessThan(MIN_USABLE_HEIGHT);
    // Refused before any encode is spent on it.
    expect(prepared.video.buffer.equals(upload.buffer)).toBe(true);
  }, 180_000);

  it("accepts a small-but-workable source and upscales it", async () => {
    const upload = await fakeUpload(2, 360);
    const prepared = await prepareLipSyncSource(upload, 2);
    expect(prepared.tooSmall).toBe(false);
    expect(prepared.upscale).toBeGreaterThan(1);
  }, 180_000);
});
