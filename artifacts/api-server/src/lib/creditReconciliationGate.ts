/**
 * Release gate for credit enforcement.
 *
 * This is deliberately a pure, explicit decision rather than an environment
 * switch. Enforcement stays locked until a complete production shadow window
 * has been checked against a real provider invoice.
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