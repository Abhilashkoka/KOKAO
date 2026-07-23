import { Router, type IRouter, type Request, type Response } from "express";
import { db, visualAssetsTable, tenantsTable } from "@workspace/db";
import type { VisualAsset } from "@workspace/db";
import { and, eq, asc } from "drizzle-orm";
import { CreateVisualAssetBody } from "@workspace/api-zod";
import { CharacterInputError, loadReferenceImage } from "../lib/characters";

const router: IRouter = Router();

/**
 * Visual assets: a small, tenant-scoped library of fixed images (product
 * shots, mascots, props, backgrounds) uploaded once and reused in the AI
 * Studio — as reference images for image generation or as source photos for
 * image-to-video. Uploads only; nothing here costs AI quota.
 */

/** Per-tenant cap: a curated set of anchors, not a general media store. */
export const MAX_VISUAL_ASSETS = 7;

function serializeAsset(asset: VisualAsset) {
  return {
    id: asset.id,
    name: asset.name,
    imagePath: asset.imagePath,
    createdAt: asset.createdAt.toISOString(),
  };
}

router.get("/visual-assets", async (req: Request, res: Response) => {
  const assets = await db
    .select()
    .from(visualAssetsTable)
    .where(eq(visualAssetsTable.tenantId, req.tenantId))
    .orderBy(asc(visualAssetsTable.id));
  res.json(assets.map(serializeAsset));
});

router.post("/visual-assets", async (req: Request, res: Response) => {
  const parsed = CreateVisualAssetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const name = parsed.data.name.trim();
  const imagePath = parsed.data.imagePath;
  if (!name) {
    res.status(400).json({ error: "An asset name is required." });
    return;
  }
  if (!imagePath.startsWith(`/objects/${req.tenantId}/`)) {
    res.status(400).json({ error: "Invalid image path." });
    return;
  }

  try {
    // Validate the upload exists, is an image, and fits provider payloads.
    await loadReferenceImage(imagePath, req.tenantId);
  } catch (err) {
    if (err instanceof CharacterInputError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }

  // Count + insert atomically: lock the tenant row so parallel creates
  // serialize and cannot slip past the cap check together.
  const asset = await db.transaction(async (tx) => {
    await tx
      .select({ id: tenantsTable.id })
      .from(tenantsTable)
      .where(eq(tenantsTable.id, req.tenantId))
      .for("update");
    const existing = await tx
      .select({ id: visualAssetsTable.id })
      .from(visualAssetsTable)
      .where(eq(visualAssetsTable.tenantId, req.tenantId));
    if (existing.length >= MAX_VISUAL_ASSETS) return null;
    return (
      await tx
        .insert(visualAssetsTable)
        .values({ tenantId: req.tenantId, name, imagePath })
        .returning()
    )[0]!;
  });
  if (!asset) {
    res.status(400).json({
      error: `You can save up to ${MAX_VISUAL_ASSETS} assets. Delete one to add another.`,
    });
    return;
  }
  res.status(201).json(serializeAsset(asset));
});

router.delete("/visual-assets/:assetId", async (req: Request, res: Response) => {
  const assetId = Number(req.params.assetId);
  if (!Number.isInteger(assetId)) {
    res.status(404).json({ error: "Asset not found" });
    return;
  }
  const deleted = await db
    .delete(visualAssetsTable)
    .where(
      and(eq(visualAssetsTable.id, assetId), eq(visualAssetsTable.tenantId, req.tenantId)),
    )
    .returning({ id: visualAssetsTable.id });
  if (deleted.length === 0) {
    res.status(404).json({ error: "Asset not found" });
    return;
  }
  res.status(204).end();
});

export default router;
