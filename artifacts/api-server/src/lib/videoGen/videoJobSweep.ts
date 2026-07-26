import { db, videoGenerationsTable } from "@workspace/db";
import { and, inArray, isNotNull, lt } from "drizzle-orm";
import { refundCredits } from "../credits";
import { logger } from "../logger";
import { videoJobUnits } from "./units";

/**
 * Periodic settling for video_generations rows that will never settle
 * themselves, in two flavours:
 *
 *   - Storyboards nobody approved. A paused job holds its funding reservation
 *     against a render that may never happen, so once the review window closes
 *     the reservation has to go back.
 *   - Jobs orphaned in queued/processing. The background job is in-process, so
 *     a restart loses the runner and the row sits "processing" forever with
 *     the reservation already spent.
 *
 * Both flips are one conditional UPDATE ... RETURNING, so a row is settled
 * exactly once even if two sweeps overlap, and only the pass that actually
 * flipped it issues the refund. Modelled on the image job sweep.
 */

/** How often the sweep runs. */
export const VIDEO_JOB_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** Grace before the first sweep so boot-time work settles first. */
export const VIDEO_JOB_SWEEP_INITIAL_DELAY_MS = 30 * 1000;

/**
 * How long a row may sit in queued/processing before the sweep treats it as
 * orphaned. Comfortably longer than the slowest pipeline (character topic
 * videos get a 25-minute internal deadline).
 */
export const VIDEO_JOB_STUCK_TIMEOUT_MS = 40 * 60 * 1000;

/** Error stamped on video jobs orphaned by a restart. */
export const VIDEO_JOB_INTERRUPTED_ERROR =
  "Video generation was interrupted by a server restart. Please try again.";

/** Error stamped on storyboards that were never approved. */
export const STORYBOARD_EXPIRED_ERROR =
  "This storyboard expired before it was approved. Nothing was charged — start a new video when you are ready.";

async function refundRow(
  row: {
    id: number;
    tenantId: number;
    engine: string;
    funding: "quota" | "credit" | null;
    options: typeof videoGenerationsTable.$inferSelect.options;
  },
  reason: string,
): Promise<void> {
  if (row.funding !== "credit") return;
  await refundCredits(row.tenantId, "video", videoJobUnits(row.engine, row.options), reason).catch(
    (err) => logger.error({ err, jobId: row.id }, "Failed to refund video credits"),
  );
}

const SETTLE_COLUMNS = {
  id: videoGenerationsTable.id,
  tenantId: videoGenerationsTable.tenantId,
  engine: videoGenerationsTable.engine,
  funding: videoGenerationsTable.funding,
  options: videoGenerationsTable.options,
};

/**
 * Fail out storyboards past their review window and refund the reservation.
 * Exported for tests; never throws. Returns the number of rows settled.
 */
export async function sweepExpiredStoryboards(): Promise<number> {
  try {
    const expired = await db
      .update(videoGenerationsTable)
      .set({
        status: "failed",
        error: STORYBOARD_EXPIRED_ERROR,
        stage: null,
        storyboardExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          inArray(videoGenerationsTable.status, ["awaiting_review"]),
          isNotNull(videoGenerationsTable.storyboardExpiresAt),
          lt(videoGenerationsTable.storyboardExpiresAt, new Date()),
        ),
      )
      .returning(SETTLE_COLUMNS);
    for (const row of expired) {
      logger.info({ jobId: row.id, tenantId: row.tenantId }, "Expired unreviewed storyboard");
      await refundRow(row, "storyboard expired unreviewed");
    }
    return expired.length;
  } catch (err) {
    logger.error({ err }, "Storyboard expiry sweep failed");
    return 0;
  }
}

/**
 * Fail out video jobs abandoned in queued/processing by a crash or restart and
 * refund the reservation. Exported for tests; never throws.
 */
export async function sweepStuckVideoJobs(): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - VIDEO_JOB_STUCK_TIMEOUT_MS);
    const reclaimed = await db
      .update(videoGenerationsTable)
      .set({
        status: "failed",
        error: VIDEO_JOB_INTERRUPTED_ERROR,
        stage: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          inArray(videoGenerationsTable.status, ["queued", "processing"]),
          lt(videoGenerationsTable.updatedAt, cutoff),
        ),
      )
      .returning(SETTLE_COLUMNS);
    for (const row of reclaimed) {
      logger.warn(
        { jobId: row.id, tenantId: row.tenantId },
        "Failed abandoned video job stuck in queued/processing",
      );
      await refundRow(row, "video job abandoned by restart");
    }
    return reclaimed.length;
  } catch (err) {
    logger.error({ err }, "Video job sweep failed");
    return 0;
  }
}

async function sweepOnce(): Promise<void> {
  await sweepExpiredStoryboards();
  await sweepStuckVideoJobs();
}

let sweepTimer: NodeJS.Timeout | null = null;
let sweepInitialTimer: NodeJS.Timeout | null = null;

/** Start the periodic sweep. Safe to call once at boot; timers unref. */
export function startVideoJobSweep(): void {
  if (sweepTimer || sweepInitialTimer) return;
  sweepInitialTimer = setTimeout(() => {
    sweepInitialTimer = null;
    void sweepOnce();
    sweepTimer = setInterval(() => {
      void sweepOnce();
    }, VIDEO_JOB_SWEEP_INTERVAL_MS);
    sweepTimer.unref();
  }, VIDEO_JOB_SWEEP_INITIAL_DELAY_MS);
  sweepInitialTimer.unref();
}

/** Stop the sweep (graceful shutdown). */
export function stopVideoJobSweep(): void {
  if (sweepInitialTimer) {
    clearTimeout(sweepInitialTimer);
    sweepInitialTimer = null;
  }
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
