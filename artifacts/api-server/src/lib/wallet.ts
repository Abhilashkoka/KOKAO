import {
  db,
  walletBalancesTable,
  walletLedgerTable,
  walletSettingsTable,
  tenantsTable,
  type WalletLedgerEntry,
} from "@workspace/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { isFeatureEnabled } from "./featureFlags";
import { getAiSpendConfig, withFee } from "./aiSpend";
import { computeTextCostPaise, computeImageCostPaise, findModelPrice } from "./aiCost";
import { logger } from "./logger";

/**
 * Prepaid RUPEE wallet.
 *
 * Money model, in one paragraph: a tenant tops up a GST-exclusive rupee
 * amount (GST is added on top only at the Razorpay checkout step); each AI
 * generation reserves an estimate up front, then settles to the REAL provider
 * cost plus the platform fee once the provider reports back. Everything is
 * integer paise and every movement is a wallet_ledger row, so the ledger
 * always sums to the balance.
 *
 * Nothing in here runs unless BOTH the `wallet` platform kill switch is on
 * AND the tenant is on billingMode="wallet". Off means the existing plan
 * quota / unit credit path is untouched.
 */

export type WalletKind = "caption" | "image" | "video";

// ---------- settings ----------

export interface WalletConfig {
  gstPercent: number;
  minTopupPaise: number;
  lowBalanceThresholdPaise: number;
  videoCostPaise: number;
}

const DEFAULT_CONFIG: WalletConfig = {
  gstPercent: 18,
  minTopupPaise: 10_000,
  lowBalanceThresholdPaise: 0,
  videoCostPaise: 0,
};

export async function getWalletConfig(): Promise<WalletConfig> {
  const [row] = await db.select().from(walletSettingsTable).limit(1);
  if (!row) return { ...DEFAULT_CONFIG };
  return {
    gstPercent: row.gstPercent,
    minTopupPaise: row.minTopupPaise,
    lowBalanceThresholdPaise: row.lowBalanceThresholdPaise,
    videoCostPaise: row.videoCostPaise,
  };
}

export async function setWalletConfig(config: WalletConfig): Promise<WalletConfig> {
  const [existing] = await db.select().from(walletSettingsTable).limit(1);
  if (existing) {
    await db
      .update(walletSettingsTable)
      .set({ ...config, updatedAt: new Date() })
      .where(eq(walletSettingsTable.id, existing.id));
  } else {
    await db.insert(walletSettingsTable).values(config);
  }
  return getWalletConfig();
}

// ---------- GST ----------

/** GST payable on a base amount, rounded to whole paise. */
export function gstOn(basePaise: number, gstPercent: number): number {
  if (!Number.isFinite(basePaise) || basePaise <= 0) return 0;
  if (!Number.isFinite(gstPercent) || gstPercent <= 0) return 0;
  return Math.round((basePaise * gstPercent) / 100);
}

/** What the tenant actually pays at checkout: base + GST. */
export function withGst(basePaise: number, gstPercent: number): number {
  return basePaise + gstOn(basePaise, gstPercent);
}

// ---------- mode ----------

/**
 * True when this workspace's generations should be funded from the wallet.
 * Requires the platform switch AND the per-tenant mode; either one off means
 * the caller keeps its existing quota-then-credits behaviour.
 *
 * Fails CLOSED to "quota" on any error: a wallet lookup blowing up must never
 * charge someone twice or lock them out of a rail that was working.
 */
export async function isWalletFunded(tenantId: number): Promise<boolean> {
  try {
    if (!(await isFeatureEnabled("wallet"))) return false;
    const [tenant] = await db
      .select({ billingMode: tenantsTable.billingMode })
      .from(tenantsTable)
      .where(eq(tenantsTable.id, tenantId))
      .limit(1);
    return tenant?.billingMode === "wallet";
  } catch {
    return false;
  }
}

// ---------- pricing ----------

/**
 * The up-front estimate for one generation: the admin-set display rate with
 * the platform fee folded in. This is also the fallback when a model has no
 * row in the price catalog, so a generation is never silently free.
 */
export async function estimateChargePaise(kind: WalletKind): Promise<number> {
  const [spend, config] = await Promise.all([getAiSpendConfig(), getWalletConfig()]);
  const base =
    kind === "caption"
      ? spend.captionCostPaise
      : kind === "image"
        ? spend.imageCostPaise
        : config.videoCostPaise;
  return withFee(base, spend.feePercent);
}

