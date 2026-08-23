import { Router, type IRouter, type Request, type Response } from "express";
import { db, tenantsTable, videoStyleProfilesTable } from "@workspace/db";
import type { VideoStyleProfile } from "@workspace/db";
import { and, eq, asc } from "drizzle-orm";
import { AnalyzeVideoStyleBody } from "@workspace/api-zod";
import { getPlanLimits } from "../lib/plans";
import { getUsage, recordUsage } from "../lib/usage";
import { spendCredit, refundCredits } from "../lib/credits";
import {
  isWalletFunded,
  reserveWallet,
  settleWalletDurably,
  refundWallet,
  type WalletReservation,
} from "../lib/wallet";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import {
  analyzeReferenceVideo,
  ReferenceAnalysisError,
} from "../lib/videoGen/referenceAnalyzer";
import { TextGenNotConfiguredError } from "../lib/textGen";

const router: IRouter = Router();

/**
 * Video style profiles: "make one like this" as a saved, reusable setting.
 *
 * A tenant uploads a reference video, we analyze its structure once (transcript
 * + sampled frames → one vision call) and store the description. Topic videos
 * can then be generated against a profile instead of the user re-describing
 * the pacing they want every time.
 *
 * Analysis costs one caption unit: it is a single text-model completion, the
 * same shape of call the caption endpoints meter. References are uploads only —
 * there is no URL ingestion, so nothing is ever fetched from a third-party host.
 */

/** Per-tenant cap: profiles are curated presets, not a media library. */
export const MAX_STYLE_PROFILES = 8;

/** Reference uploads: generous enough for a 3-minute phone export. */
const MAX_REFERENCE_BYTES = 200 * 1024 * 1024;

const objectStorageService = new ObjectStorageService();

function serializeProfile(profile: VideoStyleProfile) {
  return {
    id: profile.id,
    name: profile.name,
    sourceVideoPath: profile.sourceVideoPath,
    payload: profile.payload,
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  };
}

interface Funding {
  source: "quota" | "credit" | "wallet";
  reservation?: WalletReservation;
}

/** Reserve caption funding on whichever rail this workspace is on. */
async function reserveCaptionFunding(tenantId: number, plan: string): Promise<Funding | null> {
  if (await isWalletFunded(tenantId)) {
    const reservation = await reserveWallet(tenantId, "caption");
    return reservation ? { source: "wallet", reservation } : null;
  }
  const limits = await getPlanLimits(plan);
  const usage = await getUsage(tenantId);
  if (limits.captions === -1 || usage.captions < limits.captions) return { source: "quota" };
  if (await spendCredit(tenantId, "caption")) return { source: "credit" };
  return null;
}

async function releaseCaptionFunding(req: Request, funding: Funding): Promise<void> {
  if (funding.source === "wallet" && funding.reservation) {
    await refundWallet(
      req.tenantId,
      funding.reservation,
      "reference video analysis failed",
    ).catch((err) => req.log.error({ err }, "Failed to refund style analysis wallet"));
    return;
  }
  if (funding.source !== "credit") return;
  await refundCredits(req.tenantId, "caption", 1, "reference video analysis failed").catch(
    (err) => req.log.error({ err }, "Failed to refund style analysis credit"),
  );
}

router.get("/ai/video-styles", async (req: Request, res: Response) => {
  const profiles = await db
    .select()
    .from(videoStyleProfilesTable)
    .where(eq(videoStyleProfilesTable.tenantId, req.tenantId))
    .orderBy(asc(videoStyleProfilesTable.id));
  res.json(profiles.map(serializeProfile));
});

