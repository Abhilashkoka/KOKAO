import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("../../webFetch", () => ({
  assertPublicHost: vi.fn(async () => {}),
}));

import {
  generateWithHiggsfield,
  higgsfieldRequestBody,
  higgsfieldOutputUrl,
  higgsfieldTerminalState,
} from "./higgsfield";
import type { VideoGenInput } from "../types";

const base: VideoGenInput = {
  meterContext: null,
  prompt: "a doctor speaking to camera",
  aspectRatio: "9:16",
  durationSec: 5,
  model: "veo3.1/fast/image-to-video",
};
const image = { buffer: Buffer.from("png-bytes"), mimeType: "image/png" as const };

describe("higgsfieldRequestBody", () => {
  it("snaps duration to a value Veo actually accepts", () => {
    // The API documents duration as the enum "4" | "6" | "8", as STRINGS.
    // A 5-second scene sent verbatim is a 400 after the user has waited, so
    // it snaps to the nearest and the compositor trims the clip to the scene
    // exactly as it already does for every other provider.
    expect(higgsfieldRequestBody({ ...base, durationSec: 5 }).duration).toBe("4");
    expect(higgsfieldRequestBody({ ...base, durationSec: 7 }).duration).toBe("6");
    expect(higgsfieldRequestBody({ ...base, durationSec: 30 }).duration).toBe("8");
    expect(higgsfieldRequestBody({ ...base, durationSec: 0.5 }).duration).toBe("4");
  });

  it("maps every aspect onto the two orientations Veo offers", () => {
    // Only 16:9 and 9:16 are documented. A 4:5 or 1:1 job must still run, so
    // it takes the nearest orientation and the compositor crops to the real
    // shape — the same accommodation other partial providers get.
    expect(higgsfieldRequestBody({ ...base, aspectRatio: "9:16" }).aspect_ratio).toBe("9:16");
    expect(higgsfieldRequestBody({ ...base, aspectRatio: "4:5" }).aspect_ratio).toBe("9:16");
    expect(higgsfieldRequestBody({ ...base, aspectRatio: "1:1" }).aspect_ratio).toBe("9:16");
    expect(higgsfieldRequestBody({ ...base, aspectRatio: "16:9" }).aspect_ratio).toBe("16:9");
    expect(higgsfieldRequestBody({ ...base, aspectRatio: "21:9" }).aspect_ratio).toBe("16:9");
  });

  it("keeps audio off unless it was asked for", () => {
    // The compositor mixes its own narration, music and ducking. A clip that
    // arrives carrying dialogue collides with all of it, so audio is opt-in
    // and never inherited from a default.
    expect(higgsfieldRequestBody(base).generate_audio).toBe(false);
    expect(higgsfieldRequestBody({ ...base, generateAudio: null }).generate_audio).toBe(false);
    expect(higgsfieldRequestBody({ ...base, generateAudio: true }).generate_audio).toBe(true);
  });

  it("uses the already-uploaded public URL rather than embedding image bytes", () => {
    const body = higgsfieldRequestBody({ ...base, image }, "https://files.hf.ai/still.png");
    expect(body.image_url).toBe("https://files.hf.ai/still.png");
    expect(JSON.stringify(body)).not.toContain("data:image");
  });

  it("sends only prompt and image to Kling and Seedance routes", () => {
    // Those paths document prompt plus image and reject unknown parameters,
    // so the Veo enums must not leak onto them.
    const body = higgsfieldRequestBody({
      ...base,
      model: "kling-video/v2.5-turbo/pro/image-to-video",
      image,
    }, "https://files.hf.ai/still.png");
    expect(Object.keys(body).sort()).toEqual(["image_url", "prompt"]);
  });

  it("uses first/last frame fields only on the interpolating route", () => {
    const body = higgsfieldRequestBody({
      ...base,
      model: "veo3.1/first-last-frame-to-video",
      image,
      endImage: { buffer: Buffer.from("end"), mimeType: "image/png" },
    }, "https://files.hf.ai/start.png", "https://files.hf.ai/end.png");
    expect(body.first_frame_url).toBe("https://files.hf.ai/start.png");
    expect(body.last_frame_url).toBe("https://files.hf.ai/end.png");
    expect(body.image_url).toBeUndefined();
  });

  it("carries the prompt through", () => {
    expect(String(higgsfieldRequestBody(base).prompt)).toContain("a doctor speaking to camera");
  });
});

