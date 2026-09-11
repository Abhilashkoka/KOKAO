import { db, creditMeterEventsTable } from "@workspace/db";
import { and, desc, gte, sql } from "drizzle-orm";
import { logger } from "./logger";
import { creditCostSnapshotFor, getMeterMode, listCreditRates, MILLI } from "./creditRates";
import {
  spendCreditsOnce,
  refundCredits,
  refundCreditsSafely,
  InsufficientCreditsError,
} from "./creditAccounts";
import { MeterDispatchReplayError } from "./meterErrors";
export { MeterDispatchReplayError } from "./meterErrors";

/**
 * THE METER.
 *
 * KOKAO reserves funding at the route, per user-facing action, but spends
 * money at the provider, deep inside a pipeline. Everything in between — the
 * scene keyframes a video job generates, the retry after one fails, the render
 * a QA gate later rejects, the narration LLM call — is real provider spend
 * that nothing in the app counts.
 *
 * This wraps the provider boundary instead. Every call that costs money goes
 * through `meter()`, which prices it against the credit rate card and appends
 * a row to `credit_meter_events` whether the call succeeded or threw.
 *
 * Two rules make it safe to drop into hot paths:
 *
 *   1. It NEVER changes the outcome of the wrapped call. Metering failures are
 *      logged and swallowed; a provider result is returned, and a provider
 *      error is rethrown, exactly as if the wrapper were not there.
 *   2. In "shadow" mode — the default, and the mode to launch in — it records
 *      and charges nothing. Debiting arrives with the credit wallet in the
 *      next phase, deliberately after these numbers have been reconciled
 *      against a real provider invoice.
 *
 * Passing a null context means "not billable to a workspace" (a superadmin
 * playground run, a provider health probe). That is an explicit choice at the
 * call site rather than an omission, which is the point: a new feature cannot
 * quietly skip the meter, because the parameter is required.
 */

export interface MeterContext {
  tenantId: number;
  /** What the spend was for: videoJob | imageJob | content | campaign. */
  refKind?: string | null;
  refId?: string | null;
  provider?: string | null;
  model?: string | null;
  /**
   * A stable identity for one paid operation. When the job already has an
   * `operationKey`, pass it: a settle replayed after a crash then debits once
   * instead of twice.
   */
  operationKey?: string | null;
  /**
   * Stable identity shared by mutually exclusive provider retries/fallbacks
   * for one logical operation. Attempt-specific `operationKey` values remain
   * useful for diagnostics, while this family prevents any successful or
   * crash-uncertain attempt from being replayed through a different suffix.
   */
  operationFamilyKey?: string | null;
}

/** Rate-card keys the app meters today. Widen as cost centres are added. */
export type MeterKey =
  | "video"
  | "video_hd"
  | "image"
  | "image_edit"
  | "caption"
  | "voice"
  | "lipsync"
  | "transcription";

export interface ProviderReported {
  /** Output tokens the provider says it produced. */
  tokens?: number | null;
  /** Actual USD the provider says it charged. */
  usd?: number | null;
  /**
   * Authoritative successful quantity, when it is only knowable from the
   * provider result (for example, decoded TTS audio duration).
   */
  actualQuantity?: number | null;
}

export interface MeterOptions {
  /**
   * Hard upper bound for a quantity only known after provider success.
   * Enforce mode reserves this quantity before dispatch and permits refund-only
   * settlement. A provider result above the declared bound is invalid and is
   * not delivered.
   */
  reservationQuantity?: number;
}

export class ActualQuantityExceedsReservationError extends Error {
  constructor(
    readonly actualQuantity: number,
    readonly reservationQuantity: number,
  ) {
    super("Provider result exceeded its metered quantity reservation");
    this.name = "ActualQuantityExceedsReservationError";
  }
}

