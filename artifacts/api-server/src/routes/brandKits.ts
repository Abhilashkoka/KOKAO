import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  tenantsTable,
  brandAssetsTable,
  brandKitsTable,
  brandKitVersionsTable,
  type BrandKitPayload,
  type BrandVoiceEntry,
} from "@workspace/db";
import { randomUUID } from "node:crypto";
import { and, eq, desc } from "drizzle-orm";
import {
  CreateBrandKitBody,
  UpdateBrandKitBody,
  CreateBrandKitVersionBody,
  ActivateBrandKitVersionBody,
  DraftBrandKitBody,
  ResolveBrandSelectionBody,
  CreateBrandAssetBody,
  CloneBrandVoiceBody,
  SelectBrandVoiceBody,
  PreviewBrandVoiceBody,
  PreviewStockBrandVoiceBody,
  CreateBrandVoiceAudioBody,
  CheckBrandVoiceSampleBody,
  DeleteBrandVoiceSampleBody,
  DeleteBrandVoiceExtractedSampleBody,
} from "@workspace/api-zod";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { isFeatureEnabled, requireFeature } from "../lib/featureFlags";
import {
  cloneBrandVoice,
  buildBrandVoiceTtsOperationKey,
  speakWithClonedVoice,
  deleteClonedVoiceQuietly,
  isVoiceCloningConfigured,
  getSelectedVoiceCloneProviderId,
  VoiceCloneNotConfiguredError,
  VoiceCloneError,
  isConfirmedVoiceCloneFailure,
  type ClonedVoiceRef,
} from "../lib/voiceClone";
import {
  isWalletFunded,
  reserveWallet,
  settleWalletDurably,
  refundWallet,
  executeWalletProviderOperation,
  settleWalletProviderOperationDurably,
  WalletProviderSuccessPersistenceError,
  WalletProviderPostSuccessError,
  type WalletReservation,
} from "../lib/wallet";
import { recordUsage } from "../lib/usage";
import {
  listKits,
  getKitDetail,
  createKit,
  loadKit,
  addVersion,
  activateVersion,
  setDefault,
  deleteKit,
  serializeVersion,
  serializeAsset,
  loadActivePayload,
  PlanLimitError,
  BrandInputError,
} from "../lib/brandKit/service";
import { resolveSelection } from "../lib/brandKit/selection";
import { draftBrandKit } from "../lib/brandKit/draft";
import { resolveAiModel } from "../lib/aiModels";
import {
  analyzeVoiceSampleBuffer,
  measureVoiceSampleDurationMs,
} from "../lib/voiceSampleAnalysis";
import { computeTtsCostPaise, computeVoiceCloneCostPaise } from "../lib/aiCost";
import {
  BaseVideoAudioExtractionError,
  extractVoiceSampleFromVideo,
} from "../lib/baseVideoAudio";
import {
  adoptBrandVoiceExtractedSample,
  claimBrandVoiceExtractedSample,
  deleteBrandVoiceExtractedSample,
  discardClaimedBrandVoiceExtractedSample,
  isBrandVoiceExtractedSamplePath,
  registerBrandVoiceExtractedSample,
  releaseBrandVoiceExtractedSampleClaim,
} from "../lib/brandVoiceExtractedSamples";
import {
  synthesizeNarration,
  type NarrationVoice,
} from "../lib/videoGen/topicVideo/narration";
import { VideoGenProviderError } from "../lib/videoGen/types";

const router: IRouter = Router();

/** A provider operation acknowledged paid work, even if local handling failed. */
function successfulProviderOperationId(error: unknown): number | null {
  if (
    error instanceof WalletProviderSuccessPersistenceError ||
    error instanceof WalletProviderPostSuccessError
  ) {
    return error.operationId;
  }
  return null;
}

async function loadTenant(tenantId: number) {
  const row = (
    await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId)).limit(1)
  )[0];
  // Legacy rows may store a retired model name; fall back to a supported one.
  return row ? { ...row, aiModel: resolveAiModel(row.aiModel) } : row;
}

function assetIdParam(req: Request, res: Response): number | null {
  const id = Number(req.params.assetId);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid asset id" });
    return null;
  }
  return id;
}

router.param("id", (req, res, next, value) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  next();
});

// --- Collection ---

router.get("/brand-kits", async (req: Request, res: Response) => {
  const includeArchived = req.query.includeArchived === "true";
  const kits = await listKits(req.tenantId, includeArchived);
  res.json(kits);
});

router.post("/brand-kits", async (req: Request, res: Response) => {
  const parsed = CreateBrandKitBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const tenant = await loadTenant(req.tenantId);
  if (!tenant) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const detail = await createKit({
      tenantId: req.tenantId,
      plan: tenant.plan,
      createdBy: tenant.clerkUserId,
      name: parsed.data.name,
      slug: parsed.data.slug,
      brandType: parsed.data.brandType,
      isDefault: parsed.data.isDefault,
      payload: (parsed.data.payload as BrandKitPayload | null | undefined) ?? null,
    });
    res.status(201).json(detail);
  } catch (error) {
    if (error instanceof PlanLimitError) {
      res.status(402).json({ error: error.message });
      return;
    }
    req.log.error({ err: error }, "Brand kit creation failed");
    res.status(500).json({ error: "Failed to create brand kit" });
  }
});

// --- Static sub-routes (must precede /:id where they could collide) ---

router.post("/brand-kits/resolve-selection", async (req: Request, res: Response) => {
  const parsed = ResolveBrandSelectionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const result = await resolveSelection(req.tenantId, parsed.data);
  res.json(result);
});

router.post("/brand-kits/draft", async (req: Request, res: Response) => {
  const parsed = DraftBrandKitBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const tenant = await loadTenant(req.tenantId);
  if (!tenant) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const draft = await draftBrandKit(tenant.aiModel, parsed.data);
  res.json(draft);
});

// --- Single kit ---

router.get("/brand-kits/:id", async (req: Request, res: Response) => {
  const detail = await getKitDetail(req.tenantId, Number(req.params.id));
  if (!detail) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(detail);
});

