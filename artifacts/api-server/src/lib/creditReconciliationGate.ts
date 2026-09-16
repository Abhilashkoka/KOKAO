/**
 * Release gate for credit enforcement.
 *
 * Provider-invoice reconciliation remains a separate, explicit no-go verdict.
 * Customer-facing production credit enforcement has its own, narrowly scoped
 * saved-rate rollout authorization. Keeping those decisions separate is
 * important: an invoice verdict must not be implied by a customer policy
 * decision, and a copied development setting must never charge production.
 */
export type CreditReconciliationVerdict = "go" | "no-go";

export interface CreditReconciliationGate {
  verdict: CreditReconciliationVerdict;
  reason: string;
}

export const CREDIT_RECONCILIATION_GATE: CreditReconciliationGate = Object.freeze({
  verdict: "no-go",
  reason:
    "A complete production shadow window and matching provider invoices have not been verified; provider-invoice reconciliation remains no-go.",
});

/**
 * Explicit, development-only opt-in for exercising real credit deductions.
 *
 * This is intentionally not set by the application. A developer may provide
 * it after reviewing the saved rate card and audit plan. `NODE_ENV` must be
 * exactly "development" and a Replit deployment must not be present, so a
 * copied setting cannot enable deductions in production.
 */
export const DEVELOPMENT_CREDIT_ENFORCEMENT_SETTING =
  "CREDIT_ENFORCEMENT_DEV";

/** Exact production rollout authorization. The bootstrap validates the
 * accompanying rate/plan manifest before the process starts serving traffic. */
export const PRODUCTION_CREDIT_ENFORCEMENT_SETTING =
  "CREDIT_ENFORCEMENT_PROD";
export const PRODUCTION_CREDIT_ENFORCEMENT_VERSION = "saved-rates-v1";
export const PRODUCTION_CREDIT_ROLLOUT_MANIFEST_SETTING =
  "CREDIT_PRODUCTION_ROLLOUT_JSON";

export interface CreditEnforcementDecision {
  allowed: boolean;
  scope: "development" | "production";
  reason: string;
}

export function isDevelopmentCreditEnforcementEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    env.NODE_ENV === "development" &&
    env.REPLIT_DEPLOYMENT !== "1" &&
    env[DEVELOPMENT_CREDIT_ENFORCEMENT_SETTING] === "1"
  );
}

export function isProductionCreditEnforcementEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    env.NODE_ENV === "production" &&
    env.REPLIT_DEPLOYMENT === "1" &&
    env[PRODUCTION_CREDIT_ENFORCEMENT_SETTING] ===
      PRODUCTION_CREDIT_ENFORCEMENT_VERSION
  );
}

/** Return the current authorization to write the persisted enforce setting.
 * The customer saved-rate rollout and the provider-invoice verdict are
 * intentionally independent decisions. */
export function getCreditEnforcementDecision(
  env: NodeJS.ProcessEnv = process.env,
): CreditEnforcementDecision {
  if (isDevelopmentCreditEnforcementEnabled(env)) {
    return {
      allowed: true,
      scope: "development",
      reason:
        "Explicit local development credit enforcement is enabled; verify the saved rate card and audit deductions before use.",
    };
  }

  if (isProductionCreditEnforcementEnabled(env)) {
    return {
      allowed: true,
      scope: "production",
      reason:
        "Production saved-rate credit enforcement is explicitly authorized; provider-invoice reconciliation remains a separate no-go verdict.",
    };
  }

  const developmentIdentity =
    env.NODE_ENV === "development" && env.REPLIT_DEPLOYMENT !== "1";
  const productionIdentity =
    env.NODE_ENV === "production" && env.REPLIT_DEPLOYMENT === "1";
  return {
    allowed: false,
    scope: developmentIdentity ? "development" : "production",
    reason: developmentIdentity
      ? `Development credit enforcement is disabled; set ${DEVELOPMENT_CREDIT_ENFORCEMENT_SETTING}=1 only after rate-card review.`
      : productionIdentity
        ? `Production saved-rate enforcement is disabled; set ${PRODUCTION_CREDIT_ENFORCEMENT_SETTING}=${PRODUCTION_CREDIT_ENFORCEMENT_VERSION} with a reviewed rollout manifest.`
      : CREDIT_RECONCILIATION_GATE.reason,
  };
}

export function isCreditEnforcementAllowed(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return getCreditEnforcementDecision(env).allowed;
}

export function creditEnforcementLockReason(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return getCreditEnforcementDecision(env).reason;
}