/**
 * What a finished generation should actually cost the tenant.
 *
 * `costPaise` is the real provider cost the caller already computed with the
 * same cost engine that powers the superadmin Actual Cost Report. When it is
 * unknown (model missing from the price catalog, or no USD→INR rate set) the
 * charge falls back to the admin display rate and is flagged `estimated`, so
 * a true-up can collect the difference once the admin fills the price in.
 */
export async function actualChargePaise(args: {
  kind: WalletKind;
  costPaise?: number | null;
  /** How many generations the charge covers (a campaign settles as one). */
  units?: number;
}): Promise<{ paise: number; estimated: boolean }> {
  // A cost of exactly zero is treated as UNKNOWN, not as free. It is what a
  // provider that reports nothing, a `:free` model, and a sub-half-paise
  // rounding all produce, and charging zero for a real generation is the one
  // outcome this whole engine exists to prevent.
  if (
    typeof args.costPaise === "number" &&
    Number.isFinite(args.costPaise) &&
    args.costPaise > 0
  ) {
    const { feePercent } = await getAiSpendConfig();
    return { paise: withFee(args.costPaise, feePercent), estimated: false };
  }
  const unit = await estimateChargePaise(args.kind);
  return { paise: unit * Math.max(1, args.units ?? 1), estimated: true };
}

// ---------- balance ----------

export async function getWalletBalancePaise(tenantId: number): Promise<number> {
  const [row] = await db
    .select()
    .from(walletBalancesTable)
    .where(eq(walletBalancesTable.tenantId, tenantId))
    .limit(1);
  return row?.balancePaise ?? 0;
}

/** The transaction handle drizzle passes to `db.transaction` callbacks. */
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type LedgerFields = Omit<
  typeof walletLedgerTable.$inferInsert,
  "tenantId" | "amountPaise" | "id" | "createdAt"
>;

/**
 * Apply a signed delta to the balance and append the matching ledger row,
 * inside one transaction holding a row lock.
 *
 * The balance never goes below zero, and the ledger records the delta that
 * was ACTUALLY applied (not the requested one), so ledger totals always
 * reconcile with the stored balance — same discipline as the credit ledger.
 */
async function applyDelta(
  tx: DbTransaction,
  tenantId: number,
  requestedDelta: number,
  fields: LedgerFields,
): Promise<{ applied: number; balancePaise: number; entryId: number }> {
  const old = await lockBalance(tx, tenantId);
  const next = Math.max(0, old + requestedDelta);
  const applied = next - old;

  const [entry] = await tx
    .insert(walletLedgerTable)
    .values({ tenantId, amountPaise: applied, ...fields })
    .returning({ id: walletLedgerTable.id });

  await tx
    .update(walletBalancesTable)
    .set({ balancePaise: next, updatedAt: new Date() })
    .where(eq(walletBalancesTable.tenantId, tenantId));
  return { applied, balancePaise: next, entryId: entry.id };
}

/**
 * Take the row lock, creating the balance row first if this tenant has never
 * had one. Locking a row that does not exist locks nothing, so without the
 * upsert two concurrent first movements would both fall through to an INSERT
 * and one would die on the primary key — losing a paid top-up.
 */
async function lockBalance(tx: DbTransaction, tenantId: number): Promise<number> {
  await tx
    .insert(walletBalancesTable)
    .values({ tenantId, balancePaise: 0 })
    .onConflictDoNothing({ target: walletBalancesTable.tenantId });
  const [row] = await tx
    .select()
    .from(walletBalancesTable)
    .where(eq(walletBalancesTable.tenantId, tenantId))
    .for("update");
  return row?.balancePaise ?? 0;
}

// ---------- reserve / settle / refund ----------

export interface WalletReservation {
  /** The wallet_ledger row id of the reserve entry. */
  id: number;
  /** How much was debited up front, in paise. */
  amountPaise: number;
  /** How many generations it covers (a campaign reserves one per platform). */
  units: number;
}

/**
 * Atomically debit the estimated cost of one generation BEFORE the provider
 * call, all-or-nothing. Returns null when the balance cannot cover it — the
 * caller answers 402 with a "recharge to continue" message.
 *
 * Reserving up front is what stops two concurrent generations from both
 * spending the last rupee.
 */
