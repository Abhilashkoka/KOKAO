import { Router, type IRouter, type Request, type Response } from "express";
import { createHash } from "node:crypto";
import {
  db,
  aiModelPricesTable,
  isPromptVariantKey,
  tenantsTable,
  contentItemsTable,
  videoGenerationsTable,
  videoStyleProfilesTable,
  brandKitsTable,
  charactersTable,
  characterOutfitsTable,
  guidedStoryDraftsTable,
  walletProviderOperationsTable,
  storyboardPreviewsAreGenerated,
  type CreativeDirection,
  type VideoJobOptions,
  type VideoStoryboardScene,
  type GuidedStoryDraft,
  type GuidedStoryDraftState,
  type GuidedStoryCastSnapshot,
} from "@workspace/db";
import { and, eq, desc, isNotNull, ne, sql } from "drizzle-orm";
import {
  GenerateVideoBody,
  ImportLibraryMusicBody,
  SaveVideoToLibraryBody,
  UpdateVideoStoryboardBody,
  InsertVideoStoryboardSceneBody,
  GenerateSpokespersonScriptBody,
  AnalyzeScriptIntakeBody,
  GetVideoCapabilitiesResponse,
  RepairVideoJobBody,
  CreateGuidedStoryDraftBody,
  UpdateGuidedStoryDraftBody,
  GenerateGuidedStoryDraftScriptBody,
  GenerateGuidedStoryDraftSceneBody,
  ApproveGuidedStoryDraftScriptBody,
  CastGuidedStoryDraftBody,
  EnqueueGuidedStoryDraftBody,
  CorrectGuidedStorySceneBody,
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
  validateGuidedCastWalletCheckpoint,
  WalletProviderPostSuccessError,
  WalletProviderSuccessPersistenceError,
  type WalletProviderOperationKind,
  type WalletReservation,
  insertWalletFundedStoryboardScene,
  rollbackWalletFundedStoryboardScene,
} from "../lib/wallet";
import { enqueueBackgroundJob } from "../lib/backgroundJobs";
import {
  runVideoGenerationJob,
  resumeVideoGenerationJob,
  fundPlannedTemplateVisualWork,
  plannedTemplateUnits,
  refreshStoryboardScenePreview,
  runVideoRepairJob,
  runGuidedPreviewRenderJob,
  runGuidedSceneCorrectionJob,
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
import {
  hybridNarrationConsumesVideoUnit,
  remainingHybridUnits,
  videoJobFullUnits,
  videoJobUnits,
} from "../lib/videoGen/units";
import {
  MOTION_PRESETS,
  MOTION_PRESET_CATEGORIES,
  isMotionPresetId,
} from "../lib/videoGen/motionPresets";
import {
  TIER_UNIT_MULTIPLIER,
  findVideoModel,
  resolveModelOptions,
  supportsEndFrame,
  supportsMode,
  videoModelMultiplier,
} from "../lib/videoGen/modelCatalog";
import {
  OPENROUTER_INPUT_IMAGE_PRIVACY_CODE,
  parsePersistedOpenRouterInputImagePrivacyError,
} from "../lib/videoGen/providers/openrouter";
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
import {
  generateCharacterReference,
  getCharacterDetail,
  isOutfitSelectable,
  resolveOutfit,
} from "../lib/characters";
import {
  getPresetForTenant,
  presetSnapshot as makePresetSnapshot,
} from "../lib/presetCharacters";
import {
  releaseImageFunding,
  reserveImageFunding,
  settleImageFunding,
  isConfirmedImageFailure,
} from "./characters";
import { uploadBufferToStorage } from "../lib/storageUpload";
import { validateSuppliedPlan } from "../lib/videoGen/topicVideo/suppliedPlan";
import {
  normalizeLocalizedNarrationSelection,
  type LocalizedNarrationSelection,
} from "../lib/videoGen/topicVideo/tts";
import { splitIntoSentences } from "../lib/videoGen/topicVideo/narration";
import { synthesizeGuidedNarration } from "../lib/videoGen/topicVideo";
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
import {
  listElevenLabsPremadeVoices,
  VoiceCloneNotConfiguredError,
} from "../lib/voiceClone";
import { loadStyleGuidance } from "../lib/videoGen/referenceAnalyzer";
import { analyzeScriptIntake } from "../lib/videoGen/scriptIntake";
import { getTextGenClient, TextGenNotConfiguredError } from "../lib/textGen";
import {
  assertTemplateSafe,
  resolveCreativeBrief,
  missingSlots,
  hasNativeTemplateRuntimeSettings,
  resolveTemplateRuntimeSettings,
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
  computeVideoCostPaise,
  computeTextCostPaise,
  findModelPrice,
  getAiCostConfig,
  usdToPaise,
} from "../lib/aiCost";
import { videoPriceCriteria } from "../lib/videoGen/pricing";
import { syncModelPricingBestEffort } from "../lib/modelPricingSync";
import {
  LATENT_SYNC,
  SYNC_LIPSYNC_2,
  type LipSyncQuality,
} from "../lib/videoGen/lipSyncModels";
import {
  GUIDED_STORY_GENRES,
  GUIDED_STORY_PLATFORMS,
  GUIDED_SCENE_INSERTION_CLAIM_TTL_MS,
  generateGuidedStoryScript,
  generateGuidedStorySceneInsertion,
  guidedStoryPlatform,
  guidedStoryRolePlan,
  guidedCastHasDuplicates,
  guidedCastFailureDisposition,
  guidedCastOperationCanRestart,
  guidedCastOperationCanResume,
  guidedStoryApprovalSnapshotMatches,
  guidedStoryEstimates,
  validateGuidedResumableCastOperation,
  invalidateGuidedStoryDownstream,
  governedGuidedCastPrompt,
  guidedStoryStoryboard,
  validateAndRepairGuidedScript,
} from "../lib/videoGen/guidedStory";

const router: IRouter = Router();
const MAX_LOCALIZED_DUB_DURATION_MS = 30 * 60 * 1000;
const MAX_PRESENTER_VIDEO_BYTES = 100 * 1024 * 1024;
const PRESENTER_VIDEO_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);
const MAX_DIALOGUE_LIP_SYNC_DURATION_SEC = 30;
const GUIDED_STORY_STOCK_VOICES = [
  "alloy",
  "echo",
  "fable",
  "onyx",
  "nova",
  "shimmer",
] as const;
const GUIDED_STORY_STOCK_VOICE_SET = new Set<string>(GUIDED_STORY_STOCK_VOICES);

type GuidedStoryCloneCatalogItem = {
  id: string;
  label: string;
  providerVoiceId: string;
  brandKitId: number;
  /** IDs accepted from pre-catalog Brand Kit clients and persisted drafts. */
  legacyIds: string[];
};

async function guidedStoryCloneCatalog(
  tenantId: number,
): Promise<GuidedStoryCloneCatalogItem[]> {
  const kits = await db
    .select()
    .from(brandKitsTable)
    .where(
      and(
        eq(brandKitsTable.tenantId, tenantId),
        eq(brandKitsTable.status, "active"),
        eq(brandKitsTable.isArchived, false),
      ),
    );
  const output: GuidedStoryCloneCatalogItem[] = [];
  for (const kit of kits) {
    const active = await loadActivePayload(tenantId, kit.id);
    const voice = active?.payload.brand_voice;
    if (!voice) continue;
    const entries = voice.voices ?? [];
    const knownProviderIds = new Set<string>();
    for (const entry of entries) {
      if (entry.provider !== "elevenlabs" || !entry.provider_voice_id) continue;
      knownProviderIds.add(entry.provider_voice_id);
      output.push({
        id: `brand-kit:${kit.id}:${entry.id}`,
        label: entry.label,
        providerVoiceId: entry.provider_voice_id,
        brandKitId: kit.id,
        legacyIds: [entry.id],
      });
    }
    if (
      voice.mode === "cloned" &&
      voice.provider === "elevenlabs" &&
      voice.provider_voice_id &&
      !knownProviderIds.has(voice.provider_voice_id)
    ) {
      output.push({
        id: `brand-kit:${kit.id}:active`,
        label: voice.cloned_label || "Active Brand Voice",
        providerVoiceId: voice.provider_voice_id,
        brandKitId: kit.id,
        legacyIds: ["active", voice.provider_voice_id],
      });
    }
  }
  return output;
}
const MAX_CHARACTER_DIALOGUE_DURATION_SEC = 180;

/**
 * Direct clip engines make one homogeneous provider call per unit, so their
 * exact selected variant can safely size the wallet reservation. Composite
 * workflows keep the conservative display reservation and settle from their
 * per-provider receipts because they can span several models.
 */
async function directVideoReservationPrice(
  engine: string,
  options: NonNullable<VideoGeneration["options"]>,
  units: number,
): Promise<{
  provider: string;
  model: string;
  totalCostPaise: number;
} | null> {
  if (engine !== "text_to_video" && engine !== "image_to_video") return null;
  const mode = engine === "text_to_video" ? "text" : "image";
  const picked = findVideoModel(options.modelId);
  const selection = await getVideoGenSelection();
  const providerDef = picked
    ? await resolveVideoGenProviderDef(picked.provider)
    : await resolveVideoGenProviderDef(selection.provider);
  if (!providerDef) return null;
  const model =
    picked?.models[mode] ??
    effectiveVideoModel(
      providerDef,
      mode,
      mode === "text"
        ? selection.textToVideoModel
        : selection.imageToVideoModel,
    );
  const resolved = resolveModelOptions(options, options.durationSec ?? 5);
  const oneCall = await computeVideoCostPaise({
    provider: providerDef.id,
    model,
    durationSec: resolved.durationSec,
    variantCriteria: videoPriceCriteria({
      resolution: resolved.resolution,
      quality: resolved.quality,
      generateAudio: resolved.generateAudio,
    }),
  });
  if (oneCall === null || oneCall <= 0) return null;
  return {
    provider: providerDef.id,
    model,
    totalCostPaise: oneCall * Math.max(1, units),
  };
}

type BillableScriptResult = {
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costPaise: number | null;
};

class StaleBillableScriptOperationError extends Error {
  constructor() {
    super("The draft changed while AI work was in progress.");
  }
}

