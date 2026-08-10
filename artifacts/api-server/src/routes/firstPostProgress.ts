import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  tenantsTable,
  contentItemsTable,
  connectedAccountsTable,
  usageEventsTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";

const router: IRouter = Router();

/**
 * "First post" activation progress, computed from the tenant's own data
 * (not analytics events, which are consent-gated and may be absent):
 *   generated — any AI usage event OR any content item exists
 *   saved     — at least one content item exists in the library
 *   connected — at least one connected_accounts row with status 'connected'
 *   published — at least one content item with status 'published'
 * `dismissed` mirrors tenants.first_post_nudge_dismissed_at.
 */
async function progressFor(tenantId: number) {
  const [tenantRows, usage, items, published, connected] = await Promise.all([
    db
      .select({ dismissedAt: tenantsTable.firstPostNudgeDismissedAt })
      .from(tenantsTable)
      .where(eq(tenantsTable.id, tenantId))
      .limit(1),
    db
      .select({ n: sql<number>`1` })
      .from(usageEventsTable)
      .where(eq(usageEventsTable.tenantId, tenantId))
      .limit(1),
    db
      .select({ n: sql<number>`1` })
      .from(contentItemsTable)
      .where(eq(contentItemsTable.tenantId, tenantId))
      .limit(1),
    db
      .select({ n: sql<number>`1` })
      .from(contentItemsTable)
      .where(
        and(
          eq(contentItemsTable.tenantId, tenantId),
          eq(contentItemsTable.status, "published"),
        ),
      )
      .limit(1),
    db
      .select({ n: sql<number>`1` })
      .from(connectedAccountsTable)
      .where(
        and(
          eq(connectedAccountsTable.tenantId, tenantId),
          eq(connectedAccountsTable.status, "connected"),
        ),
      )
      .limit(1),
  ]);
  if (!tenantRows[0]) return null;
  const saved = items.length > 0;
  return {
    generated: usage.length > 0 || saved,
    saved,
    connected: connected.length > 0,
    published: published.length > 0,
    dismissed: tenantRows[0].dismissedAt != null,
  };
}

router.get("/first-post-progress", async (req: Request, res: Response) => {
  const progress = await progressFor(req.tenantId);
  if (!progress) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  res.json(progress);
});

router.post(
  "/first-post-progress/dismiss",
  async (req: Request, res: Response) => {
    // Idempotent: keep the original dismissal timestamp if one exists.
    await db
      .update(tenantsTable)
      .set({ firstPostNudgeDismissedAt: sql`COALESCE(${tenantsTable.firstPostNudgeDismissedAt}, now())` })
      .where(eq(tenantsTable.id, req.tenantId));
    const progress = await progressFor(req.tenantId);
    if (!progress) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    res.json(progress);
  },
);

export default router;