export async function reserveWallet(
  tenantId: number,
  kind: WalletKind,
  meta: { model?: string | null; provider?: string | null } = {},
  units = 1,
): Promise<WalletReservation | null> {
  const count = Math.max(1, Math.floor(units));
  const estimate = (await estimateChargePaise(kind)) * count;
  return db.transaction(async (tx) => {
    const balance = await lockBalance(tx, tenantId);
    // A zero estimate means the admin has not set display rates yet. Still
    // reserve (so the lifecycle is uniform) but never block on it.
    if (balance < estimate) return null;

    const [entry] = await tx
      .insert(walletLedgerTable)
      .values({
        tenantId,
        kind: "reserve",
        amountPaise: -estimate,
        usageKind: kind,
        model: meta.model ?? null,
        provider: meta.provider ?? null,
      })
      .returning({ id: walletLedgerTable.id });

    await tx
      .update(walletBalancesTable)
      .set({ balancePaise: balance - estimate, updatedAt: new Date() })
      .where(eq(walletBalancesTable.tenantId, tenantId));
    return { id: entry.id, amountPaise: estimate, units: count };
  });
}

/**
 * True the reservation up to the real cost once the generation has finished.
 * Writes a settle row carrying the signed difference (which may be zero), so
 * the reserve/settle pair is fully auditable and the estimate never silently
 * becomes the charge.
 */
export async function settleWallet(
  tenantId: number,
  reservation: WalletReservation,
  meta: {
    kind: WalletKind;
    costPaise?: number | null;
    provider?: string | null;
    model?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    /** Link back to what was produced: content | imageJob | videoJob | campaign. */
    refKind?: string | null;
    refId?: string | null;
  },
): Promise<{ chargedPaise: number; estimated: boolean; balancePaise: number }> {
  const { paise: actual, estimated } = await actualChargePaise({
    kind: meta.kind,
    costPaise: meta.costPaise,
    units: reservation.units,
  });
  const delta = reservation.amountPaise - actual; // positive = refund some back

  const result = await db.transaction(async (tx) =>
    applyDelta(tx, tenantId, delta, {
      kind: "settle",
      reservationId: reservation.id,
      usageKind: meta.kind,
      provider: meta.provider ?? null,
      model: meta.model ?? null,
      inputTokens: meta.inputTokens ?? null,
      outputTokens: meta.outputTokens ?? null,
      refKind: meta.refKind ?? null,
      refId: meta.refId ?? null,
      estimated,
      note: estimated
        ? `No catalog price for ${meta.model ?? "this model"}; charged the display rate`
        : null,
    }),
  );
  return {
    chargedPaise: reservation.amountPaise - result.applied,
    estimated,
    balancePaise: result.balancePaise,
  };
}

/**
 * Rebuild a reservation from the columns a background job persisted, so a
 * runner (or the stuck-job sweep) can settle or refund work that outlived the
 * request that reserved it. Null when the row was not wallet-funded.
 */
export function reservationFromRow(row: {
  walletReservationId: number | null;
  walletReservedPaise: number | null;
  /** Absent on single-unit work (image jobs); a video job carries its own. */
  walletReservedUnits?: number | null;
}): WalletReservation | null {
  if (row.walletReservationId === null || row.walletReservedPaise === null) return null;
  return {
    id: row.walletReservationId,
    amountPaise: row.walletReservedPaise,
    // Units drive the display-rate fallback, so a 12-scene video that reserved
    // 12 units must not settle as if it were one.
    units: Math.max(1, row.walletReservedUnits ?? 1),
  };
}

/** Give the whole reservation back when the generation failed. */
export async function refundWallet(
  tenantId: number,
  reservation: WalletReservation,
  note?: string,
): Promise<void> {
  if (reservation.amountPaise <= 0) return;
  await db.transaction(async (tx) =>
    applyDelta(tx, tenantId, reservation.amountPaise, {
      kind: "refund",
      reservationId: reservation.id,
      note: note ?? null,
    }),
  );
}

// ---------- top-ups and admin adjustments ----------

/**
 * Credit a paid recharge. `basePaise` is the GST-exclusive amount that lands
 * in the wallet; the GST figures are recorded alongside for reconciliation but
 * are never credited. Idempotent per Razorpay order via the ledger's unique
 * index, so a verification racing the webhook backstop credits exactly once.
 */
