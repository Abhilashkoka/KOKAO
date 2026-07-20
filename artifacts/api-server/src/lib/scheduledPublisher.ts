/**
 * Scheduled-publish executor.
 *
 * A single in-process loop (same pattern as connectionSweep) that wakes up
 * every SCHEDULED_PUBLISH_INTERVAL_MS, claims scheduled_posts rows whose
 * scheduledAt has passed, and drives the same per-platform publish cores the
 * manual publish endpoints use (publishOutcome.ts documents the contract).
 *
 * Claiming is a single atomic UPDATE pending -> processing RETURNING, so a
 * row can never be picked up twice by overlapping ticks (the overlap guard
 * makes overlap impossible in-process anyway, but the claim is still atomic).
 *
 * Per claimed row:
 * - acquire the same in-memory per-item publish lock manual publishes use;
 *   if a manual publish is mid-flight, put the row back to "pending" so the
 *   next tick re-checks it (by then the manual publish has usually finished
 *   and the core's own dedupe probe prevents a double post).
 * - run the platform core; on success mark the schedule "published" and drop
 *   an in-app notification; on failure mark it "failed" with the reason and
 *   notify (in-app + best-effort email).
 *
 * Crash recovery: rows stuck in "processing" longer than
 * STUCK_PROCESSING_TIMEOUT_MS (i.e. the process died mid-publish) are marked
 * "failed" at the start of each tick — mirroring recoverStuckPublishes.ts,
 * and for the same reason we never re-drive them automatically: the platform
 * write may have landed before the crash.
 */
import { db, scheduledPostsTable, contentItemsTable, tenantsTable } from "@workspace/db";
import { and, eq, lte, lt } from "drizzle-orm";
import { logger } from "./logger";
import { tryAcquireResendLock } from "./resendLock";
import { isShuttingDown } from "./backgroundJobs";
import { isFeatureEnabled } from "./featureFlags";
import {
  notifyScheduledPostPublished,
  notifyScheduledPublishFailed,
} from "./notifications";
import type { PublishOutcome } from "./publishOutcome";
import { publishFacebookCore, publishInstagramCore } from "../routes/meta";
import { publishLinkedinCore } from "../routes/linkedin";
import { publishTwitterCore } from "../routes/twitter";
import { publishThreadsCore } from "../routes/threads";

/** How often the executor looks for due scheduled posts. */
export const SCHEDULED_PUBLISH_INTERVAL_MS = 60 * 1000;

/** Grace before the first tick so boot-time work settles first. */
export const SCHEDULED_PUBLISH_INITIAL_DELAY_MS = 15 * 1000;

/**
 * How long a row may sit in "processing" before a tick treats it as orphaned
 * by a crash/restart. Comfortably longer than the slowest publish (Instagram
 * container polling can take minutes).
 */
export const STUCK_PROCESSING_TIMEOUT_MS = 15 * 60 * 1000;

/** Reason stamped on schedules orphaned mid-publish by a restart. */
export const SCHEDULE_INTERRUPTED_REASON =
  "Publishing was interrupted by a server restart. Check the platform to see whether the post went out before retrying from the Content Library.";

/**
 * Bounded auto-retry for TRANSIENT scheduled-publish failures (errorStatus
 * 503 — e.g. an X token refresh hitting a brief platform outage). Instead of
 * failing the schedule, the row is re-queued as "pending" with a short delay
 * up to maxRetries times; only when retries are exhausted (or on any
 * definitive error) is it marked failed and the tenant notified. Exported
 * and mutable so tests can shrink it.
 */
export const SCHEDULED_TRANSIENT_RETRY = {
  maxRetries: 3,
  delayMs: 5 * 60 * 1000,
};

const UNSUPPORTED_PLATFORM_REASON =
  "Automatic publishing is not supported for this platform yet. Publish it manually from the Content Library.";

type PublishCore = (
  tenantId: number,
  contentItemId: number,
) => Promise<PublishOutcome>;

const PLATFORM_CORES: Record<string, PublishCore> = {
  facebook: publishFacebookCore,
  instagram: publishInstagramCore,
  linkedin: publishLinkedinCore,
  twitter: publishTwitterCore,
  threads: publishThreadsCore,
};

let timer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
let running = false;

/**
 * One executor pass. Exported for tests; never throws. Returns the number of
 * schedule rows it finished (published or failed).
 */
