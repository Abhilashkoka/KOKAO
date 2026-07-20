import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateWithSeedream, SEEDREAM_MODEL } from "./providers/seedream";
import { ImageGenNotConfiguredError, ImageGenProviderError } from "./types";
import { getImageGenProviderDef } from "./index";

vi.mock("../webFetch", () => ({
  assertPublicHost: vi.fn(async (hostname: string) => {
    if (hostname.endsWith(".internal")) throw new Error("blocked host");
  }),
}));

const realFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("seedream provider", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("is registered in the catalog with the ARK key and model options", () => {
    const def = getImageGenProviderDef("seedream");
    expect(def).toBeDefined();
    expect(def!.label).toBe("ByteDance Seedream");
    expect(def!.envKey).toBe("ARK_API_KEY");
    expect(def!.defaultModel).toBe(SEEDREAM_MODEL);
    expect(def!.supportsModelOverride).toBe(true);
    expect(def!.requiresBaseUrl).toBe(false);
    expect(def!.modelOptions?.map((m) => m.value)).toEqual([
      "seedream-5-0-pro",
      "seedream-5-0-260128",
      "seedream-4-5-251128",
      "seedream-4-0",
    ]);
  });

  it("throws a not-configured error without an API key", async () => {
    await expect(
      generateWithSeedream({ prompt: "p", size: "1024x1024", model: SEEDREAM_MODEL }, null),
    ).rejects.toBeInstanceOf(ImageGenNotConfiguredError);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("posts to the ModelArk endpoint with bearer auth, watermark off, and decodes b64", async () => {
    const png = Buffer.from("fake-image-bytes");
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      jsonResponse({ data: [{ b64_json: png.toString("base64") }] }),
    );

    const result = await generateWithSeedream(
      { prompt: "a red bike", size: "1536x1024", model: SEEDREAM_MODEL },
      "ark-key-123",
    );

    expect(result.provider).toBe("seedream");
    expect(result.model).toBe(SEEDREAM_MODEL);
    expect(result.buffer.equals(png)).toBe(true);

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ark.ap-southeast.bytepluses.com/api/v3/images/generations");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer ark-key-123");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      model: SEEDREAM_MODEL,
      prompt: "a red bike",
      size: "1536x1024",
      response_format: "b64_json",
      n: 1,
      watermark: false,
    });
  });

  it("downloads the image when only a hosted https URL is returned", async () => {
    const bytes = Buffer.from("hosted-image");
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ url: "https://ark-content.example.com/img.png" }] }),
      )
      .mockResolvedValueOnce(new Response(bytes, { status: 200 }));

    const result = await generateWithSeedream(
      { prompt: "p", size: "1024x1024", model: "seedream-4-0" },
      "k",
    );
    expect(result.buffer.equals(bytes)).toBe(true);
    expect(vi.mocked(globalThis.fetch).mock.calls[1][0]).toBe(
      "https://ark-content.example.com/img.png",
    );
  });

  it("rejects a non-https image URL without downloading it", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      jsonResponse({ data: [{ url: "http://ark-content.example.com/img.png" }] }),
    );
    await expect(
      generateWithSeedream({ prompt: "p", size: "1024x1024", model: SEEDREAM_MODEL }, "k"),
    ).rejects.toBeInstanceOf(ImageGenProviderError);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });

  it("rejects an image URL on a blocked or private host without downloading it", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      jsonResponse({ data: [{ url: "https://storage.internal/img.png" }] }),
    );
    await expect(
      generateWithSeedream({ prompt: "p", size: "1024x1024", model: SEEDREAM_MODEL }, "k"),
    ).rejects.toMatchObject({
      name: "ImageGenProviderError",
      message: expect.stringContaining("blocked or private host"),
    });
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });

  it("surfaces upstream errors with status and detail", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      jsonResponse({ error: { message: "invalid api key" } }, 401),
    );
    await expect(
      generateWithSeedream({ prompt: "p", size: "1024x1024", model: SEEDREAM_MODEL }, "bad"),
    ).rejects.toMatchObject({
      name: "ImageGenProviderError",
      status: 401,
    });
  });

  it("fails loudly when no image data is returned", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(jsonResponse({ data: [] }));
    await expect(
      generateWithSeedream({ prompt: "p", size: "1024x1024", model: SEEDREAM_MODEL }, "k"),
    ).rejects.toBeInstanceOf(ImageGenProviderError);
  });
});
