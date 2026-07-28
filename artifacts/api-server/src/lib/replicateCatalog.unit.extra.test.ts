import { describe, it, expect, afterEach, vi } from "vitest";
import {
  lookupReplicateUnitPricing,
  resetReplicateCatalogCache,
} from "./replicateCatalog";

vi.mock("./platformFetch", () => ({
  platformFetch: vi.fn(async () => ({
    ok: true,
    text: async () =>
      `"prices": [{"price": "$0.20", "title": "per second of output video"},
                  {"price": "$0.40", "title": "per second of output video"},
                  {"price": "$0.05", "title": "per output image"},
                  {"price": "$1.50", "title": "per video"}]`,
  })),
}));

afterEach(() => resetReplicateCatalogCache());

describe("lookupReplicateUnitPricing", () => {
  it("maps titles to structured fields, taking the max across variants", async () => {
    const [p] = await lookupReplicateUnitPricing(["owner/model"]);
    expect(p).toEqual({
      model: "owner/model",
      usdPerImage: 0.05,
      usdPerSecond: 0.4,
      usdPerVideo: 1.5,
    });
  });

  it("does not misread 'per second of output video' as a flat per-video price", async () => {
    const [p] = await lookupReplicateUnitPricing(["owner/model"]);
    expect(p.usdPerVideo).toBe(1.5); // from the explicit "per video" entry only
  });

  it("returns all-null for malformed slugs without fetching", async () => {
    const [p] = await lookupReplicateUnitPricing(["not a slug"]);
    expect(p).toEqual({ model: "not a slug", usdPerImage: null, usdPerSecond: null, usdPerVideo: null });
  });
});
