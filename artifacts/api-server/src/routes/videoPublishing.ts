import { Router, type IRouter } from "express";
import { db, contentItemsTable, videoPublishesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { enqueueVideoPublish, publicVideoOutcome } from "../lib/videoPublisher";
import { VIDEO_DESTINATIONS } from "../lib/videoPublishValidation";
import { videoPublishAuth } from "../lib/videoPublishAuth";
import { requireFeature } from "../lib/featureFlags";
import { tryAcquireResendLock, PUBLISH_IN_PROGRESS_MESSAGE } from "../lib/resendLock";
import { isShuttingDown } from "../lib/backgroundJobs";

const router: IRouter = Router();
router.get("/video-publish-capabilities", requireFeature("connectedAccounts"), async (req, res) => {
  const entries = await Promise.all(VIDEO_DESTINATIONS.map(async platform => {
    try { await videoPublishAuth(req.tenantId, platform); return [platform, { available: true, guidance: platform === "youtube" ? "Unaudited Google API projects may be restricted to private uploads." : "Reels follow your destination's sharing and remix settings. Facebook Page Reels are public." }]; }
    catch (error) { return [platform, { available: false, guidance: error instanceof Error ? error.message : "Publishing access could not be verified. Reconnect on Accounts." }]; }
  }));
  res.json(Object.fromEntries(entries));
});
router.get("/content/:id/video-publishes", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid id" }); return; }
  const [item] = await db.select({ id: contentItemsTable.id }).from(contentItemsTable).where(and(eq(contentItemsTable.id, id), eq(contentItemsTable.tenantId, req.tenantId)));
  if (!item) { res.status(404).json({ error: "Not found" }); return; }
  const rows = await db.select().from(videoPublishesTable).where(and(eq(videoPublishesTable.contentItemId, id), eq(videoPublishesTable.tenantId, req.tenantId)));
  res.json(rows.map(publicVideoOutcome));
});
router.post("/content/:id/publish-video", requireFeature("connectedAccounts"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid id" }); return; }
  if (isShuttingDown()) { res.status(503).json({ error: "Server restarting; nothing new was submitted. Try again." }); return; }
  const [item] = await db.select().from(contentItemsTable).where(and(eq(contentItemsTable.id, id), eq(contentItemsTable.tenantId, req.tenantId)));
  if (!item?.videoPath) { res.status(404).json({ error: "Library video not found" }); return; }
  const platform = item.videoPublishMetadata?.destination ?? item.platform;
  const release = tryAcquireResendLock(platform, id);
  if (!release) { res.status(409).json({ error: PUBLISH_IN_PROGRESS_MESSAGE }); return; }
  try {
    const outcome = await enqueueVideoPublish(req.tenantId, id, platform);
    if (!outcome.ok) { res.status(outcome.errorStatus).json({ error: outcome.error }); return; }
    res.status(202).json({ platform, state: outcome.pending ? "processing" : "published", permalink: outcome.permalink });
  } finally { release(); }
});
export default router;