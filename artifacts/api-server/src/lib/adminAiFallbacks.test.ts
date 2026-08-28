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

  it("does not treat text-ready NVIDIA as multimodal-ready when the independent capability is missing", () => {
    const text = deriveFallbackEligibility({
      configured: true,
      healthy: true,
      hasPrice: true,
      priceRequired: false,
    });
    const multimodal = deriveFallbackEligibility({
      configured: true,
      healthy: true,
      hasPrice: true,
      priceRequired: false,
      dependencyReady: false,
      dependencySkipReason: "NVIDIA multimodal has not passed its independent activation gate.",
    });

    expect(text.eligible).toBe(true);
    expect(multimodal).toEqual({
      eligible: false,
      skipReason: "NVIDIA multimodal has not passed its independent activation gate.",
    });
  });

  it("reports NVIDIA text and independently activated multimodal as ready", () => {
    const text = deriveFallbackEligibility({
      configured: true,
      healthy: true,
      hasPrice: true,
      priceRequired: false,
    });
    const multimodal = deriveFallbackEligibility({
      configured: true,
      healthy: true,
      hasPrice: true,
      priceRequired: false,
      dependencyReady: true,
    });

    expect(text).toEqual({ eligible: true, skipReason: null });
    expect(multimodal).toEqual({ eligible: true, skipReason: null });
  });
});