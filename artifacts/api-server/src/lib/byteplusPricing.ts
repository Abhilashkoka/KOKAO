import { platformFetch } from "./platformFetch";

export const BYTEPLUS_SEEDANCE_25_PRICING_URL =
  "https://docs.byteplus.com/en/docs/ModelArk/1544106";
export const BYTEPLUS_SEEDANCE_25_MODEL = "dreamina-seedance-2-5-260628";

export interface BytePlusSeedancePrice {
  resolution: "480p" | "720p" | "1080p";
  usdPerSecond: number;
  promotionalUsdPerSecond: number | null;
  promotionExpiresAt: Date | null;
}

export interface BytePlusSeedancePricing {
  model: typeof BYTEPLUS_SEEDANCE_25_MODEL;
  sourceUrl: typeof BYTEPLUS_SEEDANCE_25_PRICING_URL;
  sourceCheckedAt: Date;
  prices: BytePlusSeedancePrice[];
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function parsePromotion(source: string): {
  discountPercent: number;
  expiresAt: Date;
} | null {
  const match =
    /Seedance 2\.5[\s\S]{0,1200}?through 14:00 \(UTC\+8\)\s+on ([A-Z][a-z]+) (\d{1,2}), (\d{4})[\s\S]{0,250}?1080p output[\s\S]{0,200}?(\d{1,2})% off the list price/i.exec(
      source,
    );
  if (!match) return null;
  const [, month, day, year, percent] = match;
  const expiresAt = new Date(`${month} ${day}, ${year} 06:00:00 UTC`);
  const discountPercent = Number(percent);
  if (
    !Number.isFinite(expiresAt.getTime()) ||
    !Number.isFinite(discountPercent) ||
    discountPercent <= 0 ||
    discountPercent >= 100
  ) {
    return null;
  }
  return { discountPercent, expiresAt };
}

function findReadablePricingDocument(source: string): string {
  const marker = "window._ROUTER_DATA = ";
  const payloadAt = source.indexOf(marker);
  if (payloadAt < 0) return source;
  const payloadStart = payloadAt + marker.length;
  const payloadEnd = source.indexOf("</script>", payloadStart);
  if (payloadEnd < 0) {
    throw new Error("BytePlus pricing page contained incomplete server-rendered data.");
  }
  let data: unknown;
  try {
    data = JSON.parse(source.slice(payloadStart, payloadEnd).trim());
  } catch {
    throw new Error("BytePlus pricing page contained invalid server-rendered data.");
  }
  const candidates: string[] = [];
  const visit = (value: unknown, key?: string): void => {
    if (typeof value === "string") {
      if (
        key === "MDContent" &&
        value.includes("Dreamina Seedance 2.5 price")
      ) {
        candidates.push(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const [childKey, item] of Object.entries(value)) visit(item, childKey);
    }
  };
  visit(data);
  const readable = candidates.sort((left, right) => left.length - right.length)[0];
  if (!readable) {
    throw new Error("BytePlus pricing page did not publish readable Markdown pricing data.");
  }
  return readable;
}

/**
 * Parse only the provider's Seedance 2.5 pricing-example section. BytePlus
 * serves the document as serialized editor JSON, so the visible table values
 * remain present as plain strings even when the surrounding HTML changes.
 */
export function parseBytePlusSeedancePricing(
  source: string,
  sourceCheckedAt = new Date(),
): BytePlusSeedancePricing {
  const readable = findReadablePricingDocument(source);
  const heading = /^[ \t]*### Dreamina Seedance 2\.5[ \t]*$/m.exec(readable);
  if (!heading) {
    throw new Error("BytePlus pricing page did not contain the Seedance 2.5 pricing section.");
  }
  const sectionStart = heading.index + heading[0].length;
  const nextHeading = /\n[ \t]*#{1,3}\s+\S/g.exec(readable.slice(sectionStart));
  const sectionEnd =
    nextHeading?.index === undefined ? readable.length : sectionStart + nextHeading.index;
  const section = readable.slice(sectionStart, sectionEnd);
  const withoutVideoAt = section.indexOf("**Input without video**");
  const withVideoAt = section.indexOf("**Input with video**", withoutVideoAt);
  if (withoutVideoAt < 0 || withVideoAt < 0) {
    throw new Error("BytePlus pricing page did not contain the Seedance 2.5 no-video table.");
  }
  const table = section.slice(withoutVideoAt, withVideoAt);
  if (
    !table.includes("|**Resolution**") ||
    !table.includes("**Dreamina Seedance 2.5 price**")
  ) {
    throw new Error("BytePlus pricing page changed the Seedance 2.5 pricing table headers.");
  }
  const promotion = parsePromotion(readable);
  const resolutions = ["480p", "720p", "1080p"] as const;
  const prices = resolutions.map((resolution) => {
    const match = new RegExp(
      `^\\s*\\|\\s*${resolution}\\s*\\|[^\\n]*?\\*\\s*([0-9]+(?:\\.[0-9]+)?) per second\\s*\\|\\s*$`,
      "im",
    ).exec(table);
    const usdPerSecond = Number(match?.[1]);
    if (!Number.isFinite(usdPerSecond) || usdPerSecond <= 0) {
      throw new Error(`BytePlus pricing page did not publish a usable ${resolution} per-second rate.`);
    }
    const discounted = resolution === "1080p" ? promotion : null;
    return {
      resolution,
      usdPerSecond,
      promotionalUsdPerSecond: discounted
        ? roundUsd(usdPerSecond * (1 - discounted.discountPercent / 100))
        : null,
      promotionExpiresAt: discounted?.expiresAt ?? null,
    };
  });
  if (new Set(prices.map((price) => price.resolution)).size !== 3) {
    throw new Error("BytePlus pricing page did not preserve all three Seedance resolutions.");
  }
  return {
    model: BYTEPLUS_SEEDANCE_25_MODEL,
    sourceUrl: BYTEPLUS_SEEDANCE_25_PRICING_URL,
    sourceCheckedAt,
    prices,
  };
}

/** Fixed-host authoritative refresh. Throws without mutating saved prices. */
export async function lookupBytePlusSeedancePricing(): Promise<BytePlusSeedancePricing> {
  const response = await platformFetch(BYTEPLUS_SEEDANCE_25_PRICING_URL);
  if (!response.ok) {
    throw new Error(`BytePlus pricing page responded ${response.status}.`);
  }
  return parseBytePlusSeedancePricing(await response.text(), new Date());
}