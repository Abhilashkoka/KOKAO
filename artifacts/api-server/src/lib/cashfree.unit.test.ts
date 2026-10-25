import { describe, it, expect } from "vitest";
import {
  paiseToRupees,
  rupeesToPaise,
  isCashfreeEntitledStatus,
  isCashfreePendingStatus,
  addBillingCycle,
  cashfreePaidPeriodEnd,
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

describe("cashfree billing anchor", () => {
  it("renews on the purchase date one cycle later", () => {
    const from = new Date("2026-10-25T06:30:00.000Z");
    expect(addBillingCycle(from, "monthly").toISOString()).toBe("2026-11-25T06:30:00.000Z");
    expect(addBillingCycle(from, "yearly").toISOString()).toBe("2027-10-25T06:30:00.000Z");
  });
  it("clamps month-end dates instead of skipping a month", () => {
    expect(addBillingCycle(new Date("2026-01-31T00:00:00Z"), "monthly").toISOString())
      .toBe("2026-02-28T00:00:00.000Z");
    expect(addBillingCycle(new Date("2028-02-29T00:00:00Z"), "yearly").toISOString())
      .toBe("2029-02-28T00:00:00.000Z");
  });
  it("paid period ends at the cycle end, else the first recurring charge", () => {
    expect(
      cashfreePaidPeriodEnd({
        subscription_id: "s", subscription_status: "ACTIVE",
        current_cycle: { cycle_end_time: "2027-01-25T00:00:00Z" },
        subscription_first_charge_time: "2026-11-25T00:00:00Z",
      })?.toISOString(),
    ).toBe("2027-01-25T00:00:00.000Z");
    expect(
      cashfreePaidPeriodEnd({
        subscription_id: "s", subscription_status: "ACTIVE",
        current_cycle: null,
        subscription_first_charge_time: "2026-11-25T00:00:00Z",
      })?.toISOString(),
    ).toBe("2026-11-25T00:00:00.000Z");
    expect(
      cashfreePaidPeriodEnd({ subscription_id: "s", subscription_status: "ACTIVE" }),
    ).toBeNull();
  });
});
