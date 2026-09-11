import { describe, expect, it } from "vitest";
import {
  ATLAS_WAN_PRIME_PRICES,
  ATLAS_WAN_STANDARD_PRICES,
  atlasWanPriceRows,
  isAtlasWanModel,
} from "./pricing";

describe("Atlas Cloud Wan pricing", () => {
  it("keeps the published Standard resolution matrix", () => {
    expect(ATLAS_WAN_STANDARD_PRICES).toEqual([
      { resolution: "480p", usdPerSecond: 0.04, officialUsdPerSecond: 0.05 },
      { resolution: "720p", usdPerSecond: 0.08, officialUsdPerSecond: 0.1 },
      { resolution: "720p-esr", usdPerSecond: 0.064, officialUsdPerSecond: 0.08 },
      { resolution: "1080p", usdPerSecond: 0.16, officialUsdPerSecond: 0.2 },
      { resolution: "1080p-esr", usdPerSecond: 0.128, officialUsdPerSecond: 0.16 },
      { resolution: "1440p-esr", usdPerSecond: 0.2752, officialUsdPerSecond: 0.344 },
      { resolution: "4k-esr", usdPerSecond: 0.5917, officialUsdPerSecond: 0.7396 },
    ]);
  });

  it("keeps the published Prime resolution matrix", () => {
    expect(ATLAS_WAN_PRIME_PRICES.map((price) => price.usdPerSecond)).toEqual([
      0.0612, 0.126, 0.1008, 0.252, 0.2016, 0.4334, 0.9319,
    ]);
  });

  it("emits every Wan endpoint as a resolution-aware provider row", () => {
    const models = [
      "alibaba/wan-3.0/text-to-video",
      "alibaba/wan-3.0/image-to-video",
      "alibaba/wan-3.0/reference-to-video",
      "alibaba/wan-3.0-prime/text-to-video",
      "alibaba/wan-3.0-prime/image-to-video",
      "alibaba/wan-3.0-prime/reference-to-video",
    ];
    for (const model of models) {
      expect(isAtlasWanModel(model)).toBe(true);
      expect(atlasWanPriceRows(model)).toHaveLength(7);
      expect(atlasWanPriceRows(model).every((row) => row.variantCriteria.resolution)).toBe(true);
    }
  });
});
