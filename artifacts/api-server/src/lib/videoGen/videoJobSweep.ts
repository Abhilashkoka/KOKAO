import { db, guidedStoryDraftsTable, videoGenerationsTable } from "@workspace/db";
import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { refundCredits } from "../credits";
import {
  refundFailedVideoJobWallet,
  reservationFromRow,
} from "../wallet";
import { logger } from "../logger";
import { videoJobUnits } from "./units";
import { enqueueBackgroundJob } from "../backgroundJobs";
import { cleanupGuidedAtlasBackdropAssets, runVideoGenerationJob } from "./jobRunner";
import { VIDEO_PROCESS_INSTANCE_ID } from "./processInstance";

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
export const FRESH_RESTART_CREATING_TIMEOUT_MS = 10 * 60 * 1000;
/** Legacy rows without a lease get the same conservative registration window. */
export const GUIDED_STORY_CREATING_TIMEOUT_MS = 2 * 60 * 60 * 1000;
export const GUIDED_ATLAS_ASSET_STALE_MS = 5 * 60 * 1000;

/** Error stamped on video jobs orphaned by a restart. */
export const VIDEO_JOB_INTERRUPTED_ERROR =
  "Video generation was interrupted by a server restart. Please try again.";

/** Error stamped on storyboards that were never approved. */
export const STORYBOARD_EXPIRED_ERROR =
  "This storyboard expired before it was approved. Nothing was charged — start a new video when you are ready.";

export function guidedStoryCreatingInterruptedError(jobId: number): string {
  return `Job #${jobId} was interrupted before funding could be queued. Nothing was charged; give fresh consent and create a new approved attempt.`;
}

export function retryCreatingInterruptedError(jobId: number): string {
  return `Job #${jobId} retry was interrupted before it could be queued. Any attached funding is being returned; create a new retry attempt.`;
}

async function refundRow(
  row: {
    id: number;
    tenantId: number;
    engine: string;
    funding: "quota" | "credit" | "wallet" | null;
    walletReservationId: number | null;
    walletReservedPaise: number | null;
    walletReservedUnits: number | null;
    options: typeof videoGenerationsTable.$inferSelect.options;
  },
  reason: string,
): Promise<void> {
  const reservation = reservationFromRow(row);
  if (reservation) {
    await refundFailedVideoJobWallet(row.id, reason).catch((err) =>
      logger.error({ err, jobId: row.id }, "Failed to refund video job wallet"),
    );
    return;
  }
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
  walletReservationId: videoGenerationsTable.walletReservationId,
  walletReservedPaise: videoGenerationsTable.walletReservedPaise,
  walletReservedUnits: videoGenerationsTable.walletReservedUnits,
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
          // Queued fresh-restart children are durably re-enqueued above. A
          // processing child is owned by a worker and must be reclaimed after
          // the same heartbeat timeout as every other interrupted render.
          sql`(
            ${videoGenerationsTable.status} <> 'queued'
            OR (${videoGenerationsTable.options}->'freshRestart'->>'sourceJobId') IS NULL
          )`,
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

/** Reconcile provider assets left by a process death; unsafe/unknown predictions are retained. */
export async function sweepGuidedAtlasBackdropAssets(): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - GUIDED_ATLAS_ASSET_STALE_MS);
    const rows = await db.select({ id: videoGenerationsTable.id })
      .from(videoGenerationsTable)
      .where(and(
        lt(videoGenerationsTable.updatedAt, cutoff),
        sql`${videoGenerationsTable.options}->'guidedAtlasBackdropAssets' IS NOT NULL`,
      ));
    let cleaned = 0;
    for (const row of rows) cleaned += await cleanupGuidedAtlasBackdropAssets(row.id);
    return cleaned;
  } catch (err) {
    logger.error({ err }, "Guided Atlas backdrop asset sweep failed");
    return 0;
  }
}

/** Resume fresh-restart jobs whose in-process queue was lost on a restart. */
export async function resumeQueuedFreshRestartJobs(): Promise<number> {
  const queued = await db
    .select()
    .from(videoGenerationsTable)
    .where(eq(videoGenerationsTable.status, "queued"));
  let accepted = 0;
  for (const row of queued) {
    if (row.options?.freshRestart?.sourceJobId == null || !row.funding) continue;
    if (
      enqueueBackgroundJob(() =>
        runVideoGenerationJob(row.id, row.funding as "quota" | "credit" | "wallet"),
      )
    ) {
      accepted += 1;
    }
  }
  return accepted;
}

