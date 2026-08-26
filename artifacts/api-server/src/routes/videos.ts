import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  isPromptVariantKey,
  tenantsTable,
  contentItemsTable,
  videoGenerationsTable,
  videoStyleProfilesTable,
  brandKitsTable,
  storyboardPreviewsAreGenerated,
  type CreativeDirection,
  type VideoJobOptions,
} from "@workspace/db";
import { and, eq, desc, isNotNull, sql } from "drizzle-orm";
import {
  GenerateVideoBody,
  ImportLibraryMusicBody,
  SaveVideoToLibraryBody,
  UpdateVideoStoryboardBody,
  InsertVideoStoryboardSceneBody,
  GenerateSpokespersonScriptBody,
  AnalyzeScriptIntakeBody,
  GetVideoCapabilitiesResponse,
} from "@workspace/api-zod";
import {
  searchLibraryMusic,
  downloadLibraryTrack,
  MusicLibraryError,
} from "../lib/musicLibrary";
import {
  ObjectNotFoundError,
  ObjectStorageService,
} from "../lib/objectStorage";
import { getPlanLimits } from "../lib/plans";
import { getUsage, recordUsage } from "../lib/usage";
import { spendCredit, refundCredits } from "../lib/credits";
import { getAiSpendConfig, getAiSpendRates, withFee } from "../lib/aiSpend";
import {
  actualChargePaise,
  executeWalletProviderOperation,
  getVideoJobWalletChargesPaise,
  isWalletFunded,
  reserveWallet,
  refundFailedVideoJobWallet,
  refundWallet,
  reservationFromRow,
  settleWalletProviderOperationDurably,
  WalletProviderPostSuccessError,
  WalletProviderSuccessPersistenceError,
  type WalletProviderOperationKind,
  type WalletReservation,
} from "../lib/wallet";
import { enqueueBackgroundJob } from "../lib/backgroundJobs";
import {
  runVideoGenerationJob,
  resumeVideoGenerationJob,
  refreshStoryboardScenePreview,
  STORYBOARD_REGENERATIONS_PER_SCENE,
} from "../lib/videoGen/jobRunner";
import {
  VideoGenProviderError,
  compiledClipPrompt,
  effectiveVideoModel,
  getVideoGenSelection,
  resolveVideoGenProviderDef,
} from "../lib/videoGen";
import { MAX_SLIDESHOW_IMAGES } from "../lib/videoGen/slideshow";
import {
  clampSceneDuration,
  clipShotCount,
  decideShotCountFromBrief,
} from "../lib/videoGen/clipStoryboard";
import { videoJobFullUnits, videoJobUnits } from "../lib/videoGen/units";
import {
  MOTION_PRESETS,
  MOTION_PRESET_CATEGORIES,
  isMotionPresetId,
} from "../lib/videoGen/motionPresets";
import {
  TIER_UNIT_MULTIPLIER,
  findVideoModel,
  supportsEndFrame,
  supportsMode,
  videoModelMultiplier,
} from "../lib/videoGen/modelCatalog";
import { availableVideoModels } from "../lib/videoGen";
import {
  CAMERAS,
  LENSES,
  FOCAL_LENGTHS,
  APERTURES,
  isValidCinematography,
  normalizeCinematography,
} from "../lib/videoGen/cinematography";
import { preflightVideoJob } from "../lib/videoGen/preflight";
import { getCharacterDetail, resolveOutfit } from "../lib/characters";
import { validateSuppliedPlan } from "../lib/videoGen/topicVideo/suppliedPlan";
import {
  normalizeLocalizedNarrationSelection,
  type LocalizedNarrationSelection,
} from "../lib/videoGen/topicVideo/tts";
import { splitIntoSentences } from "../lib/videoGen/topicVideo/narration";
import { isFeatureEnabled, videoModeFeature } from "../lib/featureFlags";
import { serializeContent } from "../lib/serializers";
import type { VideoGeneration } from "@workspace/db";
import { generateSpokespersonScript } from "../lib/videoGen/spokespersonScript";
import {
  ELEVEN_V3_LOCALES,
  characterDialogueLocale,
  planCharacterDialogueScenes,
} from "../lib/videoGen/characterDialogue";
import { loadVideoBranding } from "../lib/videoGen/branding";
import { loadActivePayload } from "../lib/brandKit/service";
import { loadStyleGuidance } from "../lib/videoGen/referenceAnalyzer";
import { analyzeScriptIntake } from "../lib/videoGen/scriptIntake";
import { getTextGenClient, TextGenNotConfiguredError } from "../lib/textGen";
import {
  assertTemplateSafe,
  resolveCreativeBrief,
  missingSlots,
  UnsafeTemplateError,
  type SuppliedSlots,
  type TemplateRow,
} from "../lib/videoGen/videoTemplates";
import {
  compileCreativeBrief,
  lintStoryboardCreativeBrief,
} from "../lib/videoGen/creativeBrief";
import {
  alignPresenterNarration,
  planPresenterBrollTimeline,
  PresenterBrollInputError,
  probePresenterDurationMs,
} from "../lib/videoGen/presenterBroll";
import {
  BaseVideoAudioExtractionError,
  extractVoiceSampleFromVideo,
} from "../lib/baseVideoAudio";
import {
  AsrNotConfiguredError,
  AsrProviderError,
  transcribeAudio,
} from "../lib/asr";
import {
  computeTextCostPaise,
  findModelPrice,
  getAiCostConfig,
  usdToPaise,
} from "../lib/aiCost";
import { syncModelPricingBestEffort } from "../lib/modelPricingSync";
import {
  LATENT_SYNC,
  SYNC_LIPSYNC_2,
  type LipSyncQuality,
} from "../lib/videoGen/lipSyncModels";

const router: IRouter = Router();
const MAX_LOCALIZED_DUB_DURATION_MS = 30 * 60 * 1000;
const MAX_PRESENTER_VIDEO_BYTES = 100 * 1024 * 1024;
const PRESENTER_VIDEO_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm"]);
const MAX_DIALOGUE_LIP_SYNC_DURATION_SEC = 30;
const MAX_CHARACTER_DIALOGUE_DURATION_SEC = 180;

type BillableScriptResult = {
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costPaise: number | null;
};

async function runBillableScriptRequest<T extends BillableScriptResult>(args: {
  req: Request;
  tenantModel: string;
  operationKind: Extract<
    WalletProviderOperationKind,
    "video_script_intake" | "video_script_draft"
  >;
  perform: () => Promise<T>;
}): Promise<{ result: T; funding: "wallet" | "unmetered"; chargedPaise: number | null } | null> {
  if (!(await isWalletFunded(args.req.tenantId))) {
    return { result: await args.perform(), funding: "unmetered", chargedPaise: null };
  }

  const selectedTextGen = await getTextGenClient(args.tenantModel);
  // Reserve against the model's full synchronous context/output envelope, not
  // the much smaller display-rate estimate. The final settle still uses the
  // provider's actual receipt (or one caption unit when unmetered), so nearly
  // all of this ceiling is immediately returned after a normal request.
  const maximumTextCostPaise = await computeTextCostPaise({
    provider: selectedTextGen.provider,
    model: selectedTextGen.model,
    inputTokens: 128_000,
    outputTokens: 4_096,
  });
  const reservation = await reserveWallet(
    args.req.tenantId,
    "caption",
    {
      provider: selectedTextGen.provider,
      model: selectedTextGen.model,
    },
    1,
    maximumTextCostPaise ?? undefined,
  );
  if (!reservation) return null;

  try {
    const executed = await executeWalletProviderOperation(
      {
        tenantId: args.req.tenantId,
        reservation,
        operationKind: args.operationKind,
        operationKey: `${args.operationKind}:${reservation.id}`,
        settlement: {
          kind: "caption",
          costPaise: null,
          provider: selectedTextGen.provider,
          model: selectedTextGen.model,
          refKind: "videoScript",
          refId: `${args.operationKind}:${reservation.id}`,
        },
      },
      args.perform,
      (result) => ({
        provider: result.provider,
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        ...(result.costPaise !== null ? { costPaise: result.costPaise } : {}),
      }),
    );
    const target = await actualChargePaise({
      kind: "caption",
      costPaise: executed.value.costPaise,
    });
    const settled = await settleWalletProviderOperationDurably(executed.operationId).catch(
      (error) => {
        args.req.log.error(
          { err: error, operationId: executed.operationId },
          "Failed to hand off script wallet settlement",
        );
        return null;
      },
    );
    return {
      result: executed.value,
      funding: "wallet",
      chargedPaise: settled?.chargedPaise ?? target.paise,
    };
  } catch (error) {
    if (
      !(error instanceof WalletProviderSuccessPersistenceError) &&
      !(error instanceof WalletProviderPostSuccessError)
    ) {
      await refundWallet(
        args.req.tenantId,
        reservation,
        `${args.operationKind} failed`,
      ).catch((refundError) =>
        args.req.log.error({ err: refundError }, "Failed to refund script wallet reservation"),
      );
    }
    throw error;
  }
}

/**
 * A deliberately slow speaking-rate estimate. It includes sentence gaps and
 * the narration tail, so the route can refuse a plate that would end before
 * its dialogue before it reserves any video funding.
 */
function minimumDialoguePlateDurationSec(dialogue: string): number {
  const words = dialogue.trim().split(/\s+/).filter(Boolean).length;
  const sentences = Math.max(1, splitIntoSentences(dialogue).length);
  return Math.max(3, Math.ceil(words / 1.8 + Math.max(0, sentences - 1) * 0.25 + 0.6));
}

function supportsSelectableLipSyncQuality(engine: string): boolean {
  return engine === "lip_sync" || engine === "dialogue_lip_sync";
}

const VIDEO_MODE_DISABLED_MESSAGES = {
  videoTextToVideo: "Text to Video is currently turned off.",
  videoAnimatePhoto: "Animate Photo is currently turned off.",
  videoSlideshow: "Photo Slideshow is currently turned off.",
  videoTopicToVideo: "Topic to Video is currently turned off.",
} as const;

async function rejectDisabledVideoMode(
  engine: string,
  res: Response,
): Promise<boolean> {
  const feature = videoModeFeature(engine);
  if (!feature || (await isFeatureEnabled(feature))) return false;
  res.status(403).json({
    error: VIDEO_MODE_DISABLED_MESSAGES[feature],
    code: "feature_disabled",
  });
  return true;
}

/**
 * Adjust a wallet-funded job's reserved TOTALS in place.
 *
 * The job row holds the aggregate of every reserve made for it (the enqueue
 * reservation plus any scene added during storyboard review), because the
 * refund and settle paths rebuild exactly one reservation from those columns.
 * Deltas are applied in SQL so two concurrent scene inserts cannot clobber
 * each other's increment.
 */
async function addToJobReservation(
  jobId: number,
  paiseDelta: number,
  unitsDelta: number,
): Promise<void> {
  await db
    .update(videoGenerationsTable)
    .set({
      walletReservedPaise: sql`coalesce(${videoGenerationsTable.walletReservedPaise}, 0) + ${paiseDelta}`,
      walletReservedUnits: sql`greatest(coalesce(${videoGenerationsTable.walletReservedUnits}, 1) + ${unitsDelta}, 1)`,
      updatedAt: new Date(),
    })
    .where(eq(videoGenerationsTable.id, jobId));
}

/**
 * Video generation endpoints. Generation is long-running, so POST
 * /ai/generate-video only validates + reserves funding + creates a
 * video_generations row, then hands the heavy work to an in-process
 * background job. Clients poll GET /ai/video-jobs/{id} until the job settles.
 */

/** The exact clip prompt an animate-photo render sends (see serializeVideoJob). */
function animatePhotoAiPrompt(job: VideoGeneration): string {
  const scene = job.storyboard?.scenes[0];
  if (job.storyboard && scene) {
    return compiledClipPrompt(
      scene.visual,
      clampSceneDuration(job.storyboard, scene.durationSec),
    );
  }
  return compiledClipPrompt(job.prompt ?? "", job.options?.durationSec ?? 5);
}

/** Server-derived treatment constraints; never accept creative direction from a client. */
function verticalCreativeDirection(
  aspectRatio: string | null | undefined,
  scriptVariant: string | null | undefined,
): CreativeDirection {
  const vertical = aspectRatio === "9:16" || aspectRatio === "3:4" || aspectRatio === "4:5";
  return {
    version: 1,
    narrative: {
      guidance: vertical
        ? `Compose for a vertical ${aspectRatio} frame: keep essential action centered and readable within a narrow crop.`
        : `Compose for a ${aspectRatio ?? "16:9"} frame with clear subject-safe framing.`,
      ...(scriptVariant === "short_form" ? { pacing: "brisk" as const } : {}),
    },
    visual: { composition: vertical ? "centered" : "rule_of_thirds" },
  };
}

