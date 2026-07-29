import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  cashfreeEventsTable,
  subscriptionsTable,
  tenantsTable,
  creditPacksTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  verifyCashfreeWebhookSignature,
  getCashfreeOrder,
  getCashfreeSubscription,
  isCashfreeEntitledStatus,
  rupeesToPaise,
} from "../lib/cashfree";
import { grantCredits } from "../lib/credits";
import { creditWalletTopup } from "../lib/wallet";
import { applyPlanBillingMode } from "../lib/plans";
import { recordServerEvent } from "../lib/analytics";

/**
 * PUBLIC Cashfree webhook receiver (mounted before requireTenant). Every
 * request must carry a valid x-webhook-signature — base64(HMAC-SHA256(
 * x-webhook-timestamp + rawBody, secretKey)); everything else is rejected.
 *
 * Idempotent: each Cashfree event is recorded in cashfree_events on first
 * processing (keyed by a stable id derived from the event), and redeliveries
 * are acknowledged without reprocessing. Money grants are additionally deduped
 * per order id via the ledger unique indexes.
 *
 * As with Razorpay we NEVER trust the delivered payload for money — the
 * canonical order/subscription is re-fetched and required to be PAID/ACTIVE
 * before crediting or entitling.
 */
const router: IRouter = Router();

interface CashfreeWebhookBody {
  type?: string;
  event_time?: string;
  data?: {
    order?: {
      order_id?: string;
      order_tags?: Record<string, string> | null;
    };
    subscription?: {
      subscription_id?: string;
      subscription_status?: string;
    };
    subscription_details?: {
      subscription_id?: string;
      subscription_status?: string;
    };
    payment?: {
      cf_payment_id?: string | number;
      payment_status?: string;
    };
  };
}

/** A stable idempotency id for the event (Cashfree has no single event id). */
function eventKey(body: CashfreeWebhookBody): string {
  const type = body.type ?? "unknown";
  const orderId = body.data?.order?.order_id;
  const subId =
    body.data?.subscription?.subscription_id ??
    body.data?.subscription_details?.subscription_id;
  const paymentId = body.data?.payment?.cf_payment_id;
  const ts = body.event_time ?? "";
  return `cf_${type}_${orderId ?? subId ?? "na"}_${paymentId ?? ""}_${ts}`.slice(0, 250);
}

/**
 * Backstop for one-time orders (wallet top-ups + credit packs): if the browser
 * closed before verification, the order webhook still credits. The canonical
 * order is re-fetched; its tags carry the purpose/tenant/amount.
 */
async function handleOrderPaid(req: Request, orderId: string): Promise<void> {
  const order = await getCashfreeOrder(orderId);
  if (order.order_status !== "PAID") {
    req.log.warn({ orderId, status: order.order_status }, "Cashfree webhook order not paid");
    return;
  }
  const tags = order.order_tags ?? {};
  const tenantId = Number(tags.tenantId);
  if (!Number.isInteger(tenantId)) return;

  // Never trust the delivered payload for money — cross-check what Cashfree
  // actually charged (rupee decimal) against the tagged amounts, in paise.
  const chargedPaise = rupeesToPaise(order.order_amount);

  if (tags.purpose === "wallet_topup") {
    const basePaise = Number(tags.basePaise);
    const gstPaise = Number(tags.gstPaise);
    const gstPercent = Number(tags.gstPercent);
    if (!Number.isInteger(basePaise) || basePaise <= 0) return;
    if (basePaise + gstPaise !== chargedPaise) {
      req.log.warn(
        { orderId, chargedPaise, expectedPaise: basePaise + gstPaise },
        "Cashfree webhook wallet amount mismatch; skipping credit",
      );
      return;
    }
    const credited = await creditWalletTopup({
      tenantId,
      basePaise,
      gstPaise,
      gstPercent,
      cashfreeOrderId: orderId,
      note: "Wallet top-up (webhook)",
    });
    if (credited) {
      req.log.info({ tenantId, orderId }, "Credited wallet via Cashfree webhook backstop");
      void recordServerEvent({
        name: "purchase",
        tenantId,
        params: {
          item_type: "wallet_topup",
          item_name: "wallet",
          amount_paise: basePaise + gstPaise,
        },
      });
    }
    return;
  }

  if (tags.purpose === "credit_pack") {
    const packId = Number(tags.creditPackId);
    if (!Number.isInteger(packId)) return;
    const pack = (
      await db.select().from(creditPacksTable).where(eq(creditPacksTable.id, packId)).limit(1)
    )[0];
    if (!pack) {
      req.log.warn({ packId, orderId }, "Cashfree webhook credit pack not found");
      return;
    }
    if (pack.pricePaise !== chargedPaise) {
      req.log.warn(
        { orderId, packId, chargedPaise, expectedPaise: pack.pricePaise },
        "Cashfree webhook credit-pack amount mismatch; skipping credit",
      );
      return;
    }
    const granted = await grantCredits({
      tenantId,
      captionCredits: pack.captionCredits,
      imageCredits: pack.imageCredits,
      videoCredits: pack.videoCredits,
      kind: "purchase",
      cashfreeOrderId: orderId,
      creditPackId: pack.id,
      note: `${pack.name} (webhook)`,
    });
    if (granted) {
      req.log.info({ tenantId, packId, orderId }, "Credited pack via Cashfree webhook backstop");
      void recordServerEvent({
        name: "purchase",
        tenantId,
        params: {
          item_type: "credit_pack",
          item_name: pack.name,
          amount_paise: pack.pricePaise,
        },
      });
    }
  }
}

