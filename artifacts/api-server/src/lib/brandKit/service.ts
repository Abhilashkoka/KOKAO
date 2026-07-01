import {
  db,
  brandKitsTable,
  brandKitVersionsTable,
  brandAssetsTable,
  tenantBrandPreferencesTable,
  type BrandKit,
  type BrandKitVersion,
  type BrandAsset,
  type TenantBrandPreference,
  type BrandKitPayload,
} from "@workspace/db";
import { and, eq, desc, ne, sql } from "drizzle-orm";
import { getPlanLimits } from "../plans";
import { slugify, buildDefaultPayload } from "./defaults";

/** Thrown when a tenant would exceed their plan's brand-kit allowance. */
export class PlanLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanLimitError";
  }
}

/** Thrown when a client supplies invalid input the route should surface as 400. */
export class BrandInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrandInputError";
  }
}

export function serializeVersion(v: BrandKitVersion) {
  return {
    id: v.id,
    brandKitId: v.brandKitId,
    versionNumber: v.versionNumber,
    sourceType: v.sourceType,
    sourceNotes: v.sourceNotes ?? null,
    approvalStatus: v.approvalStatus,
    payload: v.jsonPayload,
    createdAt: v.createdAt.toISOString(),
  };
}

export function serializeAsset(a: BrandAsset) {
  return {
    id: a.id,
    brandKitId: a.brandKitId,
    assetType: a.assetType,
    fileUrl: a.fileUrl,
    mimeType: a.mimeType ?? null,
    label: a.label ?? null,
    createdAt: a.createdAt.toISOString(),
  };
}

export function serializePreference(p: TenantBrandPreference) {
  return {
    id: p.id,
    useCase: p.useCase ?? null,
    channel: p.channel ?? null,
    contentType: p.contentType ?? null,
    brandKitId: p.brandKitId,
    priority: p.priority,
  };
}

export function serializeKit(
  kit: BrandKit,
  activeVersion: BrandKitVersion | null,
) {
  return {
    id: kit.id,
    name: kit.name,
    slug: kit.slug,
    brandType: kit.brandType,
    status: kit.status,
    isDefault: kit.isDefault,
    isArchived: kit.isArchived,
    activeVersionId: kit.activeVersionId ?? null,
    activeVersion: activeVersion ? serializeVersion(activeVersion) : null,
    createdAt: kit.createdAt.toISOString(),
    updatedAt: kit.updatedAt.toISOString(),
  };
}

async function loadVersionById(
  tenantId: number,
  versionId: number | null,
): Promise<BrandKitVersion | null> {
  if (!versionId) return null;
  return (
    (
      await db
        .select()
        .from(brandKitVersionsTable)
        .where(
          and(
            eq(brandKitVersionsTable.id, versionId),
            eq(brandKitVersionsTable.tenantId, tenantId),
          ),
        )
        .limit(1)
    )[0] ?? null
  );
}

/** The active version row for a kit (or null when none has been activated). */
export async function loadActiveVersionForKit(
  tenantId: number,
  kit: BrandKit,
): Promise<BrandKitVersion | null> {
  return loadVersionById(tenantId, kit.activeVersionId ?? null);
}

/** Serialize a kit resolving its active version in one call. */
export async function serializeKitResolved(tenantId: number, kit: BrandKit) {
  const active = await loadVersionById(tenantId, kit.activeVersionId ?? null);
  return serializeKit(kit, active);
}

export async function loadKit(
  tenantId: number,
  id: number,
): Promise<BrandKit | null> {
  return (
    (
      await db
        .select()
        .from(brandKitsTable)
        .where(and(eq(brandKitsTable.id, id), eq(brandKitsTable.tenantId, tenantId)))
        .limit(1)
    )[0] ?? null
  );
}

export async function listKits(tenantId: number, includeArchived: boolean) {
  const where = includeArchived
    ? eq(brandKitsTable.tenantId, tenantId)
    : and(
        eq(brandKitsTable.tenantId, tenantId),
        eq(brandKitsTable.isArchived, false),
      );
  const kits = await db
    .select()
    .from(brandKitsTable)
    .where(where)
    .orderBy(desc(brandKitsTable.isDefault), desc(brandKitsTable.createdAt));

  return Promise.all(
    kits.map(async (kit) => {
      const active = await loadVersionById(tenantId, kit.activeVersionId ?? null);
      return serializeKit(kit, active);
    }),
  );
}

export async function getKitDetail(tenantId: number, id: number) {
  const kit = await loadKit(tenantId, id);
  if (!kit) return null;
  const [versions, assets, active] = await Promise.all([
    db
      .select()
      .from(brandKitVersionsTable)
      .where(
        and(
          eq(brandKitVersionsTable.brandKitId, id),
          eq(brandKitVersionsTable.tenantId, tenantId),
        ),
      )
      .orderBy(desc(brandKitVersionsTable.versionNumber)),
    db
      .select()
      .from(brandAssetsTable)
      .where(
        and(
          eq(brandAssetsTable.brandKitId, id),
          eq(brandAssetsTable.tenantId, tenantId),
        ),
      )
      .orderBy(desc(brandAssetsTable.createdAt)),
    loadVersionById(tenantId, kit.activeVersionId ?? null),
  ]);
  return {
    ...serializeKit(kit, active),
    versions: versions.map(serializeVersion),
    assets: assets.map(serializeAsset),
  };
}

