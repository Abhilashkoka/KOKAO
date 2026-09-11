import type { Plan } from "@workspace/api-client-react";

/**
 * The feature list is stored with a plan so admins can describe capabilities
 * without changing the UI. Credit-funded plans are different: their caption,
 * image, and video allowances are not per-action quotas, so those legacy
 * strings must not survive in a customer-facing card.
 */
export type PlanFeaturePresentationInput = Pick<Plan, "features" | "billingMode"> & {
  monthlyCredits?: number | null;
};

export const SHARED_CREDIT_BALANCE_FEATURE =
  "One shared credit balance for captions, images, videos, and voice";

function isLegacyAiQuotaFeature(feature: string): boolean {
  const normalized = feature.trim().toLowerCase();

  // Keep capability copy such as "AI image generation" and structural limits
  // such as "10 brand kits". Only remove a feature when it names one of the
  // metered AI media types and carries a quota marker.
  const namesMeteredMedia = /\b(?:ai\s+)?(?:captions?|images?|videos?)\b/.test(
    normalized,
  );
  if (!namesMeteredMedia) return false;

  const hasNumericQuota =
    /\b\d+(?:\.\d+)?\s*(?:ai\s+)?(?:captions?|images?|videos?)\b/.test(normalized) ||
    /\b(?:ai\s+)?(?:captions?|images?|videos?)\s*(?:quota|allowance)\b/.test(
      normalized,
    );
  const hasUnlimitedQuota = /\b(?:unlimited|no\s+limit)\b/.test(normalized);
  const hasMonthlyQuota = /\b(?:per|\/)\s*(?:month|mo)\b/.test(normalized);

  return hasNumericQuota || hasUnlimitedQuota || hasMonthlyQuota;
}

function formatMonthlyCredits(monthlyCredits: number | null | undefined): string {
  const credits = Number.isFinite(monthlyCredits) ? Math.max(0, monthlyCredits!) : 0;
  if (credits === 0) return "No included credits";
  const display = Number.isInteger(credits) ? String(credits) : String(credits);
  return `${display} credits per month`;
}

/**
 * Returns the feature copy that customer-facing plan cards should display.
 *
 * This is deliberately presentation-only. It does not alter the plan
 * catalogue or persisted feature arrays. Quota and wallet plans retain their
 * stored copy exactly; only credits plans receive the shared-balance wording
 * and a value derived from the plan's real monthly allowance.
 */
export function getDisplayedPlanFeatures(
  plan: PlanFeaturePresentationInput,
): string[] {
  if (plan.billingMode !== "credits") return [...plan.features];

  const features = plan.features.filter((feature) => !isLegacyAiQuotaFeature(feature));
  const creditFeatures = [
    formatMonthlyCredits(plan.monthlyCredits),
    SHARED_CREDIT_BALANCE_FEATURE,
  ];

  // Avoid duplicate copy if an admin has already included either sentence in
  // the editable feature list.
  return [
    ...creditFeatures,
    ...features.filter(
      (feature) => !creditFeatures.some((creditFeature) => creditFeature === feature),
    ),
  ];
}
