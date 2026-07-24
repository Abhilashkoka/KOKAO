import { db, imageGenerationsTable, tenantsTable } from "@workspace/db";
import { and, eq, inArray, lt } from "drizzle-orm";
import { performImageGeneration } from "./imageGeneration";
import type { ImageSize } from "./imageGen";
import { loadReferenceImage, ReferenceImageError } from "./referenceGuide";
import { ImageGenNotConfiguredError, ImageGenProviderError } from "./imageGen";
import { recordUsage } from "./usage";
import { refundCredits } from "./credits";
import { logger } from "./logger";

/**
 * Executes one queued image_generations row to completion, mirroring the
 * video job runner: the route reserved funding BEFORE enqueueing, so this
 * only settles — a usage row on success, a credit refund on failure. Every
 * outcome is persisted to the row; clients poll GET /ai/image-jobs/{id}.
 */
export async function runImageGenerationJob(
  jobId: number,
  funding: "quota" | "credit",
): Promise<void> {
  // Atomic claim: flip queued -> processing in one conditional UPDATE so a
  // double-enqueued job can never be processed (and charged) twice.
  const job = (
    await db
      .update(imageGenerationsTable)
      .set({ status: "processing" })
      .where(
        and(
          eq(imageGenerationsTable.id, jobId),
          eq(imageGenerationsTable.status, "queued"),
        ),
      )
      .returning()
  )[0];
  if (!job) return;
  const startedAt = Date.now();

  try {
    const tenant = (
      await db
        .select()
        .from(tenantsTable)
        .where(eq(tenantsTable.id, job.tenantId))
        .limit(1)
    )[0];
    if (!tenant) throw new Error("Workspace not found");

    // Reference image path was tenant-prefix-checked by the route; loading
    // re-asserts the tenant scope at read time.
    const referenceImage = job.referenceImagePath
      ? await loadReferenceImage(job.referenceImagePath, job.tenantId)
      : null;

    const outcome = await performImageGeneration({
      tenantId: job.tenantId,
      tenant,
      userPrompt: job.prompt,
      // The DB column is free-text; anything unexpected falls back to square.
      size: (["1024x1024", "1536x1024", "1024x1536"].includes(job.size)
        ? job.size
        : "1024x1024") as ImageSize,
      brandKitId: job.brandKitId ?? null,
      referenceImage,
    });

    // Status-guarded terminal write: if the stuck-job sweep failed this row
    // (and refunded any credit) while we were generating, do NOT resurrect it
    // to "succeeded" and do NOT record usage — that would double-settle.
    const settled = await db
      .update(imageGenerationsTable)
      .set({
        status: "succeeded",
        imagePath: outcome.imagePath,
        provider: outcome.meta.provider ?? null,
        model: outcome.meta.model ?? null,
        durationMs: outcome.meta.durationMs ?? Date.now() - startedAt,
        error: null,
      })
      .where(
        and(
          eq(imageGenerationsTable.id, jobId),
          eq(imageGenerationsTable.status, "processing"),
        ),
      )
      .returning({ id: imageGenerationsTable.id });
    if (settled.length === 0) {
      logger.warn(
        { jobId },
        "Image job finished after being swept as stuck; result discarded",
      );
      return;
    }

    await recordUsage(job.tenantId, "image", {
      funding,
      ...outcome.meta,
      campaignId: job.campaignId ?? undefined,
      platform: job.platform ?? undefined,
    });
  } catch (error) {
    logger.error({ err: error, jobId }, "Image generation job failed");
    const message =
      error instanceof ReferenceImageError ||
      error instanceof ImageGenNotConfiguredError ||
      error instanceof ImageGenProviderError
        ? error.message
        : "Image generation failed. Please try again.";
    // Status-guarded like the success path: only the writer that actually
    // flips the row out of "processing" may refund, so a job the sweep
    // already failed (and refunded) can never refund a second time.
    const failed = await db
      .update(imageGenerationsTable)
      .set({
        status: "failed",
        error: message,
        durationMs: Date.now() - startedAt,
      })
      .where(
        and(
          eq(imageGenerationsTable.id, jobId),
          eq(imageGenerationsTable.status, "processing"),
        ),
      )
      .returning({ id: imageGenerationsTable.id })
      .catch((err) => {
        logger.error({ err, jobId }, "Failed to persist image job failure");
        return [] as { id: number }[];
      });
    if (failed.length > 0 && funding === "credit") {
      await refundCredits(job.tenantId, "image", 1, "image generation failed").catch(
        (err) => logger.error({ err, jobId }, "Failed to refund image credit"),
      );
    }
  }
}

