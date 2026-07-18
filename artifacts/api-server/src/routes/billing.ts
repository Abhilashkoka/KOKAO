import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  tenantsTable,
  subscriptionsTable,
  creditPacksTable,
} from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
import {
  BillingSubscribeBody,
  BillingVerifySubscriptionBody,
  BillingPurchaseCreditsBody,
  BillingVerifyPurchaseBody,
} from "@workspace/api-zod";
import {
  isRazorpayConfigured,
  getRazorpayKeyId,
  createRazorpaySubscription,
  fetchRazorpaySubscription,
  cancelRazorpaySubscription,
  createRazorpayOrder,
  fetchRazorpayOrder,
  verifyPaymentSignature,
  verifySubscriptionSignature,
  RazorpayNotConfiguredError,
  RazorpayApiError,
} from "../lib/razorpay";
import { getPlan, listPlans } from "../lib/plans";
import { recordServerEvent } from "../lib/analytics";
import { getCreditBalances, grantCredits, listCreditHistory } from "../lib/credits";

/**
 * Tenant billing: Razorpay plan subscriptions + prepaid credit packs.
 * SESSION-scoped (no tenant id in URLs). All writes are OWNER-only — team
 * members and admins operate inside someone else's workspace and must never
 * change its billing.
 */
const router: IRouter = Router();

function requireOwner(req: Request, res: Response): boolean {
  if (req.memberRole !== "owner") {
    res.status(403).json({ error: "Only the workspace owner can manage billing" });
    return false;
  }
  return true;
}

function handleRazorpayError(req: Request, res: Response, error: unknown, msg: string) {
  if (error instanceof RazorpayNotConfiguredError) {
    res.status(503).json({ error: error.message });
    return;
  }
  if (error instanceof RazorpayApiError) {
    req.log.error({ err: error }, msg);
    res.status(502).json({ error: `Payment provider error: ${error.message}` });
    return;
  }
  req.log.error({ err: error }, msg);
  res.status(500).json({ error: msg });
}

/** The tenant's most recent subscription row, if any. */
async function latestSubscription(tenantId: number) {
  return (
    await db
      .select()
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.tenantId, tenantId))
      .orderBy(desc(subscriptionsTable.createdAt), desc(subscriptionsTable.id))
      .limit(1)
  )[0];
}

/**
 * GET /billing
 * Billing overview: configuration state, checkout key, active subscription,
 * credit balances, purchasable packs, and recent credit history.
 */
