import { db, contentItemsTable, videoPublishesTable, scheduledPostsTable, type VideoPublishMetadata } from "@workspace/db";
import { and, eq, inArray, sql, or } from "drizzle-orm";
import { validateVideoMetadata } from "./videoPublishValidation";
import { videoPublishAuth } from "./videoPublishAuth";
import { stageVideo } from "./videoPublishMedia";
import { driveFacebook, driveInstagram, driveYoutube, VideoAmbiguousError, VideoDefinitiveError, VideoPermissionError, type VideoUpload } from "./videoPublishProviders";
import { contentPublishBlock } from "./compliance/content";
import { isFeatureEnabled } from "./featureFlags";
import { isShuttingDown, enqueueBackgroundJob } from "./backgroundJobs";
import { tryAcquireResendLock } from "./resendLock";
import { mergePublishedPlatform } from "./publishedPlatforms";
import type { PublishOutcome } from "./publishOutcome";
import { logger } from "./logger";

const ACTIVE = ["queued", "creating", "uploading", "processing", "committing"];
export const publicVideoOutcome = (row: VideoUpload) => ({ platform: row.platform, state: row.state, error: row.error, permalink: row.permalink });

export async function enqueueVideoPublish(tenantId: number, id: number, platform: string, snapshot?: { videoPath: string; metadata: VideoPublishMetadata }): Promise<PublishOutcome> {
  if (!(await isFeatureEnabled("connectedAccounts"))) return { ok: false, errorStatus: 403, error: "Social publishing is temporarily disabled." };
  const [item] = await db.select().from(contentItemsTable).where(and(eq(contentItemsTable.id, id), eq(contentItemsTable.tenantId, tenantId))).limit(1);
  if (!item) return { ok: false, errorStatus: 404, error: "Library video not found." };
  if (!item.videoPath) return { ok: false, errorStatus: 400, error: "This content type is not supported for native video publishing. Select a Library video." };
  const [existing] = await db.select().from(videoPublishesTable).where(and(eq(videoPublishesTable.contentItemId, id), eq(videoPublishesTable.platform, platform), eq(videoPublishesTable.tenantId, tenantId))).limit(1);
  if (existing) {
    if (existing.state === "attention" || existing.state === "failed") return { ok: false, errorStatus: 409, error: existing.error ?? "Check the existing upload on the platform before creating a new Library item." };
    return { ok: true, pending: existing.state !== "published", postId: existing.externalId, permalink: existing.permalink };
  }
  const metadata = snapshot?.metadata ?? item.videoPublishMetadata;
  const invalid = validateVideoMetadata(platform, metadata);
  if (invalid) return { ok: false, errorStatus: 400, error: invalid };
  const block = await contentPublishBlock(tenantId, id, { title: metadata!.title, caption: metadata!.description });
  if (block) return block;
  try {
    const auth = await videoPublishAuth(tenantId, platform);
    const path = snapshot?.videoPath ?? item.videoPath;
    const staged = await stageVideo(path, tenantId, platform);
    await staged.cleanup();
    await db.insert(videoPublishesTable).values({ tenantId, contentItemId: id, platform, videoPath: path, metadata: metadata!, accountId: auth.accountId }).onConflictDoNothing();
    await db.update(contentItemsTable).set({ status: "publishing", platform, failureReason: null, updatedAt: new Date() }).where(and(eq(contentItemsTable.id, id), eq(contentItemsTable.tenantId, tenantId)));
    return { ok: true, pending: true, postId: null, permalink: null };
  } catch (error) {
    return { ok: false, errorStatus: 400, error: error instanceof Error ? error.message : "Video preparation failed. Check the account and media." };
  }
}

async function finishUpload(row: VideoUpload) {
  if (!["published", "failed", "attention"].includes(row.state)) return;
  if (row.state === "published") {
    await db.update(contentItemsTable).set({ publishedPlatforms: mergePublishedPlatform(row.platform as "youtube" | "facebook" | "instagram", { postId: row.externalId, permalink: row.permalink }) }).where(and(eq(contentItemsTable.id, row.contentItemId), eq(contentItemsTable.tenantId, row.tenantId)));
  }
  await db.update(contentItemsTable).set({
    status: row.state === "published" ? "published" : "failed", failureReason: row.error, updatedAt: new Date(),
    ...(row.state === "published" ? { postId: row.externalId, permalink: row.permalink } : {}),
  }).where(and(eq(contentItemsTable.id, row.contentItemId), eq(contentItemsTable.tenantId, row.tenantId)));
  // A cancelled/deleted schedule is never resurrected.
  await db.update(scheduledPostsTable).set({ status: row.state === "published" ? "published" : "failed", failureReason: row.error, updatedAt: new Date() }).where(and(
    eq(scheduledPostsTable.contentItemId, row.contentItemId), eq(scheduledPostsTable.tenantId, row.tenantId),
    eq(scheduledPostsTable.platform, row.platform), eq(scheduledPostsTable.status, "processing"),
  ));
}

