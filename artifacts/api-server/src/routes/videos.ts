import { Router, type IRouter, type Request, type Response } from "express";
import { db, tenantsTable, contentItemsTable, videoGenerationsTable } from "@workspace/db";
import { and, eq, desc } from "drizzle-orm";
import { GenerateVideoBody, SaveVideoToLibraryBody } from "@workspace/api-zod";
import { getPlanLimits } from "../lib/plans";
import { getUsage } from "../lib/usage";
import { spendCredit, refundCredits } from "../lib/credits";
import { enqueueBackgroundJob } from "../lib/backgroundJobs";
import { runVideoGenerationJob } from "../lib/videoGen/jobRunner";
import { MAX_SLIDESHOW_IMAGES } from "../lib/videoGen/slideshow";
import { serializeContent } from "../lib/serializers";
import type { VideoGeneration } from "@workspace/db";

const router: IRouter = Router();

/**
 * Video generation endpoints. Generation is long-running, so POST
 * /ai/generate-video only validates + reserves funding + creates a
 * video_generations row, then hands the heavy work to an in-process
 * background job. Clients poll GET /ai/video-jobs/{id} until the job settles.
 */

function serializeVideoJob(job: VideoGeneration) {
  return {
    id: job.id,
    engine: job.engine,
    status: job.status,
    prompt: job.prompt ?? null,
    sourceImagePaths: job.sourceImagePaths ?? [],
    aspectRatio: job.options?.aspectRatio ?? "9:16",
    videoPath: job.videoPath ?? null,
    thumbnailPath: job.thumbnailPath ?? null,
    provider: job.provider ?? null,
    model: job.model ?? null,
    error: job.error ?? null,
    durationMs: job.durationMs ?? null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

router.post("/ai/generate-video", async (req: Request, res: Response) => {
  const parsed = GenerateVideoBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const body = parsed.data;

  // Engine-specific input requirements, checked BEFORE any funding is
  // reserved so a bad request never burns quota.
  const sourceImagePaths = body.sourceImagePaths ?? [];
  if (body.engine === "text_to_video" && !body.prompt?.trim()) {
    res.status(400).json({ error: "A prompt is required for text-to-video." });
    return;
  }
  if (body.engine === "topic_to_video" && !body.prompt?.trim()) {
    res.status(400).json({ error: "A topic is required for topic-to-video." });
    return;
  }
  if (body.engine === "image_to_video" && sourceImagePaths.length === 0) {
    res.status(400).json({ error: "A source image is required for image-to-video." });
    return;
  }
  if (body.engine === "slideshow") {
    if (sourceImagePaths.length === 0) {
      res.status(400).json({ error: "At least one photo is required for a slideshow." });
      return;
    }
    if (sourceImagePaths.length > MAX_SLIDESHOW_IMAGES) {
      res.status(400).json({
        error: `A slideshow supports at most ${MAX_SLIDESHOW_IMAGES} photos.`,
      });
      return;
    }
  }
  // The tenant-scope prefix is asserted again at read time in the job runner;
  // rejecting early here gives a clear message instead of a failed job.
  for (const path of sourceImagePaths) {
    if (!path.startsWith(`/objects/${req.tenantId}/`)) {
      res.status(400).json({ error: "Invalid source image path." });
      return;
    }
  }
  if (body.musicPath && !body.musicPath.startsWith(`/objects/${req.tenantId}/`)) {
    res.status(400).json({ error: "Invalid music path." });
    return;
  }

  const tenant = (
    await db.select().from(tenantsTable).where(eq(tenantsTable.id, req.tenantId)).limit(1)
  )[0];
  if (!tenant) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // Fund like every metered generation: monthly plan quota first, then an
  // atomically reserved credit (refunded by the job runner on failure).
  const limits = await getPlanLimits(tenant.plan);
  const usage = await getUsage(req.tenantId);
  let funding: "quota" | "credit";
  if (limits.videos === -1 || usage.videos < limits.videos) {
    funding = "quota";
  } else if (await spendCredit(req.tenantId, "video")) {
    funding = "credit";
  } else {
    res.status(402).json({
      error:
        "Monthly video quota reached and no video credits left. Upgrade your plan or buy a credit pack.",
    });
    return;
  }

  const job = (
    await db
      .insert(videoGenerationsTable)
      .values({
        tenantId: req.tenantId,
        engine: body.engine,
        status: "queued",
        prompt: body.prompt?.trim() || null,
        sourceImagePaths,
        options: {
          aspectRatio: body.aspectRatio ?? "9:16",
          durationSec: body.durationSec ?? 5,
          slideDurationSec: body.slideDurationSec ?? 3,
          overlayText: body.overlayText ?? null,
          musicPath: body.musicPath ?? null,
          voice: body.voice ?? "alloy",
          stockSource: body.stockSource ?? "auto",
          subtitles: body.subtitles ?? true,
          paragraphCount: body.paragraphCount ?? 1,
        },
      })
      .returning()
  )[0]!;

  const accepted = enqueueBackgroundJob(() => runVideoGenerationJob(job.id, funding));
  if (!accepted) {
    // Shutdown in progress: undo everything and ask the client to retry.
    await db
      .update(videoGenerationsTable)
      .set({ status: "failed", error: "Server restarting; please retry." })
      .where(eq(videoGenerationsTable.id, job.id));
    if (funding === "credit") {
      await refundCredits(req.tenantId, "video", 1, "video enqueue rejected");
    }
    res.status(503).json({ error: "Server is restarting. Please retry in a moment." });
    return;
  }

  res.status(201).json(serializeVideoJob(job));
});

router.get("/ai/video-jobs", async (req: Request, res: Response) => {
  const rows = await db
    .select()
    .from(videoGenerationsTable)
    .where(eq(videoGenerationsTable.tenantId, req.tenantId))
    .orderBy(desc(videoGenerationsTable.createdAt), desc(videoGenerationsTable.id))
    .limit(30);
  res.json(rows.map(serializeVideoJob));
});

router.param("jobId", (req, res, next, value) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  next();
});

async function loadJob(req: Request): Promise<VideoGeneration | undefined> {
  return (
    await db
      .select()
      .from(videoGenerationsTable)
      .where(
        and(
          eq(videoGenerationsTable.id, Number(req.params.jobId)),
          eq(videoGenerationsTable.tenantId, req.tenantId),
        ),
      )
      .limit(1)
  )[0];
}

router.get("/ai/video-jobs/:jobId", async (req: Request, res: Response) => {
  const job = await loadJob(req);
  if (!job) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(serializeVideoJob(job));
});

/** Save a finished video into the content library as a draft item. */
router.post(
  "/ai/video-jobs/:jobId/save-to-library",
  async (req: Request, res: Response) => {
    const parsed = SaveVideoToLibraryBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const job = await loadJob(req);
    if (!job) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (job.status !== "succeeded" || !job.videoPath) {
      res.status(400).json({ error: "This video is not ready yet." });
      return;
    }
    const created = (
      await db
        .insert(contentItemsTable)
        .values({
          tenantId: req.tenantId,
          title: parsed.data.title,
          caption: parsed.data.caption ?? "",
          videoPath: job.videoPath,
          videoThumbnailPath: job.thumbnailPath,
          platform: parsed.data.platform ?? "instagram",
          contentType: "reel",
          status: "draft",
          brandKitId: parsed.data.brandKitId ?? null,
        })
        .returning()
    )[0]!;
    res.status(201).json(serializeContent(created));
  },
);

export default router;
