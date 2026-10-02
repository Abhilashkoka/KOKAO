import { db, tenantsTable, videoGenerationsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import type { RequestHandler } from "express";
import { freezeMeterFunding } from "./meterFunding";

export const FREE_VIDEO_MESSAGE =
  "Free accounts can make stock-footage videos only. Upgrade for AI video visuals. Your one-time credits can still be used for AI posts, images, scripts and narration.";

export const FREE_VIDEO_BILLING_MESSAGE =
  "Stock video creation requires credit billing for AI scripts and narration. Ask an administrator to enable credit billing for the Free plan. Stock visuals themselves are free.";

export class FreeVideoPolicyError extends Error {
  readonly status = 403;
  readonly code = "FREE_PLAN_STOCK_VIDEO_ONLY";
  constructor() {
    super(FREE_VIDEO_MESSAGE);
    this.name = "FreeVideoPolicyError";
  }
}

export async function isFreeVideoTenant(tenantId: number): Promise<boolean> {
  const [tenant] = await db.select({ plan: tenantsTable.plan }).from(tenantsTable)
    .where(eq(tenantsTable.id, tenantId)).limit(1);
  if (!tenant) throw new Error("Video account could not be verified.");
  return tenant.plan === "free";
}

/** Deliberately narrow: a saved template must not introduce hidden AI steps. */
export function isStockOnlyVideo(engine: string, options: Record<string, any> | null | undefined): boolean {
  return engine === "topic_to_video" &&
    (options?.visualsSource == null || options.visualsSource === "stock") &&
    !options?.guidedStory && !options?.guidedStoryDraftId &&
    !options?.characterDialogue && !options?.hybridStory &&
    !options?.templateId && !options?.templateSnapshot &&
    !options?.styleProfileId && !options?.planSource &&
    !options?.characterId && !options?.outfitId && !options?.presetCharacterId &&
    !options?.characterSnapshot && !options?.presetSnapshot &&
    !options?.studioLipSync?.enabled && !options?.studioLipSync?.requested && options?.studioLipSync !== true &&
    !options?.characterLipSync &&
    !options?.musicPrompt?.trim() &&
    !options?.referenceImages?.length &&
    !options?.suppliedPlan &&
    !options?.sourceImagePaths?.length;
}

/** Runs before route funding, including legacy retries and saved-draft mutations. */
export const enforceFreeVideoRoutes: RequestHandler = async (req, res, next) => {
  const mutation = ["POST", "PUT", "PATCH"].includes(req.method);
  if (!mutation || !(
    req.path === "/ai/generate-video" ||
    req.path.startsWith("/ai/guided-story/") ||
    req.path.startsWith("/ai/video-jobs/")
  )) return next();
  if (!(await isFreeVideoTenant(req.tenantId))) return next();

  let allowed = false;
  if (req.path === "/ai/generate-video") {
    allowed = isStockOnlyVideo(req.body?.engine, req.body);
  } else {
    const jobPath = req.path.match(/^\/ai\/video-jobs\/(\d+)\/(.+)$/);
    if (jobPath) {
      const action = jobPath[2];
      // Existing work remains viewable, downloadable, cancellable and may use
      // extracted/uploaded covers. Generating a cover is an AI visual operation.
      allowed = ["cancel", "cover", "cover-candidates"].includes(action);
      if (["retry", "restart", "repair"].includes(action)) {
        const [job] = await db.select().from(videoGenerationsTable).where(and(
          eq(videoGenerationsTable.id, Number(jobPath[1])),
          eq(videoGenerationsTable.tenantId, req.tenantId),
        )).limit(1);
        allowed = !!job?.options?.freeStockVideo &&
          isStockOnlyVideo(job.engine, job.options);
      }
    }
  }
  if (allowed) {
    if (req.path === "/ai/generate-video" || /\/(retry|restart|repair)$/.test(req.path)) {
      const funding = await freezeMeterFunding(req.tenantId);
      if (funding.rail !== "credits" || funding.mode !== "enforce") {
        res.status(503).json({ error: FREE_VIDEO_BILLING_MESSAGE, code: "FREE_VIDEO_CREDIT_BILLING_REQUIRED" });
        return;
      }
    }
    return next();
  }
  res.status(403).json({ error: FREE_VIDEO_MESSAGE, code: "FREE_PLAN_STOCK_VIDEO_ONLY" });
};

/** Provider-boundary backstop, checked even when billing is off or in shadow. */
export async function assertFreeVideoProviderAllowed(
  tenantId: number, key: string, refKind?: string | null,
): Promise<void> {
  const videoVisual = ["video", "video_hd", "lipsync"].includes(key);
  const imageInVideo = ["image", "image_edit"].includes(key) &&
    /video|guidedStory/i.test(refKind ?? "");
  if ((videoVisual || imageInVideo) && await isFreeVideoTenant(tenantId)) {
    throw new FreeVideoPolicyError();
  }
}