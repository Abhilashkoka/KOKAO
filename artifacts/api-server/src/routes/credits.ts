import { Router, type Request, type Response } from "express";
import { requireTenant } from "../middlewares/requireTenant";
import {
  peekCreditBalance,
  listCreditHistory,
  isCreditFunded,
} from "../lib/creditAccounts";
import {
  quoteVideoJobCredits,
  quoteActionCredits,
  guidedDraftQuoteInput,
} from "../lib/creditQuote";
import { getMeterMode, getSpendGuard } from "../lib/creditRates";
import { db, guidedStoryDraftsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  getVideoJobCreditReceipt,
  ReceiptNotFoundError,
} from "../lib/creditReceipt";
import { grantUnbilledPlanCreditsSafely } from "../lib/monthlyCreditGrant";
import { getLegacyConversionStatus } from "../lib/creditMigration";

/**
 * Tenant-facing credit surface: what the workspace has, what it spent, and
 * what a job is about to cost.
 *
 * The quote endpoint is the one that decides whether a prepaid model actually
 * works. A balance people cannot spend confidently is a balance they stop
 * spending: without a price shown before the button, users ration instead of
 * generating, and a workspace that stops generating churns.
 */

const router = Router();

router.use(requireTenant);

/** GET /credits — balance, meter mode, and recent history. */
router.get("/credits", async (req: Request, res: Response) => {
  // Free plans have no gateway to grant their allowance on, so it is granted
  // here, lazily, once per calendar month. Idempotent, and best-effort: the
  // balance still reads correctly if it fails.
  await grantUnbilledPlanCreditsSafely(req.tenantId);
  const [balance, history, mode, funded, legacyConversion, spendGuard] = await Promise.all([
    peekCreditBalance(req.tenantId),
    listCreditHistory(req.tenantId, 50),
    getMeterMode(),
    isCreditFunded(req.tenantId),
    getLegacyConversionStatus(req.tenantId),
    getSpendGuard(),
  ]);
  // `funded` is the server's own answer to "is this balance what pays for my
  // work right now", so the UI never has to recombine the meter mode and the
  // workspace's rail and risk disagreeing with what the backend enforces.
  // `spendGuard` tells every paid button when to ask "are you sure?" before
  // spending, from one admin setting instead of a number baked into the UI.
  res.json({ ...balance, balance, mode, funded, history, legacyConversion, spendGuard });
});

/**
 * GET /credits/quote — what a job will cost, before it starts.
 *
 * Two shapes:
 *   ?action=image                      one unit of a single rate
 *   ?action=video&durationSec=45&...   a whole video job, scenes included
 *
 * The quote walks the same rate card the meter charges from, so the number
 * shown here and the number debited later cannot drift apart.
 */
router.get("/credits/quote", async (req: Request, res: Response) => {
  const action = String(req.query.action ?? "").trim();
  if (!action) {
    res.status(400).json({ error: "An action is required" });
    return;
  }

  const balance = await peekCreditBalance(req.tenantId);

  if (action === "guided_story") {
    // Priced from the approved script, not the request: the runtime, scene
    // count and spoken lines are what the final render actually pays for.
    const draftId = Number(req.query.draftId);
    if (!Number.isSafeInteger(draftId) || draftId <= 0) {
      res.status(400).json({ error: "A draftId is required" });
      return;
    }
    const [draft] = await db
      .select({ state: guidedStoryDraftsTable.state })
      .from(guidedStoryDraftsTable)
      .where(
        and(
          eq(guidedStoryDraftsTable.id, draftId),
          eq(guidedStoryDraftsTable.tenantId, req.tenantId),
        ),
      )
      .limit(1);
    if (!draft) {
      res.status(404).json({ error: "Guided story draft not found." });
      return;
    }
    const input = guidedDraftQuoteInput(
      { setup: draft.state.setup ?? null, script: draft.state.script ?? null },
      { lipSync: req.query.lipSync === "true" },
    );
    if (!input) {
      res.status(400).json({ error: "Approve a script before pricing the final video." });
      return;
    }
    const quote = await quoteVideoJobCredits(input);
    res.json({
      credits: quote.credits,
      lines: quote.lines,
      balance: balance.total,
      balanceAfter: Math.round((balance.total - quote.credits) * 1000) / 1000,
      sufficient: balance.total >= quote.credits,
    });
    return;
  }

  if (action === "video") {
    const durationSec = Number(req.query.durationSec);
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      res.status(400).json({ error: "A positive durationSec is required" });
      return;
    }
    const quote = await quoteVideoJobCredits({
      durationSec,
      sceneCount: Number(req.query.sceneCount) || undefined,
      resolution: req.query.resolution ? String(req.query.resolution) : null,
      narrated: req.query.narrated === "true",
      lipSync: req.query.lipSync === "true",
    });
    res.json({
      credits: quote.credits,
      lines: quote.lines,
      balance: balance.total,
      balanceAfter: Math.round((balance.total - quote.credits) * 1000) / 1000,
      sufficient: balance.total >= quote.credits,
    });
    return;
  }

  const quantity = Number(req.query.quantity ?? 1);
  const credits = await quoteActionCredits(
    action,
    Number.isFinite(quantity) ? quantity : 1,
  );
  if (credits === null) {
    res
      .status(400)
      .json({ error: `No credit rate is configured for "${action}"` });
    return;
  }
  res.json({
    credits,
    lines: [{ rateKey: action, quantity: quantity || 1, credits }],
    balance: balance.total,
    balanceAfter: Math.round((balance.total - credits) * 1000) / 1000,
    sufficient: balance.total >= credits,
  });
});

/**
 * GET /credits/receipts/video-jobs/:jobId — quoted vs charged for one video.
 *
 * Read from the ledger the meter writes, so it includes retries and refunds:
 * the honest answer to "why did this cost more than it said".
 */
router.get(
  "/credits/receipts/video-jobs/:jobId",
  async (req: Request, res: Response) => {
    try {
      res.json(
        await getVideoJobCreditReceipt(req.tenantId, Number(req.params.jobId)),
      );
    } catch (error) {
      if (error instanceof ReceiptNotFoundError) {
        res.status(404).json({ error: error.message });
        return;
      }
      throw error;
    }
  },
);

export default router;