async function runBillableScriptRequest<T extends BillableScriptResult>(args: {
  req: Request;
  tenantModel: string;
  operationKind: Extract<
    WalletProviderOperationKind,
    "video_script_intake" | "video_script_draft"
  >;
  perform: () => Promise<T>;
  /** Runs after provider completion, before success persistence or settlement. */
  beforeSettlement?: (result: T) => Promise<boolean>;
  operationKey?: string;
  onFundingReady?: (funding: "wallet" | "unmetered") => Promise<boolean>;
}): Promise<{
  result: T;
  funding: "wallet" | "unmetered";
  chargedPaise: number | null;
} | null> {
  if (!(await isWalletFunded(args.req.tenantId))) {
    if (args.onFundingReady && !(await args.onFundingReady("unmetered"))) {
      throw new StaleBillableScriptOperationError();
    }
    const result = await args.perform();
    if (args.beforeSettlement && !(await args.beforeSettlement(result))) {
      throw new StaleBillableScriptOperationError();
    }
    return {
      result,
      funding: "unmetered",
      chargedPaise: null,
    };
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
    if (args.onFundingReady && !(await args.onFundingReady("wallet"))) {
      throw new StaleBillableScriptOperationError();
    }
    const executed = await executeWalletProviderOperation(
      {
        tenantId: args.req.tenantId,
        reservation,
        operationKind: args.operationKind,
        operationKey:
          args.operationKey ?? `${args.operationKind}:${reservation.id}`,
        settlement: {
          kind: "caption",
          costPaise: null,
          provider: selectedTextGen.provider,
          model: selectedTextGen.model,
          refKind: "videoScript",
          refId: `${args.operationKind}:${reservation.id}`,
        },
      },
      async () => {
        const result = await args.perform();
        if (args.beforeSettlement && !(await args.beforeSettlement(result))) {
          throw new StaleBillableScriptOperationError();
        }
        return result;
      },
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
    const settled = await settleWalletProviderOperationDurably(
      executed.operationId,
    ).catch((error) => {
      args.req.log.error(
        { err: error, operationId: executed.operationId },
        "Failed to hand off script wallet settlement",
      );
      return null;
    });
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
        args.req.log.error(
          { err: refundError },
          "Failed to refund script wallet reservation",
        ),
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
  return Math.max(
    3,
    Math.ceil(words / 1.8 + Math.max(0, sentences - 1) * 0.25 + 0.6),
  );
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
  const vertical =
    aspectRatio === "9:16" || aspectRatio === "3:4" || aspectRatio === "4:5";
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
function brandCreativeDirection(
  payload: Awaited<ReturnType<typeof loadActivePayload>>,
): CreativeDirection | null {
  if (!payload) return null;
  const colors = [
    ...payload.payload.colors.primary,
    ...payload.payload.colors.secondary,
  ]
    .map((color) => color.hex.trim())
    .filter((color) => /^#?[0-9a-f]{6}$/i.test(color))
    .slice(0, 8);
  const traits = payload.payload.voice.traits.filter(Boolean).slice(0, 5);
  const audience = payload.payload.identity.audience
    .filter(Boolean)
    .slice(0, 3);
  const guidance = [
    traits.length ? `Use a ${traits.join(", ")} brand voice.` : null,
    audience.length ? `Address ${audience.join(", ")}.` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const restricted = payload.payload.brand_controls.restricted_terms
    .filter(Boolean)
    .slice(0, 24);
  if (!guidance && colors.length === 0 && restricted.length === 0) return null;
  return {
    version: 1,
    ...(guidance
      ? { narrative: { guidance, forbiddenVocabulary: restricted } }
      : restricted.length
        ? { narrative: { forbiddenVocabulary: restricted } }
        : {}),
    ...(colors.length ? { visual: { palette: colors } } : {}),
  };
}

function isVideoRepairable(job: VideoGeneration): boolean {
  const board = job.storyboard;
  if (
    job.status !== "succeeded" ||
    job.engine !== "topic_to_video" ||
    job.options?.repair ||
    !job.videoPath ||
    !board?.narration ||
    board.scenes.length === 0 ||
    (job.options?.musicPrompt?.trim() &&
      !job.options.musicPath &&
      !job.options.musicCheckpoint?.path)
  ) {
    return false;
  }
  if (board.visualsSource === "ai") {
    return board.scenes.every((scene) => Boolean(scene.previewPath));
  }
  if (
    board.visualsSource === "ai_video" ||
    board.visualsSource === "character"
  ) {
    return board.scenes.every((scene) =>
      Boolean(scene.previewPath && scene.providerCheckpoint?.path),
    );
  }
  return false;
}

function blocksAnotherRepair(job: VideoGeneration): boolean {
  return (
    Boolean(job.options?.repair) &&
    job.status !== "failed" &&
    job.status !== "cancelled"
  );
}

function serializeVideoJob(
  job: VideoGeneration,
  retryableOverride?: boolean,
  lineage?: {
    currentVideoPath?: string | null;
    hasRepairChild?: boolean;
    savedContentItemId?: number | null;
  },
) {
  const recovery = job.options?.recovery;
  const legacyRetry = job.options?.characterDialogue?.retry;
  const failedInventory =
    job.status === "failed" && RECOVERABLE_VIDEO_ENGINES.has(job.engine)
      ? videoRecoveryInventory(job)
      : null;
  const privacyRecoveryCapability = historicalPrivacyRecoveryCapability(job);
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
    aiPrompt:
      job.engine === "image_to_video" ? animatePhotoAiPrompt(job) : null,
    sourceImagePaths: job.sourceImagePaths ?? [],
    aspectRatio: job.options?.aspectRatio ?? "9:16",
    modelId: job.options?.modelId ?? null,
    resolution: job.options?.resolution ?? null,
    motionPreset: job.options?.motionPreset ?? null,
    cinematography: job.options?.cinematography ?? null,
    seed: job.options?.seed ?? null,
    resolvedCreativeBrief: job.options?.resolvedCreativeBrief ?? null,
    videoPath: job.videoPath ?? null,
    currentVideoPath: lineage?.currentVideoPath ?? job.videoPath ?? null,
    thumbnailPath: job.thumbnailPath ?? null,
    provider: job.provider ?? null,
    model: job.model ?? null,
    error: job.error ?? null,
    providerRequestId: job.providerRequestId ?? null,
    errorHistory: job.errorHistory ?? [],
    stage: job.stage ?? null,
    durationMs: job.durationMs ?? null,
    // How many video units this job actually charges (multi-shot clips,
    // character/AI-visual scene groups, review-added scenes, AI music bed).
    // Prefer the persisted wallet reservation when present (it tracks
    // review-time additions transactionally); otherwise recompute from the
    // options, which videoJobUnits keeps in sync with every funding path.
    units: job.walletReservedUnits ?? videoJobUnits(job.engine, job.options),
    // Template planning can hold its initial unit while the immutable board
    // has a larger exact requirement. Do not present held units as required.
    requiredUnits:
      job.options?.storyboardFunding?.requiredUnits ??
      job.walletReservedUnits ??
      videoJobUnits(job.engine, job.options),
    retryable:
      retryableOverride ??
      (job.status === "failed" &&
        RECOVERABLE_VIDEO_ENGINES.has(job.engine) &&
        legacyRetry?.childJobId == null),
    privacyRecoveryCapability,
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
    freshRestart: job.options?.freshRestart ?? null,
    repairable: isVideoRepairable(job) && !lineage?.hasRepairChild,
    repair: job.options?.repair
      ? {
          chainId: job.options.repair.chainId,
          sourceJobId: job.options.repair.sourceJobId,
          reason: job.options.repair.reason,
        }
      : null,
    guidedPreviewRender: job.options?.guidedPreviewRender
      ? {
          ...job.options.guidedPreviewRender,
          retryable: job.options.guidedPreviewRender.state === "failed",
        }
      : null,
    // Per-unit display rate frozen at charge time; null on legacy rows,
    // which clients price at the current rate instead.
    chargedRatePaise: job.chargedRatePaise ?? null,
    // The REAL snapshotted tenant-facing spend for this job (all units
    // summed), taken from its usage events at settle. Null until the job
    // succeeds or on legacy rows; clients fall back to chargedRatePaise x units.
    spendPaise: job.spendPaise ?? null,
    savedContentItemId:
      lineage?.savedContentItemId ?? job.savedContentItemId ?? null,
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
    await db
      .select()
      .from(tenantsTable)
      .where(eq(tenantsTable.id, req.tenantId))
      .limit(1)
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
      perform: () =>
        analyzeScriptIntake({
          tenantId: req.tenantId,
          tenantAiModel: tenant.aiModel,
          topic: body.topic.trim(),
          variant: isPromptVariantKey(body.variant) ? body.variant : null,
          hasBrandKit: Boolean(body.brandKitId),
        }),
    });
    if (!billed) {
      res
        .status(402)
        .json({
          error:
            "Your wallet balance can't cover script analysis. Recharge to continue.",
        });
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
      ...(result.inputTokens !== null
        ? { inputTokens: result.inputTokens }
        : {}),
      ...(result.outputTokens !== null
        ? { outputTokens: result.outputTokens }
        : {}),
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
      res
        .status(503)
        .json({
          error: "AI script writing is not configured. Contact your admin.",
        });
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
    await db
      .select()
      .from(tenantsTable)
      .where(eq(tenantsTable.id, req.tenantId))
      .limit(1)
  )[0];
  if (!tenant) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const startedAt = Date.now();
  try {
    const body = parsed.data;
    if (body.targetLocale && !characterDialogueLocale(body.targetLocale)) {
      res
        .status(400)
        .json({ error: `Unsupported target locale: ${body.targetLocale}.` });
      return;
    }
    const billed = await runBillableScriptRequest({
      req,
      tenantModel: tenant.aiModel,
      operationKind: "video_script_draft",
      perform: () =>
        generateSpokespersonScript({
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
      res
        .status(402)
        .json({
          error:
            "Your wallet balance can't cover script writing. Recharge to continue.",
        });
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
      ...(result.inputTokens !== null
        ? { inputTokens: result.inputTokens }
        : {}),
      ...(result.outputTokens !== null
        ? { outputTokens: result.outputTokens }
        : {}),
      ...(result.costPaise !== null ? { costPaise: result.costPaise } : {}),
      ...(result.cachedInputTokens !== null
        ? { cachedInputTokens: result.cachedInputTokens }
        : {}),
      ...(result.reasoningTokens !== null
        ? { reasoningTokens: result.reasoningTokens }
        : {}),
    }).catch((error) => {
      req.log.warn(
        { err: error },
        "Spokesperson script usage recording failed",
      );
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
      res
        .status(503)
        .json({
          error: "AI script writing is not configured. Contact your admin.",
        });
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
  const chargeRate = (usd: number | null): number | null => {
    if (usd === null) return null;
    const basePaise = usdToPaise(usd, args.usdToInrPaise);
    return basePaise === null ? null : withFee(basePaise, args.feePercent);
  };
  const prices = await db
    .select()
    .from(aiModelPricesTable)
    .where(
      and(
        eq(aiModelPricesTable.kind, "video"),
        sql`lower(trim(${aiModelPricesTable.provider})) = lower(${args.provider.trim()})`,
        sql`lower(trim(${aiModelPricesTable.model})) = lower(${args.model.trim()})`,
      ),
    );
  return {
    provider: args.provider,
    model: args.model,
    // Model-level figures intentionally expose legacy/default rows only.
    paisePerSecond: chargeRate(
      prices.find((row) => row.variantKey === "")?.usdPerSecond ?? null,
    ),
    paisePerVideo: chargeRate(
      prices.find((row) => row.variantKey === "")?.usdPerVideo ?? null,
    ),
    variants: prices
      .filter((row) => row.variantKey !== "")
      .map((row) => ({
        criteria: row.variantCriteria ?? {},
        paisePerSecond: chargeRate(row.usdPerSecond),
        paisePerVideo: chargeRate(row.usdPerVideo),
      })),
  };
}

/** A tenant-authenticated, server-owned snapshot; clients never choose models, prices, or fonts. */
router.get(
  "/ai/video-capabilities",
  async (_req: Request, res: Response): Promise<void> => {
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
    const [textToVideo, imageToVideo, lipSync, serializedLipSyncHigh] =
      await Promise.all([
        provider
          ? serializeVideoCostModel({
              ...common,
              provider: provider.id,
              model: effectiveVideoModel(
                provider,
                "text",
                selection.textToVideoModel,
              ),
            })
          : null,
        provider
          ? serializeVideoCostModel({
              ...common,
              provider: provider.id,
              model: effectiveVideoModel(
                provider,
                "image",
                selection.imageToVideoModel,
              ),
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
  },
);

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
      error instanceof MusicLibraryError
        ? error.message
        : "Music search failed. Please try again.";
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
      modes: (["text", "image"] as const).filter((mode) =>
        Boolean(m.models[mode]),
      ),
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
    presets: MOTION_PRESETS.map(({ id, label, category }) => ({
      id,
      label,
      category,
    })),
  });
});

function serializeGuidedDraft(row: GuidedStoryDraft) {
  return {
    id: row.id,
    revision: row.revision,
    ...row.state,
    castOperations: undefined,
    estimates: guidedStoryEstimates(row.state, {
      tenantId: row.tenantId,
      draftId: row.id,
      revision: row.revision,
    }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadGuidedDraft(
  tenantId: number,
  draftId: number,
): Promise<GuidedStoryDraft | null> {
  if (!Number.isSafeInteger(draftId) || draftId <= 0) return null;
  return (
    (
      await db
        .select()
        .from(guidedStoryDraftsTable)
        .where(
          and(
            eq(guidedStoryDraftsTable.id, draftId),
            eq(guidedStoryDraftsTable.tenantId, tenantId),
          ),
        )
        .limit(1)
    )[0] ?? null
  );
}

/**
 * Repairs the only crash window in guided enqueue: a job row may be committed
 * after the draft claim but before the draft can point at it. The immutable
 * guided snapshot is the durable join key, so this is safe across processes
 * and never guesses from a client id.
 */
async function reconcileGuidedStoryboardClaim(
  tenantId: number,
  draft: GuidedStoryDraft,
): Promise<VideoGeneration | null> {
  if (draft.state.storyboardJobId !== -1) return null;
  const jobs = await db
    .select()
    .from(videoGenerationsTable)
    .where(eq(videoGenerationsTable.tenantId, tenantId))
    .orderBy(desc(videoGenerationsTable.id))
    .limit(100);
  const job = jobs.find(
    (candidate) => candidate.options?.guidedStory?.draftId === draft.id,
  );
  if (!job) return null;
  await db
    .update(guidedStoryDraftsTable)
    .set({
      state: { ...draft.state, storyboardJobId: job.id },
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(guidedStoryDraftsTable.id, draft.id),
        eq(guidedStoryDraftsTable.tenantId, tenantId),
        eq(guidedStoryDraftsTable.revision, draft.revision),
        sql`${guidedStoryDraftsTable.state}->>'storyboardJobId' = '-1'`,
      ),
    );
  return job;
}

function guidedSetup(
  input: {
    genre: string;
    platform: string;
    durationSeconds: number;
    locale: string;
    topic: string;
    roleCount: number;
    brandKitId?: number | null;
  },
  allowManualRoleCount = false,
): NonNullable<GuidedStoryDraftState["setup"]> | null {
  const platform = guidedStoryPlatform(input.platform);
  if (!platform || !GUIDED_STORY_GENRES.includes(input.genre as never))
    return null;
  let plan;
  try {
    plan = guidedStoryRolePlan(input.platform, input.durationSeconds);
  } catch {
    return null;
  }
  if (
    !plan.allowed.includes(input.roleCount) &&
    !(allowManualRoleCount && input.roleCount >= 2 && input.roleCount <= 4)
  )
    return null;
  return {
    genre: input.genre as NonNullable<GuidedStoryDraftState["setup"]>["genre"],
    platform: input.platform as NonNullable<
      GuidedStoryDraftState["setup"]
    >["platform"],
    aspectRatio: platform.aspectRatio,
    width: platform.width,
    height: platform.height,
    safeArea: platform.safeArea,
    durationSeconds: input.durationSeconds,
    locale: input.locale.trim(),
    topic: input.topic.trim(),
    roleCount: input.roleCount,
    brandKitId: input.brandKitId ?? null,
  };
}

function canonicalGuidedVisualObjectPath(path: string, tenantId: number): boolean {
  return !path.includes("..") &&
    !path.includes("\\") &&
    !path.includes("?") &&
    !path.includes("#") &&
    new RegExp(`^/objects/${tenantId}/uploads/[A-Za-z0-9][A-Za-z0-9._-]*$`).test(path);
}

function hasOnlyGuidedVisualFields(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["revision", "setup", "script", "visualChoices"].includes(key))) return false;
  if (!("visualChoices" in input)) return true;
  const choices = input.visualChoices;
  if (!choices || typeof choices !== "object" || Array.isArray(choices)) return false;
  const visual = choices as Record<string, unknown>;
  if (Object.keys(visual).some((key) => key !== "logo" && key !== "location")) return false;
  for (const [item, fields] of [
    [visual.logo, ["path", "sceneIds"]],
    [visual.location, ["mode", "imagePath", "description"]],
  ] as Array<[unknown, string[]]>) {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        Object.keys(item as Record<string, unknown>).some((key) => !fields.includes(key))) return false;
  }
  return true;
}

function validateGuidedVisualChoices(
  value: {
    logo?: { path?: string | null; sceneIds?: string[] } | null;
    location?: { mode?: "none" | "image" | "text"; imagePath?: string | null; description?: string | null } | null;
  },
  script: GuidedStoryDraftState["script"],
  tenantId: number,
): GuidedStoryDraftState["visualChoices"] | null {
  const logo = value.logo;
  const location = value.location;
  if (!logo || !location || !script) return null;
  const logoPath = logo.path ?? null;
  const sceneIds = logo.sceneIds ?? [];
  if ((logoPath !== null && !canonicalGuidedVisualObjectPath(logoPath, tenantId)) ||
      (logoPath === null && sceneIds.length > 0) ||
      new Set(sceneIds).size !== sceneIds.length ||
      sceneIds.some((id) => !script.scenes.some((scene) => scene.id === id))) return null;
  if (location.mode === "none" && location.imagePath == null && location.description == null) {
    return { version: 1, logo: { path: logoPath, sceneIds }, location: { mode: "none", imagePath: null, description: null } };
  }
  if (location.mode === "image" && typeof location.imagePath === "string" &&
      canonicalGuidedVisualObjectPath(location.imagePath, tenantId) && location.description == null) {
    return { version: 1, logo: { path: logoPath, sceneIds }, location: { mode: "image", imagePath: location.imagePath, description: null } };
  }
  if (location.mode === "text" && location.imagePath == null && typeof location.description === "string" &&
      location.description.trim().length >= 3 && location.description.trim().length <= 1000) {
    return { version: 1, logo: { path: logoPath, sceneIds }, location: { mode: "text", imagePath: null, description: location.description.trim() } };
  }
  return null;
}

async function saveGuidedState(
  row: GuidedStoryDraft,
  revision: number,
  state: GuidedStoryDraftState,
): Promise<GuidedStoryDraft | null> {
  if (revision !== row.revision) return null;
  return (
    (
      await db
        .update(guidedStoryDraftsTable)
        .set({ state, revision: row.revision + 1, updatedAt: new Date() })
        .where(
          and(
            eq(guidedStoryDraftsTable.id, row.id),
            eq(guidedStoryDraftsTable.tenantId, row.tenantId),
            eq(guidedStoryDraftsTable.revision, row.revision),
          ),
        )
        .returning()
    )[0] ?? null
  );
}

function guidedSceneInsertionClaimActive(
  claim: GuidedStoryDraftState["sceneInsertionGeneration"],
): boolean {
  return Boolean(
    claim &&
      (claim.phase === "finalizing" ||
        (Number.isFinite(Date.parse(claim.expiresAt)) &&
          Date.parse(claim.expiresAt) > Date.now())),
  );
}

const GUIDED_SCENE_INSERTION_RECOVERY_AGE_MS = 5 * 60 * 1000;

function guidedSceneInsertionRequestKey(input: {
  revision: number;
  insertionIndex: number;
  description: string;
  script: GuidedStoryDraftState["script"];
}): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

async function claimGuidedSceneInsertion(params: {
  tenantId: number;
  draftId: number;
  revision: number;
  requestKey: string;
}): Promise<{ row: GuidedStoryDraft | null; operationKey: string | null; busy: boolean }> {
  return db.transaction(async (tx) => {
    const row = (
      await tx.select().from(guidedStoryDraftsTable).where(
        and(eq(guidedStoryDraftsTable.id, params.draftId), eq(guidedStoryDraftsTable.tenantId, params.tenantId)),
      ).for("update").limit(1)
    )[0];
    if (!row || row.revision !== params.revision) return { row: null, operationKey: null, busy: false };
    if (guidedSceneInsertionClaimActive(row.state.sceneInsertionGeneration)) {
      return { row: null, operationKey: null, busy: true };
    }
    const now = new Date();
    const operationKey = `guided-story-scene:${row.id}:${row.revision}:${now.getTime()}`;
    const [claimed] = await tx.update(guidedStoryDraftsTable).set({
      state: {
        ...row.state,
        sceneInsertionGeneration: {
          revision: row.revision,
          operationKey,
          requestKey: params.requestKey,
          phase: "generating",
          claimedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + GUIDED_SCENE_INSERTION_CLAIM_TTL_MS).toISOString(),
        },
      },
      updatedAt: now,
    }).where(and(eq(guidedStoryDraftsTable.id, row.id), eq(guidedStoryDraftsTable.revision, row.revision))).returning();
    return { row: claimed ?? null, operationKey: claimed ? operationKey : null, busy: false };
  });
}

async function finalizeGuidedSceneInsertionClaim(
  row: GuidedStoryDraft,
  operationKey: string,
  result: {
    insertedSceneId: string;
    script: NonNullable<GuidedStoryDraftState["script"]>;
  },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const fresh = (
      await tx.select().from(guidedStoryDraftsTable).where(
        and(
          eq(guidedStoryDraftsTable.id, row.id),
          eq(guidedStoryDraftsTable.tenantId, row.tenantId),
          eq(guidedStoryDraftsTable.revision, row.revision),
        ),
      ).for("update").limit(1)
    )[0];
    const claim = fresh?.state.sceneInsertionGeneration;
    if (
      !fresh ||
      !claim ||
      claim.operationKey !== operationKey ||
      claim.revision !== row.revision ||
      claim.phase !== "generating" ||
      !Number.isFinite(Date.parse(claim.expiresAt)) ||
      Date.parse(claim.expiresAt) <= Date.now() ||
      fresh.state.scriptGeneration !== null ||
      Object.keys(fresh.state.castOperations ?? {}).length > 0 ||
      fresh.state.storyboardJobId !== null
    ) {
      return false;
    }
    const [transitioned] = await tx.update(guidedStoryDraftsTable).set({
      state: {
        ...fresh.state,
        sceneInsertionGeneration: {
          ...claim,
          phase: "finalizing",
          finalizedAt: new Date().toISOString(),
          result,
        },
      },
      updatedAt: new Date(),
    }).where(
      and(
        eq(guidedStoryDraftsTable.id, fresh.id),
        eq(guidedStoryDraftsTable.tenantId, fresh.tenantId),
        eq(guidedStoryDraftsTable.revision, fresh.revision),
      ),
    ).returning({ id: guidedStoryDraftsTable.id });
    return Boolean(transitioned);
  });
}

async function setGuidedSceneInsertionFunding(
  row: GuidedStoryDraft,
  operationKey: string,
  fundingMode: "wallet" | "unmetered",
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const fresh = (
      await tx.select().from(guidedStoryDraftsTable).where(
        and(
          eq(guidedStoryDraftsTable.id, row.id),
          eq(guidedStoryDraftsTable.tenantId, row.tenantId),
          eq(guidedStoryDraftsTable.revision, row.revision),
        ),
      ).for("update").limit(1)
    )[0];
    const claim = fresh?.state.sceneInsertionGeneration;
    if (
      !fresh ||
      !claim ||
      claim.operationKey !== operationKey ||
      claim.phase !== "generating" ||
      guidedSceneInsertionClaimActive(claim) === false
    ) {
      return false;
    }
    const [updated] = await tx.update(guidedStoryDraftsTable).set({
      state: {
        ...fresh.state,
        sceneInsertionGeneration: { ...claim, fundingMode },
      },
      updatedAt: new Date(),
    }).where(
      and(
        eq(guidedStoryDraftsTable.id, fresh.id),
        eq(guidedStoryDraftsTable.tenantId, fresh.tenantId),
        eq(guidedStoryDraftsTable.revision, fresh.revision),
      ),
    ).returning({ id: guidedStoryDraftsTable.id });
    return Boolean(updated);
  });
}

async function recoverGuidedSceneInsertionClaim(params: {
  row: GuidedStoryDraft;
  requestKey: string;
}): Promise<{
  row: GuidedStoryDraft;
  operationKey: string;
  result: NonNullable<
    NonNullable<GuidedStoryDraftState["sceneInsertionGeneration"]>["result"]
  >;
} | null> {
  return db.transaction(async (tx) => {
    const fresh = (
      await tx.select().from(guidedStoryDraftsTable).where(
        and(
          eq(guidedStoryDraftsTable.id, params.row.id),
          eq(guidedStoryDraftsTable.tenantId, params.row.tenantId),
          eq(guidedStoryDraftsTable.revision, params.row.revision),
        ),
      ).for("update").limit(1)
    )[0];
    const claim = fresh?.state.sceneInsertionGeneration;
    const finalizedAt = claim?.finalizedAt
      ? Date.parse(claim.finalizedAt)
      : Number.NaN;
    if (
      !fresh ||
      !claim ||
      claim.phase !== "finalizing" ||
      claim.requestKey !== params.requestKey ||
      !claim.result ||
      !Number.isFinite(finalizedAt) ||
      Date.now() - finalizedAt < GUIDED_SCENE_INSERTION_RECOVERY_AGE_MS
    ) {
      return null;
    }
    const walletOperations = await tx
      .select({ status: walletProviderOperationsTable.status })
      .from(walletProviderOperationsTable)
      .where(
        and(
          eq(walletProviderOperationsTable.tenantId, fresh.tenantId),
          eq(
            walletProviderOperationsTable.operationKey,
            claim.walletOperationKey ?? claim.operationKey,
          ),
        ),
      );
    const terminalWalletOperation =
      walletOperations.length > 0 &&
      walletOperations.every((operation) =>
        ["settled", "refunded", "failed"].includes(operation.status),
      );
    const explicitlyUnmetered =
      claim.fundingMode === "unmetered" && walletOperations.length === 0;
    if (!terminalWalletOperation && !explicitlyUnmetered) {
      return null;
    }
    // Steal the release identity atomically. The abandoned request can no
    // longer clear protection while this recovery response is being handed off.
    const operationKey = `${claim.operationKey}:recovery:${Date.now()}`;
    const [recovered] = await tx.update(guidedStoryDraftsTable).set({
      state: {
        ...fresh.state,
        sceneInsertionGeneration: {
          ...claim,
          walletOperationKey: claim.walletOperationKey ?? claim.operationKey,
          operationKey,
        },
      },
      updatedAt: new Date(),
    }).where(
      and(
        eq(guidedStoryDraftsTable.id, fresh.id),
        eq(guidedStoryDraftsTable.tenantId, fresh.tenantId),
        eq(guidedStoryDraftsTable.revision, fresh.revision),
      ),
    ).returning();
    return recovered
      ? { row: recovered, operationKey, result: claim.result }
      : null;
  });
}

async function releaseGuidedSceneInsertionClaim(
  row: GuidedStoryDraft,
  operationKey: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const fresh = (
      await tx.select().from(guidedStoryDraftsTable).where(
        and(eq(guidedStoryDraftsTable.id, row.id), eq(guidedStoryDraftsTable.tenantId, row.tenantId), eq(guidedStoryDraftsTable.revision, row.revision)),
      ).for("update").limit(1)
    )[0];
    if (!fresh || fresh.state.sceneInsertionGeneration?.operationKey !== operationKey) return;
    const { sceneInsertionGeneration: _releasedClaim, ...releasedState } = fresh.state;
    await tx.update(guidedStoryDraftsTable).set({
      state: releasedState,
      updatedAt: new Date(),
    }).where(and(eq(guidedStoryDraftsTable.id, fresh.id), eq(guidedStoryDraftsTable.revision, fresh.revision)));
  });
}

const GUIDED_CAST_CLAIM_TTL_MS = 10 * 60 * 1000;

async function claimGuidedCastRoles(params: {
  tenantId: number;
  draftId: number;
  revision: number;
  strategy: "generated" | "saved";
  roles: Array<{ roleId: string; voiceId: string; generated: boolean }>;
}): Promise<{
  row: GuidedStoryDraft | null;
  busyRoleId?: string;
  malformedRoleId?: string;
  malformedReason?: string;
}> {
  return db.transaction(async (tx) => {
    const row = (
      await tx
        .select()
        .from(guidedStoryDraftsTable)
        .where(
          and(
            eq(guidedStoryDraftsTable.id, params.draftId),
            eq(guidedStoryDraftsTable.tenantId, params.tenantId),
          ),
        )
        .for("update")
        .limit(1)
    )[0];
    if (!row || row.revision !== params.revision) return { row: null };
    const now = new Date();
    const operations = { ...(row.state.castOperations ?? {}) };
    const expectedRoles = new Map(
      params.roles.map((role) => [role.roleId, role]),
    );
    for (const [roleId, operation] of Object.entries(operations)) {
      const expected = expectedRoles.get(roleId);
      if (!expected) {
        return {
          row,
          malformedRoleId: roleId,
          malformedReason:
            "operation belongs to a role outside this exact cast",
        };
      }
      const expectedKey = `guided-story-cast:${row.id}:${row.revision}:${roleId}`;
      if (
        operation.revision !== row.revision ||
        operation.operationKey !== expectedKey
      ) {
        return {
          row,
          malformedRoleId: roleId,
          malformedReason: "operation identity does not match this exact cast",
        };
      }
      if (operation.voiceId !== expected.voiceId) {
        // Narration voice is not an input to fictional character-image
        // generation. A retry may therefore keep an already-paid visual
        // checkpoint while adopting the user's latest voice selection.
        // Never rebind an in-flight/unknown provider operation.
        if (
          operation.status === "provider_succeeded" ||
          operation.status === "upload_succeeded" ||
          operation.status === "uploaded"
        ) {
          operations[roleId] = {
            ...operation,
            voiceId: expected.voiceId,
            updatedAt: now.toISOString(),
          };
        } else if (
          operation.status === "claimed" &&
          now.getTime() - new Date(operation.updatedAt).getTime() >=
            GUIDED_CAST_CLAIM_TTL_MS
        ) {
          // A request claims all roles up front. If it exits while processing an
          // earlier role, untouched later roles remain as harmless stale claims.
          // They have no provider boundary and can be replaced after the lease.
          delete operations[roleId];
          continue;
        } else {
          return {
            row,
            malformedRoleId: roleId,
            malformedReason: "operation identity does not match this exact cast",
          };
        }
      }
      const reconciledOperation = operations[roleId]!;
      if (
        reconciledOperation.status === "provider_succeeded" ||
        reconciledOperation.status === "upload_succeeded" ||
        reconciledOperation.status === "uploaded"
      ) {
        const semantic = validateGuidedResumableCastOperation({
          operation: reconciledOperation,
          tenantId: row.tenantId,
          draftId: row.id,
          revision: row.revision,
          roleId,
          voiceId: expected.voiceId,
        });
        if (!semantic.valid) {
          return {
            row,
            malformedRoleId: roleId,
            malformedReason: semantic.reason,
          };
        }
      }
    }
    // Every cast mutation gets a durable in-flight marker, including saved
    // assignments that make no provider call. Final storyboard approval locks
    // and checks these markers, closing the saved-cast commit window too.
    for (const role of params.roles) {
      const current = operations[role.roleId];
      const operationKey = `guided-story-cast:${row.id}:${row.revision}:${role.roleId}`;
      const resumable = current
        ? guidedCastOperationCanResume(current, {
            revision: row.revision,
            operationKey,
            voiceId: role.voiceId,
          })
        : false;
      const reusable =
        current?.revision === row.revision &&
        current.voiceId === role.voiceId &&
        guidedCastOperationCanRestart(
          current,
          now.getTime(),
          GUIDED_CAST_CLAIM_TTL_MS,
        );
      if (current && !reusable && !resumable)
        return { row, busyRoleId: role.roleId };
      if (
        !current ||
        current.revision !== row.revision ||
        current.voiceId !== role.voiceId
      ) {
        operations[role.roleId] = {
          revision: row.revision,
          operationKey,
          voiceId: role.voiceId,
          status: "claimed",
          claimedAt: now.toISOString(),
          updatedAt: now.toISOString(),
        };
      } else if (reusable) {
        // Only pre-provider claims are restarted. A stale provider_running is
        // intentionally permanent pending reconciliation: its outcome cannot
        // be inferred safely, so it must never trigger a duplicate call.
        operations[role.roleId] =
          current.status === "claimed" || current.status === "funded"
            ? {
                ...current,
                claimedAt: now.toISOString(),
                updatedAt: now.toISOString(),
              }
            : current;
      } else if (resumable) {
        // Preserve paid bytes/path, provider receipt, settlement marker and the
        // original stable key byte-for-byte. The route below can only upload,
        // settle, or commit this operation; it cannot cross the provider
        // boundary again.
        operations[role.roleId] = current;
      }
    }
    const state = {
      ...row.state,
      castStrategy: params.strategy,
      castOperations: operations,
    };
    const [saved] = await tx
      .update(guidedStoryDraftsTable)
      .set({ state, updatedAt: now })
      .where(
        and(
          eq(guidedStoryDraftsTable.id, row.id),
          eq(guidedStoryDraftsTable.revision, row.revision),
        ),
      )
      .returning();
    return { row: saved ?? null };
  });
}

async function checkpointGuidedCastOperation(params: {
  row: GuidedStoryDraft;
  roleId: string;
  operationKey: string;
  update: Partial<GuidedStoryDraftState["castOperations"][string]>;
}): Promise<GuidedStoryDraft | null> {
  return db.transaction(async (tx) => {
    const fresh = (
      await tx
        .select()
        .from(guidedStoryDraftsTable)
        .where(
          and(
            eq(guidedStoryDraftsTable.id, params.row.id),
            eq(guidedStoryDraftsTable.tenantId, params.row.tenantId),
            eq(guidedStoryDraftsTable.revision, params.row.revision),
          ),
        )
        .for("update")
        .limit(1)
    )[0];
    const operation = fresh?.state.castOperations?.[params.roleId];
    if (!fresh || operation?.operationKey !== params.operationKey) return null;
    const state = {
      ...fresh.state,
      castOperations: {
        ...fresh.state.castOperations,
        [params.roleId]: {
          ...operation,
          ...params.update,
          updatedAt: new Date().toISOString(),
        },
      },
    };
    return (
      (
        await tx
          .update(guidedStoryDraftsTable)
          .set({ state, updatedAt: new Date() })
          .where(
            and(
              eq(guidedStoryDraftsTable.id, fresh.id),
              eq(guidedStoryDraftsTable.revision, fresh.revision),
            ),
          )
          .returning()
      )[0] ?? null
    );
  });
}

async function releaseGuidedCastOperation(
  row: GuidedStoryDraft,
  roleId: string,
  operationKey: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const fresh = (
      await tx
        .select()
        .from(guidedStoryDraftsTable)
        .where(
          and(
            eq(guidedStoryDraftsTable.id, row.id),
            eq(guidedStoryDraftsTable.tenantId, row.tenantId),
            eq(guidedStoryDraftsTable.revision, row.revision),
          ),
        )
        .for("update")
        .limit(1)
    )[0];
    const operation = fresh?.state.castOperations?.[roleId];
    if (
      !fresh ||
      operation?.operationKey !== operationKey ||
      operation.status === "provider_succeeded" ||
      operation.status === "upload_succeeded" ||
      operation.status === "uploaded"
    )
      return;
    const operations = { ...fresh.state.castOperations };
    delete operations[roleId];
    await tx
      .update(guidedStoryDraftsTable)
      .set({
        state: { ...fresh.state, castOperations: operations },
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(guidedStoryDraftsTable.id, fresh.id),
          eq(guidedStoryDraftsTable.revision, fresh.revision),
        ),
      );
  });
}

router.get("/ai/guided-story/platforms", (_req: Request, res: Response) => {
  res.json(
    GUIDED_STORY_PLATFORMS.map((platform) => ({
      ...platform,
      rolePlans: Object.fromEntries(
        platform.durations.map((duration) => [
          String(duration),
          guidedStoryRolePlan(platform.id, duration),
        ]),
      ),
    })),
  );
});

router.get("/ai/guided-story/voices", async (req: Request, res: Response) => {
  // Provider credentials and availability can change independently of app
  // deployments. Never let a previously empty catalog remain in browser cache.
  res.set("Cache-Control", "no-store");
  const stock = GUIDED_STORY_STOCK_VOICES.map((voiceId) => ({
    id: `stock:${voiceId}`,
    label: voiceId,
    provider: "stock" as const,
    providerVoiceId: null,
    brandKitId: null,
  }));
  const clones = await guidedStoryCloneCatalog(req.tenantId);
  // Catalog availability must not make casting stock/tenant clones unavailable.
  // A provider failure is deliberately represented by an empty premade section.
  let premade: Array<{
    id: string;
    label: string;
    provider: "elevenlabs";
    providerVoiceId: string;
    brandKitId: null;
  }> = [];
  let providerWarning: string | null = null;
  try {
    premade = (await listElevenLabsPremadeVoices()).map((voice) => ({
      id: `elevenlabs:premade:${voice.voiceId}`,
      label: voice.label,
      provider: "elevenlabs" as const,
      providerVoiceId: voice.voiceId,
      brandKitId: null,
    }));
  } catch (error) {
    if (!(error instanceof VoiceCloneNotConfiguredError)) {
      providerWarning =
        "ElevenLabs premade voices could not be loaded. Built-in and cloned voices are still available.";
    }
  }
  res.json({
    voices: [
      ...stock,
      ...premade,
      ...clones.map((voice) => ({
        id: voice.id,
        label: voice.label,
        provider: "elevenlabs" as const,
        providerVoiceId: voice.providerVoiceId,
        brandKitId: voice.brandKitId,
      })),
    ],
    providerWarning,
  });
});

router.post("/ai/guided-story/drafts", async (req: Request, res: Response) => {
  const parsed = CreateGuidedStoryDraftBody.safeParse(req.body);
  const setup = parsed.success ? guidedSetup(parsed.data) : null;
  if (!parsed.success || !setup) {
    res
      .status(400)
      .json({
        error: "The platform, duration, or role count is not supported.",
      });
    return;
  }
  if (
    setup.brandKitId !== null &&
    !(await loadActivePayload(req.tenantId, setup.brandKitId))
  ) {
    res.status(404).json({ error: "Brand Kit not found." });
    return;
  }
  const state: GuidedStoryDraftState = {
    version: 1,
    setup,
    script: null,
    scriptApprovedAt: null,
    userRoleId: null,
    castStrategy: null,
    cast: [],
    duplicateAssignmentConfirmed: false,
    scriptGeneration: null,
    sceneInsertionGeneration: null,
    castOperations: {},
    visualChoices: {
      version: 1,
      logo: { path: null, sceneIds: [] },
      location: { mode: "none", imagePath: null, description: null },
    },
    storyboardJobId: null,
  };
  const row = (
    await db
      .insert(guidedStoryDraftsTable)
      .values({ tenantId: req.tenantId, state })
      .returning()
  )[0]!;
  res.status(201).json(serializeGuidedDraft(row));
});

router.get(
  "/ai/guided-story/drafts/:draftId",
  async (req: Request, res: Response) => {
    const row = await loadGuidedDraft(req.tenantId, Number(req.params.draftId));
    if (!row) {
      res.status(404).json({ error: "Guided story draft not found." });
      return;
    }
    res.json(serializeGuidedDraft(row));
  },
);