export async function runScheduledPublishTick(): Promise<number> {
  if (running) return 0;
  running = true;
  try {
    // Platform kill switch: when the scheduling module is disabled by a
    // superadmin, due posts stay pending (and publish later if re-enabled).
    if (!(await isFeatureEnabled("scheduling"))) return 0;
    // Publishing to social platforms is part of the connected-accounts
    // module; when it is disabled, due posts also stay pending.
    if (!(await isFeatureEnabled("connectedAccounts"))) return 0;
    await recoverStuckProcessing();
    if (isShuttingDown()) return 0;

    const now = new Date();
    const claimed = await db
      .update(scheduledPostsTable)
      .set({ status: "processing", updatedAt: now })
      .where(
        and(
          eq(scheduledPostsTable.status, "pending"),
          lte(scheduledPostsTable.scheduledAt, now),
        ),
      )
      .returning();

    let finished = 0;
    for (const row of claimed) {
      if (isShuttingDown()) {
        // Put unstarted claims back so the next process picks them up.
        await revertToPending(row.id);
        continue;
      }
      finished += await publishOneScheduledPost(row);
    }
    return finished;
  } catch (err) {
    logger.error({ err }, "Scheduled-publish tick failed");
    return 0;
  } finally {
    running = false;
  }
}

async function revertToPending(id: number): Promise<void> {
  try {
    await db
      .update(scheduledPostsTable)
      .set({ status: "pending", updatedAt: new Date() })
      .where(
        and(
          eq(scheduledPostsTable.id, id),
          eq(scheduledPostsTable.status, "processing"),
        ),
      );
  } catch (err) {
    logger.error({ err, scheduledPostId: id }, "Failed to revert claimed schedule to pending");
  }
}

async function publishOneScheduledPost(row: {
  id: number;
  tenantId: number;
  contentItemId: number;
  platform: string;
  retryCount: number;
}): Promise<number> {
  const logCtx = {
    scheduledPostId: row.id,
    tenantId: row.tenantId,
    contentItemId: row.contentItemId,
    platform: row.platform,
  };
  try {
    const core = PLATFORM_CORES[row.platform];
    if (!core) {
      await finishSchedule(row, {
        ok: false,
        errorStatus: 400,
        error: UNSUPPORTED_PLATFORM_REASON,
      });
      return 1;
    }

    const release = tryAcquireResendLock(row.platform, row.contentItemId);
    if (!release) {
      // A manual publish/resend is mid-flight for this exact item+platform.
      // Back off; the next tick re-checks and the core's dedupe probe keeps
      // us from double-posting if the manual publish succeeded.
      logger.info(logCtx, "Scheduled publish deferred: item is locked by a manual publish");
      await revertToPending(row.id);
      return 0;
    }

    let outcome: PublishOutcome;
    try {
      outcome = await core(row.tenantId, row.contentItemId);
    } finally {
      release();
    }

    // Transient platform outage (e.g. an X token refresh hitting a brief
    // 503): re-queue with a delay instead of failing, up to the bounded
    // retry budget. Definitive errors fall through to finishSchedule.
    if (
      !outcome.ok &&
      outcome.errorStatus === 503 &&
      row.retryCount < SCHEDULED_TRANSIENT_RETRY.maxRetries
    ) {
      const requeued = await requeueForTransientRetry(row, outcome.error);
      if (requeued) return 0;
      // The row changed mid-publish (e.g. cancelled); nothing more to do.
      return 0;
    }

    await finishSchedule(row, outcome);
    return 1;
  } catch (err) {
    logger.error({ err, ...logCtx }, "Scheduled publish crashed unexpectedly");
    await finishSchedule(row, {
      ok: false,
      errorStatus: 500,
      error: "An unexpected error occurred while publishing. Please retry from the Content Library.",
    });
    return 1;
  }
}

/**
 * Re-queue a schedule after a transient publish failure: pending again,
 * pushed out by the retry delay, retry counter bumped, and the transient
 * error kept in failureReason for visibility. Status-guarded on
 * "processing" so a mid-flight cancel wins. No tenant notification — the
 * post is still going to be published. Returns false if the row changed.
 */
