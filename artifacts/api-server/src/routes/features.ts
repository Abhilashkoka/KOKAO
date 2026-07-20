import { Router, type IRouter, type Request, type Response } from "express";
import { getFeatureFlags } from "../lib/featureFlags";

const router: IRouter = Router();

/**
 * GET /features
 * Platform-wide feature switches, readable by any authenticated tenant so the
 * web app can hide disabled modules. Enforcement happens server-side via
 * requireFeature — this endpoint is only a UI hint.
 */
router.get("/features", async (_req: Request, res: Response) => {
  res.json(await getFeatureFlags());
});

export default router;
