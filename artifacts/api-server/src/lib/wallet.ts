import {
  db,
  walletBalancesTable,
  walletLedgerTable,
  walletSettingsTable,
  tenantsTable,
  videoGenerationsTable,
  type WalletLedgerEntry,
} from "@workspace/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { isFeatureEnabled } from "./featureFlags";
import { getAiSpendConfig, withFee } from "./aiSpend";
import {
  computeTextCostPaise,
  computeImageCostPaise,
  computeVideoCostPaise,
  findModelPrice,
  getAiCostConfig,
} from "./aiCost";
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
  } catch (error) {
    // Unique violation on the order id = already credited. Not an error.
    if (isOrderUniqueViolation(error)) return false;
    throw error;
  }
  // The wallet just gained funds: collect any true-up remainder that a
  // previous attempt could only partially debit. Best-effort — a failure
  // here must never make a paid top-up look uncredited.
  try {
    await collectPendingTrueUpsForTenant(params.tenantId);
  } catch (error) {
    logger.error(
      { err: error, tenantId: params.tenantId },
      "Post-top-up true-up collection failed",
    );
  }
  return true;
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

/**
 * Why a group of estimated wallet charges is still awaiting reconciliation.
 * - `no_price`        — the price catalog has no row for the model at all.
 * - `price_incomplete`— a catalog row exists but lacks the price fields this
 *                       usage kind needs (e.g. a text row without token rates).
 * - `no_fx_rate`      — a usable price exists but the USD→INR rate is unset,
 *                       so no USD price can become a paise charge.
 * - `missing_usage`   — a usable price exists but the charges never recorded
 *                       the token usage a token-based price needs.
 * - `not_reconciled`  — everything needed appears to be in place; the true-up
 *                       simply has not run (or could not finish, e.g. an empty
 *                       wallet at collection time). Reconcile now / retry.
 */
export type PendingPriceReason =
  | "no_price"
  | "price_incomplete"
  | "no_fx_rate"
  | "missing_usage"
  | "not_reconciled";

export interface PendingPricedModel {
  usageKind: string;
  provider: string | null;
  model: string | null;
  chargeCount: number;
  chargedPaise: number;
  /** Why the rows are still pending — drives the admin banner copy. */
  reason: PendingPriceReason;
  /** Human-readable specifics (which input is missing, mismatches, etc.). */
  detail: string;
  /** Provider string on the catalog row that matched (null = no row). */
  priceProvider: string | null;
  /** Charges in the group that never recorded token usage. */
  missingUsageCount: number;
}

const usageKindToPriceKind = (
  usageKind: string | null,
): "text" | "image" | "video" | null =>
  usageKind === "caption"
    ? "text"
    : usageKind === "image"
      ? "image"
      : usageKind === "video"
        ? "video"
        : null;

/**
 * Models whose wallet charges are still at the display-rate fallback, each
 * diagnosed against the CURRENT price catalog (same matching rules as the
 * cost calculators, including the model-only provider fallback) so the admin
 * banner can say WHY a group is stuck instead of blaming the catalog for
 * everything.
 */
