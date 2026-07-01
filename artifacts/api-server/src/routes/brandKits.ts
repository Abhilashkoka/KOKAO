import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  tenantsTable,
  brandAssetsTable,
  brandKitsTable,
  brandKitVersionsTable,
  type BrandKitPayload,
} from "@workspace/db";
import { and, eq, desc } from "drizzle-orm";
import {
  CreateBrandKitBody,
  UpdateBrandKitBody,
  CreateBrandKitVersionBody,
  ActivateBrandKitVersionBody,
  DraftBrandKitBody,
  ResolveBrandSelectionBody,
  CreateBrandAssetBody,
} from "@workspace/api-zod";
import {
  listKits,
  getKitDetail,
  createKit,
  loadKit,
  addVersion,
  activateVersion,
  setDefault,
  deleteKit,
  serializeVersion,
  serializeAsset,
  PlanLimitError,
  BrandInputError,
} from "../lib/brandKit/service";
import { resolveSelection } from "../lib/brandKit/selection";
import { draftBrandKit } from "../lib/brandKit/draft";

const router: IRouter = Router();

async function loadTenant(tenantId: number) {
  return (
    await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId)).limit(1)
  )[0];
}

function assetIdParam(req: Request, res: Response): number | null {
  const id = Number(req.params.assetId);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid asset id" });
    return null;
  }
  return id;
}

router.param("id", (req, res, next, value) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  next();
});

// --- Collection ---

router.get("/brand-kits", async (req: Request, res: Response) => {
  const includeArchived = req.query.includeArchived === "true";
  const kits = await listKits(req.tenantId, includeArchived);
  res.json(kits);
});

router.post("/brand-kits", async (req: Request, res: Response) => {
  const parsed = CreateBrandKitBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const tenant = await loadTenant(req.tenantId);
  if (!tenant) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const detail = await createKit({
      tenantId: req.tenantId,
      plan: tenant.plan,
      createdBy: tenant.clerkUserId,
      name: parsed.data.name,
      slug: parsed.data.slug,
      brandType: parsed.data.brandType,
      isDefault: parsed.data.isDefault,
      payload: (parsed.data.payload as BrandKitPayload | null | undefined) ?? null,
    });
    res.status(201).json(detail);
  } catch (error) {
    if (error instanceof PlanLimitError) {
      res.status(402).json({ error: error.message });
      return;
    }
    req.log.error({ err: error }, "Brand kit creation failed");
    res.status(500).json({ error: "Failed to create brand kit" });
  }
});

// --- Static sub-routes (must precede /:id where they could collide) ---

router.post("/brand-kits/resolve-selection", async (req: Request, res: Response) => {
  const parsed = ResolveBrandSelectionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const result = await resolveSelection(req.tenantId, parsed.data);
  res.json(result);
});

router.post("/brand-kits/draft", async (req: Request, res: Response) => {
  const parsed = DraftBrandKitBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const tenant = await loadTenant(req.tenantId);
  if (!tenant) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const draft = await draftBrandKit(tenant.aiModel, parsed.data);
  res.json(draft);
});

// --- Single kit ---

router.get("/brand-kits/:id", async (req: Request, res: Response) => {
  const detail = await getKitDetail(req.tenantId, Number(req.params.id));
  if (!detail) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(detail);
});

router.patch("/brand-kits/:id", async (req: Request, res: Response) => {
  const parsed = UpdateBrandKitBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const id = Number(req.params.id);
  const kit = await loadKit(req.tenantId, id);
  if (!kit) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (parsed.data.name !== undefined) patch.name = parsed.data.name;
  if (parsed.data.brandType !== undefined) patch.brandType = parsed.data.brandType;
  if (parsed.data.isArchived !== undefined) patch.isArchived = parsed.data.isArchived;
  await db
    .update(brandKitsTable)
    .set(patch)
    .where(and(eq(brandKitsTable.id, id), eq(brandKitsTable.tenantId, req.tenantId)));
  const detail = await getKitDetail(req.tenantId, id);
  res.json(detail);
});

router.delete("/brand-kits/:id", async (req: Request, res: Response) => {
  const ok = await deleteKit(req.tenantId, Number(req.params.id));
  if (!ok) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(204).end();
});

// --- Versions ---

router.get("/brand-kits/:id/versions", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const kit = await loadKit(req.tenantId, id);
  if (!kit) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const versions = await db
    .select()
    .from(brandKitVersionsTable)
    .where(
      and(
        eq(brandKitVersionsTable.brandKitId, id),
        eq(brandKitVersionsTable.tenantId, req.tenantId),
      ),
    )
    .orderBy(desc(brandKitVersionsTable.versionNumber));
  res.json(versions.map(serializeVersion));
});

router.post("/brand-kits/:id/versions", async (req: Request, res: Response) => {
  const parsed = CreateBrandKitVersionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const tenant = await loadTenant(req.tenantId);
  if (!tenant) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const detail = await addVersion({
    tenantId: req.tenantId,
    brandKitId: Number(req.params.id),
    createdBy: tenant.clerkUserId,
    payload: parsed.data.payload as BrandKitPayload,
    sourceType: parsed.data.sourceType,
    sourceNotes: parsed.data.sourceNotes ?? null,
    approvalStatus: parsed.data.approvalStatus,
    activate: parsed.data.activate,
  });
  if (!detail) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(201).json(detail);
});

router.post("/brand-kits/:id/activate-version", async (req: Request, res: Response) => {
  const parsed = ActivateBrandKitVersionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  try {
    const detail = await activateVersion(
      req.tenantId,
      Number(req.params.id),
      parsed.data.versionId,
    );
    if (!detail) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(detail);
  } catch (error) {
    if (error instanceof BrandInputError) {
      res.status(400).json({ error: error.message });
      return;
    }
    throw error;
  }
});

router.post("/brand-kits/:id/set-default", async (req: Request, res: Response) => {
  const detail = await setDefault(req.tenantId, Number(req.params.id));
  if (!detail) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(detail);
});

// --- Assets ---

router.get("/brand-kits/:id/assets", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const kit = await loadKit(req.tenantId, id);
  if (!kit) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const assets = await db
    .select()
    .from(brandAssetsTable)
    .where(
      and(
        eq(brandAssetsTable.brandKitId, id),
        eq(brandAssetsTable.tenantId, req.tenantId),
      ),
    )
    .orderBy(desc(brandAssetsTable.createdAt));
  res.json(assets.map(serializeAsset));
});

router.post("/brand-kits/:id/assets", async (req: Request, res: Response) => {
  const parsed = CreateBrandAssetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const id = Number(req.params.id);
  const kit = await loadKit(req.tenantId, id);
  if (!kit) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const created = (
    await db
      .insert(brandAssetsTable)
      .values({
        tenantId: req.tenantId,
        brandKitId: id,
        assetType: parsed.data.assetType,
        fileUrl: parsed.data.fileUrl,
        mimeType: parsed.data.mimeType ?? null,
        label: parsed.data.label ?? null,
      })
      .returning()
  )[0]!;
  res.status(201).json(serializeAsset(created));
});

router.delete("/brand-kits/:id/assets/:assetId", async (req: Request, res: Response) => {
  const assetId = assetIdParam(req, res);
  if (assetId === null) return;
  const deleted = (
    await db
      .delete(brandAssetsTable)
      .where(
        and(
          eq(brandAssetsTable.id, assetId),
          eq(brandAssetsTable.brandKitId, Number(req.params.id)),
          eq(brandAssetsTable.tenantId, req.tenantId),
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
