import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  razorpayEventsTable,
  subscriptionsTable,
  tenantsTable,
  creditPacksTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { verifyWebhookSignature, fetchRazorpayOrder } from "../lib/razorpay";
import { grantCredits } from "../lib/credits";

/**
 * PUBLIC Razorpay webhook receiver (mounted before requireTenant). Every
 * request must carry a valid x-razorpay-signature (HMAC over the raw body
 * with the configured webhook secret); everything else is rejected.
 *
 * Idempotent: each Razorpay event id is recorded in razorpay_events on first
 * processing, and redeliveries are acknowledged without reprocessing.
 * Credit grants are additionally deduped per order id in the credit ledger.
 */
const router: IRouter = Router();

interface WebhookEvent {
  event?: string;
  payload?: {
    subscription?: {
      entity?: {
        id?: string;
        status?: string;
        current_end?: number | null;
        notes?: Record<string, string>;
      };
    };
    payment?: {
      entity?: {
        id?: string;
        order_id?: string;
        notes?: Record<string, string>;
      };
    };
    order?: { entity?: { id?: string; notes?: Record<string, string> } };
  };
}

/** Map a Razorpay subscription status onto the tenant's plan entitlement. */
function isEntitledStatus(status: string): boolean {
  return status === "active" || status === "authenticated";
}

async function handleSubscriptionEvent(
  req: Request,
  entity: NonNullable<NonNullable<WebhookEvent["payload"]>["subscription"]>["entity"],
): Promise<void> {
  const subscriptionId = entity?.id;
  const status = entity?.status;
  if (!subscriptionId || !status) return;

  const sub = (
    await db
      .select()
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.razorpaySubscriptionId, subscriptionId))
      .limit(1)
  )[0];
  if (!sub) {
    req.log.warn({ subscriptionId }, "Webhook for unknown subscription");
    return;
  }

  await db
    .update(subscriptionsTable)
    .set({
      status,
      currentPeriodEnd: entity?.current_end
        ? new Date(entity.current_end * 1000)
        : sub.currentPeriodEnd,
      updatedAt: new Date(),
    })
    .where(eq(subscriptionsTable.id, sub.id));

  if (isEntitledStatus(status)) {
    await db
      .update(tenantsTable)
      .set({ plan: sub.planId, updatedAt: new Date() })
      .where(eq(tenantsTable.id, sub.tenantId));
  } else if (
    status === "cancelled" ||
    status === "expired" ||
    status === "completed" ||
    status === "halted"
  ) {
    // Lapse to Pay As You Go only if the tenant is still on the plan this
    // subscription paid for (a superadmin override or newer sub wins).
    const tenant = (
      await db.select().from(tenantsTable).where(eq(tenantsTable.id, sub.tenantId)).limit(1)
    )[0];
    if (tenant && tenant.plan === sub.planId) {
      await db
        .update(tenantsTable)
        .set({ plan: "payg", updatedAt: new Date() })
        .where(eq(tenantsTable.id, sub.tenantId));
    }
  }
}

/**
 * Backstop crediting for one-time credit-pack orders: if the browser closed
 * before verification, the payment.captured webhook still credits the pack.
 * Order notes carry tenantId + creditPackId (set when the order was created).
 */
async function handlePaymentCaptured(
  req: Request,
  payment: NonNullable<NonNullable<WebhookEvent["payload"]>["payment"]>["entity"],
): Promise<void> {
  const orderId = payment?.order_id;
  const paymentNotes = payment?.notes ?? {};
  if (!orderId || paymentNotes.purpose !== "credit_pack") return;

  // Don't trust the delivered payload's notes: fetch the canonical order from
  // Razorpay and validate purpose, tenant, pack, and amount before crediting
  // (mirrors the interactive /billing/verify-purchase checks).
  const order = await fetchRazorpayOrder(orderId);
  const notes = order.notes ?? {};
  if (notes.purpose !== "credit_pack") return;
  if (order.status !== "paid") {
    req.log.warn({ orderId, status: order.status }, "Webhook order not paid; skipping credit");
    return;
  }
  const tenantId = Number(notes.tenantId);
  const packId = Number(notes.creditPackId);
  if (!Number.isInteger(tenantId) || !Number.isInteger(packId)) return;

  const pack = (
    await db.select().from(creditPacksTable).where(eq(creditPacksTable.id, packId)).limit(1)
  )[0];
  if (!pack) {
    req.log.warn({ packId, orderId }, "Webhook credit pack not found");
    return;
  }
  if (order.amount !== pack.pricePaise) {
    req.log.warn({ packId, orderId, amount: order.amount }, "Webhook order amount mismatch");
    return;
  }
  const granted = await grantCredits({
    tenantId,
    captionCredits: pack.captionCredits,
    imageCredits: pack.imageCredits,
    kind: "purchase",
    razorpayOrderId: orderId,
    creditPackId: pack.id,
    note: `${pack.name} (webhook)`,
  });
  if (granted) {
    req.log.info({ tenantId, packId, orderId }, "Credited pack via webhook backstop");
  }
}

router.post("/billing/razorpay-webhook", async (req: Request, res: Response) => {
  const signature = req.header("x-razorpay-signature") ?? "";
  const rawBody = req.rawBody ?? "";
  if (!rawBody || !(await verifyWebhookSignature(rawBody, signature))) {
    res.status(400).json({ error: "Invalid signature" });
    return;
  }

  const event = req.body as WebhookEvent;
  const eventId = req.header("x-razorpay-event-id");
  if (eventId) {
    // First-writer wins: a redelivered event id is acknowledged untouched.
    const inserted = await db
      .insert(razorpayEventsTable)
      .values({ id: eventId, eventType: event.event ?? "unknown" })
      .onConflictDoNothing()
      .returning();
    if (inserted.length === 0) {
      res.json({ ok: true, duplicate: true });
      return;
    }
  }

  try {
    if (event.event?.startsWith("subscription.")) {
      await handleSubscriptionEvent(req, event.payload?.subscription?.entity);
    } else if (event.event === "payment.captured") {
      await handlePaymentCaptured(req, event.payload?.payment?.entity);
    }
    res.json({ ok: true });
  } catch (error) {
    req.log.error({ err: error, event: event.event }, "Webhook processing failed");
    // 500 so Razorpay retries; the event-id row blocks double-processing of
    // whatever DID complete only if we got far enough — remove it so the
    // retry can run the handler again.
    if (eventId) {
      await db.delete(razorpayEventsTable).where(eq(razorpayEventsTable.id, eventId));
    }
    res.status(500).json({ error: "Webhook processing failed" });
  }
});

export default router;