router.post("/ai/video-styles", async (req: Request, res: Response) => {
  const parsed = AnalyzeVideoStyleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const name = parsed.data.name.trim();
  const sourceVideoPath = parsed.data.sourceVideoPath;
  if (!name) {
    res.status(400).json({ error: "Give this style a name." });
    return;
  }
  // The tenant prefix is asserted again by the storage layer below; rejecting
  // here gives a clear message instead of a confusing 404.
  if (!sourceVideoPath.startsWith(`/objects/${req.tenantId}/`)) {
    res.status(400).json({ error: "Invalid reference video path." });
    return;
  }

  const existing = await db
    .select({ id: videoStyleProfilesTable.id })
    .from(videoStyleProfilesTable)
    .where(eq(videoStyleProfilesTable.tenantId, req.tenantId));
  if (existing.length >= MAX_STYLE_PROFILES) {
    res.status(400).json({
      error: `You can save up to ${MAX_STYLE_PROFILES} styles. Delete one to add another.`,
    });
    return;
  }

  const tenant = (
    await db.select().from(tenantsTable).where(eq(tenantsTable.id, req.tenantId)).limit(1)
  )[0];
  if (!tenant) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // Load the upload BEFORE funding so a bad path never burns a unit.
  let videoBytes: Buffer;
  try {
    const file = await objectStorageService.getObjectEntityFile(sourceVideoPath, req.tenantId);
    const [metadata] = await file.getMetadata();
    if (Number(metadata.size ?? 0) > MAX_REFERENCE_BYTES) {
      res.status(400).json({
        error: `That video is too large (max ${Math.round(MAX_REFERENCE_BYTES / (1024 * 1024))} MB).`,
      });
      return;
    }
    [videoBytes] = await file.download();
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      res.status(400).json({ error: "That reference video could not be found." });
      return;
    }
    throw err;
  }

  const funding = await reserveCaptionFunding(req.tenantId, tenant.plan);
  if (!funding) {
    res.status(402).json({
      error:
        "Monthly caption quota reached and no caption credits left. Upgrade your plan or buy a credit pack.",
    });
    return;
  }

  const startedAt = Date.now();
  let payload;
  try {
    payload = await analyzeReferenceVideo({
      videoBytes,
      tenantAiModel: tenant.aiModel,
    });
  } catch (err) {
    await releaseCaptionFunding(req, funding);
    if (err instanceof ReferenceAnalysisError) {
      res.status(422).json({ error: err.message });
      return;
    }
    if (err instanceof TextGenNotConfiguredError) {
      res.status(503).json({
        error: "AI text generation is not configured. Contact your admin.",
      });
      return;
    }
    req.log.error({ err }, "Reference video analysis failed");
    res.status(502).json({ error: "Analyzing that video failed. Please try again." });
    return;
  }

  if (funding.source === "wallet" && funding.reservation) {
    // The analysis helper does not surface a provider cost, so this settles
    // at the admin display rate (flagged `estimated`) rather than free.
    await settleWalletDurably(req.tenantId, funding.reservation, {
      kind: "caption",
      costPaise: null,
      provider: "video-style-analysis",
      model: tenant.aiModel,
    }).catch((err) =>
      req.log.error({ err }, "Failed to settle style analysis wallet charge"),
    );
  }
  await recordUsage(req.tenantId, "caption", {
    durationMs: Date.now() - startedAt,
    responseBytes: JSON.stringify(payload).length,
    model: tenant.aiModel,
    provider: "video-style-analysis",
    funding: funding.source,
  }).catch((err) =>
    req.log.error({ err }, "Failed to record style analysis usage after successful work"),
  );

  // Re-check the cap under a tenant row lock so parallel analyses cannot both
  // slip past the count check. The analysis is already paid for either way.
  const created = await db.transaction(async (tx) => {
    await tx
      .select({ id: tenantsTable.id })
      .from(tenantsTable)
      .where(eq(tenantsTable.id, req.tenantId))
      .for("update");
    const count = await tx
      .select({ id: videoStyleProfilesTable.id })
      .from(videoStyleProfilesTable)
      .where(eq(videoStyleProfilesTable.tenantId, req.tenantId));
    if (count.length >= MAX_STYLE_PROFILES) return null;
    return (
      await tx
        .insert(videoStyleProfilesTable)
        .values({ tenantId: req.tenantId, name, sourceVideoPath, payload })
        .returning()
    )[0]!;
  });
  if (!created) {
    res.status(400).json({
      error: `You can save up to ${MAX_STYLE_PROFILES} styles. Delete one to add another.`,
    });
    return;
  }
  res.status(201).json(serializeProfile(created));
});

router.delete("/ai/video-styles/:styleId", async (req: Request, res: Response) => {
  const styleId = Number(req.params.styleId);
  if (!Number.isInteger(styleId) || styleId <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const deleted = await db
    .delete(videoStyleProfilesTable)
    .where(
      and(
        eq(videoStyleProfilesTable.id, styleId),
        eq(videoStyleProfilesTable.tenantId, req.tenantId),
      ),
    )
    .returning({ id: videoStyleProfilesTable.id });
  if (deleted.length === 0) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(204).end();
});

export default router;
