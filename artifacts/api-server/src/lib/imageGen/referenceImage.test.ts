import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateWithSeedream, SEEDREAM_MODEL } from "./providers/seedream";
import { generateWithGemini, GEMINI_IMAGE_MODEL } from "./providers/gemini";
import { getImageGenProviderDef, IMAGE_GEN_PROVIDERS } from "./index";
import type { ReferenceImage } from "./types";

vi.mock("../webFetch", () => ({
  assertPublicHost: vi.fn(async () => {}),
}));

const realFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const reference: ReferenceImage = {
  buffer: Buffer.from("ref-image-bytes"),
  mimeType: "image/png",
};

describe("reference image support", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("marks exactly the image-input-capable providers in the catalog", () => {
    const supports = Object.fromEntries(
      IMAGE_GEN_PROVIDERS.map((p) => [p.id, p.supportsImageInput]),
    );
    expect(supports).toEqual({
      openai: true,
      gemini: true,
      seedream: true,
      openrouter: true,
      bfl: false,
      stability: false,
      replicate: false,
      custom: false,
    });
    expect(getImageGenProviderDef("openai")!.supportsImageInput).toBe(true);
  });

  it("seedream sends the reference image as a data URI and omits it otherwise", async () => {
    const png = Buffer.from("out");
    vi.mocked(globalThis.fetch).mockImplementation(async () =>
      jsonResponse({ data: [{ b64_json: png.toString("base64") }] }),
    );

    await generateWithSeedream(
      { prompt: "p", size: "1024x1024", model: SEEDREAM_MODEL, referenceImage: reference },
      "key",
    );
    let body = JSON.parse(
      (vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.image).toBe(
      `data:image/png;base64,${reference.buffer.toString("base64")}`,
    );

    await generateWithSeedream({ prompt: "p", size: "1024x1024", model: SEEDREAM_MODEL }, "key");
    body = JSON.parse(
      (vi.mocked(globalThis.fetch).mock.calls[1][1] as RequestInit).body as string,
    );
    expect(body.image).toBeUndefined();
  });

  it("gemini sends the reference image as an inlineData part before the prompt", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async () =>
      jsonResponse({
        candidates: [
          {
            content: {
              parts: [{ inlineData: { data: Buffer.from("out").toString("base64") } }],
            },
          },
        ],
      }),
    );

    await generateWithGemini(
      { prompt: "make it pop", size: "1024x1024", model: GEMINI_IMAGE_MODEL, referenceImage: reference },
      "key",
    );
    const body = JSON.parse(
      (vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit).body as string,
    );
    const parts = body.contents[0].parts;
    expect(parts).toHaveLength(2);
    expect(parts[0].inlineData).toEqual({
      mimeType: "image/png",
      data: reference.buffer.toString("base64"),
    });
    expect(parts[1]).toEqual({ text: "make it pop" });

    await generateWithGemini(
      { prompt: "make it pop", size: "1024x1024", model: GEMINI_IMAGE_MODEL },
      "key",
    );
    const body2 = JSON.parse(
      (vi.mocked(globalThis.fetch).mock.calls[1][1] as RequestInit).body as string,
    );
    expect(body2.contents[0].parts).toEqual([{ text: "make it pop" }]);
  });
});