export async function listPendingPricedModels(): Promise<PendingPricedModel[]> {
  const rows = await db
    .select({
      usageKind: walletLedgerTable.usageKind,
      provider: walletLedgerTable.provider,
      model: walletLedgerTable.model,
      chargeCount: sql<number>`count(*)::int`,
      chargedPaise: sql<number>`coalesce(sum(-${walletLedgerTable.amountPaise}), 0)::int`,
      missingUsageCount: sql<number>`count(*) filter (where ${walletLedgerTable.inputTokens} is null or ${walletLedgerTable.outputTokens} is null)::int`,
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

  const { usdToInrPaise } = await getAiCostConfig();
  const out: PendingPricedModel[] = [];
  for (const r of rows) {
    const base = {
      usageKind: r.usageKind ?? "unknown",
      provider: r.provider,
      model: r.model,
      chargeCount: r.chargeCount,
      // A settle row's amount is the reserve/actual DIFFERENCE, so this sum is
      // indicative only; the per-tenant ledger stays the exact record.
      chargedPaise: r.chargedPaise,
      missingUsageCount: r.missingUsageCount,
    };
    out.push({
      ...base,
      ...(await classifyPendingGroup({
        usageKind: r.usageKind,
        provider: r.provider,
        model: r.model,
        chargeCount: r.chargeCount,
        missingUsageCount: r.missingUsageCount,
        usdToInrPaise,
      })),
    });
  }
  return out;
}

/** Diagnose one pending group against the price catalog. */
async function classifyPendingGroup(group: {
  usageKind: string | null;
  provider: string | null;
  model: string | null;
  chargeCount: number;
  missingUsageCount: number;
  usdToInrPaise: number;
}): Promise<{ reason: PendingPriceReason; detail: string; priceProvider: string | null }> {
  const kind = usageKindToPriceKind(group.usageKind);
  if (!group.model || !kind) {
    return {
      reason: "no_price",
      detail: !group.model
        ? "The charge recorded no model name, so no catalog price can ever match it."
        : `Unrecognized usage kind "${group.usageKind ?? "unknown"}".`,
      priceProvider: null,
    };
  }
  const price = await findModelPrice(kind, group.provider ?? "", group.model);
  if (!price) {
    return {
      reason: "no_price",
      detail: `No row in the price catalog matches ${kind}:${group.model} under any provider.`,
      priceProvider: null,
    };
  }
  const providerNote =
    group.provider &&
    price.provider.trim().toLowerCase() !== group.provider.trim().toLowerCase()
      ? ` (matched the catalog row for provider "${price.provider}" via the model-only fallback)`
      : "";

  const hasTokenPair = price.inputUsdPerMtok !== null && price.outputUsdPerMtok !== null;
  if (kind === "text" && !hasTokenPair) {
    return {
      reason: "price_incomplete",
      detail: `The catalog row is missing the input/output USD-per-1M-token rates a text price needs${providerNote}.`,
      priceProvider: price.provider,
    };
  }
  if (kind === "image" && price.usdPerImage === null && !hasTokenPair) {
    return {
      reason: "price_incomplete",
      detail: `The catalog row has neither a per-image price nor both token rates${providerNote}.`,
      priceProvider: price.provider,
    };
  }
  if (kind === "video" && price.usdPerSecond === null && price.usdPerVideo === null) {
    return {
      reason: "price_incomplete",
      detail: `The catalog row has neither a per-second nor a per-video price${providerNote}.`,
      priceProvider: price.provider,
    };
  }
  if (group.usdToInrPaise <= 0) {
    return {
      reason: "no_fx_rate",
      detail: `A price exists but the USD→INR rate is unset, so no charge can be computed${providerNote}.`,
      priceProvider: price.provider,
    };
  }
  // Token-based pricing with no recorded usage can never reconcile. Images
  // with a flat per-image price don't need usage; text always does.
  const needsUsage = kind === "text" || (kind === "image" && price.usdPerImage === null);
  if (needsUsage && group.missingUsageCount >= group.chargeCount) {
    return {
      reason: "missing_usage",
      detail: `A usable price exists but ${group.missingUsageCount === 1 ? "the charge" : `all ${group.missingUsageCount} charges`} recorded no token usage, so the real cost cannot be computed${providerNote}.`,
      priceProvider: price.provider,
    };
  }
  const partialUsage =
    needsUsage && group.missingUsageCount > 0
      ? ` ${group.missingUsageCount} of ${group.chargeCount} charges lack token usage and will stay pending.`
      : "";
  const videoNote =
    kind === "video" && price.usdPerVideo === null
      ? " Per-second pricing needs each charge's stored clip length; charges without one stay pending."
      : "";
  return {
    reason: "not_reconciled",
    detail: `A usable price exists; these charges have not been reconciled yet (or the wallet could not cover the shortfall). Use Reconcile now${providerNote}.${partialUsage}${videoNote}`,
    priceProvider: price.provider,
  };
}

export interface ReconcileResult {
  /** Rows fully trued-up (stamped trueUpAt) by this run. */
  settledRows: number;
  /** Net paise applied across wallets (negative = collected, positive = refunded). */
  netPaise: number;
  /** Shortfall that wallets could not cover; stays pending for later. */
  uncollectedPaise: number;
  /** The group after the run, with a fresh diagnosis; null when fully cleared. */
  remaining: PendingPricedModel | null;
}

/**
 * Admin "reconcile now" for one pending group: run the existing true-up for
 * the model, then re-diagnose what (if anything) is still pending so the
 * caller can report settled vs remaining with reasons.
 */
export async function reconcilePendingModel(args: {
  usageKind: string;
  provider: string | null;
  model: string;
}): Promise<ReconcileResult> {
  const kind = usageKindToPriceKind(args.usageKind);
  if (!kind) {
    throw new Error(`Unrecognized usage kind "${args.usageKind}"`);
  }
  const price = await findModelPrice(kind, args.provider ?? "", args.model);
  const result = price
    ? await trueUpModel({
        kind,
        provider: args.provider ?? price.provider,
        model: args.model,
      })
    : { rowsTruedUp: 0, netPaise: 0, uncollectedPaise: 0 };

  const pendingAfter = await listPendingPricedModels();
  const norm = (s: string | null) => (s ?? "").trim().toLowerCase();
  const remaining =
    pendingAfter.find(
      (p) =>
        p.usageKind === args.usageKind &&
        norm(p.provider) === norm(args.provider) &&
        norm(p.model) === norm(args.model),
    ) ?? null;
  return {
    settledRows: result.rowsTruedUp,
    netPaise: result.netPaise,
    uncollectedPaise: result.uncollectedPaise,
    remaining,
  };
}

/**
 * Collect the difference on generations that were charged the display rate
 * because their model had no price. Called after a superadmin saves a model
 * price: every estimated row for that model is recomputed against the real
 * price and the shortfall is debited (or the overcharge refunded) as a
 * `true_up` row.
 *
 * Rows are marked `trueUpAt` once their shortfall (or refund) has been FULLY
 * applied, so a model is only ever trued up once per price save. When the
 * wallet cannot cover the whole shortfall, the balance is drained to zero,
 * the partial collection is recorded, and the row stays PENDING (no
 * `trueUpAt`) so the remainder is collected on a later attempt — e.g. the
 * boot sweep or the tenant's next top-up — instead of being silently
 * forgiven. Prior partial `true_up` rows are counted as already-charged, so
 * retries never double-collect.
 */
export async function trueUpModel(args: {
  kind: "text" | "image" | "video";
  provider: string;
  model: string;
  /**
   * Restrict the true-up to one tenant's rows. Set by the post-top-up retry
   * so tenant A's payment can never trigger a debit against tenant B; a
   * price save leaves it unset and trues up everyone, as before.
   */
  tenantId?: number;
}): Promise<{ rowsTruedUp: number; netPaise: number; uncollectedPaise: number }> {
  const usageKind: WalletKind =
    args.kind === "text" ? "caption" : args.kind === "image" ? "image" : "video";
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
        ...(args.tenantId !== undefined
          ? [eq(walletLedgerTable.tenantId, args.tenantId)]
          : []),
      ),
    )
    .limit(1000);
  if (pending.length === 0) return { rowsTruedUp: 0, netPaise: 0, uncollectedPaise: 0 };

  const { feePercent } = await getAiSpendConfig();
  let rowsTruedUp = 0;
  let netPaise = 0;
  let uncollectedPaise = 0;

  // Per-second video prices need the clip length, which the ledger does not
  // store. A video settle row links back to its video_generations job
  // (refKind "videoJob"), whose options carry the REQUESTED clip length —
  // the same figure the reservation priced. Null when there is no job link
  // or the job stored no duration; computeVideoCostPaise then falls back to
  // the flat per-video price, or stays unknown (row remains pending).
  const storedVideoDurationSec = async (
    row: (typeof pending)[number],
  ): Promise<number | null> => {
    if (row.refKind !== "videoJob" || !row.refId) return null;
    const jobId = Number(row.refId);
    if (!Number.isInteger(jobId) || jobId <= 0) return null;
    const [job] = await db
      .select({ options: videoGenerationsTable.options })
      .from(videoGenerationsTable)
      .where(eq(videoGenerationsTable.id, jobId))
      .limit(1);
    const duration = job?.options?.durationSec;
    return typeof duration === "number" && Number.isFinite(duration) && duration > 0
      ? duration
      : null;
  };

  // What the tenant was ACTUALLY charged for a settled generation is the
  // reserved estimate minus the settle row's delta — not today's display rate,
  // which may have changed, and not a per-unit figure, which would be wrong
  // for a multi-platform campaign that settled as one row. Prior partial
  // `true_up` collections against the same reservation count as charged too,
  // so a retry after a top-up collects only what is still owed.
  //
  // Runs INSIDE the debit transaction, after the settle row has been locked,
  // so two concurrent true-up triggers (price save, boot sweep, top-up) can
  // never both read the same prior total and each collect the full shortfall.
  const chargedFor = async (
    tx: DbTransaction,
    row: { reservationId: number | null; amountPaise: number },
  ): Promise<number | null> => {
    if (row.reservationId === null) return null;
    const [reserve] = await tx
      .select({ amountPaise: walletLedgerTable.amountPaise })
      .from(walletLedgerTable)
      .where(eq(walletLedgerTable.id, row.reservationId))
      .limit(1);
    if (!reserve) return null;
    const [priorTrueUps] = await tx
      .select({
        total: sql<number>`coalesce(sum(${walletLedgerTable.amountPaise}), 0)::int`,
      })
      .from(walletLedgerTable)
      .where(
        and(
          eq(walletLedgerTable.reservationId, row.reservationId),
          eq(walletLedgerTable.kind, "true_up"),
        ),
      );
    // true_up debits are negative, so subtracting them ADDS what was already
    // collected to the charged total.
    return -reserve.amountPaise - row.amountPaise - (priorTrueUps?.total ?? 0);
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
        : args.kind === "image"
          ? await computeImageCostPaise({
              provider,
              model: args.model,
              inputTokens: row.inputTokens,
              outputTokens: row.outputTokens,
            })
          : await computeVideoCostPaise({
              provider,
              model: args.model,
              durationSec: await storedVideoDurationSec(row),
            });
    // Still unknown (e.g. a text model whose tokens were never reported):
    // leave the row pending rather than inventing a number.
    if (raw === null) continue;
    const realCharge = withFee(Math.max(0, raw), feePercent);

    const fullyApplied = await db.transaction(async (tx) => {
      // Serialize on the settle row itself: lock it, and re-check that no
      // concurrent trigger already trued it up while we were computing.
      const [fresh] = await tx
        .select()
        .from(walletLedgerTable)
        .where(eq(walletLedgerTable.id, row.id))
        .for("update");
      if (!fresh || fresh.trueUpAt !== null) return false;

      const charged = await chargedFor(tx, fresh);
      if (charged === null) return false;
      const delta = charged - realCharge; // positive = refund the overcharge

      let complete = true;
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
        // Both sides negative on a shortfall; > 0 means part went uncollected.
        const remainder = applied.applied - delta;
        if (remainder > 0 && delta < 0) {
          // The wallet could not cover the whole shortfall. Record exactly
          // how much is still owed on the true_up row and leave the settle
          // row PENDING so a later attempt (boot sweep, next top-up, next
          // price save) collects the remainder instead of forgiving it.
          complete = false;
          uncollectedPaise += remainder;
          await tx
            .update(walletLedgerTable)
            .set({
              note: `Priced ${args.model} after the fact — partial: ${remainder} paise still due`,
            })
            .where(eq(walletLedgerTable.id, applied.entryId));
          logger.warn(
            {
              tenantId: row.tenantId,
              model: args.model,
              collectedPaise: -applied.applied,
              stillDuePaise: remainder,
            },
            "True-up shortfall only partially collected; row left pending",
          );
        }
      }
      if (complete) {
        await tx
          .update(walletLedgerTable)
          .set({ trueUpAt: new Date() })
          .where(eq(walletLedgerTable.id, row.id));
      }
      return complete;
    });
    if (fullyApplied) rowsTruedUp += 1;
  }
  return { rowsTruedUp, netPaise, uncollectedPaise };
}