async function countActiveKits(tenantId: number): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(brandKitsTable)
    .where(
      and(
        eq(brandKitsTable.tenantId, tenantId),
        eq(brandKitsTable.isArchived, false),
      ),
    );
  return rows[0]?.n ?? 0;
}

async function enforceKitLimit(tenantId: number, plan: string) {
  const limit = getPlanLimits(plan).brandKits;
  if (limit === -1) return;
  const count = await countActiveKits(tenantId);
  if (count >= limit) {
    throw new PlanLimitError(
      "Brand kit limit reached for your plan. Upgrade to add more brands.",
    );
  }
}

async function resolveUniqueSlug(
  tenantId: number,
  desired: string,
): Promise<string> {
  const base = slugify(desired);
  let candidate = base;
  let suffix = 1;
  // Small bounded loop; slug collisions per tenant are rare.
  while (suffix < 100) {
    const existing = (
      await db
        .select({ id: brandKitsTable.id })
        .from(brandKitsTable)
        .where(
          and(
            eq(brandKitsTable.tenantId, tenantId),
            eq(brandKitsTable.slug, candidate),
          ),
        )
        .limit(1)
    )[0];
    if (!existing) return candidate;
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  return `${base}-${Date.now()}`;
}

export interface CreateKitOptions {
  tenantId: number;
  plan: string;
  createdBy: string | null;
  name: string;
  slug?: string;
  brandType?: string;
  isDefault?: boolean;
  payload?: BrandKitPayload | null;
}

export async function createKit(opts: CreateKitOptions) {
  await enforceKitLimit(opts.tenantId, opts.plan);
  const slug = await resolveUniqueSlug(opts.tenantId, opts.slug || opts.name);
  const payload =
    opts.payload ?? buildDefaultPayload({ brandName: opts.name, brandSlug: slug });
  // Keep the payload identity slug in sync with the pointer slug.
  payload.identity.brand_slug = slug;
  payload.identity.brand_name = opts.name;
  const approvalStatus = payload.brand_controls.approval_status;

  const kitId = await db.transaction(async (tx) => {
    const isFirst =
      (
        await tx
          .select({ id: brandKitsTable.id })
          .from(brandKitsTable)
          .where(eq(brandKitsTable.tenantId, opts.tenantId))
          .limit(1)
      ).length === 0;
    const makeDefault = opts.isDefault === true || isFirst;

    const kit = (
      await tx
        .insert(brandKitsTable)
        .values({
          tenantId: opts.tenantId,
          name: opts.name,
          slug,
          brandType: opts.brandType ?? "primary",
          status: "draft",
          isDefault: makeDefault,
          createdBy: opts.createdBy,
        })
        .returning()
    )[0]!;

    const version = (
      await tx
        .insert(brandKitVersionsTable)
        .values({
          tenantId: opts.tenantId,
          brandKitId: kit.id,
          versionNumber: 1,
          sourceType: "manual",
          approvalStatus,
          jsonPayload: payload,
          createdBy: opts.createdBy,
        })
        .returning()
    )[0]!;

    if (approvalStatus === "approved") {
      await tx
        .update(brandKitsTable)
        .set({ activeVersionId: version.id, status: "active" })
        .where(eq(brandKitsTable.id, kit.id));
    }

    if (makeDefault) {
      await tx
        .update(brandKitsTable)
        .set({ isDefault: false })
        .where(
          and(
            eq(brandKitsTable.tenantId, opts.tenantId),
            ne(brandKitsTable.id, kit.id),
          ),
        );
    }

    return kit.id;
  });

  return getKitDetail(opts.tenantId, kitId);
}

export interface AddVersionOptions {
  tenantId: number;
  brandKitId: number;
  createdBy: string | null;
  payload: BrandKitPayload;
  sourceType?: string;
  sourceNotes?: string | null;
  approvalStatus?: string;
  activate?: boolean;
}

export async function addVersion(opts: AddVersionOptions) {
  const kit = await loadKit(opts.tenantId, opts.brandKitId);
  if (!kit) return null;
  const approvalStatus = opts.approvalStatus ?? opts.payload.brand_controls.approval_status;

  await db.transaction(async (tx) => {
    const maxRow = (
      await tx
        .select({ max: sql<number>`coalesce(max(${brandKitVersionsTable.versionNumber}), 0)::int` })
        .from(brandKitVersionsTable)
        .where(eq(brandKitVersionsTable.brandKitId, opts.brandKitId))
    )[0];
    const nextNumber = (maxRow?.max ?? 0) + 1;

    const payload: BrandKitPayload = {
      ...opts.payload,
      identity: { ...opts.payload.identity, brand_slug: kit.slug },
    };

    const version = (
      await tx
        .insert(brandKitVersionsTable)
        .values({
          tenantId: opts.tenantId,
          brandKitId: opts.brandKitId,
          versionNumber: nextNumber,
          sourceType: opts.sourceType ?? "manual",
          sourceNotes: opts.sourceNotes ?? null,
          approvalStatus,
          jsonPayload: payload,
          createdBy: opts.createdBy,
        })
        .returning()
    )[0]!;

    if (opts.activate && approvalStatus === "approved") {
      await tx
        .update(brandKitsTable)
        .set({ activeVersionId: version.id, status: "active" })
        .where(eq(brandKitsTable.id, opts.brandKitId));
    }
  });

  return getKitDetail(opts.tenantId, opts.brandKitId);
}

export async function activateVersion(
  tenantId: number,
  brandKitId: number,
  versionId: number,
) {
  const kit = await loadKit(tenantId, brandKitId);
  if (!kit) return null;
  const version = (
    await db
      .select()
      .from(brandKitVersionsTable)
      .where(
        and(
          eq(brandKitVersionsTable.id, versionId),
          eq(brandKitVersionsTable.brandKitId, brandKitId),
          eq(brandKitVersionsTable.tenantId, tenantId),
        ),
      )
      .limit(1)
  )[0];
  if (!version) throw new BrandInputError("Version not found for this brand.");
  if (version.approvalStatus !== "approved") {
    throw new BrandInputError("Only an approved version can be activated.");
  }
  await db
    .update(brandKitsTable)
    .set({ activeVersionId: version.id, status: "active" })
    .where(and(eq(brandKitsTable.id, brandKitId), eq(brandKitsTable.tenantId, tenantId)));
  return getKitDetail(tenantId, brandKitId);
}

export async function setDefault(tenantId: number, brandKitId: number) {
  const kit = await loadKit(tenantId, brandKitId);
  if (!kit) return null;
  await db.transaction(async (tx) => {
    await tx
      .update(brandKitsTable)
      .set({ isDefault: false })
      .where(eq(brandKitsTable.tenantId, tenantId));
    await tx
      .update(brandKitsTable)
      .set({ isDefault: true })
      .where(and(eq(brandKitsTable.id, brandKitId), eq(brandKitsTable.tenantId, tenantId)));
  });
  return getKitDetail(tenantId, brandKitId);
}

export async function deleteKit(tenantId: number, brandKitId: number) {
  const kit = await loadKit(tenantId, brandKitId);
  if (!kit) return false;
  await db.transaction(async (tx) => {
    await tx
      .delete(brandKitVersionsTable)
      .where(
        and(
          eq(brandKitVersionsTable.brandKitId, brandKitId),
          eq(brandKitVersionsTable.tenantId, tenantId),
        ),
      );
    await tx
      .delete(brandAssetsTable)
      .where(
        and(
          eq(brandAssetsTable.brandKitId, brandKitId),
          eq(brandAssetsTable.tenantId, tenantId),
        ),
      );
    await tx
      .delete(tenantBrandPreferencesTable)
      .where(
        and(
          eq(tenantBrandPreferencesTable.brandKitId, brandKitId),
          eq(tenantBrandPreferencesTable.tenantId, tenantId),
        ),
      );
    await tx
      .delete(brandKitsTable)
      .where(and(eq(brandKitsTable.id, brandKitId), eq(brandKitsTable.tenantId, tenantId)));

    // Promote another brand to default if we removed the default one.
    if (kit.isDefault) {
      const next = (
        await tx
          .select()
          .from(brandKitsTable)
          .where(
            and(
              eq(brandKitsTable.tenantId, tenantId),
              eq(brandKitsTable.isArchived, false),
            ),
          )
          .orderBy(desc(brandKitsTable.createdAt))
          .limit(1)
      )[0];
      if (next) {
        await tx
          .update(brandKitsTable)
          .set({ isDefault: true })
          .where(eq(brandKitsTable.id, next.id));
      }
    }
  });
  return true;
}

/** The active brand payload a downstream generator should read, if any. */
export async function loadActivePayload(
  tenantId: number,
  brandKitId: number | null | undefined,
): Promise<{ kit: BrandKit; payload: BrandKitPayload } | null> {
  if (!brandKitId) return null;
  const kit = await loadKit(tenantId, brandKitId);
  if (!kit) return null;
  const active = await loadVersionById(tenantId, kit.activeVersionId ?? null);
  const version =
    active ??
    (
      await db
        .select()
        .from(brandKitVersionsTable)
        .where(
          and(
            eq(brandKitVersionsTable.brandKitId, kit.id),
            eq(brandKitVersionsTable.tenantId, tenantId),
          ),
        )
        .orderBy(desc(brandKitVersionsTable.versionNumber))
        .limit(1)
    )[0];
  if (!version) return null;
  return { kit, payload: version.jsonPayload };
}
