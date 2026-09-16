import { db, creditMeterEventsTable } from "@workspace/db";
import { and, desc, gte, sql } from "drizzle-orm";
import { logger } from "./logger";
import { creditCostSnapshotFor, getMeterMode, listCreditRates, MILLI } from "./creditRates";
import {
  spendCreditsOnce,
  refundCredits,
  queueCreditMeterRefund,
  markCreditMeterDispatchStarted,
  markCreditMeterDispatchOutcome,
  markCreditMeterDispatchFailedWithRefund,
  recoverCreditMeterBeforeReplay,
  InsufficientCreditsError,
} from "./creditAccounts";
import { type MeterFundingSnapshot } from "./meterFunding";
import type { MeterMode } from "./creditRates";
import { MeterDispatchReplayError } from "./meterErrors";
export { MeterDispatchReplayError } from "./meterErrors";
export type { MeterFundingSnapshot } from "./meterFunding";

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
 *   1. Legacy rails and shadow mode NEVER change the outcome of the wrapped
 *      call. Their metering failures are logged and swallowed; a provider
 *      result is returned, and a provider error is rethrown, exactly as if the
 *      wrapper were not there. An explicitly frozen enforce credits decision
 *      is different: it refuses an unfunded or ambiguous dispatch.
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
  /**
   * Funding selected by the route before dispatch. Credits are debited only
   * when this snapshot explicitly names the `credits` rail and freezes
   * `enforce`; legacy rails never debit the credit account.
   */
  funding?: MeterFundingSnapshot;
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
  /**
   * A rejected provider request is not always a confirmed non-dispatch:
   * connection loss can happen after the provider accepted the request. The
   * normal provider wrappers know when a failure is definitive. Callers may
   * return true only for an explicit terminal rejection (for example a
   * provider HTTP 4xx other than 408/409). Omitted classifiers fail closed as
   * ambiguous; they never refund or replay an unknown provider request.
   */
  isFailureConfirmed?: (error: unknown) => boolean;
}

/**
 * Conservative fallback for wrappers that have not supplied a provider
 * classifier. Network errors, timeouts, 5xx responses, and arbitrary Error
 * objects are intentionally unknown. A 4xx rejection is safe only when it is
 * not a timeout/conflict that could have raced provider acceptance.
 */
export function isDefinitiveProviderRejection(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown } | null;
  };
  const statusCandidates = [value.status, value.statusCode, value.response?.status];
  const status = statusCandidates.find(
    (candidate): candidate is number =>
      typeof candidate === "number" && Number.isInteger(candidate),
  );
  return (
    status !== undefined &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 409
  );
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

export class MeterDispatchOutcomeUnknownError extends Error {
  readonly code = "METER_DISPATCH_OUTCOME_UNKNOWN";

  constructor(readonly cause?: unknown) {
    super(
      "Metered provider outcome is unknown; the operation is blocked for reconciliation",
    );
    this.name = "MeterDispatchOutcomeUnknownError";
  }
}

export class MeterSettlementPendingError extends Error {
  readonly code = "METER_SETTLEMENT_PENDING";

  constructor(readonly refundMilli: number) {
    super("Metered provider work succeeded; credit settlement is pending retry");
    this.name = "MeterSettlementPendingError";
  }
}

/** A provider call cannot be dispatched without a route funding decision. */
export class MeterFundingSnapshotRequiredError extends Error {
  readonly code = "METER_FUNDING_SNAPSHOT_REQUIRED";

  constructor() {
    super("Meter funding snapshot is required while credit enforcement is active");
    this.name = "MeterFundingSnapshotRequiredError";
  }
}

/** The route supplied a funding snapshot that cannot safely authorize a call. */
export class MeterFundingConfigurationError extends Error {
  readonly code = "METER_FUNDING_CONFIGURATION_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "MeterFundingConfigurationError";
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

  const funding = ctx.funding;
  let mode: MeterMode;
  if (funding) {
    if (
      !Number.isSafeInteger(funding.tenantId) ||
      funding.tenantId <= 0 ||
      funding.tenantId !== ctx.tenantId
    ) {
      throw new MeterFundingConfigurationError(
        "Meter funding snapshot does not match the provider tenant",
      );
    }
    if (
      funding.mode !== "off" &&
      funding.mode !== "shadow" &&
      funding.mode !== "enforce"
    ) {
      throw new MeterFundingConfigurationError("Meter funding snapshot has an invalid mode");
    }
    if (
      funding.rail !== "quota" &&
      funding.rail !== "credit" &&
      funding.rail !== "wallet" &&
      funding.rail !== "credits"
    ) {
      throw new MeterFundingConfigurationError("Meter funding snapshot has an invalid rail");
    }
    if (funding.rail === "credits" && funding.mode !== "enforce") {
      throw new MeterFundingConfigurationError(
        "The credits funding rail requires a frozen enforce mode",
      );
    }
    // A funding snapshot is the route's immutable decision. In particular, an
    // enforce credits snapshot must not observe a later global mode change.
    mode = funding.mode;
  } else {
    try {
      mode = await getMeterMode();
    } catch (err) {
      // Without a snapshot there is no safe way to know which rail authorized
      // this call. Dispatching after a settings outage could become free work
      // if enforcement was active, so fail closed rather than infer credits
      // from the tenant row.
      logger.warn({ err }, "credit meter: could not read mode; refusing unscoped dispatch");
      throw new MeterFundingConfigurationError(
        "Meter mode could not be read; provider dispatch was refused",
      );
    }
    if (mode === "enforce") throw new MeterFundingSnapshotRequiredError();
  }
  if (mode === "off") return fn();