router.patch(
  "/ai/guided-story/drafts/:draftId",
  async (req: Request, res: Response) => {
    const parsed = UpdateGuidedStoryDraftBody.safeParse(req.body);
    let row = parsed.success
      ? await loadGuidedDraft(req.tenantId, Number(req.params.draftId))
      : null;
    if (!parsed.success || !hasOnlyGuidedVisualFields(req.body)) {
      res.status(400).json({ error: "Invalid guided story update." });
      return;
    }
    if (!row) {
      res.status(404).json({ error: "Guided story draft not found." });
      return;
    }
    if (
      row.state.scriptGeneration ||
      guidedSceneInsertionClaimActive(row.state.sceneInsertionGeneration) ||
      Object.keys(row.state.castOperations ?? {}).length > 0
    ) {
      res
        .status(409)
        .json({
          error:
            "Paid draft work is in progress; wait for it to finish before editing.",
        });
      return;
    }
    if (
      row.state.storyboardJobId !== null ||
      Object.keys(row.state.castOperations ?? {}).length > 0
    ) {
      res.status(409).json({
        error:
          "This approved attempt is already in storyboard review. Discard that video job before changing its script.",
      });
      return;
    }
    let setup = row.state.setup;
    if (parsed.data.setup) {
      setup = guidedSetup(parsed.data.setup, Boolean(parsed.data.script));
      if (!setup) {
        res
          .status(400)
          .json({
            error: "The platform, duration, or role count is not supported.",
          });
        return;
      }
      if (
        setup.brandKitId !== null &&
        !(await loadActivePayload(req.tenantId, setup.brandKitId))
      ) {
        res.status(404).json({ error: "Brand Kit not found." });
        return;
      }
    }
    let script = row.state.script;
    if (parsed.data.script) {
      if (!setup) {
        res
          .status(400)
          .json({ error: "Story setup is required before editing a script." });
        return;
      }
      try {
        const manualRoleCount = parsed.data.script.roles.length;
        if (manualRoleCount < 2 || manualRoleCount > 4) {
          throw new VideoGenProviderError("A saved script must contain 2-4 roles.");
        }
        script = validateAndRepairGuidedScript(parsed.data.script, {
          roleCount: manualRoleCount,
          durationSeconds: setup.durationSeconds,
        });
        // Initial generation keeps the platform recommendation, while a
        // deliberate manual revision may grow the cast up to the API hard cap.
        setup = { ...setup, roleCount: manualRoleCount };
      } catch (error) {
        res
          .status(400)
          .json({
            error: error instanceof Error ? error.message : "Invalid script.",
          });
        return;
      }
    }
    const visualChoices = parsed.data.visualChoices
      ? validateGuidedVisualChoices(parsed.data.visualChoices, script, req.tenantId)
      : row.state.visualChoices;
    if (!visualChoices) {
      res.status(400).json({
        error:
          "Visual choices must use tenant upload paths, current scene IDs, and exactly one location mode.",
      });
      return;
    }
    const nextState =
      parsed.data.setup || parsed.data.script
        ? invalidateGuidedStoryDownstream(
            { ...row.state, setup, visualChoices },
            script,
          )
        : { ...row.state, visualChoices };
    const saved = await saveGuidedState(row, parsed.data.revision, nextState);
    if (!saved) {
      res
        .status(409)
        .json({ error: "This draft changed. Reload it and try again." });
      return;
    }
    res.json(serializeGuidedDraft(saved));
  },
);

router.post(
  "/ai/guided-story/drafts/:draftId/scenes/generate",
  async (req: Request, res: Response) => {
    const parsed = GenerateGuidedStoryDraftSceneBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error:
          "Provide a valid current script, insertion position, description, and revision.",
      });
      return;
    }
    if (parsed.data.description.trim().length < 3) {
      res.status(400).json({
        error: "Describe the new scene in at least 3 characters.",
      });
      return;
    }
    const row = await loadGuidedDraft(
      req.tenantId,
      Number(req.params.draftId),
    );
    if (!row) {
      res.status(404).json({ error: "Guided story draft not found." });
      return;
    }
    if (parsed.data.revision !== row.revision) {
      res.status(409).json({
        error: "This draft changed. Reload it and try again.",
      });
      return;
    }
    if (!row.state.setup || !row.state.script) {
      res.status(400).json({
        error: "Save an initial script before generating another scene.",
      });
      return;
    }
    if (
      row.state.scriptGeneration ||
      Object.keys(row.state.castOperations ?? {}).length > 0 ||
      row.state.storyboardJobId !== null
    ) {
      res.status(409).json({
        error:
          "Paid downstream work is in progress; finish or discard it before changing the script.",
      });
      return;
    }
    const roleCount = parsed.data.script.roles.length;
    let currentScript;
    try {
      if (roleCount < 2 || roleCount > 4) {
        throw new VideoGenProviderError("The current script must contain 2-4 roles.");
      }
      currentScript = validateAndRepairGuidedScript(parsed.data.script, {
        roleCount,
        durationSeconds: row.state.setup.durationSeconds,
      });
      if (
        parsed.data.insertionIndex < 0 ||
        parsed.data.insertionIndex > currentScript.scenes.length ||
        currentScript.scenes.length >= 40
      ) {
        throw new VideoGenProviderError("The scene insertion position is invalid.");
      }
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : "Invalid current script.",
      });
      return;
    }
    const requestKey = guidedSceneInsertionRequestKey({
      revision: row.revision,
      insertionIndex: parsed.data.insertionIndex,
      description: parsed.data.description.trim(),
      script: currentScript,
    });
    const existingClaim = row.state.sceneInsertionGeneration;
    if (guidedSceneInsertionClaimActive(existingClaim)) {
      if (
        existingClaim?.phase === "finalizing" &&
        existingClaim.requestKey === requestKey &&
        existingClaim.result
      ) {
        const recovery = await recoverGuidedSceneInsertionClaim({
          row,
          requestKey,
        });
        if (!recovery) {
          res.status(409).json({
            error: "Scene generation is already in progress for this revision.",
          });
          return;
        }
        const responseBody = {
          revision: recovery.row.revision,
          insertedSceneId: recovery.result.insertedSceneId,
          script: recovery.result.script,
        };
        res.once("finish", () => {
          void releaseGuidedSceneInsertionClaim(
            recovery.row,
            recovery.operationKey,
          ).catch((error) =>
            req.log.error(
              { err: error, draftId: recovery.row.id },
              "Failed to release recovered guided scene insertion claim",
            ),
          );
        });
        res.json(responseBody);
        return;
      }
      res.status(409).json({
        error: "Scene generation is already in progress for this revision.",
      });
      return;
    }
    const claim = await claimGuidedSceneInsertion({
      tenantId: req.tenantId,
      draftId: row.id,
      revision: row.revision,
      requestKey,
    });
    if (!claim.row || !claim.operationKey) {
      res.status(409).json({
        error: claim.busy
          ? "Scene generation is already in progress for this revision."
          : "This draft changed. Reload it and try again.",
      });
      return;
    }
    const claimedRow = claim.row;
    const operationKey = claim.operationKey;
    const tenant = (
      await db
        .select()
        .from(tenantsTable)
        .where(eq(tenantsTable.id, req.tenantId))
        .limit(1)
    )[0];
    if (!tenant) {
      await releaseGuidedSceneInsertionClaim(claimedRow, operationKey);
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const startedAt = Date.now();
    try {
      const billed = await runBillableScriptRequest({
        req,
        tenantModel: tenant.aiModel,
        operationKind: "video_script_draft",
        operationKey,
        onFundingReady: (fundingMode) =>
          setGuidedSceneInsertionFunding(
            claimedRow,
            operationKey,
            fundingMode,
          ),
        beforeSettlement: async (result) => {
          return finalizeGuidedSceneInsertionClaim(
            claimedRow,
            operationKey,
            {
              insertedSceneId: result.insertedSceneId,
              script: result.script,
            },
          );
        },
        perform: () =>
          generateGuidedStorySceneInsertion({
            tenantId: req.tenantId,
            tenantAiModel: tenant.aiModel,
            script: currentScript,
            insertionIndex: parsed.data.insertionIndex,
            description: parsed.data.description.trim(),
            durationSeconds: row.state.setup!.durationSeconds,
            locale: row.state.setup!.locale,
          }),
      });
      if (!billed) {
        await releaseGuidedSceneInsertionClaim(claimedRow, operationKey);
        res.status(402).json({
          error: "Your wallet balance can't cover scene writing.",
        });
        return;
      }
      await recordUsage(req.tenantId, "caption", {
        requestBytes: Buffer.byteLength(parsed.data.description),
        responseBytes: Buffer.byteLength(JSON.stringify(billed.result.script)),
        durationMs: Date.now() - startedAt,
        provider: billed.result.provider,
        model: billed.result.model,
        funding: billed.funding,
        displayPaiseOverride: billed.chargedPaise,
        ...(billed.result.inputTokens !== null
          ? { inputTokens: billed.result.inputTokens }
          : {}),
        ...(billed.result.outputTokens !== null
          ? { outputTokens: billed.result.outputTokens }
          : {}),
      }).catch((error) => {
        req.log.warn(
          { err: error },
          "Guided story scene usage recording failed",
        );
      });
      const responseBody = {
        revision: claimedRow.revision,
        insertedSceneId: billed.result.insertedSceneId,
        script: billed.result.script,
      };
      await releaseGuidedSceneInsertionClaim(claimedRow, operationKey);
      res.json(responseBody);
    } catch (error) {
      await releaseGuidedSceneInsertionClaim(claimedRow, operationKey).catch(
        (releaseError) =>
          req.log.error(
            { err: releaseError, draftId: claimedRow.id },
            "Failed to release guided scene insertion claim",
          ),
      );
      if (error instanceof StaleBillableScriptOperationError) {
        res.status(409).json({
          error: "This draft changed while its scene was generated.",
        });
        return;
      }
      if (error instanceof TextGenNotConfiguredError) {
        res.status(503).json({
          error: "AI scene writing is not configured. Contact your admin.",
        });
        return;
      }
      req.log.warn({ err: error }, "Guided story scene generation failed");
      res.status(502).json({
        error:
          error instanceof VideoGenProviderError
            ? error.message
            : "Writing the scene failed. Please try again.",
      });
    }
  },
);

router.post(
  "/ai/guided-story/drafts/:draftId/script",
  async (req: Request, res: Response) => {
    const parsed = GenerateGuidedStoryDraftScriptBody.safeParse(req.body);
    let row = parsed.success
      ? await loadGuidedDraft(req.tenantId, Number(req.params.draftId))
      : null;
    if (!parsed.success || !row?.state.setup) {
      res
        .status(row ? 400 : 404)
        .json({
          error: row ? "Invalid request." : "Guided story draft not found.",
        });
      return;
    }
    if (parsed.data.revision !== row.revision) {
      res
        .status(409)
        .json({ error: "This draft changed. Reload it and try again." });
      return;
    }
    if (row.state.storyboardJobId !== null) {
      res.status(409).json({
        error:
          "This approved attempt is already in storyboard review. Discard that video job before regenerating.",
      });
      return;
    }
    if (guidedSceneInsertionClaimActive(row.state.sceneInsertionGeneration)) {
      res.status(409).json({
        error: "Scene generation is in progress; wait for it to finish before regenerating.",
      });
      return;
    }
    // Claim the exact draft revision before reserving a wallet or calling the
    // provider.  The old flow checked the revision and charged first, allowing
    // two simultaneous requests to purchase two abandoned completions.
    if (row.state.scriptGeneration) {
      const ageMs =
        Date.now() - Date.parse(row.state.scriptGeneration.claimedAt);
      if (Number.isFinite(ageMs) && ageMs < 10 * 60 * 1000) {
        res
          .status(409)
          .json({
            error:
              "Script generation is already in progress for this revision.",
          });
        return;
      }
      // A worker can die after its durable claim but before it reaches a
      // provider. Expire that claim rather than leaving this draft locked
      // forever. A later caller makes a new claim before it can spend anything.
      const released = await saveGuidedState(row, row.revision, {
        ...row.state,
        scriptGeneration: null,
      });
      if (!released) {
        res
          .status(409)
          .json({ error: "This draft changed. Reload it and try again." });
        return;
      }
      row = released;
    }
    const claimed = await saveGuidedState(row, row.revision, {
      ...row.state,
      scriptGeneration: {
        revision: row.revision,
        claimedAt: new Date().toISOString(),
      },
    });
    if (!claimed) {
      res
        .status(409)
        .json({ error: "This draft changed. Reload it and try again." });
      return;
    }
    const tenant = (
      await db
        .select()
        .from(tenantsTable)
        .where(eq(tenantsTable.id, req.tenantId))
        .limit(1)
    )[0];
    if (!tenant) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const setup = claimed.state.setup!;
    const activeBrand = setup.brandKitId
      ? await loadActivePayload(req.tenantId, setup.brandKitId)
      : null;
    let billed: {
      result: Awaited<ReturnType<typeof generateGuidedStoryScript>>;
      funding: "wallet" | "unmetered";
      chargedPaise: number | null;
    } | null;
    try {
      billed = await runBillableScriptRequest({
        req,
        tenantModel: tenant.aiModel,
        operationKind: "video_script_draft",
        perform: () =>
          generateGuidedStoryScript({
            tenantId: req.tenantId,
            tenantAiModel: tenant.aiModel,
            genre: setup.genre,
            platform: guidedStoryPlatform(setup.platform)!,
            durationSeconds: setup.durationSeconds,
            locale: setup.locale,
            topic: setup.topic,
            roleCount: setup.roleCount,
            brandConstraints: activeBrand
              ? [
                  ...activeBrand.payload.brand_controls.restricted_terms,
                  ...activeBrand.payload.voice.traits,
                ].join(", ")
              : null,
          }),
      });
    } catch (error) {
      await saveGuidedState(claimed, claimed.revision, {
        ...claimed.state,
        scriptGeneration: null,
      });
      throw error;
    }
    if (!billed) {
      await saveGuidedState(claimed, claimed.revision, {
        ...claimed.state,
        scriptGeneration: null,
      });
      res
        .status(402)
        .json({ error: "Your wallet balance can't cover script writing." });
      return;
    }
    await recordUsage(req.tenantId, "caption", {
      requestBytes: Buffer.byteLength(setup.topic),
      responseBytes: Buffer.byteLength(JSON.stringify(billed.result.script)),
      provider: billed.result.provider,
      model: billed.result.model,
      funding: billed.funding,
      displayPaiseOverride: billed.chargedPaise,
      ...(billed.result.inputTokens !== null
        ? { inputTokens: billed.result.inputTokens }
        : {}),
      ...(billed.result.outputTokens !== null
        ? { outputTokens: billed.result.outputTokens }
        : {}),
    }).catch((error) => {
      req.log.warn(
        { err: error },
        "Guided story script usage recording failed",
      );
    });
    const saved = await saveGuidedState(
      claimed,
      claimed.revision,
      invalidateGuidedStoryDownstream(claimed.state, billed.result.script),
    );
    if (!saved) {
      res
        .status(409)
        .json({ error: "This draft changed while its script was generated." });
      return;
    }
    res.json(serializeGuidedDraft(saved));
  },
);

router.post(
  "/ai/guided-story/drafts/:draftId/script/approve",
  async (req: Request, res: Response) => {
    const parsed = ApproveGuidedStoryDraftScriptBody.safeParse(req.body);
    let row = parsed.success
      ? await loadGuidedDraft(req.tenantId, Number(req.params.draftId))
      : null;
    if (!parsed.success || !row) {
      res
        .status(row ? 400 : 404)
        .json({
          error: row ? "Invalid request." : "Guided story draft not found.",
        });
      return;
    }
    if (!row.state.script) {
      res
        .status(400)
        .json({ error: "Generate or save a valid script before approval." });
      return;
    }
    if (
      row.state.scriptGeneration ||
      guidedSceneInsertionClaimActive(row.state.sceneInsertionGeneration) ||
      Object.keys(row.state.castOperations ?? {}).length > 0
    ) {
      res
        .status(409)
        .json({
          error:
            "Paid draft work is in progress; wait for it to finish before approval.",
        });
      return;
    }
    if (row.state.storyboardJobId !== null) {
      const linkedJob =
        row.state.storyboardJobId > 0
          ? ((
              await db
                .select({
                  status: videoGenerationsTable.status,
                  storyboard: videoGenerationsTable.storyboard,
                })
                .from(videoGenerationsTable)
                .where(
                  and(
                    eq(videoGenerationsTable.id, row.state.storyboardJobId),
                    eq(videoGenerationsTable.tenantId, req.tenantId),
                  ),
                )
                .limit(1)
            )[0] ?? null)
          : null;
      const failedBeforeStoryboard =
        linkedJob?.status === "failed" && linkedJob.storyboard === null;
      if (!failedBeforeStoryboard) {
        res.status(409).json({
          error: "This approved attempt is already in storyboard review.",
        });
        return;
      }
    }
    let saved = await saveGuidedState(row, parsed.data.revision, {
      ...row.state,
      scriptApprovedAt: new Date().toISOString(),
      userRoleId: null,
      castStrategy: null,
      cast: [],
      duplicateAssignmentConfirmed: false,
      scriptGeneration: null,
      storyboardJobId: null,
    });
    if (!saved) {
      res
        .status(409)
        .json({ error: "This draft changed. Reload it and try again." });
      return;
    }
    res.json(serializeGuidedDraft(saved));
  },
);

async function validateGuidedWalletCheckpoint(
  operation: GuidedStoryDraftState["castOperations"][string],
  args: { tenantId: number; draftId: number; revision: number; roleId: string },
): Promise<{ valid: true } | { valid: false; reason: string }> {
  if (operation.funding !== "wallet") return { valid: true };
  if (
    (operation.status !== "provider_succeeded" &&
      operation.status !== "upload_succeeded" &&
      operation.status !== "uploaded") ||
    !operation.walletReservation ||
    !operation.operationId ||
    !operation.provider ||
    !operation.model
  ) {
    return { valid: false, reason: "wallet checkpoint metadata is incomplete" };
  }
  return validateGuidedCastWalletCheckpoint({
    ...args,
    status: operation.status,
    operationId: operation.operationId,
    reservation: operation.walletReservation,
    provider: operation.provider,
    model: operation.model,
  });
}