/** Subscription entitlement sync, mirroring the Razorpay webhook logic. */
async function handleSubscriptionEvent(
  req: Request,
  subscriptionId: string,
): Promise<void> {
  const sub = (
    await db
      .select()
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.cashfreeSubscriptionId, subscriptionId))
      .limit(1)
  )[0];
  if (!sub) {
    req.log.warn({ subscriptionId }, "Cashfree webhook for unknown subscription");
    return;
  }

  // Re-fetch the canonical subscription rather than trusting the payload.
  const live = await getCashfreeSubscription(subscriptionId);
  const status = live.subscription_status;
  const periodEnd = live.current_cycle?.cycle_end_time
    ? new Date(live.current_cycle.cycle_end_time)
    : sub.currentPeriodEnd;

  await db
    .update(subscriptionsTable)
    .set({
      status: isCashfreeEntitledStatus(status) ? "active" : status.toLowerCase(),
      currentPeriodEnd: periodEnd,
      updatedAt: new Date(),
    })
    .where(eq(subscriptionsTable.id, sub.id));

  if (isCashfreeEntitledStatus(status)) {
    // Admin override wins over entitlement sync.
    const tenant = (
      await db.select().from(tenantsTable).where(eq(tenantsTable.id, sub.tenantId)).limit(1)
    )[0];
    if (tenant?.planOverriddenAt) {
      req.log.info(
        { subscriptionId, tenantId: sub.tenantId },
        "Skipping plan sync: superadmin plan override is in effect",
      );
      return;
    }
    await db
      .update(tenantsTable)
      .set({ plan: sub.planId, updatedAt: new Date() })
      .where(eq(tenantsTable.id, sub.tenantId));
    await applyPlanBillingMode(sub.tenantId, sub.planId);
  } else if (status === "CANCELLED" || status === "COMPLETED") {
    // Downgrade to Free only once the paid period has actually ended.
    if (periodEnd && periodEnd.getTime() > Date.now()) {
      req.log.info(
        { subscriptionId, status, periodEnd },
        "Cashfree subscription ended but paid period still active; deferring downgrade",
      );
      return;
    }
    const tenant = (
      await db.select().from(tenantsTable).where(eq(tenantsTable.id, sub.tenantId)).limit(1)
    )[0];
    if (tenant && tenant.plan === sub.planId) {
      await db
        .update(tenantsTable)
        .set({ plan: "free", updatedAt: new Date() })
        .where(eq(tenantsTable.id, sub.tenantId));
      await applyPlanBillingMode(sub.tenantId, "free");
      void recordServerEvent({
        name: "subscription_cancelled",
        tenantId: sub.tenantId,
        params: { item_type: "subscription", item_name: sub.planId, reason: status },
      });
    }
  }
}

router.post("/billing/cashfree-webhook", async (req: Request, res: Response) => {
  const signature = req.header("x-webhook-signature") ?? "";
  const timestamp = req.header("x-webhook-timestamp") ?? "";
  const rawBody = req.rawBody ?? "";
  if (
    !rawBody ||
    !(await verifyCashfreeWebhookSignature({ rawBody, timestamp, signature }))
  ) {
    res.status(400).json({ error: "Invalid signature" });
    return;
  }

  const body = req.body as CashfreeWebhookBody;
  const key = eventKey(body);
  // First-writer wins: a redelivered event is acknowledged untouched.
  const inserted = await db
    .insert(cashfreeEventsTable)
    .values({ id: key, eventType: body.type ?? "unknown" })
    .onConflictDoNothing()
    .returning();
  if (inserted.length === 0) {
    res.json({ ok: true, duplicate: true });
    return;
  }

  try {
    const type = body.type ?? "";
    if (type.includes("SUBSCRIPTION")) {
      const subId =
        body.data?.subscription?.subscription_id ??
        body.data?.subscription_details?.subscription_id;
      if (subId) await handleSubscriptionEvent(req, subId);
    } else if (type.includes("PAYMENT_SUCCESS") || type.includes("ORDER")) {
      const orderId = body.data?.order?.order_id;
      if (orderId) await handleOrderPaid(req, orderId);
    }
    res.json({ ok: true });
  } catch (error) {
    req.log.error({ err: error, type: body.type }, "Cashfree webhook processing failed");
    // 500 so Cashfree retries; drop the idempotency row so the retry re-runs.
    await db.delete(cashfreeEventsTable).where(eq(cashfreeEventsTable.id, key));
    res.status(500).json({ error: "Webhook processing failed" });
  }
});

export default router;
