import { describe, expect, it, vi } from "vitest";

const {
  lookupGeminiPricing,
  lookupOpenAiPricing,
  lookupOpenRouterPricing,
  lookupOpenRouterVideoPricing,
  lookupReplicateTokenPricing,
  lookupReplicateUnitPricing,
} = vi.hoisted(() => ({
  lookupGeminiPricing: vi.fn(),
  lookupOpenAiPricing: vi.fn(),
  lookupOpenRouterPricing: vi.fn(),
  lookupOpenRouterVideoPricing: vi.fn(),
  lookupReplicateTokenPricing: vi.fn(),
  lookupReplicateUnitPricing: vi.fn(),
}));

vi.mock("./geminiCatalog", () => ({ lookupGeminiPricing }));
vi.mock("./openaiCatalog", () => ({ lookupOpenAiPricing }));
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
      /official Replicate, OpenRouter, OpenAI, and Google Gemini/i,
    );
    expect(lookupOpenAiPricing).not.toHaveBeenCalled();
    expect(lookupGeminiPricing).not.toHaveBeenCalled();
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
    expect(parseOfficialModelPriceUrl("https://openrouter.ai/openai/gpt-5.4#pricing")).toEqual({
      provider: "openrouter",
      model: "openai/gpt-5.4",
    });
    expect(
      parseOfficialModelPriceUrl("https://developers.openai.com/api/docs/models/gpt-image-1"),
    ).toEqual({ provider: "openai", model: "gpt-image-1" });
    expect(
      parseOfficialModelPriceUrl(
        "https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-image",
      ),
    ).toEqual({ provider: "gemini", model: "gemini-2.5-flash-image" });
    expect(() => parseOfficialModelPriceUrl("http://replicate.com/owner/model")).toThrow(/HTTPS/i);
    expect(() => parseOfficialModelPriceUrl("https://replicate.com/owner/model/versions")).toThrow(
      /shape/i,
    );
    expect(() =>
      parseOfficialModelPriceUrl(
        "https://developers.openai.com/api/docs/models/gpt-image-1?redirect=https://evil.example",
      ),
    ).toThrow(/official HTTPS.*without query parameters/i);
    expect(() =>
      parseOfficialModelPriceUrl(
        "https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-image/other",
      ),
    ).toThrow(/exact official provider/i);
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

  it("maps OpenAI and Gemini model docs through their fixed first-party catalogs", async () => {
    lookupOpenAiPricing.mockResolvedValueOnce([
      { model: "gpt-image-1", inputPerMTokens: 5, outputPerMTokens: 20 },
    ]);
    lookupGeminiPricing.mockResolvedValueOnce([
      {
        model: "gemini-2.5-flash-image",
        inputPerMTokens: 0.3,
        outputPerMTokens: null,
        usdPerImage: 0.039,
      },
    ]);

    await expect(
      previewModelPriceImport(
        "https://developers.openai.com/api/docs/models/gpt-image-1",
        "image",
      ),
    ).resolves.toMatchObject({
      provider: "openai",
      model: "gpt-image-1",
      inputUsdPerMtok: 5,
      outputUsdPerMtok: 20,
      warnings: [],
    });
    await expect(
      previewModelPriceImport(
        "https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-image",
        "image",
      ),
    ).resolves.toMatchObject({
      provider: "gemini",
      model: "gemini-2.5-flash-image",
      inputUsdPerMtok: 0.3,
      outputUsdPerMtok: null,
      usdPerImage: 0.039,
      warnings: [],
    });
  });
});