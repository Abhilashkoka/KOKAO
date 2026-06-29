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
import { AdminUpdateTenantPlanBody } from "@workspace/api-zod";
import { isSuperadminEmail } from "../lib/superadmins";
import { currentPeriodStart } from "../lib/usage";

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
      id: t.id,
      email: t.email ?? null,
      name: t.name,
      plan: t.plan,
      aiModel: t.aiModel,
      isSuperadmin: isSuperadminEmail(t.email),
      createdAt: t.createdAt.toISOString(),
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

  res.json({
    id: updated.id,
    email: updated.email ?? null,
    name: updated.name,
    plan: updated.plan,
    aiModel: updated.aiModel,
    isSuperadmin: isSuperadminEmail(updated.email),
    createdAt: updated.createdAt.toISOString(),
  });
});

export default router;
