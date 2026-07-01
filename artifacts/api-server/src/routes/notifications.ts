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
router.get("/notifications", async (req: Request, res: Response) => {
  const rows = await db
    .select()
    .from(notificationsTable)
    .where(
      and(
        eq(notificationsTable.tenantId, req.tenantId),
        isNull(notificationsTable.readAt),
      ),
    )
    .orderBy(desc(notificationsTable.createdAt));
  res.json(rows.map(serialize));
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
