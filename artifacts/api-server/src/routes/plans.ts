import { Router, type IRouter, type Request, type Response } from "express";
import { listPlans } from "../lib/plans";

const router: IRouter = Router();

router.get("/plans", async (req: Request, res: Response) => {
  try {
    res.json(await listPlans());
  } catch (error) {
    req.log.error({ err: error }, "Failed to list plans");
    res.status(500).json({ error: "Failed to list plans" });
  }
});

export default router;
