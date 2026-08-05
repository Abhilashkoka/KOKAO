import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  lookupOpenRouterPricing,
  lookupOpenRouterVideoPricing,
  resetOpenRouterCatalogCache,
} from "./openrouterCatalog";
import * as platformFetchModule from "./platformFetch";

function catalogResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data }),
  } as unknown as Response;
}

describe("lookupOpenRouterPricing", () => {
  beforeEach(() => resetOpenRouterCatalogCache());
  afterEach(() => {
    vi.restoreAllMocks();
    resetOpenRouterCatalogCache();
  });

  it("maps per-token catalog prices to USD per 1M tokens", async () => {
    vi.spyOn(platformFetchModule, "platformFetch").mockResolvedValue(
      catalogResponse([
        { id: "openai/gpt-4o-mini", pricing: { prompt: "0.00000015", completion: "0.0000006" } },
        { id: "other/model", pricing: { prompt: "0.000001", completion: "0.000002" } },
      ]),
    );
    const out = await lookupOpenRouterPricing(["openai/gpt-4o-mini", "unknown/model"]);
    expect(out).toEqual([
      { model: "openai/gpt-4o-mini", inputPerMTokens: 0.15, outputPerMTokens: 0.6, imageOutputPerMTokens: null },
      { model: "unknown/model", inputPerMTokens: null, outputPerMTokens: null, imageOutputPerMTokens: null },
    ]);
  });

  it("caches the catalog across lookups", async () => {
    const spy = vi
      .spyOn(platformFetchModule, "platformFetch")
      .mockResolvedValue(catalogResponse([{ id: "a/b", pricing: { prompt: "0.000001" } }]));
    await lookupOpenRouterPricing(["a/b"]);
    await lookupOpenRouterPricing(["a/b"]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("fails soft: catalog outage yields null prices, never throws", async () => {
    vi.spyOn(platformFetchModule, "platformFetch").mockRejectedValue(new Error("boom"));
    const out = await lookupOpenRouterPricing(["a/b"]);
    expect(out).toEqual([{ model: "a/b", inputPerMTokens: null, outputPerMTokens: null, imageOutputPerMTokens: null }]);
  });
});

describe("lookupOpenRouterVideoPricing", () => {
  beforeEach(() => resetOpenRouterCatalogCache());
  afterEach(() => {
    vi.restoreAllMocks();
    resetOpenRouterCatalogCache();
  });

  it("maps pricing_skus to USD per second across SKU naming families", async () => {
    vi.spyOn(platformFetchModule, "platformFetch").mockResolvedValue(
      catalogResponse([
        // Plain per-second rate.
        { id: "kwaivgi/kling-v3.0-std", pricing_skus: { duration_seconds: "0.084" } },
        // Audio-tiered SKUs: 720p-without-audio preferred.
        {
          id: "google/veo-3.1-fast",
          pricing_skus: {
            duration_seconds_with_audio: "0.12",
            duration_seconds_without_audio_720p: "0.08",
          },
        },
        // Cents-based SKUs convert to USD.
        { id: "runway/gen-4.5", pricing_skus: { cents_per_second_output: "12" } },
        // Token-billed video (no per-second rate) resolves to null, never a guess.
        { id: "bytedance/seedance-2.0", pricing_skus: { video_tokens: "0.000007" } },
      ]),
    );
    const out = await lookupOpenRouterVideoPricing([
      "kwaivgi/kling-v3.0-std",
      "google/veo-3.1-fast",
      "runway/gen-4.5",
      "bytedance/seedance-2.0",
      "unknown/model",
    ]);
    expect(out).toEqual([
      { model: "kwaivgi/kling-v3.0-std", usdPerSecond: 0.084 },
      { model: "google/veo-3.1-fast", usdPerSecond: 0.08 },
      { model: "runway/gen-4.5", usdPerSecond: 0.12 },
      { model: "bytedance/seedance-2.0", usdPerSecond: null },
      { model: "unknown/model", usdPerSecond: null },
    ]);
  });

  it("fails soft on a video catalog outage", async () => {
    vi.spyOn(platformFetchModule, "platformFetch").mockRejectedValue(new Error("down"));
    const out = await lookupOpenRouterVideoPricing(["a/b"]);
    expect(out).toEqual([{ model: "a/b", usdPerSecond: null }]);
  });
});