/** Refund and delete non-runnable fresh children stranded before transition. */
export async function sweepStrandedFreshRestartCreations(): Promise<number> {
  const cutoff = new Date(Date.now() - FRESH_RESTART_CREATING_TIMEOUT_MS);
  const candidates = await db
    .select()
    .from(videoGenerationsTable)
    .where(
      and(
        eq(videoGenerationsTable.status, "creating"),
        lt(videoGenerationsTable.updatedAt, cutoff),
      ),
    );
  let removed = 0;
  for (const row of candidates) {
    if (row.options?.freshRestart?.sourceJobId == null) continue;
    const [deleted] = await db
      .delete(videoGenerationsTable)
      .where(
        and(
          eq(videoGenerationsTable.id, row.id),
          eq(videoGenerationsTable.status, "creating"),
        ),
      )
      .returning(SETTLE_COLUMNS);
    if (!deleted) continue;
    await refundRow(deleted, "fresh restart creation interrupted");
    removed += 1;
  }
  return removed;
}

/**
 * Terminalize numbered Atlas Guided attempts abandoned before their atomic
 * funding transition. The same transaction releases the draft binding, while
 * the job row remains as the immutable audit record and registration fence.
 */
export async function sweepStrandedGuidedStoryCreations(): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - GUIDED_STORY_CREATING_TIMEOUT_MS);
    const candidates = await db.select().from(videoGenerationsTable).where(and(
      eq(videoGenerationsTable.status, "creating"),
      eq(videoGenerationsTable.provider, "atlascloud"),
      sql`${videoGenerationsTable.options}->'guidedStory' IS NOT NULL`,
      sql`(
        (
          ${videoGenerationsTable.options}->'guidedCreatingLease'->>'expiresAt' is not null
          and (
            (${videoGenerationsTable.options}->'guidedCreatingLease'->>'processInstanceId') is distinct from ${VIDEO_PROCESS_INSTANCE_ID}
            or (${videoGenerationsTable.options}->'guidedCreatingLease'->>'expiresAt')::timestamptz < now()
          )
        )
        or (
          ${videoGenerationsTable.options}->'guidedCreatingLease' is null
          and ${videoGenerationsTable.updatedAt} < ${cutoff}
        )
      )`,
    ));
    let settled = 0;
    for (const candidate of candidates) {
      const failed = await db.transaction(async (tx) => {
        const lease = candidate.options?.guidedCreatingLease;
        const [row] = await tx.update(videoGenerationsTable).set({
          status: "failed",
          error: guidedStoryCreatingInterruptedError(candidate.id),
          stage: null,
          updatedAt: new Date(),
        }).where(and(
          eq(videoGenerationsTable.id, candidate.id),
          eq(videoGenerationsTable.status, "creating"),
          lease
            ? sql`
                (${videoGenerationsTable.options}->'guidedCreatingLease'->>'owner') = ${lease.owner}
                and (${videoGenerationsTable.options}->'guidedCreatingLease'->>'expiresAt') = ${lease.expiresAt}
                and (
                  (${videoGenerationsTable.options}->'guidedCreatingLease'->>'processInstanceId') is distinct from ${VIDEO_PROCESS_INSTANCE_ID}
                  or (${videoGenerationsTable.options}->'guidedCreatingLease'->>'expiresAt')::timestamptz < now()
                )
              `
            : and(
                sql`${videoGenerationsTable.options}->'guidedCreatingLease' is null`,
                lt(videoGenerationsTable.updatedAt, cutoff),
              ),
        )).returning(SETTLE_COLUMNS);
        const draftId = candidate.options?.guidedStory?.draftId;
        if (!row || draftId == null) return row ?? null;
        const [draft] = await tx.select().from(guidedStoryDraftsTable).where(and(
          eq(guidedStoryDraftsTable.id, draftId),
          eq(guidedStoryDraftsTable.tenantId, candidate.tenantId),
        )).for("update").limit(1);
        if (draft?.state.storyboardJobId === candidate.id) {
          await tx.update(guidedStoryDraftsTable).set({
            state: {
              ...draft.state,
              cast: draft.state.cast.map((member) => ({
                ...member,
                consentGranted: false,
              })),
              storyboardJobId: null,
            },
            updatedAt: new Date(),
          }).where(and(
            eq(guidedStoryDraftsTable.id, draft.id),
            eq(guidedStoryDraftsTable.revision, draft.revision),
            sql`${guidedStoryDraftsTable.state}->>'storyboardJobId' = ${String(candidate.id)}`,
          ));
        }
        return row;
      });
      if (!failed) continue;
      // Current code cannot commit funding while retaining creating. This also
      // safely resolves any historical partially-funded row exactly once.
      await refundRow(failed, "guided story creation interrupted");
      settled += 1;
    }
    return settled;
  } catch (err) {
    logger.error({ err }, "Guided Story creation sweep failed");
    return 0;
  }
}

