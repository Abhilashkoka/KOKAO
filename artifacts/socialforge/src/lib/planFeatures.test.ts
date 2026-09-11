import { describe, expect, it } from "vitest";
import { getDisplayedPlanFeatures, SHARED_CREDIT_BALANCE_FEATURE } from "./planFeatures";

const basePlan = {
  features: [
    "500 AI captions / month",
    "200 AI images / month",
    "50 AI videos / month",
    "10 brand kits",
    "Schedule up to 200 posts",
  ],
  billingMode: "credits" as const,
};

describe("getDisplayedPlanFeatures", () => {
  it("replaces legacy media quotas with the real monthly credit allowance", () => {
    expect(getDisplayedPlanFeatures({ ...basePlan, monthlyCredits: 125 })).toEqual([
      "125 credits per month",
      SHARED_CREDIT_BALANCE_FEATURE,
      "10 brand kits",
      "Schedule up to 200 posts",
    ]);
  });

  it("does not invent an allowance when monthly credits are zero", () => {
    const features = getDisplayedPlanFeatures({ ...basePlan, monthlyCredits: 0 });
    expect(features).toContain("No included credits");
    expect(features).not.toContain("125 credits per month");
    expect(features.join(" ")).not.toMatch(/\b(?:captions?|images?|videos?)\s*\/\s*month\b/i);
  });

  it("keeps capability and structural features on credits plans", () => {
    expect(
      getDisplayedPlanFeatures({
        features: ["AI image generation", "Brand voice engine", "Unlimited AI captions"],
        billingMode: "credits",
        monthlyCredits: 10,
      }),
    ).toEqual([
      "10 credits per month",
      SHARED_CREDIT_BALANCE_FEATURE,
      "AI image generation",
      "Brand voice engine",
    ]);
  });

  it("leaves quota and wallet plan copy unchanged", () => {
    const features = ["500 AI captions / month", "Wallet balance never expires"];
    expect(getDisplayedPlanFeatures({ features, billingMode: "quota", monthlyCredits: 999 })).toEqual(
      features,
    );
    expect(getDisplayedPlanFeatures({ features, billingMode: "wallet", monthlyCredits: 999 })).toEqual(
      features,
    );
  });
});
