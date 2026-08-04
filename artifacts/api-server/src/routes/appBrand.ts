import { Router, type IRouter, type Request, type Response } from "express";
import { db, appBrandSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  GetAppBrandResponse,
  UpdateAppBrandBody,
  CreateAppBrandUploadUrlBody,
  CreateAppBrandUploadUrlResponse,
} from "@workspace/api-zod";
import { ObjectStorageService } from "../lib/objectStorage";
import { requireSuperadmin } from "../middlewares/requireSuperadmin";
import { recordAdminAction } from "../lib/adminAudit";

const objectStorageService = new ObjectStorageService();

const EMPTY_BRAND = {
  appName: null,
  logoUrl: null,
  iconUrl: null,
  primaryColor: null,
  backgroundColor: null,
  loaderAnimationUrl: null,
};

async function loadBrand() {
  const [row] = await db
    .select()
    .from(appBrandSettingsTable)
    .where(eq(appBrandSettingsTable.id, 1))
    .limit(1);
  if (!row) return EMPTY_BRAND;
  return {
    appName: row.appName,
    logoUrl: row.logoUrl,
    iconUrl: row.iconUrl,
    primaryColor: row.primaryColor,
    backgroundColor: row.backgroundColor,
    loaderAnimationUrl: row.loaderAnimationUrl,
  };
}

/**
 * Public branding read. Mounted BEFORE authentication because the logo,
 * favicon, title and theme colors must render on the pre-auth landing/auth
 * pages. Returns nulls (defaults) when nothing has been configured.
 */
export const publicAppBrandRouter: IRouter = Router();

publicAppBrandRouter.get("/app-brand", async (req: Request, res: Response) => {
  try {
    const brand = await loadBrand();
    res.json(GetAppBrandResponse.parse(brand));
  } catch (error) {
    req.log.error({ err: error }, "Failed to load app brand");
    res.status(500).json({ error: "Failed to load app brand" });
  }
});

/**
 * Branding writes. Mounted AFTER requireTenant; every route is superadmin-only.
 */
export const protectedAppBrandRouter: IRouter = Router();

protectedAppBrandRouter.put(
  "/app-brand",
  requireSuperadmin,
  async (req: Request, res: Response) => {
    const parsed = UpdateAppBrandBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }

    const values = parsed.data;
    const oldBrand = await loadBrand();

    await db
      .insert(appBrandSettingsTable)
      .values({ id: 1, ...values })
      .onConflictDoUpdate({
        target: appBrandSettingsTable.id,
        set: values,
      });

    const brand = await loadBrand();

    // Best-effort audit trail: record who changed the white-label branding,
    // but only when something actually changed (no row for no-op saves), and
    // never fail the save if the audit write fails. No secret material here —
    // branding fields are public by design.
    if (JSON.stringify(oldBrand) !== JSON.stringify(brand)) {
      try {
        await recordAdminAction({
          action: "app_brand_change",
          actorTenantId: req.tenantId,
          actorEmail: req.tenantEmail,
          targetTenantId: null,
          targetEmail: null,
          oldValue: JSON.stringify(oldBrand),
          newValue: JSON.stringify(brand),
        });
      } catch (error) {
        req.log.error(
          { err: error },
          "Failed to write app-brand-change audit log",
        );
      }
    }

    // Best-effort cleanup: once the new branding row is committed, delete any
    // replaced/removed brand asset objects so stale logo URLs stop resolving
    // and cached copies can never be mistaken for current. Never fail the
    // save on a storage hiccup.
    const assetFields = ["logoUrl", "iconUrl", "loaderAnimationUrl"] as const;
    for (const field of assetFields) {
      const oldPath = oldBrand[field];
      if (oldPath && oldPath !== brand[field]) {
        try {
          await objectStorageService.deletePublicBrandObject(oldPath);
        } catch (error) {
          req.log.error(
            { err: error, field, oldPath },
            "Failed to delete replaced brand asset",
          );
        }
      }
    }

    res.json(GetAppBrandResponse.parse(brand));
  },
);

protectedAppBrandRouter.post(
  "/app-brand/upload-url",
  requireSuperadmin,
  async (req: Request, res: Response) => {
    const parsed = CreateAppBrandUploadUrlBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }

    try {
      const { uploadURL, servedPath } =
        await objectStorageService.getPublicBrandUploadURL();
      res.json(CreateAppBrandUploadUrlResponse.parse({ uploadURL, servedPath }));
    } catch (error) {
      req.log.error({ err: error }, "Failed to mint brand upload URL");
      res.status(500).json({ error: "Failed to mint upload URL" });
    }
  },
);
