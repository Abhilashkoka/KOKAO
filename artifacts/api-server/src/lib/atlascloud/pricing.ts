import type { VideoPriceCriteria } from "@workspace/db";

/**
 * Atlas Cloud's published Wan 3.0 rate cards, captured from the official
 * pricing catalog. Values are the currently displayed "Our Price" (after the
 * catalog promotion); the adjacent official values are retained for audit
 * context and are not used as a guessed fallback.
 */
export interface AtlasWanPrice {
  resolution: string;
  usdPerSecond: number;
  officialUsdPerSecond: number;
}

export const ATLAS_WAN_STANDARD_PRICES: readonly AtlasWanPrice[] = [
  { resolution: "480p", usdPerSecond: 0.04, officialUsdPerSecond: 0.05 },
  { resolution: "720p", usdPerSecond: 0.08, officialUsdPerSecond: 0.1 },
  { resolution: "720p-esr", usdPerSecond: 0.064, officialUsdPerSecond: 0.08 },
  { resolution: "1080p", usdPerSecond: 0.16, officialUsdPerSecond: 0.2 },
  { resolution: "1080p-esr", usdPerSecond: 0.128, officialUsdPerSecond: 0.16 },
  { resolution: "1440p-esr", usdPerSecond: 0.2752, officialUsdPerSecond: 0.344 },
  { resolution: "4k-esr", usdPerSecond: 0.5917, officialUsdPerSecond: 0.7396 },
] as const;

export const ATLAS_WAN_PRIME_PRICES: readonly AtlasWanPrice[] = [
  { resolution: "480p", usdPerSecond: 0.0612, officialUsdPerSecond: 0.068 },
  { resolution: "720p", usdPerSecond: 0.126, officialUsdPerSecond: 0.14 },
  { resolution: "720p-esr", usdPerSecond: 0.1008, officialUsdPerSecond: 0.112 },
  { resolution: "1080p", usdPerSecond: 0.252, officialUsdPerSecond: 0.28 },
  { resolution: "1080p-esr", usdPerSecond: 0.2016, officialUsdPerSecond: 0.224 },
  { resolution: "1440p-esr", usdPerSecond: 0.4334, officialUsdPerSecond: 0.4816 },
  { resolution: "4k-esr", usdPerSecond: 0.9319, officialUsdPerSecond: 1.0354 },
] as const;

export const ATLAS_WAN_PRICING_SOURCE_STANDARD =
  "https://www.atlascloud.ai/pricing/models?page=2";
export const ATLAS_WAN_PRICING_SOURCE_PRIME =
  "https://www.atlascloud.ai/pricing/models";

const STANDARD_MODELS = new Set([
  "alibaba/wan-3.0/text-to-video",
  "alibaba/wan-3.0/image-to-video",
  "alibaba/wan-3.0/reference-to-video",
]);
const PRIME_MODELS = new Set([
  "alibaba/wan-3.0-prime/text-to-video",
  "alibaba/wan-3.0-prime/image-to-video",
  "alibaba/wan-3.0-prime/reference-to-video",
]);

export function isAtlasWanModel(model: string): boolean {
  return STANDARD_MODELS.has(model) || PRIME_MODELS.has(model);
}

export function atlasWanPriceRows(model: string): Array<{
  model: string;
  resolution: string;
  variantCriteria: VideoPriceCriteria;
  usdPerSecond: number;
  sourceUrl: string;
}> {
  const prime = PRIME_MODELS.has(model);
  const prices = prime ? ATLAS_WAN_PRIME_PRICES : ATLAS_WAN_STANDARD_PRICES;
  const sourceUrl = prime
    ? ATLAS_WAN_PRICING_SOURCE_PRIME
    : ATLAS_WAN_PRICING_SOURCE_STANDARD;
  return prices.map(({ resolution, usdPerSecond }) => ({
    model,
    resolution,
    variantCriteria: { resolution },
    usdPerSecond,
    sourceUrl,
  }));
}