/** How often the sweep looks for abandoned image jobs. */
export const IMAGE_JOB_SWEEP_INTERVAL_MS = 60 * 1000;

/** Grace before the first sweep so boot-time work settles first. */
export const IMAGE_JOB_SWEEP_INITIAL_DELAY_MS = 20 * 1000;

/**
 * How long a row may sit in "queued" or "processing" before the sweep treats
 * it as orphaned by a crash/restart (the background job is in-process, so a
 * restart loses it). Comfortably longer than the slowest provider run.
 */
export const IMAGE_JOB_STUCK_TIMEOUT_MS = 10 * 60 * 1000;

/** Error stamped on image jobs orphaned by a restart. */
export const IMAGE_JOB_INTERRUPTED_ERROR =
  "Image generation was interrupted by a server restart. Please try again.";

/**
 * Fail out image_generations rows abandoned in "queued"/"processing" (the
 * in-process background job died with the server). The status flip is one
 * conditional UPDATE ... RETURNING, so each row is failed exactly once and
 * only the sweep pass that flipped it refunds its credit. Exported for tests;
 * never throws. Returns the number of rows it failed.
 */
export async function sweepStuckImageJobs(): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - IMAGE_JOB_STUCK_TIMEOUT_MS);
    const reclaimed = await db
      .update(imageGenerationsTable)
      .set({
        status: "failed",
        error: IMAGE_JOB_INTERRUPTED_ERROR,
        updatedAt: new Date(),
      })
      .where(
        and(
          inArray(imageGenerationsTable.status, ["queued", "processing"]),
          lt(imageGenerationsTable.updatedAt, cutoff),
        ),
      )
      .returning({
        id: imageGenerationsTable.id,
        tenantId: imageGenerationsTable.tenantId,
        funding: imageGenerationsTable.funding,
      });
    for (const row of reclaimed) {
      logger.warn(
        { jobId: row.id, tenantId: row.tenantId },
        "Failed abandoned image job stuck in queued/processing",
      );
      if (row.funding === "credit") {
        await refundCredits(
          row.tenantId,
          "image",
          1,
          "image job abandoned by restart",
        ).catch((err) =>
          logger.error(
            { err, jobId: row.id },
            "Failed to refund credit for abandoned image job",
          ),
        );
      }
    }
    return reclaimed.length;
  } catch (err) {
    logger.error({ err }, "Image job sweep failed");
    return 0;
  }
}

let sweepTimer: NodeJS.Timeout | null = null;
let sweepInitialTimer: NodeJS.Timeout | null = null;

/** Start the periodic stuck-job sweep. Safe to call once at boot; timers unref. */
export function startImageJobSweep(): void {
  if (sweepTimer || sweepInitialTimer) return;
  sweepInitialTimer = setTimeout(() => {
    sweepInitialTimer = null;
    void sweepStuckImageJobs();
    sweepTimer = setInterval(() => {
      void sweepStuckImageJobs();
    }, IMAGE_JOB_SWEEP_INTERVAL_MS);
    sweepTimer.unref();
  }, IMAGE_JOB_SWEEP_INITIAL_DELAY_MS);
  sweepInitialTimer.unref();
}

/** Stop the sweep (graceful shutdown). */
export function stopImageJobSweep(): void {
  if (sweepInitialTimer) {
    clearTimeout(sweepInitialTimer);
    sweepInitialTimer = null;
  }
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
