import { Router, type IRouter, type Request, type Response } from "express";
import { db, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { UpdateSettingsBody } from "@workspace/api-zod";
import { serializeTenant } from "../lib/serializers";
import { getPlanLimits } from "../lib/plans";
import { getUsage } from "../lib/usage";

const router: IRouter = Router();

async function loadTenant(tenantId: number) {
  return (
    await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId)).limit(1)
  )[0];
}

router.get("/me", async (req: Request, res: Response) => {
  const tenant = await loadTenant(req.tenantId);
  if (!tenant) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const usage = await getUsage(req.tenantId);
  res.json({
    tenant: serializeTenant(tenant),
    usage: {
      captions: usage.captions,
      images: usage.images,
      periodStart: usage.periodStart.toISOString(),
    },
    limits: getPlanLimits(tenant.plan),
  });
});

router.patch("/me/settings", async (req: Request, res: Response) => {
  const parsed = UpdateSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const updated = (
    await db
      .update(tenantsTable)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(tenantsTable.id, req.tenantId))
      .returning()
  )[0];

  if (!updated) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  res.json(serializeTenant(updated));
});

export default router;
