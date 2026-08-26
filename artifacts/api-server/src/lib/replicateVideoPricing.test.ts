import { beforeEach, describe, expect, it, vi } from "vitest";

const { findModelPrice, upsertModelPrice, lookupReplicateUnitPricing, getVideoGenSelection } = vi.hoisted(() => ({
  findModelPrice: vi.fn(),
  upsertModelPrice: vi.fn(),
  lookupReplicateUnitPricing: vi.fn(),
  getVideoGenSelection: vi.fn(),
}));

vi.mock("./aiCost", () => ({ findModelPrice, upsertModelPrice }));
vi.mock("./replicateCatalog", () => ({
  lookupReplicatePricing: vi.fn(),
  lookupReplicateUnitPricing,
}));
vi.mock("./videoGen", () => ({ getVideoGenSelection }));

import {
  listReplicateVideoPricingTargets,
  syncReplicateVideoPricing,
} from "./replicateVideoPricing";

beforeEach(() => {
  vi.clearAllMocks();
  findModelPrice.mockResolvedValue(null);
  upsertModelPrice.mockResolvedValue({});
  getVideoGenSelection.mockResolvedValue({
    provider: "replicate",
    textToVideoModel: null,
    imageToVideoModel: null,
    enabledModelIds: null,
    lipSyncPortraitModel: null,
  });
});

describe("Replicate video pricing inventory", () => {
  it("dedupes active generation slugs, includes lip sync, and excludes stale legacy options", () => {
    const targets = listReplicateVideoPricingTargets();
    const models = targets.map((target) => target.model);
    expect(new Set(models).size).toBe(models.length);
    expect(models).toContain("wan-video/wan-2.2-t2v-fast");
    expect(models).toContain("wan-video/wan-2.2-i2v-fast");
    expect(models).toContain("bytedance/latentsync");
    expect(models).toContain("sync/lipsync-2");
    expect(models).not.toContain("minimax/video-01");
    expect(models).not.toContain("google/veo-3.1");
    expect(
      targets.find((target) => target.model === "minimax/hailuo-02")?.uses,
    ).toEqual(["Text to Video", "Animate Photo"]);
  });

  it("adds a current free-text Replicate override without duplicating catalog models", () => {
    const targets = listReplicateVideoPricingTargets([
      "vendor/admin-approved-video",
      "google/veo-3",
    ]);
    expect(
      targets.find((target) => target.model === "vendor/admin-approved-video")?.uses,
    ).toEqual(["Active admin override"]);
    expect(targets.filter((target) => target.model === "google/veo-3")).toHaveLength(1);
  });

  it("persists published prices, preserves manual rows, and reports truly unavailable models", async () => {
    lookupReplicateUnitPricing.mockImplementation(async (models: string[]) =>
      models.map((model) => ({
        model,
        usdPerImage: null,
        usdPerSecond: model === "google/veo-3" ? 0.4 : null,
        usdPerVideo: null,
      })),
    );
    findModelPrice.mockImplementation(async (_kind: string, _provider: string, model: string) =>
      model === "bytedance/latentsync"
        ? { model, provider: "replicate", usdPerSecond: null, usdPerVideo: 0.1 }
        : null,
    );

    const result = await syncReplicateVideoPricing();

    expect(result.synced).toEqual(["google/veo-3"]);
    expect(result.manual).toEqual(["bytedance/latentsync"]);
    expect(result.unavailable).toContain("kwaivgi/kling-v2.1-standard");
    expect(upsertModelPrice).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "video",
        provider: "replicate",
        model: "google/veo-3",
        usdPerSecond: 0.4,
        usdPerVideo: null,
      }),
    );
    expect(upsertModelPrice).toHaveBeenCalledTimes(1);
  });
});