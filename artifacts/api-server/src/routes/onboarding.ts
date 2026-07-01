import { Router, type IRouter, type Request, type Response } from "express";
import { db, tenantsTable, brandKitsTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { CompleteOnboardingBody } from "@workspace/api-zod";

const router: IRouter = Router();

async function brandCount(tenantId: number): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(brandKitsTable)
    .where(
      and(eq(brandKitsTable.tenantId, tenantId), eq(brandKitsTable.isArchived, false)),
    );
  return rows[0]?.n ?? 0;
}

router.get("/onboarding", async (req: Request, res: Response) => {
  const tenant = (
    await db.select().from(tenantsTable).where(eq(tenantsTable.id, req.tenantId)).limit(1)
  )[0];
  if (!tenant) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  res.json({
    complete: tenant.brandOnboardingComplete,
    brandCount: await brandCount(req.tenantId),
  });
});

router.post("/onboarding/complete", async (req: Request, res: Response) => {
  const parsed = CompleteOnboardingBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const patch: Record<string, unknown> = {
    brandOnboardingComplete: true,
    updatedAt: new Date(),
  };
  if (parsed.data.industry != null) patch.industry = parsed.data.industry;

  const updated = (
    await db
      .update(tenantsTable)
      .set(patch)
      .where(eq(tenantsTable.id, req.tenantId))
      .returning()
  )[0];
  if (!updated) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  res.json({
    complete: true,
    brandCount: await brandCount(req.tenantId),
  });
});

export default router;
