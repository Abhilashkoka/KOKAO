import { Router, type IRouter, type Request, type Response } from "express";
import { db, brandKitsTable } from "@workspace/db";
import { and, eq, desc } from "drizzle-orm";
import { CreateBrandKitBody, UpdateBrandKitBody } from "@workspace/api-zod";
import { serializeBrandKit } from "../lib/serializers";

const router: IRouter = Router();

router.param("id", (req, res, next, value) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  next();
});

router.get("/brand-kits", async (req: Request, res: Response) => {
  const rows = await db
    .select()
    .from(brandKitsTable)
    .where(eq(brandKitsTable.tenantId, req.tenantId))
    .orderBy(desc(brandKitsTable.createdAt));
  res.json(rows.map(serializeBrandKit));
});

router.post("/brand-kits", async (req: Request, res: Response) => {
  const parsed = CreateBrandKitBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const created = (
    await db
      .insert(brandKitsTable)
      .values({ ...parsed.data, tenantId: req.tenantId })
      .returning()
  )[0]!;
  res.status(201).json(serializeBrandKit(created));
});

router.get("/brand-kits/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const row = (
    await db
      .select()
      .from(brandKitsTable)
      .where(and(eq(brandKitsTable.id, id), eq(brandKitsTable.tenantId, req.tenantId)))
      .limit(1)
  )[0];
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(serializeBrandKit(row));
});

router.patch("/brand-kits/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const parsed = UpdateBrandKitBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const updated = (
    await db
      .update(brandKitsTable)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(and(eq(brandKitsTable.id, id), eq(brandKitsTable.tenantId, req.tenantId)))
      .returning()
  )[0];
  if (!updated) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(serializeBrandKit(updated));
});

router.delete("/brand-kits/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const deleted = (
    await db
      .delete(brandKitsTable)
      .where(and(eq(brandKitsTable.id, id), eq(brandKitsTable.tenantId, req.tenantId)))
      .returning()
  )[0];
  if (!deleted) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(204).end();
});

export default router;
