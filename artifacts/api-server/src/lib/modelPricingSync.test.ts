import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findModelPrice: vi.fn(),
  pruneModelPriceVariants: vi.fn(),
  upsertModelPrice: vi.fn(),
  lookupOpenRouterVideoPricing: vi.fn(),
  lookupReplicateUnitPricing: vi.fn(),
}));

vi.mock("./aiCost", () => ({
  canonicalVideoVariantKey: vi.fn(() => ""),
  findModelPrice: mocks.findModelPrice,
  pruneModelPriceVariants: mocks.pruneModelPriceVariants,
  upsertModelPrice: mocks.upsertModelPrice,
}));
vi.mock("./openrouterCatalog", () => ({
  lookupOpenRouterPricing: vi.fn(),
  lookupOpenRouterVideoPricing: mocks.lookupOpenRouterVideoPricing,
}));
vi.mock("./openaiCatalog", () => ({ lookupOpenAiPricing: vi.fn() }));
vi.mock("./geminiCatalog", () => ({ lookupGeminiPricing: vi.fn() }));
vi.mock("./replicateCatalog", () => ({
  lookupReplicateTokenPricing: vi.fn(),
  lookupReplicateUnitPricing: mocks.lookupReplicateUnitPricing,
}));

import { syncActivatedModelPricing } from "./modelPricingSync";

describe("syncActivatedModelPricing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findModelPrice.mockResolvedValue(null);
    mocks.lookupOpenRouterVideoPricing.mockResolvedValue([
      {
        model: "bytedance/seedance-2.5",
        usdPerSecond: 0.9676,
      },
    ]);
    mocks.lookupReplicateUnitPricing.mockResolvedValue([]);
  });

  it("retires stale video variants after syncing the provider's generic rate", async () => {
    const result = await syncActivatedModelPricing({
      kind: "video",
      provider: "openrouter",
      models: ["bytedance/seedance-2.5"],
    });

    expect(result.missing).toEqual([]);
    expect(mocks.upsertModelPrice).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "video",
        provider: "openrouter",
        model: "bytedance/seedance-2.5",
        usdPerSecond: 0.9676,
      }),
    );
    expect(mocks.pruneModelPriceVariants).toHaveBeenCalledWith({
      kind: "video",
      provider: "openrouter",
      model: "bytedance/seedance-2.5",
      keepVariantKeys: [""],
    });
  });

  it("keeps an exact saved provider price instead of importing and warning about another catalog", async () => {
    mocks.lookupOpenRouterVideoPricing.mockResolvedValue([]);
    mocks.lookupReplicateUnitPricing.mockResolvedValue([
      {
        model: "bytedance/seedance-2.5",
        usdPerSecond: 0.9676,
      },
    ]);
    mocks.findModelPrice.mockResolvedValue({
      provider: "openrouter",
      model: "bytedance/seedance-2.5",
      inputUsdPerMtok: null,
      outputUsdPerMtok: null,
      usdPerImage: null,
      usdPerSecond: 0.23,
      usdPerVideo: null,
    });

    const result = await syncActivatedModelPricing({
      kind: "video",
      provider: "openrouter",
      models: ["bytedance/seedance-2.5"],
    });

    expect(result).toEqual({ missing: [], crossSourced: [] });
    expect(mocks.upsertModelPrice).not.toHaveBeenCalled();
    expect(mocks.pruneModelPriceVariants).not.toHaveBeenCalled();
  });
});