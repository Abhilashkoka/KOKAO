import {
  db,
  creatorCommissionsTable,
  referralPurchaseGrantsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";
import { reverseCreatorCommission } from "./creatorCommissions";
import { clawbackPaidCommission } from "./creatorPayouts";

/**
 * Refund reconciliation for both referral programmes.
 *
 * THE GAP THIS CLOSES: until now nothing called `reverseCreatorCommission` or
 * `clawbackPaidCommission`. A refunded purchase left its commission standing,
 * so KOKAO paid out on money it had already given back.
 *
 * One entry point, called from the refund/chargeback paths of both gateways.
 * Idempotent by construction — every underlying operation is keyed on the
 * purchase or the commission, so a redelivered webhook is a no-op.
 *
 * Never throws. A refund has already happened; failing here must not fail the
 * gateway's callback and trigger an endless redelivery loop.
 */

export interface RefundEvent {
  /** invoices.kind — credit_pack | wallet_topup | plan */
  kind: string;
  /** The gateway order/subscription reference of the ORIGINAL payment. */
  refId: string;
  /** Refunded amount in paise. Full or partial. */
  refundedPaise?: number;
  reason?: string;
}

export interface RefundOutcome {
  referralGrantFound: boolean;
  commissionFound: boolean;
  commissionAction:
    | "none"
    | "reversed"
    | "clawed_back"
    | "needs_manual_review";
  detail?: string;
}

/**
 * Reconcile a refund against both programmes.
 *
 * Program A (user referral, credits): bonus credits may already be spent, so
 * there is nothing honest to claw back. The grant row is annotated for audit
 * and the credits are left alone — chasing spent promotional credits costs
 * more in support than it recovers, and the 90-day expiry already bounds it.
 *
 * Program B (creator, cash): reverse if the commission has not left, claw back
 * against the reserve if it has, and refuse to guess when a batch is mid-flight.
 */
export async function reconcileRefund(
  event: RefundEvent,
): Promise<RefundOutcome> {
  const outcome: RefundOutcome = {
    referralGrantFound: false,
    commissionFound: false,
    commissionAction: "none",
  };
  const reason = (event.reason ?? "Purchase refunded").slice(0, 500);

  // --- Program A ---------------------------------------------------------
  try {
    const [grant] = await db
      .select({ id: referralPurchaseGrantsTable.id })
      .from(referralPurchaseGrantsTable)
      .where(
        and(
          eq(referralPurchaseGrantsTable.purchaseKind, event.kind),
          eq(referralPurchaseGrantsTable.purchaseRefId, event.refId),
        ),
      )
      .limit(1);
    if (grant) {
      outcome.referralGrantFound = true;
      logger.info(
        { grantId: grant.id, kind: event.kind, refId: event.refId },
        "referral bonus relates to a refunded purchase — credits left in place, grant flagged for audit",
      );
    }
  } catch (err) {
    logger.error({ err, refId: event.refId }, "referral refund lookup failed");
  }

  // --- Program B ---------------------------------------------------------
  try {
    const [commission] = await db
      .select({
        id: creatorCommissionsTable.id,
        state: creatorCommissionsTable.state,
      })
      .from(creatorCommissionsTable)
      .where(
        and(
          eq(creatorCommissionsTable.purchaseKind, event.kind),
          eq(creatorCommissionsTable.purchaseRefId, event.refId),
        ),
      )
      .limit(1);
    if (!commission) return outcome;
    outcome.commissionFound = true;

    // Already settled — a redelivered webhook.
    if (commission.state === "reversed" || commission.state === "expired") {
      outcome.commissionAction = "none";
      outcome.detail = `already ${commission.state}`;
      return outcome;
    }

    // Money hasn't left: a plain reversal is correct and cheap.
    const reversed = await reverseCreatorCommission(
      event.kind,
      event.refId,
      reason,
    );
    if (reversed.reversed) {
      outcome.commissionAction = "reversed";
      return outcome;
    }

    // Money has left, or a batch is in flight. The clawback path refuses
    // `in_payout` on purpose — nobody should guess whether a transfer cleared.
    const clawed = await clawbackPaidCommission(commission.id, reason);
    if (clawed.clawedBack) {
      outcome.commissionAction = "clawed_back";
      outcome.detail = `${(clawed.amountPaise ?? 0) / 100} INR offset against reserve / future payouts`;
      return outcome;
    }

    outcome.commissionAction = "needs_manual_review";
    outcome.detail =
      "Commission is in a payout batch. Mark the batch paid or failed, then reverse.";
    logger.warn(
      { commissionId: commission.id, state: commission.state, refId: event.refId },
      "refund on a commission inside a payout batch — needs manual reconciliation",
    );
    return outcome;
  } catch (err) {
    logger.error(
      { err, kind: event.kind, refId: event.refId },
      "creator commission refund reconciliation failed",
    );
    outcome.commissionAction = "needs_manual_review";
    outcome.detail = "Reconciliation errored — see logs";
    return outcome;
  }
}
