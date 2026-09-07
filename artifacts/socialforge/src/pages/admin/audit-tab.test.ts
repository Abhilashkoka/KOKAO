import { describe, expect, it } from "vitest";
import { formatAuditValue } from "./audit-tab";

describe("Seedance rate refresh audit formatting", () => {
  it("shows every resolution, promotion expiry, source, check time, and change outcome", () => {
    const formatted = formatAuditValue(
      "seedance_rate_refresh",
      JSON.stringify({
        outcome: "changed",
        provider: "byteplus",
        sourceUrl: "https://docs.byteplus.com/pricing",
        sourceCheckedAt: "2026-09-07T12:00:00.000Z",
        rates: {
          "480p": {
            listUsdPerSecond: 0.103,
            promotionUsdPerSecond: null,
            promotionExpiresAt: null,
          },
          "720p": {
            listUsdPerSecond: 0.231,
            promotionUsdPerSecond: null,
            promotionExpiresAt: null,
          },
          "1080p": {
            listUsdPerSecond: 0.569,
            promotionUsdPerSecond: 0.40968,
            promotionExpiresAt: "2026-09-17T06:00:00.000Z",
          },
        },
      }),
    );

    expect(formatted).toContain("rates changed");
    expect(formatted).toContain("480p: $0.103/s");
    expect(formatted).toContain("720p: $0.231/s");
    expect(formatted).toContain("1080p: $0.569/s, promo $0.40968/s until");
    expect(formatted).toContain("source: byteplus (https://docs.byteplus.com/pricing)");
    expect(formatted).toContain("checked:");
  });

  it("labels a successful refresh with identical rates as no rate change", () => {
    const formatted = formatAuditValue(
      "seedance_rate_refresh",
      JSON.stringify({
        outcome: "no_change",
        rates: {
          "480p": { listUsdPerSecond: 0.103 },
          "720p": { listUsdPerSecond: 0.231 },
          "1080p": { listUsdPerSecond: 0.569 },
        },
      }),
    );

    expect(formatted).toContain("no rate change");
  });
});