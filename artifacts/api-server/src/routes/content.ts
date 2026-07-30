import { Router, type IRouter, type Request, type Response } from "express";
import { db, contentItemsTable, campaignsTable } from "@workspace/db";
import { and, eq, desc } from "drizzle-orm";
import { CreateContentBody, UpdateContentBody } from "@workspace/api-zod";
import { serializeContent } from "../lib/serializers";
import { recordTasteSignal } from "../lib/tasteMemory";

const router: IRouter = Router();

/** A campaignId in a write must reference the tenant's own campaign. */
async function campaignBelongsToTenant(
  campaignId: number,
  tenantId: number,
): Promise<boolean> {
  const row = (
    await db
      .select({ id: campaignsTable.id })
      .from(campaignsTable)
      .where(
        and(eq(campaignsTable.id, campaignId), eq(campaignsTable.tenantId, tenantId)),
      )
      .limit(1)
  )[0];
  return !!row;
}

router.param("id", (req, res, next, value) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  next();
});

router.get("/content", async (req: Request, res: Response) => {
  const rows = await db
    .select()
    .from(contentItemsTable)
    .where(eq(contentItemsTable.tenantId, req.tenantId))
    .orderBy(desc(contentItemsTable.createdAt));
  res.json(rows.map(serializeContent));
});

/**
 * Image-editor layer documents are opaque JSON, but bounded — each must be a
 * plain object (or null to clear) and under 200KB serialized so a runaway
 * client can't bloat rows. Applies to the item-level doc and to every
 * carousel slide's doc. Returns an error message or null when valid.
 */
function invalidImageLayers(data: {
  imageLayers?: unknown;
  carouselSlides?: { imageLayers?: unknown }[] | null;
}): string | null {
  const check = (layers: unknown, label: string): string | null => {
    if (layers === undefined || layers === null) return null;
    if (typeof layers !== "object" || Array.isArray(layers)) {
      return `${label} must be an object`;
    }
    if (JSON.stringify(layers).length > 200_000) {
      return `${label} is too large (max 200KB)`;
    }
    return null;
  };
  const topLevel = check(data.imageLayers, "imageLayers");
  if (topLevel) return topLevel;
  for (const slide of data.carouselSlides ?? []) {
    const slideError = check(slide.imageLayers, "carouselSlides imageLayers");
    if (slideError) return slideError;
  }
  return null;
}

router.post("/content", async (req: Request, res: Response) => {
  const parsed = CreateContentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const layersError = invalidImageLayers(parsed.data);
  if (layersError) {
    res.status(400).json({ error: layersError });
    return;
  }
  if (
    parsed.data.campaignId != null &&
    !(await campaignBelongsToTenant(parsed.data.campaignId, req.tenantId))
  ) {
    res.status(400).json({ error: "Campaign not found" });
    return;
  }
  const created = (
    await db
      .insert(contentItemsTable)
      .values({ ...parsed.data, tenantId: req.tenantId })
      .returning()
  )[0]!;
  res.status(201).json(serializeContent(created));
});

router.get("/content/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const row = (
    await db
      .select()
      .from(contentItemsTable)
      .where(and(eq(contentItemsTable.id, id), eq(contentItemsTable.tenantId, req.tenantId)))
      .limit(1)
  )[0];
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(serializeContent(row));
});

router.patch("/content/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const parsed = UpdateContentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const layersError = invalidImageLayers(parsed.data);
  if (layersError) {
    res.status(400).json({ error: layersError });
    return;
  }
  if (
    parsed.data.campaignId != null &&
    !(await campaignBelongsToTenant(parsed.data.campaignId, req.tenantId))
  ) {
    res.status(400).json({ error: "Campaign not found" });
    return;
  }
  const updated = (
    await db
      .update(contentItemsTable)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(and(eq(contentItemsTable.id, id), eq(contentItemsTable.tenantId, req.tenantId)))
      .returning()
  )[0];
  if (!updated) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(serializeContent(updated));
});

router.delete("/content/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const deleted = (
    await db
      .delete(contentItemsTable)
      .where(and(eq(contentItemsTable.id, id), eq(contentItemsTable.tenantId, req.tenantId)))
      .returning()
  )[0];
  if (!deleted) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  // Taste memory: deleting a draft that had a caption means the user rejected
  // that generation. Best-effort; never blocks the delete response.
  if (deleted.status === "draft" && deleted.caption?.trim()) {
    void recordTasteSignal(req.tenantId, {
      kind: "discarded",
      caption: deleted.caption,
      imagePrompt: deleted.imagePrompt,
      platform: deleted.platform,
    });
  }
  res.status(204).end();
});

export default router;
