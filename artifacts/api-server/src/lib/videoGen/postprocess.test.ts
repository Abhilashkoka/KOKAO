import { describe, it, expect } from "vitest";
import { renderSlideshow } from "./slideshow";
import { normalizeVideo, fitImageToAspect } from "./postprocess";
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
