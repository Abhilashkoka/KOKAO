import { Router, type IRouter, type Request, type Response } from "express";
import { db, tenantsTable, imageGenerationsTable, type ImageGeneration } from "@workspace/db";
import { and, eq, desc } from "drizzle-orm";
import { GenerateImageAsyncBody } from "@workspace/api-zod";
import { normalizeLayerPlan, planUnits } from "../lib/imageLayers/types";
import { runLayeredImageJob } from "../lib/imageLayers/job";
import { compileImagePrompt } from "../lib/imageGen/promptCompiler";
import { getPlanLimits } from "../lib/plans";
import { getUsage } from "../lib/usage";
import { spendCredit, refundCredits } from "../lib/credits";
import {
  isWalletFunded,
  reserveWallet,
  refundWallet,
  reservationFromRow,
  type WalletReservation,
} from "../lib/wallet";
import { enqueueBackgroundJob } from "../lib/backgroundJobs";
import { isFeatureEnabled } from "../lib/featureFlags";
import { runImageGenerationJob } from "../lib/imageJobs";
import type { ImageSize } from "../lib/imageGen";

const router: IRouter = Router();

/**
 * Async image generation, mirroring the video-jobs pattern: POST
 * /ai/generate-image-async validates + reserves funding + inserts an
 * image_generations row, then hands the heavy work to an in-process
 * background job. Clients poll GET /ai/image-jobs/{id} until the job
 * settles. Funding rules are identical to the synchronous route (plan quota
 * first, then an atomically reserved credit; the runner refunds on failure).
 */

