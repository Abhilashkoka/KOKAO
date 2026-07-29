import { Router, type IRouter, type Request, type Response } from "express";
import { AdminSaveSessionTimeoutBody } from "@workspace/api-zod";
import {
  getSessionTimeoutSettings,
  saveSessionTimeoutSettings,
} from "../lib/sessionTimeout";
import { requireSuperadmin } from "../middlewares/requireSuperadmin";
import { recordAdminAction } from "../lib/adminAudit";

const router: IRouter = Router();

/**
 * Read the app-wide inactivity auto-logout settings. Available to ANY
 * signed-in user (the web client polls this to configure its idle timer);
 * only superadmins can change it via the /admin routes below.
 */
router.get(
  "/session-timeout",
  async (_req: Request, res: Response) => {
    res.json(await getSessionTimeoutSettings());
  },
);

router.get(
  "/admin/session-timeout",
  requireSuperadmin,
  async (_req: Request, res: Response) => {
    res.json(await getSessionTimeoutSettings());
  },
);

router.put(
  "/admin/session-timeout",
  requireSuperadmin,
  async (req: Request, res: Response) => {
    const parsed = AdminSaveSessionTimeoutBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const { enabled, timeoutMinutes, warningSeconds } = parsed.data;

    // The warning countdown must fit inside the timeout window, otherwise the
    // dialog could never appear (or would appear immediately at sign-in).
    if (warningSeconds >= timeoutMinutes * 60) {
      res.status(400).json({
        error:
          "warningSeconds must be strictly less than timeoutMinutes × 60 (the full timeout window).",
      });
      return;
    }

    const previous = await getSessionTimeoutSettings();
    const saved = await saveSessionTimeoutSettings({
      enabled,
      timeoutMinutes,
      warningSeconds,
    });

    try {
      await recordAdminAction({
        action: "session_timeout_change",
        actorTenantId: req.tenantId,
        actorEmail: req.tenantEmail,
        targetTenantId: null,
        targetEmail: null,
        oldValue: JSON.stringify(previous),
        newValue: JSON.stringify(saved),
      });
    } catch (error) {
      req.log.error(
        { err: error },
        "Failed to write session-timeout-change audit log",
      );
    }

    res.json(saved);
  },
);

export default router;
