import {
  db, refundReconciliationsTable as refunds, creatorCommissionsTable as commissions,
  referralPurchaseGrantsTable as grants, creatorLedgerAdjustmentsTable as adjustments,
  creatorPayoutsTable as payouts, invoicesTable as invoices,
} from "@workspace/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { logger } from "./logger";

/** Call only after canonical gateway refund/payment/order binding checks. */
export interface RefundEvent {
  gateway: "razorpay" | "cashfree"; refundId: string; tenantId: number;
  kind: string; refId: string; refundedPaise: number; purchasePaise: number;
}
export interface RefundOutcome {
  commissionAction: "none" | "reversed" | "clawed_back" | "needs_manual_review";
  referralGrantFound: boolean; commissionFound: boolean; retryable?: boolean;
}
/** Cumulative target rounding ensures two half refunds equal one full refund. */
export function refundCommissionTarget(original: number, refunded: number, gross: number) {
  return Number(BigInt(original) * BigInt(Math.min(gross, refunded)) / BigInt(gross));
}
async function applyPurchase(event: RefundEvent): Promise<RefundOutcome> {
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(73142, 1)`);
    const where = and(eq(refunds.gateway, event.gateway), eq(refunds.tenantId, event.tenantId), eq(refunds.kind, event.kind), eq(refunds.refId, event.refId));
    const rows = await tx.select().from(refunds).where(where).for("update");
    const [grant] = await tx.select({ id: grants.id }).from(grants).where(and(eq(grants.purchaseKind, event.kind), eq(grants.purchaseRefId, event.refId)));
    const out: RefundOutcome = { commissionAction: "none", referralGrantFound: !!grant, commissionFound: false };
    const [invoice] = await tx.select().from(invoices).where(and(eq(invoices.kind, event.kind), eq(invoices.refId, event.refId)));
    const [c] = await tx.select().from(commissions).where(and(eq(commissions.purchaseKind, event.kind), eq(commissions.purchaseRefId, event.refId))).for("update");
    const setStatus = async (status: string, detail: string) => {
      await tx.update(refunds).set({ status, detail, updatedAt: new Date() }).where(where);
    };
    if ((invoice && (invoice.tenantId !== event.tenantId || invoice.gateway !== event.gateway || invoice.totalPaise !== event.purchasePaise)) ||
        (c && (c.tenantId !== event.tenantId || c.grossPaise !== event.purchasePaise))) {
      await setStatus("needs_manual_review", "Purchase binding mismatch");
      out.commissionAction = "needs_manual_review"; return out;
    }
    if (!c) {
      // Keep tombstone pending: delayed paid delivery may still accrue a commission.
      await setStatus("pending", "No commission yet; referral credits deliberately retained");
      return out;
    }
    out.commissionFound = true;
    if (c.state === "in_payout") {
      await setStatus("needs_manual_review", "Reconcile the in-flight payout as paid or failed first");
      out.commissionAction = "needs_manual_review"; return out;
    }
    const cumulative = Math.min(c.grossPaise, rows.reduce((n, r) => n + r.refundedPaise, 0));
    if (["reversed", "expired"].includes(c.state)) {
      await setStatus("reconciled", "Commission already closed; referral credits retained"); return out;
    }
    const original = Number(BigInt(c.grossPaise) * BigInt(c.commissionBps) / 10000n);
    const target = refundCommissionTarget(original, cumulative, c.grossPaise);
    const delta = Math.max(0, target - c.refundedCommissionPaise);
    if (c.state === "paid" && delta > 0) {
      let remainder = delta;
      const reserves = await tx.select().from(payouts).where(and(eq(payouts.creatorId, c.creatorId), eq(payouts.status, "paid"), isNull(payouts.reserveReleasedAt))).orderBy(payouts.id).for("update");
      for (const p of reserves) {
        const absorbed = Math.min(remainder, Math.max(0, p.reserveHeldPaise - p.reserveConsumedPaise));
        if (!absorbed) continue;
        await tx.update(payouts).set({ reserveConsumedPaise: p.reserveConsumedPaise + absorbed }).where(eq(payouts.id, p.id));
        await tx.insert(adjustments).values({ creatorId: c.creatorId, amountPaise: absorbed, kind: "reserve_offset",
          commissionId: c.id, payoutId: p.id, idempotencyKey: `refund-offset:${c.id}:${target}:${p.id}`, note: "Reserve applied to refunded purchase" });
        remainder -= absorbed;
      }
      await tx.insert(adjustments).values({ creatorId: c.creatorId, amountPaise: -delta, kind: "clawback",
        commissionId: c.id, payoutId: c.payoutId, idempotencyKey: `refund-clawback:${c.id}:${target}`, note: "Proportional purchase refund" });
      out.commissionAction = "clawed_back";
    } else if (delta > 0) out.commissionAction = "reversed";
    await tx.update(commissions).set({
      refundedPaise: cumulative, refundedCommissionPaise: target, netPaise: c.grossPaise - cumulative,
      commissionPaise: c.state === "paid" ? c.commissionPaise : c.commissionPaise - delta,
      state: cumulative === c.grossPaise ? "reversed" : c.state,
      stateReason: "Purchase refund reconciled proportionally; buyer bonus credits retained",
    }).where(eq(commissions.id, c.id));
    await setStatus("reconciled", "Commission adjusted; referral and buyer bonus credits deliberately retained");
    return out;
  });
}
/** Never throws. retryable means receipt could NOT be persisted: gateway must redeliver. */
export async function reconcileRefund(event: RefundEvent): Promise<RefundOutcome> {
  const failure: RefundOutcome = { commissionAction: "needs_manual_review", referralGrantFound: false, commissionFound: false };
  try {
    if (!["credit_pack", "wallet_topup", "plan"].includes(event.kind) ||
      !event.refId || !event.refundId || event.refId.length > 250 || event.refundId.length > 250 ||
      ![event.tenantId, event.refundedPaise, event.purchasePaise].every(n => Number.isSafeInteger(n) && n > 0 && n <= 2147483647)) {
      return { ...failure, retryable: true };
    }
    await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(73142, 1)`);
      await tx.insert(refunds).values(event).onConflictDoNothing();
      const [prior] = await tx.select().from(refunds).where(and(eq(refunds.gateway, event.gateway), eq(refunds.refundId, event.refundId)));
      if (!prior || prior.tenantId !== event.tenantId || prior.refId !== event.refId ||
        prior.kind !== event.kind || prior.refundedPaise !== event.refundedPaise || prior.purchasePaise !== event.purchasePaise) throw new Error("refund binding mismatch");
    });
  } catch {
    logger.error("Refund receipt could not be persisted; gateway redelivery required");
    return { ...failure, retryable: true };
  }
  try { return await applyPurchase(event); }
  catch {
    // Receipt remains pending (or review-needed), durable and payout-blocking.
    logger.error({ gateway: event.gateway, refundId: event.refundId }, "Refund accounting pending retry");
    return failure;
  }
}
/** Accounting-only maintenance and post-invoice replay, including batches resolved by operators. */
export async function retryRefundReconciliations(refId?: string) {
  const rows = await db.select().from(refunds).where(and(inArray(refunds.status, ["pending", "needs_manual_review"]),
    refId ? eq(refunds.refId, refId) : undefined)).orderBy(refunds.updatedAt).limit(200);
  for (const row of rows) {
    await reconcileRefund({ ...row, gateway: row.gateway as RefundEvent["gateway"] });
  }
}