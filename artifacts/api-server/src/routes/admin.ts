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
  sweepStatusTable,
} from "@workspace/db";
import { eq, sql, desc, gte, lte, and, or, ilike } from "drizzle-orm";
import { requireSuperadmin } from "../middlewares/requireSuperadmin";
import { recordAdminAction } from "../lib/adminAudit";
import {
  AdminUpdateTenantPlanBody,
  AdminUpdateTenantSuperadminBody,
  AdminUpdateTenantDesignSkillBody,
  AdminUpdateDesignSkillBody,
  AdminUpdateNotificationPoliciesBody,
  AdminUpdatePlanBody,
  AdminCreatePlanBody,
  AdminDecideSeatRequestBody,
} from "@workspace/api-zod";
import {
  notificationPoliciesTable,
  planSettingsTable,
  seatRequestsTable,
} from "@workspace/db";
import { notifySeatRequestDecided } from "../lib/notifications";
import {
  serializeSeatRequest,
  getEffectiveSeatLimit,
  getSeatsUsed,
} from "../lib/team";
import {
  DEFAULT_PLAN_IDS,
  FALLBACK_PLAN_ID,
  listPlans,
  invalidatePlanCache,
} from "../lib/plans";
import { isSuperadminEmail } from "../lib/superadmins";
import {
  getGlobalDesignSkillEnabled,
  loadDesignSkillRow,
} from "../lib/designSkill";
import { designSkillSettingsTable } from "@workspace/db";
import { fetchVerifiedEmail } from "../lib/clerkUser";
import { currentPeriodStart } from "../lib/usage";
import {
  triggerSweepNow,
  checkSweepStaleness,
  isSweepRunning,
} from "../lib/connectionSweep";
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
    designSkillEnabled: t.designSkillEnabled ?? null,
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
  // Piggyback the sweep-staleness watchdog on admin traffic (self-throttled,
  // fire-and-forget) so a stalled sweep is reported even if this process's
  // background timers were never started or died.
  void checkSweepStaleness();
  const [tenantRows, contentRow, scheduleRow, accountRow, sweepRow] = await Promise.all([
    db
      .select({ plan: tenantsTable.plan, count: sql<number>`count(*)::int` })
      .from(tenantsTable)
      .groupBy(tenantsTable.plan),
    db.select({ count: sql<number>`count(*)::int` }).from(contentItemsTable),
    db.select({ count: sql<number>`count(*)::int` }).from(scheduledPostsTable),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(connectedAccountsTable),
    db
      .select()
      .from(sweepStatusTable)
      .where(eq(sweepStatusTable.id, 1))
      .limit(1),
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
    sweepRunning: isSweepRunning(),
    connectionSweep: sweepRow[0]
      ? {
          lastRunAt: sweepRow[0].lastRunAt.toISOString(),
          durationMs: sweepRow[0].durationMs,
          accountsChecked: sweepRow[0].accountsChecked,
          errorCount: sweepRow[0].errorCount,
          lastError: sweepRow[0].lastError,
        }
      : null,
  });
});

/**
 * POST /admin/sweep/run
 * Kick off a connection sweep immediately (admin "Run now"). The sweep runs
 * in the background — this responds as soon as it is started, so a sweep
 * that takes minutes never leaves the request (or the admin UI) hanging.
 * Respects the in-process overlap guard: if a sweep is already in flight the
 * request is a no-op and returns started=false. The dashboard polls
 * /admin/stats (which reports sweepRunning) until the run completes.
 */
