import { Router, type IRouter, type Request, type Response } from "express";
import { db, scheduledPostsTable, contentItemsTable } from "@workspace/db";
import { and, eq, asc } from "drizzle-orm";
import { CreateScheduleBody, UpdateScheduleBody } from "@workspace/api-zod";
import { serializeSchedule } from "../lib/serializers";
import { recordTasteSignal } from "../lib/tasteMemory";

const router: IRouter = Router();

router.param("id", (req, res, next, value) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  next();
});

router.get("/schedules", async (req: Request, res: Response) => {
  const rows = await db
    .select()
    .from(scheduledPostsTable)
    .where(eq(scheduledPostsTable.tenantId, req.tenantId))
    .orderBy(asc(scheduledPostsTable.scheduledAt));
  res.json(rows.map(serializeSchedule));
});

router.post("/schedules", async (req: Request, res: Response) => {
  const parsed = CreateScheduleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const content = (
    await db
      .select()
      .from(contentItemsTable)
      .where(
        and(
          eq(contentItemsTable.id, parsed.data.contentItemId),
          eq(contentItemsTable.tenantId, req.tenantId),
        ),
      )
      .limit(1)
  )[0];
  if (!content) {
    res.status(400).json({ error: "Content item not found" });
    return;
  }

  const created = (
    await db
      .insert(scheduledPostsTable)
      .values({
        tenantId: req.tenantId,
        contentItemId: parsed.data.contentItemId,
        platform: parsed.data.platform,
        scheduledAt: new Date(parsed.data.scheduledAt),
      })
      .returning()
  )[0]!;

  await db
    .update(contentItemsTable)
    .set({ status: "scheduled", updatedAt: new Date() })
    .where(eq(contentItemsTable.id, parsed.data.contentItemId));

  // Taste memory: scheduling content is an approval signal. Best-effort.
  void recordTasteSignal(req.tenantId, {
    kind: "scheduled",
    caption: content.caption,
    imagePrompt: content.imagePrompt,
    platform: parsed.data.platform,
  });

  res.status(201).json(serializeSchedule(created));
});

router.patch("/schedules/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const parsed = UpdateScheduleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const { scheduledAt, ...rest } = parsed.data;
  const updated = (
    await db
      .update(scheduledPostsTable)
      .set({
        ...rest,
        ...(scheduledAt ? { scheduledAt: new Date(scheduledAt) } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(eq(scheduledPostsTable.id, id), eq(scheduledPostsTable.tenantId, req.tenantId)),
      )
      .returning()
  )[0];
  if (!updated) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(serializeSchedule(updated));
});

router.delete("/schedules/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const deleted = (
    await db
      .delete(scheduledPostsTable)
      .where(
        and(eq(scheduledPostsTable.id, id), eq(scheduledPostsTable.tenantId, req.tenantId)),
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
