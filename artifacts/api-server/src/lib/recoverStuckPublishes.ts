/**
 * Startup recovery for orphaned "publishing" content items.
 *
 * Instagram publishing runs as an in-process, fire-and-forget background job
 * (see `backgroundJobs.ts` / `routes/meta.ts`). The item is flipped to
 * "publishing" before the job starts and only reaches "published"/"failed" when
 * the job finishes. If the API server restarts or crashes mid-job, that item is
 * left stuck on "publishing" forever with no worker to finish or fail it.
 *
 * A running process cannot have such orphans (its own jobs are tracked in
 * memory), but a freshly started process has no in-flight jobs at all, so any
 * item still on "publishing" is a leftover from a previous process. We only
 * reclaim items whose `updatedAt` is older than a safe timeout — comfortably
 * longer than the slowest possible publish — so that if another server instance
 * is legitimately mid-publish (horizontal scaling), we never yank its job out
 * from under it.
 *
 * Reclaimed items are marked "failed" (not re-driven): re-driving risks a
 * double-post because the Instagram container may already have been published
 * before the crash. "failed" surfaces the item in the UI so the user can retry.
 */
import { db, contentItemsTable } from "@workspace/db";
import { and, eq, lt } from "drizzle-orm";
import { logger } from "./logger";

/**
 * How long an item may sit in "publishing" before a newly started process
 * treats it as orphaned. Must be safely longer than the slowest publish job
 * (Instagram container polling backs off up to ~90s plus network overhead).
 * Exported and mutable so tests can shrink it.
 */
export const STUCK_PUBLISH_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Mark every content item stuck in "publishing" past the timeout as "failed".
 * Intended to run once on server startup. Returns the number of items
 * reclaimed. Never throws — a recovery failure must not stop the server from
 * starting.
 */
export async function recoverStuckPublishingItems(
  timeoutMs: number = STUCK_PUBLISH_TIMEOUT_MS,
): Promise<number> {
  const cutoff = new Date(Date.now() - timeoutMs);
  try {
    const reclaimed = await db
      .update(contentItemsTable)
      .set({ status: "failed", updatedAt: new Date() })
      .where(
        and(
          eq(contentItemsTable.status, "publishing"),
          lt(contentItemsTable.updatedAt, cutoff),
        ),
      )
      .returning({ id: contentItemsTable.id });

    if (reclaimed.length > 0) {
      logger.warn(
        {
          count: reclaimed.length,
          ids: reclaimed.map((r) => r.id),
          cutoff,
        },
        "Recovered content items stuck in 'publishing' after a server restart; marked them 'failed'",
      );
    }
    return reclaimed.length;
  } catch (err) {
    logger.error(
      { err },
      "Failed to recover stuck 'publishing' content items on startup",
    );
    return 0;
  }
}