router.patch("/brand-kits/:id", async (req: Request, res: Response) => {
  const parsed = UpdateBrandKitBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const id = Number(req.params.id);
  const kit = await loadKit(req.tenantId, id);
  if (!kit) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (parsed.data.name !== undefined) patch.name = parsed.data.name;
  if (parsed.data.brandType !== undefined) patch.brandType = parsed.data.brandType;
  if (parsed.data.isArchived !== undefined) patch.isArchived = parsed.data.isArchived;
  await db
    .update(brandKitsTable)
    .set(patch)
    .where(and(eq(brandKitsTable.id, id), eq(brandKitsTable.tenantId, req.tenantId)));
  const detail = await getKitDetail(req.tenantId, id);
  res.json(detail);
});

router.delete("/brand-kits/:id", async (req: Request, res: Response) => {
  const ok = await deleteKit(req.tenantId, Number(req.params.id));
  if (!ok) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(204).end();
});

// --- Versions ---

router.get("/brand-kits/:id/versions", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const kit = await loadKit(req.tenantId, id);
  if (!kit) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const versions = await db
    .select()
    .from(brandKitVersionsTable)
    .where(
      and(
        eq(brandKitVersionsTable.brandKitId, id),
        eq(brandKitVersionsTable.tenantId, req.tenantId),
      ),
    )
    .orderBy(desc(brandKitVersionsTable.versionNumber));
  res.json(versions.map(serializeVersion));
});

router.post("/brand-kits/:id/versions", async (req: Request, res: Response) => {
  const parsed = CreateBrandKitVersionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const tenant = await loadTenant(req.tenantId);
  if (!tenant) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const detail = await addVersion({
    tenantId: req.tenantId,
    brandKitId: Number(req.params.id),
    createdBy: tenant.clerkUserId,
    payload: parsed.data.payload as BrandKitPayload,
    sourceType: parsed.data.sourceType,
    sourceNotes: parsed.data.sourceNotes ?? null,
    approvalStatus: parsed.data.approvalStatus,
    activate: parsed.data.activate,
  });
  if (!detail) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(201).json(detail);
});

router.post("/brand-kits/:id/activate-version", async (req: Request, res: Response) => {
  const parsed = ActivateBrandKitVersionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  try {
    const detail = await activateVersion(
      req.tenantId,
      Number(req.params.id),
      parsed.data.versionId,
    );
    if (!detail) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(detail);
  } catch (error) {
    if (error instanceof BrandInputError) {
      res.status(400).json({ error: error.message });
      return;
    }
    throw error;
  }
});

router.post("/brand-kits/:id/set-default", async (req: Request, res: Response) => {
  const detail = await setDefault(req.tenantId, Number(req.params.id));
  if (!detail) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(detail);
});

// --- Assets ---

router.get("/brand-kits/:id/assets", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const kit = await loadKit(req.tenantId, id);
  if (!kit) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const assets = await db
    .select()
    .from(brandAssetsTable)
    .where(
      and(
        eq(brandAssetsTable.brandKitId, id),
        eq(brandAssetsTable.tenantId, req.tenantId),
      ),
    )
    .orderBy(desc(brandAssetsTable.createdAt));
  res.json(assets.map(serializeAsset));
});

router.post("/brand-kits/:id/assets", async (req: Request, res: Response) => {
  const parsed = CreateBrandAssetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const id = Number(req.params.id);
  const kit = await loadKit(req.tenantId, id);
  if (!kit) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const created = (
    await db
      .insert(brandAssetsTable)
      .values({
        tenantId: req.tenantId,
        brandKitId: id,
        assetType: parsed.data.assetType,
        fileUrl: parsed.data.fileUrl,
        mimeType: parsed.data.mimeType ?? null,
        label: parsed.data.label ?? null,
      })
      .returning()
  )[0]!;
  res.status(201).json(serializeAsset(created));
});

router.delete("/brand-kits/:id/assets/:assetId", async (req: Request, res: Response) => {
  const assetId = assetIdParam(req, res);
  if (assetId === null) return;
  const deleted = (
    await db
      .delete(brandAssetsTable)
      .where(
        and(
          eq(brandAssetsTable.id, assetId),
          eq(brandAssetsTable.brandKitId, Number(req.params.id)),
          eq(brandAssetsTable.tenantId, req.tenantId),
        ),
      )
      .returning()
  )[0];
  if (!deleted) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(204).end();
});

// --- Brand Voice (cloned narration voice) ---

const objectStorageService = new ObjectStorageService();
/** Reference samples are short (~30-60s); 15 MB covers even uncompressed WAV. */
const MAX_VOICE_SAMPLE_BYTES = 15 * 1024 * 1024;
const MAX_BASE_VIDEO_BYTES = 100 * 1024 * 1024;
const BASE_VIDEO_CONTENT_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);
const DEFAULT_PREVIEW_TEXT =
  "Hi there! This is your new brand voice. Every video you create from now on can sound exactly like this.";
const DEFAULT_STOCK_PREVIEW_TEXT =
  "Hi there! This is a preview of your selected stock voice. You can use this voice to narrate your videos.";

/** The kit's active payload, or a 409 when the kit has no version yet. */
async function requireActivePayload(
  req: Request,
  res: Response,
): Promise<{ kitId: number; payload: BrandKitPayload; createdBy: string } | null> {
  const kitId = Number(req.params.id);
  const kit = await loadKit(req.tenantId, kitId);
  if (!kit) {
    res.status(404).json({ error: "Not found" });
    return null;
  }
  const active = await loadActivePayload(req.tenantId, kitId);
  if (!active) {
    res.status(409).json({ error: "This brand kit has no version to attach a voice to yet." });
    return null;
  }
  const tenant = await loadTenant(req.tenantId);
  if (!tenant) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  return { kitId, payload: active.payload, createdBy: tenant.clerkUserId };
}

