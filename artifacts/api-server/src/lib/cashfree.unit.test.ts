import { describe, it, expect } from "vitest";
import {
  paiseToRupees,
  rupeesToPaise,
  isCashfreeEntitledStatus,
  isCashfreePendingStatus,
} from "./cashfree";

describe("cashfree amount helpers", () => {
  it("converts paise to a 2dp rupee decimal", () => {
    expect(paiseToRupees(100_000)).toBe(1000);
    expect(paiseToRupees(118_000)).toBe(1180);
    expect(paiseToRupees(49_900)).toBe(499);
    expect(paiseToRupees(1)).toBe(0.01);
  });

  it("round-trips rupees back to paise", () => {
    expect(rupeesToPaise(1000)).toBe(100_000);
    expect(rupeesToPaise("499.00")).toBe(49_900);
    expect(rupeesToPaise(0.01)).toBe(1);
  });
});

describe("cashfree subscription status mapping", () => {
  it("treats ACTIVE as entitled", () => {
    expect(isCashfreeEntitledStatus("ACTIVE")).toBe(true);
    expect(isCashfreeEntitledStatus("CANCELLED")).toBe(false);
    expect(isCashfreeEntitledStatus("INITIALIZED")).toBe(false);
  });

  it("treats INITIALIZED / BANK_APPROVAL_PENDING as pending", () => {
    expect(isCashfreePendingStatus("INITIALIZED")).toBe(true);
    expect(isCashfreePendingStatus("BANK_APPROVAL_PENDING")).toBe(true);
    expect(isCashfreePendingStatus("ACTIVE")).toBe(false);
  });
});
