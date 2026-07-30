import { db, imageGenerationsTable, tenantsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { ImageGenNotConfiguredError, ImageGenProviderError } from "../imageGen";
import type { ImageSize } from "../imageGen";
import { recordUsage } from "../usage";
import { refundCredits } from "../credits";
import { settleWallet, refundWallet, reservationFromRow } from "../wallet";
import { logger } from "../logger";
import { renderLayeredImage } from "./render";
import { normalizeLayerPlan } from "./types";

/**
 * Runs one queued LAYERED image_generations row to completion.
 *
 * Deliberately a sibling of runImageGenerationJob rather than a branch inside
 * it: the two differ in what they render, what they persist, and how much
 * they refund, and the flat path is the one that runs thousands of times a
 * day. Everything that governs correctness — the atomic queued->processing
 * claim, the status-guarded terminal write, refund-exactly-once — is kept
 * identical on purpose, because the stuck-job sweep treats both the same.
 */
export async function runLayeredImageJob(
  jobId: number,
  funding: "quota" | "credit" | "wallet",
): Promise<void> {
  const job = (
    await db
      .update(imageGenerationsTable)
      .set({ status: "processing", stage: "Planning layers" })
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
  const units = Math.max(1, job.walletReservedUnits ?? 1);

  try {
    const tenant = (
      await db.select().from(tenantsTable).where(eq(tenantsTable.id, job.tenantId)).limit(1)
    )[0];
    if (!tenant) throw new Error("Workspace not found");

    const size = (["1024x1024", "1536x1024", "1024x1536"].includes(job.size)
      ? job.size
      : "1024x1024") as ImageSize;

    // Re-validated at read time, not trusted from the column: the row has sat
    // in the database since the request, and clamping here is cheap.
    const plan = normalizeLayerPlan(job.layerPlan, size);
    if (!plan) throw new Error("Stored layer plan is unusable");

    const outcome = await renderLayeredImage({
      tenantId: job.tenantId,
      tenant,
      plan,
      size,
      onProgress: async (stage) => {
        // Best-effort: a progress write that loses a race with the sweep must
        // never take the render down with it.
        await db
          .update(imageGenerationsTable)
          .set({ stage })
          .where(
            and(
              eq(imageGenerationsTable.id, jobId),
              eq(imageGenerationsTable.status, "processing"),
            ),
          )
          .catch((err) => logger.warn({ err, jobId }, "Failed to write layer job stage"));
      },
    });

    const settled = await db
      .update(imageGenerationsTable)
      .set({
        status: "succeeded",
        imagePath: outcome.imagePath,
        layerDoc: outcome.layerDoc as unknown as Record<string, unknown>,
        stage: null,
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
        "Layered image job finished after being swept as stuck; result discarded",
      );
      return;
    }

    const reservation = reservationFromRow(job);
    if (reservation) {
      await settleWallet(job.tenantId, reservation, {
        kind: "image",
        costPaise: outcome.meta.costPaise ?? null,
        provider: outcome.meta.provider ?? null,
        model: outcome.meta.model ?? null,
        inputTokens: outcome.meta.inputTokens ?? null,
        outputTokens: outcome.meta.outputTokens ?? null,
      }).catch((err) =>
        logger.error({ err, jobId }, "Failed to settle layered image wallet charge"),
      );
    }

    // One usage row per billed unit keeps the monthly image quota honest: the
    // user spent `units` images, and a single row would let a layered job cost
    // eight credits while counting as one against the plan.
    for (let i = 0; i < units; i += 1) {
      await recordUsage(job.tenantId, "image", {
        funding,
        ...outcome.meta,
        campaignId: job.campaignId ?? undefined,
        platform: job.platform ?? undefined,
        // Cost belongs to the job, not to each unit; attributing it once
        // stops the spend report from multiplying it by the layer count.
        ...(i === 0 ? {} : { costPaise: undefined, inputTokens: undefined, outputTokens: undefined }),
      });
    }
  } catch (error) {
    logger.error({ err: error, jobId }, "Layered image job failed");
    const message =
      error instanceof ImageGenNotConfiguredError || error instanceof ImageGenProviderError
        ? error.message
        : "Layered image generation failed. Please try again.";
    const failed = await db
      .update(imageGenerationsTable)
      .set({
        status: "failed",
        error: message,
        stage: null,
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
        logger.error({ err, jobId }, "Failed to persist layered image job failure");
        return [] as { id: number }[];
      });
    if (failed.length > 0) {
      const reservation = reservationFromRow(job);
      if (reservation) {
        await refundWallet(
          job.tenantId,
          reservation,
          "layered image generation failed",
        ).catch((err) =>
          logger.error({ err, jobId }, "Failed to refund layered image wallet"),
        );
      } else if (funding === "credit") {
        // `units`, not 1: a six-layer job reserved six credits.
        await refundCredits(
          job.tenantId,
          "image",
          units,
          "layered image generation failed",
        ).catch((err) =>
          logger.error({ err, jobId }, "Failed to refund layered image credits"),
        );
      }
    }
  }
}