async function recordMeterEvent(args: {
  ctx: MeterContext;
  key: string;
  quantity: number;
  /** The rate-card result snapshotted before provider dispatch. */
  creditsMilli: number;
  outcome: "ok" | "failed";
  mode: string;
  reported?: ProviderReported | null;
}): Promise<void> {
  await db.insert(creditMeterEventsTable).values({
    tenantId: args.ctx.tenantId,
    rateKey: args.key,
    // A non-finite quantity is a caller bug, not a reason to lose the row: it
    // records at zero so the call still appears in the report.
    quantityMilli: Number.isFinite(args.quantity) ? Math.round(Math.max(0, args.quantity) * MILLI) : 0,
    // An unpriced key records at zero rather than being dropped, so it shows
    // up in the report as a gap in the rate card instead of vanishing.
    creditsMilli: args.creditsMilli,
    outcome: args.outcome,
    mode: args.mode,
    provider: args.ctx.provider ?? null,
    model: args.ctx.model ?? null,
    refKind: args.ctx.refKind ?? null,
    refId: args.ctx.refId ?? null,
    providerTokens:
      typeof args.reported?.tokens === "number" && Number.isFinite(args.reported.tokens)
        ? Math.round(args.reported.tokens)
        : null,
    providerCostMicroUsd:
      typeof args.reported?.usd === "number" && Number.isFinite(args.reported.usd)
        ? Math.round(args.reported.usd * 1_000_000)
        : null,
  });
}

/**
 * Run a provider call and record what it cost.
 *
 * `quantity` is in the rate's own unit: seconds for video, voice, lip sync and
 * transcription; items for images and captions. Fractional seconds are fine.
 */
export async function meter<T>(
  ctx: MeterContext | null,
  key: MeterKey | (string & {}),
  quantity: number,
  fn: () => Promise<T>,
  /**
   * Pull the provider's own token / cost figures off a successful result, so
   * the recorded row carries what the invoice will say and not only what the
   * rate card charged.
   */
  reportedFrom?: (
    result: T,
  ) => ProviderReported | null | undefined | Promise<ProviderReported | null | undefined>,
  options: MeterOptions = {},
): Promise<T> {
  if (!ctx) return fn();

  let mode: string;
  try {
    mode = await getMeterMode();
  } catch (err) {
    logger.warn({ err }, "credit meter: could not read mode; running unmetered");
    return fn();
  }
  if (mode === "off") return fn();

  const requestedReservation = options.reservationQuantity;
  const reservationQuantity =
    typeof requestedReservation === "number" &&
    Number.isFinite(requestedReservation) &&
    requestedReservation >= 0
      ? Math.max(Number.isFinite(quantity) ? quantity : 0, requestedReservation)
      : quantity;
  const priceSnapshot = await creditCostSnapshotFor(key, reservationQuantity).catch(() => null);
  const costMilli = priceSnapshot?.costMilli ?? 0;

  // ENFORCE: debit BEFORE the provider call, so two concurrent generations
  // cannot both spend the last credit, and refund if the call then fails.
  // SHADOW: record only. Enforcement is a per-platform switch precisely so a
  // rate card can be validated against a real invoice before anyone is
  // charged from it.
  let debited = false;
  let debitReceiptKey: string | null = null;
  let failureRefundKey: string | null = null;
  // A paid rate gets a receipt even when the conservative reservation rounds
  // to zero. The authoritative result can then be settled after success, and
  // a failed zero-estimate attempt can persist its matching refund marker.
  if (mode === "enforce" && (priceSnapshot?.unitRateMilli ?? 0) > 0) {
    const familyKey = ctx.operationFamilyKey?.trim() || null;
    const spendBase = familyKey
      ? `spend-family:${familyKey}`
      : ctx.operationKey ? `spend:${ctx.operationKey}:${key}` : null;
    const refundBase = familyKey
      ? `refund-family:${familyKey}`
      : ctx.operationKey ? `refund:${ctx.operationKey}:${key}` : null;
    const debit = await spendCreditsOnce({
      tenantId: ctx.tenantId,
      creditsMilli: costMilli,
      rateKey: key,
      refKind: ctx.refKind ?? null,
      refId: ctx.refId ?? null,
      idempotencyKey: spendBase,
      retryAfterRefund: Boolean(spendBase && refundBase),
      refundIdempotencyKey: refundBase,
    });
    debited = debit.applied;
    debitReceiptKey = debit.idempotencyKey ?? spendBase;
    failureRefundKey = debit.refundIdempotencyKey ?? refundBase;
    // An idempotency receipt means this exact provider operation has already
    // been dispatched. We do not cache provider responses here, so proceeding
    // would make a fresh paid call without a fresh debit. Callers must assign
    // a distinct operation key to every real retry.
    if (!debit.applied) {
      throw new MeterDispatchReplayError();
    }
  }

  try {
    const result = await fn();
    const reported = reportedFrom ? ((await reportedFrom(result)) ?? null) : null;
    const actualQuantity =
      typeof reported?.actualQuantity === "number" &&
      Number.isFinite(reported.actualQuantity) &&
      reported.actualQuantity >= 0
        ? reported.actualQuantity
        : quantity;
    if (
      mode === "enforce" &&
      reported?.actualQuantity !== undefined &&
      Number.isFinite(actualQuantity) &&
      Number.isFinite(reservationQuantity) &&
      actualQuantity > reservationQuantity
    ) {
      // This is a provider/caller contract violation, not metering
      // infrastructure failure. Rejecting it is what makes the pre-dispatch
      // upper bound provable and prevents unfunded output delivery.
      throw new ActualQuantityExceedsReservationError(actualQuantity, reservationQuantity);
    }
    const authoritativeCostMilli = priceSnapshot && Number.isFinite(actualQuantity)
      ? Math.round(actualQuantity * priceSnapshot.unitRateMilli)
      : costMilli;
    let settledCostMilli = costMilli;
    if (mode === "enforce" && debited && authoritativeCostMilli !== costMilli) {
      if (authoritativeCostMilli < costMilli) {
        try {
          await refundCredits({
            tenantId: ctx.tenantId,
            creditsMilli: costMilli - authoritativeCostMilli,
            rateKey: key,
            refKind: ctx.refKind ?? null,
            refId: ctx.refId ?? null,
            idempotencyKey: debitReceiptKey ? `${debitReceiptKey}:settle-refund` : null,
          });
          settledCostMilli = authoritativeCostMilli;
        } catch (err) {
          logger.warn({ err, key }, "credit meter: failed to settle quantity refund");
        }
      }
    } else if (mode !== "enforce") {
      settledCostMilli = authoritativeCostMilli;
    }
    await recordMeterEvent({
      ctx,
      key,
      quantity: actualQuantity,
      creditsMilli: settledCostMilli,
      outcome: "ok",
      mode,
      reported,
    }).catch((err) => logger.warn({ err, key }, "credit meter: failed to record a successful call"));
    return result;
  } catch (error) {
    // The whole reason this exists: a failed provider call is still billed by
    // the provider, so it must still be recorded. The CUSTOMER is refunded —
    // a failure that was never their fault should not cost them — which means
    // provider failure waste lands on the platform, where it is visible in the
    // report and can be engineered away.
    await recordMeterEvent({
      ctx,
      key,
      quantity,
      creditsMilli: costMilli,
      outcome: "failed",
      mode,
    }).catch((err) => logger.warn({ err, key }, "credit meter: failed to record a failed call"));
    if (debited) {
      await refundCreditsSafely({
        tenantId: ctx.tenantId,
        creditsMilli: costMilli,
        rateKey: key,
        refKind: ctx.refKind ?? null,
        refId: ctx.refId ?? null,
        idempotencyKey: failureRefundKey,
      });
    }
    throw error;
  }
}

