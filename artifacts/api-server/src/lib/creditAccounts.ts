import {
  db,
  creditAccountsTable,
  creditAccountLedgerTable,
  tenantsTable,
  type CreditAccount,
} from "@workspace/db";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { logger } from "./logger";
import { MILLI, getMeterMode, type MeterMode } from "./creditRates";

/**
 * The credit balance: grant, spend, refund, expire.
 *
 * Two buckets per workspace. `granted` credits (a plan allowance, a signup
 * bonus, a promo) expire; `purchased` credits never do. Spending draws from
 * granted first so an allowance gets used before it lapses.
 *
 * Every mutation happens inside one transaction holding SELECT ... FOR UPDATE
 * on the account row, with a matching ledger append, so the ledger always sums
 * to the balance and two concurrent generations can never spend the same
 * credit twice — the same discipline lib/wallet.ts applies to rupees.
 */

export class InsufficientCreditsError extends Error {
  readonly requiredMilli: number;
  readonly availableMilli: number;
  constructor(requiredMilli: number, availableMilli: number) {
    super("Not enough credits");
    this.name = "InsufficientCreditsError";
    this.requiredMilli = requiredMilli;
    this.availableMilli = availableMilli;
  }
}

export interface CreditBalance {
  /** Paid-for credits. Never expire. */
  purchased: number;
  /** Allowance and bonus credits, which do expire. */
  granted: number;
  /** What the workspace can actually spend right now. */
  total: number;
  grantedExpiresAt: string | null;
}

export type GrantKind =
  | "grant_plan"
  | "grant_signup"
  | "grant_promo"
  | "grant_admin"
  | "purchase"
  | "migrate";

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface AccountState {
  purchasedMilli: number;
  grantedMilli: number;
  grantedExpiresAt: Date | null;
}

function toBalance(state: AccountState): CreditBalance {
  return {
    purchased: state.purchasedMilli / MILLI,
    granted: state.grantedMilli / MILLI,
    total: (state.purchasedMilli + state.grantedMilli) / MILLI,
    grantedExpiresAt: state.grantedExpiresAt
      ? state.grantedExpiresAt.toISOString()
      : null,
  };
}

/**
 * Take the row lock, creating the account first if this workspace has never
 * had one. Locking a row that does not exist locks nothing, so without the
 * upsert two concurrent first movements would both fall through to an INSERT
 * and one would die on the primary key — losing a paid top-up.
 *
 * Expiry is applied here, inside the lock, so nothing downstream can read a
 * balance that includes credits which have already lapsed.
 */
async function lockAccount(
  tx: DbTransaction,
  tenantId: number,
): Promise<AccountState> {
  await tx
    .insert(creditAccountsTable)
    .values({ tenantId })
    .onConflictDoNothing({ target: creditAccountsTable.tenantId });
  const [row] = await tx
    .select()
    .from(creditAccountsTable)
    .where(eq(creditAccountsTable.tenantId, tenantId))
    .for("update");

  const state: AccountState = {
    purchasedMilli: row?.purchasedMilli ?? 0,
    grantedMilli: row?.grantedMilli ?? 0,
    grantedExpiresAt: row?.grantedExpiresAt ?? null,
  };

  if (
    state.grantedMilli > 0 &&
    state.grantedExpiresAt &&
    state.grantedExpiresAt.getTime() <= Date.now()
  ) {
    const lapsed = state.grantedMilli;
    state.grantedMilli = 0;
    state.grantedExpiresAt = null;
    await tx
      .update(creditAccountsTable)
      .set({ grantedMilli: 0, grantedExpiresAt: null, updatedAt: new Date() })
      .where(eq(creditAccountsTable.tenantId, tenantId));
    await tx.insert(creditAccountLedgerTable).values({
      tenantId,
      kind: "expire",
      grantedDeltaMilli: -lapsed,
      balanceAfterMilli: state.purchasedMilli,
      note: "Granted credits expired",
    });
  }

  return state;
}

async function writeState(
  tx: DbTransaction,
  tenantId: number,
  state: AccountState,
): Promise<void> {
  await tx
    .update(creditAccountsTable)
    .set({
      purchasedMilli: state.purchasedMilli,
      grantedMilli: state.grantedMilli,
      grantedExpiresAt:
        state.grantedMilli === 0 ? null : state.grantedExpiresAt,
      updatedAt: new Date(),
    })
    .where(eq(creditAccountsTable.tenantId, tenantId));
}

/** What this workspace can spend right now, with expiry already applied. */
export async function getCreditBalance(
  tenantId: number,
): Promise<CreditBalance> {
  return toBalance(
    await db.transaction(async (tx) => lockAccount(tx, tenantId)),
  );
}

/** A cheap read that takes no lock, for display where staleness is fine. */
export async function peekCreditBalance(
  tenantId: number,
): Promise<CreditBalance> {
  const [row] = await db
    .select()
    .from(creditAccountsTable)
    .where(eq(creditAccountsTable.tenantId, tenantId))
    .limit(1);
  const lapsed = Boolean(
    row?.grantedExpiresAt && row.grantedExpiresAt.getTime() <= Date.now(),
  );
  return toBalance({
    purchasedMilli: row?.purchasedMilli ?? 0,
    grantedMilli: lapsed ? 0 : (row?.grantedMilli ?? 0),
    grantedExpiresAt: lapsed ? null : (row?.grantedExpiresAt ?? null),
  });
}

/**
 * Read every canonical account in one query for admin listings. This is the
 * display equivalent of peekCreditBalance: expired grants are omitted without
 * creating an account or writing an expiry receipt. Keeping this batched is
 * important because the admin workspace table can contain hundreds of rows.
 */
export async function peekCreditBalancesByTenant(
  tenantIds?: number[],
): Promise<Map<number, CreditBalance>> {
  const rows = await db
    .select()
    .from(creditAccountsTable)
    .where(
      tenantIds && tenantIds.length > 0
        ? inArray(creditAccountsTable.tenantId, tenantIds)
        : undefined,
    );
  const now = Date.now();
  return new Map(
    rows.map((row) => {
      const expired = Boolean(
        row.grantedExpiresAt && row.grantedExpiresAt.getTime() <= now,
      );
      return [
        row.tenantId,
        toBalance({
          purchasedMilli: row.purchasedMilli,
          grantedMilli: expired ? 0 : row.grantedMilli,
          grantedExpiresAt: expired ? null : row.grantedExpiresAt,
        }),
      ];
    }),
  );
}

export interface GrantCreditsInput {
  tenantId: number;
  /** Whole credits (fractions allowed); negative only valid for grant_admin. */
  credits: number;
  kind: GrantKind;
  /**
   * How long a granted bucket lives. Omitted for `purchase` and `migrate`,
   * which never expire. When the bucket already holds credits, the LATER of
   * the two expiry dates wins, so a new allowance never shortens the life of
   * credits already on the balance.
   */
  expiresInDays?: number | null;
  /**
   * Makes the grant idempotent. A redelivered webhook carrying the same key is
   * a no-op that returns the current balance rather than granting twice.
   */
  idempotencyKey?: string | null;
  note?: string | null;
}

