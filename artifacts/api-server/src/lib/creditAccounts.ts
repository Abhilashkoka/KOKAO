import {
  db,
  creditAccountsTable,
  creditAccountLedgerTable,
  type CreditAccount,
} from "@workspace/db";
import { desc, eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { MILLI } from "./creditRates";

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
    grantedExpiresAt: state.grantedExpiresAt ? state.grantedExpiresAt.toISOString() : null,
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
async function lockAccount(tx: DbTransaction, tenantId: number): Promise<AccountState> {
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
      grantedExpiresAt: state.grantedMilli === 0 ? null : state.grantedExpiresAt,
      updatedAt: new Date(),
    })
    .where(eq(creditAccountsTable.tenantId, tenantId));
}

/** What this workspace can spend right now, with expiry already applied. */
export async function getCreditBalance(tenantId: number): Promise<CreditBalance> {
  return toBalance(await db.transaction(async (tx) => lockAccount(tx, tenantId)));
}

/** A cheap read that takes no lock, for display where staleness is fine. */
export async function peekCreditBalance(tenantId: number): Promise<CreditBalance> {
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
export async function grantCredits(input: GrantCreditsInput): Promise<CreditBalance> {
  const deltaMilli = Math.round((Number(input.credits) || 0) * MILLI);
  const toPurchased = input.kind === "purchase" || input.kind === "migrate";
  if (deltaMilli < 0 && input.kind !== "grant_admin") {
    throw new Error("Only an admin adjustment may remove credits");
  }

  return db.transaction(async (tx) => {
    if (input.idempotencyKey) {
      const [seen] = await tx
        .select({ id: creditAccountLedgerTable.id })
        .from(creditAccountLedgerTable)
        .where(eq(creditAccountLedgerTable.idempotencyKey, input.idempotencyKey))
        .limit(1);
      if (seen) return toBalance(await lockAccount(tx, input.tenantId));
    }

    const before = await lockAccount(tx, input.tenantId);
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
      const candidate = new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000);
      after.grantedExpiresAt =
        after.grantedExpiresAt && after.grantedExpiresAt > candidate
          ? after.grantedExpiresAt
          : candidate;
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
  });
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
  note?: string | null;
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
export async function spendCredits(input: SpendCreditsInput): Promise<CreditBalance> {
  const costMilli = Math.max(0, Math.round(input.creditsMilli));
  return db.transaction(async (tx) => {
    if (input.idempotencyKey) {
      const [seen] = await tx
        .select({ id: creditAccountLedgerTable.id })
        .from(creditAccountLedgerTable)
        .where(eq(creditAccountLedgerTable.idempotencyKey, input.idempotencyKey))
        .limit(1);
      if (seen) return toBalance(await lockAccount(tx, input.tenantId));
    }

    const before = await lockAccount(tx, input.tenantId);
    const available = before.purchasedMilli + before.grantedMilli;
    if (costMilli > available) throw new InsufficientCreditsError(costMilli, available);

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
      idempotencyKey: input.idempotencyKey ?? null,
      note: input.note ?? null,
    });
    return toBalance(after);
  });
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
  if (amountMilli === 0) return;
  await db.transaction(async (tx) => {
    if (input.idempotencyKey) {
      const [seen] = await tx
        .select({ id: creditAccountLedgerTable.id })
        .from(creditAccountLedgerTable)
        .where(eq(creditAccountLedgerTable.idempotencyKey, input.idempotencyKey))
        .limit(1);
      if (seen) return;
    }
    const before = await lockAccount(tx, input.tenantId);
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

/** Best-effort refund: never let bookkeeping break a user-facing flow. */
export async function refundCreditsSafely(input: SpendCreditsInput): Promise<void> {
  await refundCredits(input).catch((err) =>
    logger.error({ err, tenantId: input.tenantId }, "credit refund failed"),
  );
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
    .limit(Math.min(500, Math.max(1, limit)));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    credits: (r.purchasedDeltaMilli + r.grantedDeltaMilli) / MILLI,
    balanceAfter: r.balanceAfterMilli / MILLI,
    rateKey: r.rateKey,
    refKind: r.refKind,
    refId: r.refId,
    note: r.note,
    createdAt: r.createdAt.toISOString(),
  }));
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