/** Re-exported so routes can answer 402 without importing the accounts lib. */
export { InsufficientCreditsError };

export interface MeterReportRow {
  rateKey: string;
  provider: string | null;
  model: string | null;
  calls: number;
  failedCalls: number;
  /** Total consumed in the rate's unit (seconds or items). */
  quantity: number;
  /** What those calls would have cost, in whole credits. */
  credits: number;
  /**
   * How this key appears on the current rate card. "unpriced" is deliberately
   * distinct from a configured zero rate and a disabled rate.
   */
  pricingStatus: "priced" | "free" | "inactive" | "unpriced";
  /** Output tokens the provider reported, when it reports any. */
  providerTokens: number | null;
  /** Actual USD the provider reported, when it reports any. */
  providerUsd: number | null;
}

export interface MeterReport {
  since: string;
  mode: string;
  totalCalls: number;
  failedCalls: number;
  totalCredits: number;
  /** Provider-reported totals, for holding against an invoice. */
  totalProviderTokens: number | null;
  totalProviderUsd: number | null;
  /** Metered keys absent from the current rate card. */
  unpricedKeys: string[];
  rows: MeterReportRow[];
}

/**
 * What the meter has seen over the last `days`, grouped by rate key, provider
 * and model — the report to hold up against a provider invoice.
 *
 * The failed-call column is the interesting one. It is spend the provider
 * charged for and that nothing else in the app has ever recorded.
 */
