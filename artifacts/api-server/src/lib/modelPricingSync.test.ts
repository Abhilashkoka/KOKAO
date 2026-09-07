import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findModelPrice: vi.fn(),
  pruneModelPriceVariants: vi.fn(),
  replaceModelPriceVariantsAtomically: vi.fn(),
  upsertModelPrice: vi.fn(),
  lookupOpenRouterVideoPricing: vi.fn(),
  lookupReplicateUnitPricing: vi.fn(),
  lookupBytePlusSeedancePricing: vi.fn(),
  isModelPriceAutoImportSuppressed: vi.fn(),
}));

vi.mock("./aiCost", () => ({
  canonicalVideoVariantKey: vi.fn((criteria?: Record<string, unknown>) =>
    criteria ? JSON.stringify(criteria) : "",
  ),
  findModelPrice: mocks.findModelPrice,
  pruneModelPriceVariants: mocks.pruneModelPriceVariants,
  replaceModelPriceVariantsAtomically: mocks.replaceModelPriceVariantsAtomically,
  upsertModelPrice: mocks.upsertModelPrice,
  isModelPriceAutoImportSuppressed: mocks.isModelPriceAutoImportSuppressed,
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
vi.mock("./byteplusPricing", () => ({
  lookupBytePlusSeedancePricing: mocks.lookupBytePlusSeedancePricing,
}));

import {
  refreshBytePlusSeedancePricing,
  syncActivatedModelPricing,
} from "./modelPricingSync";

describe("syncActivatedModelPricing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findModelPrice.mockResolvedValue(null);
    mocks.isModelPriceAutoImportSuppressed.mockResolvedValue(false);
    mocks.lookupOpenRouterVideoPricing.mockResolvedValue([
      {
        model: "bytedance/seedance-2.5",
        usdPerSecond: 0.9676,
      },
    ]);
    mocks.lookupReplicateUnitPricing.mockResolvedValue([]);
    mocks.lookupBytePlusSeedancePricing.mockResolvedValue({
      model: "dreamina-seedance-2-5-260628",
      sourceUrl: "https://docs.byteplus.com/en/docs/ModelArk/1544106",
      sourceCheckedAt: new Date("2026-09-07T12:00:00.000Z"),
      prices: [
        {
          resolution: "480p",
          usdPerSecond: 0.103,
          promotionalUsdPerSecond: null,
          promotionExpiresAt: null,
        },
        {
          resolution: "720p",
          usdPerSecond: 0.231,
          promotionalUsdPerSecond: null,
          promotionExpiresAt: null,
        },
        {
          resolution: "1080p",
          usdPerSecond: 0.569,
          promotionalUsdPerSecond: 0.40968,
          promotionExpiresAt: new Date("2026-09-17T06:00:00.000Z"),
        },
      ],
    });
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

  it("does not recreate a model price after an admin removed it", async () => {
    mocks.isModelPriceAutoImportSuppressed.mockResolvedValue(true);

    const result = await syncActivatedModelPricing({
      kind: "video",
      provider: "openrouter",
      models: ["bytedance/seedance-2.5"],
    });

    expect(result).toEqual({
      missing: ["bytedance/seedance-2.5"],
      crossSourced: [],
    });
    expect(mocks.lookupOpenRouterVideoPricing).not.toHaveBeenCalled();
    expect(mocks.lookupReplicateUnitPricing).not.toHaveBeenCalled();
    expect(mocks.upsertModelPrice).not.toHaveBeenCalled();
  });

  it("refreshes BytePlus Seedance as three source-stamped resolution variants", async () => {
    await refreshBytePlusSeedancePricing();

    expect(mocks.replaceModelPriceVariantsAtomically).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "byteplus",
        model: "dreamina-seedance-2-5-260628",
        sourceCheckedAt: new Date("2026-09-07T12:00:00.000Z"),
        keepVariantKeys: [
          '{"resolution":"480p"}',
          '{"resolution":"720p"}',
          '{"resolution":"1080p"}',
        ],
        prices: expect.arrayContaining([
          expect.objectContaining({
            variantCriteria: { resolution: "1080p" },
            usdPerSecond: 0.569,
            promotionalUsdPerSecond: 0.40968,
            promotionExpiresAt: new Date("2026-09-17T06:00:00.000Z"),
          }),
        ]),
      }),
    );
  });

  it("uses the authoritative BytePlus refresh during Seedance activation", async () => {
    const result = await syncActivatedModelPricing({
      kind: "video",
      provider: "byteplus",
      models: ["dreamina-seedance-2-5-260628"],
    });

    expect(result).toEqual({ missing: [], crossSourced: [] });
    expect(mocks.lookupBytePlusSeedancePricing).toHaveBeenCalledOnce();
    expect(mocks.replaceModelPriceVariantsAtomically).toHaveBeenCalledOnce();
    expect(mocks.lookupOpenRouterVideoPricing).not.toHaveBeenCalled();
    expect(mocks.lookupReplicateUnitPricing).not.toHaveBeenCalled();
  });
});