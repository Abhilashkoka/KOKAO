// The Replicate input builder must map the start photo to each model
// family's own field name. A wrong field name is NOT an error — the model
// silently generates from text alone and the uploaded subject never appears
// (this actually happened with alibaba/happyhorse, which wants `images: []`).
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateWithReplicate } from "./providers/replicate";

const PNG = Buffer.from("fakepng");
const DATA_URI = `data:image/png;base64,${PNG.toString("base64")}`;

function mockReplicate(): { bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/predictions")) {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({ id: "p1", status: "succeeded", output: "https://x/video.mp4" }),
          { status: 201 },
        );
      }
      // Video download.
      return new Response(Buffer.from("video-bytes"), { status: 200 });
    }),
  );
  return { bodies };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function inputFor(model: string): Promise<Record<string, unknown>> {
  const { bodies } = mockReplicate();
  await generateWithReplicate(
    {
      prompt: "animate the man",
      aspectRatio: "9:16",
      durationSec: 10,
      model,
      image: { buffer: PNG, mimeType: "image/png" },
    },
    "test-key",
  );
  return (bodies[0] as { input: Record<string, unknown> }).input;
}

describe("replicate buildInput photo mapping", () => {
  it("happyhorse gets the photo as an images ARRAY plus bounded duration", async () => {
    const input = await inputFor("alibaba/happyhorse-1.1");
    expect(input.images).toEqual([DATA_URI]);
    expect(input.image).toBeUndefined();
    expect(input.duration).toBe(10);
    expect(input.aspect_ratio).toBe("9:16");
  });

  it("minimax gets first_frame_image", async () => {
    const input = await inputFor("minimax/video-01");
    expect(input.first_frame_image).toBe(DATA_URI);
  });

  it("kling gets start_image", async () => {
    const input = await inputFor("kwaivgi/kling-v2.1-standard");
    expect(input.start_image).toBe(DATA_URI);
  });

  it("wan (and unknown models) get image", async () => {
    const input = await inputFor("wan-video/wan-2.2-i2v-fast");
    expect(input.image).toBe(DATA_URI);
  });

  // Every curated image-to-video catalog model must carry the photo under a
  // field its live Replicate schema accepts (verified 2026-07-26). A model
  // whose family mapping is missing would silently animate from text alone.
  const CATALOG_PHOTO_FIELD: Record<string, string> = {
    "wan-video/wan-2.2-i2v-fast": "image",
    "wan-video/wan-2.5-i2v": "image",
    "minimax/video-01": "first_frame_image",
    "minimax/hailuo-02": "first_frame_image",
    "kwaivgi/kling-v2.1-standard": "start_image",
    "kwaivgi/kling-v2.1-master": "start_image",
    "google/veo-3.1": "image",
    "bytedance/seedance-1-pro": "image",
    "alibaba/happyhorse-1.1": "images",
  };

  it("every catalog i2v model carries the photo under its schema's field", async () => {
    for (const [model, field] of Object.entries(CATALOG_PHOTO_FIELD)) {
      const input = await inputFor(model);
      const value = input[field];
      expect(
        value === DATA_URI || (Array.isArray(value) && value[0] === DATA_URI),
        `${model} must send the photo as "${field}"`,
      ).toBe(true);
    }
  });
});

describe("replicate failed prediction diagnostics", () => {
  it("retains the prediction id and marks ordinary model failures transient", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({
        id: "pred_failed_123",
        status: "failed",
        error: "The model worker exited unexpectedly.",
      }), { status: 201, headers: { "Content-Type": "application/json" } })
    ));

    await expect(generateWithReplicate({
      model: "wan-video/wan-2.2-i2v-fast",
      prompt: "A presenter speaking",
      aspectRatio: "9:16",
      durationSec: 5,
      image: { buffer: Buffer.from("image"), mimeType: "image/png" },
    }, "test-key")).rejects.toMatchObject({
      status: 503,
      requestId: "pred_failed_123",
      provider: "replicate",
      model: "wan-video/wan-2.2-i2v-fast",
    });
  });

  it("keeps content-policy prediction failures terminal", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({
        id: "pred_rejected_456",
        status: "failed",
        error: "Input failed safety moderation.",
      }), { status: 201, headers: { "Content-Type": "application/json" } })
    ));

    await expect(generateWithReplicate({
      model: "wan-video/wan-2.2-i2v-fast",
      prompt: "A presenter speaking",
      aspectRatio: "9:16",
      durationSec: 5,
      image: { buffer: Buffer.from("image"), mimeType: "image/png" },
    }, "test-key")).rejects.toMatchObject({
      status: 422,
      requestId: "pred_rejected_456",
    });
  });
});