router.put(
  "/ai/guided-story/drafts/:draftId/cast",
  async (req: Request, res: Response) => {
    const parsed = CastGuidedStoryDraftBody.safeParse(req.body);
    let row = parsed.success
      ? await loadGuidedDraft(req.tenantId, Number(req.params.draftId))
      : null;
    if (!parsed.success || !row) {
      res
        .status(row ? 400 : 404)
        .json({
          error: row ? "Invalid cast." : "Guided story draft not found.",
        });
      return;
    }
    const script = row.state.script;
    if (
      row.state.scriptGeneration ||
      guidedSceneInsertionClaimActive(row.state.sceneInsertionGeneration)
    ) {
      res
        .status(409)
        .json({
          error:
            "Script generation is in progress; wait for it to finish before casting.",
        });
      return;
    }
    if (!script || !row.state.scriptApprovedAt) {
      res
        .status(400)
        .json({ error: "Approve the current script before casting." });
      return;
    }
    const linkedJob =
      row.state.storyboardJobId && row.state.storyboardJobId > 0
        ? ((
            await db
              .select()
              .from(videoGenerationsTable)
              .where(
                and(
                  eq(videoGenerationsTable.id, row.state.storyboardJobId),
                  eq(videoGenerationsTable.tenantId, req.tenantId),
                ),
              )
              .limit(1)
          )[0] ?? null)
        : null;
    if (
      row.state.storyboardJobId !== null &&
      (!linkedJob ||
        linkedJob.status !== "awaiting_review" ||
        linkedJob.storyboard?.mode !== "guided_story" ||
        !linkedJob.options?.guidedStory)
    ) {
      res.status(409).json({
        error:
          "Casting can only be changed while its Guided Story storyboard is awaiting review.",
      });
      return;
    }
    if (
      linkedJob?.options?.guidedPreviewRender?.state === "queued" ||
      linkedJob?.options?.guidedPreviewRender?.state === "running"
    ) {
      res.status(409).json({
        error:
          "Missing previews are being rendered. Wait for that operation to finish before changing the cast.",
      });
      return;
    }
    const assignments = parsed.data.assignments;
    const expectedRoles = new Set(script.roles.map((role) => role.id));
    if (
      assignments.length !== expectedRoles.size ||
      new Set(assignments.map((item) => item.roleId)).size !==
        expectedRoles.size ||
      assignments.some((item) => !expectedRoles.has(item.roleId)) ||
      assignments.filter((item) => item.isUserRole).length > 1
    ) {
      res
        .status(400)
        .json({
          error:
            "Assign every script role exactly once and choose zero or one user role.",
        });
      return;
    }
    if (
      assignments.some((item) =>
        item.isUserRole
          ? item.source !== "saved"
          : item.source !== parsed.data.strategy,
      )
    ) {
      res
        .status(400)
        .json({
          error:
            "The user role must be saved and remaining roles must match the cast strategy.",
        });
      return;
    }
    // Validate every tenant-scoped dependency before claiming or funding any
    // generated role. Assignment order must never let a valid generated role
    // spend before a later cross-tenant identifier is rejected.
    const cloneCatalog = await guidedStoryCloneCatalog(req.tenantId);
    const submittedPremadeIds = new Set(
      assignments
        .map((item) => item.voiceId)
        .filter((id) => id.startsWith("elevenlabs:premade:"))
        .map((id) => id.slice("elevenlabs:premade:".length)),
    );
    const premadeIds = new Set<string>();
    if (submittedPremadeIds.size) {
      try {
        for (const voice of await listElevenLabsPremadeVoices()) {
          premadeIds.add(voice.voiceId);
        }
      } catch {
        res.status(400).json({
          error: "ElevenLabs premade voices cannot be verified right now.",
        });
        return;
      }
    }
    for (const assignment of assignments) {
      const role = script.roles.find(
        (candidate) => candidate.id === assignment.roleId,
      )!;
      const brandKitId =
        assignment.brandKitId ?? row.state.setup?.brandKitId ?? null;
      const stockVoiceId = assignment.voiceId.startsWith("stock:")
        ? assignment.voiceId.slice("stock:".length)
        : assignment.voiceId.startsWith("preset:")
          ? assignment.voiceId.slice("preset:".length)
          : assignment.voiceId;
      const clone = cloneCatalog.find(
        (voice) =>
          voice.id === assignment.voiceId ||
          (brandKitId === voice.brandKitId &&
            voice.legacyIds.includes(assignment.voiceId)),
      );
      const isPremade =
        assignment.voiceId.startsWith("elevenlabs:premade:") &&
        premadeIds.has(assignment.voiceId.slice("elevenlabs:premade:".length));
      const isStock = GUIDED_STORY_STOCK_VOICE_SET.has(stockVoiceId);
      if (
        !isStock &&
        !isPremade &&
        !clone
      ) {
        res.status(404).json({
          error: `Selectable voice for role ${role.name} was not found.`,
        });
        return;
      }
      if (assignment.source === "saved") {
        const detail =
          assignment.characterId == null
            ? null
            : await getCharacterDetail(req.tenantId, assignment.characterId);
        const outfit = detail
          ? resolveOutfit(detail, assignment.outfitId)
          : null;
        if (!detail || !outfit || assignment.consentGranted !== true) {
          res.status(404).json({
            error: `Tenant-owned character and outfit for role ${role.name} were not found or consent is missing.`,
          });
          return;
        }
      } else if (
        assignment.characterId != null ||
        assignment.outfitId != null
      ) {
        res.status(400).json({
          error: `Generated role ${role.name} cannot carry client-supplied identity or outfit IDs.`,
        });
        return;
      }
    }
    const normalizedVoiceIds = new Map(
      assignments.map((assignment) => {
        const brandKitId =
          assignment.brandKitId ?? row!.state.setup?.brandKitId ?? null;
        const stockVoiceId = assignment.voiceId.startsWith("stock:")
          ? assignment.voiceId.slice("stock:".length)
          : assignment.voiceId.startsWith("preset:")
            ? assignment.voiceId.slice("preset:".length)
            : assignment.voiceId;
        const clone = cloneCatalog.find(
          (voice) =>
            voice.id === assignment.voiceId ||
            (brandKitId === voice.brandKitId &&
              voice.legacyIds.includes(assignment.voiceId)),
        );
        return [
          assignment.roleId,
          GUIDED_STORY_STOCK_VOICE_SET.has(stockVoiceId)
            ? stockVoiceId
            : clone?.id ?? assignment.voiceId,
        ];
      }),
    );
    const castClaim = await claimGuidedCastRoles({
      tenantId: req.tenantId,
      draftId: row.id,
      revision: parsed.data.revision,
      strategy: parsed.data.strategy,
      roles: assignments.map((assignment) => ({
        roleId: assignment.roleId,
        voiceId: normalizedVoiceIds.get(assignment.roleId) ?? assignment.voiceId,
        generated: assignment.source === "generated",
      })),
    });
    if (!castClaim.row) {
      res
        .status(409)
        .json({ error: "This draft changed. Reload it and try again." });
      return;
    }
    if (castClaim.busyRoleId) {
      res.status(409).json({
        error: `Cast generation is already in progress for role ${castClaim.busyRoleId}.`,
      });
      return;
    }
    if (castClaim.malformedRoleId) {
      res.status(409).json({
        error: `Cast checkpoint for role ${castClaim.malformedRoleId} is invalid and requires reconciliation: ${castClaim.malformedReason}.`,
      });
      return;
    }
    row = castClaim.row;
    const cast: GuidedStoryCastSnapshot[] = [];
    for (const assignment of assignments) {
      const role = script.roles.find(
        (candidate) => candidate.id === assignment.roleId,
      )!;
      const brandKitId =
        assignment.brandKitId ?? row.state.setup?.brandKitId ?? null;
      const stockVoiceId = assignment.voiceId.startsWith("stock:")
        ? assignment.voiceId.slice("stock:".length)
        : assignment.voiceId.startsWith("preset:")
          ? assignment.voiceId.slice("preset:".length)
          : assignment.voiceId;
      const clone = cloneCatalog.find(
        (voice) =>
          voice.id === assignment.voiceId ||
          (brandKitId === voice.brandKitId &&
            voice.legacyIds.includes(assignment.voiceId)),
      );
      const premadeVoiceId = assignment.voiceId.startsWith("elevenlabs:premade:")
        ? assignment.voiceId.slice("elevenlabs:premade:".length)
        : null;
      const voice = GUIDED_STORY_STOCK_VOICE_SET.has(stockVoiceId)
        ? {
            id: stockVoiceId,
            label: stockVoiceId,
            provider: "stock",
            provider_voice_id: null,
            brandKitId: null,
          }
        : premadeVoiceId && premadeIds.has(premadeVoiceId)
          ? {
              id: assignment.voiceId,
              label: premadeVoiceId,
              provider: "elevenlabs",
              provider_voice_id: premadeVoiceId,
              brandKitId: null,
            }
          : clone
            ? {
                id: clone.id,
                label: clone.label,
                provider: "elevenlabs",
                provider_voice_id: clone.providerVoiceId,
                brandKitId: clone.brandKitId,
              }
            : null;
      if (!voice) {
        res.status(404).json({ error: `Selectable voice for role ${role.name} was not found.` });
        return;
      }
      if (assignment.source === "saved") {
        if (
          assignment.characterId == null ||
          assignment.consentGranted !== true
        ) {
          res
            .status(400)
            .json({
              error: `Saved role ${role.name} requires a character and fresh consent.`,
            });
          return;
        }
        const detail = await getCharacterDetail(
          req.tenantId,
          assignment.characterId,
        );
        if (!detail) {
          res
            .status(404)
            .json({
              error: `Tenant-owned character for role ${role.name} was not found.`,
            });
          return;
        }
        const outfit = resolveOutfit(detail, assignment.outfitId);
        if (!outfit) {
          res
            .status(404)
            .json({
              error: `Tenant-owned outfit for role ${role.name} was not found.`,
            });
          return;
        }
        cast.push({
          roleId: role.id,
          source: "saved",
          characterId: detail.character.id,
          outfitId: outfit.id,
          brandKitId: voice.brandKitId,
          voiceId: voice.id,
          character: {
            name: detail.character.name,
            description: detail.character.description,
            referenceImagePath: detail.character.referenceImagePath,
          },
          outfit: {
            name: outfit.name,
            description: outfit.description,
            referenceImagePath: outfit.referenceImagePath,
          },
          voice: {
            id: voice.id,
            label: voice.label,
            provider: voice.provider,
            providerVoiceId: voice.provider_voice_id,
          },
          isUserRole: assignment.isUserRole,
          consentGranted: true,
        });
      } else {
        if (assignment.characterId != null || assignment.outfitId != null) {
          res.status(400).json({
            error: `Generated role ${role.name} cannot carry client-supplied identity or outfit IDs.`,
          });
          return;
        }
        const checkpointed = row.state.cast.find(
          (member) =>
            member.roleId === role.id &&
            member.source === "generated" &&
            member.voiceId === voice.id &&
            member.generatedAsset?.path,
        );
        if (checkpointed) {
          cast.push(checkpointed);
          continue;
        }
        let operation = row.state.castOperations[role.id];
        if (!operation) {
          res
            .status(409)
            .json({
              error: `Cast checkpoint for role ${role.name} is missing.`,
            });
          return;
        }
        const operationKey = operation.operationKey;
        let funding: {
          source: "quota" | "credit" | "wallet";
          reservation?: WalletReservation;
        } | null = operation.funding
          ? {
              source: operation.funding,
              ...(operation.walletReservation
                ? { reservation: operation.walletReservation }
                : {}),
            }
          : null;
        if (!funding) {
          funding = await reserveImageFunding(req);
          if (!funding) {
            await releaseGuidedCastOperation(row, role.id, operationKey);
            res.status(402).json({
              error: `Generated cast asset for role ${role.name} needs one image unit.`,
            });
            return;
          }
          const funded = await checkpointGuidedCastOperation({
            row,
            roleId: role.id,
            operationKey,
            update: {
              status: "funded",
              funding: funding.source,
              walletReservation: funding.reservation ?? null,
            },
          });
          if (!funded) {
            await releaseImageFunding(req, funding);
            res
              .status(409)
              .json({
                error:
                  "This cast operation changed before funding was recorded.",
              });
            return;
          }
          row = funded;
          operation = row.state.castOperations[role.id];
          if (!operation) {
            res
              .status(409)
              .json({
                error: `Funded cast checkpoint for role ${role.name} is missing.`,
              });
            return;
          }
        }
        if (
          operation.status === "provider_succeeded" ||
          operation.status === "upload_succeeded" ||
          operation.status === "uploaded"
        ) {
          const semantic = validateGuidedResumableCastOperation({
            operation,
            tenantId: req.tenantId,
            draftId: row.id,
            revision: row.revision,
            roleId: role.id,
            voiceId: voice.id,
          });
          if (!semantic.valid) {
            res.status(409).json({
              error: `Cast checkpoint for role ${role.name} is invalid and requires reconciliation: ${semantic.reason}.`,
            });
            return;
          }
          const walletSemantic = await validateGuidedWalletCheckpoint(
            operation,
            {
              tenantId: req.tenantId,
              draftId: row.id,
              revision: row.revision,
              roleId: role.id,
            },
          );
          if (!walletSemantic.valid) {
            res.status(409).json({
              error: `Cast checkpoint for role ${role.name} is invalid and requires reconciliation: ${walletSemantic.reason}.`,
            });
            return;
          }
        }
        const startedAt = Date.now();
        let operationId = operation.operationId ?? null;
        let provider = operation.provider;
        let model = operation.model;
        let imageBuffer: Buffer<ArrayBufferLike> | null = operation.imageBase64
          ? Buffer.from(operation.imageBase64, "base64")
          : null;
        try {
          if (
            !imageBuffer &&
            !operation.path &&
            operation.status !== "provider_succeeded" &&
            operation.status !== "upload_succeeded" &&
            operation.status !== "uploaded"
          ) {
            const castPrompt = await governedGuidedCastPrompt({
              tenantId: req.tenantId,
              role,
              genre: row.state.setup!.genre,
              visualDirection: script.scenes
                .filter((scene) =>
                  scene.lines.some((line) => line.ownerRoleId === role.id),
                )
                .map((scene) => scene.visualDirection)
                .join(" ")
                .slice(0, 1500),
            });
            // This checkpoint is the one-way provider boundary on every funding
            // rail. Once written, a crash or ambiguous exception can never turn
            // into either an automatic refund or a second provider request.
            const running = await checkpointGuidedCastOperation({
              row,
              roleId: role.id,
              operationKey,
              update: { status: "provider_running" },
            });
            if (!running) {
              throw new Error("Cast provider boundary checkpoint CAS failed.");
            }
            row = running;
            const executed =
              funding.source === "wallet" && funding.reservation
                ? await executeWalletProviderOperation(
                    {
                      tenantId: req.tenantId,
                      reservation: funding.reservation,
                      operationKind: "character_reference",
                      operationKey,
                      settlement: {
                        kind: "image",
                        costPaise: null,
                        refKind: "guidedStoryCast",
                        refId: `${row.id}:${row.revision}:${role.id}`,
                      },
                    },
                    () => generateCharacterReference(castPrompt),
                    (result) => ({
                      provider: result.provider,
                      model: result.model,
                    }),
                    { isFailureConfirmed: isConfirmedImageFailure },
                  )
                : null;
            const generated =
              executed?.value ?? (await generateCharacterReference(castPrompt));
            operationId = executed?.operationId ?? null;
            provider = generated.provider;
            model = generated.model;
            const paidBuffer = generated.buffer;
            imageBuffer = paidBuffer;
            const providerSucceeded = await checkpointGuidedCastOperation({
              row,
              roleId: role.id,
              operationKey,
              update: {
                status: "provider_succeeded",
                operationId,
                provider,
                model,
                // Temporary durable handoff: retries upload these exact paid bytes
                // and never invoke the provider a second time on any funding rail.
                imageBase64: paidBuffer.toString("base64"),
                imageByteLength: paidBuffer.length,
              },
            });
            if (!providerSucceeded) {
              throw new WalletProviderPostSuccessError(
                operationId ?? 0,
                new Error("Cast checkpoint CAS failed"),
              );
            }
            row = providerSucceeded;
          }
          operation = row.state.castOperations[role.id] ?? operation;
        } catch (error) {
          const disposition = guidedCastFailureDisposition(
            isConfirmedImageFailure(error),
          );
          if (disposition.releaseFunding) {
            await releaseImageFunding(req, funding);
            await releaseGuidedCastOperation(row, role.id, operationKey);
          } else {
            // Timeouts, transport failures, process interruption and persistence
            // failures do not prove that the provider did no work. Preserve the
            // reservation and claim permanently for explicit reconciliation.
            await checkpointGuidedCastOperation({
              row,
              roleId: role.id,
              operationKey,
              update: { status: disposition.nextStatus },
            }).catch((checkpointError) => {
              req.log.error(
                { err: checkpointError, roleId: role.id },
                "Failed to persist indeterminate guided cast outcome",
              );
            });
          }
          req.log.warn(
            { err: error, roleId: role.id },
            "Guided fictional cast generation failed",
          );
          res.status(502).json({
            error: isConfirmedImageFailure(error)
              ? `Generating fictional cast for role ${role.name} failed.`
              : `The provider outcome for role ${role.name} is unknown. Funding remains held pending reconciliation.`,
          });
          return;
        }
        operation = row.state.castOperations[role.id];
        if (!operation) {
          res
            .status(409)
            .json({
              error: `Cast checkpoint for role ${role.name} disappeared.`,
            });
          return;
        }
        const preUploadSemantic = validateGuidedResumableCastOperation({
          operation,
          tenantId: req.tenantId,
          draftId: row.id,
          revision: row.revision,
          roleId: role.id,
          voiceId: voice.id,
        });
        if (!preUploadSemantic.valid) {
          res.status(409).json({
            error: `Cast checkpoint for role ${role.name} is invalid and requires reconciliation: ${preUploadSemantic.reason}.`,
          });
          return;
        }
        const preUploadWallet = await validateGuidedWalletCheckpoint(
          operation,
          {
            tenantId: req.tenantId,
            draftId: row.id,
            revision: row.revision,
            roleId: role.id,
          },
        );
        if (!preUploadWallet.valid) {
          res.status(409).json({
            error: `Cast checkpoint for role ${role.name} is invalid and requires reconciliation: ${preUploadWallet.reason}.`,
          });
          return;
        }
        let referenceImagePath = operation.path;
        try {
          if (!referenceImagePath) {
            if (!imageBuffer || !provider || !model) {
              throw new Error("Paid cast provider checkpoint is incomplete.");
            }
            referenceImagePath = await uploadBufferToStorage(
              req.tenantId,
              imageBuffer,
              imageBuffer[0] === 0xff &&
                imageBuffer[1] === 0xd8 &&
                imageBuffer[2] === 0xff
                ? "image/jpeg"
                : "image/png",
            );
            const uploaded = await checkpointGuidedCastOperation({
              row,
              roleId: role.id,
              operationKey,
              update: {
                status: "upload_succeeded",
                path: referenceImagePath,
                imageBase64: undefined,
                imageByteLength: imageBuffer.length,
              },
            });
            if (!uploaded)
              throw new Error("Cast upload checkpoint CAS failed.");
            row = uploaded;
          }
        } catch (error) {
          // Provider work was already checkpointed; never refund or repeat it.
          req.log.error(
            { err: error, roleId: role.id },
            "Guided cast asset upload failed",
          );
          res
            .status(500)
            .json({
              error: `Saving fictional cast for role ${role.name} failed.`,
            });
          return;
        }
        operation = row.state.castOperations[role.id];
        if (!operation) {
          res
            .status(409)
            .json({
              error: `Cast checkpoint for role ${role.name} disappeared.`,
            });
          return;
        }
        if (operation.status === "upload_succeeded") {
          const semantic = validateGuidedResumableCastOperation({
            operation,
            tenantId: req.tenantId,
            draftId: row.id,
            revision: row.revision,
            roleId: role.id,
            voiceId: voice.id,
          });
          if (
            !semantic.valid ||
            !operation.path ||
            !operation.provider ||
            !operation.model
          ) {
            res.status(409).json({
              error: `Cast upload checkpoint for role ${role.name} is invalid and requires reconciliation.`,
            });
            return;
          }
          try {
            await settleImageFunding(
              req,
              funding,
              {
                durationMs: Date.now() - startedAt,
                responseBytes: operation.imageByteLength ?? 0,
                model: operation.model,
                provider: operation.provider,
              },
              operation.operationId ?? undefined,
            );
          } catch (error) {
            req.log.error(
              { err: error, roleId: role.id },
              "Guided cast wallet settlement failed",
            );
            res.status(500).json({
              error: `Cast settlement for role ${role.name} failed and requires reconciliation.`,
            });
            return;
          }
          const settled = await checkpointGuidedCastOperation({
            row,
            roleId: role.id,
            operationKey,
            update: { status: "uploaded", settledAt: new Date().toISOString() },
          });
          if (!settled) {
            res.status(500).json({
              error: `Cast settlement checkpoint for role ${role.name} requires reconciliation.`,
            });
            return;
          }
          row = settled;
          operation = row.state.castOperations[role.id];
        }
        if (!operation || operation.status !== "uploaded") {
          req.log.error(
            { roleId: role.id, operationKey },
            "Guided cast checkpoint did not reach uploaded settlement",
          );
          res.status(500).json({
            error: `The paid cast checkpoint for role ${role.name} needs reconciliation before commit.`,
          });
          return;
        }
        const finalSemantic = validateGuidedResumableCastOperation({
          operation,
          tenantId: req.tenantId,
          draftId: row.id,
          revision: row.revision,
          roleId: role.id,
          voiceId: voice.id,
        });
        if (
          !finalSemantic.valid ||
          !operation.path ||
          !operation.provider ||
          !operation.model
        ) {
          res.status(409).json({
            error: `Completed cast checkpoint for role ${role.name} is invalid and requires reconciliation.`,
          });
          return;
        }
        const finalWalletSemantic = await validateGuidedWalletCheckpoint(
          operation,
          {
            tenantId: req.tenantId,
            draftId: row.id,
            revision: row.revision,
            roleId: role.id,
          },
        );
        if (!finalWalletSemantic.valid) {
          res.status(409).json({
            error: `Completed cast checkpoint for role ${role.name} is invalid and requires reconciliation: ${finalWalletSemantic.reason}.`,
          });
          return;
        }
        referenceImagePath = operation.path;
        provider = operation.provider;
        model = operation.model;
        cast.push({
          roleId: role.id,
          source: "generated",
          characterId: null,
          outfitId: null,
          brandKitId: voice.brandKitId,
          voiceId: voice.id,
          character: {
            name: role.name,
            description: `Wholly fictional character. ${role.description}`,
            referenceImagePath,
          },
          outfit: {
            name: `${role.name} story wardrobe`,
            description: `Original fictional wardrobe suited to ${row.state.setup!.genre.replaceAll("_", " ")}.`,
            referenceImagePath,
          },
          voice: {
            id: voice.id,
            label: voice.label,
            provider: voice.provider,
            providerVoiceId: voice.provider_voice_id,
          },
          isUserRole: false,
          consentGranted: false,
          generatedAsset: {
            path: referenceImagePath,
            provider,
            model,
            operationId,
          },
        });
      }
    }
    const duplicates = guidedCastHasDuplicates(cast);
    if (duplicates && parsed.data.duplicateAssignmentConfirmed !== true) {
      res
        .status(400)
        .json({
          error:
            "Duplicate identity or voice assignments require explicit confirmation.",
        });
      return;
    }
    let saved = await saveGuidedState(row, parsed.data.revision, {
      ...row.state,
      userRoleId: cast.find((item) => item.isUserRole)?.roleId ?? null,
      castStrategy: parsed.data.strategy,
      cast,
      duplicateAssignmentConfirmed: duplicates,
      castOperations: linkedJob ? row.state.castOperations : {},
      storyboardJobId: row.state.storyboardJobId,
    });
    if (!saved) {
      res
        .status(409)
        .json({ error: "This draft changed. Reload it and try again." });
      return;
    }
    if (linkedJob?.storyboard && linkedJob.options?.guidedStory) {
      const guidedSnapshot = {
        ...linkedJob.options.guidedStory,
        draftRevision: saved.revision,
        cast,
      };
      let storyboard = guidedStoryStoryboard(
        guidedSnapshot,
        linkedJob.storyboard,
      );
      if (!storyboard.narration) {
        storyboard = {
          ...storyboard,
          narration: await synthesizeGuidedNarration({
            tenantId: req.tenantId,
            cast,
            script,
            upload: (bytes, contentType) =>
              uploadBufferToStorage(req.tenantId, bytes, contentType),
            fallbackVoice: "alloy",
          }),
        };
      }
      await db
        .update(videoGenerationsTable)
        .set({
          options: { ...linkedJob.options, guidedStory: guidedSnapshot },
          storyboard,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(videoGenerationsTable.id, linkedJob.id),
            eq(videoGenerationsTable.tenantId, req.tenantId),
            eq(videoGenerationsTable.status, "awaiting_review"),
          ),
        );
      const [cleared] = await db
        .update(guidedStoryDraftsTable)
        .set({
          state: { ...saved.state, castOperations: {} },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(guidedStoryDraftsTable.id, saved.id),
            eq(guidedStoryDraftsTable.tenantId, req.tenantId),
            eq(guidedStoryDraftsTable.revision, saved.revision),
          ),
        )
        .returning();
      if (cleared) saved = cleared;
    }
    res.json(serializeGuidedDraft(saved));
  },
);

router.post(
  "/ai/guided-story/drafts/:draftId/enqueue",
  async (req: Request, res: Response) => {
    const parsed = EnqueueGuidedStoryDraftBody.safeParse(req.body);
    const row = parsed.success
      ? await loadGuidedDraft(req.tenantId, Number(req.params.draftId))
      : null;
    if (!parsed.success || !row) {
      res
        .status(row ? 400 : 404)
        .json({
          error: row ? "Invalid request." : "Guided story draft not found.",
        });
      return;
    }
    if (
      parsed.data.revision !== row.revision ||
      guidedSceneInsertionClaimActive(row.state.sceneInsertionGeneration) ||
      !row.state.script ||
      !row.state.scriptApprovedAt ||
      row.state.cast.length !== row.state.script.roles.length ||
      row.state.cast.some(
        (item) => item.source === "saved" && item.consentGranted !== true,
      )
    ) {
      res
        .status(400)
        .json({
          error:
            "Approve the exact current script and complete casting with fresh consent before enqueue.",
        });
      return;
    }
    if (row.state.storyboardJobId === -1) {
      const existing = await reconcileGuidedStoryboardClaim(req.tenantId, row);
      if (existing) {
        res.status(200).json(serializeVideoJob(existing));
        return;
      }
      // A process can also die before inserting the job. Do not make a
      // sentinel permanent: only release a stale claim, preserving the active
      // request's exclusive window.
      if (Date.now() - row.updatedAt.getTime() >= 60_000) {
        const released = await saveGuidedState(row, row.revision, {
          ...row.state,
          cast: row.state.cast.map((member) => ({
            ...member,
            consentGranted: false,
          })),
          storyboardJobId: null,
        });
        if (!released) {
          res
            .status(409)
            .json({ error: "This draft changed. Reload it and try again." });
          return;
        }
        res.status(409).json({
          error:
            "The previous enqueue was interrupted. Fresh consent is required before retrying.",
        });
        return;
      }
    }
    if (row.state.storyboardJobId !== null) {
      res.status(409).json({ error: "This draft has already been enqueued." });
      return;
    }
    const claimed = await saveGuidedState(row, row.revision, {
      ...row.state,
      // A negative id is an enqueue claim, never a real job reference. It closes
      // the race between duplicate requests before any funding can be reserved.
      storyboardJobId: -1,
    });
    if (!claimed) {
      res
        .status(409)
        .json({ error: "This draft changed. Reload it and try again." });
      return;
    }
    req.body = { engine: "topic_to_video", guidedStoryDraftId: row.id };
    res.locals.guidedStoryEnqueue = true;
    await generateVideoHandler(req, res);
    if (res.statusCode >= 400) {
      const current = await loadGuidedDraft(req.tenantId, row.id);
      if (current?.state.storyboardJobId === -1) {
        await saveGuidedState(current, current.revision, {
          ...current.state,
          cast: current.state.cast.map((member) => ({
            ...member,
            consentGranted: false,
          })),
          storyboardJobId: null,
        });
      }
    }
  },
);

