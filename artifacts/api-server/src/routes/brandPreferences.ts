import { Router, type IRouter, type Request, type Response } from "express";
import { db, tenantBrandPreferencesTable, brandKitsTable } from "@workspace/db";
import { and, eq, desc } from "drizzle-orm";
import { UpsertBrandPreferenceBody } from "@workspace/api-zod";
import { serializePreference } from "../lib/brandKit/service";

const router: IRouter = Router();

router.get("/brand-preferences", async (req: Request, res: Response) => {
  const rows = await db
    .select()
    .from(tenantBrandPreferencesTable)
    .where(eq(tenantBrandPreferencesTable.tenantId, req.tenantId))
    .orderBy(desc(tenantBrandPreferencesTable.priority));
  res.json(rows.map(serializePreference));
});

router.post("/brand-preferences", async (req: Request, res: Response) => {
  const parsed = UpsertBrandPreferenceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  // The referenced brand must belong to this tenant (tenant isolation).
  const kit = (
    await db
      .select({ id: brandKitsTable.id })
      .from(brandKitsTable)
      .where(
        and(
          eq(brandKitsTable.id, parsed.data.brandKitId),
          eq(brandKitsTable.tenantId, req.tenantId),
        ),
      )
      .limit(1)
  )[0];
  if (!kit) {
    res.status(400).json({ error: "Unknown brand kit." });
    return;
  }

  const useCase = parsed.data.useCase ?? null;
  const channel = parsed.data.channel ?? null;
  const contentType = parsed.data.contentType ?? null;
  const priority = parsed.data.priority ?? 0;

  // Upsert on the (useCase, channel, contentType) scope for this tenant.
  const existing = (
    await db
      .select()
      .from(tenantBrandPreferencesTable)
      .where(eq(tenantBrandPreferencesTable.tenantId, req.tenantId))
  ).find(
    (p) =>
      (p.useCase ?? null) === useCase &&
      (p.channel ?? null) === channel &&
      (p.contentType ?? null) === contentType,
  );

  let row;
  if (existing) {
    row = (
      await db
        .update(tenantBrandPreferencesTable)
        .set({
          brandKitId: parsed.data.brandKitId,
          priority,
          updatedAt: new Date(),
        })
        .where(eq(tenantBrandPreferencesTable.id, existing.id))
        .returning()
    )[0]!;
  } else {
    row = (
      await db
        .insert(tenantBrandPreferencesTable)
        .values({
          tenantId: req.tenantId,
          useCase,
          channel,
          contentType,
          brandKitId: parsed.data.brandKitId,
          priority,
        })
        .returning()
    )[0]!;
  }
  res.status(201).json(serializePreference(row));
});

router.delete("/brand-preferences/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const deleted = (
    await db
      .delete(tenantBrandPreferencesTable)
      .where(
        and(
          eq(tenantBrandPreferencesTable.id, id),
          eq(tenantBrandPreferencesTable.tenantId, req.tenantId),
        ),
      )
      .returning()
  )[0];
  if (!deleted) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(204).end();
});

export default router;
