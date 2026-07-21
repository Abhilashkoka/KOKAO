import { Router, type Request, type Response } from "express";
import { getAiSpendRates } from "../lib/aiSpend";

const router = Router();

/**
 * GET /ai-spend/rates
 * The per-caption/per-image amounts shown as "AI amount spent" in the app.
 * The platform fee is already folded in — clients never see the split.
 * The whole prefix is gated by the `aiSpend` feature switch in routes/index.ts.
 */
router.get("/ai-spend/rates", async (_req: Request, res: Response) => {
  res.json(await getAiSpendRates());
});

export default router;