async function requeueForTransientRetry(
  row: { id: number; tenantId: number; platform: string; retryCount: number },
  error: string,
): Promise<boolean> {
  const updated = await db
    .update(scheduledPostsTable)
    .set({
      status: "pending",
      scheduledAt: new Date(Date.now() + SCHEDULED_TRANSIENT_RETRY.delayMs),
      retryCount: row.retryCount + 1,
      failureReason: error,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(scheduledPostsTable.id, row.id),
        eq(scheduledPostsTable.status, "processing"),
      ),
    )
    .returning({ id: scheduledPostsTable.id });
  if (updated.length === 0) {
    logger.warn(
      { scheduledPostId: row.id, tenantId: row.tenantId, platform: row.platform },
      "Schedule row changed mid-publish; skipping transient-retry requeue",
    );
    return false;
  }
  logger.info(
    {
      scheduledPostId: row.id,
      tenantId: row.tenantId,
      platform: row.platform,
      attempt: row.retryCount + 1,
      maxRetries: SCHEDULED_TRANSIENT_RETRY.maxRetries,
      error,
    },
    "Scheduled publish hit a transient outage; re-queued for retry",
  );
  return true;
}

/** Result of a user-initiated retry of a failed scheduled post. */
export type ScheduleRetryResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

/**
 * User-initiated retry of a FAILED scheduled post, run synchronously (the
 * caller is an HTTP handler awaiting the outcome, mirroring the library
 * page's manual publish retry). Claims failed -> processing atomically so a
 * double-click or a concurrent executor tick can never drive the same row
 * twice, holds the same per-item publish lock as manual publishes, drives
 * the platform core for the platform the row targeted, and stamps the final
 * schedule status via the same status-guarded finishSchedule write.
 */
export async function retryScheduledPostNow(
  tenantId: number,
  scheduledPostId: number,
): Promise<ScheduleRetryResult> {
  const claimed = (
    await db
      .update(scheduledPostsTable)
      .set({ status: "processing", updatedAt: new Date() })
      .where(
        and(
          eq(scheduledPostsTable.id, scheduledPostId),
          eq(scheduledPostsTable.tenantId, tenantId),
          eq(scheduledPostsTable.status, "failed"),
        ),
      )
      .returning()
  )[0];

  if (!claimed) {
    const existing = (
      await db
        .select({ status: scheduledPostsTable.status })
        .from(scheduledPostsTable)
        .where(
          and(
            eq(scheduledPostsTable.id, scheduledPostId),
            eq(scheduledPostsTable.tenantId, tenantId),
          ),
        )
        .limit(1)
    )[0];
    if (!existing) return { ok: false, status: 404, error: "Not found" };
    return {
      ok: false,
      status: 409,
      error: `Only failed scheduled posts can be retried (current status: ${existing.status}).`,
    };
  }

  const revertToFailed = async () => {
    // Keep the prior failureReason (the claim only touched status/updatedAt).
    await db
      .update(scheduledPostsTable)
      .set({ status: "failed", updatedAt: new Date() })
      .where(
        and(
          eq(scheduledPostsTable.id, claimed.id),
          eq(scheduledPostsTable.status, "processing"),
        ),
      );
  };

  const core = PLATFORM_CORES[claimed.platform];
  if (!core) {
    await revertToFailed();
    return { ok: false, status: 400, error: UNSUPPORTED_PLATFORM_REASON };
  }

  const release = tryAcquireResendLock(claimed.platform, claimed.contentItemId);
  if (!release) {
    await revertToFailed();
    return {
      ok: false,
      status: 409,
      error: "A publish is already in progress for this post. Try again in a moment.",
    };
  }

  let outcome: PublishOutcome;
  try {
    outcome = await core(claimed.tenantId, claimed.contentItemId);
  } catch (err) {
    logger.error(
      { err, scheduledPostId: claimed.id, tenantId, platform: claimed.platform },
      "Scheduled-post retry crashed unexpectedly",
    );
    outcome = {
      ok: false,
      errorStatus: 500,
      error: "An unexpected error occurred while publishing. Please try again.",
    };
  } finally {
    release();
  }

  await finishSchedule(claimed, outcome);
  if (outcome.ok) return { ok: true };
  return { ok: false, status: outcome.errorStatus, error: outcome.error };
}