/** Deep-clone the payload so a new version never aliases the stored one. */
function clonePayload(payload: BrandKitPayload): BrandKitPayload {
  return JSON.parse(JSON.stringify(payload)) as BrandKitPayload;
}

/** The kit can keep this many saved cloned voices — each is a live provider clone. */
const MAX_VOICE_LIBRARY = 5;

/**
 * The kit's saved-voice library. Kits cloned before the library existed have
 * only the flat active-voice fields, so those synthesize a one-entry library —
 * this keeps every legacy kit's voice selectable/deletable like a saved one.
 */
function voiceLibrary(bv: BrandKitPayload["brand_voice"]): BrandVoiceEntry[] {
  if (!bv) return [];
  if (Array.isArray(bv.voices)) return bv.voices;
  if (bv.mode === "cloned" && bv.provider && bv.provider_voice_id) {
    return [
      {
        id: bv.provider_voice_id,
        label: bv.cloned_label ?? "Brand voice",
        provider: bv.provider,
        provider_voice_id: bv.provider_voice_id,
        sample_asset_path: bv.sample_asset_path,
        ...(bv.cloned_accent ? { accent: bv.cloned_accent } : {}),
        cloned_at: bv.cloned_at ?? new Date().toISOString(),
      },
    ];
  }
  return [];
}

/** Copy one library entry into the flat ACTIVE-voice fields (which all narration reads). */
function activateVoiceEntry(
  payload: BrandKitPayload,
  entry: BrandVoiceEntry,
  library: BrandVoiceEntry[],
): void {
  payload.brand_voice = {
    mode: "cloned",
    preset_voice: payload.brand_voice?.preset_voice ?? "alloy",
    delivery_style: payload.brand_voice?.delivery_style ?? "",
    provider: entry.provider,
    provider_voice_id: entry.provider_voice_id,
    sample_asset_path: entry.sample_asset_path,
    cloned_label: entry.label,
    cloned_accent: entry.accent ?? null,
    cloned_at: entry.cloned_at,
    voices: library,
  };
}

function voiceCloneErrorStatus(error: unknown): number {
  if (error instanceof VoiceCloneNotConfiguredError) return 503;
  if (error instanceof VoiceCloneError) {
    return error.status && error.status >= 400 && error.status < 500 ? 422 : 502;
  }
  return 502;
}

/** PUT bytes to a fresh presigned upload URL and return the /objects/... path. */
async function uploadTenantObject(
  tenantId: number,
  bytes: Buffer,
  contentType: string,
): Promise<string> {
  const uploadURL = await objectStorageService.getObjectEntityUploadURL(tenantId);
  const putRes = await fetch(uploadURL, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: new Uint8Array(bytes),
    signal: AbortSignal.timeout(120_000),
  });
  if (!putRes.ok) {
    throw new Error(`Audio upload failed with status ${putRes.status}`);
  }
  return objectStorageService.normalizeObjectEntityPath(uploadURL);
}

/**
 * GET /brand-voice/status
 * Whether the Brand Voice feature can run right now: the kill switch AND a
 * configured provider. The editor uses this for its disabled/unconfigured
 * messaging; it never reveals the key.
 */
router.get("/brand-voice/status", async (_req: Request, res: Response) => {
  const [enabled, configured, provider] = await Promise.all([
    isFeatureEnabled("brandVoiceClone").catch(() => true),
    isVoiceCloningConfigured().catch(() => false),
    getSelectedVoiceCloneProviderId().catch(() => "elevenlabs"),
  ]);
  res.json({ enabled, configured, provider });
});

/**
 * POST /brand-voice/check-sample
 * Analyze an uploaded voice sample for quality problems (quiet / clipped /
 * noisy / duration) BEFORE the clone step, mirroring the web app's client-side
 * analyzeVoiceSample. Fail-open: a sample that cannot be decoded returns no
 * issues — analysis must never block the upload/clone flow.
 */
router.post("/brand-voice/check-sample", async (req: Request, res: Response) => {
  const parsed = CheckBrandVoiceSampleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  // The sample must be a tenant-owned object; the ACL check inside
  // getObjectEntityFile rejects foreign paths.
  let buffer: Buffer;
  try {
    const file = await objectStorageService.getObjectEntityFile(
      parsed.data.sampleAssetPath,
      req.tenantId,
    );
    const [metadata] = await file.getMetadata();
    const size = Number(metadata.size ?? 0);
    if (size > MAX_VOICE_SAMPLE_BYTES) {
      res.status(400).json({ error: "The voice sample is too large (max 15 MB)." });
      return;
    }
    [buffer] = await file.download();
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      res.status(400).json({ error: "The voice sample could not be found." });
      return;
    }
    throw error;
  }
  const issues = await analyzeVoiceSampleBuffer(buffer);
  if (issues === null) {
    req.log.info(
      { path: parsed.data.sampleAssetPath },
      "Voice sample could not be decoded for quality analysis; skipping",
    );
  }
  res.json({ issues: issues ?? [] });
});

/**
 * DELETE /brand-voice/sample
 * Best-effort cleanup of a picked file the user rejected after a server-side
 * quality warning. Only the dedicated temporary sample namespace is eligible,
 * so this endpoint can never remove an unrelated tenant upload.
 */
router.delete("/brand-voice/sample", async (req: Request, res: Response) => {
  const parsed = DeleteBrandVoiceSampleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const expectedPrefix = `/objects/${req.tenantId}/voice-samples/`;
  if (!parsed.data.sampleAssetPath.startsWith(expectedPrefix)) {
    res.status(400).json({ error: "This is not a temporary voice sample." });
    return;
  }
  await objectStorageService.deleteObjectEntityQuietly(
    parsed.data.sampleAssetPath,
    req.tenantId,
  );
  res.status(204).end();
});

/**
 * POST /brand-kits/:id/base-videos/:baseVideoId/extract-audio
 * Prepare one saved base video's first audio track as a private voice sample.
 * This is deliberately provider-free: the user reviews the sample before the
 * existing clone route performs any billed or irreversible work.
 */
