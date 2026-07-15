import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  tenantsTable,
  contentItemsTable,
  brandKitsTable,
  scheduledPostsTable,
  connectedAccountsTable,
  usageEventsTable,
  adminAuditLogsTable,
} from "@workspace/db";
import { eq, sql, desc, gte } from "drizzle-orm";
import { requireSuperadmin } from "../middlewares/requireSuperadmin";
import { recordAdminAction } from "../lib/adminAudit";
import {
  AdminUpdateTenantPlanBody,
  AdminUpdateTenantSuperadminBody,
  AdminUpdateNotificationPoliciesBody,
  AdminUpdatePlanBody,
  AdminCreatePlanBody,
} from "@workspace/api-zod";
import { notificationPoliciesTable, planSettingsTable } from "@workspace/db";
import {
  DEFAULT_PLAN_IDS,
  FALLBACK_PLAN_ID,
  listPlans,
  invalidatePlanCache,
} from "../lib/plans";
import { isSuperadminEmail } from "../lib/superadmins";
import { fetchVerifiedEmail } from "../lib/clerkUser";
import { currentPeriodStart } from "../lib/usage";
import {
  NOTIFICATION_TYPES,
  NOTIFICATION_TYPE_SET,
} from "../lib/notificationCatalog";
import { defaultPolicy, getPolicyMap } from "../lib/notificationSettings";
import type { Tenant } from "@workspace/db";

const router: IRouter = Router();

// Every admin route requires superadmin privileges.
router.use("/admin", requireSuperadmin);

router.param("id", (req, res, next, value) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  next();
});

function serializeAdminTenant(t: Tenant) {
  const isAllowlisted = isSuperadminEmail(t.email);
  return {
    id: t.id,
    email: t.email ?? null,
    name: t.name,
    plan: t.plan,
    aiModel: t.aiModel,
    // Effective: granted in-app OR allowlisted by email.
    isSuperadmin: t.isSuperadmin || isAllowlisted,
    isAllowlisted,
    createdAt: t.createdAt.toISOString(),
  };
}

async function countByTenant(
  table:
    | typeof contentItemsTable
    | typeof brandKitsTable
    | typeof scheduledPostsTable
    | typeof connectedAccountsTable,
): Promise<Map<number, number>> {
  const rows = await db
    .select({
      tenantId: table.tenantId,
      count: sql<number>`count(*)::int`,
    })
    .from(table)
    .groupBy(table.tenantId);
  return new Map(rows.map((r) => [r.tenantId, r.count]));
}

/**
 * GET /admin/tenants
 * List every tenant in the platform with usage and resource counts.
 */
router.get("/admin/tenants", async (_req: Request, res: Response) => {
  const periodStart = currentPeriodStart();

  const [
    tenants,
    contentCounts,
    brandKitCounts,
    scheduleCounts,
    accountCounts,
    usageRows,
  ] = await Promise.all([
    db.select().from(tenantsTable).orderBy(desc(tenantsTable.createdAt)),
    countByTenant(contentItemsTable),
    countByTenant(brandKitsTable),
    countByTenant(scheduledPostsTable),
    countByTenant(connectedAccountsTable),
    db
      .select({
        tenantId: usageEventsTable.tenantId,
        kind: usageEventsTable.kind,
        count: sql<number>`count(*)::int`,
      })
      .from(usageEventsTable)
      .where(gte(usageEventsTable.createdAt, periodStart))
      .groupBy(usageEventsTable.tenantId, usageEventsTable.kind),
  ]);

  const captionUsage = new Map<number, number>();
  const imageUsage = new Map<number, number>();
  for (const row of usageRows) {
    if (row.kind === "caption") captionUsage.set(row.tenantId, row.count);
    else if (row.kind === "image") imageUsage.set(row.tenantId, row.count);
  }

  res.json(
    tenants.map((t) => ({
      ...serializeAdminTenant(t),
      counts: {
        content: contentCounts.get(t.id) ?? 0,
        brandKits: brandKitCounts.get(t.id) ?? 0,
        scheduledPosts: scheduleCounts.get(t.id) ?? 0,
        connectedAccounts: accountCounts.get(t.id) ?? 0,
      },
      usage: {
        captions: captionUsage.get(t.id) ?? 0,
        images: imageUsage.get(t.id) ?? 0,
        periodStart: periodStart.toISOString(),
      },
    })),
  );
});

