import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  tenantsTable,
  subscriptionsTable,
  creditPacksTable,
  planSettingsTable,
} from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
import {
  BillingSubscribeBody,
  BillingVerifySubscriptionBody,
  BillingPurchaseCreditsBody,
  BillingVerifyPurchaseBody,
  BillingRedeemPromoBody,
} from "@workspace/api-zod";
import { redeemPromoCode } from "../lib/promoCodes";
import {
  isRazorpayConfigured,
  getRazorpayKeyId,
  createRazorpaySubscription,
  fetchRazorpaySubscription,
  cancelRazorpaySubscription,
  createRazorpayOrder,
  createRazorpayPlan,
  fetchRazorpayOrder,
  verifyPaymentSignature,
  verifySubscriptionSignature,
  RazorpayNotConfiguredError,
  RazorpayApiError,
} from "../lib/razorpay";
import {
  applyPlanBillingMode,
  getPlan,
  invalidatePlanCache,
  listPlans,
} from "../lib/plans";
import { recordServerEvent } from "../lib/analytics";
import { getCreditBalances, grantCredits, listCreditHistory } from "../lib/credits";
import { notifyUpgradeRequested } from "../lib/notifications";
import { fetchVerifiedEmail } from "../lib/clerkUser";

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

/**
 * True only when Razorpay explicitly reports an id (subscription or order) as
 * unknown (deleted / never existed) — a 400/404 whose description says the id
 * is not valid or not found. Auth failures, throttling, and other 4xx do NOT
 * match.
 */
function isRazorpayLostIdError(error: unknown): boolean {
  if (!(error instanceof RazorpayApiError)) return false;
  if (error.status !== 400 && error.status !== 404) return false;
  return /not a valid id|not found|does not exist|no such/i.test(error.message);
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
        videoCredits: p.videoCredits,
      })),
      history: history.map((h) => ({
        id: h.id,
        kind: h.kind,
        captionDelta: h.captionDelta,
        imageDelta: h.imageDelta,
        videoDelta: h.videoDelta,
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
  let cyclePlanId =
    cycle === "yearly" ? plan.razorpayPlanIdYearly : plan.razorpayPlanId;
  const cyclePrice = cycle === "yearly" ? plan.priceInrYearly : plan.priceInr;
  // Lazy mint: an admin may have priced this plan before Razorpay keys were
  // configured (that save no longer blocks). Heal the link at first purchase.
  if (cyclePrice && !cyclePlanId && (await isRazorpayConfigured())) {
    try {
      const minted = await createRazorpayPlan(
        plan.name,
        cyclePrice,
        cycle === "yearly" ? "yearly" : "monthly",
      );
      await db
        .update(planSettingsTable)
        .set(
          cycle === "yearly"
            ? { razorpayPlanIdYearly: minted.id, updatedAt: new Date() }
            : { razorpayPlanId: minted.id, updatedAt: new Date() },
        )
        .where(eq(planSettingsTable.id, plan.id));
      invalidatePlanCache();
      cyclePlanId = minted.id;
    } catch (error) {
      req.log.error({ err: error }, "Lazy Razorpay plan mint failed");
    }
  }
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
    await applyPlanBillingMode(req.tenantId, sub.planId);

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
    // A local subscription row can point at an id Razorpay no longer knows
    // (e.g. deleted in the dashboard). Razorpay answers the live-state fetch
    // with a 4xx — surface that as a clear, actionable 400 instead of a
    // confusing "payment provider error" gateway 502. Nothing was mutated
    // yet: the fetch happens before any plan/subscription-row writes.
    if (
      error instanceof RazorpayApiError &&
      error.status >= 400 &&
      error.status < 500
    ) {
      res.status(400).json({
        error:
          "Razorpay no longer recognizes this subscription. Please start a new subscription or contact support.",
      });
      return;
    }
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
    // Razorpay may no longer know the stored subscription id (e.g. it was
    // deleted from the Razorpay dashboard). Only when the error explicitly
    // says the id is unknown do we surface a clear, actionable 400 and mark
    // the stale local row cancelled so the user isn't stuck with an
    // uncancellable ghost subscription. Other 4xx (auth, throttling, ...)
    // stay on the generic provider-error path with no local mutation.
    if (isRazorpayLostIdError(error)) {
      await db
        .update(subscriptionsTable)
        .set({ status: "cancelled", cancelAtPeriodEnd: true, updatedAt: new Date() })
        .where(eq(subscriptionsTable.id, sub.id));
      res.status(400).json({
        error:
          "Razorpay no longer recognizes this subscription, so there is nothing to cancel there. It has been marked cancelled here — you can start a new subscription anytime.",
      });
      return;
    }
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
  await applyPlanBillingMode(req.tenantId, "payg");
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
      videoCredits: pack.videoCredits,
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
    // A stored order id Razorpay no longer knows (deleted in the dashboard,
    // or never existed) makes the order fetch fail with a 4xx saying the id
    // is invalid. Surface that as the same clear, actionable 400 the
    // subscription flows use — not a confusing 502 "Payment provider error".
    // Reaching this point already required a valid signature over the order
    // id, so this is no order-existence oracle.
    if (isRazorpayLostIdError(error)) {
      res.status(400).json({
        error:
          "Razorpay no longer recognizes this order. Please start a new purchase or contact support.",
      });
      return;
    }
    // Any other Razorpay 4xx (auth failure, throttling, malformed request)
    // stays a generic 400, never a 5xx.
    if (
      error instanceof RazorpayApiError &&
      error.status >= 400 &&
      error.status < 500
    ) {
      res.status(400).json({ error: "Payment verification failed" });
      return;
    }
    handleRazorpayError(req, res, error, "Failed to verify purchase");
  }
});