router.post("/admin/sweep/run", async (req: Request, res: Response) => {
  const started = triggerSweepNow();
  try {
    await recordAdminAction({
      action: "sweep_run",
      actorTenantId: req.tenantId,
      actorEmail: req.tenantEmail,
      targetTenantId: null,
      targetEmail: null,
      oldValue: null,
      newValue: JSON.stringify({ started }),
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to write sweep-run audit log");
  }
  res.json({ started });
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

/**
 * PATCH /admin/tenants/:id/design-skill
 * Set (true/false) or clear (null) a tenant's design-skill override.
 */
router.patch(
  "/admin/tenants/:id/design-skill",
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const parsed = AdminUpdateTenantDesignSkillBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
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
        .set({ designSkillEnabled: parsed.data.enabled, updatedAt: new Date() })
        .where(eq(tenantsTable.id, id))
        .returning()
    )[0];
    if (!updated) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    if (previous.designSkillEnabled !== updated.designSkillEnabled) {
      try {
        await recordAdminAction({
          action: "design_skill_change",
          actorTenantId: req.tenantId,
          actorEmail: req.tenantEmail,
          targetTenantId: updated.id,
          targetEmail: updated.email ?? null,
          oldValue: String(previous.designSkillEnabled),
          newValue: String(updated.designSkillEnabled),
        });
      } catch (error) {
        req.log.error({ err: error }, "Failed to write design-skill audit log");
      }
    }

    res.json(serializeAdminTenant(updated));
  },
);

/**
 * GET /admin/design-skill
 * The global switch for the canvas-design image prompt skill.
 */
router.get("/admin/design-skill", async (_req: Request, res: Response) => {
  res.json({ enabled: await getGlobalDesignSkillEnabled() });
});

/**
 * PUT /admin/design-skill
 * Enable or disable the design skill platform-wide (tenant overrides still win).
 */
router.put("/admin/design-skill", async (req: Request, res: Response) => {
  const parsed = AdminUpdateDesignSkillBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const before = await getGlobalDesignSkillEnabled();
  const row = await loadDesignSkillRow();
  if (row) {
    await db
      .update(designSkillSettingsTable)
      .set({ enabled: parsed.data.enabled })
      .where(eq(designSkillSettingsTable.id, row.id));
  } else {
    await db.insert(designSkillSettingsTable).values({ enabled: parsed.data.enabled });
  }

  if (before !== parsed.data.enabled) {
    try {
      await recordAdminAction({
        action: "design_skill_change",
        actorTenantId: req.tenantId,
        actorEmail: req.tenantEmail,
        targetTenantId: null,
        targetEmail: null,
        oldValue: String(before),
        newValue: String(parsed.data.enabled),
      });
    } catch (error) {
      req.log.error({ err: error }, "Failed to write design-skill audit log");
    }
  }

  res.json({ enabled: parsed.data.enabled });
});

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

  const { name, priceLabel, limits, features, teamSeats } = parsed.data;
  if (invalidLimits(limits)) {
    res
      .status(400)
      .json({ error: "Limits must be whole numbers (use -1 for unlimited)" });
    return;
  }
  if (teamSeats !== undefined && !Number.isInteger(teamSeats)) {
    res.status(400).json({ error: "Team seats must be a whole number" });
    return;
  }

  const values = {
    id: planId,
    name: name.trim(),
    priceLabel: priceLabel.trim(),
    teamSeats: teamSeats ?? previous.teamSeats,
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

  const { name, priceLabel, limits, features, teamSeats } = parsed.data;
  if (teamSeats !== undefined && !Number.isInteger(teamSeats)) {
    res.status(400).json({ error: "Team seats must be a whole number" });
    return;
  }
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
    teamSeats: teamSeats ?? 0,
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
      teamSeats: existing.teamSeats,
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
const AUDIT_ACTIONS = new Set([
  "plan_change",
  "superadmin_grant",
  "superadmin_revoke",
  "plan_edit",
  "plan_create",
  "plan_delete",
  "notification_policy_change",
  "credential_change",
  "app_brand_change",
  "email_settings_change",
  "email_test_send",
  "sweep_run",
]);

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function buildAuditLogWhere(
  q: Record<string, unknown>,
): { ok: true; where: ReturnType<typeof and> } | { ok: false; message: string } {
  const conditions = [];

  const action = typeof q.action === "string" ? q.action : undefined;
  if (action) {
    if (!AUDIT_ACTIONS.has(action)) {
      return { ok: false, message: `Unknown action "${action}"` };
    }
    conditions.push(eq(adminAuditLogsTable.action, action));
  }

  const actor =
    typeof q.actor === "string" && q.actor.trim() !== ""
      ? q.actor.trim().slice(0, 200)
      : undefined;
  if (actor) {
    const asId = /^\d+$/.test(actor) ? Number.parseInt(actor, 10) : null;
    const emailMatch = ilike(
      adminAuditLogsTable.actorEmail,
      `%${escapeLike(actor)}%`,
    );
    conditions.push(
      asId !== null
        ? or(emailMatch, eq(adminAuditLogsTable.actorTenantId, asId))!
        : emailMatch,
    );
  }

  const target =
    typeof q.target === "string" && q.target.trim() !== ""
      ? q.target.trim().slice(0, 200)
      : undefined;
  if (target) {
    const asId = /^\d+$/.test(target) ? Number.parseInt(target, 10) : null;
    const emailMatch = ilike(
      adminAuditLogsTable.targetEmail,
      `%${escapeLike(target)}%`,
    );
    conditions.push(
      asId !== null
        ? or(emailMatch, eq(adminAuditLogsTable.targetTenantId, asId))!
        : emailMatch,
    );
  }

  for (const [key, op] of [
    ["from", gte],
    ["to", lte],
  ] as const) {
    const raw = typeof q[key] === "string" ? (q[key] as string) : undefined;
    if (raw) {
      const date = new Date(raw);
      if (Number.isNaN(date.getTime())) {
        return { ok: false, message: `Invalid ${key} date` };
      }
      conditions.push(op(adminAuditLogsTable.createdAt, date));
    }
  }

  return {
    ok: true,
    where: conditions.length > 0 ? and(...conditions) : undefined,
  };
}

router.get("/admin/audit-logs", async (req: Request, res: Response) => {
  const q = req.query as Record<string, unknown>;

  const rawLimit = Number.parseInt(String(q.limit ?? ""), 10);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), 200)
    : 50;
  const rawOffset = Number.parseInt(String(q.offset ?? ""), 10);
  const offset = Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0;

  const parsed = buildAuditLogWhere(q);
  if (!parsed.ok) {
    res.status(400).json({ error: { message: parsed.message } });
    return;
  }
  const where = parsed.where;

  const [rows, [{ count }]] = await Promise.all([
    db
      .select()
      .from(adminAuditLogsTable)
      .where(where)
      .orderBy(desc(adminAuditLogsTable.createdAt), desc(adminAuditLogsTable.id))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(adminAuditLogsTable)
      .where(where),
  ]);

  res.json({
    items: rows.map((r) => ({
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
    total: count,
    limit,
    offset,
  });
});

/**
 * GET /admin/audit-logs/export
 * Streams ALL audit records matching the same filters as GET /admin/audit-logs
 * as a CSV download (no paging). Superadmin-scoped like the rest of /admin.
 */
function csvCell(value: string | number | null): string {
  if (value === null) return "";
  let s = String(value);
  // Neutralize spreadsheet formula injection: a leading =, +, -, @ (or a
  // tab/CR before one) would be interpreted as a formula by Excel/Sheets.
  if (/^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`;
  }
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const AUDIT_EXPORT_BATCH = 500;

/**
 * HEAD /admin/audit-logs/export
 * Preflight for the CSV export: runs the same auth (router-level
 * requireSuperadmin) and filter validation as the GET, but sends no body.
 * The frontend calls this before triggering the browser-native anchor
 * download so a 401/403/400 surfaces as an in-app toast instead of the
 * browser saving a JSON error body as a .csv file.
 */
router.head("/admin/audit-logs/export", (req: Request, res: Response) => {
  const parsed = buildAuditLogWhere(req.query as Record<string, unknown>);
  if (!parsed.ok) {
    res.status(400).end();
    return;
  }
  res.status(204).end();
});

router.get(
  "/admin/audit-logs/export",
  async (req: Request, res: Response) => {
    const parsed = buildAuditLogWhere(req.query as Record<string, unknown>);
    if (!parsed.ok) {
      res.status(400).json({ error: { message: parsed.message } });
      return;
    }
    const where = parsed.where;

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="audit-log-${stamp}.csv"`,
    );

    res.write(
      "id,createdAt,action,actorTenantId,actorEmail,targetTenantId,targetEmail,oldValue,newValue\r\n",
    );

    let offset = 0;
    for (;;) {
      const rows = await db
        .select()
        .from(adminAuditLogsTable)
        .where(where)
        .orderBy(
          desc(adminAuditLogsTable.createdAt),
          desc(adminAuditLogsTable.id),
        )
        .limit(AUDIT_EXPORT_BATCH)
        .offset(offset);

      for (const r of rows) {
        res.write(
          [
            csvCell(r.id),
            csvCell(r.createdAt.toISOString()),
            csvCell(r.action),
            csvCell(r.actorTenantId),
            csvCell(r.actorEmail ?? null),
            csvCell(r.targetTenantId),
            csvCell(r.targetEmail ?? null),
            csvCell(r.oldValue ?? null),
            csvCell(r.newValue ?? null),
          ].join(",") + "\r\n",
        );
      }

      if (rows.length < AUDIT_EXPORT_BATCH) break;
      offset += AUDIT_EXPORT_BATCH;
    }

    res.end();
  },
);

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

/**
 * GET /admin/seat-requests
 * All tenant seat requests, newest first, with workspace context.
 */
router.get("/admin/seat-requests", async (req: Request, res: Response) => {
  const rows = await db
    .select({
      request: seatRequestsTable,
      tenant: tenantsTable,
    })
    .from(seatRequestsTable)
    .innerJoin(tenantsTable, eq(seatRequestsTable.tenantId, tenantsTable.id))
    .orderBy(desc(seatRequestsTable.createdAt))
    .limit(200);

  // Effective limit and usage are computed per unique workspace (not per
  // request row) so the same tenant with several requests costs one lookup.
  const byTenant = new Map<number, { limit: number; used: number }>();
  for (const r of rows) {
    if (byTenant.has(r.tenant.id)) continue;
    const [limit, used] = await Promise.all([
      getEffectiveSeatLimit(r.tenant),
      getSeatsUsed(r.tenant.id),
    ]);
    byTenant.set(r.tenant.id, { limit, used });
  }

  res.json(
    rows.map((r) => {
      const t = byTenant.get(r.tenant.id)!;
      return {
        ...serializeSeatRequest(r.request),
        tenantId: r.request.tenantId,
        tenantName: r.tenant.name,
        tenantEmail: r.tenant.email ?? null,
        tenantPlan: r.tenant.plan,
        currentSeatLimit: t.limit,
        seatsUsed: t.used,
      };
    }),
  );
});

/**
 * PATCH /admin/seat-requests/:id
 * Approve (optionally with an adjusted seat count) or deny a pending seat
 * request. Approval writes the granted count to tenants.seatLimit — the
 * per-workspace override on top of the plan's default teamSeats. Audited
 * best-effort; the tenant is notified via the notification framework.
 */
router.patch(
  "/admin/seat-requests/:id",
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const parsed = AdminDecideSeatRequestBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    if (
      parsed.data.seats !== undefined &&
      !Number.isInteger(parsed.data.seats)
    ) {
      res.status(400).json({ error: "Seats must be a whole number" });
      return;
    }

    const existing = (
      await db
        .select()
        .from(seatRequestsTable)
        .where(eq(seatRequestsTable.id, id))
        .limit(1)
    )[0];
    if (!existing) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (existing.status !== "pending") {
      res.status(400).json({ error: "This request was already decided" });
      return;
    }

    const approved = parsed.data.action === "approve";
    const grantedSeats = approved
      ? (parsed.data.seats ?? existing.requestedSeats)
      : null;

    const tenant = (
      await db
        .select()
        .from(tenantsTable)
        .where(eq(tenantsTable.id, existing.tenantId))
        .limit(1)
    )[0];
    if (!tenant) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }

    if (approved) {
      await db
        .update(tenantsTable)
        .set({ seatLimit: grantedSeats, updatedAt: new Date() })
        .where(eq(tenantsTable.id, existing.tenantId));
    }

    const updated = (
      await db
        .update(seatRequestsTable)
        .set({
          status: approved ? "approved" : "denied",
          grantedSeats,
          decidedByEmail: req.tenantEmail,
          decidedAt: new Date(),
        })
        .where(eq(seatRequestsTable.id, id))
        .returning()
    )[0];

    try {
      await recordAdminAction({
        action: approved ? "seat_request_approve" : "seat_request_deny",
        actorTenantId: req.tenantId,
        actorEmail: req.tenantEmail,
        targetTenantId: existing.tenantId,
        targetEmail: tenant.email ?? null,
        oldValue: JSON.stringify({
          requestedSeats: existing.requestedSeats,
          previousSeatLimit: tenant.seatLimit ?? null,
        }),
        newValue: JSON.stringify({ grantedSeats }),
      });
    } catch (error) {
      req.log.error({ err: error }, "Failed to write seat-request audit log");
    }

    await notifySeatRequestDecided(existing.tenantId, {
      approved,
      grantedSeats,
    });

    const decidedTenant = (
      await db
        .select()
        .from(tenantsTable)
        .where(eq(tenantsTable.id, existing.tenantId))
        .limit(1)
    )[0];
    const [currentSeatLimit, seatsUsed] = await Promise.all([
      getEffectiveSeatLimit(decidedTenant ?? tenant),
      getSeatsUsed(existing.tenantId),
    ]);

    res.json({
      ...serializeSeatRequest(updated!),
      tenantId: existing.tenantId,
      tenantName: tenant.name,
      tenantEmail: tenant.email ?? null,
      tenantPlan: tenant.plan,
      currentSeatLimit,
      seatsUsed,
    });
  },
);

export default router;