export async function creditWalletTopup(params: {
  tenantId: number;
  basePaise: number;
  gstPaise: number;
  gstPercent: number;
  /** Exactly one order id must be set; the matching unique index dedupes. */
  razorpayOrderId?: string;
  cashfreeOrderId?: string;
  note?: string | null;
}): Promise<boolean> {
  if (!params.razorpayOrderId && !params.cashfreeOrderId) {
    throw new Error("creditWalletTopup requires a razorpayOrderId or cashfreeOrderId");
  }
  try {
    await db.transaction(async (tx) =>
      applyDelta(tx, params.tenantId, params.basePaise, {
        kind: "topup",
        baseAmountPaise: params.basePaise,
        gstAmountPaise: params.gstPaise,
        gstPercent: params.gstPercent,
        razorpayOrderId: params.razorpayOrderId ?? null,
        cashfreeOrderId: params.cashfreeOrderId ?? null,
        note: params.note ?? null,
      }),
    );
    return true;
  } catch (error) {
    // Unique violation on the order id = already credited. Not an error.
    if (isOrderUniqueViolation(error)) return false;
    throw error;
  }
}

function isOrderUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    const e = current as {
      code?: string;
      constraint?: string;
      message?: string;
      cause?: unknown;
    };
    // Deliberately NOT a bare code 23505 check: any other unique violation
    // means the top-up was LOST, and reporting that as "already credited"
    // would swallow a payment the tenant actually made.
    if (
      e.constraint === "wallet_ledger_order_unique" ||
      e.constraint === "wallet_ledger_cf_order_unique" ||
      (typeof e.message === "string" &&
        /wallet_ledger_(cf_)?order_unique/i.test(e.message))
    ) {
      return true;
    }
    current = e.cause;
  }
  return false;
}

/**
 * Superadmin manual top-up or deduction, in paise. Positive credits, negative
 * debits. No GST is involved — an admin grant is not a sale.
 */
export async function adminAdjustWallet(params: {
  tenantId: number;
  amountPaise: number;
  note?: string | null;
}): Promise<{ appliedPaise: number; balancePaise: number }> {
  const result = await db.transaction(async (tx) =>
    applyDelta(tx, params.tenantId, params.amountPaise, {
      kind: params.amountPaise >= 0 ? "admin_credit" : "admin_debit",
      note: params.note ?? null,
    }),
  );
  return { appliedPaise: result.applied, balancePaise: result.balancePaise };
}

// ---------- history and pending prices ----------

export async function listWalletHistory(
  tenantId: number,
  limit = 50,
): Promise<WalletLedgerEntry[]> {
  return db
    .select()
    .from(walletLedgerTable)
    .where(eq(walletLedgerTable.tenantId, tenantId))
    .orderBy(desc(walletLedgerTable.createdAt), desc(walletLedgerTable.id))
    .limit(limit);
}

export interface PendingPricedModel {
  usageKind: string;
  provider: string | null;
  model: string | null;
  chargeCount: number;
  chargedPaise: number;
}

/**
 * Models that have been charged at the display-rate fallback because they are
 * missing from the price catalog. This is the admin's to-do list: add a price
 * and the difference gets collected by `trueUpModel`.
 */
export async function listPendingPricedModels(): Promise<PendingPricedModel[]> {
  const rows = await db
    .select({
      usageKind: walletLedgerTable.usageKind,
      provider: walletLedgerTable.provider,
      model: walletLedgerTable.model,
      chargeCount: sql<number>`count(*)::int`,
      chargedPaise: sql<number>`coalesce(sum(-${walletLedgerTable.amountPaise}), 0)::int`,
    })
    .from(walletLedgerTable)
    .where(
      and(
        eq(walletLedgerTable.estimated, true),
        isNull(walletLedgerTable.trueUpAt),
      ),
    )
    .groupBy(
      walletLedgerTable.usageKind,
      walletLedgerTable.provider,
      walletLedgerTable.model,
    );
  return rows.map((r) => ({
    usageKind: r.usageKind ?? "unknown",
    provider: r.provider,
    model: r.model,
    chargeCount: r.chargeCount,
    // A settle row's amount is the reserve/actual DIFFERENCE, so this sum is
    // indicative only; the per-tenant ledger stays the exact record.
    chargedPaise: r.chargedPaise,
  }));
}

/**
 * Collect the difference on generations that were charged the display rate
 * because their model had no price. Called after a superadmin saves a model
 * price: every estimated row for that model is recomputed against the real
 * price and the shortfall is debited (or the overcharge refunded) as a
 * `true_up` row.
 *
 * Rows are marked `trueUpAt` whether or not money moved, so a model is only
 * ever trued up once per price save.
 */
