import { db, imageGenerationsTable, tenantsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
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

    await db
      .update(imageGenerationsTable)
      .set({
        status: "succeeded",
        imagePath: outcome.imagePath,
        provider: outcome.meta.provider ?? null,
        model: outcome.meta.model ?? null,
        durationMs: outcome.meta.durationMs ?? Date.now() - startedAt,
        error: null,
      })
      .where(eq(imageGenerationsTable.id, jobId));

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
    await db
      .update(imageGenerationsTable)
      .set({
        status: "failed",
        error: message,
        durationMs: Date.now() - startedAt,
      })
      .where(eq(imageGenerationsTable.id, jobId))
      .catch(() => {});
    if (funding === "credit") {
      await refundCredits(job.tenantId, "image", 1, "image generation failed").catch(
        (err) => logger.error({ err, jobId }, "Failed to refund image credit"),
      );
    }
  }
}