describe("Higgsfield file uploads", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requests an upload URL, PUTs the raw bytes with only signed headers, then submits its public URL", async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/files/generate-upload-url")) {
        return new Response(JSON.stringify({
          public_url: "https://files.hf.ai/still.png",
          upload_url: "https://upload.hf.ai/still",
          upload_headers: { "x-upload-token": "signed", "Content-Type": "image/png" },
        }), { status: 200 });
      }
      if (url === "https://upload.hf.ai/still") return new Response(null, { status: 200 });
      if (url.endsWith("/veo3.1/fast/image-to-video")) {
        return new Response(JSON.stringify({
          id: "job-1", status: "completed", output: { url: "https://cdn.hf.ai/final.mp4" },
        }), { status: 200 });
      }
      if (url === "https://cdn.hf.ai/final.mp4") return new Response("video", { status: 200 });
      throw new Error(`unexpected URL ${url}`);
    });
    vi.stubGlobal("fetch", fetch);

    await generateWithHiggsfield({ ...base, image }, "key-id:key-secret");

    expect(fetch.mock.calls).toHaveLength(4);
    expect(fetch.mock.calls[0]![0]).toBe("https://api.higgsfield.ai/files/generate-upload-url");
    expect(fetch.mock.calls[0]![1]).toMatchObject({
      method: "POST",
      headers: { Authorization: "Key key-id:key-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ content_type: "image/png" }),
    });
    expect(fetch.mock.calls[1]![0]).toBe("https://upload.hf.ai/still");
    expect(fetch.mock.calls[1]![1]).toMatchObject({
      method: "PUT",
      body: image.buffer,
    });
    expect(fetch.mock.calls[1]![1]?.headers).toEqual({
      "x-upload-token": "signed",
      "Content-Type": "image/png",
    });
    const submit = JSON.parse(String(fetch.mock.calls[2]![1]?.body));
    expect(submit.image_url).toBe("https://files.hf.ai/still.png");
    expect(JSON.stringify(submit)).not.toContain("data:");
  });

  it("uploads each first/last frame and sends both resulting public URLs", async () => {
    let uploads = 0;
    const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith("/files/generate-upload-url")) {
        uploads += 1;
        return new Response(JSON.stringify({
          public_url: `https://files.hf.ai/${uploads}.png`,
          upload_url: `https://upload.hf.ai/${uploads}`,
          upload_headers: { "x-upload-token": `signed-${uploads}` },
        }));
      }
      if (url.startsWith("https://upload.hf.ai/")) return new Response(null);
      if (url.endsWith("/veo3.1/first-last-frame-to-video")) {
        return new Response(JSON.stringify({
          id: "job-1", status: "completed", output: { url: "https://cdn.hf.ai/final.mp4" },
        }));
      }
      if (url === "https://cdn.hf.ai/final.mp4") return new Response("video");
      throw new Error(`unexpected URL ${url}`);
    });
    vi.stubGlobal("fetch", fetch);

    await generateWithHiggsfield({
      ...base, model: "veo3.1/first-last-frame-to-video", image,
      endImage: { buffer: Buffer.from("end"), mimeType: "image/png" },
    }, "key-id:key-secret");

    const submit = JSON.parse(String(fetch.mock.calls[4]![1]?.body));
    expect(submit).toMatchObject({
      first_frame_url: "https://files.hf.ai/1.png",
      last_frame_url: "https://files.hf.ai/2.png",
    });
    expect(submit.image_url).toBeUndefined();
  });

  it("fails safely when Higgsfield returns an invalid upload target", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ public_url: "not-a-url" })));
    vi.stubGlobal("fetch", fetch);

    await expect(generateWithHiggsfield({ ...base, image }, "key-id:key-secret"))
      .rejects.toMatchObject({ name: "VideoGenProviderError", status: 502 });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe("higgsfieldTerminalState", () => {
  it("recognises success and failure across the vocabularies these APIs use", () => {
    for (const done of ["completed", "succeeded", "SUCCESS", "finished", "ready"]) {
      expect(higgsfieldTerminalState(done)).toBe("done");
    }
    for (const bad of ["failed", "error", "nsfw", "cancelled", "canceled", "expired"]) {
      expect(higgsfieldTerminalState(bad)).toBe("failed");
    }
  });

  it("keeps polling on anything it does not recognise", () => {
    // Treating an unknown status as terminal would abandon a job that is
    // still running and still being billed. Unknown means keep waiting; the
    // overall deadline is what stops the loop.
    for (const pending of ["queued", "in_progress", "starting", "", undefined, "weird"]) {
      expect(higgsfieldTerminalState(pending)).toBeNull();
    }
  });
});

describe("higgsfieldOutputUrl", () => {
  // Higgsfield's published OpenAPI truncates the RequestStatus schema, so the
  // nesting of the output URL is not documented. Guessing one path and being
  // slightly wrong would report "no video URL" on a job that succeeded and was
  // billed — so this searches instead of assuming.
  it("finds the URL wherever the response nests it", () => {
    const shapes: unknown[] = [
      { url: "https://cdn.hf.ai/a.mp4" },
      { output: { url: "https://cdn.hf.ai/a.mp4" } },
      { result: { video_url: "https://cdn.hf.ai/a.mp4" } },
      { results: [{ raw_url: "https://cdn.hf.ai/a.mp4" }] },
      { output: [{ files: [{ file_url: "https://cdn.hf.ai/a.mp4" }] }] },
    ];
    for (const shape of shapes) {
      expect(higgsfieldOutputUrl(shape)).toBe("https://cdn.hf.ai/a.mp4");
    }
  });

  it("ignores URLs that are not video files", () => {
    // A status payload carries its own status and cancel URLs. Downloading one
    // of those would hand the pipeline a JSON body named like a video.
    const status = {
      status_url: "https://api.higgsfield.ai/requests/abc/status",
      cancel_url: "https://api.higgsfield.ai/requests/abc/cancel",
      preview: "https://cdn.hf.ai/thumb.jpg",
      output: { url: "https://cdn.hf.ai/final.mp4" },
    };
    expect(higgsfieldOutputUrl(status)).toBe("https://cdn.hf.ai/final.mp4");
  });

  it("returns null rather than something unusable", () => {
    expect(higgsfieldOutputUrl({ status: "completed" })).toBeNull();
    expect(higgsfieldOutputUrl(null)).toBeNull();
    expect(higgsfieldOutputUrl({ url: "not-a-url" })).toBeNull();
  });

  it("cannot be sent into a loop by a self-referencing payload", () => {
    const cyclic: Record<string, unknown> = { status: "completed" };
    cyclic.self = cyclic;
    expect(() => higgsfieldOutputUrl(cyclic)).not.toThrow();
  });
});