function serializeImageJob(job: ImageGeneration) {
  return {
    id: job.id,
    status: job.status,
    prompt: job.prompt,
    size: job.size,
    brandKitId: job.brandKitId ?? null,
    campaignId: job.campaignId ?? null,
    platform: job.platform ?? null,
    imagePath: job.imagePath ?? null,
    layered: job.layered,
    layerDoc: job.layerDoc ?? null,
    stage: job.stage ?? null,
    provider: job.provider ?? null,
    model: job.model ?? null,
    error: job.error ?? null,
    durationMs: job.durationMs ?? null,
    spendPaise: job.spendPaise ?? null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

router.post("/ai/generate-image-async", async (req: Request, res: Response) => {
  const parsed = GenerateImageAsyncBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const body = parsed.data;

  // Reference-image checks happen BEFORE funding so a bad request never
  // burns quota; the runner re-asserts the tenant prefix at read time.
  if (body.referenceImagePath) {
    if (!(await isFeatureEnabled("referenceImages"))) {
      res.status(403).json({
        error: "Reference images are currently disabled by the administrator.",
        code: "feature_disabled",
      });
      return;
    }
    if (!body.referenceImagePath.startsWith(`/objects/${req.tenantId}/`)) {
      res.status(400).json({ error: "Invalid reference image path." });
      return;
    }
  }

  const size = (body.size ?? "1024x1024") as ImageSize;

  // Layered generation bills one image per layer, so the plan is resolved and
  // capped BEFORE funding: the number reserved here has to be the number the
  // client was quoted by POST /ai/layer-plan.
  let layerPlan: ReturnType<typeof normalizeLayerPlan> = null;
  if (body.layered) {
    if (!(await isFeatureEnabled("layeredImages").catch(() => true))) {
      res.status(403).json({
        error: "Layered images are currently disabled by the administrator.",
        code: "feature_disabled",
      });
      return;
    }
    layerPlan = normalizeLayerPlan(body.layerPlan, size);
    if (!layerPlan) {
      res.status(400).json({
        error: "Send the layer plan returned by /ai/layer-plan to generate a layered image.",
      });
      return;
    }
  }
  const units = layerPlan ? planUnits(layerPlan) : 1;

  const tenant = (
    await db.select().from(tenantsTable).where(eq(tenantsTable.id, req.tenantId)).limit(1)
  )[0];
  if (!tenant) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const limits = await getPlanLimits(tenant.plan);
  const usage = await getUsage(req.tenantId);
  // The reservation is persisted on the job row: the runner settles it to the
  // real provider cost minutes later, long after this request is gone.
  let funding: "quota" | "credit" | "wallet";
  let reservation: WalletReservation | null = null;
  if (await isWalletFunded(req.tenantId)) {
    reservation = await reserveWallet(req.tenantId, "image", {}, units);
    if (!reservation) {
      res.status(402).json({
        error:
          units > 1
            ? `This layered image needs ${units} generations (one per layer) and your wallet balance can't cover it. Recharge to continue.`
            : "Your wallet balance can't cover this image. Recharge to continue.",
      });
      return;
    }
    funding = "wallet";
  } else if (limits.images === -1 || usage.images + units <= limits.images) {
    funding = "quota";
  } else if (await spendCredit(req.tenantId, "image", units)) {
    funding = "credit";
  } else {
    res.status(402).json({
      error:
        units > 1
          ? `This layered image needs ${units} generations (one per layer) and your remaining quota and credits can't cover it. Generate it as a flat image, use fewer layers, or top up.`
          : "Monthly image quota reached and no image credits left. Upgrade your plan or buy a credit pack.",
    });
    return;
  }

  // The funding reservation above is only made whole by the runner (settle) or
  // the failure paths below (refund). If the row insert itself throws, nothing
  // would ever settle it — so any insert-time failure must refund immediately.
  let job;
  try {
    job = (
      await db
        .insert(imageGenerationsTable)
        .values({
        tenantId: req.tenantId,
        status: "queued",
        funding,
        walletReservationId: reservation?.id ?? null,
        walletReservedPaise: reservation?.amountPaise ?? null,
        walletReservedUnits: units,
        layered: layerPlan !== null,
        layerPlan: layerPlan as unknown as Record<string, unknown> | null,
        // Compiled here, not in the runner: the stored prompt is what the
        // gallery shows and what a re-run sends back, so it has to be the
        // finished text rather than a brief plus a recipe the runner ate.
        prompt: compileImagePrompt(
          body.prompt,
          // Kill switch: when Image Look Presets is off, the recipe is dropped.
          (await isFeatureEnabled("imageLooks").catch(() => true))
            ? body.promptRecipe
            : undefined,
        ),
        size,
        brandKitId: body.brandKitId ?? null,
        referenceImagePath: body.referenceImagePath ?? null,
        campaignId: body.campaignId ?? null,
        platform: body.platform ?? null,
      })
        .returning()
    )[0]!;
  } catch (error) {
    if (reservation) {
      await refundWallet(req.tenantId, reservation, "image job insert failed");
    } else if (funding === "credit") {
      await refundCredits(req.tenantId, "image", units, "image job insert failed");
    }
    req.log.error({ err: error }, "Failed to create image generation job");
    res.status(500).json({ error: "Failed to start the image generation. You have not been charged." });
    return;
  }

  const accepted = enqueueBackgroundJob(() =>
    layerPlan ? runLayeredImageJob(job.id, funding) : runImageGenerationJob(job.id, funding),
  );
  if (!accepted) {
    // Shutdown in progress: undo everything and ask the client to retry.
    await db
      .update(imageGenerationsTable)
      .set({ status: "failed", error: "Server restarting; please retry." })
      .where(eq(imageGenerationsTable.id, job.id));
    if (reservation) {
      await refundWallet(req.tenantId, reservation, "image enqueue rejected");
    } else if (funding === "credit") {
      await refundCredits(req.tenantId, "image", units, "image enqueue rejected");
    }
    res.status(503).json({ error: "Server is restarting. Please retry in a moment." });
    return;
  }

  res.status(201).json(serializeImageJob(job));
});

router.get("/ai/image-jobs", async (req: Request, res: Response) => {
  const rows = await db
    .select()
    .from(imageGenerationsTable)
    .where(eq(imageGenerationsTable.tenantId, req.tenantId))
    .orderBy(desc(imageGenerationsTable.createdAt), desc(imageGenerationsTable.id))
    .limit(30);
  res.json(rows.map(serializeImageJob));
});

router.get("/ai/image-jobs/:jobId", async (req: Request, res: Response) => {
  const id = Number(req.params.jobId);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const job = (
    await db
      .select()
      .from(imageGenerationsTable)
      .where(
        and(
          eq(imageGenerationsTable.id, id),
          eq(imageGenerationsTable.tenantId, req.tenantId),
        ),
      )
      .limit(1)
  )[0];
  if (!job) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(serializeImageJob(job));
});

/**
 * Cancel a still-queued job. The conditional queued->cancelled UPDATE is the
 * same atomic guard the runner uses for its queued->processing claim, so a
 * job can never be both cancelled and executed: whichever flip lands first
 * wins. Refunds the reserved credit when the job was credit-funded (quota
 * funding is only metered on success, so there is nothing to refund).
 */
router.post("/ai/image-jobs/:jobId/cancel", async (req: Request, res: Response) => {
  const id = Number(req.params.jobId);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  // The status flip and the credit refund share one transaction so a job can
  // never end up cancelled without its refund (or vice versa).
  let cancelledReservation: WalletReservation | null = null;
  const cancelled = await db.transaction(async (tx) => {
    const row = (
      await tx
        .update(imageGenerationsTable)
        .set({ status: "cancelled", error: null })
        .where(
          and(
            eq(imageGenerationsTable.id, id),
            eq(imageGenerationsTable.tenantId, req.tenantId),
            eq(imageGenerationsTable.status, "queued"),
          ),
        )
        .returning()
    )[0];
    if (row) {
      const held = reservationFromRow(row);
      if (held) {
        // The wallet refund runs on its own connection rather than `tx`, so
        // it is issued only after the cancel has actually committed (below).
        cancelledReservation = held;
      } else if (row.funding === "credit") {
        await refundCredits(
          req.tenantId,
          "image",
          Math.max(1, row.walletReservedUnits ?? 1),
          "image job cancelled",
          tx,
        );
      }
    }
    return row;
  });
  if (cancelled) {
    if (cancelledReservation) {
      await refundWallet(
        req.tenantId,
        cancelledReservation,
        "image job cancelled",
      ).catch((error) =>
        req.log.error({ err: error, jobId: id }, "Failed to refund cancelled image job"),
      );
    }
    res.json(serializeImageJob(cancelled));
    return;
  }
  const existing = (
    await db
      .select()
      .from(imageGenerationsTable)
      .where(
        and(
          eq(imageGenerationsTable.id, id),
          eq(imageGenerationsTable.tenantId, req.tenantId),
        ),
      )
      .limit(1)
  )[0];
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(409).json({
    error:
      existing.status === "processing"
        ? "This job has already started and can no longer be cancelled."
        : "This job has already finished.",
  });
});

export default router;