router.post(
  "/brand-kits/:id/base-videos/:baseVideoId/extract-audio",
  requireFeature("brandVoiceClone"),
  async (req: Request, res: Response) => {
    const baseVideoId = Array.isArray(req.params.baseVideoId)
      ? req.params.baseVideoId[0]
      : req.params.baseVideoId;
    if (!baseVideoId || baseVideoId.length > 200) {
      res.status(400).json({ error: "Invalid base video id" });
      return;
    }
    const ctx = await requireActivePayload(req, res);
    if (!ctx) return;
    const baseVideo = ctx.payload.base_videos?.find((video) => video.id === baseVideoId);
    if (!baseVideo) {
      res.status(404).json({ error: "That saved base video could not be found." });
      return;
    }

    let source: Buffer;
    try {
      const file = await objectStorageService.getObjectEntityFile(
        baseVideo.video_path,
        req.tenantId,
      );
      const [metadata] = await file.getMetadata();
      const size = Number(metadata.size ?? 0);
      if (!Number.isFinite(size) || size <= 0 || size > MAX_BASE_VIDEO_BYTES) {
        res.status(400).json({ error: "The saved base video is empty or too large." });
        return;
      }
      const contentType = String(metadata.contentType ?? "")
        .toLowerCase()
        .split(";")[0]
        .trim();
      if (!BASE_VIDEO_CONTENT_TYPES.has(contentType)) {
        res.status(400).json({ error: "The saved file is not a supported base video." });
        return;
      }
      [source] = await file.download();
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        res.status(404).json({ error: "The saved base video file could not be found." });
        return;
      }
      throw error;
    }

    try {
      const audio = await extractVoiceSampleFromVideo(source);
      if (audio.length > MAX_VOICE_SAMPLE_BYTES) {
        res.status(422).json({
          error: "The extracted audio is too long to use as a voice sample.",
        });
        return;
      }
      const issues = await analyzeVoiceSampleBuffer(audio);
      const uploadURL =
        await objectStorageService.getBrandVoiceExtractionUploadURL(
          req.tenantId,
          ctx.kitId,
        );
      const sampleAssetPath =
        objectStorageService.normalizeObjectEntityPath(uploadURL.split("?")[0]);
      await registerBrandVoiceExtractedSample({
        tenantId: req.tenantId,
        brandKitId: ctx.kitId,
        objectPath: sampleAssetPath,
      });
      try {
        const putRes = await fetch(uploadURL, {
          method: "PUT",
          headers: { "Content-Type": "audio/mpeg" },
          body: audio,
          signal: AbortSignal.timeout(30_000),
        });
        if (!putRes.ok) {
          throw new Error(`Object upload failed (${putRes.status})`);
        }
      } catch (error) {
        await deleteBrandVoiceExtractedSample({
          tenantId: req.tenantId,
          brandKitId: ctx.kitId,
          objectPath: sampleAssetPath,
        }).catch((cleanupError) => {
          req.log.warn(
            { err: cleanupError },
            "Failed to clean up uncommitted extracted sample",
          );
        });
        throw error;
      }
      res.json({
        sampleAssetPath,
        contentType: "audio/mpeg",
        sizeBytes: audio.length,
        issues: issues ?? [],
      });
    } catch (error) {
      if (error instanceof BaseVideoAudioExtractionError) {
        res.status(422).json({ error: error.message });
        return;
      }
      req.log.error({ err: error }, "Base-video audio extraction failed");
      res.status(500).json({ error: "Could not prepare the video's audio. Please try again." });
    }
  },
);

/**
 * DELETE /brand-kits/:id/voice/extracted-sample
 * Remove a prepared sample the user chose not to clone. Only the dedicated
 * per-kit extraction namespace is eligible, and a retained library sample can
 * never be removed through this cleanup path.
 */
router.delete(
  "/brand-kits/:id/voice/extracted-sample",
  async (req: Request, res: Response) => {
    const parsed = DeleteBrandVoiceExtractedSampleBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const ctx = await requireActivePayload(req, res);
    if (!ctx) return;
    const expectedPrefix = `/objects/${req.tenantId}/voice-extracts/${ctx.kitId}/`;
    if (!parsed.data.sampleAssetPath.startsWith(expectedPrefix)) {
      res.status(400).json({ error: "This is not an extracted sample for the Brand Kit." });
      return;
    }
    const library = voiceLibrary(ctx.payload.brand_voice);
    if (
      ctx.payload.brand_voice?.sample_asset_path === parsed.data.sampleAssetPath ||
      library.some((voice) => voice.sample_asset_path === parsed.data.sampleAssetPath)
    ) {
      res.status(409).json({ error: "This sample is already used by a saved voice." });
      return;
    }
    const deletion = await deleteBrandVoiceExtractedSample({
      tenantId: req.tenantId,
      brandKitId: ctx.kitId,
      objectPath: parsed.data.sampleAssetPath,
    });
    if (deletion === "busy") {
      res.status(409).json({ error: "This sample is currently being saved." });
      return;
    }
    res.status(204).end();
  },
);

/**
 * POST /brand-kits/:id/voice/clone
 * Clone a brand voice from an uploaded reference sample and store it on the
 * kit as a NEW version (untouched sections preserved). Wallet-funded tenants
 * pay the caption rate; failures refund.
 */
