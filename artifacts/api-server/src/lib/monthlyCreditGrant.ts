import { db, planSettingsTable, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { grantCredits, peekCreditBalance } from "./creditAccounts";
import { getPlan } from "./plans";

/**
 * The monthly credit allowance.
 *
 * Nothing in KOKAO granted a recurring allowance into a balance before this:
 * quota was COUNTED (usage tallied and compared against a plan limit), never
 * DEPOSITED. A credit balance needs the opposite — credits have to actually
 * arrive each period, or a subscription buys nothing.
 *
 * Called from both gateway webhooks when a subscription period is paid.
 *
 * Idempotency is the whole safety story here. Payment webhooks are redelivered
 * routinely — Razorpay and Cashfree both retry until they get a 2xx, and a
 * retry after a slow response is normal, not exceptional. A grant that ran
 * twice is free money, so every grant carries a key derived from the tenant
 * and the period, and the ledger's unique index makes a repeat a no-op.
 */

export const DEFAULT_GRANT_EXPIRY_DAYS = Number(
  process.env.CREDIT_GRANT_EXPIRY_DAYS ?? 90,
);

/** `plan:<tenantId>:<periodEnd ISO>` — one grant per workspace per period. */
export function monthlyGrantKey(tenantId: number, periodEnd: Date | string): string {
  const iso = typeof periodEnd === "string" ? periodEnd : periodEnd.toISOString();
  return `plan:${tenantId}:${iso}`;
}

/**
 * How many credits a plan grants per period. Reads the superadmin-editable
 * plan row, falling back to the built-in catalog.
 */
export async function monthlyCreditsForPlan(planId: string): Promise<number> {
  const [row] = await db
    .select({ monthlyCredits: planSettingsTable.monthlyCredits })
    .from(planSettingsTable)
    .where(eq(planSettingsTable.id, planId))
    .limit(1);
  if (row && Number.isFinite(row.monthlyCredits)) return Math.max(0, row.monthlyCredits);
  // A plan with no row uses the catalog default, which carries no allowance
  // until a superadmin sets one.
  await getPlan(planId).catch(() => null);
  return 0;
}

export interface GrantMonthlyCreditsInput {
  tenantId: number;
  /** The plan being paid for. Falls back to the tenant's current plan. */
  planId?: string | null;
  /**
   * End of the paid period. This is what makes the grant idempotent, so it
   * must come from the gateway event rather than from `now()` — two
   * redeliveries an hour apart would otherwise produce two different keys.
   */
  periodEnd: Date | string;
  /** Overrides the platform default expiry for this grant. */
  expiresInDays?: number | null;
}

/**
 * Grant one period's allowance. Safe to call repeatedly for the same period.
 *
 * Returns the credits actually granted — 0 when the plan has no allowance, or
 * when this period was already granted.
 */
export async function grantMonthlyCredits(
  input: GrantMonthlyCreditsInput,
): Promise<number> {
  let planId = input.planId ?? null;
  if (!planId) {
    const [tenant] = await db
      .select({ plan: tenantsTable.plan })
      .from(tenantsTable)
      .where(eq(tenantsTable.id, input.tenantId))
      .limit(1);
    planId = tenant?.plan ?? null;
  }
  if (!planId) return 0;

  const credits = await monthlyCreditsForPlan(planId);
  if (credits <= 0) return 0;

  const key = monthlyGrantKey(input.tenantId, input.periodEnd);
  const before = await peekCreditBalance(input.tenantId);
  const after = await grantCredits({
    tenantId: input.tenantId,
    credits,
    kind: "grant_plan",
    expiresInDays: input.expiresInDays ?? DEFAULT_GRANT_EXPIRY_DAYS,
    idempotencyKey: key,
    note: `${planId} monthly allowance`,
  });

  // A no-op idempotent replay returns the balance unchanged; report 0 so a
  // caller logging "granted N" never overstates what happened.
  const granted = after.total > before.total ? credits : 0;
  if (granted > 0) {
    logger.info(
      { tenantId: input.tenantId, planId, credits },
      "Granted monthly credit allowance",
    );
  }
  return granted;
}

/**
 * Best-effort wrapper for webhook handlers: a bookkeeping failure must never
 * make a payment webhook return non-2xx, because the gateway would then retry
 * a payment that already succeeded.
 */
export async function grantMonthlyCreditsSafely(
  input: GrantMonthlyCreditsInput,
): Promise<void> {
  await grantMonthlyCredits(input).catch((err) =>
    logger.error(
      { err, tenantId: input.tenantId },
      "Monthly credit grant failed; subscription payment itself was unaffected",
    ),
  );
}