/**
 * POST /billing/request-upgrade
 * A team member (or admin) asks the workspace OWNER to upgrade the plan or
 * add credits. Owners cannot call it — they can just upgrade directly. The
 * notification helper dedupes on an existing unread alert (updated in place,
 * no re-email) and enforces a per-workspace cooldown between fresh alerts.
 */
router.post("/billing/request-upgrade", async (req: Request, res: Response) => {
  if (req.memberRole === "owner") {
    res.status(400).json({
      error: "You are the workspace owner — you can upgrade the plan directly.",
    });
    return;
  }
  try {
    let email: string | null = null;
    try {
      email = await fetchVerifiedEmail(req.clerkUserId);
    } catch {
      // Best-effort: the notification falls back to "A teammate".
    }
    const outcome = await notifyUpgradeRequested(req.tenantId, {
      email,
      clerkUserId: req.clerkUserId,
    });
    if (outcome === "cooldown") {
      res.status(429).json({
        error:
          "You already asked for an upgrade recently. Give the owner a little time to respond.",
      });
      return;
    }
    res.json({ ok: true, deduped: outcome === "updated" });
  } catch (error) {
    req.log.error({ err: error }, "Failed to submit upgrade request");
    res.status(500).json({ error: "Could not send the request. Please try again." });
  }
});

/**
 * POST /billing/promo/redeem
 * Redeem a promo code for prepaid credits (owner only). All eligibility
 * checks and the grant run atomically inside the redemption engine; the
 * route just translates the outcome. Rejections come back as 400 with a
 * user-readable message and a machine `code`.
 */
router.post("/billing/promo/redeem", async (req: Request, res: Response) => {
  if (!requireOwner(req, res)) return;
  const parsed = BillingRedeemPromoBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter a promo code." });
    return;
  }
  try {
    const result = await redeemPromoCode(req.tenantId, parsed.data.code);
    if (!result.ok) {
      res.status(400).json({ error: result.message, code: result.reason });
      return;
    }
    void recordServerEvent({
      name: "promo_redeemed",
      tenantId: req.tenantId,
      params: {
        caption_credits: result.captionCredits,
        image_credits: result.imageCredits,
        video_credits: result.videoCredits,
      },
    });
    res.json({
      ok: true,
      captionCredits: result.captionCredits,
      imageCredits: result.imageCredits,
      videoCredits: result.videoCredits,
      message: result.message,
    });
  } catch (error) {
    req.log.error({ err: error }, "Promo redemption failed");
    res.status(500).json({ error: "Could not redeem the code. Please try again." });
  }
});

export default router;