router.post(
  "/brand-kits/:id/voice/clone",
  requireFeature("brandVoiceClone"),
  async (req: Request, res: Response) => {
    const parsed = CloneBrandVoiceBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const ctx = await requireActivePayload(req, res);
    if (!ctx) return;
    const extractedSampleInput = {
      tenantId: req.tenantId,
      brandKitId: ctx.kitId,
      objectPath: parsed.data.sampleAssetPath,
    };
    const isExtractedSample = isBrandVoiceExtractedSamplePath(
      parsed.data.sampleAssetPath,
      req.tenantId,
      ctx.kitId,
    );
    let extractedSampleClaimed = false;
    const releaseExtractedSampleClaim = async () => {
      if (!extractedSampleClaimed) return;
      await releaseBrandVoiceExtractedSampleClaim(extractedSampleInput);
      extractedSampleClaimed = false;
    };
    if (isExtractedSample) {
      extractedSampleClaimed =
        await claimBrandVoiceExtractedSample(extractedSampleInput);
      if (!extractedSampleClaimed) {
        res.status(409).json({
          error: "This extracted sample expired or is already being saved.",
        });
        return;
      }
    }

    // The sample must be a tenant-owned object; the ACL check inside
    // getObjectEntityFile rejects foreign paths.
    let sample: { buffer: Buffer; mimeType: string };
    try {
      const file = await objectStorageService.getObjectEntityFile(
        parsed.data.sampleAssetPath,
        req.tenantId,
      );
      const [metadata] = await file.getMetadata();
      const size = Number(metadata.size ?? 0);
      if (size > MAX_VOICE_SAMPLE_BYTES) {
        await releaseExtractedSampleClaim();
        res.status(400).json({ error: "The voice sample is too large (max 15 MB)." });
        return;
      }
      const mimeType = String(metadata.contentType ?? "").toLowerCase().split(";")[0].trim();
      if (!mimeType.startsWith("audio/") && mimeType !== "video/webm") {
        await releaseExtractedSampleClaim();
        res.status(400).json({ error: "The voice sample must be an audio file." });
        return;
      }
      const [buffer] = await file.download();
      sample = { buffer, mimeType };
    } catch (error) {
      await releaseExtractedSampleClaim();
      if (error instanceof ObjectNotFoundError) {
        res.status(400).json({ error: "The voice sample could not be found." });
        return;
      }
      throw error;
    }

    // Every saved voice is a live provider clone, so the library is capped.
    const existingLibrary = voiceLibrary(ctx.payload.brand_voice);
    if (existingLibrary.length >= MAX_VOICE_LIBRARY) {
      await releaseExtractedSampleClaim();
      res.status(400).json({
        error: `You can save up to ${MAX_VOICE_LIBRARY} voices. Delete one from the voice library first.`,
      });
      return;
    }

    // Measure before the paid provider call. A decode failure deliberately
    // remains unknown rather than turning bytes or a MIME type into a guess.
    const selectedCloneProvider = await getSelectedVoiceCloneProviderId();
    const sampleDurationMs = await measureVoiceSampleDurationMs(sample.buffer);
    const cloneCostPaise =
      selectedCloneProvider === "elevenlabs"
        ? await computeVoiceCloneCostPaise({
            provider: "elevenlabs",
            model: "voice-clone",
            sampleDurationMs,
          })
        : null;

    // Wallet-funded tenants pay for the clone like any other generation.
    let reservation: WalletReservation | null = null;
    if (await isWalletFunded(req.tenantId)) {
      reservation = await reserveWallet(
        req.tenantId,
        "caption",
        { provider: selectedCloneProvider, model: "voice-clone" },
        1,
        cloneCostPaise,
      );
      if (!reservation) {
        await releaseExtractedSampleClaim();
        res.status(402).json({ error: "Insufficient wallet balance. Please recharge." });
        return;
      }
    }

    const label = parsed.data.label?.trim() || "Brand voice";
    /** Set once the provider clone exists, so failures can compensate. */
    let cloned: ClonedVoiceRef | null = null;
    /** Durable receipt for wallet-funded work, written before the provider call. */
    let providerOperationId: number | null = null;
    /** True once the new kit version is persisted — the work is committed. */
    let committed = false;
    try {
      // A reservation is globally unique, making this name a stable receipt
      // that the recovery worker can locate after a crash at the provider
      // acknowledgement boundary.
      const providerVoiceName = reservation
        ? `kokao-brand-voice-r${reservation.id}`
        : `kokao-t${req.tenantId}-k${ctx.kitId}-${randomUUID().slice(0, 8)}`;
      if (reservation) {
        // Persist the selected provider with the intent as well as the
        // deterministic name. Reconciliation must never probe a different
        // provider if an administrator changes the selection mid-request.
        const operation = await executeWalletProviderOperation(
          {
            tenantId: req.tenantId,
            reservation,
            operationKind: "brand_voice_clone",
            operationKey: providerVoiceName,
            settlement: {
              kind: "caption",
              costPaise: cloneCostPaise,
              provider: selectedCloneProvider,
              model: "voice-clone",
              refKind: "brandKit",
              refId: String(ctx.kitId),
            },
          },
          () =>
            cloneBrandVoice({
              name: providerVoiceName,
              audio: sample.buffer,
              mimeType: sample.mimeType,
              provider: selectedCloneProvider,
            }),
          (voice) => ({
            provider: voice.provider,
            model: "voice-clone",
            providerResultId: voice.voiceId,
          }),
          { isFailureConfirmed: isConfirmedVoiceCloneFailure },
        );
        cloned = operation.value;
        providerOperationId = operation.operationId;
      } else {
        cloned = await cloneBrandVoice({
          name: providerVoiceName,
          audio: sample.buffer,
          mimeType: sample.mimeType,
        });
      }

      const entry: BrandVoiceEntry = {
        id: randomUUID(),
        label,
        provider: cloned.provider,
        provider_voice_id: cloned.voiceId,
        sample_asset_path: parsed.data.sampleAssetPath,
        accent: parsed.data.accent ?? "american_english",
        cloned_at: new Date().toISOString(),
      };
      const payload = clonePayload(ctx.payload);
      // The new voice joins the library and becomes active; older saved
      // voices stay cloned at the provider so the user can switch back.
      activateVoiceEntry(payload, entry, [...existingLibrary, entry]);
      const detail = await addVersion({
        tenantId: req.tenantId,
        brandKitId: ctx.kitId,
        createdBy: ctx.createdBy,
        payload,
        sourceType: "manual",
        sourceNotes: `Brand voice cloned (${cloned.provider})`,
        approvalStatus: "approved",
        activate: true,
      });
      if (!detail) {
        throw new Error("The brand kit disappeared while cloning the voice.");
      }
      committed = true;
      if (extractedSampleClaimed) {
        await adoptBrandVoiceExtractedSample(extractedSampleInput).catch((err) => {
          // The active payload now references the object. The expiry sweep also
          // checks references before deleting, so a transient tracker-delete
          // failure cannot remove a committed voice sample.
          req.log.warn(
            { err },
            "Failed to release adopted Brand Voice sample tracker",
          );
        });
        extractedSampleClaimed = false;
      }

      let settledChargePaise: number | undefined;
      if (providerOperationId !== null) {
        // The work succeeded — a settlement hiccup must never refund it.
        // The durable operation froze the catalog-derived clone cost before
        // the provider call, including the measured submitted-sample duration.
        const settled = await settleWalletProviderOperationDurably(providerOperationId).catch(
          (err) => {
            req.log.error({ err }, "Voice-clone wallet settlement failed after committed work");
            return null;
          },
        );
        settledChargePaise = settled?.chargedPaise;
      }
      recordUsage(req.tenantId, "caption", {
        provider: cloned.provider,
        model: "voice-clone",
        sampleDurationMs: sampleDurationMs ?? undefined,
        costPaise: cloneCostPaise ?? undefined,
        displayPaiseOverride: settledChargePaise,
        funding: reservation ? "wallet" : undefined,
      }).catch(() => {});

      res.status(201).json(detail);
    } catch (error) {
      if (committed) {
        // Should be unreachable now, but never refund/compensate committed work.
        req.log.error({ err: error }, "Voice clone failed after commit");
        res.status(500).json({ error: "Voice cloning failed. Please try again." });
        return;
      }
      // The provider positively acknowledged the clone, but persisting that
      // acknowledgement failed. Its pending receipt is intentionally left for
      // provider-side reconciliation: deleting/refunding here could make paid
      // work disappear at the crash boundary.
      if (error instanceof WalletProviderSuccessPersistenceError) {
        req.log.error(
          { err: error, operationId: error.operationId },
          "Voice clone provider success could not be persisted",
        );
        res.status(500).json({ error: "Voice cloning failed. Please try again." });
        return;
      }
      // The clone exists at the provider but was never persisted — a paid
      // orphan slot; tidy it up best-effort.
      if (cloned) {
        await deleteClonedVoiceQuietly(cloned);
      }
      if (providerOperationId !== null) {
        // The provider already confirmed success. A later Brand Kit write
        // failure cannot turn that paid operation into a provider failure.
        await settleWalletProviderOperationDurably(providerOperationId).catch((err) => {
          req.log.error({ err }, "Voice-clone settlement failed after local persistence error");
        });
      } else if (reservation) {
        await refundWallet(req.tenantId, reservation, "Voice cloning failed").catch(() => {});
      }
      if (extractedSampleClaimed) {
        // Keep the durable tracker if storage is temporarily unavailable; the
        // expiry sweep will retry instead of losing the only cleanup record.
        await discardClaimedBrandVoiceExtractedSample(
          extractedSampleInput,
        ).catch((err) => {
          req.log.warn(
            { err },
            "Failed to delete rejected extracted Brand Voice sample",
          );
        });
        extractedSampleClaimed = false;
      } else {
        // Ordinary uploaded samples are not TTL-tracked, so retain the original
        // best-effort failure cleanup.
        await objectStorageService
          .deleteObjectEntityQuietly(parsed.data.sampleAssetPath, req.tenantId)
          .catch(() => {});
      }
      req.log.error({ err: error }, "Brand voice cloning failed");
      res.status(voiceCloneErrorStatus(error)).json({
        error:
          error instanceof VoiceCloneError
            ? error.message
            : "Voice cloning failed. Please try again.",
      });
    }
  },
);

