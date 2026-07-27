import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { lookupOpenRouterPricing, resetOpenRouterCatalogCache } from "./openrouterCatalog";
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
      { model: "openai/gpt-4o-mini", inputPerMTokens: 0.15, outputPerMTokens: 0.6 },
      { model: "unknown/model", inputPerMTokens: null, outputPerMTokens: null },
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
    expect(out).toEqual([{ model: "a/b", inputPerMTokens: null, outputPerMTokens: null }]);
  });
});