async function generateVideoHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const parsed = GenerateVideoBody.safeParse(req.body);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const field = firstIssue?.path.join(".");
    req.log.warn(
      {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
      },
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
  let body = parsed.data;
  let guidedDraft: GuidedStoryDraft | null = null;
  if (body.guidedStoryDraftId != null) {
    if (res.locals.guidedStoryEnqueue !== true) {
      res.status(400).json({
        error:
          "Use the guided-story enqueue endpoint so revision and approval gates are enforced.",
      });
      return;
    }
    guidedDraft = await loadGuidedDraft(req.tenantId, body.guidedStoryDraftId);
    if (
      !guidedDraft?.state.setup ||
      !guidedDraft.state.script ||
      !guidedDraft.state.scriptApprovedAt ||
      guidedDraft.state.cast.length !== guidedDraft.state.script.roles.length ||
      Object.keys(guidedDraft.state.castOperations ?? {}).length > 0
    ) {
      res
        .status(400)
        .json({ error: "The guided story is not approved and fully cast." });
      return;
    }
    const state = guidedDraft.state;
    const setup = state.setup!;
    body = {
      ...body,
      engine: "topic_to_video",
      prompt: setup.topic,
      aspectRatio: setup.aspectRatio,
      durationSec: setup.durationSeconds,
      visualsSource: "ai_video",
      reviewStoryboard: true,
      brandKitId: setup.brandKitId,
      paragraphCount: Math.max(
        1,
        Math.min(3, Math.ceil(setup.durationSeconds / 30)),
      ),
    };
  }
  const requestedPresetId = body.presetCharacterId?.trim() || null;
  const requestedPresetOutfitId = body.presetOutfitDerivativeId ?? null;
  const requestedPresetVoiceId = body.presetVoiceId ?? null;
  const requestedPresetLanguage =
    body.presetLanguage ?? body.characterDialogue?.locale ?? "en";
  if (
    requestedPresetId &&
    (body.characterId != null ||
      (requestedPresetOutfitId != null &&
        (!Number.isInteger(requestedPresetOutfitId) ||
          requestedPresetOutfitId <= 0)))
  ) {
    res.status(400).json({
      error:
        "Select either a workspace character or one preset character with a valid outfit.",
    });
    return;
  }
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
    supportsSelectableLipSyncQuality(body.engine) &&
    body.lipSyncQuality === "high"
      ? "high"
      : "standard";
  // OpenAPI supplies a 5s default for legacy engines. Dialogue plates instead
  // default to their script-derived safe duration, so retain whether the
  // caller actually selected a duration.
  const requestHasDurationSec = Object.prototype.hasOwnProperty.call(
    req.body ?? {},
    "durationSec",
  );

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
    res
      .status(400)
      .json({ error: "A source image is required for image-to-video." });
    return;
  }
  if (body.engine === "slideshow") {
    if (sourceImagePaths.length === 0) {
      res
        .status(400)
        .json({ error: "At least one photo is required for a slideshow." });
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
      res
        .status(403)
        .json({
          error: "Lip-synced videos are currently turned off.",
          code: "feature_disabled",
        });
      return;
    }
    // A voice track replaces the script: with a recording there is nothing to
    // synthesise, so demanding a script would be demanding busywork.
    if (!body.audioPath && !body.prompt?.trim()) {
      res
        .status(400)
        .json({ error: "A script is required for a lip-synced video." });
      return;
    }
    if (!body.sourceVideoPath && !body.sourceImagePath) {
      res.status(400).json({
        error:
          "A base video or a portrait photo is required for a lip-synced video.",
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
    if (!requestedPresetId && !(await isFeatureEnabled("brandVoiceClone"))) {
      res.status(403).json({
        error: "Brand Voice is currently turned off.",
        code: "feature_disabled",
      });
      return;
    }
    if (!body.prompt?.trim()) {
      res
        .status(400)
        .json({ error: "An AI-person visual prompt is required." });
      return;
    }
    if (!body.dialogue?.trim()) {
      res
        .status(400)
        .json({ error: "Dialogue is required for a dialogue lip-sync video." });
      return;
    }
    if (body.characterDialogue) {
      if (body.characterDialogue.scriptApproved !== true) {
        res
          .status(400)
          .json({
            error:
              "Please approve the script before creating a character dialogue video.",
          });
        return;
      }
      if (!characterDialogueLocale(body.characterDialogue.locale)) {
        res
          .status(400)
          .json({
            error: `Unsupported locale: ${body.characterDialogue.locale}.`,
          });
        return;
      }
      if (body.characterId == null && requestedPresetId == null) {
        res
          .status(400)
          .json({
            error: "Pick a saved character for a character dialogue video.",
          });
        return;
      }
      if (body.brandKitId == null && requestedPresetId == null) {
        res
          .status(400)
          .json({
            error:
              "Character dialogue requires an active Brand Kit with a cloned voice.",
          });
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
    const requestedDurationSec = requestHasDurationSec
      ? (body.durationSec ?? 5)
      : minimumDurationSec;
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
    if (
      !body.characterDialogue &&
      requestedDurationSec > Math.ceil(minimumDurationSec * 1.25)
    ) {
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
      res
        .status(400)
        .json({ error: "A source video is required for a localized dub." });
      return;
    }
    if (!body.localizedTrack) {
      res
        .status(400)
        .json({ error: "A localized track is required for a localized dub." });
      return;
    }
    // scriptApproved is the hard gate: the workspace must have reviewed every
    // cue and confirmed the script. A false value is rejected before funding.
    if (body.localizedTrack.scriptApproved !== true) {
      res.status(400).json({
        error:
          "Please approve the script before submitting a localized dub job.",
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
      res
        .status(400)
        .json({
          error: `Unsupported locale: ${track.locale}. Use te, ta, or hi.`,
        });
      return;
    }

    const voiceMode = (track.voiceMode ?? "stock") as
      | "stock"
      | "brand_voice"
      | "source_voice";

    if (voiceMode === "stock") {
      // Only normalize for stock mode (provider/model/speaker fields required).
      try {
        localizedNarration = normalizeLocalizedNarrationSelection(track);
      } catch (error) {
        res.status(400).json({
          error:
            error instanceof Error
              ? error.message
              : "Invalid localized narration selection.",
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
      res
        .status(400)
        .json({ error: "At least one cue is required for a localized dub." });
      return;
    }
    if (track.cues.length > 300) {
      res
        .status(400)
        .json({ error: "A localized dub supports at most 300 cues." });
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
  if (
    body.sourceVideoPath &&
    !body.sourceVideoPath.startsWith(`/objects/${req.tenantId}/`)
  ) {
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
  if (
    body.sourceImagePath &&
    !body.sourceImagePath.startsWith(`/objects/${req.tenantId}/`)
  ) {
    res.status(400).json({ error: "Invalid portrait path." });
    return;
  }
  if (
    body.audioPath &&
    !body.audioPath.startsWith(`/objects/${req.tenantId}/`)
  ) {
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
  if (
    body.musicPath &&
    !body.musicPath.startsWith(`/objects/${req.tenantId}/`)
  ) {
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
    res
      .status(400)
      .json({
        error: "That camera, lens, focal length or aperture is not available.",
      });
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
    const enabled =
      picked && (await availableVideoModels()).some((m) => m.id === picked.id);
    if (!picked || !enabled) {
      res.status(400).json({ error: "That video model is not available." });
      return;
    }
    // text_to_video with a character locked, and every topic-video visual
    // mode, animate a generated keyframe — so they are image-to-video jobs
    // whatever their engine name says.
    const mode: "text" | "image" =
      body.engine === "text_to_video" &&
      body.characterId == null &&
      requestedPresetId == null
        ? "text"
        : "image";
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
    const deferredCharacterMode =
      body.engine === "text_to_video" &&
      (body.characterId != null || requestedPresetId != null);
    if (!deferredCharacterMode && !supportsMode(picked, mode)) {
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
  const requestHas = (key: string) =>
    Object.prototype.hasOwnProperty.call(rawRequest, key);

  // A platform template is executable only when it is published, asset-free,
  // and visible through the same Reference Styles switch as the picker.
  let selectedTemplate: TemplateRow | null = null;
  let selectedStyleProfile: typeof videoStyleProfilesTable.$inferSelect | null =
    null;
  if (
    (body.engine === "topic_to_video" ||
      (body.engine === "dialogue_lip_sync" &&
        body.characterDialogue != null)) &&
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
        res
          .status(400)
          .json({ error: "That video template is not available." });
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
    selectedTemplate?.slots.filter((slot) => slot.kind === "presenter_video") ??
    [];
  if (presenterSlots.some((slot) => !slot.required)) {
    res.status(400).json({
      error:
        "That presenter template is invalid: its presenter video slot must be required.",
    });
    return;
  }
  const presenterTemplate = presenterSlots.some((slot) => slot.required);
  const hybridTemplate =
    selectedTemplate?.jobDefaults.format === "hybrid_character_story";
  if (body.presenterVideoPath && !presenterTemplate) {
    res.status(400).json({
      error:
        "A presenter video can only be used with a curated presenter template.",
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
    selectedTemplate?.jobDefaults.visualStrategy !== undefined
      ? "visualStrategy"
      : "visualsSource",
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
          (requestedVisualsSource === "ai" ||
            requestedVisualsSource === "ai_video")
        ? requestedVisualsSource
        : "stock";
  const wantsCharacter =
    visualsSource === "character" ||
    hybridTemplate ||
    requestedPresetId != null ||
    (body.engine === "text_to_video" && body.characterId != null) ||
    (body.engine === "dialogue_lip_sync" && body.characterDialogue != null);
  let characterId: number | null = null;
  let outfitId: number | null = null;
  let characterSnapshot: VideoJobOptions["characterSnapshot"] = null;
  let selectedPresetSnapshot: VideoJobOptions["presetSnapshot"] = null;
  let hybridCharacterSnapshot:
    | NonNullable<VideoJobOptions["hybridStory"]>["characterSnapshot"]
    | undefined;
  if (wantsCharacter) {
    if (requestedPresetId) {
      const resolved = await getPresetForTenant(
        req.tenantId,
        requestedPresetId,
        requestedPresetOutfitId,
      );
      if (!resolved) {
        res
          .status(400)
          .json({ error: "That preset character or outfit is not available." });
        return;
      }
      if (
        !resolved.preset.supportedLanguages.includes(requestedPresetLanguage)
      ) {
        res.status(400).json({
          error: `That preset does not support language ${requestedPresetLanguage}.`,
        });
        return;
      }
      const selectedVoice =
        resolved.preset.voices.find(
          (item) => item.id === requestedPresetVoiceId,
        ) ??
        (requestedPresetVoiceId == null
          ? resolved.preset.voices[0]
          : undefined);
      if (
        !selectedVoice ||
        !selectedVoice.languages.includes(requestedPresetLanguage)
      ) {
        res.status(400).json({
          error:
            "That licensed preset voice does not support the selected language.",
        });
        return;
      }
      characterId = resolved.preset.id;
      outfitId = resolved.outfit.id;
      selectedPresetSnapshot = makePresetSnapshot(
        resolved,
        requestedPresetLanguage,
        selectedVoice,
      );
      characterSnapshot = {
        character: {
          id: resolved.preset.id,
          name: resolved.preset.name,
          description: resolved.preset.description,
          referenceImagePath: resolved.preset.referenceImagePath,
        },
        outfits: [{ ...resolved.outfit }],
      };
      if (hybridTemplate) {
        hybridCharacterSnapshot = {
          referenceImagePath: resolved.preset.referenceImagePath,
          characterName: resolved.preset.name,
          characterDescription: resolved.preset.description,
          outfitReferenceImagePath: resolved.outfit.referenceImagePath,
          outfitName: resolved.outfit.name,
          outfitDescription: resolved.outfit.description,
        };
      }
    } else {
      // Hybrid templates may use the tenant's first saved character as its
      // default. It is still resolved and snapshotted before funding; a platform
      // template never supplies identity or asset data.
      const defaultCharacterId =
        hybridTemplate && body.characterId == null
          ? ((
              await db
                .select({ id: charactersTable.id })
                .from(charactersTable)
                .where(eq(charactersTable.tenantId, req.tenantId))
                // A character's default outfit is its durable default signal.
                // Prefer that tenant-owned character, then keep deterministic ID
                // fallback for older characters without outfit rows.
                .orderBy(
                  desc(sql`exists (select 1 from ${characterOutfitsTable}
                  where ${characterOutfitsTable.characterId} = ${charactersTable.id}
                    and ${characterOutfitsTable.tenantId} = ${req.tenantId}
                    and ${characterOutfitsTable.isDefault})`),
                  charactersTable.id,
                )
                .limit(1)
            )[0]?.id ?? null)
          : body.characterId;
      if (defaultCharacterId == null) {
        res
          .status(400)
          .json({ error: "Pick a character for a character video." });
        return;
      }
      const detail = await getCharacterDetail(req.tenantId, defaultCharacterId);
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
      characterSnapshot = {
        character: {
          id: detail.character.id,
          name: detail.character.name,
          description: detail.character.description,
          referenceImagePath: detail.character.referenceImagePath,
        },
        outfits: detail.outfits.filter(isOutfitSelectable).map((savedOutfit) => ({
          id: savedOutfit.id,
          name: savedOutfit.name,
          description: savedOutfit.description,
          referenceImagePath: savedOutfit.referenceImagePath,
          isDefault: savedOutfit.isDefault,
          status: savedOutfit.status,
          identityVerified: savedOutfit.identityVerified,
          canonicalReferenceImagePath:
            savedOutfit.canonicalReferenceImagePath,
          protectedRegion: savedOutfit.protectedRegion,
        })),
      };
      if (hybridTemplate) {
        hybridCharacterSnapshot = {
          referenceImagePath: detail.character.referenceImagePath,
          characterName: detail.character.name,
          characterDescription: detail.character.description,
          outfitReferenceImagePath: outfit.referenceImagePath,
          outfitName: outfit.name,
          outfitDescription: outfit.description,
        };
      }
    }
  }
  if (hybridTemplate && body.lipSyncConsent !== true) {
    res.status(400).json({
      error:
        "Please confirm you own this character or have permission to lip-sync it before creating a hybrid character story.",
    });
    return;
  }
  if (body.engine === "text_to_video" && characterId != null && body.modelId) {
    const picked = findVideoModel(body.modelId);
    if (!picked || !supportsMode(picked, "image")) {
      res.status(400).json({
        error: `${picked?.label ?? "That video model"} cannot animate an image. Pick a different model.`,
      });
      return;
    }
  }

  if (selectedTemplate) {
    const needsBrand = selectedTemplate.slots.some(
      (slot) =>
        slot.required && (slot.kind === "brand_kit" || slot.kind === "logo"),
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
      saved_character: characterId != null,
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
    await db
      .select()
      .from(tenantsTable)
      .where(eq(tenantsTable.id, req.tenantId))
      .limit(1)
  )[0];
  if (!tenant) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // A dialogue job may use only an active Brand Kit owned by this tenant.
  // Unlike ordinary best-effort branding, a user-selected speaking identity
  // is security-sensitive and must not silently accept a foreign/deleted id.
  if (
    body.engine === "dialogue_lip_sync" &&
    body.brandKitId != null &&
    requestedPresetId == null
  ) {
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
      res
        .status(400)
        .json({
          error: "That Brand Voice is not available in this workspace.",
        });
      return;
    }
  }
  let characterDialogue: VideoJobOptions["characterDialogue"] = null;
  if (body.engine === "dialogue_lip_sync" && body.characterDialogue) {
    const locale = characterDialogueLocale(body.characterDialogue.locale);
    if (
      selectedPresetSnapshot &&
      (!locale ||
        selectedPresetSnapshot.language !== locale.code ||
        !selectedPresetSnapshot.voice.languages.includes(locale.code))
    ) {
      res.status(400).json({
        error:
          "The selected preset voice and language must match the Character Dialogue locale.",
      });
      return;
    }
    const branding = selectedPresetSnapshot
      ? null
      : await loadVideoBranding(req.tenantId, body.brandKitId!);
    if (
      !locale ||
      (!selectedPresetSnapshot &&
        (!branding?.clonedVoice ||
          branding.clonedVoice.provider !== "elevenlabs"))
    ) {
      res.status(400).json({
        error:
          "Character dialogue requires an active Brand Kit with a cloned ElevenLabs voice.",
      });
      return;
    }
    if (characterId == null || outfitId == null) {
      res
        .status(400)
        .json({ error: "The selected character outfit is not available." });
      return;
    }
    const scenes = planCharacterDialogueScenes(
      body.dialogue!,
      body.prompt!.trim(),
      locale,
    );
    characterDialogue = {
      version: 1,
      scriptApproved: true,
      locale: locale.code,
      modelId: "eleven_v3",
      lipSyncModel:
        lipSyncQuality === "high" ? "sync/lipsync-2" : "bytedance/latentsync",
      direction: locale.direction,
      script: locale.script,
      scriptName: locale.script,
      fontCandidates: locale.fontCandidates,
      characterId,
      outfitId,
      brandKitId: body.brandKitId ?? null,
      scenes,
    };
  }

  // Saved-plan reuse: send a prior job's AI scene plan (possibly hand-edited)
  // back into generation instead of planning fresh. Checked BEFORE funding —
  // a rejected plan must never burn quota. The plan is validated strictly
  // here (reject, never silently fix); the planners additionally run it
  // through the same clamps as a live AI reply, so a reused plan cannot break
  // the costume lock or the style rules.
  let suppliedPlan: { flow: "broll" | "character"; raw: unknown } | null = null;
  if (guidedDraft?.state.setup && guidedDraft.state.script) {
    const setup = guidedDraft.state.setup;
    suppliedPlan = {
      flow: "broll",
      raw: {
        style: `${setup.genre.replaceAll("_", " ")}; ${setup.safeArea}`,
        prompts: guidedDraft.state.script.scenes.map((scene) => {
          const roleDetails = guidedDraft!.state.cast
            .filter((cast) =>
              scene.lines.some((line) => line.ownerRoleId === cast.roleId),
            )
            .map(
              (cast) =>
                `${cast.character.name}: ${cast.character.description}; ${cast.outfit?.description ?? ""}`,
            )
            .join(". ");
          return `${scene.visualDirection}. ${roleDetails}`.slice(0, 2000);
        }),
      },
    };
  } else if (body.planSource) {
    if (body.engine !== "topic_to_video") {
      res
        .status(400)
        .json({ error: "Saved plans apply to topic videos only." });
      return;
    }
    if (
      visualsSource !== "ai" &&
      visualsSource !== "ai_video" &&
      visualsSource !== "character"
    ) {
      res.status(400).json({
        error:
          "Saved plans apply to AI imagery or character visuals, not stock footage.",
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
      res
        .status(400)
        .json({ error: "The video that plan came from no longer exists." });
      return;
    }
    const savedPlan = source.storyboard?.aiPlan ?? null;
    // An edited plan overrides the saved one, but the source job still
    // anchors tenancy and provenance.
    const raw =
      body.planSource.plan ??
      (savedPlan?.flow === expectedFlow ? savedPlan.raw : null);
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
        res
          .status(400)
          .json({ error: "Presenter video is too large (max 100 MB)." });
        return;
      }
      const mimeType = String(metadata.contentType ?? "")
        .toLowerCase()
        .split(";")[0]
        .trim();
      if (!PRESENTER_VIDEO_TYPES.has(mimeType)) {
        res.status(400).json({
          error:
            "Unsupported presenter video type. Please upload an MP4, MOV, or WebM video.",
        });
        return;
      }
      const [presenterVideo] = await file.download();
      if (presenterVideo.byteLength > MAX_PRESENTER_VIDEO_BYTES) {
        res
          .status(400)
          .json({ error: "Presenter video is too large (max 100 MB)." });
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
      if (
        error instanceof AsrNotConfiguredError ||
        error instanceof AsrProviderError
      ) {
        req.log.warn(
          { err: error },
          "Presenter speech verification failed before funding",
        );
        res.status(503).json({
          error:
            "We could not verify the spoken presenter script. Nothing was charged; please try again.",
        });
        return;
      }
      req.log.warn(
        { err: error },
        "Presenter B-roll planning failed before funding",
      );
      res.status(502).json({
        error:
          "Planning the presenter B-roll failed. Nothing was charged; please try again.",
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
          scene.text.trim().split(/\s+/u).slice(0, 8).join(" ") ||
          body.prompt!.trim(),
        kind: "lifestyle",
        opacity: 0.55,
        lineIndexes: [index + 1],
        assetPath: null,
        previewPath: null,
        assetKind: "video",
        provider: null,
      })),
      notes: [
        "Supporting B-roll follows the approved dialogue scene boundaries.",
      ],
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
          const effectiveAspectRatio = defaultValue(
            "aspectRatio",
            body.aspectRatio,
            "9:16",
          );
          const effectiveVariant = isPromptVariantKey(body.scriptVariant)
            ? body.scriptVariant
            : null;
          const brief = resolveCreativeBrief({
            jobDefaults: selectedTemplate?.jobDefaults ?? {},
            legacyPayload: selectedTemplate?.payload,
            template:
              (selectedTemplate?.payload?.creativeDirection as
                | CreativeDirection
                | undefined) ?? null,
            user:
              selectedStyleProfile?.scope === "tenant"
                ? (selectedStyleProfile.payload.creativeDirection ?? null)
                : null,
            vertical: verticalCreativeDirection(
              effectiveAspectRatio,
              effectiveVariant,
            ),
            brand: brandCreativeDirection(activeBrandPayload),
            topic: body.prompt?.trim(),
            references: {
              ...(selectedTemplate
                ? { template: `videoStyleProfile:${selectedTemplate.id}` }
                : {}),
              ...(selectedStyleProfile?.scope === "tenant"
                ? { user: `videoStyleProfile:${selectedStyleProfile.id}` }
                : {}),
              vertical: `videoFormat:${effectiveAspectRatio}`,
              ...(activeBrandPayload
                ? {
                    brand: `brandKitVersion:${activeBrandPayload.kit.activeVersionId ?? "active"}`,
                  }
                : {}),
            },
          });
          if (!legacyReferenceStyleGuidance) return brief;
          const source =
            selectedStyleProfile?.scope === "tenant"
              ? ("user" as const)
              : ("template" as const);
          const reference = selectedStyleProfile
            ? `videoStyleProfile:${selectedStyleProfile.id}`
            : undefined;
          const existing = brief.provenance.find(
            (entry) => entry.source === source,
          );
          return {
            ...brief,
            legacyReferenceStyleGuidance: legacyReferenceStyleGuidance.slice(
              0,
              800,
            ),
            provenance: existing
              ? brief.provenance.map((entry) =>
                  entry === existing
                    ? {
                        ...entry,
                        fields: [
                          ...entry.fields,
                          "legacyReferenceStyleGuidance",
                        ].sort(),
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
    templateRuntime:
      body.engine === "topic_to_video" &&
      selectedTemplate &&
      hasNativeTemplateRuntimeSettings(selectedTemplate.jobDefaults)
        ? resolveTemplateRuntimeSettings(selectedTemplate.jobDefaults)
        : null,
    guidedStory:
      guidedDraft?.state.setup &&
      guidedDraft.state.script &&
      guidedDraft.state.scriptApprovedAt
        ? {
            version: 1,
            draftId: guidedDraft.id,
            draftRevision: guidedDraft.revision,
            scriptApprovedAt: guidedDraft.state.scriptApprovedAt,
            platform: {
              id: guidedDraft.state.setup.platform,
              aspectRatio: guidedDraft.state.setup.aspectRatio,
              width: guidedDraft.state.setup.width,
              height: guidedDraft.state.setup.height,
              safeArea: guidedDraft.state.setup.safeArea,
              durationSeconds: guidedDraft.state.setup.durationSeconds,
            },
            script: guidedDraft.state.script,
            cast: guidedDraft.state.cast,
            visuals: guidedDraft.state.visualChoices,
          }
        : undefined,
    hybridStory:
      hybridTemplate && characterId != null && outfitId != null
        ? {
            version: 1,
            pattern: (
              selectedTemplate!.jobDefaults.hybridBeatPattern as Array<{
                kind:
                  | "character_opening"
                  | "story_animation"
                  | "character_interlude"
                  | "character_closing";
                maxDurationSeconds: number;
              }>
            ).map((beat) => ({ ...beat })),
            characterId,
            outfitId,
            characterSnapshot: hybridCharacterSnapshot,
            lipSyncConsent: true,
          }
        : null,
    aspectRatio: defaultValue("aspectRatio", body.aspectRatio, "9:16"),
    durationSec:
      body.engine === "dialogue_lip_sync"
        ? requestHasDurationSec
          ? (body.durationSec ?? 5)
          : minimumDialoguePlateDurationSec(body.dialogue ?? "")
        : defaultValue("durationSec", body.durationSec, 5),
    // Slideshows run no AI model, so a camera move has nothing to act on and
    // is dropped rather than stored as a promise the renderer cannot keep.
    motionPreset:
      body.engine === "slideshow" ? null : (body.motionPreset ?? null),
    // Normalized rather than stored raw: a job's options are replayed on every
    // retry, and an axis that has since left the catalog must degrade to "not
    // set" instead of failing a render months later.
    cinematography:
      body.engine === "slideshow"
        ? null
        : normalizeCinematography(body.cinematography),
    seed: body.engine === "slideshow" ? null : (body.seed ?? null),
    // Validated above. A slideshow runs no model, so it never carries one —
    // which also keeps videoJobUnits from ever multiplying a slideshow.
    modelId: body.engine === "slideshow" ? null : (body.modelId ?? null),
    resolution: body.engine === "slideshow" ? null : (body.resolution ?? null),
    quality: body.engine === "slideshow" ? null : (body.quality ?? null),
    generateAudio:
      body.engine === "slideshow" ? null : (body.generateAudio ?? null),
    // Prices the job (one unit per shot), so it is pinned here and the
    // storyboard editor cannot move it. shotCount 0 = "auto": the script
    // decides, resolved by one LLM call BEFORE funding is reserved so the
    // resolved number is what the job costs.
    shotCount:
      body.engine === "text_to_video"
        ? body.shotCount === 0
          ? await decideShotCountFromBrief(
              req.tenantId,
              body.prompt?.trim() ?? "",
            )
          : clipShotCount(body.shotCount)
        : 1,
    slideDurationSec: defaultValue(
      "slideDurationSec",
      body.slideDurationSec,
      3,
    ),
    overlayText: defaultValue("overlayText", body.overlayText, null),
    musicPath: defaultValue("musicPath", body.musicPath, null),
    musicPrompt: body.musicPath
      ? null
      : body.musicPrompt?.trim()
        ? [body.musicPrompt.trim(), creativeFragments.music]
            .filter(Boolean)
            .join(", ")
        : creativeFragments.music,
    // Omitted = "no explicit choice": the job runner then prefers the brand
    // kit's preset voice (when one is set) before the default narrator.
    voice: selectedPresetSnapshot?.voice.speaker ?? body.voice,
    // Lip-sync inputs: validated above (feature switch, consent, tenant-scoped
    // path); persisted in options so the job — and the consent — is
    // self-describing.
    // localized_dub also uses sourceVideoPath (the base video to dub).
    sourceVideoPath:
      body.engine === "lip_sync" || body.engine === "localized_dub"
        ? (body.sourceVideoPath ?? null)
        : null,
    sourceImagePath:
      body.engine === "lip_sync" ? (body.sourceImagePath ?? null) : null,
    audioPath: body.engine === "lip_sync" ? (body.audioPath ?? null) : null,
    presenterVideoPath: presenterTemplate
      ? (body.presenterVideoPath ?? null)
      : null,
    videoTemplateId: selectedTemplate?.id ?? null,
    resolvedCreativeBrief,
    presenterBroll,
    lipSyncConsent:
      body.engine === "lip_sync" ? body.lipSyncConsent === true : undefined,
    lipSyncQuality: supportsSelectableLipSyncQuality(body.engine)
      ? lipSyncQuality
      : undefined,
    // Character-dialogue scenes are an immutable approved transcript: retain
    // every byte (including leading/trailing/newline whitespace). Legacy
    // single-plate dialogue keeps its historical trim behavior.
    dialogue:
      body.engine === "dialogue_lip_sync"
        ? body.characterDialogue
          ? (body.dialogue ?? null)
          : (body.dialogue?.trim() ?? null)
        : null,
    aiPersonConsent:
      body.engine === "dialogue_lip_sync"
        ? body.aiPersonConsent === true
        : undefined,
    characterDialogue,
    // localized_dub: snapshot the approved, fully timed dub track at enqueue
    // time. The job runner reads this verbatim — immutable after enqueue.
    localizedTrack:
      body.engine === "localized_dub" && body.localizedTrack
        ? (() => {
            const track = body.localizedTrack!;
            const voiceMode = (track.voiceMode ?? "stock") as
              | "stock"
              | "brand_voice"
              | "source_voice";
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
    characterSnapshot,
    presetSnapshot: selectedPresetSnapshot,
    wardrobeNotes: body.wardrobeNotes?.trim() || null,
    // localized_dub never goes through storyboard review — the script is
    // already approved by the caller, and there is no plan to edit.
    // Every other engine uses the request field (defaults to true).
    reviewStoryboard:
      body.engine === "localized_dub"
        ? false
        : body.engine === "dialogue_lip_sync" && characterDialogue
          ? true
          : body.engine === "topic_to_video" &&
              selectedTemplate &&
              hasNativeTemplateRuntimeSettings(selectedTemplate.jobDefaults) &&
              (visualsSource === "character" ||
                visualsSource === "ai" ||
                visualsSource === "ai_video") &&
              !requestHas("reviewStoryboard")
            ? // Native long-form AI work plans/checkpoints before billable
              // scenes by default. An explicit Studio choice can still skip
              // review for customers who accept the bounded retry trade-off.
              true
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
          : body.engine === "topic_to_video" &&
              (await isFeatureEnabled("brandVideo"))
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
    storyboardFunding:
      body.engine === "topic_to_video" &&
      selectedTemplate &&
      hasNativeTemplateRuntimeSettings(selectedTemplate.jobDefaults) &&
      (visualsSource === "character" ||
        visualsSource === "ai" ||
        visualsSource === "ai_video")
        ? {
            version: 1,
            sceneCount: null,
            requiredUnits: null,
            fundedUnits: 1,
            planningUnits: 1,
          }
        : null,
  };

  // Dependency preflight BEFORE funding: a job that will die four minutes in
  // on a missing key or a provider that is already failing should never take
  // the tenant's quota in the first place. Refunds return credits, not time.
  // Platform kill switch (fail-open): when off, jobs fund and run exactly as
  // they did before preflight existed.
  const preflightEnabled = await isFeatureEnabled("providerResilience").catch(
    () => true,
  );
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
  let units = videoJobUnits(body.engine, options);
  const limits = await getPlanLimits(tenant.plan);
  const usage = await getUsage(req.tenantId);
  const walletFunded = await isWalletFunded(req.tenantId);
  // Legacy native templates retain their ceiling-funded quota behavior.
  // Hybrid must remain deferred on every rail: only the voiced narration tells
  // us whether its unit belongs to this video hold or was independently settled
  // by cloned-voice billing. The queued job row is the durable finite-quota
  // planning reservation, and fundPlannedTemplateVisualWork keeps the rail
  // all-quota or all-credit after the exact board exists.
  if (
    !walletFunded &&
    options.storyboardFunding &&
    !options.hybridStory &&
    (limits.videos === -1 ||
      usage.videos +
        videoJobFullUnits(body.engine, {
          ...options,
          storyboardFunding: null,
        }) <=
        limits.videos)
  ) {
    options.storyboardFunding = null;
    units = videoJobUnits(body.engine, options);
  }
  // Wallet workspaces reserve one estimate per unit in a single
  // all-or-nothing debit, persisted on the job row so the runner can settle
  // it to the real cost minutes later.
  let funding: "quota" | "credit" | "wallet";
  let reservation: WalletReservation | null = null;
  if (walletFunded) {
    const exactReservation = await directVideoReservationPrice(
      body.engine,
      options,
      units,
    ).catch(() => null);
    reservation = await reserveWallet(
      req.tenantId,
      "video",
      exactReservation
        ? { provider: exactReservation.provider, model: exactReservation.model }
        : {},
      units,
      exactReservation?.totalCostPaise,
    );
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

  const accepted = enqueueBackgroundJob(() =>
    runVideoGenerationJob(job.id, funding),
  );
  if (!accepted) {
    // Shutdown in progress: undo everything and ask the client to retry.
    await db
      .update(videoGenerationsTable)
      .set({ status: "failed", error: "Server restarting; please retry." })
      .where(eq(videoGenerationsTable.id, job.id));
    if (reservation) {
      await refundFailedVideoJobWallet(job.id, "video enqueue rejected");
    } else if (funding === "credit") {
      await refundCredits(
        req.tenantId,
        "video",
        units,
        "video enqueue rejected",
      );
    }
    res
      .status(503)
      .json({ error: "Server is restarting. Please retry in a moment." });
    return;
  }

  if (guidedDraft) {
    await db
      .update(guidedStoryDraftsTable)
      .set({
        state: { ...guidedDraft.state, storyboardJobId: job.id },
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(guidedStoryDraftsTable.id, guidedDraft.id),
          eq(guidedStoryDraftsTable.tenantId, req.tenantId),
          eq(guidedStoryDraftsTable.revision, guidedDraft.revision),
        ),
      );
  }
  res.status(201).json(serializeVideoJob(job));
}

router.post("/ai/generate-video", generateVideoHandler);

async function reconcileWalletVideoJobSpends(
  rows: VideoGeneration[],
): Promise<VideoGeneration[]> {
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
    .where(
      and(
        eq(videoGenerationsTable.tenantId, req.tenantId),
        ne(videoGenerationsTable.status, "creating"),
      ),
    )
    .orderBy(
      desc(videoGenerationsTable.createdAt),
      desc(videoGenerationsTable.id),
    )
    .limit(30);
  const childSourceIds = new Set(
    rows.flatMap((row) => {
      const sourceId =
        row.options?.recovery?.sourceJobId ??
        row.options?.characterDialogue?.retry?.sourceJobId ??
        row.options?.freshRestart?.sourceJobId;
      return sourceId == null ? [] : [sourceId];
    }),
  );
  const repairChildren = new Map<number, VideoGeneration>();
  const blockingRepairSourceIds = new Set<number>();
  for (const row of rows) {
    const sourceId = row.options?.repair?.sourceJobId;
    if (sourceId == null) continue;
    if (blocksAnotherRepair(row)) blockingRepairSourceIds.add(sourceId);
    const existing = repairChildren.get(sourceId);
    if (!existing || row.id > existing.id) repairChildren.set(sourceId, row);
  }
  const savedContentByPath = new Map(
    (
      await db
        .select({
          id: contentItemsTable.id,
          videoPath: contentItemsTable.videoPath,
        })
        .from(contentItemsTable)
        .where(eq(contentItemsTable.tenantId, req.tenantId))
        .orderBy(desc(contentItemsTable.id))
    ).flatMap((item) =>
      item.videoPath ? [[item.videoPath, item.id] as const] : [],
    ),
  );
  res.json(
    (await reconcileWalletVideoJobSpends(rows)).map((row) => {
      const currentVideoPath =
        repairChildren.get(row.id)?.status === "succeeded"
          ? repairChildren.get(row.id)!.videoPath
          : row.videoPath;
      return serializeVideoJob(
        row,
        childSourceIds.has(row.id) ? false : undefined,
        {
          hasRepairChild: blockingRepairSourceIds.has(row.id),
          currentVideoPath,
          savedContentItemId:
            row.savedContentItemId ??
            (currentVideoPath
              ? savedContentByPath.get(currentVideoPath)
              : undefined) ??
            (row.videoPath
              ? savedContentByPath.get(row.videoPath)
              : undefined) ??
            null,
        },
      );
    }),
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
  const repairChild = (
    await db
      .select()
      .from(videoGenerationsTable)
      .where(eq(videoGenerationsTable.tenantId, req.tenantId))
      .orderBy(desc(videoGenerationsTable.id))
  ).find((row) => row.options?.repair?.sourceJobId === job.id);
  const currentVideoPath =
    repairChild?.status === "succeeded"
      ? repairChild.videoPath
      : reconciled!.videoPath;
  const legacySavedContent = currentVideoPath
    ? (
        await db
          .select({ id: contentItemsTable.id })
          .from(contentItemsTable)
          .where(
            and(
              eq(contentItemsTable.tenantId, req.tenantId),
              eq(contentItemsTable.videoPath, currentVideoPath),
            ),
          )
          .orderBy(desc(contentItemsTable.id))
          .limit(1)
      )[0]
    : undefined;
  res.json(
    serializeVideoJob(reconciled!, hasChild ? false : undefined, {
      hasRepairChild: Boolean(repairChild && blocksAnotherRepair(repairChild)),
      currentVideoPath,
      savedContentItemId:
        reconciled!.savedContentItemId ?? legacySavedContent?.id ?? null,
    }),
  );
});

function remainingCharacterDialogueUnits(options: VideoJobOptions): number {
  const plan = options.characterDialogue;
  if (!plan) return 0;
  let videoOperations = 0;
  for (const scene of plan.scenes) {
    if (!scene.checkpoint?.platePath || !scene.checkpoint.visualEvent)
      videoOperations += 1;
    if (
      !scene.checkpoint?.lipSyncPath ||
      !scene.checkpoint.lipSyncEvent ||
      !scene.checkpoint.narrationDurationSec
    )
      videoOperations += 1;
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
  )
    units += 1;
  return units;
}

type RecoveryInventory = {
  mode: "resume" | "saved_inputs";
  reusable: string[];
  regenerated: string[];
  units: number;
};

type HistoricalPrivacyRecoveryCapability = {
  eligible: boolean;
  code: typeof OPENROUTER_INPUT_IMAGE_PRIVACY_CODE;
  sceneId: string | null;
  reason: string | null;
};

/**
 * Legacy rows have only a persisted error string. Treat it as evidence only
 * when it contains the exact structured OpenRouter code and the board has one
 * and only one unfinished scene; guessing between scenes could alter identity.
 */
function historicalPrivacyRecoveryCapability(
  job: VideoGeneration,
): HistoricalPrivacyRecoveryCapability | null {
  if (
    job.status !== "failed" ||
    !job.error ||
    job.engine !== "topic_to_video" ||
    !job.storyboard
  ) {
    return null;
  }
  const parsed = parsePersistedOpenRouterInputImagePrivacyError(job.error);
  if (!parsed) return null;
  const unfinished = job.storyboard.scenes.filter(
    (scene) => !scene.providerCheckpoint?.path,
  );
  if (unfinished.length !== 1) {
    return {
      eligible: false,
      code: OPENROUTER_INPUT_IMAGE_PRIVACY_CODE,
      sceneId: null,
      reason:
        "The affected scene cannot be identified unambiguously from this older failure. Edit the missing scene or start over.",
    };
  }
  const scene = unfinished[0]!;
  if (scene.privacyRecovery) {
    return {
      eligible: false,
      code: OPENROUTER_INPUT_IMAGE_PRIVACY_CODE,
      sceneId: scene.id,
      reason: "This scene already used its one privacy-safe recovery attempt.",
    };
  }
  const generatedStoryScene =
    job.storyboard.visualsSource === "ai_video" &&
    (job.storyboard.mode !== "hybrid_character_story" ||
      scene.beatType === "story_animation");
  if (!generatedStoryScene) {
    return {
      eligible: false,
      code: OPENROUTER_INPUT_IMAGE_PRIVACY_CODE,
      sceneId: scene.id,
      reason:
        "This scene uses a user-uploaded or saved-character identity image. KOKAO will not replace identity-backed images automatically.",
    };
  }
  if (!scene.previewPath || scene.previewCheckpoint?.status === "prepared") {
    return {
      eligible: false,
      code: OPENROUTER_INPUT_IMAGE_PRIVACY_CODE,
      sceneId: scene.id,
      reason:
        "The affected scene was edited or no longer has the rejected generated keyframe. Save a new scene image or start over.",
    };
  }
  return {
    eligible: true,
    code: OPENROUTER_INPUT_IMAGE_PRIVACY_CODE,
    sceneId: scene.id,
    reason: null,
  };
}

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
  } else if (
    source.engine === "dialogue_lip_sync" &&
    options.characterDialogue
  ) {
    const completeScenes = options.characterDialogue.scenes.filter(
      (scene) =>
        scene.checkpoint?.lipSyncPath &&
        scene.checkpoint.narrationDurationSec &&
        scene.checkpoint.lipSyncEvent,
    ).length;
    if (completeScenes > 0)
      reusable.push(
        `${completeScenes} completed dialogue scene${completeScenes === 1 ? "" : "s"}`,
      );
    if (options.characterDialogue.musicCheckpoint?.path) reusable.push("music");
    if (source.storyboard) reusable.push("approved storyboard");
    units = remainingCharacterDialogueUnits(options);
    if (units > 0)
      regenerated.push(
        `${units} missing provider operation${units === 1 ? "" : "s"}`,
      );
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
      options.presenterBroll?.beats.filter(
        (beat) => beat.assetPath && beat.previewPath,
      ).length ?? 0;
    if (completePresenterAssets > 0) {
      reusable.push(
        `${completePresenterAssets} presenter B-roll asset${completePresenterAssets === 1 ? "" : "s"}`,
      );
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
        source.storyboard?.scenes.flatMap((scene) => [
          ...(scene.providerCheckpoint?.event
            ? [scene.providerCheckpoint.event]
            : []),
          ...(scene.previewCheckpoint?.events ?? []),
          ...(scene.previewCheckpoint?.event
            ? [scene.previewCheckpoint.event]
            : []),
        ]) ?? [];
      const completedNarrationEvents =
        source.storyboard?.mode === "hybrid_character_story" &&
        hybridNarrationConsumesVideoUnit(
          source.storyboard.narration?.event?.accountingMode,
        ) &&
        source.storyboard.narration?.event
          ? [source.storyboard.narration.event]
          : [];
      const completedMusic =
        Boolean(options.musicCheckpoint?.path) ||
        Boolean(options.presenterMusicCheckpoint?.path);
      // Provider receipts, not a guessed engine count, are the source of
      // truth for stages already paid in this durable chain.
      const completedVisualOperations = new Set(
        [...paidVideoEvents, ...completedSceneEvents].map(
          (event) =>
            event.eventId ?? `${event.provider}:${event.model}:${event.label}`,
        ),
      ).size;
      // Narration is a single product unit and never inherits a premium video
      // model's multiplier. Independently-settled cloned TTS is evidence only:
      // it did not consume the aggregate video reservation.
      const completedVideoOwnedNarration = new Set(
        completedNarrationEvents.map(
          (event) =>
            event.eventId ?? `${event.provider}:${event.model}:${event.label}`,
        ),
      ).size;
      units =
        source.storyboard?.mode === "hybrid_character_story"
          ? remainingHybridUnits({
              requiredUnits: units,
              completedVisualOperations,
              completedNarrationUnit: completedVideoOwnedNarration > 0,
              completedMusic,
              modelId: options.modelId,
            })
          : Math.max(
              0,
              units -
                completedVisualOperations *
                  videoModelMultiplier(options.modelId) -
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

function isChildOfVideoSource(
  options: VideoJobOptions | null | undefined,
  sourceId: number,
): boolean {
  return (
    options?.recovery?.sourceJobId === sourceId ||
    options?.characterDialogue?.retry?.sourceJobId === sourceId ||
    options?.freshRestart?.sourceJobId === sourceId
  );
}

function recoveryObjectPaths(
  source: VideoGeneration,
  inventory: RecoveryInventory,
): string[] {
  const options = source.options;
  const requiredOutfitIds = new Set(
    [
      options?.characterDialogue?.outfitId,
      options?.outfitId,
      ...(source.storyboard?.scenes.map((scene) => scene.outfitId) ?? []),
    ].filter((id): id is number => id != null),
  );
  const paths = [
    ...(source.sourceImagePaths ?? []),
    options?.sourceVideoPath,
    options?.sourceImagePath,
    options?.audioPath,
    options?.presenterVideoPath,
    options?.musicPath,
    ...(options?.characterSnapshot?.outfits
      .filter((outfit) => requiredOutfitIds.has(outfit.id))
      .map((outfit) => outfit.referenceImagePath) ?? []),
  ];
  if (inventory.mode === "resume") {
    paths.push(
      source.storyboard?.narration?.audioPath,
      ...(source.storyboard?.scenes.map((scene) => scene.previewPath) ?? []),
      ...(source.storyboard?.scenes.map(
        (scene) => scene.providerCheckpoint?.path,
      ) ?? []),
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
      message:
        "The saved completed render is missing its durable provider receipt. Retry from saved inputs instead.",
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
    const outfitId = options?.characterDialogue?.outfitId ?? options?.outfitId;
    const snapshot = options?.characterSnapshot;
    const snapshotValid =
      snapshot?.character.id === characterId &&
      (!outfitId ||
        snapshot.outfits.some(
          (outfit) =>
            outfit.id === outfitId &&
            (outfit.isDefault ||
              (outfit.status === undefined
                ? outfit.identityVerified !== false
                : outfit.status === "approved" &&
                  outfit.identityVerified === true)),
        ));
    const detail = snapshot
      ? null
      : await getCharacterDetail(source.tenantId, characterId);
    if (
      snapshot
        ? !snapshotValid
        : !detail ||
          (outfitId && !resolveOutfit(detail, outfitId))
    ) {
      return {
        code: "recovery_asset_missing",
        message:
          "The saved character or outfit is no longer available. Start over with an available character.",
      };
    }
  }
  const brandKitId =
    options?.characterDialogue?.brandKitId ?? options?.brandKitId;
  if (brandKitId && !(await loadActivePayload(source.tenantId, brandKitId))) {
    return {
      code: "recovery_asset_missing",
      message:
        "The saved brand kit is no longer available. Start over with an available brand kit.",
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
    if (
      !profile ||
      (profile.tenantId !== null && profile.tenantId !== source.tenantId)
    ) {
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
        message:
          "A saved input or checkpoint does not belong to this workspace.",
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

const VIDEO_STORYBOARD_RECOVERY_LOCK_NS = 1_077_001;

router.post(
  "/ai/video-jobs/:jobId/retry",
  async (req: Request, res: Response): Promise<void> => {
    const sourceId = Number(req.params.jobId);
    const initial = await loadJob(req);
    if (!initial) {
      res
        .status(404)
        .json({ error: "Not found", code: "recovery_source_not_found" });
      return;
    }
    if (
      initial.status !== "failed" ||
      !RECOVERABLE_VIDEO_ENGINES.has(initial.engine)
    ) {
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
      ...(initial.engine === "lip_sync" ||
      initial.engine === "dialogue_lip_sync"
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
    let source: VideoGeneration | null = null;
    let child: VideoGeneration | null = null;
    let historicalPrivacyRecovery = false;
    let recoveryError: Awaited<ReturnType<typeof validateRecoveryObjects>> =
      null;
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(${VIDEO_STORYBOARD_RECOVERY_LOCK_NS}, ${sourceId})`,
      );
      await tx.execute(
        sql`select id from ${videoGenerationsTable} where id = ${sourceId} for update`,
      );
      source =
        (
          await tx
            .select()
            .from(videoGenerationsTable)
            .where(
              and(
                eq(videoGenerationsTable.id, sourceId),
                eq(videoGenerationsTable.tenantId, req.tenantId),
              ),
            )
            .limit(1)
        )[0] ?? null;
      if (
        !source ||
        source.status !== "failed" ||
        !RECOVERABLE_VIDEO_ENGINES.has(source.engine)
      )
        return;
      const lockedInventory = videoRecoveryInventory(source);
      const privacyCapability = historicalPrivacyRecoveryCapability(source);
      if (privacyCapability?.eligible) {
        historicalPrivacyRecovery = true;
        lockedInventory.units += 1;
        lockedInventory.regenerated = [
          `privacy-safe keyframe for scene ${privacyCapability.sceneId}`,
          ...lockedInventory.regenerated,
        ];
      }
      recoveryError = await validateRecoveryObjects(source, lockedInventory);
      if (recoveryError) return;
      const tenantJobs = await tx
        .select({
          id: videoGenerationsTable.id,
          options: videoGenerationsTable.options,
        })
        .from(videoGenerationsTable)
        .where(eq(videoGenerationsTable.tenantId, req.tenantId));
      const existingChild = tenantJobs.some(
        (job) => isChildOfVideoSource(job.options, sourceId),
      );
      if (
        existingChild ||
        source.options?.characterDialogue?.retry?.childJobId != null
      )
        return;
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
        fundedUnits: lockedInventory.units,
        mode: lockedInventory.mode,
        state: "creating",
        reusable: lockedInventory.reusable,
        regenerated: lockedInventory.regenerated,
        privacyRecovery: privacyCapability?.eligible
          ? {
              code: privacyCapability.code,
              sceneId: privacyCapability.sceneId!,
            }
          : null,
        rendered:
          source.options?.renderCheckpoint ??
          source.options?.recovery?.rendered ??
          null,
      };
      if (privacyCapability?.eligible && source.storyboard) {
        const target = source.storyboard.scenes.find(
          (scene) => scene.id === privacyCapability.sceneId,
        )!;
        const childBoard = structuredClone(source.storyboard);
        const childTarget = childBoard.scenes.find(
          (scene) => scene.id === target.id,
        )!;
        childTarget.privacyRecovery = {
          code: privacyCapability.code,
          status: "pending",
          inputIndex:
            parsePersistedOpenRouterInputImagePrivacyError(source.error)
              ?.inputIndex ?? null,
          originalPreviewPath: target.previewPath,
        };
        const originalRequired = plannedTemplateUnits(
          { ...source, options: childOptions },
          childBoard,
        );
        childOptions.storyboardFunding = {
          version: 1,
          sceneCount: childBoard.scenes.length,
          requiredUnits: originalRequired,
          fundedUnits: originalRequired,
          planningUnits: 0,
        };
        source = { ...source, storyboard: childBoard };
      }
      // Preserve compatibility for already-deployed Character Dialogue runners,
      // but linkage/concurrency is owned by generic recovery metadata.
      if (childOptions.characterDialogue) {
        childOptions.characterDialogue.retry = {
          sourceJobId: chainId,
          fundedUnits: lockedInventory.units,
          state: "creating",
        };
      }
      child = (
        await tx
          .insert(videoGenerationsTable)
          .values({
            tenantId: source.tenantId,
            engine: source.engine,
            status: "queued",
            prompt: source.prompt,
            sourceImagePaths: structuredClone(source.sourceImagePaths),
            storyboard: source.storyboard
              ? structuredClone(source.storyboard)
              : null,
            options: childOptions,
            funding: null,
            chargedRatePaise: (await getAiSpendRates()).videoPaise,
          })
          .returning()
      )[0]!;
    });
    const lockedRecoveryError = recoveryError as {
      message: string;
      code: string;
    } | null;
    if (lockedRecoveryError) {
      res.status(410).json({
        error: lockedRecoveryError.message,
        code: lockedRecoveryError.code,
      });
      return;
    }
    if (!source) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (!child) {
      const sourceJob = source as VideoGeneration;
      if (
        sourceJob.status !== "failed" ||
        !RECOVERABLE_VIDEO_ENGINES.has(sourceJob.engine)
      ) {
        res
          .status(400)
          .json({
            error: "This video cannot be retried.",
            code: "recovery_not_eligible",
          });
      } else {
        res.status(409).json({
          error:
            "A recovery child already exists. Open that job, or wait for it to finish.",
          code: "recovery_child_exists",
        });
      }
      return;
    }
    const childJob = child as VideoGeneration;
    const rollbackChild = async () => {
      await db
        .delete(videoGenerationsTable)
        .where(eq(videoGenerationsTable.id, childJob.id));
    };
    const options = childJob.options!;
    const units = videoJobUnits(childJob.engine, options);
    if (
      units > 0 &&
      (await isFeatureEnabled("providerResilience").catch(() => true))
    ) {
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
    const tenant = (
      await db
        .select()
        .from(tenantsTable)
        .where(eq(tenantsTable.id, req.tenantId))
        .limit(1)
    )[0];
    if (!tenant) {
      await rollbackChild();
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    let funding: "quota" | "credit" | "wallet" = "quota";
    let reservation: WalletReservation | null = null;
    const originalRail = historicalPrivacyRecovery
      ? (source as VideoGeneration).funding
      : null;
    if (
      units > 0 &&
      (originalRail === "wallet" ||
        (originalRail == null && (await isWalletFunded(req.tenantId))))
    ) {
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
      const [limits, usage] = await Promise.all([
        getPlanLimits(tenant.plan),
        getUsage(req.tenantId),
      ]);
      if (
        originalRail !== "credit" &&
        (limits.videos === -1 || usage.videos + units <= limits.videos)
      )
        funding = "quota";
      else if (
        originalRail !== "quota" &&
        (await spendCredit(req.tenantId, "video", units))
      )
        funding = "credit";
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
    const [fundedChild] = await db
      .update(videoGenerationsTable)
      .set({
        options: childOptions,
        funding,
        walletReservationId: reservation?.id ?? null,
        walletReservedPaise: reservation?.amountPaise ?? null,
        walletReservedUnits: reservation?.units ?? null,
      })
      .where(eq(videoGenerationsTable.id, childJob.id))
      .returning();
    const accepted = enqueueBackgroundJob(() =>
      runVideoGenerationJob(childJob.id, funding),
    );
    if (!accepted) {
      if (reservation)
        await refundWallet(req.tenantId, reservation, "retry enqueue rejected");
      else if (funding === "credit")
        await refundCredits(
          req.tenantId,
          "video",
          units,
          "retry enqueue rejected",
        );
      await rollbackChild();
      res
        .status(503)
        .json({ error: "Server is restarting. Please retry in a moment." });
      return;
    }
    res.status(201).json(serializeVideoJob(fundedChild!));
  },
);

/**
 * Return only the request/configuration half of a row.  In particular this is
 * intentionally stricter than recovery: no storyboard, narration, previews,
 * provider receipts, composition outputs, music, or recovery-chain metadata
 * can cross this boundary.
 */
function freshRestartOptions(source: VideoGeneration): VideoJobOptions {
  const options = structuredClone(
    source.options ?? ({ aspectRatio: "9:16" } as VideoJobOptions),
  );
  delete options.recovery;
  delete options.repair;
  delete options.renderCheckpoint;
  delete options.musicCheckpoint;
  delete options.presenterMusicCheckpoint;
  delete options.presenterBroll;
  delete options.storyboardFunding;
  delete options.suppliedPlan;
  delete options.addedScenes;
  if (options.characterDialogue) {
    delete options.characterDialogue.retry;
    delete options.characterDialogue.musicCheckpoint;
    options.characterDialogue.scenes = options.characterDialogue.scenes.map(
      ({ checkpoint: _checkpoint, ...scene }) => scene,
    );
  }
  options.freshRestart = { version: 1, sourceJobId: source.id, childJobId: null };
  return options;
}

// Share retry's lock namespace: recovery and clean-room restart are mutually
// exclusive terminal actions for the same failed source.
const VIDEO_FRESH_RESTART_LOCK_NS = VIDEO_STORYBOARD_RECOVERY_LOCK_NS;

router.post(
  "/ai/video-jobs/:jobId/restart",
  async (req: Request, res: Response): Promise<void> => {
    if (req.memberRole !== "owner") {
      res.status(403).json({
        error: "Only the workspace owner can start a fresh video job.",
        code: "fresh_owner_required",
      });
      return;
    }
    const sourceId = Number(req.params.jobId);
    const initial = await loadJob(req);
    if (!initial) {
      res.status(404).json({ error: "Not found", code: "fresh_source_not_found" });
      return;
    }
    if (initial.status !== "failed") {
      res.status(400).json({
        error: "Only a failed video can be started again from its original inputs.",
        code: "fresh_not_eligible",
      });
      return;
    }
    if (await rejectDisabledVideoMode(initial.engine, res)) return;
    const options = freshRestartOptions(initial);
    if (await isFeatureEnabled("providerResilience").catch(() => true)) {
      const preflight = await preflightVideoJob(initial.engine, options);
      if (preflight) {
        res.status(preflight.status).json({ error: preflight.message, code: "fresh_provider_unavailable" });
        return;
      }
    }
    const units = videoJobUnits(initial.engine, options);
    const tenant = (await db.select().from(tenantsTable)
      .where(eq(tenantsTable.id, req.tenantId)).limit(1))[0];
    if (!tenant) {
      res.status(401).json({ error: "Unauthorized" }); return;
    }
    const walletFunded = await isWalletFunded(req.tenantId);
    let funding: "quota" | "credit" | "wallet" = walletFunded ? "wallet" : "quota";
    if (!walletFunded) {
      const [limits, usage] = await Promise.all([
        getPlanLimits(tenant.plan),
        getUsage(req.tenantId),
      ]);
      if (!(limits.videos === -1 || usage.videos + units <= limits.videos)) {
        funding = "credit";
      }
    }
    const exactReservation = walletFunded
      ? await directVideoReservationPrice(initial.engine, options, units).catch(() => null)
      : null;
    let reservation: WalletReservation | null = null;
    let funded: VideoGeneration | null = null;
    let rejection: "exists" | "insufficient" | "transition" | null = null;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${VIDEO_FRESH_RESTART_LOCK_NS}, ${sourceId})`);
        const source = (await tx.select().from(videoGenerationsTable).where(and(
          eq(videoGenerationsTable.id, sourceId),
          eq(videoGenerationsTable.tenantId, req.tenantId),
        )).limit(1).for("update"))[0];
        if (!source || source.status !== "failed") {
          rejection = "transition";
          return;
        }
        const jobs = await tx.select({ options: videoGenerationsTable.options })
          .from(videoGenerationsTable).where(eq(videoGenerationsTable.tenantId, req.tenantId));
        if (jobs.some((row) => isChildOfVideoSource(row.options, sourceId))) {
          rejection = "exists";
          return;
        }
        if (funding === "wallet") {
          reservation = await reserveWallet(
            req.tenantId,
            "video",
            exactReservation
              ? { provider: exactReservation.provider, model: exactReservation.model }
              : {},
            units,
            exactReservation?.totalCostPaise,
            tx,
          );
          if (!reservation) {
            rejection = "insufficient";
            return;
          }
        } else if (
          funding === "credit" &&
          !(await spendCredit(req.tenantId, "video", units, tx))
        ) {
          rejection = "insufficient";
          return;
        }
        const clean = freshRestartOptions(source);
        const [created] = await tx.insert(videoGenerationsTable).values({
          tenantId: source.tenantId,
          engine: source.engine,
          status: "queued",
          prompt: source.prompt,
          sourceImagePaths: structuredClone(source.sourceImagePaths),
          options: clean,
          funding,
          walletReservationId: reservation?.id ?? null,
          walletReservedPaise: reservation?.amountPaise ?? null,
          walletReservedUnits: reservation?.units ?? null,
          chargedRatePaise: await getAiSpendRates().then((rates) => rates.videoPaise),
        }).returning();
        if (!created) throw new Error("Fresh restart child creation failed.");
        const [retired] = await tx.update(videoGenerationsTable).set({
          status: "cancelled",
          stage: null,
          options: {
            ...(source.options ?? ({ aspectRatio: "9:16" } as VideoJobOptions)),
            freshRestart: { version: 1, sourceJobId: null, childJobId: created.id },
          },
        }).where(and(
          eq(videoGenerationsTable.id, sourceId),
          eq(videoGenerationsTable.status, "failed"),
        )).returning();
        if (!retired) throw new Error("Fresh restart source transition failed.");
        funded = created;
      });
    } catch {
      res.status(409).json({ error: "The source changed before the fresh restart could be queued.", code: "fresh_transition_failed" });
      return;
    }
    if (rejection === "insufficient") {
      res.status(402).json({
        error: walletFunded
          ? "Your wallet balance can't cover this fresh video."
          : "Your plan and credits cannot cover this fresh video.",
        code: "fresh_insufficient_funds",
      });
      return;
    }
    if (!funded) {
      res.status(409).json({
        error: rejection === "exists"
          ? "A retry or fresh restart already exists for this video."
          : "The source changed before the fresh restart could be queued.",
        code: rejection === "exists" ? "fresh_child_exists" : "fresh_transition_failed",
      });
      return;
    }
    enqueueBackgroundJob(() => runVideoGenerationJob(funded!.id, funding));
    res.status(201).json(serializeVideoJob(funded));
  },
);

router.post(
  "/ai/video-jobs/:jobId/repair",
  async (req: Request, res: Response): Promise<void> => {
    const parsed = RepairVideoJobBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({
          error: parsed.error.issues[0]?.message ?? "Invalid repair reason.",
        });
      return;
    }
    const sourceId = Number(req.params.jobId);
    const initial = await loadJob(req);
    if (!initial) {
      res
        .status(404)
        .json({ error: "Not found", code: "repair_source_not_found" });
      return;
    }
    if (!isVideoRepairable(initial)) {
      res.status(400).json({
        error:
          "This video does not have the complete saved narration and scene assets required for a no-charge repair.",
        code: "repair_not_eligible",
      });
      return;
    }
    const repairPaths = [
      initial.storyboard!.narration!.audioPath,
      ...initial.storyboard!.scenes.flatMap((scene) => [
        scene.previewPath,
        scene.providerCheckpoint?.path,
      ]),
      initial.options?.musicPath,
      initial.options?.musicCheckpoint?.path,
    ].filter((path): path is string => Boolean(path));
    for (const objectPath of [...new Set(repairPaths)]) {
      if (!objectPath.startsWith(`/objects/${req.tenantId}/`)) {
        res.status(410).json({
          error:
            "A saved repair asset does not belong to this workspace. The original video is unchanged.",
          code: "repair_asset_forbidden",
        });
        return;
      }
      try {
        await musicStorage.getObjectEntityFile(objectPath, req.tenantId);
      } catch (error) {
        if (error instanceof ObjectNotFoundError) {
          res.status(410).json({
            error: `A saved repair asset is missing (${objectPath.split("/").pop()}). The original video is unchanged.`,
            code: "repair_asset_missing",
          });
          return;
        }
        throw error;
      }
    }

    let child: VideoGeneration | null = null;
    let duplicate = false;
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from ${videoGenerationsTable} where id = ${sourceId} for update`,
      );
      const source = (
        await tx
          .select()
          .from(videoGenerationsTable)
          .where(
            and(
              eq(videoGenerationsTable.id, sourceId),
              eq(videoGenerationsTable.tenantId, req.tenantId),
            ),
          )
          .limit(1)
      )[0];
      if (!source || !isVideoRepairable(source)) return;
      const tenantJobs = await tx
        .select({
          options: videoGenerationsTable.options,
          status: videoGenerationsTable.status,
        })
        .from(videoGenerationsTable)
        .where(eq(videoGenerationsTable.tenantId, req.tenantId));
      if (
        tenantJobs.some(
          (row) =>
            row.options?.repair?.sourceJobId === sourceId &&
            row.status !== "failed" &&
            row.status !== "cancelled",
        )
      ) {
        duplicate = true;
        return;
      }
      const options = structuredClone(source.options!);
      options.repair = {
        version: 1,
        chainId: source.options?.repair?.chainId ?? source.id,
        sourceJobId: source.id,
        reason: parsed.data.reason,
        state: "queued",
      };
      // A repair is a fresh local composition, never a shortcut to the source's
      // already-composed final bytes.
      options.renderCheckpoint = null;
      options.recovery = null;
      child = (
        await tx
          .insert(videoGenerationsTable)
          .values({
            tenantId: source.tenantId,
            engine: source.engine,
            status: "queued",
            prompt: source.prompt,
            sourceImagePaths: structuredClone(source.sourceImagePaths),
            storyboard: structuredClone(source.storyboard),
            options,
            funding: null,
            chargedRatePaise: 0,
            spendPaise: 0,
          })
          .returning()
      )[0]!;
    });
    if (duplicate) {
      res.status(409).json({
        error:
          "A repair already exists for this video. Open that repair to see its progress.",
        code: "repair_child_exists",
      });
      return;
    }
    if (!child) {
      res.status(400).json({
        error: "This video is no longer eligible for repair.",
        code: "repair_not_eligible",
      });
      return;
    }
    const repairChild = child as VideoGeneration;
    const accepted = enqueueBackgroundJob(() =>
      runVideoRepairJob(repairChild.id),
    );
    if (!accepted) {
      await db
        .delete(videoGenerationsTable)
        .where(eq(videoGenerationsTable.id, repairChild.id));
      res
        .status(503)
        .json({ error: "Server is restarting. Please retry in a moment." });
      return;
    }
    res.status(201).json(serializeVideoJob(repairChild));
  },
);

/**
 * Cancel a still-queued job. The conditional queued->cancelled UPDATE is the
 * same atomic guard the runner uses for its queued->processing claim, so a
 * job can never be both cancelled and executed: whichever flip lands first
 * wins. Refunds the reserved credits when the job was credit-funded (quota
 * funding is only metered on success, so there is nothing to refund). The
 * refund amount is recomputed from the stored engine/options — the exact
 * inputs the route priced the job with at enqueue.
 */
router.post(
  "/ai/video-jobs/:jobId/cancel",
  async (req: Request, res: Response) => {
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
          await refundCredits(
            req.tenantId,
            "video",
            units,
            "video job cancelled",
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
          "video job cancelled",
        ).catch((error) =>
          req.log.error(
            { err: error, jobId: id },
            "Failed to refund cancelled video job",
          ),
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
  },
);

/**
 * Storyboard review. A job created with reviewStoryboard pauses after the cheap
 * half (script → narration → one still per scene) and waits here in
 * awaiting_review. The stills on the plan ARE the frames the render animates, so
 * approving costs no image generation twice, and editing is free.
 *
 * Funding was reserved when the job was created; approve spends nothing extra
 * and discard gives it back.
 */

/** Load a storyboard that is editable either during review or after a
 * retryable failure. Failed jobs receive the stricter missing-scene policy in
 * the update route; all other storyboard actions still use loadPausedJob. */
async function loadEditableStoryboardJob(
  req: Request,
  res: Response,
): Promise<{
  job: VideoGeneration;
  storyboard: NonNullable<VideoGeneration["storyboard"]>;
} | null> {
  const job = await loadJob(req);
  if (!job) {
    res.status(404).json({ error: "Not found" });
    return null;
  }
  let failedRecovery = false;
  if (
    job.status === "failed" &&
    RECOVERABLE_VIDEO_ENGINES.has(job.engine) &&
    job.options?.characterDialogue?.retry?.childJobId == null
  ) {
    const tenantJobs = await db
      .select({
        id: videoGenerationsTable.id,
        options: videoGenerationsTable.options,
      })
      .from(videoGenerationsTable)
      .where(eq(videoGenerationsTable.tenantId, req.tenantId));
    failedRecovery = !tenantJobs.some(
      (candidate) =>
        candidate.id !== job.id &&
        (candidate.options?.recovery?.sourceJobId === job.id ||
          candidate.options?.characterDialogue?.retry?.sourceJobId === job.id),
    );
  }
  if (
    (job.status !== "awaiting_review" && !failedRecovery) ||
    !job.storyboard
  ) {
    res.status(400).json({
      error:
        job.status === "failed"
          ? "This failed video does not have a retryable storyboard to edit."
          : "This video is not waiting for storyboard review.",
    });
    return null;
  }
  return { job, storyboard: job.storyboard };
}

async function loadPausedJob(
  req: Request,
  res: Response,
): Promise<{
  job: VideoGeneration;
  storyboard: NonNullable<VideoGeneration["storyboard"]>;
} | null> {
  const loaded = await loadEditableStoryboardJob(req, res);
  if (!loaded) return null;
  if (loaded.job.status !== "awaiting_review") {
    res
      .status(400)
      .json({ error: "This video is not waiting for storyboard review." });
    return null;
  }
  return loaded;
}

/** Edit scene prompts (and, when the timeline is unlocked, scene lengths). */
router.patch(
  "/ai/video-jobs/:jobId/storyboard",
  async (req: Request, res: Response) => {
    const parsed = UpdateVideoStoryboardBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const sourceId = Number(req.params.jobId);
    if (!Number.isSafeInteger(sourceId) || sourceId <= 0) {
      res.status(400).json({ error: "Invalid video job id." });
      return;
    }
    await db.transaction(async (lockTx) => {
      await lockTx.execute(
        sql`select pg_advisory_xact_lock(${VIDEO_STORYBOARD_RECOVERY_LOCK_NS}, ${sourceId})`,
      );
      const loaded = await loadEditableStoryboardJob(req, res);
      if (!loaded) return;
      const { storyboard } = loaded;
      if (storyboard.mode === "guided_story") {
        res.status(400).json({
          error: "Guided Story storyboards are immutable. Change the draft and start a new attempt.",
        });
        return;
      }

      const edits = new Map(
        parsed.data.scenes.map((scene) => [scene.id, scene]),
      );
      const privacyCapability =
        loaded.job.status === "failed"
          ? historicalPrivacyRecoveryCapability(loaded.job)
          : null;
      for (const id of edits.keys()) {
        if (!storyboard.scenes.some((scene) => scene.id === id)) {
          res
            .status(400)
            .json({ error: "That scene is not in this storyboard." });
          return;
        }
      }
      if (
        loaded.job.status === "failed" &&
        parsed.data.scenes.some(
          (edit) =>
            Boolean(
              storyboard.scenes.find((scene) => scene.id === edit.id)
                ?.previewPath,
            ) &&
            !(
              privacyCapability?.eligible &&
              privacyCapability.sceneId === edit.id
            ),
        )
      ) {
        res.status(400).json({
          error:
            "Saved storyboard scenes are protected and cannot be edited during recovery.",
        });
        return;
      }
      // Topic storyboards are cut against already-recorded narration, so a length
      // edit would either desync every later scene from the audio or silently
      // change the total. Reject it rather than accept-and-ignore.
      if (
        storyboard.timelineLocked &&
        parsed.data.scenes.some((s) => s.durationSec != null)
      ) {
        res.status(400).json({
          error:
            "Scene lengths are set by the narration timing and cannot be changed.",
        });
        return;
      }
      if (
        storyboard.mode === "character_dialogue" &&
        parsed.data.scenes.some((edit) => edit.text !== undefined)
      ) {
        res.status(400).json({
          error:
            "Approved Character Dialogue text cannot be changed in the storyboard.",
        });
        return;
      }
      if (
        parsed.data.scenes.some((edit) => {
          if (edit.brollVisual === undefined) return false;
          const scene = storyboard.scenes.find(
            (candidate) => candidate.id === edit.id,
          );
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
          error:
            "This video has no narration, so there is no scene text to edit.",
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
      const textChangedIds = new Set(
        sceneEdits.flatMap((edit) => {
          const scene = storyboard.scenes.find(
            (candidate) => candidate.id === edit.id,
          );
          const text = edit.text?.trim();
          return scene && text && text !== scene.text ? [scene.id] : [];
        }),
      );
      const revisesGeneratedClaim = textChangedIds.size > 0;
      const renderChangedIds = new Set(
        sceneEdits.flatMap((edit) => {
          const scene = storyboard.scenes.find(
            (candidate) => candidate.id === edit.id,
          );
          if (!scene) return [];
          const visual = edit.visual?.trim();
          const nextVisual =
            visual || (blankClearsVisual && visual === "" ? "" : scene.visual);
          const nextText = edit.text?.trim() || scene.text;
          const nextBroll =
            edit.brollVisual === undefined
              ? scene.brollVisual
              : edit.brollVisual?.trim() || null;
          const nextDuration =
            edit.durationSec == null
              ? scene.durationSec
              : clampSceneDuration(storyboard, edit.durationSec);
          const changed =
            nextVisual !== scene.visual ||
            nextText !== scene.text ||
            nextBroll !== scene.brollVisual ||
            nextDuration !== scene.durationSec ||
            (edit.motionPreset !== undefined &&
              edit.motionPreset !== scene.motionPreset) ||
            (edit.seed !== undefined && edit.seed !== scene.seed);
          return changed ? [scene.id] : [];
        }),
      );
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
          const intentionallyReplacedPrivacyTarget =
            loaded.job.status === "failed" &&
            privacyCapability?.eligible &&
            privacyCapability.sceneId === scene.id &&
            renderChangedIds.has(scene.id);
          return {
            ...scene,
            text: text || scene.text,
            visual:
              visual ||
              (blankClearsVisual && visual === "" ? "" : scene.visual),
            ...(intentionallyReplacedPrivacyTarget
              ? { previewPath: null }
              : {}),
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
            ...(edit.motionPreset !== undefined
              ? { motionPreset: edit.motionPreset }
              : {}),
            ...(edit.seed !== undefined ? { seed: edit.seed } : {}),
            // Hybrid animation and lip-sync outputs are bound to the spoken audio.
            // Keep reusable identity keyframes/previews, but never reuse a rendered
            // beat created for older wording.
            ...((loaded.job.status === "awaiting_review" &&
              revisesGeneratedClaim) ||
            (loaded.job.status === "failed" && renderChangedIds.has(scene.id))
              ? { providerCheckpoint: null }
              : {}),
            ...(loaded.job.status === "failed" &&
            renderChangedIds.has(scene.id) &&
            (scene.previewCheckpoint || intentionallyReplacedPrivacyTarget)
              ? {
                  previewCheckpoint: {
                    targetPath: scene.previewCheckpoint?.targetPath ?? "",
                    status: "prepared" as const,
                    events: [],
                  },
                }
              : {}),
            ...(storyboard.mode === "guided_story" &&
            renderChangedIds.has(scene.id)
              ? {
                  previewPath: null,
                  previewCheckpoint: null,
                  providerCheckpoint: null,
                  guidedStory: scene.guidedStory
                    ? {
                        ...scene.guidedStory,
                        inconsistencyFlags: Array.from(
                          new Set([
                            ...scene.guidedStory.inconsistencyFlags,
                            "visual_edited_preview_required",
                          ]),
                        ),
                      }
                    : null,
                }
              : {}),
          };
        }),
      };
      if (updated.mode === "hybrid_character_story") {
        const pattern = loaded.job.options?.hybridStory?.pattern;
        if (!pattern) {
          res
            .status(400)
            .json({
              error: "This hybrid story is missing its fixed beat pattern.",
            });
          return;
        }
        if (
          updated.scenes.some((scene, index) => {
            const original = storyboard.scenes[index];
            const expected = pattern[scene.patternIndex ?? -1];
            return (
              !original ||
              scene.id !== original.id ||
              scene.beatType !== original.beatType ||
              scene.hybridRole !== original.hybridRole ||
              scene.patternIndex !== original.patternIndex ||
              !expected ||
              expected.kind !== scene.hybridRole ||
              !scene.text.trim()
            );
          })
        ) {
          res.status(400).json({
            error:
              "Hybrid story beat identities and order are fixed, and every beat needs narration.",
          });
          return;
        }
      }
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
      const nextOptions =
        revisesGeneratedClaim &&
        loaded.job.status === "awaiting_review" &&
        loaded.job.options
          ? {
              ...loaded.job.options,
              renderCheckpoint: null,
              ...(loaded.job.options.recovery?.rendered
                ? {
                    recovery: {
                      ...loaded.job.options.recovery,
                      rendered: null,
                    },
                  }
                : {}),
            }
          : loaded.job.options;
      const saved = (
        await db
          .update(videoGenerationsTable)
          .set({
            storyboard: updated,
            ...(revisesGeneratedClaim ? { options: nextOptions } : {}),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(videoGenerationsTable.id, Number(req.params.jobId)),
              eq(videoGenerationsTable.tenantId, req.tenantId),
              eq(videoGenerationsTable.status, loaded.job.status),
            ),
          )
          .returning()
      )[0];
      if (!saved) {
        res
          .status(400)
          .json({
            error: "This storyboard is no longer available for editing.",
          });
        return;
      }
      res.json(serializeVideoJob(saved));
    });
  },
);

/** Hard ceiling on scenes per narrated storyboard: the largest planned board
 * (character, 3 paragraphs) is 12 scenes, and each added scene lengthens the
 * recording and the render, so growth past this needs a new video instead. */
const MAX_NARRATED_STORYBOARD_SCENES = 16;

/** Add a scene to a paused narrated storyboard. Costs one extra video unit,
 * funded the same way as the job so every refund path stays consistent. */
router.post(
  "/ai/video-jobs/:jobId/storyboard/scenes",
  async (req: Request, res: Response) => {
    const parsed = InsertVideoStoryboardSceneBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const loaded = await loadPausedJob(req, res);
    if (!loaded) return;
    const { job, storyboard } = loaded;
    if (await rejectDisabledVideoMode(job.engine, res)) return;
    if (storyboard.mode === "guided_story") {
      res.status(400).json({
        error: "Guided Story storyboards are immutable. Change the draft and start a new attempt.",
      });
      return;
    }
    if (storyboard.mode === "hybrid_character_story") {
      res.status(400).json({
        error:
          "Hybrid story beat structure is fixed and cannot be changed during review.",
      });
      return;
    }

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
    const afterSceneId = parsed.data.afterSceneId;
    const text = parsed.data.text.trim();
    if (!text) {
      res.status(400).json({ error: "The new scene needs narration text." });
      return;
    }
    const sceneDraft = {
      text,
      visual: parsed.data.visual?.trim() || text,
      durationSec: 0,
      previewPath: null as string | null,
      outfitId: null as number | null,
    };

    // Fund the extra unit the same way the job was funded — mixed funding would
    // break the refund paths, which give back videoJobUnits(engine, options)
    // only when funding is "credit". The unit is recorded in options.addedScenes
    // so success metering, discard and failure refunds all price it in.
    const options = job.options ?? { aspectRatio: "9:16" as const };
    // An added scene is one more generation on the job's OWN model, so it costs
    // that model's multiplier — the same arithmetic videoJobUnits applies to
    // addedScenes. Charging a flat unit here while the refund paths recompute a
    // multiplied one is how a tenant ends up owed money nobody notices.
    const sceneUnits = videoModelMultiplier(options.modelId);
    let insertedJob: VideoGeneration;
    let insertedScene: VideoStoryboardScene;
    if (job.funding === "wallet") {
      const inserted = await insertWalletFundedStoryboardScene({
        tenantId: req.tenantId,
        jobId: job.id,
        scene: sceneDraft,
        afterSceneId,
        units: sceneUnits,
        maxScenes: MAX_NARRATED_STORYBOARD_SCENES,
      });
      if (inserted.status === "insufficient") {
        res.status(402).json({
          error:
            "Adding a scene needs another generation and your wallet can't cover it.",
        });
        return;
      }
      if (inserted.status === "invalid_anchor") {
        res
          .status(400)
          .json({ error: "That scene is not in this storyboard." });
        return;
      }
      if (inserted.status === "rejected") {
        res
          .status(400)
          .json({ error: "This video is not waiting for storyboard review." });
        return;
      }
      if (inserted.status === "at_cap") {
        res.status(400).json({
          error: `This storyboard is at its maximum of ${MAX_NARRATED_STORYBOARD_SCENES} scenes.`,
        });
        return;
      }
      insertedJob = inserted.job!;
      insertedScene = inserted.scene!;
    } else {
      let quotaLimit = -1;
      let quotaUsage = 0;
      if (job.funding !== "credit") {
        const tenant = (
          await db
            .select()
            .from(tenantsTable)
            .where(eq(tenantsTable.id, req.tenantId))
        )[0];
        const limits = await getPlanLimits(tenant?.plan ?? "free");
        const usage = await getUsage(req.tenantId);
        quotaLimit = limits.videos;
        quotaUsage = usage.videos;
      }
      const inserted = await db.transaction(async (tx) => {
        const [fresh] = await tx
          .select()
          .from(videoGenerationsTable)
          .where(
            and(
              eq(videoGenerationsTable.id, job.id),
              eq(videoGenerationsTable.tenantId, req.tenantId),
            ),
          )
          .for("update")
          .limit(1);
        if (!fresh || fresh.status !== "awaiting_review" || !fresh.storyboard) {
          return { status: "rejected" as const };
        }
        if (fresh.storyboard.scenes.length >= MAX_NARRATED_STORYBOARD_SCENES) {
          return { status: "at_cap" as const };
        }
        if (
          afterSceneId != null &&
          !fresh.storyboard.scenes.some((scene) => scene.id === afterSceneId)
        ) {
          return { status: "invalid_anchor" as const };
        }
        const freshOptions = fresh.options ?? options;
        if (
          fresh.funding !== "credit" &&
          quotaLimit !== -1 &&
          quotaUsage +
            videoJobUnits(fresh.engine, {
              ...freshOptions,
              addedScenes: (freshOptions.addedScenes ?? 0) + 1,
            }) >
            quotaLimit
        ) {
          return { status: "insufficient" as const };
        }
        if (
          fresh.funding === "credit" &&
          !(await spendCredit(req.tenantId, "video", sceneUnits, tx))
        ) {
          return { status: "insufficient" as const };
        }
        const nextNumber =
          fresh.storyboard.scenes.reduce((max, scene) => {
            const match = /^s(\d+)$/.exec(scene.id);
            return match ? Math.max(max, Number(match[1])) : max;
          }, 0) + 1;
        const averageDuration =
          fresh.storyboard.scenes.reduce(
            (sum, item) => sum + item.durationSec,
            0,
          ) / fresh.storyboard.scenes.length;
        const scene: VideoStoryboardScene = {
          ...sceneDraft,
          id: `s${nextNumber}`,
          durationSec: Math.round(averageDuration * 10) / 10,
        };
        const scenes = [...fresh.storyboard.scenes];
        const at =
          afterSceneId === null
            ? 0
            : afterSceneId === undefined
              ? scenes.length
              : Math.max(
                  0,
                  scenes.findIndex(
                    (candidate) => candidate.id === afterSceneId,
                  ) + 1,
                );
        scenes.splice(at, 0, scene);
        const deferredFunding = freshOptions.storyboardFunding;
        const [updated] = await tx
          .update(videoGenerationsTable)
          .set({
            storyboard: { ...fresh.storyboard, scenes },
            options: {
              ...freshOptions,
              addedScenes: (freshOptions.addedScenes ?? 0) + 1,
              ...(deferredFunding
                ? {
                    storyboardFunding: {
                      ...deferredFunding,
                      sceneCount: scenes.length,
                      requiredUnits:
                        (deferredFunding.requiredUnits ??
                          deferredFunding.fundedUnits) + sceneUnits,
                      fundedUnits: deferredFunding.fundedUnits + sceneUnits,
                    },
                  }
                : {}),
            },
            updatedAt: new Date(),
          })
          .where(eq(videoGenerationsTable.id, fresh.id))
          .returning();
        return { status: "inserted" as const, job: updated!, scene };
      });
      if (inserted.status === "insufficient") {
        res.status(402).json({
          error:
            job.funding === "credit"
              ? sceneUnits > 1
                ? `Adding a scene needs ${sceneUnits} video credits and you do not have enough left.`
                : "Adding a scene needs one video credit and you have none left."
              : "Adding a scene needs one more video unit than your monthly quota has left. Upgrade your plan or start a smaller video.",
        });
        return;
      }
      if (inserted.status === "at_cap") {
        res.status(400).json({
          error: `This storyboard is at its maximum of ${MAX_NARRATED_STORYBOARD_SCENES} scenes.`,
        });
        return;
      }
      if (inserted.status === "invalid_anchor") {
        res
          .status(400)
          .json({ error: "That scene is not in this storyboard." });
        return;
      }
      if (inserted.status === "rejected") {
        res
          .status(400)
          .json({ error: "This video is not waiting for storyboard review." });
        return;
      }
      insertedJob = inserted.job;
      insertedScene = inserted.scene;
    }

    // The row lock above allocated and inserted the unique scene before this
    // paid/slow work. Concurrent requests therefore cannot share an id or hold.
    let previewBoard;
    try {
      previewBoard = await refreshStoryboardScenePreview(
        insertedJob,
        insertedJob.storyboard!,
        insertedScene,
      );
    } catch (error) {
      req.log.warn(
        { err: error, jobId: job.id },
        "Storyboard scene insert preview failed",
      );
      if (job.funding === "wallet") {
        await rollbackWalletFundedStoryboardScene({
          tenantId: req.tenantId,
          jobId: job.id,
          sceneId: insertedScene.id,
          units: sceneUnits,
          note: "storyboard scene insert failed",
        }).catch((rollbackError) =>
          req.log.error(
            { err: rollbackError, jobId: job.id },
            "Wallet scene rollback failed",
          ),
        );
      } else {
        await db.transaction(async (tx) => {
          const [fresh] = await tx
            .select()
            .from(videoGenerationsTable)
            .where(eq(videoGenerationsTable.id, job.id))
            .for("update")
            .limit(1);
          if (
            !fresh?.storyboard?.scenes.some(
              (scene) => scene.id === insertedScene.id,
            )
          )
            return;
          const scenes = fresh.storyboard.scenes.filter(
            (scene) => scene.id !== insertedScene.id,
          );
          const currentOptions = fresh.options ?? options;
          const funding = currentOptions.storyboardFunding;
          await tx
            .update(videoGenerationsTable)
            .set({
              storyboard: { ...fresh.storyboard, scenes },
              options: {
                ...currentOptions,
                addedScenes:
                  Math.max(0, (currentOptions.addedScenes ?? 1) - 1) ||
                  undefined,
                ...(funding
                  ? {
                      storyboardFunding: {
                        ...funding,
                        sceneCount: scenes.length,
                        requiredUnits: Math.max(
                          funding.planningUnits,
                          (funding.requiredUnits ?? funding.fundedUnits) -
                            sceneUnits,
                        ),
                        fundedUnits: Math.max(
                          funding.planningUnits,
                          funding.fundedUnits - sceneUnits,
                        ),
                      },
                    }
                  : {}),
              },
              updatedAt: new Date(),
            })
            .where(eq(videoGenerationsTable.id, job.id));
          if (job.funding === "credit") {
            await refundCredits(
              req.tenantId,
              "video",
              sceneUnits,
              "storyboard scene insert failed",
              tx,
            );
          }
        });
      }
      const message =
        error instanceof VideoGenProviderError
          ? error.message
          : "Generating the new scene's image failed. Please try again.";
      res.status(502).json({ error: message });
      return;
    }
    const generated =
      previewBoard.scenes.find((scene) => scene.id === insertedScene.id) ??
      insertedScene;
    const saved = (
      await db
        .update(videoGenerationsTable)
        .set({
          storyboard: sql`jsonb_set(${videoGenerationsTable.storyboard}, '{scenes}', (
      select jsonb_agg(case when scene->>'id' = ${insertedScene.id} then ${JSON.stringify(generated)}::jsonb else scene end)
      from jsonb_array_elements(${videoGenerationsTable.storyboard}->'scenes') scene
    ))`,
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
      res
        .status(400)
        .json({ error: "This video is not waiting for storyboard review." });
      return;
    }
    res.json(serializeVideoJob(saved));
  },
);

/** Re-roll one scene's preview still from its current prompt. */
router.post(
  "/ai/video-jobs/:jobId/storyboard/scenes/:sceneId/preview",
  async (req: Request, res: Response) => {
    const loaded = await loadPausedJob(req, res);
    if (!loaded) return;
    const { job, storyboard } = loaded;
    if (await rejectDisabledVideoMode(job.engine, res)) return;
    if (storyboard.mode === "guided_story") {
      res.status(400).json({
        error: "Guided Story storyboards are immutable. Change the draft and start a new attempt.",
      });
      return;
    }
    if (storyboard.mode === "hybrid_character_story") {
      res.status(400).json({
        error:
          "Hybrid beat redraw is unavailable while identity-anchored preview funding is not supported.",
      });
      return;
    }

    // "photo" and "slide" plans preview the user's OWN uploaded photos, and a
    // "prompt" plan has no still at all — there is nothing here to re-roll, and
    // generating one would replace a photo they chose with one they did not.
    if (
      !storyboardPreviewsAreGenerated(storyboard.visualsSource, storyboard.mode)
    ) {
      res.status(400).json({
        error:
          "This storyboard's images are your own photos, so there is nothing to redraw.",
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
      req.log.warn(
        { err: error, jobId: job.id },
        "Storyboard preview regeneration failed",
      );
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
      res
        .status(400)
        .json({ error: "This video is not waiting for storyboard review." });
      return;
    }
    res.json(serializeVideoJob(saved));
  },
);

/**
 * Claim a preview-only Guided Story operation. The parent remains paused for
 * review; polling the ordinary VideoJob exposes this operation's lifecycle.
 */
router.post(
  "/ai/video-jobs/:jobId/storyboard/render-missing-previews",
  async (req: Request, res: Response) => {
    const jobId = Number(req.params.jobId);
    if (!Number.isSafeInteger(jobId) || jobId <= 0) {
      res.status(400).json({ error: "Invalid video job id." });
      return;
    }
    const result = await db.transaction(async (tx) => {
      const [job] = await tx.select().from(videoGenerationsTable).where(and(
        eq(videoGenerationsTable.id, jobId),
        eq(videoGenerationsTable.tenantId, req.tenantId),
      )).for("update").limit(1);
      if (!job) return { kind: "missing" as const };
      if (job.status !== "awaiting_review" || job.storyboard?.mode !== "guided_story") {
        return { kind: "invalid" as const };
      }
      const active = job.options?.guidedPreviewRender;
      if (active?.state === "queued" || active?.state === "running") {
        return { kind: "existing" as const, job };
      }
      if (job.storyboard.scenes.some((scene) =>
        (scene.guidedStory?.corrections?.attempts ?? []).some((attempt) =>
          ["queued", "running", "provider_started", "provider_succeeded"].includes(attempt.state)))) {
        return { kind: "correction_active" as const };
      }
      const missing = job.storyboard.scenes.filter((scene) =>
        !scene.previewPath ||
        scene.previewCheckpoint?.status !== "complete" ||
        scene.previewCheckpoint.targetPath !== scene.previewPath,
      ).length;
      if (missing === 0) return { kind: "complete" as const, job };
      const now = new Date();
      const operation = {
        version: 1 as const,
        operationId: `guided-preview:${job.id}:${now.getTime()}`,
        state: "queued" as const,
        total: job.storyboard.scenes.length,
        completed: job.storyboard.scenes.length - missing,
        error: null,
        requestedAt: now.toISOString(),
        startedAt: null,
        finishedAt: null,
      };
      const [claimed] = await tx.update(videoGenerationsTable).set({
        options: {
          ...(job.options ?? { aspectRatio: "9:16" as const }),
          guidedPreviewRender: operation,
        },
        error: null,
        updatedAt: now,
      }).where(and(
        eq(videoGenerationsTable.id, job.id),
        eq(videoGenerationsTable.tenantId, req.tenantId),
        eq(videoGenerationsTable.status, "awaiting_review"),
      )).returning();
      return { kind: "claimed" as const, job: claimed! };
    });
    if (result.kind === "missing") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (result.kind === "invalid") {
      res.status(400).json({
        error: "Only a Guided Story waiting for storyboard review can render missing previews.",
      });
      return;
    }
    if (result.kind === "correction_active") {
      res.status(409).json({
        error: "Wait for the active scene correction before rendering missing previews.",
      });
      return;
    }
    if (result.kind === "complete") {
      res.status(200).json(serializeVideoJob(result.job));
      return;
    }
    if (result.kind === "existing") {
      res.status(202).json(serializeVideoJob(result.job));
      return;
    }
    if (!enqueueBackgroundJob(() => runGuidedPreviewRenderJob(result.job.id))) {
      await db.update(videoGenerationsTable).set({
        options: {
          ...result.job.options!,
          guidedPreviewRender: {
            ...result.job.options!.guidedPreviewRender!,
            state: "failed",
            error: "Server is restarting. Please retry in a moment.",
            finishedAt: new Date().toISOString(),
          },
        },
        error: "Server is restarting. Please retry in a moment.",
      }).where(and(
        eq(videoGenerationsTable.id, result.job.id),
        eq(videoGenerationsTable.tenantId, req.tenantId),
      ));
      res.status(503).json({ error: "Server is restarting. Please retry in a moment." });
      return;
    }
    res.status(202).json(serializeVideoJob(result.job));
  },
);

router.post(
  "/ai/video-jobs/:jobId/storyboard/scenes/:sceneId/corrections",
  async (req: Request, res: Response) => {
    const parsed = CorrectGuidedStorySceneBody.safeParse(req.body);
    const jobId = Number(req.params.jobId);
    if (
      !parsed.success ||
      parsed.data.confirmed !== true ||
      !Number.isSafeInteger(jobId) ||
      jobId <= 0
    ) {
      res.status(400).json({
        error: "Choose a correction category, add a 3-300 character note, and explicitly confirm.",
      });
      return;
    }
    const sceneId = String(req.params.sceneId);
    const [before] = await db.select().from(videoGenerationsTable).where(and(
      eq(videoGenerationsTable.id, jobId),
      eq(videoGenerationsTable.tenantId, req.tenantId),
    )).limit(1);
    const beforeScene = before?.storyboard?.scenes.find((scene) => scene.id === sceneId);
    if (
      !before || before.status !== "awaiting_review" ||
      before.storyboard?.mode !== "guided_story" || !beforeScene?.guidedStory ||
      !beforeScene.previewPath ||
      beforeScene.previewCheckpoint?.status !== "complete" ||
      beforeScene.previewCheckpoint.targetPath !== beforeScene.previewPath
    ) {
      res.status(400).json({
        error: "Only a complete generated Guided Story preview can be corrected.",
      });
      return;
    }
    const existingActive = before.storyboard.scenes.flatMap((scene) =>
      scene.guidedStory?.corrections?.attempts ?? []).find((attempt) =>
        ["queued", "running", "provider_started", "provider_succeeded"].includes(attempt.state));
    if (
      before.options?.guidedPreviewRender?.state === "queued" ||
      before.options?.guidedPreviewRender?.state === "running"
    ) {
      res.status(409).json({
        error: "Wait for missing Guided Story previews to finish before correcting a scene.",
      });
      return;
    }
    if (existingActive) {
      res.status(202).json(serializeVideoJob(before));
      return;
    }
    const latest = beforeScene.guidedStory.corrections?.attempts.at(-1);
    if (latest?.state === "outcome_unknown") {
      res.status(409).json({
        error: "This scene has an uncertain provider outcome that must be reconciled before retrying.",
      });
      return;
    }

    const funding = await reserveImageFunding(req);
    if (!funding) {
      res.status(402).json({
        error: "Your image quota, credits, or wallet balance cannot fund this correction.",
      });
      return;
    }
    const now = new Date();
    const attemptId = `guided-correction:${jobId}:${sceneId}:${now.getTime()}`;
    const result = await db.transaction(async (tx) => {
      const [job] = await tx.select().from(videoGenerationsTable).where(and(
        eq(videoGenerationsTable.id, jobId),
        eq(videoGenerationsTable.tenantId, req.tenantId),
      )).for("update").limit(1);
      const scene = job?.storyboard?.scenes.find((item) => item.id === sceneId);
      if (!job?.storyboard || job.status !== "awaiting_review" || !scene?.guidedStory ||
        scene.previewPath !== beforeScene.previewPath) return null;
      const allAttempts = job.storyboard.scenes.flatMap((item) =>
        item.guidedStory?.corrections?.attempts ?? []);
      if (allAttempts.some((attempt) =>
        ["queued", "running", "provider_started", "provider_succeeded"].includes(attempt.state))) {
        return null;
      }
      const attempts = scene.guidedStory.corrections?.attempts ?? [];
      scene.guidedStory.corrections = {
        version: 1,
        attempts: [...attempts, {
          id: attemptId,
          version: attempts.length + 1,
          category: parsed.data.category,
          note: parsed.data.note.trim(),
          state: "queued",
          inputFingerprint: scene.guidedStory.inputFingerprint,
          originalPreviewPath: scene.previewPath!,
          replacementPath: null,
          funding: funding.source,
          walletReservation: funding.reservation ?? null,
          walletOperationId: null,
          provider: null,
          model: null,
          knownCostPaise: funding.reservation?.amountPaise ?? null,
          actualCostPaise: null,
          error: null,
          requestedAt: now.toISOString(),
          startedAt: null,
          finishedAt: null,
        }],
      };
      scene.guidedStory.inconsistencyFlags = [
        ...scene.guidedStory.inconsistencyFlags.filter((flag) =>
          !flag.startsWith("user_reported:")),
        `user_reported:${parsed.data.category}`,
      ];
      return (await tx.update(videoGenerationsTable).set({
        storyboard: job.storyboard,
        updatedAt: now,
      }).where(eq(videoGenerationsTable.id, job.id)).returning())[0]!;
    });
    if (!result) {
      await releaseImageFunding(req, funding);
      const [current] = await db.select().from(videoGenerationsTable).where(and(
        eq(videoGenerationsTable.id, jobId),
        eq(videoGenerationsTable.tenantId, req.tenantId),
      )).limit(1);
      const active = current?.storyboard?.scenes.flatMap((item) =>
        item.guidedStory?.corrections?.attempts ?? []).find((attempt) =>
          ["queued", "running", "provider_started", "provider_succeeded"].includes(
            attempt.state,
          ));
      if (current && active) {
        res.status(202).json(serializeVideoJob(current));
        return;
      }
      res.status(409).json({ error: "The storyboard changed or another correction was started." });
      return;
    }
    if (!enqueueBackgroundJob(() =>
      runGuidedSceneCorrectionJob(result.id, sceneId, attemptId))) {
      // The durable queued attempt is recovered at next startup; do not release
      // its funding or allow a second charge.
      res.status(503).json({ error: "Server is restarting. The funded correction remains queued." });
      return;
    }
    res.status(202).json(serializeVideoJob(result));
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
    if (loaded.storyboard.mode === "guided_story") {
      if (
        loaded.job.options?.guidedPreviewRender?.state === "queued" ||
        loaded.job.options?.guidedPreviewRender?.state === "running"
      ) {
        res.status(409).json({
          error: "Missing previews are still rendering. Review them after the operation finishes.",
        });
        return;
      }
      const latestUnresolved = loaded.storyboard.scenes.some((scene) => {
        const latest = scene.guidedStory?.corrections?.attempts.at(-1);
        return latest != null && latest.state !== "succeeded";
      });
      if (latestUnresolved) {
        res.status(409).json({
          error: "Guided Story approval is blocked while a correction is active or unresolved.",
        });
        return;
      }
      const draftId = loaded.job.options?.guidedStory?.draftId;
      const draft = draftId
        ? await loadGuidedDraft(req.tenantId, draftId)
        : null;
      if (!draft || Object.keys(draft.state.castOperations ?? {}).length > 0) {
        res.status(409).json({
          error:
            "Guided Story casting is still being committed. Retry approval after it finishes.",
        });
        return;
      }
      const snapshot = loaded.job.options?.guidedStory;
      if (
        !snapshot ||
        !guidedStoryApprovalSnapshotMatches({
          draftId: draft.id,
          draftRevision: draft.revision,
          draftState: draft.state,
          jobId: loaded.job.id,
          snapshot,
          storyboard: loaded.storyboard,
        })
      ) {
        res.status(409).json({
          error:
            "Guided Story changed or has incomplete previews. Change the draft and start a new immutable attempt.",
        });
        return;
      }
    }

    // Claim atomically here rather than in the runner, so two approve requests
    // cannot both start a render (the second finds nothing to claim).
    const claimValues = {
      status: "processing" as const,
      stage: "Getting started",
      storyboardExpiresAt: null,
      updatedAt: new Date(),
    };
    const claimed =
      loaded.storyboard.mode === "guided_story"
        ? await db.transaction(async (tx) => {
            const job = (
              await tx
                .select()
                .from(videoGenerationsTable)
                .where(
                  and(
                    eq(videoGenerationsTable.id, loaded.job.id),
                    eq(videoGenerationsTable.tenantId, req.tenantId),
                  ),
                )
                .for("update")
                .limit(1)
            )[0];
            const snapshot = job?.options?.guidedStory;
            if (
              !job ||
              job.status !== "awaiting_review" ||
              !job.storyboard ||
              job.storyboard.mode !== "guided_story" ||
              !snapshot ||
              job.options?.guidedPreviewRender?.state === "queued" ||
              job.options?.guidedPreviewRender?.state === "running"
            )
              return null;
            const draft = (
              await tx
                .select()
                .from(guidedStoryDraftsTable)
                .where(
                  and(
                    eq(guidedStoryDraftsTable.id, snapshot.draftId),
                    eq(guidedStoryDraftsTable.tenantId, req.tenantId),
                  ),
                )
                .for("update")
                .limit(1)
            )[0];
            if (
              !draft ||
              !guidedStoryApprovalSnapshotMatches({
                draftId: draft.id,
                draftRevision: draft.revision,
                draftState: draft.state,
                jobId: job.id,
                snapshot,
                storyboard: job.storyboard,
              })
            )
              return null;
            return (
              (
                await tx
                  .update(videoGenerationsTable)
                  .set(claimValues)
                  .where(
                    and(
                      eq(videoGenerationsTable.id, job.id),
                      eq(videoGenerationsTable.tenantId, req.tenantId),
                      eq(videoGenerationsTable.status, "awaiting_review"),
                      isNotNull(videoGenerationsTable.storyboard),
                    ),
                  )
                  .returning()
              )[0] ?? null
            );
          })
        : (
            await db
              .update(videoGenerationsTable)
              .set(claimValues)
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
      res.status(loaded.storyboard.mode === "guided_story" ? 409 : 400).json({
        error:
          loaded.storyboard.mode === "guided_story"
            ? "Guided Story approval was rejected because the draft, cast, or exact preview snapshot changed."
            : "This video is not waiting for storyboard review.",
      });
      return;
    }
    // Native templates may have stopped after their one-unit planning reserve.
    // We claim first (preventing double approvals), then acquire the immutable
    // board's missing visual funding. A shortfall puts precisely this plan back
    // for a later approval rather than discarding or re-planning it.
    const claimedBoard = claimed.storyboard!;
    const claimedCreativeIssues = lintStoryboardCreativeBrief(
      claimedBoard,
      claimed.options?.resolvedCreativeBrief,
    );
    if (claimedCreativeIssues.length > 0) {
      await db
        .update(videoGenerationsTable)
        .set({
          status: "awaiting_review",
          stage: null,
          storyboardExpiresAt: loaded.job.storyboardExpiresAt,
        })
        .where(eq(videoGenerationsTable.id, claimed.id));
      res
        .status(400)
        .json({
          error:
            "The storyboard changed while approval was being claimed. Review it and try again.",
        });
      return;
    }
    const fundingResult = await fundPlannedTemplateVisualWork(
      claimed,
      claimedBoard,
    );
    if (!fundingResult.funded) {
      await db
        .update(videoGenerationsTable)
        .set({
          status: "awaiting_review",
          stage: null,
          error: fundingResult.error,
          storyboardExpiresAt: loaded.job.storyboardExpiresAt,
          updatedAt: new Date(),
        })
        .where(eq(videoGenerationsTable.id, claimed.id));
      res.status(402).json({ error: fundingResult.error });
      return;
    }
    const fundedClaim = fundingResult.job;

    const accepted = enqueueBackgroundJob(() =>
      resumeVideoGenerationJob(fundedClaim),
    );
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
        .where(eq(videoGenerationsTable.id, fundedClaim.id));
      res
        .status(503)
        .json({ error: "Server is restarting. Please retry in a moment." });
      return;
    }
    res.status(202).json(serializeVideoJob(fundedClaim));
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
      res
        .status(400)
        .json({ error: "This video is not waiting for storyboard review." });
      return;
    }
    const discardedReservation = reservationFromRow(discarded);
    if (discardedReservation) {
      await refundFailedVideoJobWallet(
        discarded.id,
        "storyboard discarded",
      ).catch((err) =>
        req.log.error(
          { err, jobId: discarded.id },
          "Failed to refund discarded storyboard",
        ),
      );
    } else if (discarded.funding === "credit") {
      await refundCredits(
        req.tenantId,
        "video",
        videoJobUnits(discarded.engine, discarded.options),
        "storyboard discarded",
      ).catch((err) =>
        req.log.error(
          { err, jobId: discarded.id },
          "Failed to refund discarded storyboard",
        ),
      );
    }
    const guidedDraftId = discarded.options?.guidedStory?.draftId;
    if (guidedDraftId) {
      const draft = await loadGuidedDraft(req.tenantId, guidedDraftId);
      if (draft?.state.storyboardJobId === discarded.id) {
        await saveGuidedState(draft, draft.revision, {
          ...draft.state,
          // Consent is attempt-scoped. Discarding never revives the checkbox
          // captured for the abandoned provider attempt.
          cast: draft.state.cast.map((member) => ({
            ...member,
            consentGranted: false,
          })),
          storyboardJobId: null,
        });
      }
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
    const result = await db.transaction(async (tx) => {
      const job = (
        await tx
          .select()
          .from(videoGenerationsTable)
          .where(
            and(
              eq(videoGenerationsTable.id, Number(req.params.jobId)),
              eq(videoGenerationsTable.tenantId, req.tenantId),
            ),
          )
          .for("update")
          .limit(1)
      )[0];
      if (!job) return { status: 404 as const, error: "Not found" };
      if (job.status !== "succeeded" || !job.videoPath) {
        return { status: 400 as const, error: "This video is not ready yet." };
      }

      if (job.savedContentItemId) {
        const existing = (
          await tx
            .select()
            .from(contentItemsTable)
            .where(
              and(
                eq(contentItemsTable.id, job.savedContentItemId),
                eq(contentItemsTable.tenantId, req.tenantId),
              ),
            )
            .limit(1)
        )[0];
        if (existing) return { status: 200 as const, content: existing };
      }

      const repairChild = (
        await tx
          .select()
          .from(videoGenerationsTable)
          .where(eq(videoGenerationsTable.tenantId, req.tenantId))
          .orderBy(desc(videoGenerationsTable.id))
      ).find(
        (candidate) =>
          candidate.options?.repair?.sourceJobId === job.id &&
          candidate.status === "succeeded" &&
          Boolean(candidate.videoPath),
      );
      const currentVideoPath = repairChild?.videoPath ?? job.videoPath;
      const legacyExisting = (
        await tx
          .select()
          .from(contentItemsTable)
          .where(
            and(
              eq(contentItemsTable.tenantId, req.tenantId),
              eq(contentItemsTable.videoPath, currentVideoPath),
            ),
          )
          .orderBy(desc(contentItemsTable.id))
          .limit(1)
      )[0];
      if (legacyExisting) {
        await tx
          .update(videoGenerationsTable)
          .set({ savedContentItemId: legacyExisting.id, updatedAt: new Date() })
          .where(
            and(
              eq(videoGenerationsTable.id, job.id),
              eq(videoGenerationsTable.tenantId, req.tenantId),
            ),
          );
        return { status: 200 as const, content: legacyExisting };
      }
      const created = (
        await tx
          .insert(contentItemsTable)
          .values({
            tenantId: req.tenantId,
            title: parsed.data.title,
            caption: parsed.data.caption ?? "",
            videoPath: currentVideoPath,
            videoThumbnailPath: repairChild?.thumbnailPath ?? job.thumbnailPath,
            platform: parsed.data.platform ?? "instagram",
            contentType: "reel",
            status: "draft",
            brandKitId: parsed.data.brandKitId ?? null,
          })
          .returning()
      )[0]!;
      await tx
        .update(videoGenerationsTable)
        .set({ savedContentItemId: created.id, updatedAt: new Date() })
        .where(
          and(
            eq(videoGenerationsTable.id, job.id),
            eq(videoGenerationsTable.tenantId, req.tenantId),
          ),
        );
      return { status: 201 as const, content: created };
    });

    if ("error" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.status(result.status).json(serializeContent(result.content));
  },
);

export default router;