/**
 * Add credits. `purchase` and `migrate` land in the never-expiring bucket;
 * every other kind lands in the expiring one.
 */
export async function grantCredits(
  input: GrantCreditsInput,
  transaction?: DbTransaction,
): Promise<CreditBalance> {
  const deltaMilli = Math.round((Number(input.credits) || 0) * MILLI);
  const toPurchased = input.kind === "purchase" || input.kind === "migrate";
  if (deltaMilli < 0 && input.kind !== "grant_admin") {
    throw new Error("Only an admin adjustment may remove credits");
  }

  const apply = async (tx: DbTransaction): Promise<CreditBalance> => {
    const before = await lockAccount(tx, input.tenantId);
    if (input.idempotencyKey) {
      const [seen] = await tx
        .select({ id: creditAccountLedgerTable.id })
        .from(creditAccountLedgerTable)
        .where(
          and(
            eq(creditAccountLedgerTable.tenantId, input.tenantId),
            eq(creditAccountLedgerTable.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (seen) return toBalance(before);
    }

    // A negative admin adjustment can empty a bucket but never drive it below
    // zero. The ledger records what was ACTUALLY applied, so totals reconcile.
    const after: AccountState = {
      purchasedMilli: toPurchased
        ? Math.max(0, before.purchasedMilli + deltaMilli)
        : before.purchasedMilli,
      grantedMilli: toPurchased
        ? before.grantedMilli
        : Math.max(0, before.grantedMilli + deltaMilli),
      grantedExpiresAt: before.grantedExpiresAt,
    };

    if (!toPurchased && deltaMilli > 0 && input.expiresInDays) {
      // A legacy/admin goodwill balance with no deadline is deliberately
      // preserved as non-expiring when a later expiring grant is added. The
      // old value must never be made destructively expiring by a migration or
      // by merely sharing the granted bucket.
      if (!(before.grantedMilli > 0 && before.grantedExpiresAt === null)) {
        const candidate = new Date(
          Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000,
        );
        after.grantedExpiresAt =
          after.grantedExpiresAt && after.grantedExpiresAt > candidate
            ? after.grantedExpiresAt
            : candidate;
      }
    }
    if (after.grantedMilli === 0) after.grantedExpiresAt = null;

    await writeState(tx, input.tenantId, after);
    await tx.insert(creditAccountLedgerTable).values({
      tenantId: input.tenantId,
      kind: input.kind,
      purchasedDeltaMilli: after.purchasedMilli - before.purchasedMilli,
      grantedDeltaMilli: after.grantedMilli - before.grantedMilli,
      balanceAfterMilli: after.purchasedMilli + after.grantedMilli,
      idempotencyKey: input.idempotencyKey ?? null,
      note: input.note ?? null,
    });
    return toBalance(after);
  };
  // Callers that already hold a business transaction (for example, a
  // referral redemption) can keep the account grant and its own receipt
  // atomic. Existing callers retain the one-transaction convenience API.
  return transaction ? apply(transaction) : db.transaction(apply);
}

export interface SpendCreditsInput {
  tenantId: number;
  /** Cost in MILLI-credits, as the rate card computed it. */
  creditsMilli: number;
  rateKey?: string | null;
  refKind?: string | null;
  refId?: string | null;
  /** Pass a job's operation key so a retried settle cannot double-charge. */
  idempotencyKey?: string | null;
  /**
   * Meter-only retry allocation. The stable idempotency key is treated as a
   * base identity; another ordinal is allowed only after the prior ordinal has
   * a persisted matching refund receipt.
   */
  retryAfterRefund?: boolean;
  refundIdempotencyKey?: string | null;
  note?: string | null;
  /**
   * A meter spend can create its dispatch-intent receipt in the same
   * transaction as the debit.  That receipt is deliberately separate from
   * the spend row: if it is still "pending" after a restart, no provider call
   * was started and the debit can be recovered safely.
   */
  meterDispatch?: {
    /**
     * Optional explicit key for callers that already know the concrete
     * attempt. The meter leaves this unset because retry ordinals are selected
     * inside this transaction.
     */
    pendingKey?: string;
    refundKey: string;
    creditsMilli: number;
    rateKey?: string | null;
    refKind?: string | null;
    refId?: string | null;
  };
}

/**
 * Meter lifecycle receipts live in the existing append-only account ledger.
 * They have zero deltas, so they do not change the balance or the historical
 * spend/refund totals.  Keeping the lifecycle beside the debit gives the
 * recovery worker a durable, tenant-scoped source of truth without introducing
 * a second outbox table (and without ever treating a provider timeout as a
 * safe replay).
 */
export const CREDIT_METER_DISPATCH_PENDING_KIND = "meter_dispatch_pending";
export const CREDIT_METER_DISPATCH_STARTED_KIND = "meter_dispatch_started";
export const CREDIT_METER_DISPATCH_SUCCEEDED_KIND = "meter_dispatch_succeeded";
export const CREDIT_METER_DISPATCH_FAILED_KIND = "meter_dispatch_failed";
export const CREDIT_METER_DISPATCH_AMBIGUOUS_KIND = "meter_dispatch_ambiguous";
export const CREDIT_METER_REFUND_PENDING_KIND = "refund_pending";
/**
 * A pending dispatch receipt is not immediately safe to refund: a live
 * process may have committed the debit and be between the receipt and its
 * started marker. Recovery only claims it after this lease/grace period.
 */
export const CREDIT_METER_PENDING_GRACE_MS = 5 * 60_000;

const METER_LIFECYCLE_KINDS = [
  CREDIT_METER_DISPATCH_PENDING_KIND,
  CREDIT_METER_DISPATCH_STARTED_KIND,
  CREDIT_METER_DISPATCH_SUCCEEDED_KIND,
  CREDIT_METER_DISPATCH_FAILED_KIND,
  CREDIT_METER_DISPATCH_AMBIGUOUS_KIND,
  CREDIT_METER_REFUND_PENDING_KIND,
] as const;

type MeterLifecycleKind = (typeof METER_LIFECYCLE_KINDS)[number];

interface MeterLifecycleNote {
  version: 1;
  spendKey: string;
  refundKey: string;
  creditsMilli: number;
  rateKey?: string | null;
  refKind?: string | null;
  refId?: string | null;
  actualQuantity?: number | null;
  authoritativeCostMilli?: number | null;
  error?: string | null;
}

function meterMarkerKey(
  spendKey: string,
  phase: "pending" | "started" | "succeeded" | "failed" | "ambiguous",
): string {
  return `${spendKey}:dispatch:${phase}`;
}

export function meterRefundPendingKey(refundKey: string): string {
  return `${refundKey}:pending`;
}

function meterLifecycleNote(input: {
  spendKey: string;
  refundKey: string;
  creditsMilli: number;
  rateKey?: string | null;
  refKind?: string | null;
  refId?: string | null;
  actualQuantity?: number | null;
  authoritativeCostMilli?: number | null;
  error?: string | null;
}): string {
  return JSON.stringify({
    version: 1,
    spendKey: input.spendKey,
    refundKey: input.refundKey,
    creditsMilli: input.creditsMilli,
    rateKey: input.rateKey ?? null,
    refKind: input.refKind ?? null,
    refId: input.refId ?? null,
    actualQuantity: input.actualQuantity ?? null,
    authoritativeCostMilli: input.authoritativeCostMilli ?? null,
    error: input.error ?? null,
  } satisfies MeterLifecycleNote);
}

function parseMeterLifecycleNote(note: string | null): MeterLifecycleNote | null {
  if (!note) return null;
  try {
    const value = JSON.parse(note) as Partial<MeterLifecycleNote>;
    if (
      value.version !== 1 ||
      typeof value.spendKey !== "string" ||
      typeof value.refundKey !== "string" ||
      typeof value.creditsMilli !== "number" ||
      !Number.isSafeInteger(value.creditsMilli) ||
      value.creditsMilli < 0
    ) {
      return null;
    }
    return value as MeterLifecycleNote;
  } catch {
    return null;
  }
}

function meterPendingLeaseExpired(
  row: CreditAccountLedgerEntry,
  now = Date.now(),
): boolean {
  const createdAtMs = row.createdAt instanceof Date
    ? row.createdAt.getTime()
    : new Date(row.createdAt).getTime();
  return (
    Number.isFinite(createdAtMs) &&
    createdAtMs <= now - CREDIT_METER_PENDING_GRACE_MS
  );
}

async function appendMeterLifecycle(
  tx: DbTransaction,
  input: {
    tenantId: number;
    kind: MeterLifecycleKind;
    idempotencyKey: string;
    note: MeterLifecycleNote;
    rateKey?: string | null;
    refKind?: string | null;
    refId?: string | null;
  },
): Promise<void> {
  const [seen] = await tx
    .select({ id: creditAccountLedgerTable.id })
    .from(creditAccountLedgerTable)
    .where(
      and(
        eq(creditAccountLedgerTable.tenantId, input.tenantId),
        eq(creditAccountLedgerTable.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (seen) return;
  const [account] = await tx
    .select({
      purchasedMilli: creditAccountsTable.purchasedMilli,
      grantedMilli: creditAccountsTable.grantedMilli,
    })
    .from(creditAccountsTable)
    .where(eq(creditAccountsTable.tenantId, input.tenantId))
    .limit(1);
  await tx.insert(creditAccountLedgerTable).values({
    tenantId: input.tenantId,
    kind: input.kind,
    purchasedDeltaMilli: 0,
    grantedDeltaMilli: 0,
    balanceAfterMilli: (account?.purchasedMilli ?? 0) + (account?.grantedMilli ?? 0),
    rateKey: input.rateKey ?? null,
    refKind: input.refKind ?? null,
    refId: input.refId ?? null,
    idempotencyKey: input.idempotencyKey,
    note: meterLifecycleNote(input.note),
  });
}

/**
 * Mark the durable dispatch boundary immediately before invoking a provider.
 *
 * The account row is locked while this transition is committed.  A recovery
 * worker racing this call therefore either refunds before dispatch (and this
 * function refuses to start), or observes the started marker and leaves the
 * operation blocked for manual reconciliation.
 */
export async function markCreditMeterDispatchStarted(input: {
  tenantId: number;
  spendKey: string;
  refundKey: string;
  creditsMilli: number;
  rateKey?: string | null;
  refKind?: string | null;
  refId?: string | null;
}): Promise<void> {
  await db.transaction(async (tx) => {
    await lockAccount(tx, input.tenantId);
    const [refunded] = await tx
      .select({ id: creditAccountLedgerTable.id })
      .from(creditAccountLedgerTable)
      .where(
        and(
          eq(creditAccountLedgerTable.tenantId, input.tenantId),
          or(
            and(
              eq(
                creditAccountLedgerTable.idempotencyKey,
                input.refundKey,
              ),
              eq(creditAccountLedgerTable.kind, "refund"),
            ),
            and(
              eq(
                creditAccountLedgerTable.idempotencyKey,
                meterRefundPendingKey(input.refundKey),
              ),
              eq(
                creditAccountLedgerTable.kind,
                CREDIT_METER_REFUND_PENDING_KIND,
              ),
            ),
          ),
        ),
      )
      .limit(1);
    if (refunded) {
      throw new Error("Meter dispatch was already recovered before it started");
    }
    const [pending] = await tx
      .select({ id: creditAccountLedgerTable.id })
      .from(creditAccountLedgerTable)
      .where(
        and(
          eq(creditAccountLedgerTable.tenantId, input.tenantId),
          eq(
            creditAccountLedgerTable.idempotencyKey,
            meterMarkerKey(input.spendKey, "pending"),
          ),
          eq(
            creditAccountLedgerTable.kind,
            CREDIT_METER_DISPATCH_PENDING_KIND,
          ),
        ),
      )
      .limit(1);
    if (!pending) {
      throw new Error("Meter dispatch intent is missing");
    }
    await appendMeterLifecycle(tx, {
      tenantId: input.tenantId,
      kind: CREDIT_METER_DISPATCH_STARTED_KIND,
      idempotencyKey: meterMarkerKey(input.spendKey, "started"),
      note: {
        version: 1,
        spendKey: input.spendKey,
        refundKey: input.refundKey,
        creditsMilli: input.creditsMilli,
        rateKey: input.rateKey,
        refKind: input.refKind,
        refId: input.refId,
      },
      rateKey: input.rateKey,
      refKind: input.refKind,
      refId: input.refId,
    });
  });
}

/**
 * Persist a confirmed provider outcome before settling or returning output.
 * A succeeded marker is also the recovery record when a process dies between
 * the provider response and the normal quantity refund.
 */
export async function markCreditMeterDispatchOutcome(input: {
  tenantId: number;
  spendKey: string;
  refundKey: string;
  creditsMilli: number;
  outcome: "succeeded" | "failed" | "ambiguous";
  rateKey?: string | null;
  refKind?: string | null;
  refId?: string | null;
  actualQuantity?: number | null;
  authoritativeCostMilli?: number | null;
  error?: string | null;
}): Promise<void> {
  await db.transaction(async (tx) => {
    await lockAccount(tx, input.tenantId);
    await appendMeterLifecycle(tx, {
      tenantId: input.tenantId,
      kind:
        input.outcome === "succeeded"
          ? CREDIT_METER_DISPATCH_SUCCEEDED_KIND
          : input.outcome === "failed"
            ? CREDIT_METER_DISPATCH_FAILED_KIND
            : CREDIT_METER_DISPATCH_AMBIGUOUS_KIND,
      idempotencyKey: meterMarkerKey(input.spendKey, input.outcome),
      note: {
        version: 1,
        spendKey: input.spendKey,
        refundKey: input.refundKey,
        creditsMilli: input.creditsMilli,
        rateKey: input.rateKey,
        refKind: input.refKind,
        refId: input.refId,
        actualQuantity: input.actualQuantity,
        authoritativeCostMilli: input.authoritativeCostMilli,
        error: input.error,
      },
      rateKey: input.rateKey,
      refKind: input.refKind,
      refId: input.refId,
    });
  });
}

/**
 * Persist a confirmed provider failure and its exact refund outbox marker as
 * one account transaction. A later synchronous refund attempt may fail, but
 * the durable marker is then guaranteed to exist; if this transaction fails,
 * the started receipt remains ambiguous and recovery will not refund it.
 */
export async function markCreditMeterDispatchFailedWithRefund(input: {
  tenantId: number;
  spendKey: string;
  refundKey: string;
  creditsMilli: number;
  rateKey?: string | null;
  refKind?: string | null;
  refId?: string | null;
  error?: string | null;
}): Promise<void> {
  const amountMilli = Math.max(0, Math.round(input.creditsMilli));
  if (!Number.isSafeInteger(amountMilli)) {
    throw new Error("Credit refund amount is outside the supported range");
  }
  await db.transaction(async (tx) => {
    await lockAccount(tx, input.tenantId);
    await appendMeterLifecycle(tx, {
      tenantId: input.tenantId,
      kind: CREDIT_METER_DISPATCH_FAILED_KIND,
      idempotencyKey: meterMarkerKey(input.spendKey, "failed"),
      note: {
        version: 1,
        spendKey: input.spendKey,
        refundKey: input.refundKey,
        creditsMilli: amountMilli,
        rateKey: input.rateKey,
        refKind: input.refKind,
        refId: input.refId,
        error: input.error,
      },
      rateKey: input.rateKey,
      refKind: input.refKind,
      refId: input.refId,
    });
    await appendMeterLifecycle(tx, {
      tenantId: input.tenantId,
      kind: CREDIT_METER_REFUND_PENDING_KIND,
      idempotencyKey: meterRefundPendingKey(input.refundKey),
      note: {
        version: 1,
        spendKey: input.spendKey,
        refundKey: input.refundKey,
        creditsMilli: amountMilli,
        rateKey: input.rateKey,
        refKind: input.refKind,
        refId: input.refId,
        error: input.error ?? "meter provider failure",
      },
      rateKey: input.rateKey,
      refKind: input.refKind,
      refId: input.refId,
    });
  });
}

/** Queue an exact, idempotent meter refund before trying it synchronously. */
export async function queueCreditMeterRefund(input: {
  tenantId: number;
  refundKey: string;
  creditsMilli: number;
  rateKey?: string | null;
  refKind?: string | null;
  refId?: string | null;
  spendKey?: string | null;
  note?: string | null;
}): Promise<void> {
  const amountMilli = Math.max(0, Math.round(input.creditsMilli));
  if (!Number.isSafeInteger(amountMilli)) {
    throw new Error("Credit refund amount is outside the supported range");
  }
  const spendKey = input.spendKey ?? input.refundKey.replace(/^refund(?:-family)?:/, "spend:");
  await db.transaction(async (tx) => {
    await lockAccount(tx, input.tenantId);
    if (input.spendKey) {
      const lifecycleRows = await tx
        .select({
          kind: creditAccountLedgerTable.kind,
          idempotencyKey: creditAccountLedgerTable.idempotencyKey,
        })
        .from(creditAccountLedgerTable)
        .where(eq(creditAccountLedgerTable.tenantId, input.tenantId));
      const started = lifecycleRows.some(
        (row) =>
          row.kind === CREDIT_METER_DISPATCH_STARTED_KIND &&
          row.idempotencyKey === meterMarkerKey(input.spendKey!, "started"),
      );
      const outcome = lifecycleRows.some(
        (row) =>
          (row.kind === CREDIT_METER_DISPATCH_SUCCEEDED_KIND ||
            row.kind === CREDIT_METER_DISPATCH_FAILED_KIND) &&
          row.idempotencyKey !== null &&
          row.idempotencyKey.startsWith(`${input.spendKey}:dispatch:`),
      );
      if (started && !outcome) {
        throw new Error(
          "Cannot queue a meter refund for an ambiguous provider dispatch",
        );
      }
    }
    await appendMeterLifecycle(tx, {
      tenantId: input.tenantId,
      kind: CREDIT_METER_REFUND_PENDING_KIND,
      idempotencyKey: meterRefundPendingKey(input.refundKey),
      note: {
        version: 1,
        spendKey,
        refundKey: input.refundKey,
        creditsMilli: amountMilli,
        rateKey: input.rateKey,
        refKind: input.refKind,
        refId: input.refId,
        error: input.note,
      },
      rateKey: input.rateKey,
      refKind: input.refKind,
      refId: input.refId,
    });
  });
}

/**
 * Debit atomically, all-or-nothing. Throws `InsufficientCreditsError` when the
 * balance cannot cover it, so the caller answers 402 rather than doing work it
 * cannot bill for.
 *
 * Granted credits are spent first: they are the ones with an expiry date, and
 * burning purchased credits while an allowance lapses is the one outcome a
 * customer would rightly complain about.
 */
export interface SpendCreditsResult {
  balance: CreditBalance;
  /** False when this idempotency key had already been debited. */
  applied: boolean;
  /** Concrete persisted receipt selected for this attempt. */
  idempotencyKey?: string | null;
  /** Matching full-failure refund receipt for this attempt. */
  refundIdempotencyKey?: string | null;
  attemptOrdinal?: number | null;
}
export async function spendCredits(
  input: SpendCreditsInput,
): Promise<CreditBalance> {
  return (await spendCreditsOnce(input)).balance;
}

/**
 * Return credits for work that failed.
 *
 * Refunds land in the PURCHASED bucket regardless of which bucket paid. That
 * is deliberate and in the customer's favour: returning them to an expiring
 * bucket could hand back credits that lapse tomorrow, and a refund for a
 * failure that was never the customer's fault should not carry a deadline.
 */
export async function refundCredits(input: SpendCreditsInput): Promise<void> {
  const amountMilli = Math.max(0, Math.round(input.creditsMilli));
  if (!Number.isSafeInteger(amountMilli)) {
    throw new Error("Credit refund amount is outside the supported range");
  }
  await db.transaction(async (tx) => {
    const before = await lockAccount(tx, input.tenantId);
    if (input.idempotencyKey) {
      const [seen] = await tx
        .select({ id: creditAccountLedgerTable.id })
        .from(creditAccountLedgerTable)
        .where(
          and(
            eq(creditAccountLedgerTable.tenantId, input.tenantId),
            eq(creditAccountLedgerTable.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (seen) return;
    }
    const after: AccountState = {
      ...before,
      purchasedMilli: before.purchasedMilli + amountMilli,
    };
    await writeState(tx, input.tenantId, after);
    await tx.insert(creditAccountLedgerTable).values({
      tenantId: input.tenantId,
      kind: "refund",
      purchasedDeltaMilli: amountMilli,
      balanceAfterMilli: after.purchasedMilli + after.grantedMilli,
      rateKey: input.rateKey ?? null,
      refKind: input.refKind ?? null,
      refId: input.refId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      note: input.note ?? "Generation failed",
    });
  });
}

/**
 * Refund while leaving a durable retry receipt first.
 *
 * The old implementation logged and swallowed a database error. That made the
 * provider failure look handled while permanently consuming the customer's
 * credits. With an idempotency key, a pending marker is enough for the worker
 * to retry the exact same refund; a synchronous outage therefore remains
 * visible as pending rather than disappearing.
 */
export async function refundCreditsSafely(
  input: SpendCreditsInput,
): Promise<"refunded" | "pending"> {
  if (!input.idempotencyKey) {
    await refundCredits(input);
    return "refunded";
  }
  await queueCreditMeterRefund({
    tenantId: input.tenantId,
    refundKey: input.idempotencyKey,
    creditsMilli: input.creditsMilli,
    rateKey: input.rateKey,
    refKind: input.refKind,
    refId: input.refId,
    note: input.note,
  });
  try {
    await refundCredits(input);
    return "refunded";
  } catch (err) {
    logger.error(
      { err, tenantId: input.tenantId, refundKey: input.idempotencyKey },
      "credit refund queued for durable retry",
    );
    return "pending";
  }
}

export type CreditMeterRecoveryStatus = "refunded" | "pending" | "blocked";

export interface CreditMeterRecoveryResult {
  scanned: number;
  refunded: number;
  pending: number;
  blocked: number;
}

interface MeterLifecycleRows {
  pending: CreditAccountLedgerEntry;
  started?: CreditAccountLedgerEntry;
  succeeded?: CreditAccountLedgerEntry;
  failed?: CreditAccountLedgerEntry;
  ambiguous?: CreditAccountLedgerEntry;
  refundPending?: CreditAccountLedgerEntry;
  refund?: CreditAccountLedgerEntry;
}

type CreditAccountLedgerEntry = typeof creditAccountLedgerTable.$inferSelect;

async function meterLifecycleRows(
  tenantId: number,
  spendKey: string,
  refundKey: string,
): Promise<MeterLifecycleRows> {
  const rows = await db
    .select()
    .from(creditAccountLedgerTable)
    .where(eq(creditAccountLedgerTable.tenantId, tenantId));
  const byKey = new Map(rows.map((row) => [row.idempotencyKey, row]));
  const findKind = (
    key: string,
    kind: MeterLifecycleKind,
  ): CreditAccountLedgerEntry | undefined => {
    const row = byKey.get(key);
    return row?.kind === kind ? row : undefined;
  };
  return {
    pending:
      findKind(
        meterMarkerKey(spendKey, "pending"),
        CREDIT_METER_DISPATCH_PENDING_KIND,
      ) ?? rows.find(
        (row) =>
          row.kind === CREDIT_METER_DISPATCH_PENDING_KIND &&
          parseMeterLifecycleNote(row.note)?.spendKey === spendKey,
      )!,
    started: findKind(
      meterMarkerKey(spendKey, "started"),
      CREDIT_METER_DISPATCH_STARTED_KIND,
    ),
    succeeded: findKind(
      meterMarkerKey(spendKey, "succeeded"),
      CREDIT_METER_DISPATCH_SUCCEEDED_KIND,
    ),
    failed: findKind(
      meterMarkerKey(spendKey, "failed"),
      CREDIT_METER_DISPATCH_FAILED_KIND,
    ),
    ambiguous: findKind(
      meterMarkerKey(spendKey, "ambiguous"),
      CREDIT_METER_DISPATCH_AMBIGUOUS_KIND,
    ),
    refundPending: findKind(
      meterRefundPendingKey(refundKey),
      CREDIT_METER_REFUND_PENDING_KIND,
    ),
    refund: byKey.get(refundKey)?.kind === "refund" ? byKey.get(refundKey) : undefined,
  };
}

async function recoverOneCreditMeterLifecycle(
  pending: CreditAccountLedgerEntry,
): Promise<CreditMeterRecoveryStatus> {
  const intent = parseMeterLifecycleNote(pending.note);
  if (!intent) {
    logger.error(
      { tenantId: pending.tenantId, ledgerId: pending.id },
      "Credit meter lifecycle receipt is malformed; manual reconciliation required",
    );
    return "blocked";
  }

  // A generic refund caller can use the same durable marker even when it has
  // no meter dispatch-intent row. Recover that exact idempotent refund
  // directly; meter lifecycle rows take the stricter outcome path below.
  if (pending.kind === CREDIT_METER_REFUND_PENDING_KIND) {
    const [refund] = await db
      .select({ id: creditAccountLedgerTable.id })
      .from(creditAccountLedgerTable)
      .where(
        and(
          eq(creditAccountLedgerTable.tenantId, pending.tenantId),
          eq(creditAccountLedgerTable.idempotencyKey, intent.refundKey),
          eq(creditAccountLedgerTable.kind, "refund"),
        ),
      )
      .limit(1);
    if (refund) return "refunded";
    try {
      await refundCredits({
        tenantId: pending.tenantId,
        creditsMilli: intent.creditsMilli,
        rateKey: intent.rateKey,
        refKind: intent.refKind,
        refId: intent.refId,
        idempotencyKey: intent.refundKey,
        note: "Credit refund retry",
      });
      return "refunded";
    } catch (err) {
      logger.error(
        { err, tenantId: pending.tenantId, refundKey: intent.refundKey },
        "Credit refund outbox remains pending",
      );
      return "pending";
    }
  }

  const lifecycle = await meterLifecycleRows(
    pending.tenantId,
    intent.spendKey,
    intent.refundKey,
  );
  if (lifecycle.refund) return "refunded";

  // A fresh pending receipt may belong to a live process that has not yet
  // committed its started marker. Do not race it by refunding immediately;
  // the lease must expire first. An existing refund outbox marker means a
  // prior recovery already claimed the receipt and is safe to continue.
  if (
    !lifecycle.started &&
    !lifecycle.succeeded &&
    !lifecycle.failed &&
    !lifecycle.ambiguous &&
    !lifecycle.refundPending &&
    !meterPendingLeaseExpired(pending)
  ) {
    return "pending";
  }

  // A started request with no provider outcome is explicitly ambiguous. It
  // may have reached the provider even when this process saw an exception, so
  // never refund it and never redispatch it automatically.
  if (
    lifecycle.started &&
    !lifecycle.succeeded &&
    !lifecycle.failed &&
    !lifecycle.ambiguous
  ) {
    logger.warn(
      {
        tenantId: pending.tenantId,
        spendKey: intent.spendKey,
        refundKey: intent.refundKey,
      },
      "Credit meter provider dispatch is ambiguous; manual reconciliation required",
    );
    return "blocked";
  }
  if (lifecycle.ambiguous && !lifecycle.succeeded && !lifecycle.failed) {
    logger.warn(
      {
        tenantId: pending.tenantId,
        spendKey: intent.spendKey,
        refundKey: intent.refundKey,
      },
      "Credit meter dispatch outcome is ambiguous; manual reconciliation required",
    );
    return "blocked";
  }

  const needsRefund =
    !lifecycle.started ||
    Boolean(lifecycle.failed) ||
    Boolean(!lifecycle.succeeded && !lifecycle.ambiguous);
  const outcomeNote = lifecycle.succeeded
    ? parseMeterLifecycleNote(lifecycle.succeeded.note)
    : intent;
  const amountMilli =
    lifecycle.succeeded && outcomeNote?.authoritativeCostMilli !== null &&
    outcomeNote?.authoritativeCostMilli !== undefined
      ? Math.max(
          0,
          intent.creditsMilli - Math.max(0, outcomeNote.authoritativeCostMilli),
        )
      : intent.creditsMilli;
  const refundAmount = lifecycle.succeeded ? amountMilli : intent.creditsMilli;
  const recoveryRefundKey = lifecycle.succeeded
    ? `${intent.spendKey}:settle-refund`
    : intent.refundKey;

  // A confirmed failed outcome, and a pending intent that never reached the
  // started marker, are both safe to refund. A successful outcome only queues
  // the quantity difference; full successful work is never refunded.
  if (needsRefund || refundAmount > 0) {
    await queueCreditMeterRefund({
      tenantId: pending.tenantId,
      refundKey: recoveryRefundKey,
      creditsMilli: refundAmount,
      rateKey: intent.rateKey,
      refKind: intent.refKind,
      refId: intent.refId,
      spendKey: intent.spendKey,
      note: lifecycle.succeeded ? "meter quantity settlement" : "meter provider failure",
    });
    try {
      await refundCredits({
        tenantId: pending.tenantId,
        creditsMilli: refundAmount,
        rateKey: intent.rateKey,
        refKind: intent.refKind,
        refId: intent.refId,
        idempotencyKey: recoveryRefundKey,
        note: lifecycle.succeeded ? "Meter quantity settlement" : "Generation failed",
      });
      return "refunded";
    } catch (err) {
      logger.error(
        { err, tenantId: pending.tenantId, refundKey: intent.refundKey },
        "Credit meter durable refund remains pending",
      );
      return "pending";
    }
  }
  return "refunded";
}

/**
 * A same-key retry may arrive before the periodic worker.  Only the
 * pre-dispatch state can be repaired inline; a started/ambiguous receipt still
 * returns false so the caller raises the replay block.
 */
export async function recoverCreditMeterBeforeReplay(input: {
  tenantId: number;
  spendKey: string;
}): Promise<boolean> {
  const rows = await db
    .select()
    .from(creditAccountLedgerTable)
    .where(
      and(
        eq(creditAccountLedgerTable.tenantId, input.tenantId),
        eq(
          creditAccountLedgerTable.kind,
          CREDIT_METER_DISPATCH_PENDING_KIND,
        ),
      ),
    );
  const pending = rows.find(
    (row) => parseMeterLifecycleNote(row.note)?.spendKey === input.spendKey,
  );
  if (!pending) return false;
  return (await recoverOneCreditMeterLifecycle(pending)) === "refunded";
}

/**
 * Recover only deterministic pre-dispatch failures and confirmed outcomes.
 * Ambiguous started operations remain reserved and visible for manual
 * liability review; this worker intentionally has no provider replay path.
 */
export async function sweepCreditMeterRecoveries(
  tenantId?: number,
): Promise<CreditMeterRecoveryResult> {
  const rows = await db
    .select()
    .from(creditAccountLedgerTable)
    .where(
      tenantId === undefined
        ? inArray(creditAccountLedgerTable.kind, [
            CREDIT_METER_DISPATCH_PENDING_KIND,
            CREDIT_METER_REFUND_PENDING_KIND,
          ])
        : and(
            inArray(creditAccountLedgerTable.kind, [
              CREDIT_METER_DISPATCH_PENDING_KIND,
              CREDIT_METER_REFUND_PENDING_KIND,
            ]),
            eq(creditAccountLedgerTable.tenantId, tenantId),
          ),
    )
    .orderBy(creditAccountLedgerTable.id);
  const dispatchSpends = new Set(
    rows
      .filter((row) => row.kind === CREDIT_METER_DISPATCH_PENDING_KIND)
      .map((row) => parseMeterLifecycleNote(row.note)?.spendKey)
      .filter((key): key is string => Boolean(key)),
  );
  const recoverableRows = rows.filter((row) => {
    if (row.kind !== CREDIT_METER_REFUND_PENDING_KIND) return true;
    const spendKey = parseMeterLifecycleNote(row.note)?.spendKey;
    // A dispatch intent owns its quantity-refund marker; process it once from
    // the dispatch row rather than racing the marker as a generic refund.
    return !spendKey || !dispatchSpends.has(spendKey);
  });
  const result: CreditMeterRecoveryResult = {
    scanned: recoverableRows.length,
    refunded: 0,
    pending: 0,
    blocked: 0,
  };
  for (const row of recoverableRows) {
    try {
      const status = await recoverOneCreditMeterLifecycle(row);
      if (status === "refunded") result.refunded += 1;
      if (status === "pending") result.pending += 1;
      if (status === "blocked") result.blocked += 1;
    } catch (err) {
      result.pending += 1;
      logger.error(
        { err, tenantId: row.tenantId, ledgerId: row.id },
        "Credit meter recovery attempt failed",
      );
    }
  }
  return result;
}

let creditMeterRecoveryTimer: NodeJS.Timeout | null = null;
let creditMeterRecoveryRunning = false;

export const CREDIT_METER_RECOVERY_INTERVAL_MS = Number(
  process.env.CREDIT_METER_RECOVERY_INTERVAL_MS ?? 60_000,
);

export function startCreditMeterRecoverySweep(
  intervalMs = CREDIT_METER_RECOVERY_INTERVAL_MS,
): void {
  if (creditMeterRecoveryTimer) return;
  creditMeterRecoveryTimer = setInterval(() => {
    if (creditMeterRecoveryRunning) return;
    creditMeterRecoveryRunning = true;
    void sweepCreditMeterRecoveries()
      .catch((error) => {
        logger.error({ err: error }, "Credit meter recovery sweep failed");
      })
      .finally(() => {
        creditMeterRecoveryRunning = false;
      });
  }, intervalMs);
  creditMeterRecoveryTimer.unref?.();
}

export function stopCreditMeterRecoverySweep(): void {
  if (!creditMeterRecoveryTimer) return;
  clearInterval(creditMeterRecoveryTimer);
  creditMeterRecoveryTimer = null;
}

export interface CreditHistoryEntry {
  id: number;
  kind: string;
  credits: number;
  balanceAfter: number;
  rateKey: string | null;
  refKind: string | null;
  refId: string | null;
  note: string | null;
  createdAt: string;
  /**
   * Metered provider work is not presented as final while its durable refund
   * or dispatch outcome is unresolved. Ordinary grants/spends have null.
   */
  settlementStatus: "settled" | "pending" | "ambiguous" | null;
}

export async function listCreditHistory(
  tenantId: number,
  limit = 50,
): Promise<CreditHistoryEntry[]> {
  const rows = await db
    .select()
    .from(creditAccountLedgerTable)
    .where(eq(creditAccountLedgerTable.tenantId, tenantId))
    .orderBy(desc(creditAccountLedgerTable.id))
    // Lifecycle receipts are hidden from the customer-facing history, but are
    // fetched alongside the rows so each visible spend can expose its durable
    // status without a second query per line.
    .limit(Math.min(5_000, Math.max(1, limit) * 10));
  const lifecycleByKey = new Map(
    rows.map((row) => [row.idempotencyKey, row]),
  );
  const visible = rows
    .filter(
      (row) =>
        !(METER_LIFECYCLE_KINDS as readonly string[]).includes(row.kind),
    )
    .slice(0, Math.min(500, Math.max(1, limit)));
  return visible.map((r) => {
    let settlementStatus: CreditHistoryEntry["settlementStatus"] = null;
    if (r.kind === "spend" && r.idempotencyKey) {
      const pending = rows.find(
        (row) =>
          row.kind === CREDIT_METER_DISPATCH_PENDING_KIND &&
          parseMeterLifecycleNote(row.note)?.spendKey === r.idempotencyKey,
      );
      if (pending) {
        const note = parseMeterLifecycleNote(pending.note);
        const started = lifecycleByKey.get(
          meterMarkerKey(r.idempotencyKey, "started"),
        );
        const succeeded = lifecycleByKey.get(
          meterMarkerKey(r.idempotencyKey, "succeeded"),
        );
        const failed = lifecycleByKey.get(
          meterMarkerKey(r.idempotencyKey, "failed"),
        );
        const ambiguous = lifecycleByKey.get(
          meterMarkerKey(r.idempotencyKey, "ambiguous"),
        );
        if (
          ambiguous ||
          (started && !succeeded && !failed)
        ) {
          settlementStatus = "ambiguous";
        } else if (note) {
          const succeededNote = succeeded
            ? parseMeterLifecycleNote(succeeded.note)
            : null;
          const settlementRefundKey =
            succeeded && succeededNote?.authoritativeCostMilli !== null &&
            succeededNote?.authoritativeCostMilli !== undefined &&
            succeededNote.authoritativeCostMilli < note.creditsMilli
              ? `${r.idempotencyKey}:settle-refund`
              : note.refundKey;
          const requiresRefund =
            Boolean(
              succeeded &&
                succeededNote?.authoritativeCostMilli !== null &&
                succeededNote?.authoritativeCostMilli !== undefined &&
                succeededNote.authoritativeCostMilli < note.creditsMilli,
            ) || Boolean(failed);
          const refunded = lifecycleByKey.get(settlementRefundKey)?.kind === "refund";
          const refundPending =
            lifecycleByKey.get(meterRefundPendingKey(settlementRefundKey)) !==
            undefined;
          settlementStatus =
            refunded || (!requiresRefund && !refundPending && Boolean(succeeded))
              ? "settled"
              : "pending";
        }
      }
    }
    return {
    id: r.id,
    kind: r.kind,
    credits: (r.purchasedDeltaMilli + r.grantedDeltaMilli) / MILLI,
    balanceAfter: r.balanceAfterMilli / MILLI,
    rateKey: r.rateKey,
    refKind: r.refKind,
    refId: r.refId,
    note: r.note,
    createdAt: r.createdAt.toISOString(),
      settlementStatus,
    };
  });
}

/** Has this workspace ever had a credit account? Guards the migration. */
export async function hasCreditAccount(tenantId: number): Promise<boolean> {
  const [row] = await db
    .select({ tenantId: creditAccountsTable.tenantId })
    .from(creditAccountsTable)
    .where(eq(creditAccountsTable.tenantId, tenantId))
    .limit(1);
  return Boolean(row);
}

/** True only after the explicit, admin-approved legacy conversion ran. */
export async function hasMigrationReceipt(tenantId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: creditAccountLedgerTable.id })
    .from(creditAccountLedgerTable)
    .where(
      and(
        eq(creditAccountLedgerTable.tenantId, tenantId),
        eq(creditAccountLedgerTable.kind, "migrate"),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Total credits outstanding across every workspace — the platform's liability,
 * and the number to watch after a migration.
 */
export async function totalOutstandingCredits(): Promise<number> {
  const [row] = await db
    .select({
      milli: sql<number>`coalesce(sum(${creditAccountsTable.purchasedMilli} + ${creditAccountsTable.grantedMilli}), 0)::bigint`,
    })
    .from(creditAccountsTable);
  return Number(row?.milli ?? 0) / MILLI;
}

/**
 * Credit a paid pack into the balance.
 *
 * The gateway order id is the idempotency key, so a verification racing the
 * webhook backstop — which is normal, both fire on the same payment — credits
 * exactly once. A pack with no `credits` set is a legacy three-bucket pack and
 * this is a no-op, which is what lets one pack list serve both rails during
 * the changeover.
 */
export async function topUpCreditAccount(
  tenantId: number,
  pack: { id: number; name: string; credits: number },
  orderKey: string,
): Promise<void> {
  if (!pack.credits || pack.credits <= 0) return;
  await grantCredits({
    tenantId,
    credits: pack.credits,
    kind: "purchase",
    idempotencyKey: `pack:${orderKey}`,
    note: pack.name,
  });
}

/** Serializer for a CreditAccount row, for admin listings. */
export function serializeAccount(row: CreditAccount): CreditBalance {
  return toBalance({
    purchasedMilli: row.purchasedMilli,
    grantedMilli: row.grantedMilli,
    grantedExpiresAt: row.grantedExpiresAt,
  });
}

/**
 * True when this workspace's generations should be funded from the credit
 * balance rather than plan quota or the rupee wallet.
 *
 * Two conditions, and the second is the important one: the workspace must be
 * on billingMode="credits" AND the meter must actually be enforcing. A plan
 * can therefore be moved onto credits at any time — during shadow mode it
 * changes nothing, because the meter is still only recording and the old rail
 * is still the one collecting. The rail flips for everyone when the meter
 * flips, which is the same single dropdown that rolls it back.
 *
 * Without the mode check, a credits-mode workspace in shadow would reserve
 * nothing at the route and be charged nothing at the provider: unlimited free
 * generation, arrived at by two settings that each looked harmless.
 *
 * Fails CLOSED to the existing rail on any error.
 */
export async function isCreditFunded(
  tenantId: number,
  frozenMode?: MeterMode,
): Promise<boolean> {
  try {
    // Callers that are freezing a route funding decision pass the mode they
    // already read. Re-reading the mutable platform setting here would allow
    // a transition between reservation and provider dispatch to change rails.
    if ((frozenMode ?? (await getMeterMode())) !== "enforce") return false;
    const [tenant] = await db
      .select({ billingMode: tenantsTable.billingMode })
      .from(tenantsTable)
      .where(eq(tenantsTable.id, tenantId))
      .limit(1);
    return tenant?.billingMode === "credits";
  } catch {
    return false;
  }
}

function ordinalForReceipt(key: string, base: string): number | null {
  if (key === base) return 1; // compatibility with receipts predating ordinals
  const suffix = key.slice(`${base}:attempt:`.length);
  if (!key.startsWith(`${base}:attempt:`) || !/^[1-9]\d*$/.test(suffix))
    return null;
  return Number(suffix);
}

/**
 * The receipt-bearing form used by the meter. Knowing whether this invocation
 * actually debited is essential: a replay after an earlier successful call
 * must not refund that earlier debit if the replayed provider call fails.
 */
export async function spendCreditsOnce(
  input: SpendCreditsInput,
): Promise<SpendCreditsResult> {
  const costMilli = Math.max(0, Math.round(input.creditsMilli));
  return db.transaction(async (tx) => {
    // Serialize all movements for this workspace before consulting the
    // idempotency ledger. Checking first leaves a race where two transactions
    // both observe "unseen", both debit, and only the later ledger INSERT
    // discovers the unique-key collision (after the balance was calculated).
    // Rechecking while holding the account row lock makes the receipt and
    // balance mutation one atomic decision.
    const before = await lockAccount(tx, input.tenantId);
    let receiptKey = input.idempotencyKey ?? null;
    let refundReceiptKey = input.refundIdempotencyKey ?? null;
    let attemptOrdinal: number | null = null;
    if (input.idempotencyKey) {
      if (input.retryAfterRefund && input.refundIdempotencyKey) {
        const spendBase = input.idempotencyKey;
        const refundBase = input.refundIdempotencyKey;
        const receipts = await tx
          .select({
            kind: creditAccountLedgerTable.kind,
            idempotencyKey: creditAccountLedgerTable.idempotencyKey,
          })
          .from(creditAccountLedgerTable)
          .where(
            and(
              eq(creditAccountLedgerTable.tenantId, input.tenantId),
              or(
                eq(creditAccountLedgerTable.idempotencyKey, spendBase),
                eq(creditAccountLedgerTable.idempotencyKey, refundBase),
                sql`starts_with(${creditAccountLedgerTable.idempotencyKey}, ${`${spendBase}:attempt:`})`,
                sql`starts_with(${creditAccountLedgerTable.idempotencyKey}, ${`${refundBase}:attempt:`})`,
              ),
            ),
          );
        const spent = new Set<number>();
        const refunded = new Set<number>();
        for (const row of receipts) {
          if (!row.idempotencyKey) continue;
          const spendOrdinal = ordinalForReceipt(row.idempotencyKey, spendBase);
          if (row.kind === "spend" && spendOrdinal !== null)
            spent.add(spendOrdinal);
          const refundOrdinal = ordinalForReceipt(
            row.idempotencyKey,
            refundBase,
          );
          if (row.kind === "refund" && refundOrdinal !== null)
            refunded.add(refundOrdinal);
        }
        const latest = spent.size ? Math.max(...spent) : 0;
        if (latest > 0 && !refunded.has(latest)) {
          return {
            balance: toBalance(before),
            applied: false,
            idempotencyKey:
              latest === 1 &&
              receipts.some((r) => r.idempotencyKey === spendBase)
                ? spendBase
                : `${spendBase}:attempt:${latest}`,
            refundIdempotencyKey:
              latest === 1 &&
              receipts.some((r) => r.idempotencyKey === refundBase)
                ? refundBase
                : `${refundBase}:attempt:${latest}`,
            attemptOrdinal: latest,
          };
        }
        attemptOrdinal = latest + 1;
        receiptKey = `${spendBase}:attempt:${attemptOrdinal}`;
        refundReceiptKey = `${refundBase}:attempt:${attemptOrdinal}`;
      }
      const [seen] = await tx
        .select({ id: creditAccountLedgerTable.id })
        .from(creditAccountLedgerTable)
        .where(
          and(
            eq(creditAccountLedgerTable.tenantId, input.tenantId),
            eq(creditAccountLedgerTable.idempotencyKey, receiptKey!),
          ),
        )
        .limit(1);
      if (seen) {
        return {
          balance: toBalance(before),
          applied: false,
          idempotencyKey: receiptKey,
          refundIdempotencyKey: refundReceiptKey,
          attemptOrdinal,
        };
      }
    }

    const available = before.purchasedMilli + before.grantedMilli;
    if (costMilli > available)
      throw new InsufficientCreditsError(costMilli, available);

    const fromGranted = Math.min(before.grantedMilli, costMilli);
    const fromPurchased = costMilli - fromGranted;
    const after: AccountState = {
      purchasedMilli: before.purchasedMilli - fromPurchased,
      grantedMilli: before.grantedMilli - fromGranted,
      grantedExpiresAt: before.grantedExpiresAt,
    };
    if (after.grantedMilli === 0) after.grantedExpiresAt = null;

    await writeState(tx, input.tenantId, after);
    await tx.insert(creditAccountLedgerTable).values({
      tenantId: input.tenantId,
      kind: "spend",
      purchasedDeltaMilli: -fromPurchased,
      grantedDeltaMilli: -fromGranted,
      balanceAfterMilli: after.purchasedMilli + after.grantedMilli,
      rateKey: input.rateKey ?? null,
      refKind: input.refKind ?? null,
      refId: input.refId ?? null,
      idempotencyKey: receiptKey,
      note: input.note ?? null,
    });
    if (input.meterDispatch) {
      const dispatchRefundKey =
        input.idempotencyKey &&
        input.refundIdempotencyKey &&
        receiptKey?.startsWith(`${input.idempotencyKey}:attempt:`)
          ? `${input.meterDispatch.refundKey}:attempt:${receiptKey.slice(
              `${input.idempotencyKey}:attempt:`.length,
            )}`
          : input.meterDispatch.refundKey;
      await appendMeterLifecycle(tx, {
        tenantId: input.tenantId,
        kind: CREDIT_METER_DISPATCH_PENDING_KIND,
        idempotencyKey:
          input.meterDispatch.pendingKey ??
          meterMarkerKey(receiptKey!, "pending"),
        note: {
          version: 1,
          spendKey: receiptKey!,
          refundKey: dispatchRefundKey,
          creditsMilli: Math.max(0, Math.round(input.meterDispatch.creditsMilli)),
          rateKey: input.meterDispatch.rateKey,
          refKind: input.meterDispatch.refKind,
          refId: input.meterDispatch.refId,
        },
        rateKey: input.meterDispatch.rateKey,
        refKind: input.meterDispatch.refKind,
        refId: input.meterDispatch.refId,
      });
    }
    return {
      balance: toBalance(after),
      applied: true,
      idempotencyKey: receiptKey,
      refundIdempotencyKey: refundReceiptKey,
      attemptOrdinal,
    };
  });
}
