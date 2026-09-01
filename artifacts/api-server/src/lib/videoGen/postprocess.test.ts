import { describe, it, expect } from "vitest";
import { renderSlideshow, probeDurationSec, runFfmpeg } from "./slideshow";
import { probeHeight } from "./lipSyncSource";
import { mkdtemp, writeFile, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { normalizeVideo, fitImageToAspect, trimClipToStart } from "./postprocess";
import { withRetries, withTimeout } from "./retry";
import { VideoGenProviderError } from "./types";

// 1x1 red PNG.
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function isMp4(buffer: Buffer): boolean {
  return buffer.length > 12 && buffer.toString("ascii", 4, 8) === "ftyp";
}

describe("normalizeVideo", () => {
  it("re-frames a clip to the requested aspect with real ffmpeg", async () => {
    // Render a small 1:1 clip, then normalize it to 9:16 — mimicking a
    // provider that ignored the requested aspect ratio.
    const square = await renderSlideshow({
      images: [PNG_1PX],
      aspectRatio: "1:1",
      slideDurationSec: 1,
    });
    const portrait = await normalizeVideo(square, "9:16");
    expect(isMp4(portrait)).toBe(true);
    // A real transcode happened (not the fail-soft passthrough).
    expect(portrait.equals(square)).toBe(false);
  }, 180_000);

  it("fails soft: garbage input returns the original buffer untouched", async () => {
    const garbage = Buffer.from("definitely not a video");
    const out = await normalizeVideo(garbage, "9:16");
    expect(out.equals(garbage)).toBe(true);
  }, 60_000);
});

describe("fitImageToAspect", () => {
  it("pads a photo into the target frame as a JPEG with real ffmpeg", async () => {
    const fitted = await fitImageToAspect({ buffer: PNG_1PX, mimeType: "image/png" }, "9:16");
    // A real fit happened (not the fail-soft passthrough): JPEG out.
    expect(fitted.mimeType).toBe("image/jpeg");
    expect(fitted.buffer.length).toBeGreaterThan(2);
    expect(fitted.buffer[0]).toBe(0xff);
    expect(fitted.buffer[1]).toBe(0xd8);
  }, 60_000);

  it("fails soft: garbage input returns the original image untouched", async () => {
    const garbage = { buffer: Buffer.from("not an image"), mimeType: "image/png" };
    const out = await fitImageToAspect(garbage, "9:16");
    expect(out.buffer.equals(garbage.buffer)).toBe(true);
    expect(out.mimeType).toBe("image/png");
  }, 60_000);
});

describe("retry helpers", () => {
  it("retries transient provider errors and succeeds", async () => {
    let calls = 0;
    const result = await withRetries(
      async () => {
        calls += 1;
        if (calls < 3) throw new VideoGenProviderError("busy", 429);
        return "ok";
      },
      { attempts: 3, baseDelayMs: 1 },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("does not retry permanent provider rejections", async () => {
    let calls = 0;
    await expect(
      withRetries(
        async () => {
          calls += 1;
          throw new VideoGenProviderError("bad prompt", 422);
        },
        { attempts: 3, baseDelayMs: 1 },
      ),
    ).rejects.toBeInstanceOf(VideoGenProviderError);
    expect(calls).toBe(1);
  });

  it("withTimeout rejects a hung call instead of stalling forever", async () => {
    await expect(
      withTimeout(() => new Promise(() => {}), 50, "Test"),
    ).rejects.toBeInstanceOf(VideoGenProviderError);
  });
});

describe("trimClipToStart", () => {
  it("cuts a long clip to exactly the shot length, from the beginning", async () => {
    const clip = await renderSlideshow({
      images: [PNG_1PX],
      aspectRatio: "16:9",
      slideDurationSec: 5,
    });
    const trimmed = await trimClipToStart(clip, 3.2);
    expect(isMp4(trimmed)).toBe(true);
    const dir = await mkdtemp(join(tmpdir(), "kokao-trim-test-"));
    try {
      await writeFile(join(dir, "t.mp4"), trimmed);
      const durationSec = await probeDurationSec("t.mp4", dir);
      // No tolerance window here: a lip-sync model assumes video and audio
      // start together, so the length has to be right, not close.
      expect(Math.abs(durationSec! - 3.2)).toBeLessThan(0.12);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }, 180_000);

  it("holds the last frame when the clip is shorter than the shot", async () => {
    const clip = await renderSlideshow({
      images: [PNG_1PX],
      aspectRatio: "16:9",
      slideDurationSec: 2,
    });
    const trimmed = await trimClipToStart(clip, 3);
    const dir = await mkdtemp(join(tmpdir(), "kokao-trim-test-"));
    try {
      await writeFile(join(dir, "t.mp4"), trimmed);
      const durationSec = await probeDurationSec("t.mp4", dir);
      expect(Math.abs(durationSec! - 3)).toBeLessThan(0.15);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }, 180_000);

  it("refuses a nonsense length instead of shipping a desynced shot", async () => {
    await expect(trimClipToStart(Buffer.from("x"), 0)).rejects.toBeInstanceOf(
      VideoGenProviderError,
    );
  });
});

describe("trimClipToStart face-pixel floor", () => {
  it("upscales a shot too small for the lip-sync model's face crop", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kokao-small-shot-"));
    try {
      // 360p, the shape an image-to-video provider can return.
      await runFfmpeg(
        [
          "-y", "-f", "lavfi", "-i", "testsrc=s=640x360:r=30:d=3",
          "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
          "small.mp4",
        ],
        dir,
      );
      const small = await readFile(join(dir, "small.mp4"));

      const raised = await trimClipToStart(small, 2, 720);
      await writeFile(join(dir, "raised.mp4"), raised);
      expect(await probeHeight("raised.mp4", dir)).toBe(720);
      // The length contract still holds — the upscale rides the same encode.
      const durationSec = await probeDurationSec("raised.mp4", dir);
      expect(Math.abs(durationSec! - 2)).toBeLessThan(0.12);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }, 180_000);

  it("never blows a shot up by more than 2x", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kokao-tiny-shot-"));
    try {
      await runFfmpeg(
        [
          "-y", "-f", "lavfi", "-i", "testsrc=s=256x144:r=30:d=3",
          "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
          "tiny.mp4",
        ],
        dir,
      );
      const raised = await trimClipToStart(await readFile(join(dir, "tiny.mp4")), 2, 720);
      await writeFile(join(dir, "raised.mp4"), raised);
      // 144 * 2, not 720: past 2x we would be inventing pixels.
      expect(await probeHeight("raised.mp4", dir)).toBe(288);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }, 180_000);

  it("leaves a shot that already clears the floor alone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kokao-big-shot-"));
    try {
      await runFfmpeg(
        [
          "-y", "-f", "lavfi", "-i", "testsrc=s=1280x720:r=30:d=3",
          "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
          "big.mp4",
        ],
        dir,
      );
      const out = await trimClipToStart(await readFile(join(dir, "big.mp4")), 2, 720);
      await writeFile(join(dir, "out.mp4"), out);
      expect(await probeHeight("out.mp4", dir)).toBe(720);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }, 180_000);
});
