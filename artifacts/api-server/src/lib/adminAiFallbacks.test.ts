import { describe, expect, it } from "vitest";
import { deriveFallbackEligibility } from "./adminAiFallbacks";

describe("admin AI fallback pricing gate", () => {
  it("skips an unpriced video model but does not apply the price gate to ASR/TTS", () => {
    expect(deriveFallbackEligibility({ configured: true, healthy: true, hasPrice: false, priceRequired: true }))
      .toEqual({ eligible: false, skipReason: "Missing price: video runtime will not attempt this model." });
    expect(deriveFallbackEligibility({ configured: true, healthy: true, hasPrice: false, priceRequired: false }))
      .toEqual({ eligible: true, skipReason: null });
  });

  it("keeps configuration and breaker failures explicit", () => {
    expect(deriveFallbackEligibility({ configured: false, healthy: true, hasPrice: true, priceRequired: true }).skipReason)
      .toBe("Provider is not configured.");
    expect(deriveFallbackEligibility({ configured: true, healthy: false, hasPrice: true, priceRequired: true }).skipReason)
      .toBe("Provider circuit breaker is open.");
  });
});