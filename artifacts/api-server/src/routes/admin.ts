import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  tenantsTable,
  contentItemsTable,
  brandKitsTable,
  scheduledPostsTable,
  connectedAccountsTable,
  usageEventsTable,
} from "@workspace/db";
import { eq, sql, desc, gte } from "drizzle-orm";
import { requireSuperadmin } from "../middlewares/requireSuperadmin";
import {
  AdminUpdateTenantPlanBody,
  AdminUpdateTenantSuperadminBody,
  AdminUpdateNotificationPoliciesBody,
} from "@workspace/api-zod";
import { notificationPoliciesTable } from "@workspace/db";
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

  const byPlan = { free: 0, pro: 0, business: 0 } as Record<string, number>;
  let totalTenants = 0;
  for (const row of tenantRows) {
    byPlan[row.plan] = (byPlan[row.plan] ?? 0) + row.count;
    totalTenants += row.count;
  }

  res.json({
    totalTenants,
    tenantsByPlan: {
      free: byPlan.free ?? 0,
      pro: byPlan.pro ?? 0,
      business: byPlan.business ?? 0,
    },
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

    res.json(serializeAdminTenant(updated));
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
