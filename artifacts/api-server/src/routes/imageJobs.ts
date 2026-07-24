import { Router, type IRouter, type Request, type Response } from "express";
import { db, tenantsTable, imageGenerationsTable, type ImageGeneration } from "@workspace/db";
import { and, eq, desc } from "drizzle-orm";
import { GenerateImageAsyncBody } from "@workspace/api-zod";
import { getPlanLimits } from "../lib/plans";
import { getUsage } from "../lib/usage";
import { spendCredit, refundCredits } from "../lib/credits";
import { enqueueBackgroundJob } from "../lib/backgroundJobs";
import { isFeatureEnabled } from "../lib/featureFlags";
import { runImageGenerationJob } from "../lib/imageJobs";

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
    provider: job.provider ?? null,
    model: job.model ?? null,
    error: job.error ?? null,
    durationMs: job.durationMs ?? null,
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

  const tenant = (
    await db.select().from(tenantsTable).where(eq(tenantsTable.id, req.tenantId)).limit(1)
  )[0];
  if (!tenant) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const limits = await getPlanLimits(tenant.plan);
  const usage = await getUsage(req.tenantId);
  let funding: "quota" | "credit";
  if (limits.images === -1 || usage.images < limits.images) {
    funding = "quota";
  } else if (await spendCredit(req.tenantId, "image", 1)) {
    funding = "credit";
  } else {
    res.status(402).json({
      error:
        "Monthly image quota reached and no image credits left. Upgrade your plan or buy a credit pack.",
    });
    return;
  }

  const job = (
    await db
      .insert(imageGenerationsTable)
      .values({
        tenantId: req.tenantId,
        status: "queued",
        prompt: body.prompt,
        size: body.size ?? "1024x1024",
        brandKitId: body.brandKitId ?? null,
        referenceImagePath: body.referenceImagePath ?? null,
        campaignId: body.campaignId ?? null,
        platform: body.platform ?? null,
      })
      .returning()
  )[0]!;

  const accepted = enqueueBackgroundJob(() => runImageGenerationJob(job.id, funding));
  if (!accepted) {
    // Shutdown in progress: undo everything and ask the client to retry.
    await db
      .update(imageGenerationsTable)
      .set({ status: "failed", error: "Server restarting; please retry." })
      .where(eq(imageGenerationsTable.id, job.id));
    if (funding === "credit") {
      await refundCredits(req.tenantId, "image", 1, "image enqueue rejected");
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

export default router;
