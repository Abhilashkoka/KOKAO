import { describe, expect, it } from "vitest";
import type { GamificationPlanSettingsView } from "@workspace/api-client-react";
import { validateReferralSettings } from "./gamification-plans-card";

const settings = {
  referralSlabs: null,
  referralTriggerMode: "every_purchase",
  referralAttributionDays: 180,
  referralBonusExpiryDays: 90,
} as GamificationPlanSettingsView;

describe("purchase referral admin validation", () => {
  it("accepts the default ladder and strictly increasing custom tiers", () => {
    expect(validateReferralSettings(settings)).toBeNull();
    expect(validateReferralSettings({
      ...settings,
      referralSlabs: [
        { minReferrals: 0, referrerBps: 1000, refereeBps: 1000 },
        { minReferrals: 5, referrerBps: 1200, refereeBps: 1000 },
      ],
    })).toBeNull();
  });

  it("rejects duplicate thresholds, invalid rates and durations", () => {
    expect(validateReferralSettings({ ...settings, referralSlabs: [
      { minReferrals: 0, referrerBps: 1000, refereeBps: 1000 },
      { minReferrals: 0, referrerBps: 1200, refereeBps: 1000 },
    ] })).toMatch(/strictly increasing/);
    expect(validateReferralSettings({ ...settings, referralSlabs: [
      { minReferrals: 0, referrerBps: 10001, refereeBps: 1000 },
    ] })).toMatch(/100%/);
    expect(validateReferralSettings({ ...settings, referralBonusExpiryDays: 0 })).toMatch(/durations/);
  });
});