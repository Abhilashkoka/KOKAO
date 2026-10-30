import { Router, type IRouter, type Request, type Response } from "express";
import { AdminUpdateReelCostSettingsBody } from "@workspace/api-zod";
import { recordAdminAction } from "../lib/adminAudit";
import {
  getReelCostSettings,
  REEL_COST_AUDIT_ACTION,
  reelCostSettingsHistory,
  saveReelCostSettings,
} from "../lib/reelCostSettings";
import { requireSuperadmin } from "../middlewares/requireSuperadmin";

/**
 * Showcase reel cost controls. Every signed-in workspace reads the defaults
 * (Create uses them); only superadmins change them, and every change is
 * written to the admin audit log so it can be tracked.
 */
const router: IRouter = Router();
router.use("/admin/reel-cost-settings", requireSuperadmin);

router.get("/quick-create/reel-settings", async (_req: Request, res: Response): Promise<void> => {
  res.json(await getReelCostSettings());
});

router.get("/admin/reel-cost-settings", async (_req: Request, res: Response): Promise<void> => {
  res.json({
    settings: await getReelCostSettings(),
    history: await reelCostSettingsHistory().catch(() => []),
  });
});

router.put("/admin/reel-cost-settings", async (req: Request, res: Response): Promise<void> => {
  const parsed = AdminUpdateReelCostSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid reel cost settings." });
    return;
  }
  const input = parsed.data;
  if (input.defaultReelStyle === "hero" && !input.heroModeEnabled) {
    res.status(400).json({ error: "Turn on Hero reel before making it the default." });
    return;
  }
  const before = await getReelCostSettings();
  const saved = await saveReelCostSettings(input, req.tenantEmail ?? null);
  const strip = ({ updatedAt: _a, updatedBy: _b, ...rest }: typeof saved) => rest;
  await recordAdminAction({
    action: REEL_COST_AUDIT_ACTION,
    actorTenantId: req.tenantId,
    actorEmail: req.tenantEmail ?? null,
    targetTenantId: null,
    targetEmail: null,
    oldValue: JSON.stringify(strip(before)),
    newValue: JSON.stringify(strip(saved)),
  }).catch((err) => req.log.error({ err }, "Failed to audit reel cost settings change"));
  res.json({ settings: saved, history: await reelCostSettingsHistory().catch(() => []) });
});

export default router;
