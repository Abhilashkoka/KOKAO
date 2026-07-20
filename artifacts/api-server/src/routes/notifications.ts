import { Router, type IRouter, type Request, type Response } from "express";
import { db, notificationsTable } from "@workspace/db";
import { and, desc, eq, isNull } from "drizzle-orm";

const router: IRouter = Router();

function serialize(row: typeof notificationsTable.$inferSelect) {
  return {
    id: row.id,
    type: row.type,
    platform: row.platform,
    title: row.title,
    message: row.message,
    linkUrl: row.linkUrl,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt ? row.readAt.toISOString() : null,
  };
}

router.param("id", (req, res, next, value) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  next();
});

// List the current tenant's unread notifications, newest first.
// Pass ?all=true to include recently read notifications (capped) for inbox views.
router.get("/notifications", async (req: Request, res: Response) => {
  const includeRead = req.query.all === "true";
  const conditions = [
    eq(notificationsTable.tenantId, req.tenantId),
    eq(notificationsTable.inApp, true),
  ];
  if (!includeRead) {
    conditions.push(isNull(notificationsTable.readAt));
  }
  let query = db
    .select()
    .from(notificationsTable)
    .where(and(...conditions))
    .orderBy(desc(notificationsTable.createdAt));
  const rows = includeRead ? await query.limit(100) : await query;
  res.json(rows.map(serialize));
});

// Mark all of the current tenant's unread notifications as read.
router.post("/notifications/read-all", async (req: Request, res: Response) => {
  await db
    .update(notificationsTable)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notificationsTable.tenantId, req.tenantId),
        isNull(notificationsTable.readAt),
      ),
    );
  res.status(204).end();
});

// Dismiss (mark read) a single notification, scoped to the current tenant.
router.post(
  "/notifications/:id/read",
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const updated = await db
      .update(notificationsTable)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notificationsTable.id, id),
          eq(notificationsTable.tenantId, req.tenantId),
        ),
      )
      .returning();
    if (updated.length === 0) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(204).end();
  },
);

export default router;