/** Recover every retry child abandoned in creating, including non-Atlas work. */
export async function sweepStrandedRetryCreations(): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - GUIDED_STORY_CREATING_TIMEOUT_MS);
    const candidates = await db.select().from(videoGenerationsTable).where(and(
      eq(videoGenerationsTable.status, "creating"),
      sql`${videoGenerationsTable.options}->'recovery' IS NOT NULL`,
      sql`(
        (
          ${videoGenerationsTable.options}->'recovery'->'creatingLease'->>'expiresAt' is not null
          and (${videoGenerationsTable.options}->'recovery'->'creatingLease'->>'expiresAt')::timestamptz < now()
        )
        or (
          ${videoGenerationsTable.options}->'recovery'->'creatingLease' is null
          and ${videoGenerationsTable.updatedAt} < ${cutoff}
        )
      )`,
    ));
    let settled = 0;
    for (const candidate of candidates) {
      const lease = candidate.options?.recovery?.creatingLease;
      const failed = await db.transaction(async (tx) => {
        const [row] = await tx.update(videoGenerationsTable).set({
          status: "failed",
          error: retryCreatingInterruptedError(candidate.id),
          stage: null,
          updatedAt: new Date(),
        }).where(and(
          eq(videoGenerationsTable.id, candidate.id),
          eq(videoGenerationsTable.status, "creating"),
          lease
            ? sql`
                (${videoGenerationsTable.options}->'recovery'->'creatingLease'->>'owner') = ${lease.owner}
                and (${videoGenerationsTable.options}->'recovery'->'creatingLease'->>'expiresAt') = ${lease.expiresAt}
                and (${videoGenerationsTable.options}->'recovery'->'creatingLease'->>'expiresAt')::timestamptz < now()
              `
            : and(
                sql`${videoGenerationsTable.options}->'recovery'->'creatingLease' is null`,
                lt(videoGenerationsTable.updatedAt, cutoff),
              ),
        )).returning(SETTLE_COLUMNS);
        const draftId = candidate.options?.guidedStory?.draftId;
        if (!row || draftId == null) return row ?? null;
        const [draft] = await tx.select().from(guidedStoryDraftsTable).where(and(
          eq(guidedStoryDraftsTable.id, draftId),
          eq(guidedStoryDraftsTable.tenantId, candidate.tenantId),
        )).for("update").limit(1);
        if (draft?.state.storyboardJobId === candidate.id) {
          await tx.update(guidedStoryDraftsTable).set({
            state: { ...draft.state, storyboardJobId: null },
            updatedAt: new Date(),
          }).where(and(
            eq(guidedStoryDraftsTable.id, draft.id),
            eq(guidedStoryDraftsTable.revision, draft.revision),
            sql`${guidedStoryDraftsTable.state}->>'storyboardJobId' = ${String(candidate.id)}`,
          ));
        }
        return row;
      });
      if (!failed) continue;
      await refundRow(failed, "retry creation interrupted");
      await db.update(videoGenerationsTable).set({
        options: sql`jsonb_set(${videoGenerationsTable.options}, '{recovery,fundingReleasedAt}', ${JSON.stringify(new Date().toISOString())}::jsonb)`,
        updatedAt: new Date(),
      }).where(and(
        eq(videoGenerationsTable.id, failed.id),
        eq(videoGenerationsTable.status, "failed"),
      ));
      settled += 1;
    }
    return settled;
  } catch (err) {
    logger.error({ err }, "Retry creation sweep failed");
    return 0;
  }
}

async function sweepOnce(): Promise<void> {
  await resumeQueuedFreshRestartJobs();
  await sweepStrandedFreshRestartCreations();
  await sweepStrandedRetryCreations();
  await sweepStrandedGuidedStoryCreations();
  await sweepExpiredStoryboards();
  await sweepStuckVideoJobs();
  await sweepGuidedAtlasBackdropAssets();
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