  // An enforce snapshot on a legacy rail means the route is still reserving
  // quota, wallet, or legacy credits. It must not be represented as an
  // enforce-mode credit-account charge in the meter ledger. Keep `off` as the
  // true pass-through above; all other legacy recordings are effectively
  // shadowed.
  const effectiveMode: MeterMode =
    funding?.rail !== "credits" && mode === "enforce" ? "shadow" : mode;
  const requestedReservation = options.reservationQuantity;
  const reservationQuantity =
    typeof requestedReservation === "number" &&
    Number.isFinite(requestedReservation) &&
    requestedReservation >= 0
      ? Math.max(Number.isFinite(quantity) ? quantity : 0, requestedReservation)
      : quantity;
  const creditsEnforced = funding?.rail === "credits" && mode === "enforce";
  if (
    creditsEnforced &&
    (!Number.isFinite(quantity) || quantity < 0)
  ) {
    throw new MeterFundingConfigurationError(
      "Metered quantity is invalid for enforced credit funding",
    );
  }
  if (
    creditsEnforced &&
    requestedReservation !== undefined &&
    (!Number.isFinite(requestedReservation) || requestedReservation < 0)
  ) {
    throw new MeterFundingConfigurationError(
      "Metered reservation is invalid for enforced credit funding",
    );
  }

  let priceSnapshot: {
    unitRateMilli: number;
    costMilli: number;
    active: boolean;
    valid: boolean;
  } | null;
  try {
    priceSnapshot = await creditCostSnapshotFor(key, reservationQuantity);
  } catch (err) {
    if (creditsEnforced) {
      throw new MeterFundingConfigurationError(
        "Credit pricing could not be loaded; provider dispatch was refused",
      );
    }
    logger.warn({ err, key }, "credit meter: could not read rate; recording at zero");
    priceSnapshot = null;
  }
  const costMilli = priceSnapshot?.costMilli ?? 0;
  if (creditsEnforced && !priceSnapshot) {
    throw new MeterFundingConfigurationError(
      `No credit price is configured for metered key "${key}"`,
    );
  }
  if (creditsEnforced && priceSnapshot && !priceSnapshot.valid) {
    throw new MeterFundingConfigurationError(
      `The saved credit price for metered key "${key}" is invalid`,
    );
  }
  if (
    creditsEnforced &&
    priceSnapshot &&
    (!Number.isSafeInteger(priceSnapshot.costMilli) || priceSnapshot.costMilli < 0)
  ) {
    throw new MeterFundingConfigurationError(
      `The metered cost for key "${key}" is outside the supported credit range`,
    );
  }
  if (creditsEnforced && priceSnapshot && !priceSnapshot.active) {
    throw new MeterFundingConfigurationError(
      `The saved credit price for metered key "${key}" is inactive`,
    );
  }