export async function meterReport(days = 30): Promise<MeterReport> {
  const since = new Date(Date.now() - Math.max(1, days) * 24 * 60 * 60 * 1000);
  const [rows, rates] = await Promise.all([
    db
      .select({
        rateKey: creditMeterEventsTable.rateKey,
        provider: creditMeterEventsTable.provider,
        model: creditMeterEventsTable.model,
        calls: sql<number>`count(*)::int`,
        failedCalls: sql<number>`count(*) filter (where ${creditMeterEventsTable.outcome} = 'failed')::int`,
        quantityMilli: sql<number>`coalesce(sum(${creditMeterEventsTable.quantityMilli}), 0)::bigint`,
        creditsMilli: sql<number>`coalesce(sum(${creditMeterEventsTable.creditsMilli}), 0)::bigint`,
        providerTokens: sql<number | null>`sum(${creditMeterEventsTable.providerTokens})::bigint`,
        providerCostMicroUsd: sql<number | null>`sum(${creditMeterEventsTable.providerCostMicroUsd})::bigint`,
      })
      .from(creditMeterEventsTable)
      .where(gte(creditMeterEventsTable.createdAt, since))
      .groupBy(creditMeterEventsTable.rateKey, creditMeterEventsTable.provider, creditMeterEventsTable.model)
      .orderBy(desc(sql`coalesce(sum(${creditMeterEventsTable.creditsMilli}), 0)`)),
    listCreditRates(),
  ]);
  const ratesByKey = new Map(rates.map((rate) => [rate.key, rate]));

  const mapped: MeterReportRow[] = rows.map((r) => {
    const rate = ratesByKey.get(r.rateKey);
    const pricingStatus: MeterReportRow["pricingStatus"] = !rate
      ? "unpriced"
      : !rate.active
        ? "inactive"
        : rate.credits === 0
          ? "free"
          : "priced";
    return {
      rateKey: r.rateKey,
      provider: r.provider,
      model: r.model,
      calls: Number(r.calls),
      failedCalls: Number(r.failedCalls),
      quantity: Number(r.quantityMilli) / MILLI,
      credits: Number(r.creditsMilli) / MILLI,
      pricingStatus,
      providerTokens: r.providerTokens === null ? null : Number(r.providerTokens),
      providerUsd: r.providerCostMicroUsd === null ? null : Number(r.providerCostMicroUsd) / 1_000_000,
    };
  });

  const tokenRows = mapped.filter((r) => r.providerTokens !== null);
  const usdRows = mapped.filter((r) => r.providerUsd !== null);

  return {
    since: since.toISOString(),
    mode: await getMeterMode(),
    totalCalls: mapped.reduce((sum, r) => sum + r.calls, 0),
    totalCredits: mapped.reduce((sum, r) => sum + r.credits, 0),
    failedCalls: mapped.reduce((sum, r) => sum + r.failedCalls, 0),
    // Null rather than zero when nothing reported: a provider that says
    // nothing must not read as a provider that charged nothing.
    totalProviderTokens: tokenRows.length ? tokenRows.reduce((sum, r) => sum + (r.providerTokens ?? 0), 0) : null,
    totalProviderUsd: usdRows.length ? usdRows.reduce((sum, r) => sum + (r.providerUsd ?? 0), 0) : null,
    unpricedKeys: [...new Set(mapped.filter((r) => r.pricingStatus === "unpriced").map((r) => r.rateKey))].sort(),
    rows: mapped,
  };
}

/**
 * What one workspace has consumed in the window — the same figures the report
 * shows, narrowed to a tenant, for a per-workspace view later.
 */
export async function tenantMeterCredits(tenantId: number, days = 30): Promise<number> {
  const since = new Date(Date.now() - Math.max(1, days) * 24 * 60 * 60 * 1000);
  const [row] = await db
    .select({
      creditsMilli: sql<number>`coalesce(sum(${creditMeterEventsTable.creditsMilli}), 0)::bigint`,
    })
    .from(creditMeterEventsTable)
    .where(and(sql`${creditMeterEventsTable.tenantId} = ${tenantId}`, gte(creditMeterEventsTable.createdAt, since)));
  return Number(row?.creditsMilli ?? 0) / MILLI;
}