/** Bounded brand treatment distilled only from the tenant-owned active payload. */
function brandCreativeDirection(payload: Awaited<ReturnType<typeof loadActivePayload>>): CreativeDirection | null {
  if (!payload) return null;
  const colors = [...payload.payload.colors.primary, ...payload.payload.colors.secondary]
    .map((color) => color.hex.trim())
    .filter((color) => /^#?[0-9a-f]{6}$/i.test(color))
    .slice(0, 8);
  const traits = payload.payload.voice.traits.filter(Boolean).slice(0, 5);
  const audience = payload.payload.identity.audience.filter(Boolean).slice(0, 3);
  const guidance = [
    traits.length ? `Use a ${traits.join(", ")} brand voice.` : null,
    audience.length ? `Address ${audience.join(", ")}.` : null,
  ].filter(Boolean).join(" ");
  const restricted = payload.payload.brand_controls.restricted_terms
    .filter(Boolean)
    .slice(0, 24);
  if (!guidance && colors.length === 0 && restricted.length === 0) return null;
  return {
    version: 1,
    ...(guidance ? { narrative: { guidance, forbiddenVocabulary: restricted } } : restricted.length ? { narrative: { forbiddenVocabulary: restricted } } : {}),
    ...(colors.length ? { visual: { palette: colors } } : {}),
  };
}

function serializeVideoJob(job: VideoGeneration, retryableOverride?: boolean) {
  const recovery = job.options?.recovery;
  const legacyRetry = job.options?.characterDialogue?.retry;
  const failedInventory =
    job.status === "failed" && RECOVERABLE_VIDEO_ENGINES.has(job.engine)
      ? videoRecoveryInventory(job)
      : null;
  return {
    id: job.id,
    engine: job.engine,
    status: job.status,
    prompt: job.prompt ?? null,
    // Transparency: the exact prompt the video model receives. Storyboard
    // engines show their per-scene prompts in the storyboard instead. When an
    // animate-photo job HAS a storyboard, the render uses the (editable) scene
    // prompt and its clamped length — so derive from those, never job.prompt,
    // or the shown text could diverge from what was actually sent.
    aiPrompt: job.engine === "image_to_video" ? animatePhotoAiPrompt(job) : null,
    sourceImagePaths: job.sourceImagePaths ?? [],
    aspectRatio: job.options?.aspectRatio ?? "9:16",
    modelId: job.options?.modelId ?? null,
    resolution: job.options?.resolution ?? null,
    motionPreset: job.options?.motionPreset ?? null,
    cinematography: job.options?.cinematography ?? null,
    seed: job.options?.seed ?? null,
    resolvedCreativeBrief: job.options?.resolvedCreativeBrief ?? null,
    videoPath: job.videoPath ?? null,
    thumbnailPath: job.thumbnailPath ?? null,
    provider: job.provider ?? null,
    model: job.model ?? null,
    error: job.error ?? null,
    stage: job.stage ?? null,
    durationMs: job.durationMs ?? null,
    // How many video units this job actually charges (multi-shot clips,
    // character/AI-visual scene groups, review-added scenes, AI music bed).
    // Prefer the persisted wallet reservation when present (it tracks
    // review-time additions transactionally); otherwise recompute from the
    // options, which videoJobUnits keeps in sync with every funding path.
    units: job.walletReservedUnits ?? videoJobUnits(job.engine, job.options),
    retryable:
      retryableOverride ??
      (job.status === "failed" &&
        RECOVERABLE_VIDEO_ENGINES.has(job.engine) &&
        legacyRetry?.childJobId == null),
    recovery:
      recovery || failedInventory
        ? {
            mode: recovery?.mode ?? failedInventory!.mode,
            chainId: recovery?.chainId ?? job.id,
            sourceJobId: recovery?.sourceJobId ?? job.id,
            reusable: recovery?.reusable ?? failedInventory!.reusable,
            regenerated: recovery?.regenerated ?? failedInventory!.regenerated,
          }
        : null,
    // Per-unit display rate frozen at charge time; null on legacy rows,
    // which clients price at the current rate instead.
    chargedRatePaise: job.chargedRatePaise ?? null,
    // The REAL snapshotted tenant-facing spend for this job (all units
    // summed), taken from its usage events at settle. Null until the job
    // succeeds or on legacy rows; clients fall back to chargedRatePaise x units.
    spendPaise: job.spendPaise ?? null,
    storyboard: job.storyboard ?? null,
    storyboardExpiresAt: job.storyboardExpiresAt?.toISOString() ?? null,
    // Localized dub result snapshot: populated on success for localized_dub
    // jobs; null on all other engines or before the job succeeds.
    localizedResult: job.localizedResult ?? null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

const RECOVERABLE_VIDEO_ENGINES = new Set([
  "topic_to_video",
  "dialogue_lip_sync",
  "text_to_video",
  "image_to_video",
  "slideshow",
  "lip_sync",
]);

const musicStorage = new ObjectStorageService();

/**
 * Parse a free-text topic into structured script inputs.
 *
 * Deliberately cheap and side-effect free: it exists so the studio can
 * pre-fill the script request and ask the user about the two or three fields
 * that are genuinely missing, instead of showing a twelve-field form.
 */
router.post("/ai/script-intake", async (req: Request, res: Response) => {
  const parsed = AnalyzeScriptIntakeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Describe the topic in 3-2000 characters." });
    return;
  }
  if (!(await isFeatureEnabled("lipSync"))) {
    res.status(403).json({
      error: "Spokesperson videos are currently turned off.",
      code: "feature_disabled",
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

  const startedAt = Date.now();
  try {
    const body = parsed.data;
    const billed = await runBillableScriptRequest({
      req,
      tenantModel: tenant.aiModel,
      operationKind: "video_script_intake",
      perform: () => analyzeScriptIntake({
        tenantId: req.tenantId,
        tenantAiModel: tenant.aiModel,
        topic: body.topic.trim(),
        variant: isPromptVariantKey(body.variant) ? body.variant : null,
        hasBrandKit: Boolean(body.brandKitId),
      }),
    });
    if (!billed) {
      res.status(402).json({ error: "Your wallet balance can't cover script analysis. Recharge to continue." });
      return;
    }
    const { result } = billed;
    await recordUsage(req.tenantId, "caption", {
      requestBytes: Buffer.byteLength(body.topic),
      responseBytes: Buffer.byteLength(JSON.stringify(result)),
      durationMs: Date.now() - startedAt,
      provider: result.provider,
      model: result.model,
      funding: billed.funding,
      displayPaiseOverride: billed.chargedPaise,
      ...(result.inputTokens !== null ? { inputTokens: result.inputTokens } : {}),
      ...(result.outputTokens !== null ? { outputTokens: result.outputTokens } : {}),
      ...(result.costPaise !== null ? { costPaise: result.costPaise } : {}),
    }).catch((error) => {
      req.log.warn({ err: error }, "Script intake usage recording failed");
    });
    res.json({
      suggestedVariant: result.suggestedVariant,
      variantConfidence: result.variantConfidence,
      desiredTakeaway: result.desiredTakeaway,
      extractedFacts: result.extractedFacts,
      detectedLanguage: result.detectedLanguage,
      gaps: result.gaps,
    });
  } catch (error) {
    if (error instanceof TextGenNotConfiguredError) {
      res.status(503).json({ error: "AI script writing is not configured. Contact your admin." });
      return;
    }
    req.log.warn({ err: error }, "Script intake failed");
    res.status(502).json({
      error:
        error instanceof VideoGenProviderError
          ? error.message
          : "Reading the topic failed. Please try again.",
    });
  }
});

/** Draft a spoken script without creating or funding a video job. */
router.post("/ai/spokesperson-script", async (req: Request, res: Response) => {
  const parsed = GenerateSpokespersonScriptBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Describe the topic in 3-2000 characters." });
    return;
  }
  if (!(await isFeatureEnabled("lipSync"))) {
    res.status(403).json({
      error: "Spokesperson videos are currently turned off.",
      code: "feature_disabled",
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

  const startedAt = Date.now();
  try {
    const body = parsed.data;
    if (body.targetLocale && !characterDialogueLocale(body.targetLocale)) {
      res.status(400).json({ error: `Unsupported target locale: ${body.targetLocale}.` });
      return;
    }
    const billed = await runBillableScriptRequest({
      req,
      tenantModel: tenant.aiModel,
      operationKind: "video_script_draft",
      perform: () => generateSpokespersonScript({
        tenantId: req.tenantId,
        tenantAiModel: tenant.aiModel,
        topic: body.topic.trim(),
        variant: isPromptVariantKey(body.variant) ? body.variant : null,
        durationSeconds: body.durationSeconds ?? null,
        // Brand and style ids only; the values behind them are resolved
        // server-side so a client can never assert its own brand rules.
        brandKitId: body.brandKitId ?? null,
        styleProfileId: body.styleProfileId ?? null,
        targetLocale: body.targetLocale ?? null,
        overrides: {
          audience: body.audience ?? null,
          desiredTakeaway: body.desiredTakeaway ?? null,
          cta: body.cta ?? null,
          toneNote: body.toneNote ?? null,
          presenterPersona: body.presenterPersona ?? null,
          sourceFacts: body.sourceFacts ?? null,
          bannedTerms: body.bannedTerms ?? null,
        },
      }),
    });
    if (!billed) {
      res.status(402).json({ error: "Your wallet balance can't cover script writing. Recharge to continue." });
      return;
    }
    const { result } = billed;
    await recordUsage(req.tenantId, "caption", {
      requestBytes: Buffer.byteLength(parsed.data.topic),
      responseBytes: Buffer.byteLength(result.script),
      durationMs: Date.now() - startedAt,
      provider: result.provider,
      model: result.model,
      funding: billed.funding,
      displayPaiseOverride: billed.chargedPaise,
      ...(result.inputTokens !== null ? { inputTokens: result.inputTokens } : {}),
      ...(result.outputTokens !== null ? { outputTokens: result.outputTokens } : {}),
      ...(result.costPaise !== null ? { costPaise: result.costPaise } : {}),
      ...(result.cachedInputTokens !== null
        ? { cachedInputTokens: result.cachedInputTokens }
        : {}),
      ...(result.reasoningTokens !== null
        ? { reasoningTokens: result.reasoningTokens }
        : {}),
    }).catch((error) => {
      req.log.warn({ err: error }, "Spokesperson script usage recording failed");
    });
    res.json({
      script: result.script,
      ...(result.variant ? { variant: result.variant } : {}),
      // Omitted rather than empty so a model that returned only a flat script
      // reads as "no production doc" instead of "a doc with no beats".
      ...(result.beats.length > 0 ? { beats: result.beats } : {}),
      meta: result.meta,
    });
  } catch (error) {
    if (error instanceof TextGenNotConfiguredError) {
      res.status(503).json({ error: "AI script writing is not configured. Contact your admin." });
      return;
    }
    req.log.warn({ err: error }, "Spokesperson script generation failed");
    res.status(502).json({
      error:
        error instanceof VideoGenProviderError
          ? error.message
          : "Writing the spokesperson script failed. Please try again.",
    });
  }
});

async function serializeVideoCostModel(args: {
  provider: string;
  model: string;
  usdToInrPaise: number;
  feePercent: number;
  exactProviderOnly?: boolean;
}) {
  const price = await findModelPrice(
    "video",
    args.provider,
    args.model,
    args.exactProviderOnly ? { exactProviderOnly: true } : undefined,
  );
  const chargeRate = (usd: number | null): number | null => {
    if (usd === null) return null;
    const basePaise = usdToPaise(usd, args.usdToInrPaise);
    return basePaise === null ? null : withFee(basePaise, args.feePercent);
  };
  return {
    provider: args.provider,
    model: args.model,
    paisePerSecond: chargeRate(price?.usdPerSecond ?? null),
    paisePerVideo: chargeRate(price?.usdPerVideo ?? null),
  };
}

/** A tenant-authenticated, server-owned snapshot; clients never choose models, prices, or fonts. */
router.get("/ai/video-capabilities", async (_req: Request, res: Response): Promise<void> => {
  // High Quality is a built-in selectable model rather than an admin-picked
  // default. Lazily sync its public Replicate price the first time Studio asks
  // for capabilities, then keep using the catalog row like every other model.
  const existingHighPrice = await findModelPrice(
    "video",
    "replicate",
    SYNC_LIPSYNC_2.model,
    { exactProviderOnly: true },
  );
  if (!existingHighPrice) {
    await syncModelPricingBestEffort([
      { kind: "video", provider: "replicate", model: SYNC_LIPSYNC_2.model },
    ]);
  }
  const [selection, costConfig, spendConfig] = await Promise.all([
    getVideoGenSelection(),
    getAiCostConfig(),
    getAiSpendConfig(),
  ]);
  const provider = await resolveVideoGenProviderDef(selection.provider);
  const common = {
    usdToInrPaise: costConfig.usdToInrPaise,
    feePercent: spendConfig.feePercent,
  };
  const [textToVideo, imageToVideo, lipSync, serializedLipSyncHigh] = await Promise.all([
    provider
      ? serializeVideoCostModel({
          ...common,
          provider: provider.id,
          model: effectiveVideoModel(provider, "text", selection.textToVideoModel),
        })
      : null,
    provider
      ? serializeVideoCostModel({
          ...common,
          provider: provider.id,
          model: effectiveVideoModel(provider, "image", selection.imageToVideoModel),
        })
      : null,
    serializeVideoCostModel({
      ...common,
      provider: "replicate",
      model: LATENT_SYNC.model,
    }),
    serializeVideoCostModel({
      ...common,
      provider: "replicate",
      model: SYNC_LIPSYNC_2.model,
      exactProviderOnly: true,
    }),
  ]);
  const lipSyncHigh =
    serializedLipSyncHigh.paisePerSecond !== null &&
    serializedLipSyncHigh.paisePerSecond > 0
      ? serializedLipSyncHigh
      : null;
  res.json(
    GetVideoCapabilitiesResponse.parse({
      characterDialogueLocales: ELEVEN_V3_LOCALES,
      costModels: { textToVideo, imageToVideo, lipSync, lipSyncHigh },
    }),
  );
});

/** Built-in background-music library: search commercially-usable CC tracks. */
router.get("/ai/music/search", async (req: Request, res: Response) => {
  const q = String(req.query.q ?? "").trim();
  if (q.length < 2 || q.length > 80) {
    res.status(400).json({ error: "Search for 2-80 characters." });
    return;
  }
  try {
    res.json({ tracks: await searchLibraryMusic(q) });
  } catch (error) {
    req.log.warn({ err: error }, "Music library search failed");
    const message =
      error instanceof MusicLibraryError ? error.message : "Music search failed. Please try again.";
    res.status(502).json({ error: message });
  }
});

/** Import a chosen library track into tenant storage → musicPath. */
router.post("/ai/music/import", async (req: Request, res: Response) => {
  const parsed = ImportLibraryMusicBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  try {
    const bytes = await downloadLibraryTrack(parsed.data.audioUrl);
    const uploadURL = await musicStorage.getObjectEntityUploadURL(req.tenantId);
    const putRes = await fetch(uploadURL, {
      method: "PUT",
      headers: { "Content-Type": "audio/mpeg" },
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(60_000),
    });
    if (!putRes.ok) {
      res.status(502).json({ error: "Saving the track to storage failed." });
      return;
    }
    res.json({
      musicPath: musicStorage.normalizeObjectEntityPath(uploadURL),
      title: parsed.data.title,
    });
  } catch (error) {
    req.log.warn({ err: error }, "Music library import failed");
    const message =
      error instanceof MusicLibraryError
        ? error.message
        : "Importing the track failed. Please try again.";
    res.status(400).json({ error: message });
  }
});

/**
 * The models this workspace may generate with: on the admin's allowlist, and
 * served by a provider whose key is saved. Capability travels with each one
 * so the studio can render only the controls that model supports — offering a
 * duration a model cannot render is how the old fixed slider produced a
 * 7-second request that came back at 5 with no explanation.
 */
router.get("/ai/video-models", async (_req: Request, res: Response) => {
  const models = await availableVideoModels();
  res.json({
    models: models.map((m) => ({
      id: m.id,
      label: m.label,
      blurb: m.blurb,
      provider: m.provider,
      tier: m.tier,
      unitMultiplier: TIER_UNIT_MULTIPLIER[m.tier],
      modes: (["text", "image"] as const).filter((mode) => Boolean(m.models[mode])),
      aspects: [...m.aspects],
      durations: [...m.durations],
      resolutions: [...m.resolutions],
      hasQuality: m.hasQuality,
      canGenerateAudio: m.canGenerateAudio,
      supportsEndFrame: m.supportsEndFrame === true,
    })),
  });
});

/**
 * The optics catalog: camera bodies, lenses, focal lengths and apertures.
 * Static per deploy, like the motion presets, and read the same way.
 */
router.get("/ai/video-cinematography", (_req: Request, res: Response) => {
  res.json({
    cameras: CAMERAS.map(({ id, label }) => ({ id, label })),
    lenses: LENSES.map(({ id, label }) => ({ id, label })),
    focalLengths: FOCAL_LENGTHS.map(({ mm, label }) => ({ mm, label })),
    apertures: APERTURES.map(({ id, label }) => ({ id, label })),
  });
});

/**
 * The camera-motion preset catalog. Static per deploy and not tenant-scoped,
 * so it is a plain read with no funding, no kill switch and no cache headers
 * to get wrong — the ids are permanent, so clients cache it themselves.
 */
router.get("/ai/video-motion-presets", (_req: Request, res: Response) => {
  res.json({
    categories: MOTION_PRESET_CATEGORIES,
    presets: MOTION_PRESETS.map(({ id, label, category }) => ({ id, label, category })),
  });
});

router.post("/ai/generate-video", async (req: Request, res: Response) => {
  const parsed = GenerateVideoBody.safeParse(req.body);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const field = firstIssue?.path.join(".");
    req.log.warn(
      { issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })) },
      "Video generation input validation failed",
    );
    res.status(400).json({
      error:
        firstIssue && field
          ? `Invalid ${field}: ${firstIssue.message}`
          : "Invalid video generation input.",
    });
    return;
  }
  const body = parsed.data;
  if (
    body.lipSyncQuality !== undefined &&
    !supportsSelectableLipSyncQuality(body.engine)
  ) {
    res.status(400).json({
      error:
        "Lip-sync quality can only be selected for video lip sync or dialogue lip sync.",
    });
    return;
  }
  const lipSyncQuality: LipSyncQuality =
    supportsSelectableLipSyncQuality(body.engine) && body.lipSyncQuality === "high"
      ? "high"
      : "standard";
  // OpenAPI supplies a 5s default for legacy engines. Dialogue plates instead
  // default to their script-derived safe duration, so retain whether the
  // caller actually selected a duration.
  const requestHasDurationSec = Object.prototype.hasOwnProperty.call(req.body ?? {}, "durationSec");

  // Mode switches are checked before input expansion, provider preflight, or
  // funding so a disabled mode cannot consume quota, credits, or wallet funds.
  if (await rejectDisabledVideoMode(body.engine, res)) return;

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
  if (body.engine === "lip_sync") {
    // Kill switch checked BEFORE funding, like every other engine gate.
    if (!(await isFeatureEnabled("lipSync"))) {
      res.status(403).json({ error: "Lip-synced videos are currently turned off.", code: "feature_disabled" });
      return;
    }
    // A voice track replaces the script: with a recording there is nothing to
    // synthesise, so demanding a script would be demanding busywork.
    if (!body.audioPath && !body.prompt?.trim()) {
      res.status(400).json({ error: "A script is required for a lip-synced video." });
      return;
    }
    if (!body.sourceVideoPath && !body.sourceImagePath) {
      res.status(400).json({
        error: "A base video or a portrait photo is required for a lip-synced video.",
      });
      return;
    }
    if (body.sourceVideoPath && body.sourceImagePath) {
      res.status(400).json({
        error: "Send either a base video or a portrait photo, not both.",
      });
      return;
    }
    if (body.sourceImagePath && lipSyncQuality === "high") {
      res.status(400).json({
        error:
          "High Quality lip sync currently needs a video source. Portrait lip sync uses the platform's configured portrait model.",
      });
      return;
    }
    // Consent is a hard gate, not a checkbox for show: this feature redraws a
    // real person's mouth, so it only runs on footage the workspace owns or
    // has permission to use.
    if (body.lipSyncConsent !== true) {
      res.status(400).json({
        error:
          "Please confirm the video is your own footage (or you have permission to use it) before generating.",
      });
      return;
    }
  }
  if (body.engine === "dialogue_lip_sync") {
    // This pipeline combines all three governed capabilities. Check every
    // switch before provider preflight or funding so a disabled capability
    // cannot spend quota, credits, or wallet funds.
    if (!(await isFeatureEnabled("videoGen"))) {
      res.status(403).json({
        error: "Video Studio is currently turned off.",
        code: "feature_disabled",
      });
      return;
    }
    if (!(await isFeatureEnabled("lipSync"))) {
      res.status(403).json({
        error: "Lip-synced videos are currently turned off.",
        code: "feature_disabled",
      });
      return;
    }
    if (!(await isFeatureEnabled("brandVoiceClone"))) {
      res.status(403).json({
        error: "Brand Voice is currently turned off.",
        code: "feature_disabled",
      });
      return;
    }
    if (!body.prompt?.trim()) {
      res.status(400).json({ error: "An AI-person visual prompt is required." });
      return;
    }
    if (!body.dialogue?.trim()) {
      res.status(400).json({ error: "Dialogue is required for a dialogue lip-sync video." });
      return;
    }
    if (body.characterDialogue) {
      if (body.characterDialogue.scriptApproved !== true) {
        res.status(400).json({ error: "Please approve the script before creating a character dialogue video." });
        return;
      }
      if (!characterDialogueLocale(body.characterDialogue.locale)) {
        res.status(400).json({ error: `Unsupported locale: ${body.characterDialogue.locale}.` });
        return;
      }
      if (body.characterId == null) {
        res.status(400).json({ error: "Pick a saved character for a character dialogue video." });
        return;
      }
      if (body.brandKitId == null) {
        res.status(400).json({ error: "Character dialogue requires an active Brand Kit with a cloned voice." });
        return;
      }
    }
    if (body.aiPersonConsent !== true) {
      res.status(400).json({
        error:
          "Please confirm you are authorized to create this AI person or likeness and make them speak the dialogue.",
      });
      return;
    }
    const minimumDurationSec = minimumDialoguePlateDurationSec(body.dialogue);
    const requestedDurationSec = requestHasDurationSec ? (body.durationSec ?? 5) : minimumDurationSec;
    const dialogueLimit = body.characterDialogue
      ? MAX_CHARACTER_DIALOGUE_DURATION_SEC
      : MAX_DIALOGUE_LIP_SYNC_DURATION_SEC;
    if (minimumDurationSec > dialogueLimit) {
      res.status(400).json({
        error: `This dialogue needs about ${minimumDurationSec} seconds. Dialogue lip-sync videos support up to ${dialogueLimit} seconds.`,
      });
      return;
    }
    if (requestedDurationSec < minimumDurationSec) {
      res.status(400).json({
        error: `This dialogue needs at least ${minimumDurationSec} seconds. Increase the video duration so the full script can be spoken.`,
      });
      return;
    }
    // A much longer visual plate cannot be checked against the spoken track
    // meaningfully and can leave a silent talking head at the end.
    if (!body.characterDialogue && requestedDurationSec > Math.ceil(minimumDurationSec * 1.25)) {
      res.status(400).json({
        error: `Choose a duration between ${minimumDurationSec} and ${Math.ceil(minimumDurationSec * 1.25)} seconds for this dialogue.`,
      });
      return;
    }
  }
  if (lipSyncQuality === "high") {
    const [price, costConfig] = await Promise.all([
      findModelPrice("video", "replicate", SYNC_LIPSYNC_2.model, {
        exactProviderOnly: true,
      }),
      getAiCostConfig(),
    ]);
    const hasProviderPrice =
      typeof price?.usdPerSecond === "number" &&
      Number.isFinite(price.usdPerSecond) &&
      price.usdPerSecond > 0;
    if (
      !hasProviderPrice ||
      !Number.isFinite(costConfig.usdToInrPaise) ||
      costConfig.usdToInrPaise <= 0
    ) {
      res.status(400).json({
        error:
          "High Quality lip-sync pricing is currently unavailable. Reload Video Studio to refresh the Replicate catalog, or ask an administrator to configure sync/lipsync-2 pricing.",
      });
      return;
    }
  }
  let localizedNarration: LocalizedNarrationSelection | null = null;
  if (body.engine === "localized_dub") {
    // Kill switch: localization is gated by the videoLocalization feature flag,
    // checked BEFORE funding so a disabled mode never burns quota or credits.
    if (!(await isFeatureEnabled("videoLocalization"))) {
      res.status(403).json({
        error: "Video localization is currently turned off.",
        code: "feature_disabled",
      });
      return;
    }
    // Lip-sync kill switch: localized_dub feeds into LatentSync, so it needs
    // this gate too.
    if (!(await isFeatureEnabled("lipSync"))) {
      res.status(403).json({
        error: "Lip-synced videos are currently turned off.",
        code: "feature_disabled",
      });
      return;
    }
    if (!body.sourceVideoPath) {
      res.status(400).json({ error: "A source video is required for a localized dub." });
      return;
    }
    if (!body.localizedTrack) {
      res.status(400).json({ error: "A localized track is required for a localized dub." });
      return;
    }
    // scriptApproved is the hard gate: the workspace must have reviewed every
    // cue and confirmed the script. A false value is rejected before funding.
    if (body.localizedTrack.scriptApproved !== true) {
      res.status(400).json({
        error: "Please approve the script before submitting a localized dub job.",
      });
      return;
    }
    // The same top-level consent field gates both lip_sync and localized_dub.
    // The confirmed value is copied into the immutable job snapshot below.
    if (body.lipSyncConsent !== true) {
      res.status(400).json({
        error:
          "Please confirm the video is your own footage (or you have permission to use it) before generating.",
      });
      return;
    }
    const track = body.localizedTrack;
    const SUPPORTED_LOCALES = new Set(["te", "ta", "hi"]);
    if (!SUPPORTED_LOCALES.has(track.locale)) {
      res.status(400).json({ error: `Unsupported locale: ${track.locale}. Use te, ta, or hi.` });
      return;
    }

    const voiceMode = (track.voiceMode ?? "stock") as "stock" | "brand_voice" | "source_voice";

    if (voiceMode === "stock") {
      // Only normalize for stock mode (provider/model/speaker fields required).
      try {
        localizedNarration = normalizeLocalizedNarrationSelection(track);
      } catch (error) {
        res.status(400).json({
          error: error instanceof Error ? error.message : "Invalid localized narration selection.",
        });
        return;
      }
    } else if (voiceMode === "brand_voice") {
      // brand_voice requires a brandKitId on the job — verified at load time in
      // the runner against the tenant's kits; we just check it is present here.
      if (!body.brandKitId) {
        res.status(400).json({
          error:
            "Brand-voice dubbing requires a brand kit. Set brandKitId to the kit that has a configured cloned voice.",
        });
        return;
      }
      // brand_voice requires the brandVoiceClone kill switch.
      if (!(await isFeatureEnabled("brandVoiceClone"))) {
        res.status(403).json({
          error: "Brand voice cloning is currently turned off.",
          code: "feature_disabled",
        });
        return;
      }
    } else if (voiceMode === "source_voice") {
      // Source-voice mode creates a temporary ElevenLabs clone from the
      // provider-preserved dub, so the same execution kill switch applies.
      if (!(await isFeatureEnabled("brandVoiceClone"))) {
        res.status(403).json({
          error: "Brand voice cloning is currently turned off.",
          code: "feature_disabled",
        });
        return;
      }
      // The ElevenLabs key is checked in preflight before funding.
    }

    if (!track.cues || track.cues.length === 0) {
      res.status(400).json({ error: "At least one cue is required for a localized dub." });
      return;
    }
    if (track.cues.length > 300) {
      res.status(400).json({ error: "A localized dub supports at most 300 cues." });
      return;
    }
    // Validate cue ordering: indices must be unique and ascending, endMs > startMs,
    // and cues must not overlap each other.
    const seenIndices = new Set<number>();
    for (let i = 0; i < track.cues.length; i++) {
      const cue = track.cues[i]!;
      if (
        !Number.isInteger(cue.index) ||
        !Number.isInteger(cue.startMs) ||
        !Number.isInteger(cue.endMs)
      ) {
        res.status(400).json({
          error: `Cue ${cue.index}: index and timing values must be whole numbers.`,
        });
        return;
      }
      if (seenIndices.has(cue.index)) {
        res.status(400).json({ error: `Duplicate cue index: ${cue.index}.` });
        return;
      }
      seenIndices.add(cue.index);
      if (!cue.text || cue.text.trim().length === 0) {
        res.status(400).json({
          error: `Cue ${cue.index}: text must not be blank.`,
        });
        return;
      }
      if (cue.endMs <= cue.startMs) {
        res.status(400).json({
          error: `Cue ${cue.index}: endMs must be greater than startMs.`,
        });
        return;
      }
      if (cue.endMs > MAX_LOCALIZED_DUB_DURATION_MS) {
        res.status(400).json({
          error: `Cue ${cue.index}: localized dubs support source videos up to 30 minutes.`,
        });
        return;
      }
      if (i > 0) {
        const prev = track.cues[i - 1]!;
        if (cue.index <= prev.index) {
          res.status(400).json({
            error: `Cues must be in ascending index order (cue ${cue.index} follows ${prev.index}).`,
          });
          return;
        }
        if (cue.startMs < prev.endMs) {
          res.status(400).json({
            error: `Cue ${cue.index} overlaps cue ${prev.index} (starts at ${cue.startMs} ms before previous ends at ${prev.endMs} ms).`,
          });
          return;
        }
      }
    }
  }
  if (body.sourceVideoPath && !body.sourceVideoPath.startsWith(`/objects/${req.tenantId}/`)) {
    res.status(400).json({ error: "Invalid base video path." });
    return;
  }
  if (
    body.presenterVideoPath &&
    !body.presenterVideoPath.startsWith(`/objects/${req.tenantId}/`)
  ) {
    res.status(400).json({ error: "Invalid presenter video path." });
    return;
  }
  if (body.sourceImagePath && !body.sourceImagePath.startsWith(`/objects/${req.tenantId}/`)) {
    res.status(400).json({ error: "Invalid portrait path." });
    return;
  }
  if (body.audioPath && !body.audioPath.startsWith(`/objects/${req.tenantId}/`)) {
    res.status(400).json({ error: "Invalid voice track path." });
    return;
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
  // An unknown preset id is a client bug, not a silent default: a job funded
  // and rendered without the camera move the user picked is worse than a 400.
  if (body.motionPreset && !isMotionPresetId(body.motionPreset)) {
    res.status(400).json({ error: "That camera move is not available." });
    return;
  }
  // Optics: an unrecognised body, lens, focal length or aperture is a client
  // bug, and rendering without the look the user picked is worse than a 400.
  if (body.cinematography && !isValidCinematography(body.cinematography)) {
    res.status(400).json({ error: "That camera, lens, focal length or aperture is not available." });
    return;
  }
  // Model choice, validated BEFORE funding for the same reason: a premium
  // model costs four units, and reserving four units for a job that then
  // silently ran on the platform default would be charging for something the
  // tenant did not get.
  if (body.modelId) {
    if (body.engine === "slideshow") {
      res.status(400).json({ error: "A photo slideshow runs no AI model." });
      return;
    }
    const picked = findVideoModel(body.modelId);
    const enabled = picked && (await availableVideoModels()).some((m) => m.id === picked.id);
    if (!picked || !enabled) {
      res.status(400).json({ error: "That video model is not available." });
      return;
    }
    // text_to_video with a character locked, and every topic-video visual
    // mode, animate a generated keyframe — so they are image-to-video jobs
    // whatever their engine name says.
    const mode: "text" | "image" =
      body.engine === "text_to_video" && body.characterId == null ? "text" : "image";
    // A second photo on image_to_video means "end here". Silently dropping it
    // would render a video the user did not ask for and charge them for it.
    if (
      body.engine === "image_to_video" &&
      sourceImagePaths.length > 1 &&
      !supportsEndFrame(picked)
    ) {
      res.status(400).json({
        error: `${picked.label} cannot blend a start and end frame. Pick a model that can, or upload one photo.`,
      });
      return;
    }
    if (!supportsMode(picked, mode)) {
      res.status(400).json({
        error:
          mode === "image"
            ? `${picked.label} cannot animate an image. Pick a different model.`
            : `${picked.label} cannot generate from a prompt alone. Pick a different model.`,
      });
      return;
    }
  }

  const rawRequest = req.body as Record<string, unknown>;
  const requestHas = (key: string) => Object.prototype.hasOwnProperty.call(rawRequest, key);

  // A platform template is executable only when it is published, asset-free,
  // and visible through the same Reference Styles switch as the picker.
  let selectedTemplate: TemplateRow | null = null;
  let selectedStyleProfile: typeof videoStyleProfilesTable.$inferSelect | null = null;
  if (
    (body.engine === "topic_to_video" ||
      (body.engine === "dialogue_lip_sync" && body.characterDialogue != null)) &&
    body.styleProfileId != null &&
    (await isFeatureEnabled("referenceStyles"))
  ) {
    const profile = (
      await db
        .select()
        .from(videoStyleProfilesTable)
        .where(eq(videoStyleProfilesTable.id, body.styleProfileId))
        .limit(1)
    )[0];
    selectedStyleProfile =
      profile &&
      (profile.scope === "platform" || profile.tenantId === req.tenantId)
        ? profile
        : null;
    if (profile?.scope === "platform") {
      if (!profile.published || profile.sourceKind !== "curated") {
        res.status(400).json({ error: "That video template is not available." });
        return;
      }
      try {
        assertTemplateSafe(profile);
      } catch (error) {
        res.status(400).json({
          error:
            error instanceof UnsafeTemplateError
              ? "That video template is not safe to use. Ask an administrator to repair it."
              : "That video template is invalid.",
        });
        return;
      }
      selectedTemplate = profile;
    }
  }

  const presenterSlots =
    selectedTemplate?.slots.filter((slot) => slot.kind === "presenter_video") ?? [];
  if (presenterSlots.some((slot) => !slot.required)) {
    res.status(400).json({
      error:
        "That presenter template is invalid: its presenter video slot must be required.",
    });
    return;
  }
  const presenterTemplate = presenterSlots.some((slot) => slot.required);
  if (body.presenterVideoPath && !presenterTemplate) {
    res.status(400).json({
      error: "A presenter video can only be used with a curated presenter template.",
    });
    return;
  }
  const defaultValue = <T>(key: string, requestValue: T, fallback: T): T => {
    if (requestHas(key)) return requestValue;
    const value = selectedTemplate?.jobDefaults[key];
    return value === undefined || value === null ? fallback : (value as T);
  };

  // Character lock: validate the character (and outfit) belong to the caller
  // BEFORE funding, and resolve the effective outfit so the job is
  // self-describing even if the default outfit changes later.
  const requestedVisualsSource = defaultValue(
    "visualsSource",
    body.visualsSource,
    "stock",
  );
  const visualsSource =
    body.engine === "topic_to_video" &&
    (requestedVisualsSource === "character" ||
      requestedVisualsSource === "ai" ||
      requestedVisualsSource === "ai_video")
      ? requestedVisualsSource
      : body.engine === "dialogue_lip_sync" &&
          (requestedVisualsSource === "ai" || requestedVisualsSource === "ai_video")
        ? requestedVisualsSource
        : "stock";
  const wantsCharacter =
    visualsSource === "character" ||
    (body.engine === "text_to_video" && body.characterId != null) ||
    (body.engine === "dialogue_lip_sync" && body.characterDialogue != null);
  let characterId: number | null = null;
  let outfitId: number | null = null;
  if (wantsCharacter) {
    if (body.characterId == null) {
      res.status(400).json({ error: "Pick a character for a character video." });
      return;
    }
    const detail = await getCharacterDetail(req.tenantId, body.characterId);
    if (!detail) {
      res.status(400).json({ error: "That character does not exist." });
      return;
    }
    const outfit = resolveOutfit(detail, body.outfitId ?? null);
    if (!outfit) {
      res.status(400).json({ error: "That outfit does not exist." });
      return;
    }
    characterId = detail.character.id;
    outfitId = outfit.id;
  }

  if (selectedTemplate) {
    const needsBrand = selectedTemplate.slots.some(
      (slot) => slot.required && (slot.kind === "brand_kit" || slot.kind === "logo"),
    );
    let hasActiveBrandKit = false;
    if (needsBrand && body.brandKitId != null) {
      const [kit] = await db
        .select({ id: brandKitsTable.id })
        .from(brandKitsTable)
        .where(
          and(
            eq(brandKitsTable.id, body.brandKitId),
            eq(brandKitsTable.tenantId, req.tenantId),
            eq(brandKitsTable.status, "active"),
            eq(brandKitsTable.isArchived, false),
            isNotNull(brandKitsTable.activeVersionId),
          ),
        )
        .limit(1);
      hasActiveBrandKit = Boolean(kit);
    }
    const supplied: SuppliedSlots = {
      // A saved character is the presenter layer in either character
      // workflow, so presenter-style templates do not require a second upload.
      presenter_video: Boolean(body.presenterVideoPath || characterId),
      script: Boolean(body.prompt?.trim()),
      brand_kit: hasActiveBrandKit,
      character: characterId != null,
      music: Boolean(body.musicPath || body.musicPrompt?.trim()),
      logo: hasActiveBrandKit,
    };
    const missing = missingSlots(selectedTemplate.slots, supplied);
    if (missing.length > 0) {
      res.status(400).json({
        error: `This video template requires ${missing.map((slot) => slot.label).join(", ")}.`,
      });
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

  // A dialogue job may use only an active Brand Kit owned by this tenant.
  // Unlike ordinary best-effort branding, a user-selected speaking identity
  // is security-sensitive and must not silently accept a foreign/deleted id.
  if (body.engine === "dialogue_lip_sync" && body.brandKitId != null) {
    const [kit] = await db
      .select({ id: brandKitsTable.id })
      .from(brandKitsTable)
      .where(
        and(
          eq(brandKitsTable.id, body.brandKitId),
          eq(brandKitsTable.tenantId, req.tenantId),
          eq(brandKitsTable.status, "active"),
          eq(brandKitsTable.isArchived, false),
          isNotNull(brandKitsTable.activeVersionId),
        ),
      )
      .limit(1);
    if (!kit) {
      res.status(400).json({ error: "That Brand Voice is not available in this workspace." });
      return;
    }
  }
  let characterDialogue: VideoJobOptions["characterDialogue"] = null;
  if (body.engine === "dialogue_lip_sync" && body.characterDialogue) {
    const locale = characterDialogueLocale(body.characterDialogue.locale);
    const branding = await loadVideoBranding(req.tenantId, body.brandKitId!);
    if (!locale || !branding?.clonedVoice || branding.clonedVoice.provider !== "elevenlabs") {
      res.status(400).json({
        error: "Character dialogue requires an active Brand Kit with a cloned ElevenLabs voice.",
      });
      return;
    }
    if (characterId == null || outfitId == null) {
      res.status(400).json({ error: "The selected character outfit is not available." });
      return;
    }
    const scenes = planCharacterDialogueScenes(body.dialogue!, body.prompt!.trim(), locale);
    characterDialogue = {
      version: 1, scriptApproved: true, locale: locale.code, modelId: "eleven_v3",
      lipSyncModel:
        lipSyncQuality === "high" ? "sync/lipsync-2" : "bytedance/latentsync",
      direction: locale.direction, script: locale.script, scriptName: locale.script, fontCandidates: locale.fontCandidates,
      characterId, outfitId, brandKitId: body.brandKitId!, scenes,
    };
  }

  // Saved-plan reuse: send a prior job's AI scene plan (possibly hand-edited)
  // back into generation instead of planning fresh. Checked BEFORE funding —
  // a rejected plan must never burn quota. The plan is validated strictly
  // here (reject, never silently fix); the planners additionally run it
  // through the same clamps as a live AI reply, so a reused plan cannot break
  // the costume lock or the style rules.
  let suppliedPlan: { flow: "broll" | "character"; raw: unknown } | null = null;
  if (body.planSource) {
    if (body.engine !== "topic_to_video") {
      res.status(400).json({ error: "Saved plans apply to topic videos only." });
      return;
    }
    if (visualsSource !== "ai" && visualsSource !== "ai_video" && visualsSource !== "character") {
      res.status(400).json({
        error: "Saved plans apply to AI imagery or character visuals, not stock footage.",
      });
      return;
    }
    const expectedFlow = visualsSource === "character" ? "character" : "broll";
    // Tenant-scoped source job: reusing another workspace's plan is a 400,
    // indistinguishable from a job that never existed.
    const source = (
      await db
        .select()
        .from(videoGenerationsTable)
        .where(
          and(
            eq(videoGenerationsTable.id, body.planSource.jobId),
            eq(videoGenerationsTable.tenantId, req.tenantId),
          ),
        )
        .limit(1)
    )[0];
    if (!source) {
      res.status(400).json({ error: "The video that plan came from no longer exists." });
      return;
    }
    const savedPlan = source.storyboard?.aiPlan ?? null;
    // An edited plan overrides the saved one, but the source job still
    // anchors tenancy and provenance.
    const raw = body.planSource.plan ?? (savedPlan?.flow === expectedFlow ? savedPlan.raw : null);
    if (raw == null) {
      res.status(400).json({
        error:
          savedPlan && savedPlan.flow !== expectedFlow
            ? savedPlan.flow === "character"
              ? "That plan was made for character visuals — switch the visual style to match."
              : "That plan was made for AI imagery — switch the visual style to match."
            : "That video has no saved plan to reuse.",
      });
      return;
    }
    const planError = validateSuppliedPlan(expectedFlow, raw);
    if (planError) {
      res.status(400).json({ error: planError });
      return;
    }
    suppliedPlan = { flow: expectedFlow, raw };
  }

  let presenterBroll: VideoJobOptions["presenterBroll"] = null;
  if (presenterTemplate && body.presenterVideoPath) {
    try {
      const file = await musicStorage.getObjectEntityFile(
        body.presenterVideoPath,
        req.tenantId,
      );
      const [metadata] = await file.getMetadata();
      const size = Number(metadata.size ?? 0);
      if (size > MAX_PRESENTER_VIDEO_BYTES) {
        res.status(400).json({ error: "Presenter video is too large (max 100 MB)." });
        return;
      }
      const mimeType = String(metadata.contentType ?? "")
        .toLowerCase()
        .split(";")[0]
        .trim();
      if (!PRESENTER_VIDEO_TYPES.has(mimeType)) {
        res.status(400).json({
          error: "Unsupported presenter video type. Please upload an MP4, MOV, or WebM video.",
        });
        return;
      }
      const [presenterVideo] = await file.download();
      if (presenterVideo.byteLength > MAX_PRESENTER_VIDEO_BYTES) {
        res.status(400).json({ error: "Presenter video is too large (max 100 MB)." });
        return;
      }
      const durationMs = await probePresenterDurationMs(presenterVideo);
      const presenterAudio = await extractVoiceSampleFromVideo(presenterVideo);
      const transcription = await transcribeAudio({
        buffer: presenterAudio,
        mimeType: "audio/mpeg",
        filename: "presenter-audio.mp3",
        timestamps: true,
      });
      const lines = alignPresenterNarration({
        script: body.prompt?.trim() ?? "",
        durationMs,
        transcriptText: transcription.text,
        segments: transcription.segments,
      });
      presenterBroll = await planPresenterBrollTimeline({
        script: body.prompt?.trim() ?? "",
        tenantAiModel: tenant.aiModel,
        durationMs,
        lines,
      });
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        res.status(400).json({ error: "Presenter video not found." });
        return;
      }
      if (error instanceof PresenterBrollInputError) {
        res.status(400).json({ error: error.message });
        return;
      }
      if (error instanceof BaseVideoAudioExtractionError) {
        res.status(400).json({
          error: "The presenter video needs a clear spoken audio track.",
        });
        return;
      }
      if (error instanceof AsrNotConfiguredError || error instanceof AsrProviderError) {
        req.log.warn({ err: error }, "Presenter speech verification failed before funding");
        res.status(503).json({
          error:
            "We could not verify the spoken presenter script. Nothing was charged; please try again.",
        });
        return;
      }
      req.log.warn({ err: error }, "Presenter B-roll planning failed before funding");
      res.status(502).json({
        error: "Planning the presenter B-roll failed. Nothing was charged; please try again.",
      });
      return;
    }
  }
  if (
    presenterTemplate &&
    characterDialogue &&
    characterDialogue.scenes.length > 0 &&
    !presenterBroll
  ) {
    let cursorMs = 0;
    const lines = characterDialogue.scenes.map((scene, index) => {
      const startMs = cursorMs;
      cursorMs += Math.round(scene.estimatedDurationSec * 1000);
      return {
        index: index + 1,
        startMs,
        endMs: cursorMs,
        text: scene.text,
      };
    });
    presenterBroll = {
      version: 1,
      durationMs: cursorMs,
      lines,
      beats: characterDialogue.scenes.map((scene, index) => ({
        id: `cdb${index + 1}`,
        startMs: lines[index]!.startMs,
        endMs: lines[index]!.endMs,
        query:
          scene.text
            .trim()
            .split(/\s+/u)
            .slice(0, 8)
            .join(" ") || body.prompt!.trim(),
        kind: "lifestyle",
        opacity: 0.55,
        lineIndexes: [index + 1],
        assetPath: null,
        previewPath: null,
        assetKind: "video",
        provider: null,
      })),
      notes: ["Supporting B-roll follows the approved dialogue scene boundaries."],
    };
  }

  // Resolve portable creative intent once, before funding and enqueue. The
  // worker only reads this snapshot; it never re-reads a mutable template on a
  // resume/retry. Explicit Studio controls remain authoritative downstream.
  const activeBrandPayload =
    body.engine === "topic_to_video" && body.brandKitId != null
      ? await loadActivePayload(req.tenantId, body.brandKitId)
      : null;
  const legacyReferenceStyleGuidance =
    body.engine === "topic_to_video" && selectedStyleProfile
      ? await loadStyleGuidance(req.tenantId, selectedStyleProfile.id)
      : null;
  const resolvedCreativeBrief =
    body.engine === "topic_to_video"
      ? (() => {
          const effectiveAspectRatio = defaultValue("aspectRatio", body.aspectRatio, "9:16");
          const effectiveVariant = isPromptVariantKey(body.scriptVariant) ? body.scriptVariant : null;
          const brief = resolveCreativeBrief({
          jobDefaults: selectedTemplate?.jobDefaults ?? {},
          legacyPayload: selectedTemplate?.payload,
          template:
            (selectedTemplate?.payload?.creativeDirection as CreativeDirection | undefined) ??
            null,
          user:
            selectedStyleProfile?.scope === "tenant"
              ? (selectedStyleProfile.payload.creativeDirection ?? null)
              : null,
          vertical: verticalCreativeDirection(effectiveAspectRatio, effectiveVariant),
          brand: brandCreativeDirection(activeBrandPayload),
          topic: body.prompt?.trim(),
          references: {
            ...(selectedTemplate ? { template: `videoStyleProfile:${selectedTemplate.id}` } : {}),
            ...(selectedStyleProfile?.scope === "tenant"
              ? { user: `videoStyleProfile:${selectedStyleProfile.id}` }
              : {}),
            vertical: `videoFormat:${effectiveAspectRatio}`,
            ...(activeBrandPayload
              ? { brand: `brandKitVersion:${activeBrandPayload.kit.activeVersionId ?? "active"}` }
              : {}),
          },
          });
          if (!legacyReferenceStyleGuidance) return brief;
          const source = selectedStyleProfile?.scope === "tenant" ? "user" as const : "template" as const;
          const reference = selectedStyleProfile
            ? `videoStyleProfile:${selectedStyleProfile.id}`
            : undefined;
          const existing = brief.provenance.find((entry) => entry.source === source);
          return {
            ...brief,
            legacyReferenceStyleGuidance: legacyReferenceStyleGuidance.slice(0, 800),
            provenance: existing
              ? brief.provenance.map((entry) =>
                  entry === existing
                    ? {
                        ...entry,
                        fields: [...entry.fields, "legacyReferenceStyleGuidance"].sort(),
                      }
                    : entry,
                )
              : [
                  ...brief.provenance,
                  {
                    source,
                    ...(reference ? { reference } : {}),
                    fields: ["legacyReferenceStyleGuidance"],
                  },
                ],
          };
        })()
      : null;
  const creativeFragments = compileCreativeBrief(resolvedCreativeBrief);

  const options: VideoJobOptions = {
    aspectRatio: defaultValue("aspectRatio", body.aspectRatio, "9:16"),
    durationSec:
      body.engine === "dialogue_lip_sync"
        ? (requestHasDurationSec
            ? (body.durationSec ?? 5)
            : minimumDialoguePlateDurationSec(body.dialogue ?? ""))
        : defaultValue("durationSec", body.durationSec, 5),
    // Slideshows run no AI model, so a camera move has nothing to act on and
    // is dropped rather than stored as a promise the renderer cannot keep.
    motionPreset: body.engine === "slideshow" ? null : (body.motionPreset ?? null),
    // Normalized rather than stored raw: a job's options are replayed on every
    // retry, and an axis that has since left the catalog must degrade to "not
    // set" instead of failing a render months later.
    cinematography:
      body.engine === "slideshow" ? null : normalizeCinematography(body.cinematography),
    seed: body.engine === "slideshow" ? null : (body.seed ?? null),
    // Validated above. A slideshow runs no model, so it never carries one —
    // which also keeps videoJobUnits from ever multiplying a slideshow.
    modelId: body.engine === "slideshow" ? null : (body.modelId ?? null),
    resolution: body.engine === "slideshow" ? null : (body.resolution ?? null),
    quality: body.engine === "slideshow" ? null : (body.quality ?? null),
    generateAudio: body.engine === "slideshow" ? null : (body.generateAudio ?? null),
    // Prices the job (one unit per shot), so it is pinned here and the
    // storyboard editor cannot move it. shotCount 0 = "auto": the script
    // decides, resolved by one LLM call BEFORE funding is reserved so the
    // resolved number is what the job costs.
    shotCount:
      body.engine === "text_to_video"
        ? body.shotCount === 0
          ? await decideShotCountFromBrief(req.tenantId, body.prompt?.trim() ?? "")
          : clipShotCount(body.shotCount)
        : 1,
    slideDurationSec: defaultValue("slideDurationSec", body.slideDurationSec, 3),
    overlayText: defaultValue("overlayText", body.overlayText, null),
    musicPath: defaultValue("musicPath", body.musicPath, null),
    musicPrompt: body.musicPath
      ? null
      : body.musicPrompt?.trim()
        ? [body.musicPrompt.trim(), creativeFragments.music].filter(Boolean).join(", ")
        : creativeFragments.music,
    // Omitted = "no explicit choice": the job runner then prefers the brand
    // kit's preset voice (when one is set) before the default narrator.
    voice: body.voice,
    // Lip-sync inputs: validated above (feature switch, consent, tenant-scoped
    // path); persisted in options so the job — and the consent — is
    // self-describing.
    // localized_dub also uses sourceVideoPath (the base video to dub).
    sourceVideoPath:
      body.engine === "lip_sync" || body.engine === "localized_dub"
        ? (body.sourceVideoPath ?? null)
        : null,
    sourceImagePath: body.engine === "lip_sync" ? (body.sourceImagePath ?? null) : null,
    audioPath: body.engine === "lip_sync" ? (body.audioPath ?? null) : null,
    presenterVideoPath: presenterTemplate ? (body.presenterVideoPath ?? null) : null,
    videoTemplateId: selectedTemplate?.id ?? null,
    resolvedCreativeBrief,
    presenterBroll,
    lipSyncConsent: body.engine === "lip_sync" ? body.lipSyncConsent === true : undefined,
    lipSyncQuality: supportsSelectableLipSyncQuality(body.engine)
      ? lipSyncQuality
      : undefined,
    // Character-dialogue scenes are an immutable approved transcript: retain
    // every byte (including leading/trailing/newline whitespace). Legacy
    // single-plate dialogue keeps its historical trim behavior.
    dialogue: body.engine === "dialogue_lip_sync"
      ? (body.characterDialogue ? (body.dialogue ?? null) : (body.dialogue?.trim() ?? null))
      : null,
    aiPersonConsent:
      body.engine === "dialogue_lip_sync" ? body.aiPersonConsent === true : undefined,
    characterDialogue,
    // localized_dub: snapshot the approved, fully timed dub track at enqueue
    // time. The job runner reads this verbatim — immutable after enqueue.
    localizedTrack:
      body.engine === "localized_dub" && body.localizedTrack
        ? (() => {
            const track = body.localizedTrack!;
            const voiceMode = (track.voiceMode ?? "stock") as "stock" | "brand_voice" | "source_voice";
            const base = {
              scriptApproved: true as const,
              locale: track.locale as "te" | "ta" | "hi",
              voiceMode,
              // Consent for LatentSync lip-sync; required and confirmed above.
              lipSyncConsent: true as const,
              cues: track.cues.map((c) => ({
                index: c.index,
                startMs: c.startMs,
                endMs: c.endMs,
                text: c.text,
              })),
            };
            if (voiceMode === "stock" && localizedNarration) {
              return {
                ...base,
                provider: localizedNarration.provider,
                model: localizedNarration.model,
                speaker: localizedNarration.speaker,
                // Retain the legacy field on OpenAI snapshots so older workers
                // remain able to render a newly queued job during a rolling deploy.
                voice:
                  localizedNarration.provider === "openai"
                    ? (localizedNarration.speaker as
                        | "alloy"
                        | "echo"
                        | "fable"
                        | "onyx"
                        | "nova"
                        | "shimmer")
                    : undefined,
              };
            }
            return base;
          })()
        : null,
    stockSource: defaultValue("stockSource", body.stockSource, "auto"),
    subtitles: defaultValue("subtitles", body.subtitles, true),
    captionStyle: requestHas("captionStyle")
      ? body.captionStyle
      : (creativeFragments.captionStyle ??
        defaultValue("captionStyle", body.captionStyle, "classic")),
    paragraphCount: defaultValue("paragraphCount", body.paragraphCount, 1),
    visualsSource,
    characterId,
    outfitId,
    wardrobeNotes: body.wardrobeNotes?.trim() || null,
    // localized_dub never goes through storyboard review — the script is
    // already approved by the caller, and there is no plan to edit.
    // Every other engine uses the request field (defaults to true).
    reviewStoryboard:
      body.engine === "localized_dub"
        ? false
        : body.engine === "dialogue_lip_sync" && characterDialogue
          ? true
          : defaultValue("reviewStoryboard", body.reviewStoryboard, true),
    // Brand kit is tenant-scoped at load time in the job runner; storing a
    // foreign id just renders unbranded. Dropped entirely when the Brand
    // Video kill switch is off.
    brandKitId:
      body.engine === "lip_sync" || body.engine === "dialogue_lip_sync"
        ? // Lip-sync uses the kit only for its (cloned/preset) voice; the
          // engine's own kill switch was already checked above.
          (body.brandKitId ?? null)
        : body.engine === "localized_dub" &&
            body.localizedTrack?.voiceMode === "brand_voice"
          ? // brand_voice dubbing: kit is required (validated above) and tenant-
            // scoped at load time in the runner; persist the id for the runner.
            (body.brandKitId ?? null)
          : body.engine === "topic_to_video" && (await isFeatureEnabled("brandVideo"))
            ? (body.brandKitId ?? null)
            : null,
    // Same story for the style profile: tenant-scoped at load time, so a
    // foreign or deleted id just renders without reference styling. Dropped
    // entirely when the Reference Styles kill switch is off.
    styleProfileId:
      (body.engine === "topic_to_video" ||
        (body.engine === "dialogue_lip_sync" && characterDialogue)) &&
      (await isFeatureEnabled("referenceStyles"))
        ? (body.styleProfileId ?? null)
        : null,
    // Persisted for every engine so the job's script variant survives a
    // resume, and so the compiled-prompt log can be joined back to the
    // choice the user actually made in the studio.
    scriptVariant: isPromptVariantKey(body.scriptVariant)
      ? body.scriptVariant
      : null,
    suppliedPlan,
  };

  // Dependency preflight BEFORE funding: a job that will die four minutes in
  // on a missing key or a provider that is already failing should never take
  // the tenant's quota in the first place. Refunds return credits, not time.
  // Platform kill switch (fail-open): when off, jobs fund and run exactly as
  // they did before preflight existed.
  const preflightEnabled = await isFeatureEnabled("providerResilience").catch(() => true);
  if (preflightEnabled) {
    const preflight = await preflightVideoJob(body.engine, options);
    if (preflight) {
      res.status(preflight.status).json({ error: preflight.message });
      return;
    }
  }

  // Fund like every metered generation: monthly plan quota first, then
  // atomically reserved credits (refunded by the job runner on failure).
  // Character story videos cost one unit PER SCENE — every scene is a real
  // keyframe + image-to-video generation.
  const units = videoJobUnits(body.engine, options);
  const limits = await getPlanLimits(tenant.plan);
  const usage = await getUsage(req.tenantId);
  // Wallet workspaces reserve one estimate per unit in a single
  // all-or-nothing debit, persisted on the job row so the runner can settle
  // it to the real cost minutes later.
  let funding: "quota" | "credit" | "wallet";
  let reservation: WalletReservation | null = null;
  if (await isWalletFunded(req.tenantId)) {
    reservation = await reserveWallet(req.tenantId, "video", {}, units);
    if (!reservation) {
      res.status(402).json({
        error:
          units > 1
            ? `This video needs ${units} generations (one per scene) and your wallet balance can't cover it. Recharge to continue.`
            : "Your wallet balance can't cover this video. Recharge to continue.",
      });
      return;
    }
    funding = "wallet";
  } else if (limits.videos === -1 || usage.videos + units <= limits.videos) {
    funding = "quota";
  } else if (await spendCredit(req.tenantId, "video", units)) {
    funding = "credit";
  } else {
    res.status(402).json({
      error:
        units > 1
          ? `This video needs ${units} video units (one per generated scene) and your plan does not have enough left. Upgrade your plan or buy a credit pack.`
          : "Monthly video quota reached and no video credits left. Upgrade your plan or buy a credit pack.",
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
        options,
        // Persisted at creation, not at the runner's claim: if the process
        // restarts before the runner claims this row, the stuck-job sweep can
        // only refund a reservation it knows about.
        funding,
        // Freeze the per-unit display rate in effect right now, so the
        // "AI amount spent" line keeps showing what was really charged even
        // after a superadmin edits the rates. (The kill switch only gates
        // display, so the snapshot is written unconditionally.)
        chargedRatePaise: (await getAiSpendRates()).videoPaise,
        walletReservationId: reservation?.id ?? null,
        walletReservedPaise: reservation?.amountPaise ?? null,
        walletReservedUnits: reservation?.units ?? null,
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
    if (reservation) {
      await refundFailedVideoJobWallet(job.id, "video enqueue rejected");
    } else if (funding === "credit") {
      await refundCredits(req.tenantId, "video", units, "video enqueue rejected");
    }
    res.status(503).json({ error: "Server is restarting. Please retry in a moment." });
    return;
  }

  res.status(201).json(serializeVideoJob(job));
});

async function reconcileWalletVideoJobSpends(rows: VideoGeneration[]): Promise<VideoGeneration[]> {
  const candidates = rows.filter(
    (row) => row.status === "succeeded" && row.funding === "wallet",
  );
  if (candidates.length === 0) return rows;
  const charges = await getVideoJobWalletChargesPaise(
    candidates[0]!.tenantId,
    candidates.map((row) => row.id),
  );
  await Promise.all(
    candidates.map(async (row) => {
      const chargedPaise = charges.get(row.id);
      if (chargedPaise === undefined || chargedPaise === row.spendPaise) return;
      await db
        .update(videoGenerationsTable)
        .set({ spendPaise: chargedPaise, updatedAt: new Date() })
        .where(
          and(
            eq(videoGenerationsTable.id, row.id),
            eq(videoGenerationsTable.tenantId, row.tenantId),
          ),
        );
      row.spendPaise = chargedPaise;
    }),
  );
  return rows;
}

router.get("/ai/video-jobs", async (req: Request, res: Response) => {
  const rows = await db
    .select()
    .from(videoGenerationsTable)
    .where(eq(videoGenerationsTable.tenantId, req.tenantId))
    .orderBy(desc(videoGenerationsTable.createdAt), desc(videoGenerationsTable.id))
    .limit(30);
  const childSourceIds = new Set(
    rows.flatMap((row) => {
      const sourceId =
        row.options?.recovery?.sourceJobId ??
        row.options?.characterDialogue?.retry?.sourceJobId;
      return sourceId == null ? [] : [sourceId];
    }),
  );
  res.json(
    (await reconcileWalletVideoJobSpends(rows)).map((row) =>
      serializeVideoJob(row, childSourceIds.has(row.id) ? false : undefined),
    ),
  );
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
  const [reconciled] = await reconcileWalletVideoJobSpends([job]);
  const tenantJobs = await db
    .select({ options: videoGenerationsTable.options })
    .from(videoGenerationsTable)
    .where(eq(videoGenerationsTable.tenantId, req.tenantId));
  const hasChild = tenantJobs.some(
    (row) =>
      row.options?.recovery?.sourceJobId === job.id ||
      row.options?.characterDialogue?.retry?.sourceJobId === job.id,
  );
  res.json(serializeVideoJob(reconciled!, hasChild ? false : undefined));
});

function remainingCharacterDialogueUnits(options: VideoJobOptions): number {
  const plan = options.characterDialogue;
  if (!plan) return 0;
  let videoOperations = 0;
  for (const scene of plan.scenes) {
    if (!scene.checkpoint?.platePath || !scene.checkpoint.visualEvent) videoOperations += 1;
    if (
      !scene.checkpoint?.lipSyncPath ||
      !scene.checkpoint.lipSyncEvent ||
      !scene.checkpoint.narrationDurationSec
    ) videoOperations += 1;
  }
  if (
    options.presenterBroll &&
    (options.visualsSource === "ai" || options.visualsSource === "ai_video")
  ) {
    videoOperations += options.presenterBroll.beats.filter(
      (beat) => !beat.assetPath || !beat.previewPath,
    ).length;
  }
  videoOperations += Math.max(0, Math.trunc(options.addedScenes ?? 0));
  let units = videoOperations * videoModelMultiplier(options.modelId);
  if (
    !options.musicPath &&
    options.musicPrompt?.trim() &&
    !plan.musicCheckpoint?.path &&
    !options.musicCheckpoint?.path &&
    !options.presenterMusicCheckpoint?.path
  ) units += 1;
  return units;
}

type RecoveryInventory = {
  mode: "resume" | "saved_inputs";
  reusable: string[];
  regenerated: string[];
  units: number;
};

/** Engine-aware inventory of complete checkpoints. Partial paths are never
 * advertised or deducted: the runner will regenerate those stages. */
function videoRecoveryInventory(source: VideoGeneration): RecoveryInventory {
  const options = source.options ?? { aspectRatio: "9:16" as const };
  const reusable: string[] = [];
  const regenerated: string[] = [];
  // Recovery children persist only the units funded for that attempt. That is
  // an execution/settlement override, not the chain's expected operation
  // count: on a later hop we must rebuild the immutable full baseline before
  // subtracting inherited checkpoints, or those checkpoints are deducted
  // twice.
  let units = videoJobFullUnits(source.engine, options);

  const savedRender = options.renderCheckpoint ?? options.recovery?.rendered;
  const hasFinalRender =
    options.renderCheckpoint?.stage === "final" ||
    (!options.renderCheckpoint && Boolean(options.recovery?.rendered?.path));
  if (savedRender?.path && hasFinalRender) {
    reusable.push("completed video render");
    regenerated.push("final thumbnail and job finalization");
    units = 0;
  } else if (source.engine === "dialogue_lip_sync" && options.characterDialogue) {
    const completeScenes = options.characterDialogue.scenes.filter(
      (scene) =>
        scene.checkpoint?.lipSyncPath &&
        scene.checkpoint.narrationDurationSec &&
        scene.checkpoint.lipSyncEvent,
    ).length;
    if (completeScenes > 0) reusable.push(`${completeScenes} completed dialogue scene${completeScenes === 1 ? "" : "s"}`);
    if (options.characterDialogue.musicCheckpoint?.path) reusable.push("music");
    if (source.storyboard) reusable.push("approved storyboard");
    units = remainingCharacterDialogueUnits(options);
    if (units > 0) regenerated.push(`${units} missing provider operation${units === 1 ? "" : "s"}`);
    else regenerated.push("final composition and upload");
  } else {
    if (source.storyboard) {
      reusable.push("approved storyboard");
      if (source.storyboard.narration?.audioPath) reusable.push("narration");
      if (source.storyboard.scenes.some((scene) => scene.previewPath)) {
        reusable.push("saved scene assets");
      }
    }
    const completePresenterAssets =
      options.presenterBroll?.beats.filter((beat) => beat.assetPath && beat.previewPath).length ?? 0;
    if (completePresenterAssets > 0) {
      reusable.push(`${completePresenterAssets} presenter B-roll asset${completePresenterAssets === 1 ? "" : "s"}`);
    }
    if (options.presenterMusicCheckpoint?.path) reusable.push("music");
    // A slideshow has no video provider call. Only an unfinished AI music bed
    // needs provider funding; local composition/upload remains zero-unit.
    if (source.engine === "slideshow") {
      units =
        !options.musicPath &&
        options.musicPrompt?.trim() &&
        !options.presenterMusicCheckpoint?.path &&
        !options.musicCheckpoint?.path
          ? 1
          : 0;
    } else {
      const paidVideoEvents = [
        ...(options.renderCheckpoint?.path
          ? options.renderCheckpoint.providerEvents
          : []),
        ...(options.recovery?.rendered?.path
          ? options.recovery.rendered.providerEvents
          : []),
        ...(options.presenterBroll?.providerEvents ?? []),
      ];
      const completedSceneEvents =
        source.storyboard?.scenes.flatMap((scene) =>
          scene.providerCheckpoint?.event ? [scene.providerCheckpoint.event] : [],
        ) ?? [];
      const completedMusic =
        Boolean(options.musicCheckpoint?.path) ||
        Boolean(options.presenterMusicCheckpoint?.path);
      // Provider receipts, not a guessed engine count, are the source of
      // truth for stages already paid in this durable chain.
      units = Math.max(
        0,
        units -
          (
            new Set(paidVideoEvents.map((event) => event.eventId ?? `${event.provider}:${event.model}:${event.label}`))
              .size +
            completedSceneEvents.length
          ) * videoModelMultiplier(options.modelId) -
          (completedMusic ? 1 : 0),
      );
    }
    regenerated.push(
      units > 0
        ? `${units} missing provider operation${units === 1 ? "" : "s"}`
        : "final composition and upload",
    );
  }
  return {
    mode: reusable.length > 0 ? "resume" : "saved_inputs",
    reusable,
    regenerated,
    units: Math.max(0, units),
  };
}

function recoveryObjectPaths(source: VideoGeneration, inventory: RecoveryInventory): string[] {
  const options = source.options;
  const paths = [
    ...(source.sourceImagePaths ?? []),
    options?.sourceVideoPath,
    options?.sourceImagePath,
    options?.audioPath,
    options?.presenterVideoPath,
    options?.musicPath,
  ];
  if (inventory.mode === "resume") {
    paths.push(
      source.storyboard?.narration?.audioPath,
      ...(source.storyboard?.scenes.map((scene) => scene.previewPath) ?? []),
      ...(source.storyboard?.scenes.map((scene) => scene.providerCheckpoint?.path) ?? []),
      ...(options?.presenterBroll?.beats.flatMap((beat) => [
        beat.assetPath,
        beat.previewPath,
      ]) ?? []),
      options?.presenterMusicCheckpoint?.path,
      options?.musicCheckpoint?.path,
      options?.renderCheckpoint?.path,
      options?.recovery?.rendered?.path,
      ...(options?.characterDialogue?.scenes.flatMap((scene) => [
        scene.checkpoint?.narrationPath,
        scene.checkpoint?.platePath,
        scene.checkpoint?.lipSyncPath,
      ]) ?? []),
      options?.characterDialogue?.musicCheckpoint?.path,
    );
  }
  return [...new Set(paths.filter((path): path is string => Boolean(path)))];
}

async function validateRecoveryObjects(
  source: VideoGeneration,
  inventory: RecoveryInventory,
): Promise<{ code: string; message: string } | null> {
  const options = source.options;
  const render = options?.renderCheckpoint ?? options?.recovery?.rendered;
  if (render?.path && render.provider && render.providerEvents.length === 0) {
    return {
      code: "recovery_checkpoint_invalid",
      message: "The saved completed render is missing its durable provider receipt. Retry from saved inputs instead.",
    };
  }
  for (const scene of options?.characterDialogue?.scenes ?? []) {
    const checkpoint = scene.checkpoint;
    if (
      (checkpoint?.platePath && !checkpoint.visualEvent) ||
      (checkpoint?.lipSyncPath &&
        (!checkpoint.lipSyncEvent || !checkpoint.narrationDurationSec))
    ) {
      return {
        code: "recovery_checkpoint_invalid",
        message: `Saved dialogue scene ${scene.id} has an incomplete checkpoint and cannot be reused safely.`,
      };
    }
  }
  const characterId =
    options?.characterDialogue?.characterId ?? options?.characterId;
  if (characterId) {
    const detail = await getCharacterDetail(source.tenantId, characterId);
    const outfitId =
      options?.characterDialogue?.outfitId ?? options?.outfitId;
    if (!detail || (outfitId && !detail.outfits.some((outfit) => outfit.id === outfitId))) {
      return {
        code: "recovery_asset_missing",
        message: "The saved character or outfit is no longer available. Start over with an available character.",
      };
    }
  }
  const brandKitId =
    options?.characterDialogue?.brandKitId ?? options?.brandKitId;
  if (brandKitId && !(await loadActivePayload(source.tenantId, brandKitId))) {
    return {
      code: "recovery_asset_missing",
      message: "The saved brand kit is no longer available. Start over with an available brand kit.",
    };
  }
  if (options?.styleProfileId) {
    const [profile] = await db
      .select({
        tenantId: videoStyleProfilesTable.tenantId,
        published: videoStyleProfilesTable.published,
      })
      .from(videoStyleProfilesTable)
      .where(eq(videoStyleProfilesTable.id, options.styleProfileId))
      .limit(1);
    if (!profile || (profile.tenantId !== null && profile.tenantId !== source.tenantId)) {
      return {
        code: "recovery_asset_missing",
        message: "The saved video style or template is no longer available.",
      };
    }
  }
  for (const objectPath of recoveryObjectPaths(source, inventory)) {
    if (!objectPath.startsWith(`/objects/${source.tenantId}/`)) {
      return {
        code: "recovery_asset_forbidden",
        message: "A saved input or checkpoint does not belong to this workspace.",
      };
    }
    try {
      await musicStorage.getObjectEntityFile(objectPath, source.tenantId);
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        return {
          code: "recovery_asset_missing",
          message: `A saved input or checkpoint is missing (${objectPath.split("/").pop()}). Start over with an available asset.`,
        };
      }
      throw error;
    }
  }
  return null;
}

router.post("/ai/video-jobs/:jobId/retry", async (req: Request, res: Response): Promise<void> => {
  const sourceId = Number(req.params.jobId);
  const initial = await loadJob(req);
  if (!initial) {
    res.status(404).json({ error: "Not found", code: "recovery_source_not_found" });
    return;
  }
  if (initial.status !== "failed" || !RECOVERABLE_VIDEO_ENGINES.has(initial.engine)) {
    res.status(400).json({
      error: "This video does not have saved inputs that can be retried.",
      code: "recovery_not_eligible",
    });
    return;
  }
  if (await rejectDisabledVideoMode(initial.engine, res)) return;
  const requiredFeatures: Array<
    readonly [Parameters<typeof isFeatureEnabled>[0], string]
  > = [
    ["videoGen", "Video Studio is currently turned off."],
    ...(initial.engine === "lip_sync" || initial.engine === "dialogue_lip_sync"
      ? [["lipSync", "Lip-synced videos are currently turned off."] as const]
      : []),
    ...(initial.options?.characterDialogue
      ? [["brandVoiceClone", "Brand Voice is currently turned off."] as const]
      : []),
  ];
  for (const [feature, message] of requiredFeatures) {
    if (!(await isFeatureEnabled(feature))) {
      res.status(403).json({ error: message, code: "feature_disabled" });
      return;
    }
  }
  const inventory = videoRecoveryInventory(initial);
  const invalidAsset = await validateRecoveryObjects(initial, inventory);
  if (invalidAsset) {
    res.status(410).json({ error: invalidAsset.message, code: invalidAsset.code });
    return;
  }

  let source: VideoGeneration | null = null;
  let child: VideoGeneration | null = null;
  await db.transaction(async (tx) => {
    await tx.execute(sql`select id from ${videoGenerationsTable} where id = ${sourceId} for update`);
    source = (
      await tx.select().from(videoGenerationsTable).where(and(
        eq(videoGenerationsTable.id, sourceId),
        eq(videoGenerationsTable.tenantId, req.tenantId),
      )).limit(1)
    )[0] ?? null;
    if (!source || source.status !== "failed" || !RECOVERABLE_VIDEO_ENGINES.has(source.engine)) return;
    const tenantJobs = await tx
      .select({ id: videoGenerationsTable.id, options: videoGenerationsTable.options })
      .from(videoGenerationsTable)
      .where(eq(videoGenerationsTable.tenantId, req.tenantId));
    const existingChild = tenantJobs.some(
      (job) =>
        job.options?.recovery?.sourceJobId === sourceId ||
        job.options?.characterDialogue?.retry?.sourceJobId === sourceId,
    );
    if (existingChild || source.options?.characterDialogue?.retry?.childJobId != null) return;
    const childOptions: VideoJobOptions = structuredClone(
      source.options ?? { aspectRatio: "9:16" as const },
    );
    const chainId =
      source.options?.recovery?.chainId ??
      source.options?.characterDialogue?.retry?.sourceJobId ??
      source.id;
    childOptions.recovery = {
      version: 1,
      chainId,
      sourceJobId: source.id,
      fundedUnits: inventory.units,
      mode: inventory.mode,
      state: "creating",
      reusable: inventory.reusable,
      regenerated: inventory.regenerated,
      rendered:
        source.options?.renderCheckpoint ??
        source.options?.recovery?.rendered ??
        null,
    };
    // Preserve compatibility for already-deployed Character Dialogue runners,
    // but linkage/concurrency is owned by generic recovery metadata.
    if (childOptions.characterDialogue) {
      childOptions.characterDialogue.retry = {
        sourceJobId: chainId,
        fundedUnits: inventory.units,
        state: "creating",
      };
    }
    child = (
      await tx.insert(videoGenerationsTable).values({
        tenantId: source.tenantId, engine: source.engine, status: "queued",
        prompt: source.prompt,
        sourceImagePaths: structuredClone(source.sourceImagePaths),
        storyboard: source.storyboard ? structuredClone(source.storyboard) : null,
        options: childOptions,
        funding: null, chargedRatePaise: (await getAiSpendRates()).videoPaise,
      }).returning()
    )[0]!;
  });
  if (!source) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!child) {
    const sourceJob = source as VideoGeneration;
    if (sourceJob.status !== "failed" || !RECOVERABLE_VIDEO_ENGINES.has(sourceJob.engine)) {
      res.status(400).json({ error: "This video cannot be retried.", code: "recovery_not_eligible" });
    } else {
      res.status(409).json({
        error: "A recovery child already exists. Open that job, or wait for it to finish.",
        code: "recovery_child_exists",
      });
    }
    return;
  }
  const childJob = child as VideoGeneration;
  const rollbackChild = async () => {
    await db.delete(videoGenerationsTable).where(eq(videoGenerationsTable.id, childJob.id));
  };
  const options = childJob.options!;
  const units = videoJobUnits(childJob.engine, options);
  if (units > 0 && await isFeatureEnabled("providerResilience").catch(() => true)) {
    const preflight = await preflightVideoJob(childJob.engine, options);
    if (preflight) {
      await rollbackChild();
      res.status(preflight.status).json({
        error: preflight.message,
        code: "recovery_provider_unavailable",
      });
      return;
    }
  }
  const tenant = (await db.select().from(tenantsTable).where(eq(tenantsTable.id, req.tenantId)).limit(1))[0];
  if (!tenant) {
    await rollbackChild();
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  let funding: "quota" | "credit" | "wallet" = "quota";
  let reservation: WalletReservation | null = null;
  if (units > 0 && await isWalletFunded(req.tenantId)) {
    reservation = await reserveWallet(req.tenantId, "video", {}, units);
    if (!reservation) {
      await rollbackChild();
      res.status(402).json({
        error: `Resume needs ${units} missing provider operation${units === 1 ? "" : "s"}, but the wallet cannot cover them.`,
        code: "recovery_insufficient_funds",
      });
      return;
    }
    funding = "wallet";
  } else if (units > 0) {
    const [limits, usage] = await Promise.all([getPlanLimits(tenant.plan), getUsage(req.tenantId)]);
    if (limits.videos === -1 || usage.videos + units <= limits.videos) funding = "quota";
    else if (await spendCredit(req.tenantId, "video", units)) funding = "credit";
    else {
      await rollbackChild();
      res.status(402).json({
        error: `Resume needs ${units} missing provider operation${units === 1 ? "" : "s"}. Add credits or upgrade to continue.`,
        code: "recovery_insufficient_funds",
      });
      return;
    }
  }
  const childOptions = structuredClone(options);
  childOptions.recovery!.state = "queued";
  if (childOptions.characterDialogue?.retry) {
    childOptions.characterDialogue.retry.state = "queued";
  }
  const [fundedChild] = await db.update(videoGenerationsTable).set({
    options: childOptions, funding,
    walletReservationId: reservation?.id ?? null,
    walletReservedPaise: reservation?.amountPaise ?? null,
    walletReservedUnits: reservation?.units ?? null,
  }).where(eq(videoGenerationsTable.id, childJob.id)).returning();
  const accepted = enqueueBackgroundJob(() => runVideoGenerationJob(childJob.id, funding));
  if (!accepted) {
    if (reservation) await refundWallet(req.tenantId, reservation, "retry enqueue rejected");
    else if (funding === "credit") await refundCredits(req.tenantId, "video", units, "retry enqueue rejected");
    await rollbackChild();
    res.status(503).json({ error: "Server is restarting. Please retry in a moment." });
    return;
  }
  res.status(201).json(serializeVideoJob(fundedChild!));
});

/**
 * Cancel a still-queued job. The conditional queued->cancelled UPDATE is the
 * same atomic guard the runner uses for its queued->processing claim, so a
 * job can never be both cancelled and executed: whichever flip lands first
 * wins. Refunds the reserved credits when the job was credit-funded (quota
 * funding is only metered on success, so there is nothing to refund). The
 * refund amount is recomputed from the stored engine/options — the exact
 * inputs the route priced the job with at enqueue.
 */
router.post("/ai/video-jobs/:jobId/cancel", async (req: Request, res: Response) => {
  const id = Number(req.params.jobId);
  // The status flip and the credit refund share one transaction so a job can
  // never end up cancelled without its refund (or vice versa).
  let cancelledReservation: WalletReservation | null = null;
  const cancelled = await db.transaction(async (tx) => {
    const row = (
      await tx
        .update(videoGenerationsTable)
        .set({ status: "cancelled", error: null })
        .where(
          and(
            eq(videoGenerationsTable.id, id),
            eq(videoGenerationsTable.tenantId, req.tenantId),
            eq(videoGenerationsTable.status, "queued"),
          ),
        )
        .returning()
    )[0];
    if (row) {
      const held = reservationFromRow(row);
      if (held) {
        // Issued after the cancel commits, on its own connection.
        cancelledReservation = held;
      } else if (row.funding === "credit") {
        const units = videoJobUnits(row.engine, row.options);
        await refundCredits(req.tenantId, "video", units, "video job cancelled", tx);
      }
    }
    return row;
  });
  if (cancelled) {
    if (cancelledReservation) {
      await refundWallet(
        req.tenantId,
        cancelledReservation,
        "video job cancelled",
      ).catch((error) =>
        req.log.error({ err: error, jobId: id }, "Failed to refund cancelled video job"),
      );
    }
    res.json(serializeVideoJob(cancelled));
    return;
  }
  const existing = await loadJob(req);
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(409).json({
    error:
      existing.status === "processing"
        ? "This video has already started and can no longer be cancelled."
        : existing.status === "awaiting_review"
          ? "This video is waiting on storyboard review — discard the storyboard instead."
          : "This video has already finished.",
  });
});

/**
 * Storyboard review. A job created with reviewStoryboard pauses after the cheap
 * half (script → narration → one still per scene) and waits here in
 * awaiting_review. The stills on the plan ARE the frames the render animates, so
 * approving costs no image generation twice, and editing is free.
 *
 * Funding was reserved when the job was created; approve spends nothing extra
 * and discard gives it back.
 */

/** Load a job that must be paused for review, answering the request when it is
 * not. Returns the job and its plan together so callers get both non-null. */
async function loadPausedJob(
  req: Request,
  res: Response,
): Promise<{ job: VideoGeneration; storyboard: NonNullable<VideoGeneration["storyboard"]> } | null> {
  const job = await loadJob(req);
  if (!job) {
    res.status(404).json({ error: "Not found" });
    return null;
  }
  if (job.status !== "awaiting_review" || !job.storyboard) {
    res.status(400).json({ error: "This video is not waiting for storyboard review." });
    return null;
  }
  return { job, storyboard: job.storyboard };
}

/** Edit scene prompts (and, when the timeline is unlocked, scene lengths). */
router.patch("/ai/video-jobs/:jobId/storyboard", async (req: Request, res: Response) => {
  const parsed = UpdateVideoStoryboardBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const loaded = await loadPausedJob(req, res);
  if (!loaded) return;
  const { storyboard } = loaded;

  const edits = new Map(parsed.data.scenes.map((scene) => [scene.id, scene]));
  for (const id of edits.keys()) {
    if (!storyboard.scenes.some((scene) => scene.id === id)) {
      res.status(400).json({ error: "That scene is not in this storyboard." });
      return;
    }
  }
  // Topic storyboards are cut against already-recorded narration, so a length
  // edit would either desync every later scene from the audio or silently
  // change the total. Reject it rather than accept-and-ignore.
  if (storyboard.timelineLocked && parsed.data.scenes.some((s) => s.durationSec != null)) {
    res.status(400).json({
      error: "Scene lengths are set by the narration timing and cannot be changed.",
    });
    return;
  }
  if (
    storyboard.mode === "character_dialogue" &&
    parsed.data.scenes.some((edit) => edit.text !== undefined)
  ) {
    res.status(400).json({
      error: "Approved Character Dialogue text cannot be changed in the storyboard.",
    });
    return;
  }
  if (
    parsed.data.scenes.some((edit) => {
      if (edit.brollVisual === undefined) return false;
      const scene = storyboard.scenes.find((candidate) => candidate.id === edit.id);
      return !scene || scene.brollVisual == null;
    })
  ) {
    res.status(400).json({
      error: "This scene has no supporting B-roll direction to edit.",
    });
    return;
  }
  // Narration text is only editable where narration exists to re-record: the
  // narrated (topic) plans. Everywhere else `text` is empty by construction,
  // so accepting an edit would invent a script no engine will voice.
  if (
    storyboard.mode !== "character_story" &&
    !storyboard.narration &&
    parsed.data.scenes.some((s) => s.text?.trim())
  ) {
    res.status(400).json({
      error: "This video has no narration, so there is no scene text to edit.",
    });
    return;
  }

  // Camera moves only mean something on a plan that runs an AI model. A
  // "slide" plan is ffmpeg cross-fades over the user's own photos: there is no
  // camera to move, so accepting the field would be accept-and-ignore.
  const sceneEdits = parsed.data.scenes;
  if (
    storyboard.visualsSource === "slide" &&
    sceneEdits.some((s) => s.motionPreset !== undefined)
  ) {
    res.status(400).json({
      error: "A photo slideshow has no camera move to set.",
    });
    return;
  }
  for (const edit of sceneEdits) {
    if (edit.motionPreset && !isMotionPresetId(edit.motionPreset)) {
      res.status(400).json({ error: "That camera move is not available." });
      return;
    }
  }

  // On a slideshow plan, `visual` is the burned-in caption, so clearing it is a
  // real edit. Everywhere else it is the generation prompt, and an empty prompt
  // has nothing to generate — there, blank means "leave it alone".
  const blankClearsVisual = storyboard.visualsSource === "slide";
  // Verification markers are deliberately not spoken. A narration-text edit is
  // the explicit review action that replaces the generated claim, so it clears
  // the old marker and lets lint evaluate the revised script instead.
  const revisesGeneratedClaim = sceneEdits.some((edit) => edit.text?.trim());
  const updated = {
    ...storyboard,
    ...(revisesGeneratedClaim ? { verificationFindings: [] } : {}),
    scenes: storyboard.scenes.map((scene) => {
      const edit = edits.get(scene.id);
      if (!edit) return scene;
      const visual = edit.visual?.trim();
      // Blank never clears narration: a narrated scene with no words has no
      // length. The voiceover re-records to match edited text on approve.
      const text = edit.text?.trim();
      return {
        ...scene,
        text: text || scene.text,
        visual: visual || (blankClearsVisual && visual === "" ? "" : scene.visual),
        ...(edit.brollVisual !== undefined
          ? { brollVisual: edit.brollVisual?.trim() || null }
          : {}),
        // Clamped rather than rejected: the bounds are what the renderer can
        // actually deliver, and a client that asks for 30s meant "the longest
        // you can do".
        durationSec:
          edit.durationSec == null
            ? scene.durationSec
            : clampSceneDuration(storyboard, edit.durationSec),
        // undefined = untouched; an explicit null clears the override back to
        // the job's own setting. Distinguishing the two is the whole point of
        // a PATCH, so neither is collapsed into the other.
        ...(edit.motionPreset !== undefined ? { motionPreset: edit.motionPreset } : {}),
        ...(edit.seed !== undefined ? { seed: edit.seed } : {}),
      };
    }),
  };
  const creativeIssues = lintStoryboardCreativeBrief(
    updated,
    loaded.job.options?.resolvedCreativeBrief,
  );
  if (creativeIssues.length > 0) {
    res.status(400).json({
      error: `Storyboard does not satisfy its creative brief: ${creativeIssues
        .map((issue) =>
          issue.kind === "required_vocabulary"
            ? `missing required vocabulary "${issue.term}"`
            : issue.kind === "forbidden_vocabulary"
              ? `contains forbidden vocabulary "${issue.term}"`
              : "contains an unverified claim marker",
        )
        .join("; ")}.`,
    });
    return;
  }
  const saved = (
    await db
      .update(videoGenerationsTable)
      .set({ storyboard: updated, updatedAt: new Date() })
      .where(
        and(
          eq(videoGenerationsTable.id, Number(req.params.jobId)),
          eq(videoGenerationsTable.tenantId, req.tenantId),
          eq(videoGenerationsTable.status, "awaiting_review"),
        ),
      )
      .returning()
  )[0];
  if (!saved) {
    res.status(400).json({ error: "This video is not waiting for storyboard review." });
    return;
  }
  res.json(serializeVideoJob(saved));
});

/** Hard ceiling on scenes per narrated storyboard: the largest planned board
 * (character, 3 paragraphs) is 12 scenes, and each added scene lengthens the
 * recording and the render, so growth past this needs a new video instead. */
const MAX_NARRATED_STORYBOARD_SCENES = 16;

/** Add a scene to a paused narrated storyboard. Costs one extra video unit,
 * funded the same way as the job so every refund path stays consistent. */
router.post("/ai/video-jobs/:jobId/storyboard/scenes", async (req: Request, res: Response) => {
  const parsed = InsertVideoStoryboardSceneBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const loaded = await loadPausedJob(req, res);
  if (!loaded) return;
  const { job, storyboard } = loaded;
  if (await rejectDisabledVideoMode(job.engine, res)) return;

  // Phase 1: narrated topic boards only. Their scenes are generated stills, so
  // a new one can be drawn from a prompt; the voiceover re-records on approve.
  if (
    !storyboard.narration ||
    !storyboardPreviewsAreGenerated(storyboard.visualsSource, storyboard.mode)
  ) {
    res.status(400).json({
      error: "Scenes can only be added to narrated topic storyboards.",
    });
    return;
  }
  if (storyboard.scenes.length >= MAX_NARRATED_STORYBOARD_SCENES) {
    res.status(400).json({
      error: `This storyboard is at its maximum of ${MAX_NARRATED_STORYBOARD_SCENES} scenes.`,
    });
    return;
  }
  const afterSceneId = parsed.data.afterSceneId;
  if (afterSceneId != null && !storyboard.scenes.some((s) => s.id === afterSceneId)) {
    res.status(400).json({ error: "That scene is not in this storyboard." });
    return;
  }
  const text = parsed.data.text.trim();
  if (!text) {
    res.status(400).json({ error: "The new scene needs narration text." });
    return;
  }

  // Fund the extra unit the same way the job was funded — mixed funding would
  // break the refund paths, which give back videoJobUnits(engine, options)
  // only when funding is "credit". The unit is recorded in options.addedScenes
  // so success metering, discard and failure refunds all price it in.
  const options = job.options ?? { aspectRatio: "9:16" as const };
  const optionsAfter = { ...options, addedScenes: (options.addedScenes ?? 0) + 1 };
  // An added scene is one more generation on the job's OWN model, so it costs
  // that model's multiplier — the same arithmetic videoJobUnits applies to
  // addedScenes. Charging a flat unit here while the refund paths recompute a
  // multiplied one is how a tenant ends up owed money nobody notices.
  const sceneUnits = videoModelMultiplier(options.modelId);
  let sceneReservation: WalletReservation | null = null;
  if (job.funding === "wallet") {
    sceneReservation = await reserveWallet(req.tenantId, "video", {}, sceneUnits);
    if (!sceneReservation) {
      res.status(402).json({
        error: "Adding a scene needs another generation and your wallet can't cover it.",
      });
      return;
    }
    // Fold it into the job's reserved totals. The refund paths (render
    // failure, storyboard discard, sweep) rebuild ONE reservation from these
    // columns, so an extra reserve that is not folded in here is money the
    // tenant can never get back.
    await addToJobReservation(job.id, sceneReservation.amountPaise, sceneUnits);
  } else if (job.funding === "credit") {
    if (!(await spendCredit(req.tenantId, "video", sceneUnits))) {
      res.status(402).json({
        error:
          sceneUnits > 1
            ? `Adding a scene needs ${sceneUnits} video credits and you do not have enough left.`
            : "Adding a scene needs one video credit and you have none left.",
      });
      return;
    }
  } else {
    const tenant = (
      await db.select().from(tenantsTable).where(eq(tenantsTable.id, req.tenantId))
    )[0];
    const limits = await getPlanLimits(tenant?.plan ?? "free");
    const usage = await getUsage(req.tenantId);
    const unitsAfter = videoJobUnits(job.engine, optionsAfter);
    if (limits.videos !== -1 && usage.videos + unitsAfter > limits.videos) {
      res.status(402).json({
        error:
          "Adding a scene needs one more video unit than your monthly quota has left. Upgrade your plan or start a smaller video.",
      });
      return;
    }
  }
  const refundInsert = async (reason: string): Promise<void> => {
    if (sceneReservation) {
      // Unfold first, so the job's totals stop claiming a scene that never
      // landed and a later refund cannot hand the same paise back twice.
      await addToJobReservation(job.id, -sceneReservation.amountPaise, -sceneUnits).catch(
        (err) =>
          req.log.error(
            { err, jobId: job.id },
            "Failed to unfold a scene reservation from the job totals",
          ),
      );
      await refundWallet(req.tenantId, sceneReservation, reason).catch((err) => {
        req.log.error(
          { err, jobId: job.id, tenantId: req.tenantId, reason },
          "Storyboard scene insert wallet refund FAILED — tenant may be owed a refund",
        );
      });
      return;
    }
    if (job.funding === "credit") {
      await refundCredits(req.tenantId, "video", sceneUnits, reason).catch((err) => {
        // A failed refund leaves the tenant charged for a scene that never
        // landed — surface it loudly so it can be reconciled by hand.
        req.log.error(
          { err, jobId: job.id, tenantId: req.tenantId, reason },
          "Storyboard scene insert refund FAILED — tenant may be owed 1 video credit",
        );
      });
    }
  };

  // Give back the funding if anything below fails; quota jobs only meter on
  // success, so there the checks above were the whole reservation.
  const nextId = `s${storyboard.scenes.reduce((max, s) => {
    const m = /^s(\d+)$/.exec(s.id);
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0) + 1}`;
  // Length placeholder only: the re-recorded narration dictates the real
  // duration when the storyboard is approved.
  const durationSec =
    storyboard.scenes.reduce((sum, s) => sum + s.durationSec, 0) / storyboard.scenes.length;
  const newScene = {
    id: nextId,
    text,
    visual: parsed.data.visual?.trim() || text,
    durationSec: Math.round(durationSec * 10) / 10,
    previewPath: null as string | null,
    outfitId: null as number | null,
  };

  // Generate the preview still BEFORE persisting anything, so a provider
  // failure charges nothing and leaves the board exactly as it was.
  let previewBoard;
  try {
    previewBoard = await refreshStoryboardScenePreview(
      job,
      { ...storyboard, scenes: [...storyboard.scenes, newScene] },
      newScene,
    );
  } catch (error) {
    req.log.warn({ err: error, jobId: job.id }, "Storyboard scene insert preview failed");
    await refundInsert("storyboard scene insert failed");
    const message =
      error instanceof VideoGenProviderError
        ? error.message
        : "Generating the new scene's image failed. Please try again.";
    res.status(502).json({ error: message });
    return;
  }
  const generated = previewBoard.scenes.find((s) => s.id === nextId) ?? newScene;

  // Re-read under lock and splice into the CURRENT board, so edits made while
  // the image generated are kept and two parallel inserts cannot lose one.
  let saved;
  try {
    saved = await db.transaction(async (tx) => {
    const fresh = (
      await tx
        .select()
        .from(videoGenerationsTable)
        .where(
          and(
            eq(videoGenerationsTable.id, job.id),
            eq(videoGenerationsTable.tenantId, req.tenantId),
          ),
        )
        .for("update")
    )[0];
    if (
      !fresh ||
      fresh.status !== "awaiting_review" ||
      !fresh.storyboard ||
      fresh.storyboard.scenes.length >= MAX_NARRATED_STORYBOARD_SCENES ||
      fresh.storyboard.scenes.some((s) => s.id === nextId)
    ) {
      return null;
    }
    const scenes = [...fresh.storyboard.scenes];
    const at =
      afterSceneId === null
        ? 0
        : afterSceneId === undefined
          ? scenes.length
          : scenes.findIndex((s) => s.id === afterSceneId) + 1 || scenes.length;
    scenes.splice(at, 0, generated);
    const freshOptions = fresh.options ?? options;
    return (
      await tx
        .update(videoGenerationsTable)
        .set({
          storyboard: { ...fresh.storyboard, scenes },
          options: { ...freshOptions, addedScenes: (freshOptions.addedScenes ?? 0) + 1 },
          updatedAt: new Date(),
        })
        .where(eq(videoGenerationsTable.id, job.id))
        .returning()
    )[0];
    });
  } catch (error) {
    // The DB write failed after funding was taken — give it back before 500ing.
    req.log.error({ err: error, jobId: job.id }, "Storyboard scene insert persist failed");
    await refundInsert("storyboard scene insert failed");
    res.status(500).json({ error: "Saving the new scene failed. You were not charged." });
    return;
  }
  if (!saved) {
    await refundInsert("storyboard scene insert rejected");
    res.status(400).json({ error: "This video is not waiting for storyboard review." });
    return;
  }
  res.json(serializeVideoJob(saved));
});

/** Re-roll one scene's preview still from its current prompt. */
router.post(
  "/ai/video-jobs/:jobId/storyboard/scenes/:sceneId/preview",
  async (req: Request, res: Response) => {
    const loaded = await loadPausedJob(req, res);
    if (!loaded) return;
    const { job, storyboard } = loaded;
    if (await rejectDisabledVideoMode(job.engine, res)) return;

    // "photo" and "slide" plans preview the user's OWN uploaded photos, and a
    // "prompt" plan has no still at all — there is nothing here to re-roll, and
    // generating one would replace a photo they chose with one they did not.
    if (!storyboardPreviewsAreGenerated(storyboard.visualsSource, storyboard.mode)) {
      res.status(400).json({
        error: "This storyboard's images are your own photos, so there is nothing to redraw.",
      });
      return;
    }
    const scene = storyboard.scenes.find((s) => s.id === req.params.sceneId);
    if (!scene) {
      res.status(400).json({ error: "That scene is not in this storyboard." });
      return;
    }
    const cap = STORYBOARD_REGENERATIONS_PER_SCENE * storyboard.scenes.length;

    // Spend one re-roll atomically BEFORE the expensive generation: the
    // conditional UPDATE both checks the cap and increments the counter in one
    // statement, so concurrent requests each need their own winning claim and
    // can never overshoot the cap by racing a read-then-write.
    const claimed = (
      await db
        .update(videoGenerationsTable)
        .set({
          storyboard: sql`jsonb_set(${videoGenerationsTable.storyboard}, '{regenerations}', to_jsonb(COALESCE((${videoGenerationsTable.storyboard}->>'regenerations')::int, 0) + 1))`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(videoGenerationsTable.id, job.id),
            eq(videoGenerationsTable.tenantId, req.tenantId),
            eq(videoGenerationsTable.status, "awaiting_review"),
            sql`COALESCE((${videoGenerationsTable.storyboard}->>'regenerations')::int, 0) < ${cap}`,
          ),
        )
        .returning()
    )[0];
    if (!claimed || !claimed.storyboard) {
      res.status(400).json({
        error: `You have used all ${cap} free preview re-rolls for this storyboard. Approve it, or start a new video.`,
      });
      return;
    }

    // Best-effort: a provider failure should not eat a re-roll. Guarded the
    // same way as the claim; if the plan moved on meanwhile, leave it alone.
    const releaseClaim = async (): Promise<void> => {
      await db
        .update(videoGenerationsTable)
        .set({
          storyboard: sql`jsonb_set(${videoGenerationsTable.storyboard}, '{regenerations}', to_jsonb(GREATEST(COALESCE((${videoGenerationsTable.storyboard}->>'regenerations')::int, 0) - 1, 0)))`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(videoGenerationsTable.id, job.id),
            eq(videoGenerationsTable.tenantId, req.tenantId),
            eq(videoGenerationsTable.status, "awaiting_review"),
          ),
        );
    };

    const fresh = claimed.storyboard;
    const freshScene = fresh.scenes.find((s) => s.id === scene.id) ?? scene;
    let updated;
    try {
      updated = await refreshStoryboardScenePreview(job, fresh, freshScene);
    } catch (error) {
      req.log.warn({ err: error, jobId: job.id }, "Storyboard preview regeneration failed");
      await releaseClaim().catch(() => {});
      const message =
        error instanceof VideoGenProviderError
          ? error.message
          : "Generating that preview failed. Please try again.";
      res.status(502).json({ error: message });
      return;
    }
    // Persist only the scenes; the regenerations counter was already spent by
    // the atomic claim above, and writing the whole object back would let a
    // slow request overwrite a counter a concurrent request has since moved.
    // Guarded on status so a preview cannot land on a plan that was approved
    // or discarded while the image was generating.
    const saved = (
      await db
        .update(videoGenerationsTable)
        .set({
          storyboard: sql`jsonb_set(${videoGenerationsTable.storyboard}, '{scenes}', ${JSON.stringify(updated.scenes)}::jsonb)`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(videoGenerationsTable.id, job.id),
            eq(videoGenerationsTable.tenantId, req.tenantId),
            eq(videoGenerationsTable.status, "awaiting_review"),
          ),
        )
        .returning()
    )[0];
    if (!saved) {
      res.status(400).json({ error: "This video is not waiting for storyboard review." });
      return;
    }
    res.json(serializeVideoJob(saved));
  },
);

/** Approve the plan and run the expensive half. */
router.post(
  "/ai/video-jobs/:jobId/storyboard/approve",
  async (req: Request, res: Response) => {
    const loaded = await loadPausedJob(req, res);
    if (!loaded) return;
    if (await rejectDisabledVideoMode(loaded.job.engine, res)) return;
    const creativeIssues = lintStoryboardCreativeBrief(
      loaded.storyboard,
      loaded.job.options?.resolvedCreativeBrief,
    );
    if (creativeIssues.length > 0) {
      res.status(400).json({
        error: `Storyboard cannot be approved until its creative brief issues are fixed: ${creativeIssues
          .map((issue) => `"${issue.term}"`)
          .join(", ")}.`,
      });
      return;
    }

    // Claim atomically here rather than in the runner, so two approve requests
    // cannot both start a render (the second finds nothing to claim).
    const claimed = (
      await db
        .update(videoGenerationsTable)
        .set({
          status: "processing",
          stage: "Getting started",
          storyboardExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(videoGenerationsTable.id, loaded.job.id),
            eq(videoGenerationsTable.tenantId, req.tenantId),
            eq(videoGenerationsTable.status, "awaiting_review"),
            isNotNull(videoGenerationsTable.storyboard),
          ),
        )
        .returning()
    )[0];
    if (!claimed) {
      res.status(400).json({ error: "This video is not waiting for storyboard review." });
      return;
    }

    const accepted = enqueueBackgroundJob(() => resumeVideoGenerationJob(claimed));
    if (!accepted) {
      // Shutdown in progress: put the plan back so the user can approve again.
      // Nothing was charged, so there is nothing to refund.
      await db
        .update(videoGenerationsTable)
        .set({
          status: "awaiting_review",
          stage: null,
          storyboardExpiresAt: loaded.job.storyboardExpiresAt,
        })
        .where(eq(videoGenerationsTable.id, claimed.id));
      res.status(503).json({ error: "Server is restarting. Please retry in a moment." });
      return;
    }
    res.status(202).json(serializeVideoJob(claimed));
  },
);

/** Abandon the plan now instead of waiting for it to expire, and refund. */
router.post(
  "/ai/video-jobs/:jobId/storyboard/discard",
  async (req: Request, res: Response) => {
    const loaded = await loadPausedJob(req, res);
    if (!loaded) return;

    const discarded = (
      await db
        .update(videoGenerationsTable)
        .set({
          status: "failed",
          error: "You discarded this storyboard. Nothing was charged.",
          stage: null,
          storyboardExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(videoGenerationsTable.id, loaded.job.id),
            eq(videoGenerationsTable.tenantId, req.tenantId),
            eq(videoGenerationsTable.status, "awaiting_review"),
          ),
        )
        .returning()
    )[0];
    // Conditional on status, so only the request that actually flipped the row
    // issues the refund — a double discard cannot refund twice.
    if (!discarded) {
      res.status(400).json({ error: "This video is not waiting for storyboard review." });
      return;
    }
    const discardedReservation = reservationFromRow(discarded);
    if (discardedReservation) {
      await refundWallet(
        req.tenantId,
        discardedReservation,
        "storyboard discarded",
      ).catch((err) =>
        req.log.error({ err, jobId: discarded.id }, "Failed to refund discarded storyboard"),
      );
    } else if (discarded.funding === "credit") {
      await refundCredits(
        req.tenantId,
        "video",
        videoJobUnits(discarded.engine, discarded.options),
        "storyboard discarded",
      ).catch((err) =>
        req.log.error({ err, jobId: discarded.id }, "Failed to refund discarded storyboard"),
      );
    }
    res.json(serializeVideoJob(discarded));
  },
);

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