/**
 * Retry pending true-ups for ONE tenant's estimated-but-unpriced charges,
 * used right after a top-up so a shortfall that was only partially collected
 * (wallet was empty at price-save time) gets the remainder debited from the
 * fresh balance. Only groups whose model now has a catalog price are touched;
 * everything else stays pending exactly as before.
 */
export async function collectPendingTrueUpsForTenant(tenantId: number): Promise<void> {
  const groups = await db
    .selectDistinct({
      usageKind: walletLedgerTable.usageKind,
      provider: walletLedgerTable.provider,
      model: walletLedgerTable.model,
    })
    .from(walletLedgerTable)
    .where(
      and(
        eq(walletLedgerTable.tenantId, tenantId),
        eq(walletLedgerTable.estimated, true),
        isNull(walletLedgerTable.trueUpAt),
      ),
    );
  for (const group of groups) {
    if (!group.model) continue;
    const kind =
      group.usageKind === "caption"
        ? ("text" as const)
        : group.usageKind === "image"
          ? ("image" as const)
          : group.usageKind === "video"
            ? ("video" as const)
            : null;
    if (!kind) continue;
    const price = await findModelPrice(kind, group.provider ?? "", group.model);
    if (!price) continue;
    await trueUpModel({
      kind,
      provider: group.provider ?? price.provider,
      model: group.model,
      // Scope strictly to the tenant whose top-up triggered this: their
      // payment must never cause a debit against another tenant's wallet.
      tenantId,
    });
  }
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
            : group.usageKind === "video"
              ? ("video" as const)
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

// ---------- periodic true-up retry ----------

/**
 * How often the background retry re-checks pending estimated charges against
 * the price catalog. Overridable for tests. The retry exists so a true-up
 * that silently failed (or a price added while the fire-and-forget hook was
 * down) does not leave rows pending until the next boot or price re-save.
 */
export const TRUE_UP_RETRY_INTERVAL_MS = Number(
  process.env.TRUE_UP_RETRY_INTERVAL_MS ?? 15 * 60_000,
);

let trueUpRetryTimer: NodeJS.Timeout | null = null;
let trueUpRetryRunning = false;

/**
 * Start the periodic true-up retry. Each tick runs the same sweep as boot:
 * only pending groups whose model NOW has a catalog price are touched, the
 * per-invocation row cap and per-row locking in `trueUpModel` apply, and
 * failures are logged, never thrown. An overlap guard skips a tick while the
 * previous one is still running.
 */
export function startTrueUpRetrySweep(intervalMs = TRUE_UP_RETRY_INTERVAL_MS): void {
  if (trueUpRetryTimer) return;
  trueUpRetryTimer = setInterval(() => {
    if (trueUpRetryRunning) return;
    trueUpRetryRunning = true;
    void sweepStuckPendingTrueUps().finally(() => {
      trueUpRetryRunning = false;
    });
  }, intervalMs);
  trueUpRetryTimer.unref?.();
}

export function stopTrueUpRetrySweep(): void {
  if (trueUpRetryTimer) {
    clearInterval(trueUpRetryTimer);
    trueUpRetryTimer = null;
  }
}
