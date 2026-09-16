/**
 * Release gate for credit enforcement.
 *
 * The production decision remains an explicit no-go until a complete shadow
 * window has been checked against provider invoices. Development is a separate
 * decision: it may be enabled only with an explicit local setting and a
 * fail-closed runtime identity check. In particular, this must not become a
 * broad "gate is go" environment switch that can accidentally charge a
 * deployed worker.
 */
export type CreditReconciliationVerdict = "go" | "no-go";

export interface CreditReconciliationGate {
  verdict: CreditReconciliationVerdict;
  reason: string;
}

export const CREDIT_RECONCILIATION_GATE: CreditReconciliationGate = Object.freeze({
  verdict: "no-go",
  reason:
    "A complete production shadow window and matching provider invoices have not been verified; reconcile shadow usage against provider invoices before enabling credit enforcement.",
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

/**
 * Return the current authorization to write the persisted enforce setting.
 *
 * `CREDIT_RECONCILIATION_GATE.verdict` is deliberately still no-go in the
 * shipped production policy. Keeping the test seam here lets algorithm tests
 * mock a reviewed gate without changing the production constant or pretending
 * invoice evidence exists.
 */
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

  if (CREDIT_RECONCILIATION_GATE.verdict === "go") {
    return {
      allowed: true,
      scope: "production",
      reason: "Production credit enforcement was explicitly released after invoice reconciliation.",
    };
  }

  const developmentIdentity =
    env.NODE_ENV === "development" && env.REPLIT_DEPLOYMENT !== "1";
  return {
    allowed: false,
    scope: developmentIdentity ? "development" : "production",
    reason: developmentIdentity
      ? `Development credit enforcement is disabled; set ${DEVELOPMENT_CREDIT_ENFORCEMENT_SETTING}=1 only after rate-card review.`
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