/**
 * POST /brand-kits/:id/voice/preview
 * Speak a short line in the kit's cloned voice and return the audio path.
 */
router.post(
  "/brand-kits/:id/voice/preview",
  requireFeature("brandVoiceClone"),
  async (req: Request, res: Response) => {
    const parsed = PreviewBrandVoiceBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const ctx = await requireActivePayload(req, res);
    if (!ctx) return;
    const bv = ctx.payload.brand_voice;
    if (!bv || bv.mode !== "cloned" || !bv.provider || !bv.provider_voice_id) {
      res.status(409).json({ error: "This brand kit has no cloned voice to preview." });
      return;
    }

    const text = (parsed.data.text?.trim() || DEFAULT_PREVIEW_TEXT).slice(0, 300);
    const ttsCostPaise =
      bv.provider === "elevenlabs"
        ? await computeTtsCostPaise({
            provider: "elevenlabs",
            model: "eleven_multilingual_v2",
            inputCharacters: text.length,
          })
        : null;
    let reservation: WalletReservation | null = null;
    if (await isWalletFunded(req.tenantId)) {
      reservation = await reserveWallet(
        req.tenantId,
        "caption",
        { provider: bv.provider, model: "eleven_multilingual_v2" },
        1,
        ttsCostPaise,
      );
      if (!reservation) {
        res.status(402).json({ error: "Insufficient wallet balance. Please recharge." });
        return;
      }
    }

    let providerOperationId: number | null = null;
    try {
      const wav = reservation
        ? (
            await executeWalletProviderOperation(
              {
                tenantId: req.tenantId,
                reservation,
                operationKind: "brand_voice_tts",
                operationKey: buildBrandVoiceTtsOperationKey(
                  bv.provider_voice_id,
                  "eleven_multilingual_v2",
                  text,
                ),
                settlement: {
                  kind: "caption",
                  costPaise: ttsCostPaise,
                  provider: bv.provider,
                  model: "eleven_multilingual_v2",
                  refKind: "brandKit",
                  refId: String(ctx.kitId),
                },
              },
              () =>
                speakWithClonedVoice(
                  { provider: bv.provider!, voiceId: bv.provider_voice_id! },
                  text,
                ),
              () => ({ provider: bv.provider, model: "eleven_multilingual_v2" }),
              { isFailureConfirmed: isConfirmedVoiceCloneFailure },
            )
          )
        : null;
      if (wav) providerOperationId = wav.operationId;
      const audio = wav?.value ??
        (await speakWithClonedVoice(
          { provider: bv.provider, voiceId: bv.provider_voice_id },
          text,
        ));
      const audioPath = await uploadTenantObject(req.tenantId, audio, "audio/wav");
      const settled = providerOperationId !== null
        ? await settleWalletProviderOperationDurably(providerOperationId).catch((err) => {
            req.log.error({ err }, "Voice-preview wallet settlement failed after successful work");
            return null;
          })
        : null;
      recordUsage(req.tenantId, "caption", {
        provider: bv.provider,
        model: "eleven_multilingual_v2",
        inputCharacters: text.length,
        costPaise: ttsCostPaise ?? undefined,
        displayPaiseOverride: settled?.chargedPaise,
        funding: reservation ? "wallet" : undefined,
      }).catch(() => {});
      res.json({ audioPath });
    } catch (error) {
      const succeededOperationId = providerOperationId ?? successfulProviderOperationId(error);
      if (succeededOperationId !== null) {
        await settleWalletProviderOperationDurably(succeededOperationId).catch((settlementError) => {
          req.log.error(
            { err: settlementError },
            "Voice-preview wallet settlement failed after successful work",
          );
        });
      } else if (reservation) {
        await refundWallet(req.tenantId, reservation, "Voice preview failed").catch(() => {});
      }
      req.log.error({ err: error }, "Brand voice preview failed");
      res.status(voiceCloneErrorStatus(error)).json({
        error:
          error instanceof VoiceCloneError
            ? error.message
            : "The voice preview failed. Please try again.",
      });
    }
  },
);

