import {
  db,
  creditAccountLedgerTable,
  planSettingsTable,
  subscriptionsTable,
  tenantsTable,
} from "@workspace/db";
import { and, eq, gte, lt } from "drizzle-orm";
import { logger } from "./logger";
import {
  grantCredits,
  hasCreditAccount,
  isCreditFunded,
  peekCreditBalance,
} from "./creditAccounts";
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
  // A plan with no override row falls back to the catalog, whose built-in
  // defaults carry no allowance until a superadmin sets one.
  const plan = await getPlan(planId).catch(() => null);
  return Math.max(0, plan?.monthlyCredits ?? 0);
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

interface UtcCalendarPeriod {
  key: string;
  start: Date;
  end: Date;
}

function currentUtcCalendarPeriod(now = new Date()): UtcCalendarPeriod {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return {
    key: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`,
    start,
    end,
  };
}

/**
 * A paid-period grant may use either a gateway period-end key (an ISO date),
 * or the calendar-month key used by the lazy path. Treat both as the same
 * period when deciding whether the lazy path has anything left to do.
 *
 * The gateway is the source of truth for paid grants. This check is an
 * additional conservative guard for a read racing a late webhook or following
 * a subscription that has just ended.
 */
async function hasPlanGrantInPeriod(
  tenantId: number,
  period: UtcCalendarPeriod,
): Promise<boolean> {
  const rows = await db
    .select({
      idempotencyKey: creditAccountLedgerTable.idempotencyKey,
      createdAt: creditAccountLedgerTable.createdAt,
    })
    .from(creditAccountLedgerTable)
    .where(
      and(
        eq(creditAccountLedgerTable.tenantId, tenantId),
        eq(creditAccountLedgerTable.kind, "grant_plan"),
      ),
    );

  const prefix = `plan:${tenantId}:`;
  return rows.some((row) => {
    const key = row.idempotencyKey ?? "";
    const suffix = key.startsWith(prefix) ? key.slice(prefix.length) : "";
    const keyedDate = suffix ? new Date(suffix) : null;
    if (keyedDate && !Number.isNaN(keyedDate.getTime())) {
      return keyedDate >= period.start && keyedDate < period.end;
    }
    // "activation" has no period-end in the provider payload. Its creation
    // month is the only safe period identity available to us.
    return row.createdAt >= period.start && row.createdAt < period.end;
  });
}

/**
 * The migration's quota allowance is deliberately non-expiring and lands in
 * the purchased bucket. A lazy grant in that same calendar period would give
 * the workspace the allowance twice. Do not infer migration completion from
 * account creation alone; inspect the canonical migration ledger receipt.
 */
async function wasMigratedInPeriod(
  tenantId: number,
  period: UtcCalendarPeriod,
): Promise<boolean> {
  const [row] = await db
    .select({ id: creditAccountLedgerTable.id })
    .from(creditAccountLedgerTable)
    .where(
      and(
        eq(creditAccountLedgerTable.tenantId, tenantId),
        eq(creditAccountLedgerTable.kind, "migrate"),
        gte(creditAccountLedgerTable.createdAt, period.start),
        lt(creditAccountLedgerTable.createdAt, period.end),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * A subscription can remain entitled while it is marked cancel-at-period-end,
 * and gateway webhooks can temporarily leave a terminal status on a row whose
 * paid period has not ended. Treat either an active status or a future period
 * end as entitlement. This intentionally fails closed: a stale active row may
 * delay a free grant, but can never create a duplicate paid allowance.
 */
async function hasCurrentGatewayEntitlement(tenantId: number): Promise<boolean> {
  const rows = await db
    .select({
      status: subscriptionsTable.status,
      currentPeriodEnd: subscriptionsTable.currentPeriodEnd,
    })
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.tenantId, tenantId));
  const now = Date.now();
  return rows.some(
    (row) =>
      row.status === "active" ||
      row.status === "authenticated" ||
      Boolean(row.currentPeriodEnd && row.currentPeriodEnd.getTime() > now),
  );
}

/**
 * The allowance for workspaces no payment webhook will ever fire for.
 *
 * Paid plans get their credits on `subscription.charged` / an entitled
 * Cashfree cycle, keyed to the gateway's own period. A free plan has no
 * gateway, no subscription and no period — so without this, a free workspace
 * would hold a plan that advertises an allowance and a balance that stays at
 * zero, and the first thing it would ever see of the credit system is being
 * refused.
 *
 * Scope is deliberately conservative: the workspace must explicitly be on
 * the credit rail and the release-gated meter must be enforcing. A null
 * catalog price is not an eligibility signal — manual-only plans can still
 * have a live gateway subscription, and catalog prices can be edited.
 *
 * The account must already exist. This read path must never create the marker
 * used by credit migration, otherwise a GET /credits before migration would
 * make the migration skip the workspace's legacy balance. Existing plan-grant
 * and migration receipts are checked as a second line of defence against
 * overlapping a paid or migrated allowance.
 *
 * The period is the calendar month, and the key is the same shape the webhook
 * path uses, so the ledger's unique index makes repeat calls free. This is
 * called on a read (the balance endpoint), which keeps it lazy — no cron, and
 * a workspace that never opens the app is never granted credits it would not
 * have spent.
 */
export async function grantUnbilledPlanCredits(tenantId: number): Promise<number> {
  const [tenant] = await db
    .select({ plan: tenantsTable.plan })
    .from(tenantsTable)
    .where(eq(tenantsTable.id, tenantId))
    .limit(1);
  if (!tenant?.plan) return 0;

  // A lazy read is only allowed to fund the explicitly selected credit rail
  // while enforcement is live. isCreditFunded also applies the reconciliation
  // release gate, so a stored "enforce" value remains shadow until go-live.
  if (!(await isCreditFunded(tenantId))) return 0;

  // Never create an account from this read path. The migration uses account
  // existence as its once-only guard, so an account-less legacy workspace must
  // remain untouched until the migration has had a chance to inspect it.
  if (!(await hasCreditAccount(tenantId))) return 0;

  if (await hasCurrentGatewayEntitlement(tenantId)) return 0;

  const credits = await monthlyCreditsForPlan(tenant.plan);
  if (credits <= 0) return 0;

  const period = currentUtcCalendarPeriod();
  if (
    (await hasPlanGrantInPeriod(tenantId, period)) ||
    (await wasMigratedInPeriod(tenantId, period))
  ) {
    return 0;
  }

  const before = await peekCreditBalance(tenantId);
  const after = await grantCredits({
    tenantId,
    credits,
    kind: "grant_plan",
    expiresInDays: DEFAULT_GRANT_EXPIRY_DAYS,
    idempotencyKey: monthlyGrantKey(tenantId, period.key),
    note: `${tenant.plan} monthly allowance`,
  });
  return after.total > before.total ? credits : 0;
}

/** Best-effort wrapper: a grant failure must never fail the read it rode in on. */
export async function grantUnbilledPlanCreditsSafely(tenantId: number): Promise<void> {
  await grantUnbilledPlanCredits(tenantId).catch((err) =>
    logger.warn({ err, tenantId }, "Unbilled plan credit grant failed"),
  );
}
