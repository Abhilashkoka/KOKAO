import { Router, type IRouter, type Request, type Response } from "express";
import { AdminUpdateInvoiceSettingsBody } from "@workspace/api-zod";
import {
  getInvoiceSettings,
  updateInvoiceSettings,
} from "../lib/invoices";
import { requireSuperadmin } from "../middlewares/requireSuperadmin";
import { recordAdminAction } from "../lib/adminAudit";

const router: IRouter = Router();

const view = (s: Awaited<ReturnType<typeof getInvoiceSettings>>) => ({
  legalName: s.legalName,
  gstin: s.gstin,
  address: s.address,
  numberPrefix: s.numberPrefix,
});

/** Seller details printed on every invoice. Superadmin-managed. */
router.get(
  "/admin/invoice-settings",
  requireSuperadmin,
  async (_req: Request, res: Response) => {
    res.json(view(await getInvoiceSettings()));
  },
);

router.put(
  "/admin/invoice-settings",
  requireSuperadmin,
  async (req: Request, res: Response) => {
    const parsed = AdminUpdateInvoiceSettingsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const previous = await getInvoiceSettings();
    const saved = await updateInvoiceSettings({
      ...(parsed.data.legalName !== undefined
        ? { legalName: parsed.data.legalName.trim() }
        : {}),
      ...(parsed.data.gstin !== undefined
        ? { gstin: parsed.data.gstin?.trim() || null }
        : {}),
      ...(parsed.data.address !== undefined
        ? { address: parsed.data.address?.trim() || null }
        : {}),
      ...(parsed.data.numberPrefix !== undefined
        ? { numberPrefix: parsed.data.numberPrefix.trim() }
        : {}),
    });
    try {
      await recordAdminAction({
        action: "invoice_settings_change",
        actorTenantId: req.tenantId,
        actorEmail: req.tenantEmail,
        targetTenantId: null,
        targetEmail: null,
        oldValue: JSON.stringify(view(previous)),
        newValue: JSON.stringify(view(saved)),
      });
    } catch (error) {
      req.log.error({ err: error }, "Failed to write invoice-settings audit log");
    }
    res.json(view(saved));
  },
);

export default router;
