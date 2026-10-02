export interface PackEstimateRate {
  key: string;
  unit: string;
  credits: number;
  active: boolean;
}

/** Alternative base-generation allowances, not a bundled workflow quote. */
export function creditPackEstimate(credits: number, rates?: readonly PackEstimateRate[]): string | null {
  if (!Number.isFinite(credits) || credits <= 0 || !rates) return null;
  const quantity = (key: string, unit: string) => {
    const rate = rates.find((r) => r.key === key && r.unit === unit && r.active);
    if (!rate || !Number.isFinite(rate.credits) || rate.credits <= 0) return null;
    // Rate cards store thousandths of a credit. Integer division avoids
    // floating-point undercounts for rates such as 0.3 credits per image.
    const milli = Math.round(rate.credits * 1000);
    return milli > 0 ? Math.floor(Math.round(credits * 1000) / milli) : null;
  };
  const seconds = quantity("video", "second");
  const images = quantity("image", "item");
  const parts: string[] = [];
  if (seconds !== null && seconds > 0) {
    const duration = seconds >= 60
      ? `${Math.floor(seconds / 6) / 10} min`
      : `${seconds} sec`;
    parts.push(`${duration} of standard AI video`);
  }
  if (images !== null && images > 0) parts.push(`${images.toLocaleString("en-IN")} ${images === 1 ? "image" : "images"}`);
  return parts.length ? `≈ ${parts.join(" or ")}` : null;
}

export const CREDIT_PACK_ESTIMATE_NOTE =
  "Base generation only, using current credit rates. HD video, audio and other steps may use extra credits.";