/**
 * GET /admin/stats
 * Platform-wide aggregate stats.
 */
router.get("/admin/stats", async (_req: Request, res: Response) => {
  const [tenantRows, contentRow, scheduleRow, accountRow] = await Promise.all([
    db
      .select({ plan: tenantsTable.plan, count: sql<number>`count(*)::int` })
      .from(tenantsTable)
      .groupBy(tenantsTable.plan),
    db.select({ count: sql<number>`count(*)::int` }).from(contentItemsTable),
    db.select({ count: sql<number>`count(*)::int` }).from(scheduledPostsTable),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(connectedAccountsTable),
  ]);

  // Include every catalog plan (even those with zero tenants) plus any plan
  // ids still referenced by tenants but no longer in the catalog.
  const byPlan: Record<string, number> = {};
  for (const p of await listPlans()) byPlan[p.id] = 0;
  let totalTenants = 0;
  for (const row of tenantRows) {
    byPlan[row.plan] = (byPlan[row.plan] ?? 0) + row.count;
    totalTenants += row.count;
  }

  res.json({
    totalTenants,
    tenantsByPlan: byPlan,
    totalContent: contentRow[0]?.count ?? 0,
    totalScheduledPosts: scheduleRow[0]?.count ?? 0,
    totalConnectedAccounts: accountRow[0]?.count ?? 0,
  });
});

/**
 * PATCH /admin/tenants/:id
 * Superadmin override of a tenant's subscription plan.
 */
router.patch("/admin/tenants/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const parsed = AdminUpdateTenantPlanBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  // Plans are dynamic; validate against the live catalog rather than an enum.
  const catalog = await listPlans();
  if (!catalog.some((p) => p.id === parsed.data.plan)) {
    res.status(400).json({ error: "Unknown plan" });
    return;
  }

  const previous = (
    await db.select().from(tenantsTable).where(eq(tenantsTable.id, id))
  )[0];

  if (!previous) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const updated = (
    await db
      .update(tenantsTable)
      .set({ plan: parsed.data.plan, updatedAt: new Date() })
      .where(eq(tenantsTable.id, id))
      .returning()
  )[0];

  if (!updated) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  if (previous.plan !== updated.plan) {
    try {
      await recordAdminAction({
        action: "plan_change",
        actorTenantId: req.tenantId,
        actorEmail: req.tenantEmail,
        targetTenantId: updated.id,
        targetEmail: updated.email ?? null,
        oldValue: previous.plan,
        newValue: updated.plan,
      });
    } catch (error) {
      req.log.error({ err: error }, "Failed to write plan-change audit log");
    }
  }

  res.json(serializeAdminTenant(updated));
});

/**
 * PATCH /admin/tenants/:id/superadmin
 * Grant or revoke the in-app superadmin role for a tenant.
 *
 * Authorization: restricted to allowlisted (root) OWNERS — a merely granted
 * superadmin must not be able to mint or remove other superadmins. The actor's
 * LIVE verified Clerk email is resolved here so a stale cached flag can never
 * authorize role management; it fails closed.
 *
 * Allowlisted owners are permanent: their access derives from the email
 * allowlist, not this flag, so writes against an allowlisted target (including
 * self) are rejected to keep the DB state semantically clean and to prevent
 * self-lockout.
 */