export async function trueUpModel(args: {
  kind: "text" | "image";
  provider: string;
  model: string;
}): Promise<{ rowsTruedUp: number; netPaise: number }> {
  const usageKind: WalletKind = args.kind === "text" ? "caption" : "image";
  const pending = await db
    .select()
    .from(walletLedgerTable)
    .where(
      and(
        eq(walletLedgerTable.estimated, true),
        isNull(walletLedgerTable.trueUpAt),
        eq(walletLedgerTable.usageKind, usageKind),
        // Same normalization as the price-catalog lookup (findPrice): trimmed,
        // case-insensitive. An exact string match here left rows permanently
        // "pending" whenever the admin's catalog entry differed from the
        // ledger's model string only by case or whitespace.
        sql`lower(trim(${walletLedgerTable.model})) = lower(${args.model.trim()})`,
      ),
    )
    .limit(1000);
  if (pending.length === 0) return { rowsTruedUp: 0, netPaise: 0 };

  const { feePercent } = await getAiSpendConfig();
  let rowsTruedUp = 0;
  let netPaise = 0;

  // What the tenant was ACTUALLY charged for a settled generation is the
  // reserved estimate minus the settle row's delta — not today's display rate,
  // which may have changed, and not a per-unit figure, which would be wrong
  // for a multi-platform campaign that settled as one row.
  const chargedFor = async (row: (typeof pending)[number]): Promise<number | null> => {
    if (row.reservationId === null) return null;
    const [reserve] = await db
      .select({ amountPaise: walletLedgerTable.amountPaise })
      .from(walletLedgerTable)
      .where(eq(walletLedgerTable.id, row.reservationId))
      .limit(1);
    if (!reserve) return null;
    return -reserve.amountPaise - row.amountPaise;
  };

  for (const row of pending) {
    const provider = row.provider ?? args.provider;
    const raw =
      args.kind === "text"
        ? await computeTextCostPaise({
            provider,
            model: args.model,
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
          })
        : await computeImageCostPaise({
            provider,
            model: args.model,
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
          });
    // Still unknown (e.g. a text model whose tokens were never reported):
    // leave the row pending rather than inventing a number.
    if (raw === null) continue;
    const charged = await chargedFor(row);
    if (charged === null) continue;

    const realCharge = withFee(Math.max(0, raw), feePercent);
    const delta = charged - realCharge; // positive = refund the overcharge
    await db.transaction(async (tx) => {
      if (delta !== 0) {
        const applied = await applyDelta(tx, row.tenantId, delta, {
          kind: "true_up",
          reservationId: row.reservationId,
          usageKind: row.usageKind,
          provider,
          model: args.model,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          note: `Priced ${args.model} after the fact`,
        });
        netPaise += applied.applied;
      }
      await tx
        .update(walletLedgerTable)
        .set({ trueUpAt: new Date() })
        .where(eq(walletLedgerTable.id, row.id));
    });
    rowsTruedUp += 1;
  }
  return { rowsTruedUp, netPaise };
}

/**
 * Startup sweep clearing the "Needs pricing" backlog left by the old exact
 * string match in `trueUpModel`: rows that stayed pending even though a
 * matching (case/whitespace-insensitively) price row existed, because the
 * true-up only ran when a price was SAVED. Re-checks every pending group
 * against the current catalog and trues up the ones that now have a price.
 *
 * Safe to run every boot: `trueUpModel` only touches rows with a NULL
 * `trueUpAt` and stamps them once processed, so nothing is ever trued up
 * twice, and groups still without a price are left pending untouched.
 * Best-effort — a failure is logged and never affects startup.
 */
export async function sweepStuckPendingTrueUps(): Promise<void> {
  try {
    const pending = await listPendingPricedModels();
    for (const group of pending) {
      if (!group.model) continue;
      const kind =
        group.usageKind === "caption"
          ? ("text" as const)
          : group.usageKind === "image"
            ? ("image" as const)
            : null;
      if (!kind) continue;
      try {
        // Only invoke the true-up when the catalog actually has a price now;
        // trueUpModel itself would no-op safely, but this keeps the sweep
        // from doing per-row work for models still awaiting pricing.
        const price = await findModelPrice(kind, group.provider ?? "", group.model);
        if (!price) continue;
        const result = await trueUpModel({
          kind,
          provider: group.provider ?? price.provider,
          model: group.model,
        });
        if (result.rowsTruedUp > 0) {
          logger.info(
            { model: group.model, kind, rowsTruedUp: result.rowsTruedUp, netPaise: result.netPaise },
            "Trued up stuck pending wallet charges against the price catalog",
          );
        }
      } catch (error) {
        logger.error(
          { err: error, model: group.model, usageKind: group.usageKind },
          "Failed to true up a stuck pending model",
        );
      }
    }
  } catch (error) {
    logger.error({ err: error }, "Stuck pending true-up sweep failed");
  }
}