/**
 * POST /brand-kits/:id/voice/stock-preview
 * Speak a short sample with the selected stock narrator. This deliberately
 * bypasses the cloned-voice provider so it remains useful when cloning is
 * disabled, unconfigured, or temporarily unavailable.
 */
router.post(
  "/brand-kits/:id/voice/stock-preview",
  async (req: Request, res: Response) => {
    const parsed = PreviewStockBrandVoiceBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Choose a valid stock voice." });
      return;
    }
    const ctx = await requireActivePayload(req, res);
    if (!ctx) return;

    let reservation: WalletReservation | null = null;
    if (await isWalletFunded(req.tenantId)) {
      reservation = await reserveWallet(req.tenantId, "caption");
      if (!reservation) {
        res.status(402).json({ error: "Insufficient wallet balance. Please recharge." });
        return;
      }
    }

    try {
      const voice = parsed.data.presetVoice as NarrationVoice;
      const narration = await synthesizeNarration(
        [DEFAULT_STOCK_PREVIEW_TEXT],
        voice,
      );
      const audioPath = await uploadTenantObject(
        req.tenantId,
        narration.wav,
        "audio/wav",
      );
      if (reservation) {
        await settleWalletDurably(req.tenantId, reservation, {
          kind: "caption",
          costPaise: null,
          provider: "stock-tts",
          model: voice,
          refKind: "brandKit",
          refId: String(ctx.kitId),
        }).catch((err) => {
          req.log.error(
            { err },
            "Stock-voice-preview wallet settlement failed after successful work",
          );
        });
      }
      recordUsage(req.tenantId, "caption", {
        provider: "stock-tts",
        model: voice,
        funding: reservation ? "wallet" : undefined,
      }).catch(() => {});
      res.json({ audioPath });
    } catch (error) {
      if (reservation) {
        await refundWallet(
          req.tenantId,
          reservation,
          "Stock voice preview failed",
        ).catch(() => {});
      }
      req.log.error({ err: error }, "Stock voice preview failed");
      res.status(503).json({
        error:
          error instanceof VideoGenProviderError
            ? error.message
            : "The stock voice preview failed. Please try again.",
      });
    }
  },
);

/**
 * POST /brand-kits/:id/voice/audio
 * Generate a downloadable voiceover WAV from user-provided text in the kit's
 * cloned voice. Same gating and funding as previews: kill-switch protected,
 * wallet-funded tenants pay the caption rate, failures refund.
 */
router.post(
  "/brand-kits/:id/voice/audio",
  requireFeature("brandVoiceClone"),
  async (req: Request, res: Response) => {
    const parsed = CreateBrandVoiceAudioBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const text = parsed.data.text.trim();
    if (!text) {
      res.status(400).json({ error: "Enter the script you want spoken." });
      return;
    }
    const ctx = await requireActivePayload(req, res);
    if (!ctx) return;
    const bv = ctx.payload.brand_voice;
    if (!bv || bv.mode !== "cloned" || !bv.provider || !bv.provider_voice_id) {
      res.status(409).json({ error: "This brand kit has no cloned voice yet." });
      return;
    }

    const ttsCostPaise =
      bv.provider === "elevenlabs"
        ? await computeTtsCostPaise({
            provider: "elevenlabs",
            model: "eleven_multilingual_v2",
            inputCharacters: text.length,
          })
        : null;
    let reservation: WalletReservation | null = null;
    if (await isWalletFunded(req.tenantId)) {
      reservation = await reserveWallet(
        req.tenantId,
        "caption",
        { provider: bv.provider, model: "eleven_multilingual_v2" },
        1,
        ttsCostPaise,
      );
      if (!reservation) {
        res.status(402).json({ error: "Insufficient wallet balance. Please recharge." });
        return;
      }
    }

    let providerOperationId: number | null = null;
    try {
      const operation = reservation
        ? await executeWalletProviderOperation(
            {
              tenantId: req.tenantId,
              reservation,
              operationKind: "brand_voice_tts",
              operationKey: buildBrandVoiceTtsOperationKey(
                bv.provider_voice_id,
                "eleven_multilingual_v2",
                text,
              ),
              settlement: {
                kind: "caption",
                costPaise: ttsCostPaise,
                provider: bv.provider,
                model: "eleven_multilingual_v2",
                refKind: "brandKit",
                refId: String(ctx.kitId),
              },
            },
            () =>
              speakWithClonedVoice(
                { provider: bv.provider!, voiceId: bv.provider_voice_id! },
                text,
              ),
            () => ({ provider: bv.provider, model: "eleven_multilingual_v2" }),
            { isFailureConfirmed: isConfirmedVoiceCloneFailure },
          )
        : null;
      if (operation) providerOperationId = operation.operationId;
      const wav = operation?.value ??
        (await speakWithClonedVoice(
          { provider: bv.provider, voiceId: bv.provider_voice_id },
          text,
        ));
      const audioPath = await uploadTenantObject(req.tenantId, wav, "audio/wav");
      const settled = providerOperationId !== null
        ? await settleWalletProviderOperationDurably(providerOperationId).catch((err) => {
            req.log.error({ err }, "Voice-audio wallet settlement failed after successful work");
            return null;
          })
        : null;
      recordUsage(req.tenantId, "caption", {
        provider: bv.provider,
        model: "eleven_multilingual_v2",
        inputCharacters: text.length,
        costPaise: ttsCostPaise ?? undefined,
        displayPaiseOverride: settled?.chargedPaise,
        funding: reservation ? "wallet" : undefined,
      }).catch(() => {});
      res.json({ audioPath });
    } catch (error) {
      const succeededOperationId = providerOperationId ?? successfulProviderOperationId(error);
      if (succeededOperationId !== null) {
        await settleWalletProviderOperationDurably(succeededOperationId).catch((settlementError) => {
          req.log.error(
            { err: settlementError },
            "Voice-audio wallet settlement failed after successful work",
          );
        });
      } else if (reservation) {
        await refundWallet(req.tenantId, reservation, "Voice audio failed").catch(() => {});
      }
      req.log.error({ err: error }, "Brand voice audio generation failed");
      res.status(voiceCloneErrorStatus(error)).json({
        error:
          error instanceof VoiceCloneError
            ? error.message
            : "Generating the audio failed. Please try again.",
      });
    }
  },
);

