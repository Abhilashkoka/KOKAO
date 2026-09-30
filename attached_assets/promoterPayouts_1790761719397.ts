import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { db, creatorPayoutsTable } from "@workspace/db";
import { desc, eq, inArray } from "drizzle-orm";
import { requireSuperadmin } from "../middlewares/requireSuperadmin";
import { getCreatorForTenant } from "../lib/creatorProgram";
import {
  buildPayoutRun,
  clawbackPaidCommission,
  exportPayoutBatch,
  getCreatorPayoutIdentity,
  getPayoutBalance,
  listCreatorPayouts,
  markPayoutFailed,
  markPayoutPaid,
  PayoutIdentityError,
  releaseMatureReserves,
  saveCreatorPayoutIdentity,
} from "../lib/creatorPayouts";

/**
 * Payout routes.
 *
 * The promoter half collects bank details and shows history. The admin half
 * builds batches, exports them and records what actually cleared.
 *
 * PII WARNING: the POST body on /promoter/payout-details carries a raw PAN and
 * account number. Never log `req.body` on this router, and keep the tight rate
 * limiter on it (mounted in routes/index.ts).
 */

const router: IRouter = Router();
router.use("/admin/payouts", requireSuperadmin);

const PayoutDetailsBody = z.object({
  pan: z.string().trim().min(10).max(12),
  accountNumber: z.string().trim().min(6).max(24),
  ifsc: z.string().trim().min(11).max(11),
  beneficiaryName: z.string().trim().min(2).max(120),
});

const paise = (n: number) => n / 100;

// ---------------------------------------------------------------------------
// Promoter
// ---------------------------------------------------------------------------

/** What's on file, masked. Never returns a hash or a full number. */
router.get("/promoter/payout-details", async (req: Request, res: Response) => {
  const creator = await getCreatorForTenant(req.tenantId);
  if (!creator) {
    res.status(404).json({ error: "Not a promoter", code: "not_a_promoter" });
    return;
  }
  const identity = await getCreatorPayoutIdentity(creator.id);
  if (!identity) {
    res.json({ onFile: false });
    return;
  }
  res.json({
    onFile: true,
    panLast4: identity.panLast4,
    bankLast4: identity.bankLast4,
    ifsc: identity.ifsc,
    beneficiaryName: identity.beneficiaryName,
    verified: identity.verifiedAt !== null,
  });
});

router.post("/promoter/payout-details", async (req: Request, res: Response) => {
  const creator = await getCreatorForTenant(req.tenantId);
  if (!creator) {
    res.status(404).json({ error: "Not a promoter", code: "not_a_promoter" });
    return;
  }
  const parsed = PayoutDetailsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  try {
    const saved = await saveCreatorPayoutIdentity({
      creatorId: creator.id,
      ...parsed.data,
    });
    res.json({
      onFile: true,
      panLast4: saved.panLast4,
      bankLast4: saved.bankLast4,
      ifsc: saved.ifsc,
      beneficiaryName: saved.beneficiaryName,
      verified: false,
    });
  } catch (error) {
    if (error instanceof PayoutIdentityError) {
      res
        .status(error.code === "pan_in_use" ? 409 : 400)
        .json({ error: error.message, code: error.code });
      return;
    }
    // Deliberately does not log the error object — it may carry the raw input.
    req.log.error(
      { creatorId: creator.id },
      "Saving promoter payout details failed",
    );
    res.status(500).json({ error: "Could not save those details." });
  }
});

router.get("/promoter/payouts", async (req: Request, res: Response) => {
  const creator = await getCreatorForTenant(req.tenantId);
  if (!creator) {
    res.status(404).json({ error: "Not a promoter", code: "not_a_promoter" });
    return;
  }
  const [payouts, balance] = await Promise.all([
    listCreatorPayouts(creator.id),
    getPayoutBalance(creator.id),
  ]);
  res.json({
    balance: {
      payable: paise(balance.payablePaise),
      netOwed: paise(balance.netOwedPaise),
      owedBack: paise(balance.owedBackPaise),
    },
    payouts: payouts.map((p) => ({
      id: p.id,
      gross: paise(p.grossPaise),
      tds: paise(p.tdsPaise),
      tdsRateBps: p.tdsRateBps,
      reserveHeld: paise(p.reserveHeldPaise),
      reserveReleasedAt: p.reserveReleasedAt,
      net: paise(p.netPaise),
      status: p.status,
      paidAt: p.paidAt,
      reference: p.gatewayRef,
    })),
  });
});

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

/** Build draft batches. Sends nothing — a human reviews and exports. */
router.post("/admin/payouts/run", async (req: Request, res: Response) => {
  const summary = await buildPayoutRun();
  req.log.info({ summary }, "promoter payout run built");
  res.json(summary);
});

router.get("/admin/payouts", async (req: Request, res: Response) => {
  const status = z
    .enum(["draft", "exported", "paid", "failed"])
    .optional()
    .safeParse(req.query.status);
  const rows = await db
    .select()
    .from(creatorPayoutsTable)
    .where(
      status.success && status.data
        ? eq(creatorPayoutsTable.status, status.data)
        : undefined,
    )
    .orderBy(desc(creatorPayoutsTable.createdAt))
    .limit(200);
  res.json(rows);
});

/** CSV for the bank portal. Marks the included drafts as exported. */
router.post("/admin/payouts/export", async (req: Request, res: Response) => {
  const parsed = z
    .object({ payoutIds: z.array(z.number().int().positive()).min(1).max(500) })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const csv = await exportPayoutBatch(parsed.data.payoutIds);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="promoter-payouts-${new Date().toISOString().slice(0, 10)}.csv"`,
  );
  res.send(csv);
});

router.post("/admin/payouts/:id/paid", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const ref =
    typeof req.body?.reference === "string"
      ? req.body.reference.slice(0, 200)
      : null;
  const payout = await markPayoutPaid(id, ref);
  if (!payout) {
    res
      .status(409)
      .json({ error: "That payout is not awaiting payment.", code: "bad_state" });
    return;
  }
  res.json({ status: payout.status, paidAt: payout.paidAt });
});

router.post("/admin/payouts/:id/failed", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const payout = await markPayoutFailed(
    id,
    typeof req.body?.reason === "string" ? req.body.reason : "Transfer failed",
  );
  if (!payout) {
    res
      .status(409)
      .json({ error: "That payout is not awaiting payment.", code: "bad_state" });
    return;
  }
  res.json({ status: payout.status });
});

/** Claw back a commission that already went out in a payout. */
router.post(
  "/admin/payouts/clawback/:commissionId",
  async (req: Request, res: Response) => {
    const id = Number(req.params.commissionId);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const result = await clawbackPaidCommission(
      id,
      typeof req.body?.reason === "string"
        ? req.body.reason
        : "Refunded after payout",
    );
    if (!result.clawedBack) {
      res.status(409).json({
        error:
          "That commission hasn't been paid out, or the clawback is already recorded.",
        code: "bad_state",
      });
      return;
    }
    res.json({ clawedBack: true, amount: paise(result.amountPaise ?? 0) });
  },
);

router.post(
  "/admin/payouts/release-reserves",
  async (_req: Request, res: Response) => {
    res.json(await releaseMatureReserves());
  },
);

export default router;
