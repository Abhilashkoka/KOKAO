import { Router, type IRouter, type Request, type Response } from "express";
import { WalletRechargeBody, WalletVerifyRechargeBody } from "@workspace/api-zod";
import {
  isRazorpayConfigured,
  getRazorpayKeyId,
  createRazorpayOrder,
  fetchRazorpayOrder,
  verifyPaymentSignature,
  RazorpayNotConfiguredError,
  RazorpayApiError,
} from "../lib/razorpay";
import {
  getWalletConfig,
  getWalletBalancePaise,
  isWalletFunded,
  estimateChargePaise,
  listWalletHistory,
  creditWalletTopup,
  gstOn,
  withGst,
} from "../lib/wallet";
import { recordServerEvent } from "../lib/analytics";

/**
 * Prepaid rupee wallet, tenant-facing. SESSION-scoped (no tenant id in URLs),
 * and every write is OWNER-only — same rule as the rest of billing.
 *
 * Money shown here is GST-EXCLUSIVE. GST is applied once, when the Razorpay
 * order is created, and only the base amount is ever credited to the wallet.
 *
 * The whole prefix is gated by the `wallet` feature switch in routes/index.ts.
 */
const router: IRouter = Router();

function requireOwner(req: Request, res: Response): boolean {
  if (req.memberRole !== "owner") {
    res.status(403).json({ error: "Only the workspace owner can manage the wallet" });
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
 * GET /wallet
 * Balance, GST rate, indicative per-generation rates, and recent history.
 */
router.get("/wallet", async (req: Request, res: Response) => {
  try {
    const [configured, keyId, balancePaise, config, walletBilling, history] =
      await Promise.all([
        isRazorpayConfigured(),
        getRazorpayKeyId(),
        getWalletBalancePaise(req.tenantId),
        getWalletConfig(),
        isWalletFunded(req.tenantId),
        listWalletHistory(req.tenantId),
      ]);
    const [captionPaise, imagePaise, videoPaise] = await Promise.all([
      estimateChargePaise("caption"),
      estimateChargePaise("image"),
      estimateChargePaise("video"),
    ]);

    res.json({
      walletBilling,
      configured,
      keyId: configured ? keyId : null,
      balancePaise,
      gstPercent: config.gstPercent,
      minTopupPaise: config.minTopupPaise,
      lowBalanceThresholdPaise: config.lowBalanceThresholdPaise,
      lowBalance:
        config.lowBalanceThresholdPaise > 0 &&
        balancePaise < config.lowBalanceThresholdPaise,
      rates: { captionPaise, imagePaise, videoPaise },
      history: history.map((h) => ({
        id: h.id,
        kind: h.kind,
        amountPaise: h.amountPaise,
        baseAmountPaise: h.baseAmountPaise,
        gstAmountPaise: h.gstAmountPaise,
        gstPercent: h.gstPercent,
        usageKind: h.usageKind,
        model: h.model,
        estimated: h.estimated,
        note: h.note,
        createdAt: h.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to load wallet overview");
    res.status(500).json({ error: "Failed to load wallet" });
  }
});

/**
 * POST /wallet/recharge
 * Create a one-time Razorpay order for a top-up. The tenant asked for a
 * GST-exclusive amount; the order is raised for that amount PLUS GST, and the
 * base is recorded in the order notes so verification credits exactly it.
 */
router.post("/wallet/recharge", async (req: Request, res: Response) => {
  if (!requireOwner(req, res)) return;
  const parsed = WalletRechargeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const config = await getWalletConfig();
  const basePaise = parsed.data.amountPaise;
  if (basePaise < config.minTopupPaise) {
    res.status(400).json({
      error: `The minimum top-up is ₹${(config.minTopupPaise / 100).toLocaleString("en-IN")}.`,
    });
    return;
  }

  const gstPaise = gstOn(basePaise, config.gstPercent);
  const totalPaise = withGst(basePaise, config.gstPercent);

  try {
    const order = await createRazorpayOrder({
      amountPaise: totalPaise,
      receipt: `w_t${req.tenantId}_${Date.now()}`.slice(0, 40),
      notes: {
        purpose: "wallet_topup",
        tenantId: String(req.tenantId),
        basePaise: String(basePaise),
        gstPaise: String(gstPaise),
        gstPercent: String(config.gstPercent),
      },
    });
    res.json({
      razorpayOrderId: order.id,
      basePaise,
      gstPaise,
      gstPercent: config.gstPercent,
      totalPaise: order.amount,
      keyId: await getRazorpayKeyId(),
    });
  } catch (error) {
    handleRazorpayError(req, res, error, "Failed to create wallet top-up order");
  }
});

/**
 * POST /wallet/verify-recharge
 * Verify the checkout signature, cross-check the order with Razorpay (amount,
 * paid state, and that its notes belong to THIS workspace), then credit the
 * BASE amount. Idempotent per order via the ledger's unique index.
 */
router.post("/wallet/verify-recharge", async (req: Request, res: Response) => {
  if (!requireOwner(req, res)) return;
  const parsed = WalletVerifyRechargeBody.safeParse(req.body);
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
    if (notes.purpose !== "wallet_topup" || Number(notes.tenantId) !== req.tenantId) {
      res.status(400).json({ error: "Order does not belong to this workspace" });
      return;
    }
    if (order.status !== "paid") {
      res.status(409).json({ error: "Payment not confirmed yet" });
      return;
    }

    // Trust the order's own notes for the split, not the current settings —
    // the GST rate may have changed between checkout and verification.
    const basePaise = Number(notes.basePaise);
    const gstPaise = Number(notes.gstPaise);
    const gstPercent = Number(notes.gstPercent);
    if (
      !Number.isInteger(basePaise) ||
      basePaise <= 0 ||
      basePaise + gstPaise !== order.amount
    ) {
      res.status(400).json({ error: "Order does not match the top-up amount" });
      return;
    }

    await creditWalletTopup({
      tenantId: req.tenantId,
      basePaise,
      gstPaise,
      gstPercent,
      razorpayOrderId,
      note: "Wallet top-up",
    });
    void recordServerEvent({
      name: "purchase",
      tenantId: req.tenantId,
      params: {
        item_type: "wallet_topup",
        item_name: "wallet",
        amount_paise: order.amount,
      },
    });
    // A duplicate credit (webhook raced us) is fine — the balance is correct.
    res.json({ ok: true, balancePaise: await getWalletBalancePaise(req.tenantId) });
  } catch (error) {
    // A nonexistent or malformed order id makes Razorpay's fetch fail with a
    // 4xx. Treat it exactly like a bad signature: a generic 400 that never
    // reveals whether an order exists, and never a 5xx.
    if (error instanceof RazorpayApiError && error.status >= 400 && error.status < 500) {
      res.status(400).json({ error: "Payment verification failed" });
      return;
    }
    handleRazorpayError(req, res, error, "Failed to verify the top-up");
  }
});

export default router;
