import { Router, type IRouter, type Request, type Response } from "express";
import { db, scheduledPostsTable, contentItemsTable } from "@workspace/db";
import { and, eq, asc, ne, sql } from "drizzle-orm";
import { CreateScheduleBody, UpdateScheduleBody } from "@workspace/api-zod";
import { serializeSchedule } from "../lib/serializers";
import { recordTasteSignal } from "../lib/tasteMemory";
import { retryScheduledPostNow } from "../lib/scheduledPublisher";
import { checkContentItemCompliance } from "../lib/compliance/content";
import { validateVideoMetadata } from "../lib/videoPublishValidation";
import { videoPublishAuth } from "../lib/videoPublishAuth";

const router: IRouter = Router();
const PROCESSING_SCHEDULE_MESSAGE = "Publishing has already started. This schedule cannot be changed or removed safely. Check the upload in the Content Library and the destination account; it may continue after reconnecting.";

async function unavailableSchedule(req: Request, res: Response, id: number) {
  const [existing] = await db.select({ id: scheduledPostsTable.id }).from(scheduledPostsTable)
    .where(and(eq(scheduledPostsTable.id, id), eq(scheduledPostsTable.tenantId, req.tenantId))).limit(1);
  res.status(existing ? 409 : 404).json({ error: existing ? PROCESSING_SCHEDULE_MESSAGE : "Not found" });
}

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
  const compliance = await checkContentItemCompliance(req.tenantId, content.id,
    content.videoPath && content.videoPublishMetadata
      ? { title: content.videoPublishMetadata.title, caption: content.videoPublishMetadata.description }
      : undefined);
  if (content.videoPath) {
    const invalid = validateVideoMetadata(parsed.data.platform, content.videoPublishMetadata);
    if (invalid) { res.status(400).json({ error: invalid }); return; }
    try { await videoPublishAuth(req.tenantId, parsed.data.platform); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Verify publishing access first." }); return; }
  }
  if (!compliance.ok) {
    res.status(compliance.errorStatus).json({
      error: compliance.error,
      code: compliance.errorStatus === 503 ? "compliance_unavailable" : "compliance_blocked",
      ...(compliance.report ? { compliance: compliance.report } : {}),
    });
    return;
  }

  const created = (
    await db
      .insert(scheduledPostsTable)
      .values({
        tenantId: req.tenantId,
        contentItemId: parsed.data.contentItemId,
        platform: parsed.data.platform,
        videoSnapshot: content.videoPath && content.videoPublishMetadata ? { videoPath: content.videoPath, metadata: content.videoPublishMetadata } : null,
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
  if (rest.platform) {
    const [existing] = await db.select().from(scheduledPostsTable).where(and(eq(scheduledPostsTable.id, id), eq(scheduledPostsTable.tenantId, req.tenantId))).limit(1);
    if (existing?.videoSnapshot && existing.videoSnapshot.metadata.destination !== rest.platform) {
      res.status(400).json({ error: "The video review is saved for a different destination. Create a new reviewed schedule from the Content Library." }); return;
    }
  }
  const updated = (
    await db
      .update(scheduledPostsTable)
      .set({
        ...rest,
        ...(scheduledAt ? { scheduledAt: new Date(scheduledAt) } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(eq(scheduledPostsTable.id, id), eq(scheduledPostsTable.tenantId, req.tenantId),
          ne(scheduledPostsTable.status, "processing"),
          sql`NOT EXISTS (SELECT 1 FROM video_publishes vp WHERE vp.content_item_id = ${scheduledPostsTable.contentItemId} AND vp.platform = ${scheduledPostsTable.platform} AND vp.state IN ('queued','creating','uploading','processing','committing'))`),
      )
      .returning()
  )[0];
  if (!updated) {
    await unavailableSchedule(req, res, id);
    return;
  }
  res.json(serializeSchedule(updated));
});

// Retry a FAILED scheduled post on the platform it targeted. Runs the same
// platform publish core the executor uses, synchronously, and returns the
// updated schedule row so the client can reflect the final status.
router.post("/schedules/:id/retry", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const result = await retryScheduledPostNow(req.tenantId, id);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  const row = (
    await db
      .select()
      .from(scheduledPostsTable)
      .where(
        and(eq(scheduledPostsTable.id, id), eq(scheduledPostsTable.tenantId, req.tenantId)),
      )
      .limit(1)
  )[0];
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(serializeSchedule(row));
});

router.delete("/schedules/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const deleted = (
    await db
      .delete(scheduledPostsTable)
      .where(
        and(eq(scheduledPostsTable.id, id), eq(scheduledPostsTable.tenantId, req.tenantId),
          ne(scheduledPostsTable.status, "processing"),
          sql`NOT EXISTS (SELECT 1 FROM video_publishes vp WHERE vp.content_item_id = ${scheduledPostsTable.contentItemId} AND vp.platform = ${scheduledPostsTable.platform} AND vp.state IN ('queued','creating','uploading','processing','committing'))`),
      )
      .returning()
  )[0];
  if (!deleted) {
    await unavailableSchedule(req, res, id);
    return;
  }
  res.status(204).end();
});

export default router;