  // ENFORCE: debit BEFORE the provider call, so two concurrent generations
  // cannot both spend the last credit, and refund if the call then fails.
  // SHADOW: record only. Enforcement is a per-platform switch precisely so a
  // rate card can be validated against a real invoice before anyone is
  // charged from it.
  let debited = false;
  let debitReceiptKey: string | null = null;
  let failureRefundKey: string | null = null;
  let providerCallReturned = false;
  let dispatchOutcomePersisted = false;
  // A paid rate gets a receipt even when the conservative reservation rounds
  // to zero. The authoritative result can then be settled after success, and
  // a failed zero-estimate attempt can persist its matching refund marker.
  if (creditsEnforced && (priceSnapshot?.unitRateMilli ?? 0) > 0) {
    const familyKey = ctx.operationFamilyKey?.trim() || null;
    const operationKey = ctx.operationKey?.trim() || null;
    if (!familyKey && !operationKey) {
      throw new MeterFundingConfigurationError(
        "Enforced credit funding requires a stable provider operation identity",
      );
    }
    const spendBase = familyKey
      ? `spend-family:${familyKey}`
      : operationKey ? `spend:${operationKey}:${key}` : null;
    const refundBase = familyKey
      ? `refund-family:${familyKey}`
      : operationKey ? `refund:${operationKey}:${key}` : null;
    const spendInput = {
      tenantId: ctx.tenantId,
      creditsMilli: costMilli,
      rateKey: key,
      refKind: ctx.refKind ?? null,
      refId: ctx.refId ?? null,
      idempotencyKey: spendBase,
      retryAfterRefund: Boolean(spendBase && refundBase),
      refundIdempotencyKey: refundBase,
      meterDispatch: {
        refundKey: refundBase!,
        creditsMilli: costMilli,
        rateKey: key,
        refKind: ctx.refKind ?? null,
        refId: ctx.refId ?? null,
      },
    } as const;
    let debit = await spendCreditsOnce(spendInput);
    if (!debit.applied && debit.idempotencyKey && debit.refundIdempotencyKey) {
      // A crash after the debit transaction committed but before the
      // dispatch-started marker is the one safe replay case.  Repair it
      // synchronously when possible; a started/unknown operation remains
      // blocked and can never silently invoke the provider twice.
      const recovered = await recoverCreditMeterBeforeReplay({
        tenantId: ctx.tenantId,
        spendKey: debit.idempotencyKey,
      });
      if (recovered) debit = await spendCreditsOnce(spendInput);
    }
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
    await markCreditMeterDispatchStarted({
      tenantId: ctx.tenantId,
      spendKey: debitReceiptKey!,
      refundKey: failureRefundKey!,
      creditsMilli: costMilli,
      rateKey: key,
      refKind: ctx.refKind ?? null,
      refId: ctx.refId ?? null,
    });
  }

