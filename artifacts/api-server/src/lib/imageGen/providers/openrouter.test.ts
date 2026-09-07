import { afterEach, describe, expect, it, vi } from "vitest";
import { generateWithOpenRouter } from "./openrouter";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("generateWithOpenRouter", () => {
  it("uses the dedicated Images API with a reference image and reads base64 output", async () => {
    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://openrouter.ai/api/v1/images");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toEqual({
        model: "google/gemini-2.5-flash-image",
        prompt: "A clean medical explainer frame",
        aspect_ratio: "2:3",
        n: 1,
        input_references: [{
          type: "image_url",
          image_url: { url: "data:image/jpeg;base64,cmVmZXJlbmNl" },
        }],
      });
      return Response.json({
        data: [{ b64_json: "aW1hZ2U=", media_type: "image/png" }],
        usage: {
          prompt_tokens: 123,
          completion_tokens: 1290,
        },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await generateWithOpenRouter({
      prompt: "A clean medical explainer frame",
      size: "1024x1536",
      model: "google/gemini-2.5-flash-image",
      referenceImage: {
        buffer: Buffer.from("reference"),
        mimeType: "image/jpeg",
      },
    }, "test-key");

    expect(result.buffer.toString()).toBe("image");
    expect(result.provider).toBe("openrouter");
    expect(result.usage).toEqual({
      inputTokens: 123,
      outputTokens: 1290,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});