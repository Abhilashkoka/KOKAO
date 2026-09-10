import { Router, type Request, type Response } from "express";
import { requireTenant } from "../middlewares/requireTenant";
import {
  peekCreditBalance,
  listCreditHistory,
} from "../lib/creditAccounts";
import { quoteVideoJobCredits, quoteActionCredits } from "../lib/creditQuote";
import { getMeterMode } from "../lib/creditRates";

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
  const [balance, history, mode] = await Promise.all([
    peekCreditBalance(req.tenantId),
    listCreditHistory(req.tenantId, 50),
    getMeterMode(),
  ]);
  res.json({ ...balance, mode, history });
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
  const credits = await quoteActionCredits(action, Number.isFinite(quantity) ? quantity : 1);
  if (credits === null) {
    res.status(400).json({ error: `No credit rate is configured for "${action}"` });
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

export default router;
