import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  tenantsTable,
  brandAssetsTable,
  brandKitsTable,
  brandKitVersionsTable,
  type BrandKitPayload,
} from "@workspace/db";
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
  PreviewBrandVoiceBody,
} from "@workspace/api-zod";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { isFeatureEnabled, requireFeature } from "../lib/featureFlags";
import {
  cloneBrandVoice,
  speakWithClonedVoice,
  deleteClonedVoiceQuietly,
  isVoiceCloningConfigured,
  getSelectedVoiceCloneProviderId,
  VoiceCloneNotConfiguredError,
  VoiceCloneError,
  type ClonedVoiceRef,
} from "../lib/voiceClone";
import {
  isWalletFunded,
  reserveWallet,
  settleWallet,
  refundWallet,
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

const router: IRouter = Router();

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
const DEFAULT_PREVIEW_TEXT =
  "Hi there! This is your new brand voice. Every video you create from now on can sound exactly like this.";

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
        res.status(400).json({ error: "The voice sample is too large (max 15 MB)." });
        return;
      }
      const mimeType = String(metadata.contentType ?? "").toLowerCase().split(";")[0].trim();
      if (!mimeType.startsWith("audio/") && mimeType !== "video/webm") {
        res.status(400).json({ error: "The voice sample must be an audio file." });
        return;
      }
      const [buffer] = await file.download();
      sample = { buffer, mimeType };
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        res.status(400).json({ error: "The voice sample could not be found." });
        return;
      }
      throw error;
    }

    // Wallet-funded tenants pay for the clone like any other generation.
    let reservation: WalletReservation | null = null;
    if (await isWalletFunded(req.tenantId)) {
      reservation = await reserveWallet(req.tenantId, "caption");
      if (!reservation) {
        res.status(402).json({ error: "Insufficient wallet balance. Please recharge." });
        return;
      }
    }

    const previous: ClonedVoiceRef | null =
      ctx.payload.brand_voice?.mode === "cloned" &&
      ctx.payload.brand_voice.provider &&
      ctx.payload.brand_voice.provider_voice_id
        ? {
            provider: ctx.payload.brand_voice.provider,
            voiceId: ctx.payload.brand_voice.provider_voice_id,
          }
        : null;

    const label = parsed.data.label?.trim() || "Brand voice";
    try {
      const cloned = await cloneBrandVoice({
        name: `kokao-t${req.tenantId}-k${ctx.kitId}`,
        audio: sample.buffer,
        mimeType: sample.mimeType,
      });

      const payload = clonePayload(ctx.payload);
      payload.brand_voice = {
        mode: "cloned",
        preset_voice: ctx.payload.brand_voice?.preset_voice ?? "alloy",
        delivery_style: ctx.payload.brand_voice?.delivery_style ?? "",
        provider: cloned.provider,
        provider_voice_id: cloned.voiceId,
        sample_asset_path: parsed.data.sampleAssetPath,
        cloned_label: label,
        cloned_at: new Date().toISOString(),
      };
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
        // The kit vanished mid-flight; the clone is orphaned at the provider.
        await deleteClonedVoiceQuietly(cloned);
        throw new Error("The brand kit disappeared while cloning the voice.");
      }

      if (reservation) {
        // Actual provider cost is unknown (no per-call price is reported), so
        // it is recorded as NULL — never guessed — and the wallet settles at
        // the display rate.
        await settleWallet(req.tenantId, reservation, {
          kind: "caption",
          costPaise: null,
          provider: cloned.provider,
          model: "voice-clone",
          refKind: "brandKit",
          refId: String(ctx.kitId),
        });
      }
      recordUsage(req.tenantId, "caption", {
        provider: cloned.provider,
        model: "voice-clone",
        funding: reservation ? "wallet" : undefined,
      }).catch(() => {});

      // Replacing an older clone: tidy it up at the provider, best effort.
      if (previous && previous.voiceId !== cloned.voiceId) {
        await deleteClonedVoiceQuietly(previous);
      }

      res.status(201).json(detail);
    } catch (error) {
      if (reservation) {
        await refundWallet(req.tenantId, reservation, "Voice cloning failed").catch(() => {});
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

    let reservation: WalletReservation | null = null;
    if (await isWalletFunded(req.tenantId)) {
      reservation = await reserveWallet(req.tenantId, "caption");
      if (!reservation) {
        res.status(402).json({ error: "Insufficient wallet balance. Please recharge." });
        return;
      }
    }

    try {
      const text = parsed.data.text?.trim() || DEFAULT_PREVIEW_TEXT;
      const wav = await speakWithClonedVoice(
        { provider: bv.provider, voiceId: bv.provider_voice_id },
        text.slice(0, 300),
      );
      const audioPath = await uploadTenantObject(req.tenantId, wav, "audio/wav");
      if (reservation) {
        await settleWallet(req.tenantId, reservation, {
          kind: "caption",
          costPaise: null,
          provider: bv.provider,
          model: "voice-preview",
          refKind: "brandKit",
          refId: String(ctx.kitId),
        });
      }
      recordUsage(req.tenantId, "caption", {
        provider: bv.provider,
        model: "voice-preview",
        funding: reservation ? "wallet" : undefined,
      }).catch(() => {});
      res.json({ audioPath });
    } catch (error) {
      if (reservation) {
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
 * DELETE /brand-kits/:id/voice
 * Remove the kit's brand voice (new version, section cleared). Deliberately
 * NOT gated by the kill switch: removal must always work, even when the
 * feature was turned off after voices were cloned.
 */
router.delete("/brand-kits/:id/voice", async (req: Request, res: Response) => {
  const ctx = await requireActivePayload(req, res);
  if (!ctx) return;
  const bv = ctx.payload.brand_voice;
  if (!bv) {
    res.status(404).json({ error: "This brand kit has no brand voice to remove." });
    return;
  }

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
  if (bv.mode === "cloned" && bv.provider && bv.provider_voice_id) {
    await deleteClonedVoiceQuietly({ provider: bv.provider, voiceId: bv.provider_voice_id });
  }
  res.json(detail);
});

export default router;