/**
 * POST /brand-kits/:id/voice/select
 * Make a saved voice from the kit's library the active narration voice. No
 * provider call is made, so this deliberately is NOT gated by the kill
 * switch — switching between already-cloned voices must always work.
 */
router.post("/brand-kits/:id/voice/select", async (req: Request, res: Response) => {
  const parsed = SelectBrandVoiceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const ctx = await requireActivePayload(req, res);
  if (!ctx) return;
  const library = voiceLibrary(ctx.payload.brand_voice);
  const entry = library.find((v) => v.id === parsed.data.voiceId);
  if (!entry) {
    res.status(404).json({ error: "That saved voice no longer exists." });
    return;
  }

  const payload = clonePayload(ctx.payload);
  activateVoiceEntry(payload, entry, library);
  const detail = await addVersion({
    tenantId: req.tenantId,
    brandKitId: ctx.kitId,
    createdBy: ctx.createdBy,
    payload,
    sourceType: "manual",
    sourceNotes: `Brand voice switched to "${entry.label}"`,
    approvalStatus: "approved",
    activate: true,
  });
  if (!detail) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(detail);
});

/**
 * DELETE /brand-kits/:id/voice/entries/:voiceId
 * Delete one saved voice from the library (and its provider clone, best
 * effort). Deleting the active voice promotes the newest remaining entry, or
 * clears the section when the library empties. NOT gated by the kill switch:
 * removal must always work.
 */
router.delete("/brand-kits/:id/voice/entries/:voiceId", async (req: Request, res: Response) => {
  const ctx = await requireActivePayload(req, res);
  if (!ctx) return;
  const library = voiceLibrary(ctx.payload.brand_voice);
  const entry = library.find((v) => v.id === String(req.params.voiceId));
  if (!entry) {
    res.status(404).json({ error: "That saved voice no longer exists." });
    return;
  }
  const remaining = library.filter((v) => v.id !== entry.id);
  const wasActive = ctx.payload.brand_voice?.provider_voice_id === entry.provider_voice_id;

  const payload = clonePayload(ctx.payload);
  if (remaining.length === 0) {
    payload.brand_voice = null;
  } else if (wasActive) {
    const newest = remaining.reduce((a, b) => (a.cloned_at >= b.cloned_at ? a : b));
    activateVoiceEntry(payload, newest, remaining);
  } else if (payload.brand_voice) {
    payload.brand_voice.voices = remaining;
  }
  const detail = await addVersion({
    tenantId: req.tenantId,
    brandKitId: ctx.kitId,
    createdBy: ctx.createdBy,
    payload,
    sourceType: "manual",
    sourceNotes: `Saved voice "${entry.label}" deleted`,
    approvalStatus: "approved",
    activate: true,
  });
  if (!detail) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await deleteClonedVoiceQuietly({ provider: entry.provider, voiceId: entry.provider_voice_id });
  res.json(detail);
});

/**
 * DELETE /brand-kits/:id/voice
 * Remove the kit's brand voice entirely — every saved library voice is
 * deleted at the provider (best effort). Deliberately NOT gated by the kill
 * switch: removal must always work, even when the feature was turned off
 * after voices were cloned.
 */
router.delete("/brand-kits/:id/voice", async (req: Request, res: Response) => {
  const ctx = await requireActivePayload(req, res);
  if (!ctx) return;
  const bv = ctx.payload.brand_voice;
  if (!bv) {
    res.status(404).json({ error: "This brand kit has no brand voice to remove." });
    return;
  }
  const library = voiceLibrary(bv);

  const payload = clonePayload(ctx.payload);
  payload.brand_voice = null;
  const detail = await addVersion({
    tenantId: req.tenantId,
    brandKitId: ctx.kitId,
    createdBy: ctx.createdBy,
    payload,
    sourceType: "manual",
    sourceNotes: "Brand voice removed",
    approvalStatus: "approved",
    activate: true,
  });
  if (!detail) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  for (const v of library) {
    await deleteClonedVoiceQuietly({ provider: v.provider, voiceId: v.provider_voice_id });
  }
  res.json(detail);
});

export default router;
