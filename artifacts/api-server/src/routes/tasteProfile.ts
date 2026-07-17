import { Router, type IRouter, type Request, type Response } from "express";
import { UpdateTasteProfileBody, RecordTasteSignalBody } from "@workspace/api-zod";
import {
  getTasteSummary,
  setTasteEnabled,
  clearTasteProfile,
  recordTasteSignalFromContent,
} from "../lib/tasteMemory";

const router: IRouter = Router();

router.get("/taste-profile", async (req: Request, res: Response) => {
  res.json(await getTasteSummary(req.tenantId));
});

router.put("/taste-profile", async (req: Request, res: Response) => {
  const parsed = UpdateTasteProfileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  await setTasteEnabled(req.tenantId, parsed.data.enabled);
  res.json(await getTasteSummary(req.tenantId));
});

router.delete("/taste-profile", async (req: Request, res: Response) => {
  await clearTasteProfile(req.tenantId);
  res.json(await getTasteSummary(req.tenantId));
});

router.post("/taste-profile/signal", async (req: Request, res: Response) => {
  const parsed = RecordTasteSignalBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  // The lookup is tenant-scoped, so a foreign contentItemId is a silent no-op.
  await recordTasteSignalFromContent(req.tenantId, parsed.data.contentItemId, parsed.data.kind);
  res.status(204).end();
});

export default router;
