import { describe, expect, it } from "vitest";
import { creditPackEstimate } from "./credit-pack-estimate";

const rates = [
  { key: "video", unit: "second", credits: 1, active: true },
  { key: "image", unit: "item", credits: 0.5, active: true },
];

describe("credit pack allowance estimates", () => {
  it("calculates alternative allowances from current rates", () => {
    expect(creditPackEstimate(120, rates)).toBe("≈ 2 min of standard AI video or 240 images");
    expect(creditPackEstimate(120, [{ ...rates[0]!, credits: 2 }, rates[1]!]))
      .toBe("≈ 1 min of standard AI video or 240 images");
  });
  it("handles fractional rates without overpromising whole items", () => {
    expect(creditPackEstimate(81, [{ ...rates[1]!, credits: 0.3 }])).toBe("≈ 270 images");
    expect(creditPackEstimate(1, rates)).toBe("≈ 1 sec of standard AI video or 2 images");
    expect(creditPackEstimate(0.5, rates)).toBe("≈ 1 image");
  });
  it("never treats unknown, inactive, zero, or mismatched rates as free", () => {
    expect(creditPackEstimate(120)).toBeNull();
    expect(creditPackEstimate(0, rates)).toBeNull();
    expect(creditPackEstimate(NaN, rates)).toBeNull();
    expect(creditPackEstimate(120, rates.map((r) => ({ ...r, active: false })))).toBeNull();
    expect(creditPackEstimate(120, rates.map((r) => ({ ...r, credits: 0 })))).toBeNull();
    expect(creditPackEstimate(120, [{ ...rates[0]!, unit: "item" }])).toBeNull();
  });
});