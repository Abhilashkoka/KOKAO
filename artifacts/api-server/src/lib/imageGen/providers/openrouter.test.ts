import { afterEach, describe, expect, it, vi } from "vitest";
import { generateWithOpenRouter } from "./openrouter";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("generateWithOpenRouter", () => {
  it("caps unused text output so image fallback does not request the model maximum", async () => {
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.max_tokens).toBe(1);
      expect(body.modalities).toEqual(["image", "text"]);
      return Response.json({
        choices: [{
          message: {
            images: [{ image_url: { url: "data:image/png;base64,aW1hZ2U=" } }],
          },
        }],
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