router.get("/billing", async (req: Request, res: Response) => {
  try {
    const [configured, keyId, sub, balances, packs, history, tenant] =
      await Promise.all([
        isRazorpayConfigured(),
        getRazorpayKeyId(),
        latestSubscription(req.tenantId),
        getCreditBalances(req.tenantId),
        db
          .select()
          .from(creditPacksTable)
          .where(eq(creditPacksTable.active, true))
          .orderBy(creditPacksTable.sortOrder, creditPacksTable.id),
        listCreditHistory(req.tenantId),
        db.select().from(tenantsTable).where(eq(tenantsTable.id, req.tenantId)).limit(1),
      ]);

    res.json({
      configured,
      keyId: configured ? keyId : null,
      plan: tenant[0]?.plan ?? "free",
      subscription: sub
        ? {
            id: sub.id,
            planId: sub.planId,
            status: sub.status,
            billingCycle: sub.billingCycle,
            razorpaySubscriptionId: sub.razorpaySubscriptionId,
            currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
            cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
          }
        : null,
      credits: balances,
      creditPacks: packs.map((p) => ({
        id: p.id,
        name: p.name,
        pricePaise: p.pricePaise,
        captionCredits: p.captionCredits,
        imageCredits: p.imageCredits,
      })),
      history: history.map((h) => ({
        id: h.id,
        kind: h.kind,
        captionDelta: h.captionDelta,
        imageDelta: h.imageDelta,
        note: h.note,
        createdAt: h.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to load billing overview");
    res.status(500).json({ error: "Failed to load billing" });
  }
});

/**
 * POST /billing/subscribe
 * Start a subscription checkout for a paid plan. Creates the Razorpay
 * subscription in "created" state; the browser opens Razorpay Checkout with
 * the returned subscription id, then calls /billing/verify-subscription.
 */
router.post("/billing/subscribe", async (req: Request, res: Response) => {
  if (!requireOwner(req, res)) return;
  const parsed = BillingSubscribeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const plan = (await listPlans()).find((p) => p.id === parsed.data.planId);
  if (!plan) {
    res.status(400).json({ error: "Unknown plan" });
    return;
  }
  const cycle = parsed.data.billingCycle ?? "monthly";
  const cyclePlanId =
    cycle === "yearly" ? plan.razorpayPlanIdYearly : plan.razorpayPlanId;
  const cyclePrice = cycle === "yearly" ? plan.priceInrYearly : plan.priceInr;
  if (!cyclePrice || !cyclePlanId) {
    res.status(400).json({
      error:
        cycle === "yearly"
          ? "This plan does not offer yearly billing"
          : "This plan is not available for online purchase",
    });
    return;
  }

  const existing = await latestSubscription(req.tenantId);
  if (
    existing &&
    (existing.status === "active" || existing.status === "authenticated") &&
    !existing.cancelAtPeriodEnd
  ) {
    res.status(409).json({
      error: "You already have an active subscription. Cancel it before switching plans.",
    });
    return;
  }

  try {
    const rzpSub = await createRazorpaySubscription(
      cyclePlanId,
      {
        tenantId: String(req.tenantId),
        planId: plan.id,
        billingCycle: cycle,
      },
      cycle,
    );
    await db.insert(subscriptionsTable).values({
      tenantId: req.tenantId,
      planId: plan.id,
      razorpaySubscriptionId: rzpSub.id,
      status: rzpSub.status || "created",
      billingCycle: cycle,
    });
    res.json({ razorpaySubscriptionId: rzpSub.id, keyId: await getRazorpayKeyId() });
  } catch (error) {
    handleRazorpayError(req, res, error, "Failed to start subscription");
  }
});

/**
 * POST /billing/verify-subscription
 * Called by the browser after Razorpay Checkout succeeds. Verifies the
 * checkout signature, cross-checks the subscription state with Razorpay,
 * and activates the plan. The webhook remains the backstop.
 */
router.post("/billing/verify-subscription", async (req: Request, res: Response) => {
  if (!requireOwner(req, res)) return;
  const parsed = BillingVerifySubscriptionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const { razorpaySubscriptionId, razorpayPaymentId, razorpaySignature } = parsed.data;

  const sub = (
    await db
      .select()
      .from(subscriptionsTable)
      .where(
        and(
          eq(subscriptionsTable.razorpaySubscriptionId, razorpaySubscriptionId),
          eq(subscriptionsTable.tenantId, req.tenantId),
        ),
      )
      .limit(1)
  )[0];
  if (!sub) {
    res.status(404).json({ error: "Subscription not found" });
    return;
  }

  try {
    const valid = await verifySubscriptionSignature({
      subscriptionId: razorpaySubscriptionId,
      paymentId: razorpayPaymentId,
      signature: razorpaySignature,
    });
    if (!valid) {
      res.status(400).json({ error: "Payment verification failed" });
      return;
    }

    // Trust Razorpay's live state, not just the browser.
    const live = await fetchRazorpaySubscription(razorpaySubscriptionId);
    if (live.status !== "active" && live.status !== "authenticated") {
      res.status(409).json({
        error: `Payment received but the subscription is ${live.status}. It will activate automatically once confirmed.`,
      });
      return;
    }

    await db
      .update(subscriptionsTable)
      .set({
        status: live.status,
        currentPeriodEnd: live.current_end ? new Date(live.current_end * 1000) : null,
        updatedAt: new Date(),
      })
      .where(eq(subscriptionsTable.id, sub.id));
    // The tenant just paid for this plan themselves — a deliberate billing
    // action clears any earlier superadmin plan override.
    await db
      .update(tenantsTable)
      .set({ plan: sub.planId, planOverriddenAt: null, updatedAt: new Date() })
      .where(eq(tenantsTable.id, req.tenantId));

    // Server-side revenue analytics (own billing records, not consent-gated).
    const plan = await getPlan(sub.planId);
    void recordServerEvent({
      name: "subscription_started",
      tenantId: req.tenantId,
      params: { item_type: "subscription", item_name: sub.planId },
    });
    void recordServerEvent({
      name: "purchase",
      tenantId: req.tenantId,
      params: {
        item_type: "subscription",
        item_name: sub.planId,
        amount_paise:
          (sub.billingCycle === "yearly" ? plan?.priceInrYearly : plan?.priceInr) ?? 0,
      },
    });

    res.json({ ok: true, plan: sub.planId });
  } catch (error) {
    handleRazorpayError(req, res, error, "Failed to verify subscription");
  }
});

/**
 * POST /billing/cancel
 * Cancel the active subscription at the end of the paid period.
 */
router.post("/billing/cancel", async (req: Request, res: Response) => {
  if (!requireOwner(req, res)) return;
  const sub = await latestSubscription(req.tenantId);
  if (!sub || (sub.status !== "active" && sub.status !== "authenticated")) {
    res.status(400).json({ error: "No active subscription to cancel" });
    return;
  }
  if (sub.cancelAtPeriodEnd) {
    res.status(400).json({ error: "Subscription is already set to cancel" });
    return;
  }

  try {
    const live = await cancelRazorpaySubscription(sub.razorpaySubscriptionId, true);
    await db
      .update(subscriptionsTable)
      .set({ cancelAtPeriodEnd: true, status: live.status, updatedAt: new Date() })
      .where(eq(subscriptionsTable.id, sub.id));
    void recordServerEvent({
      name: "subscription_cancelled",
      tenantId: req.tenantId,
      params: {
        item_type: "subscription",
        item_name: sub.planId,
        reason: "user_cancelled",
      },
    });
    res.json({ ok: true });
  } catch (error) {
    handleRazorpayError(req, res, error, "Failed to cancel subscription");
  }
});

/**
 * POST /billing/switch-payg
 * Move a free-plan workspace onto Pay As You Go (no payment involved).
 * Paid plans must be cancelled first (the lapse lands on Free automatically;
 * switching to Pay As You Go afterwards is a deliberate choice).
 */
router.post("/billing/switch-payg", async (req: Request, res: Response) => {
  if (!requireOwner(req, res)) return;
  const tenant = (
    await db.select().from(tenantsTable).where(eq(tenantsTable.id, req.tenantId)).limit(1)
  )[0];
  if (!tenant) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const sub = await latestSubscription(req.tenantId);
  if (sub && (sub.status === "active" || sub.status === "authenticated")) {
    res.status(400).json({
      error:
        "Cancel your subscription first; once it ends you can switch to Pay As You Go.",
    });
    return;
  }
  const payg = (await listPlans()).find((p) => p.id === "payg");
  if (!payg) {
    res.status(400).json({ error: "Pay As You Go is not available" });
    return;
  }
  // Deliberate tenant billing action: clears any superadmin plan override.
  await db
    .update(tenantsTable)
    .set({ plan: "payg", planOverriddenAt: null, updatedAt: new Date() })
    .where(eq(tenantsTable.id, req.tenantId));
  res.json({ ok: true, plan: "payg" });
});

/**
 * POST /billing/purchase-credits
 * Create a one-time Razorpay order for a credit pack. The browser opens
 * Checkout with the order id, then calls /billing/verify-purchase.
 */
router.post("/billing/purchase-credits", async (req: Request, res: Response) => {
  if (!requireOwner(req, res)) return;
  const parsed = BillingPurchaseCreditsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const pack = (
    await db
      .select()
      .from(creditPacksTable)
      .where(
        and(eq(creditPacksTable.id, parsed.data.creditPackId), eq(creditPacksTable.active, true)),
      )
      .limit(1)
  )[0];
  if (!pack) {
    res.status(404).json({ error: "Credit pack not found" });
    return;
  }

  try {
    const order = await createRazorpayOrder({
      amountPaise: pack.pricePaise,
      receipt: `cp_${pack.id}_t${req.tenantId}_${Date.now()}`.slice(0, 40),
      notes: {
        purpose: "credit_pack",
        tenantId: String(req.tenantId),
        creditPackId: String(pack.id),
      },
    });
    res.json({
      razorpayOrderId: order.id,
      amountPaise: order.amount,
      keyId: await getRazorpayKeyId(),
    });
  } catch (error) {
    handleRazorpayError(req, res, error, "Failed to create order");
  }
});

/**
 * POST /billing/verify-purchase
 * Verify a credit-pack payment signature, cross-check the order with
 * Razorpay (amount, paid state, and that its notes belong to THIS tenant),
 * and credit the pack. Idempotent per order via the ledger's unique index.
 */
router.post("/billing/verify-purchase", async (req: Request, res: Response) => {
  if (!requireOwner(req, res)) return;
  const parsed = BillingVerifyPurchaseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = parsed.data;

  try {
    const valid = await verifyPaymentSignature({
      orderId: razorpayOrderId,
      paymentId: razorpayPaymentId,
      signature: razorpaySignature,
    });
    if (!valid) {
      res.status(400).json({ error: "Payment verification failed" });
      return;
    }

    const order = await fetchRazorpayOrder(razorpayOrderId);
    const notes = order.notes ?? {};
    if (
      notes.purpose !== "credit_pack" ||
      Number(notes.tenantId) !== req.tenantId
    ) {
      res.status(400).json({ error: "Order does not belong to this workspace" });
      return;
    }
    if (order.status !== "paid") {
      res.status(409).json({ error: "Payment not confirmed yet" });
      return;
    }
    const pack = (
      await db
        .select()
        .from(creditPacksTable)
        .where(eq(creditPacksTable.id, Number(notes.creditPackId)))
        .limit(1)
    )[0];
    if (!pack || order.amount !== pack.pricePaise) {
      res.status(400).json({ error: "Order does not match the credit pack" });
      return;
    }

    await grantCredits({
      tenantId: req.tenantId,
      captionCredits: pack.captionCredits,
      imageCredits: pack.imageCredits,
      kind: "purchase",
      razorpayOrderId,
      creditPackId: pack.id,
      note: pack.name,
    });
    void recordServerEvent({
      name: "purchase",
      tenantId: req.tenantId,
      params: {
        item_type: "credit_pack",
        item_name: pack.name,
        amount_paise: pack.pricePaise,
      },
    });
    // Duplicate grants (webhook raced us) are fine — balance is already right.
    res.json({ ok: true, credits: await getCreditBalances(req.tenantId) });
  } catch (error) {
    handleRazorpayError(req, res, error, "Failed to verify purchase");
  }
});

export default router;