router.patch(
  "/admin/tenants/:id/superadmin",
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const parsed = AdminUpdateTenantSuperadminBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }

    const actorEmail = await fetchVerifiedEmail(req.clerkUserId);
    if (!isSuperadminEmail(actorEmail)) {
      res
        .status(403)
        .json({ error: "Only owners can change superadmin roles" });
      return;
    }

    const target = (
      await db.select().from(tenantsTable).where(eq(tenantsTable.id, id))
    )[0];
    if (!target) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    if (isSuperadminEmail(target.email)) {
      res.status(400).json({ error: "Allowlisted owners cannot be modified" });
      return;
    }

    const updated = (
      await db
        .update(tenantsTable)
        .set({ isSuperadmin: parsed.data.isSuperadmin, updatedAt: new Date() })
        .where(eq(tenantsTable.id, id))
        .returning()
    )[0];

    if (!updated) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    if (target.isSuperadmin !== updated.isSuperadmin) {
      try {
        await recordAdminAction({
          action: updated.isSuperadmin
            ? "superadmin_grant"
            : "superadmin_revoke",
          actorTenantId: req.tenantId,
          actorEmail: actorEmail ?? req.tenantEmail,
          targetTenantId: updated.id,
          targetEmail: updated.email ?? null,
          oldValue: String(target.isSuperadmin),
          newValue: String(updated.isSuperadmin),
        });
      } catch (error) {
        req.log.error(
          { err: error },
          "Failed to write superadmin-change audit log",
        );
      }
    }

    res.json(serializeAdminTenant(updated));
  },
);

const invalidLimit = (n: number) =>
  !Number.isInteger(n) || (n < 0 && n !== -1);

function invalidLimits(limits: {
  captions: number;
  images: number;
  brandKits: number;
  scheduledPosts: number;
}): boolean {
  return (
    invalidLimit(limits.captions) ||
    invalidLimit(limits.images) ||
    invalidLimit(limits.brandKits) ||
    invalidLimit(limits.scheduledPosts)
  );
}

/**
 * PUT /admin/plans/:planId
 * Superadmin edit of a subscription plan's name, price label, limits, and
 * feature list. Works for both built-in and custom plans; the row in
 * plan_settings overrides or defines the plan. Returns the full catalog.
 */
