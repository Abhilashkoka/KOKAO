import { describe, it, expect } from "vitest";
import {
  higgsfieldRequestBody,
  higgsfieldOutputUrl,
  higgsfieldTerminalState,
} from "./higgsfield";
import type { VideoGenInput } from "../types";

const base: VideoGenInput = {
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

  it("passes the still as a data URI, like the other providers", () => {
    const body = higgsfieldRequestBody({ ...base, image });
    expect(body.image_url).toBe(`data:image/png;base64,${image.buffer.toString("base64")}`);
  });

  it("sends only prompt and image to Kling and Seedance routes", () => {
    // Those paths document prompt plus image and reject unknown parameters,
    // so the Veo enums must not leak onto them.
    const body = higgsfieldRequestBody({
      ...base,
      model: "kling-video/v2.5-turbo/pro/image-to-video",
      image,
    });
    expect(Object.keys(body).sort()).toEqual(["image_url", "prompt"]);
  });

  it("uses first/last frame fields only on the interpolating route", () => {
    const body = higgsfieldRequestBody({
      ...base,
      model: "veo3.1/first-last-frame-to-video",
      image,
      endImage: { buffer: Buffer.from("end"), mimeType: "image/png" },
    });
    expect(body.first_frame_url).toBeTruthy();
    expect(body.last_frame_url).toBeTruthy();
    expect(body.image_url).toBeUndefined();
  });

  it("carries the prompt through", () => {
    expect(String(higgsfieldRequestBody(base).prompt)).toContain("a doctor speaking to camera");
  });
});

describe("higgsfieldTerminalState", () => {
  it("recognises success and failure across the vocabularies these APIs use", () => {
    for (const done of ["completed", "succeeded", "SUCCESS", "finished", "ready"]) {
      expect(higgsfieldTerminalState(done)).toBe("done");
    }
    for (const bad of ["failed", "error", "cancelled", "canceled", "expired"]) {
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