export async function runVideoPublishTick() {
  if (isShuttingDown() || !(await isFeatureEnabled("connectedAccounts"))) return;
  if (await isFeatureEnabled("scheduling")) {
    // A crash between claiming a schedule and enqueuing its upload must not
    // orphan the schedule. The unique upload key makes this reconciliation safe.
    const interrupted = await db.select().from(scheduledPostsTable).where(and(
      eq(scheduledPostsTable.status, "processing"),
      sql`${scheduledPostsTable.videoSnapshot} IS NOT NULL`,
      sql`${scheduledPostsTable.updatedAt} < NOW() - interval '5 minutes'`,
      sql`NOT EXISTS (SELECT 1 FROM video_publishes vp WHERE vp.content_item_id = ${scheduledPostsTable.contentItemId} AND vp.platform = ${scheduledPostsTable.platform})`,
    )).limit(10);
    for (const schedule of interrupted) {
      const release = tryAcquireResendLock(schedule.platform, schedule.contentItemId);
      if (!release) continue;
      try {
        const result = await enqueueVideoPublish(schedule.tenantId, schedule.contentItemId, schedule.platform, schedule.videoSnapshot!);
        if (!result.ok) await db.update(scheduledPostsTable).set({ status: "failed", failureReason: result.error, updatedAt: new Date() }).where(and(eq(scheduledPostsTable.id, schedule.id), eq(scheduledPostsTable.status, "processing")));
      } finally { release(); }
    }
  }
  const rows = await db.select().from(videoPublishesTable).where(or(
    inArray(videoPublishesTable.state, ACTIVE),
    sql`EXISTS (SELECT 1 FROM content_items c WHERE c.id = ${videoPublishesTable.contentItemId} AND c.status = 'publishing')`,
    sql`EXISTS (SELECT 1 FROM scheduled_posts s WHERE s.content_item_id = ${videoPublishesTable.contentItemId} AND s.platform = ${videoPublishesTable.platform} AND s.status = 'processing')`,
  )).orderBy(videoPublishesTable.lastAttemptAt, videoPublishesTable.id).limit(10);
  for (const candidate of rows) {
    if (isShuttingDown()) return;
    const release = tryAcquireResendLock(candidate.platform, candidate.contentItemId);
    if (!release) continue;
    try {
      // Cross-process exclusion. Checkpoints use the main pool, not this transaction:
      // they MUST commit before provider writes and survive a killed worker.
      await db.transaction(async tx => {
        const locked = await tx.execute(sql`select pg_try_advisory_xact_lock(72123, ${candidate.id}) as locked`);
        if (!(locked.rows[0] as { locked?: boolean })?.locked) return;
        let [row] = await db.select().from(videoPublishesTable).where(eq(videoPublishesTable.id, candidate.id));
        if (!row) return;
        await db.update(videoPublishesTable).set({ lastAttemptAt: new Date() }).where(eq(videoPublishesTable.id, row.id));
        if (!ACTIVE.includes(row.state)) { await finishUpload(row); return; }
        const save = async (patch: Partial<VideoUpload>) => {
          [row] = await db.update(videoPublishesTable).set({ error: null, ...patch, updatedAt: new Date() }).where(eq(videoPublishesTable.id, row.id)).returning();
          await db.update(contentItemsTable).set({ updatedAt: new Date() }).where(and(eq(contentItemsTable.id, row.contentItemId), eq(contentItemsTable.tenantId, row.tenantId)));
        };
        try {
          if (Date.now() - row.createdAt.getTime() > 24 * 60 * 60_000) throw new VideoAmbiguousError("Upload remains unresolved after 24 hours. Check the destination before creating another Library item.");
          const [item] = await db.select({ id: contentItemsTable.id }).from(contentItemsTable).where(and(eq(contentItemsTable.id, row.contentItemId), eq(contentItemsTable.tenantId, row.tenantId)));
          if (!item) throw new VideoAmbiguousError("Library item was removed. Check the destination for any existing upload.");
          const auth = await videoPublishAuth(row.tenantId, row.platform).catch(() => {
            throw new VideoPermissionError("Publishing access could not be verified. Reconnect the original destination on Accounts; this upload resumes automatically after access is restored.");
          });
          if (auth.accountId !== row.accountId) throw new VideoPermissionError("The connected account changed. Reconnect the original destination to resume this upload.");
          if (row.platform === "youtube") await driveYoutube(row, auth.token, save);
          else if (row.platform === "instagram") await driveInstagram(row, auth.token, auth.accountId, save);
          else await driveFacebook(row, auth.token, auth.accountId, save);
        } catch (error) {
          const terminal = error instanceof VideoAmbiguousError ? "attention" : error instanceof VideoDefinitiveError ? "failed" : null;
          if (error instanceof VideoPermissionError) {
            // Reconnecting resumes the exact checkpoint, never a fresh upload.
            await db.update(videoPublishesTable).set({ error: error.message }).where(eq(videoPublishesTable.id, row.id));
          }
          // Unknown transport results retain their checkpoint. In particular a
          // create/commit is never repeated just because its response was lost.
          if (terminal) await save({ state: terminal, error: (error as Error).message });
          else if (Date.now() - row.createdAt.getTime() > 24 * 60 * 60_000) await save({ state: "attention", error: "The platform has not confirmed this upload within 24 hours. Check the destination before creating another upload." });
          // No raw transport errors: they can contain upload sessions or signed URLs.
        }
        await finishUpload(row);
      });
    } catch {
      logger.warn({ videoPublishId: candidate.id }, "Video upload checkpoint unavailable; will reconcile on next tick");
    } finally { release(); }
  }
}

let timer: ReturnType<typeof setInterval> | undefined;
let busy = false;
export function startVideoPublisher() {
  if (timer) return;
  const tick = () => {
    if (busy || isShuttingDown()) return;
    busy = true;
    if (!enqueueBackgroundJob(async () => { try { await runVideoPublishTick(); } finally { busy = false; } })) busy = false;
  };
  timer = setInterval(tick, 15_000);
  timer.unref();
  tick();
}
export function stopVideoPublisher() { if (timer) clearInterval(timer); timer = undefined; }