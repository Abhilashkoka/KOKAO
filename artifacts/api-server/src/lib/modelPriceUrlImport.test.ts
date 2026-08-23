import { describe, expect, it, vi } from "vitest";

const {
  lookupOpenRouterPricing,
  lookupOpenRouterVideoPricing,
  lookupReplicateTokenPricing,
  lookupReplicateUnitPricing,
} = vi.hoisted(() => ({
  lookupOpenRouterPricing: vi.fn(),
  lookupOpenRouterVideoPricing: vi.fn(),
  lookupReplicateTokenPricing: vi.fn(),
  lookupReplicateUnitPricing: vi.fn(),
}));

vi.mock("./openrouterCatalog", () => ({
  lookupOpenRouterPricing,
  lookupOpenRouterVideoPricing,
}));
vi.mock("./replicateCatalog", () => ({
  lookupReplicateTokenPricing,
  lookupReplicateUnitPricing,
}));

import { parseOfficialModelPriceUrl, previewModelPriceImport } from "./modelPriceUrlImport";

describe("model price URL imports", () => {
  it("rejects an unsafe host before any catalog lookup", async () => {
    await expect(previewModelPriceImport("https://127.0.0.1/openai/gpt-4o", "text")).rejects.toThrow(
      /official Replicate and OpenRouter/i,
    );
    expect(lookupOpenRouterPricing).not.toHaveBeenCalled();
    expect(lookupReplicateTokenPricing).not.toHaveBeenCalled();
  });

  it("only accepts official HTTPS two-segment model page shapes", () => {
    expect(parseOfficialModelPriceUrl("https://replicate.com/owner/model")).toEqual({
      provider: "replicate",
      model: "owner/model",
    });
    expect(parseOfficialModelPriceUrl("https://openrouter.ai/openai/gpt-4o:free")).toEqual({
      provider: "openrouter",
      model: "openai/gpt-4o:free",
    });
    expect(() => parseOfficialModelPriceUrl("http://replicate.com/owner/model")).toThrow(/HTTPS/i);
    expect(() => parseOfficialModelPriceUrl("https://replicate.com/owner/model/versions")).toThrow(
      /shape/i,
    );
  });

  it("returns a structured read-only proposal and warning for unpriced models", async () => {
    lookupOpenRouterPricing.mockResolvedValueOnce([
      { model: "openai/unpriced", inputPerMTokens: null, outputPerMTokens: null, imageOutputPerMTokens: null },
    ]);
    await expect(
      previewModelPriceImport("https://openrouter.ai/openai/unpriced", "text"),
    ).resolves.toMatchObject({
      provider: "openrouter",
      model: "openai/unpriced",
      kind: "text",
      inputUsdPerMtok: null,
      outputUsdPerMtok: null,
      warnings: [expect.stringMatching(/did not publish/i)],
    });
  });

  it("maps official catalog prices to a proposal without persistence", async () => {
    lookupReplicateUnitPricing.mockResolvedValueOnce([
      { model: "owner/model", usdPerImage: null, usdPerSecond: 0.25, usdPerVideo: 1.5 },
    ]);
    await expect(previewModelPriceImport("https://replicate.com/owner/model", "video")).resolves.toMatchObject({
      provider: "replicate",
      model: "owner/model",
      usdPerSecond: 0.25,
      usdPerVideo: 1.5,
      warnings: [],
    });
  });
});