async function finishSchedule(
  row: { id: number; tenantId: number; contentItemId: number; platform: string },
  outcome: PublishOutcome,
): Promise<void> {
  const title = await lookupTitle(row.tenantId, row.contentItemId);
  if (outcome.ok) {
    const updated = await db
      .update(scheduledPostsTable)
      .set({ status: "published", failureReason: null, updatedAt: new Date() })
      .where(
        and(
          eq(scheduledPostsTable.id, row.id),
          eq(scheduledPostsTable.status, "processing"),
        ),
      )
      .returning({ id: scheduledPostsTable.id });
    if (updated.length === 0) {
      logger.warn(
        { scheduledPostId: row.id, tenantId: row.tenantId, platform: row.platform },
        "Schedule row changed mid-publish; skipping final status write and notification",
      );
      return;
    }
    logger.info(
      { scheduledPostId: row.id, tenantId: row.tenantId, platform: row.platform, postId: outcome.postId },
      "Scheduled post published",
    );
    await notifyScheduledPostPublished(row.tenantId, title, row.platform);
  } else {
    const updated = await db
      .update(scheduledPostsTable)
      .set({ status: "failed", failureReason: outcome.error, updatedAt: new Date() })
      .where(
        and(
          eq(scheduledPostsTable.id, row.id),
          eq(scheduledPostsTable.status, "processing"),
        ),
      )
      .returning({ id: scheduledPostsTable.id });
    if (updated.length === 0) {
      logger.warn(
        { scheduledPostId: row.id, tenantId: row.tenantId, platform: row.platform },
        "Schedule row changed mid-publish; skipping final status write and notification",
      );
      return;
    }
    logger.warn(
      { scheduledPostId: row.id, tenantId: row.tenantId, platform: row.platform, error: outcome.error },
      "Scheduled publish failed",
    );
    const clerkUserId = await lookupClerkUserId(row.tenantId);
    await notifyScheduledPublishFailed(
      row.tenantId,
      clerkUserId,
      title,
      row.platform,
      outcome.error,
    );
  }
}

async function lookupTitle(tenantId: number, contentItemId: number): Promise<string> {
  try {
    const rows = await db
      .select({ title: contentItemsTable.title })
      .from(contentItemsTable)
      .where(
        and(
          eq(contentItemsTable.id, contentItemId),
          eq(contentItemsTable.tenantId, tenantId),
        ),
      )
      .limit(1);
    return rows[0]?.title ?? "Untitled post";
  } catch {
    return "Untitled post";
  }
}

async function lookupClerkUserId(tenantId: number): Promise<string | null> {
  try {
    const rows = await db
      .select({ clerkUserId: tenantsTable.clerkUserId })
      .from(tenantsTable)
      .where(eq(tenantsTable.id, tenantId))
      .limit(1);
    return rows[0]?.clerkUserId ?? null;
  } catch {
    return null;
  }
}

/** Fail schedules orphaned in "processing" by a previous process crash. */
async function recoverStuckProcessing(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - STUCK_PROCESSING_TIMEOUT_MS);
    const reclaimed = await db
      .update(scheduledPostsTable)
      .set({
        status: "failed",
        failureReason: SCHEDULE_INTERRUPTED_REASON,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(scheduledPostsTable.status, "processing"),
          lt(scheduledPostsTable.updatedAt, cutoff),
        ),
      )
      .returning({
        id: scheduledPostsTable.id,
        tenantId: scheduledPostsTable.tenantId,
        contentItemId: scheduledPostsTable.contentItemId,
        platform: scheduledPostsTable.platform,
      });
    for (const r of reclaimed) {
      logger.warn(
        { scheduledPostId: r.id, tenantId: r.tenantId },
        "Recovered scheduled post stuck in 'processing'; marked failed",
      );
      const title = await lookupTitle(r.tenantId, r.contentItemId);
      const clerkUserId = await lookupClerkUserId(r.tenantId);
      await notifyScheduledPublishFailed(
        r.tenantId,
        clerkUserId,
        title,
        r.platform,
        SCHEDULE_INTERRUPTED_REASON,
      );
    }
  } catch (err) {
    logger.error({ err }, "Failed to recover stuck 'processing' scheduled posts");
  }
}

/** Start the periodic executor. Safe to call once at boot; timers unref. */
export function startScheduledPublisher(): void {
  if (timer || initialTimer) return;
  initialTimer = setTimeout(() => {
    initialTimer = null;
    void runScheduledPublishTick();
    timer = setInterval(() => {
      void runScheduledPublishTick();
    }, SCHEDULED_PUBLISH_INTERVAL_MS);
    timer.unref();
  }, SCHEDULED_PUBLISH_INITIAL_DELAY_MS);
  initialTimer.unref();
}

/** Stop the executor (graceful shutdown). In-flight tick finishes on its own. */
export function stopScheduledPublisher(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
