import { Router, type IRouter, type Request, type Response } from "express";
import { PLANS } from "../lib/plans";

const router: IRouter = Router();

router.get("/plans", (_req: Request, res: Response) => {
  res.json(PLANS);
});

export default router;