  try {
    const result = await fn();
    providerCallReturned = true;
    const reported = reportedFrom ? ((await reportedFrom(result)) ?? null) : null;
    const actualQuantity =
      typeof reported?.actualQuantity === "number" &&
      Number.isFinite(reported.actualQuantity) &&
      reported.actualQuantity >= 0
        ? reported.actualQuantity
        : quantity;
    const authoritativeCostMilli = priceSnapshot && Number.isFinite(actualQuantity)
      ? Math.round(actualQuantity * priceSnapshot.unitRateMilli)
      : costMilli;
    if (
      creditsEnforced &&
      reported?.actualQuantity !== undefined &&
      Number.isFinite(actualQuantity) &&
      Number.isFinite(reservationQuantity) &&
      actualQuantity > reservationQuantity
    ) {
      // This is a provider/caller contract violation, not metering
      // infrastructure failure. The provider already returned work, so do not
      // refund it or permit a replay; persist the successful outcome first.
      if (debited) {
        await markCreditMeterDispatchOutcome({
          tenantId: ctx.tenantId,
          spendKey: debitReceiptKey!,
          refundKey: failureRefundKey!,
          creditsMilli: costMilli,
          outcome: "succeeded",
          rateKey: key,
          refKind: ctx.refKind ?? null,
          refId: ctx.refId ?? null,
          actualQuantity,
          authoritativeCostMilli,
          error: "provider result exceeded reservation",
        });
        dispatchOutcomePersisted = true;
      }
      await recordMeterEvent({
        ctx,
        key,
        quantity: actualQuantity,
        creditsMilli: costMilli,
        outcome: "failed",
        mode: effectiveMode,
        reported,
      }).catch((err) =>
        logger.warn({ err, key }, "credit meter: failed to record an over-bound call"),
      );
      throw new ActualQuantityExceedsReservationError(actualQuantity, reservationQuantity);
    }
    if (debited) {
      await markCreditMeterDispatchOutcome({
        tenantId: ctx.tenantId,
        spendKey: debitReceiptKey!,
        refundKey: failureRefundKey!,
        creditsMilli: costMilli,
        outcome: "succeeded",
        rateKey: key,
        refKind: ctx.refKind ?? null,
        refId: ctx.refId ?? null,
        actualQuantity,
        authoritativeCostMilli,
      });
      dispatchOutcomePersisted = true;
    }
    let settledCostMilli = costMilli;
    if (creditsEnforced && debited && authoritativeCostMilli !== costMilli) {
      if (authoritativeCostMilli < costMilli) {
        const settlementRefundKey = debitReceiptKey
          ? `${debitReceiptKey}:settle-refund`
          : null;
        try {
          if (!settlementRefundKey) throw new Error("Meter settlement receipt is missing");
          await queueCreditMeterRefund({
            tenantId: ctx.tenantId,
            refundKey: settlementRefundKey,
            spendKey: debitReceiptKey,
            creditsMilli: costMilli - authoritativeCostMilli,
            rateKey: key,
            refKind: ctx.refKind ?? null,
            refId: ctx.refId ?? null,
            note: "meter quantity settlement",
          });
          await refundCredits({
            tenantId: ctx.tenantId,
            creditsMilli: costMilli - authoritativeCostMilli,
            rateKey: key,
            refKind: ctx.refKind ?? null,
            refId: ctx.refId ?? null,
            idempotencyKey: settlementRefundKey,
            note: "Meter quantity settlement",
          });
          settledCostMilli = authoritativeCostMilli;
        } catch (err) {
          // The succeeded marker and pending refund are durable. Returning
          // provider output is safe (there is no replay), while the ledger and
          // billing UI continue to show a pending settlement until recovery.
          logger.error(
            { err, key, tenantId: ctx.tenantId },
            "credit meter: quantity refund queued for durable retry",
          );
        }
      }
    } else if (effectiveMode !== "enforce") {
      settledCostMilli = authoritativeCostMilli;
    }
    await recordMeterEvent({
      ctx,
      key,
      quantity: actualQuantity,
      creditsMilli: settledCostMilli,
      outcome: "ok",
      mode: effectiveMode,
      reported,
    }).catch((err) => logger.warn({ err, key }, "credit meter: failed to record a successful call"));
    return result;
  } catch (error) {
    // The whole reason this exists: a failed provider call is still billed by
    // the provider, so it must still be recorded. The CUSTOMER is refunded —
    // a failure that was never their fault should not cost them — which means
    // provider failure waste lands on the platform, where it is visible in the
    // report and can be engineered away. A provider result or a persisted
    // success marker means work may have completed remotely. Never turn that
    // into a refund merely because local settlement/validation failed, and do
    // not append a second "failed" event.
    if (providerCallReturned || dispatchOutcomePersisted) {
      throw error;
    }
    await recordMeterEvent({
      ctx,
      key,
      quantity,
      creditsMilli: costMilli,
      outcome: "failed",
      mode: effectiveMode,
    }).catch((err) => logger.warn({ err, key }, "credit meter: failed to record a failed call"));
    let confirmed = false;
    try {
      confirmed = options.isFailureConfirmed
        ? options.isFailureConfirmed(error)
        : isDefinitiveProviderRejection(error);
    } catch (classifierError) {
      logger.error(
        { err: classifierError, key, tenantId: ctx.tenantId },
        "credit meter: failure classifier threw; treating provider outcome as ambiguous",
      );
    }
    if (debited && !confirmed) {
      await markCreditMeterDispatchOutcome({
        tenantId: ctx.tenantId,
        spendKey: debitReceiptKey!,
        refundKey: failureRefundKey!,
        creditsMilli: costMilli,
        outcome: "ambiguous",
        rateKey: key,
        refKind: ctx.refKind ?? null,
        refId: ctx.refId ?? null,
        error: error instanceof Error ? error.message : String(error),
      }).catch((persistError) => {
        logger.error(
          { err: persistError, key },
          "credit meter: could not persist ambiguous provider outcome",
        );
      });
      throw new MeterDispatchOutcomeUnknownError(error);
    }
    if (debited) {
      let failureReceiptPersisted = false;
      try {
        // The failed outcome and its exact refund outbox marker must commit in
        // one transaction. If that transaction fails, the started receipt is
        // deliberately left ambiguous rather than claiming a refund is
        // pending when no durable receipt exists.
        await markCreditMeterDispatchFailedWithRefund({
          tenantId: ctx.tenantId,
          spendKey: debitReceiptKey!,
          refundKey: failureRefundKey!,
          creditsMilli: costMilli,
          rateKey: key,
          refKind: ctx.refKind ?? null,
          refId: ctx.refId ?? null,
          error: error instanceof Error ? error.message : String(error),
        });
        failureReceiptPersisted = true;
        await refundCredits({
          tenantId: ctx.tenantId,
          creditsMilli: costMilli,
          rateKey: key,
          refKind: ctx.refKind ?? null,
          refId: ctx.refId ?? null,
          idempotencyKey: failureRefundKey,
          note: "Generation failed",
        });
      } catch (refundError) {
        if (failureReceiptPersisted) {
          // The pending marker is the durable handoff. Keep the provider error
          // as the route-facing error and let the scoped recovery worker retry
          // this exact refund without replaying the provider.
          logger.error(
            { err: refundError, key, tenantId: ctx.tenantId },
            "credit meter: failed refund remains pending for recovery",
          );
        } else {
          // No failed/outbox receipt committed. The started operation remains
          // explicitly ambiguous and must never be auto-refunded or replayed.
          logger.error(
            { err: refundError, key, tenantId: ctx.tenantId },
            "credit meter: failed outcome receipt unavailable; dispatch remains ambiguous",
          );
        }
      }
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