router.put("/admin/plans/:planId", async (req: Request, res: Response) => {
  const planId = String(req.params.planId);
  const catalog = await listPlans();
  const previous = catalog.find((p) => p.id === planId);
  if (!previous) {
    res.status(404).json({ error: "Unknown plan" });
    return;
  }

  const parsed = AdminUpdatePlanBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const { name, priceLabel, limits, features } = parsed.data;
  if (invalidLimits(limits)) {
    res
      .status(400)
      .json({ error: "Limits must be whole numbers (use -1 for unlimited)" });
    return;
  }

  const values = {
    id: planId,
    name: name.trim(),
    priceLabel: priceLabel.trim(),
    captions: limits.captions,
    images: limits.images,
    brandKits: limits.brandKits,
    scheduledPosts: limits.scheduledPosts,
    features: features.map((f) => f.trim()).filter(Boolean),
    sortOrder: catalog.findIndex((p) => p.id === planId),
    archived: false,
    updatedAt: new Date(),
  };

  await db
    .insert(planSettingsTable)
    .values(values)
    .onConflictDoUpdate({ target: planSettingsTable.id, set: values });

  invalidatePlanCache();

  try {
    await recordAdminAction({
      action: "plan_edit",
      actorTenantId: req.tenantId,
      actorEmail: req.tenantEmail,
      targetTenantId: null,
      targetEmail: null,
      oldValue: JSON.stringify(previous.limits),
      newValue: JSON.stringify(limits),
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to write plan-edit audit log");
  }

  res.json(await listPlans());
});

/**
 * POST /admin/plans
 * Superadmin creation of a new custom subscription plan. The id is either
 * provided (url-safe) or derived from the name; it must not collide with an
 * existing catalog plan or a built-in default id (even a deleted one keeps
 * its id reserved to avoid resurrecting defaults unexpectedly).
 */
router.post("/admin/plans", async (req: Request, res: Response) => {
  const parsed = AdminCreatePlanBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const { name, priceLabel, limits, features } = parsed.data;
  if (invalidLimits(limits)) {
    res
      .status(400)
      .json({ error: "Limits must be whole numbers (use -1 for unlimited)" });
    return;
  }

  const id =
    parsed.data.id ??
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
  if (!id) {
    res.status(400).json({ error: "Plan name must contain letters or digits" });
    return;
  }

  const catalog = await listPlans();
  const existingRow = (
    await db
      .select({ id: planSettingsTable.id })
      .from(planSettingsTable)
      .where(eq(planSettingsTable.id, id))
  )[0];
  if (
    catalog.some((p) => p.id === id) ||
    DEFAULT_PLAN_IDS.includes(id) ||
    existingRow
  ) {
    res.status(409).json({ error: "A plan with this id already exists" });
    return;
  }

  await db.insert(planSettingsTable).values({
    id,
    name: name.trim(),
    priceLabel: priceLabel.trim(),
    captions: limits.captions,
    images: limits.images,
    brandKits: limits.brandKits,
    scheduledPosts: limits.scheduledPosts,
    features: features.map((f) => f.trim()).filter(Boolean),
    sortOrder: catalog.length,
    archived: false,
  });

  invalidatePlanCache();

  try {
    await recordAdminAction({
      action: "plan_create",
      actorTenantId: req.tenantId,
      actorEmail: req.tenantEmail,
      targetTenantId: null,
      targetEmail: null,
      oldValue: null,
      newValue: JSON.stringify({ id, name: name.trim(), limits }),
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to write plan-create audit log");
  }

  res.json(await listPlans());
});

/**
 * DELETE /admin/plans/:planId
 * Superadmin deletion of a subscription plan. Guarded: the fallback plan
 * (new signups land there) cannot be deleted, and a plan still assigned to
 * any workspace cannot be deleted until those workspaces are moved. Built-in
 * defaults are removed via an archived marker row; custom plans are deleted
 * outright.
 */
router.delete("/admin/plans/:planId", async (req: Request, res: Response) => {
  const planId = String(req.params.planId);

  if (planId === FALLBACK_PLAN_ID) {
    res.status(400).json({
      error: "The Free plan is the default for new signups and cannot be deleted",
    });
    return;
  }

  const catalog = await listPlans();
  const existing = catalog.find((p) => p.id === planId);
  if (!existing) {
    res.status(404).json({ error: "Unknown plan" });
    return;
  }

  const inUse = (
    await db
      .select({ count: sql<number>`count(*)::int` })
      .from(tenantsTable)
      .where(eq(tenantsTable.plan, planId))
  )[0];
  if ((inUse?.count ?? 0) > 0) {
    res.status(400).json({
      error: `Cannot delete: ${inUse!.count} workspace(s) are on this plan. Move them to another plan first.`,
    });
    return;
  }

  if (DEFAULT_PLAN_IDS.includes(planId)) {
    // Built-in default: mark as archived so it stays deleted.
    const values = {
      id: planId,
      name: existing.name,
      priceLabel: existing.priceLabel,
      captions: existing.limits.captions,
      images: existing.limits.images,
      brandKits: existing.limits.brandKits,
      scheduledPosts: existing.limits.scheduledPosts,
      features: existing.features,
      archived: true,
      updatedAt: new Date(),
    };
    await db
      .insert(planSettingsTable)
      .values(values)
      .onConflictDoUpdate({ target: planSettingsTable.id, set: values });
  } else {
    await db.delete(planSettingsTable).where(eq(planSettingsTable.id, planId));
  }

  invalidatePlanCache();

  try {
    await recordAdminAction({
      action: "plan_delete",
      actorTenantId: req.tenantId,
      actorEmail: req.tenantEmail,
      targetTenantId: null,
      targetEmail: null,
      oldValue: JSON.stringify({ id: planId, name: existing.name }),
      newValue: null,
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to write plan-delete audit log");
  }

  res.json(await listPlans());
});

/**
 * GET /admin/audit-logs
 * The append-only trail of privileged admin actions (plan overrides and
 * superadmin grants/revokes), most recent first. Read-only, superadmin-scoped.
 */
router.get("/admin/audit-logs", async (_req: Request, res: Response) => {
  const rows = await db
    .select()
    .from(adminAuditLogsTable)
    .orderBy(desc(adminAuditLogsTable.createdAt))
    .limit(100);

  res.json(
    rows.map((r) => ({
      id: r.id,
      action: r.action,
      actorTenantId: r.actorTenantId,
      actorEmail: r.actorEmail ?? null,
      targetTenantId: r.targetTenantId,
      targetEmail: r.targetEmail ?? null,
      oldValue: r.oldValue ?? null,
      newValue: r.newValue ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
  );
});

/**
 * GET /admin/notification-policies
 * The global per-type notification policy (enabled + email policy), merged with
 * the catalog so every known type appears even before it has a stored row.
 */
router.get(
  "/admin/notification-policies",
  async (_req: Request, res: Response) => {
    const map = await getPolicyMap();
    res.json(
      NOTIFICATION_TYPES.map((def) => {
        const policy = map.get(def.type) ?? defaultPolicy();
        return {
          type: def.type,
          label: def.label,
          description: def.description,
          enabled: policy.enabled,
          emailPolicy: policy.emailPolicy,
        };
      }),
    );
  },
);

/**
 * PUT /admin/notification-policies
 * Superadmin update of the global notification policy per type. Unknown types
 * are ignored so a stale client cannot create junk rows.
 */
router.put(
  "/admin/notification-policies",
  async (req: Request, res: Response) => {
    const parsed = AdminUpdateNotificationPoliciesBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }

    const unknown = parsed.data.policies
      .map((p) => p.type)
      .filter((t) => !NOTIFICATION_TYPE_SET.has(t));
    if (unknown.length > 0) {
      res
        .status(400)
        .json({ error: `Unknown notification type(s): ${unknown.join(", ")}` });
      return;
    }

    // Snapshot the prior policies so each real change (not no-op saves) can be
    // audited with old vs new values.
    const priorMap = await getPolicyMap();

    for (const policy of parsed.data.policies) {
      await db
        .insert(notificationPoliciesTable)
        .values({
          type: policy.type,
          enabled: policy.enabled,
          emailPolicy: policy.emailPolicy,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: notificationPoliciesTable.type,
          set: {
            enabled: policy.enabled,
            emailPolicy: policy.emailPolicy,
            updatedAt: new Date(),
          },
        });
    }

    // Best-effort audit of real changes AFTER the primary mutation succeeded:
    // one row per changed type, with old vs new enabled/emailPolicy.
    for (const policy of parsed.data.policies) {
      const prior = priorMap.get(policy.type) ?? defaultPolicy();
      if (
        prior.enabled === policy.enabled &&
        prior.emailPolicy === policy.emailPolicy
      ) {
        continue;
      }
      try {
        await recordAdminAction({
          action: "notification_policy_change",
          actorTenantId: req.tenantId,
          actorEmail: req.tenantEmail,
          targetTenantId: null,
          targetEmail: null,
          oldValue: JSON.stringify({
            type: policy.type,
            enabled: prior.enabled,
            emailPolicy: prior.emailPolicy,
          }),
          newValue: JSON.stringify({
            type: policy.type,
            enabled: policy.enabled,
            emailPolicy: policy.emailPolicy,
          }),
        });
      } catch (error) {
        req.log.error(
          { err: error },
          "Failed to write notification-policy audit log",
        );
      }
    }

    const map = await getPolicyMap();
    res.json(
      NOTIFICATION_TYPES.map((def) => {
        const policy = map.get(def.type) ?? defaultPolicy();
        return {
          type: def.type,
          label: def.label,
          description: def.description,
          enabled: policy.enabled,
          emailPolicy: policy.emailPolicy,
        };
      }),
    );
  },
);

export default router;
