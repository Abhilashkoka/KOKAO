import {
  db,
  isPromptVariantKey,
  videoGenerationsTable,
  tenantsTable,
  type VideoGeneration,
  type VideoJobOptions,
  type VideoStoryboard,
  type VideoStoryboardScene,
  type VideoGenerationErrorHistoryEntry,
  type LocalizedDubResult,
  type VideoPriceCriteria,
} from "@workspace/db";
import { createHash } from "node:crypto";
import { mkdtemp, readFile as readLocalFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { ObjectStorageService, ObjectNotFoundError } from "../objectStorage";
import { getUsage, recordUsage } from "../usage";
import {
  computeVideoCostPaise,
  computeImageCostPaise,
  isVideoModelPriced,
  elevenLabsCreditReservationCeiling,
  elevenLabsCreditsToPaise,
  getAiCostConfig,
} from "../aiCost";
import { computeDisplayPaise, getAiSpendConfig } from "../aiSpend";
import { refundCredits, spendCredit } from "../credits";
import {
  actualChargePaise,
  exactChargePaise,
  executeWalletProviderOperation,
  getVideoJobWalletChargesPaise,
  isWalletFunded,
  reconcileVideoJobWalletCost,
  refundFailedVideoJobWallet,
  refundWallet,
  reservationFromRow,
  reserveWallet,
  reserveVideoJobWalletTopUp,
  videoJobWalletReservations,
  settleWalletDurably,
  settleWalletProviderOperationDurably,
  type WalletReservation,
} from "../wallet";
import { logger } from "../logger";
import { recordServerEvent } from "../analytics";
import {
  recordStudioLipSyncEvent,
  studioLipSyncWorkflow,
} from "./studioLipSyncAnalytics";
import { ImageGenProviderError } from "../imageGen";
import {
  generateVideo,
  hasNativeSynchronizedAudio,
  getVideoGenProviderDef,
  getVideoGenSelection,
  resolveVideoGenApiKey,
  resolveLipSyncModelRef,
  VideoGenNotConfiguredError,
  VideoGenProviderError,
  VideoModelResolutionError,
} from "./index";
import { generateLipSyncWithReplicate } from "./providers/replicate";
import { prepareLipSyncSource, MIN_USABLE_HEIGHT } from "./lipSyncSource";
import { synthesizeNarration, splitIntoSentences } from "./topicVideo/narration";
import { buildWav, parseWav } from "./topicVideo/narration";
import { composeTopicVideo } from "./topicVideo/compose";
import {
  generateBrollStills,
  animateBrollStills,
  privacySafeGeneratedVisualPrompt,
} from "./topicVideo/aiBroll";
import {
  OPENROUTER_INPUT_IMAGE_PRIVACY_CODE,
  OpenRouterInputImagePrivacyError,
} from "./providers/openrouter";
import { assertHybridStoryBeatPlan, planHybridStoryBeats } from "./hybridStory";
import { renderSlideshow, extractPosterFrame, expectedSlideshowDurationSec } from "./slideshow";
import {
  normalizeVideo,
  mixMusicIntoVideo,
  fitImageToAspect,
  applyAppWatermarkToVideo,
  loopVideoPlateToDuration,
  concatClips,
} from "./postprocess";
import { composeApprovedStillAudioClip, composeCharacterDialogue, probeNarrationWavDurationSec, trimCharacterDialogueClipStrict } from "./characterDialogueCompose";
import { planAudioFit } from "../localization/dub";
import { probeDurationSec, runFfmpeg } from "./slideshow";
import {
  characterDialogueStoryboard,
  lipSyncSourcePlatePrompt,
} from "./characterDialogue";
import { getPlan, getPlanLimits } from "../plans";
import { generateMusicBed, MUSICGEN_MODEL, musicGenDurationSec } from "./musicGen";
import { loadVideoBranding } from "./branding";
import { loadStyleGuidance } from "./referenceAnalyzer";
import { isFeatureEnabled, videoModeFeature } from "../featureFlags";
import { verifyRenderedVideo, verifyRepairedVideo, type VideoQaExpectations } from "./qaGate";
import {
  generateTopicVideo,
  planTopicStoryboard,
  prepareCharacterStoryStoryboard,
  renderTopicStoryboard,
  refreshEditedNarration,
  regenerateStoryboardPreview,
  guidedContinuityImages,
  rememberGuidedContinuityImage,
  synthesizeGuidedNarration,
  NARRATION_VOICES,
  type NarrationVoice,
  resolveNarrationVoice,
  type StockSourceChoice,
} from "./topicVideo";
import { isSuppliedPlan } from "./topicVideo/suppliedPlan";
import { generateCharacterClip } from "./characterClip";
import {
  clipShotCount,
  clipStoryboardSource,
  clipStoryboardTotalSec,
  planClipStoryboard,
  polishStoryboardPrompts,
  renderClipStoryboard,
} from "./clipStoryboard";
import { hybridNarrationIsAggregateOwned, hybridRequiredUnits, videoJobUnits } from "./units";
import { motionPresetClause } from "./motionPrompt";
import {
  GUIDED_CAST_APPROVAL_REQUIRED_MESSAGE,
  guidedCastApprovalsMatch,
  guidedStorySceneImmutableInputsMatch,
  guidedBackdropFingerprint,
  guidedBackdropCoversEveryScriptScene,
  guidedStoryBackdropsAreApproved,
  guidedStoryStoryboard,
  effectiveGuidedBackdrop,
} from "./guidedStory";
import { resolveModelOptions, videoModelMultiplier } from "./modelCatalog";
import {
  LATENT_SYNC,
  SYNC_LIPSYNC_2,
  lipSyncModelForQuality,
  portraitLipSyncModel,
  ALLOWED_LIP_SYNC_AUDIO_TYPES,
  ALLOWED_LIP_SYNC_IMAGE_TYPES,
  MAX_LIP_SYNC_AUDIO_BYTES,
} from "./lipSyncModels";
import type { SourceImage, VideoAspect } from "./types";
import {
  orchestrateLocalizedDubFull,
  CueOverrunError,
  extractVoiceSampleWav,
  LocalizedDubInputError,
  type ApprovedDubCue,
} from "../localization/dub";
import { normalizeLocalizedNarrationSelection } from "./topicVideo/tts";
import {
  buildBrandVoiceTtsOperationKey,
  elevenLabsDubSourceVoice,
  resolveElevenLabsSpeechLanguage,
  isConfirmedVoiceCloneFailure,
  resolveVoiceCloneApiKey,
  getVoiceCloneProviderDef,
  speakWithClonedVoiceReceipt,
  type ClonedVoiceRef,
} from "../voiceClone";
import { getTextGenClient } from "../textGen";
import { parseModelJsonObject } from "../modelJson";
import {
  characterStoryPresenterBroll,
  presenterStoryboard,
  renderPresenterBroll,
  resolvePresenterBrollAssets,
  syncReviewedPresenterBroll,
  unaccountedPresenterBrollEvents,
} from "./presenterBroll";
import { compileCreativeBrief, lintStoryboardCreativeBrief } from "./creativeBrief";
import { videoPriceCriteria } from "./pricing";

/**
 * Executes one queued video_generations row to completion. Runs inside an
 * in-process background job (lib/backgroundJobs.ts) after the enqueue request
 * has already responded, so it persists every outcome — success or failure —
 * to its own row; clients poll GET /ai/video-jobs/{id}.
 *
 * Funding was reserved by the route BEFORE enqueueing (quota check or an
 * atomic credit debit), so this runner only settles: a usage row on success,
 * a credit refund on failure.
 */

/** Source images must fit provider payloads; same cap as reference images. */
const MAX_SOURCE_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
/** Music uploads: cap matches the audio transcription route's limit. */
const MAX_MUSIC_BYTES = 15 * 1024 * 1024;
/** Lip-sync base videos: big enough for a ~1 minute phone clip, small enough
 * to upload to the provider without minutes of dead transfer time. */
const MAX_SOURCE_VIDEO_BYTES = 100 * 1024 * 1024;
const ALLOWED_SOURCE_VIDEO_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm"]);
/** Narration WAV parked between planning and approval; a few minutes of 24kHz
 * mono is well under this, and it is our own file rather than an upload. */
const MAX_NARRATION_BYTES = 60 * 1024 * 1024;
/** How long an unreviewed storyboard is held before it is swept and refunded.
 * A day is long enough to come back to tomorrow and short enough that reserved
 * credits are not parked indefinitely. */
export const STORYBOARD_TTL_MS = 24 * 60 * 60 * 1000;
/** Free preview re-rolls per storyboard, expressed per scene. Previews are not
 * billed, so this is the abuse ceiling on authenticated image generation — two
 * tries per scene is enough to fix a bad prompt without being an open tap. */
export const STORYBOARD_REGENERATIONS_PER_SCENE = 2;

const objectStorageService = new ObjectStorageService();

export function imageProviderFailureMessage(
  error: ImageGenProviderError,
  storyboard: VideoStoryboard | null | undefined,
): string {
  const total = storyboard?.scenes.length ?? 0;
  const saved = storyboard?.scenes.filter((scene) => Boolean(scene.previewPath)).length ?? 0;
  const progress =
    total > 0 && saved > 0
      ? ` ${saved} of ${total} storyboard images were saved and will be reused when you retry.`
      : "";
  if (error.status === 402) {
    return `AI provider failure: the backup image provider could not fund the remaining image requests.${progress}`;
  }
  if (error.status === 429 || error.status === 503 || /\bE003\b|high demand|rate limit/i.test(error.message)) {
    return `AI provider failure: the image provider is temporarily overloaded.${progress}`;
  }
  return `AI provider failure: an image provider could not complete the remaining storyboard images.${progress}`;
}

class VideoJobInputError extends Error {}

interface VideoProviderEvent {
  eventId?: string;
  provider: string;
  model: string;
  durationSec: number | null;
  requestBytes: number;
  label: string;
  costPaise: number | null;
  /** Request identity frozen with the provider receipt for retry settlement. */
  criteria?: VideoPriceCriteria;
  accounted?: boolean;
  /** Deferred-template units consumed by this operation. Absent keeps legacy event-count semantics. */
  unitWeight?: number;
}

function jobVideoPriceCriteria(job: VideoGeneration, hasReferenceVideo = false): VideoPriceCriteria {
  // Provider dispatch reads these fields from the immutable snapshot. Receipt
  // pricing must do the same: a default-resolved job has modelId=null, so
  // re-resolving mutable catalog options here can select a generic price row.
  const frozen = job.options?.resolvedVideoModel;
  const model = frozen ?? resolveModelOptions(job.options, 5);
  return videoPriceCriteria({
    resolution: model.resolution,
    quality: model.quality,
    generateAudio: model.generateAudio,
    hasReferenceVideo,
  });
}

function durableCheckpointEvents(options: VideoGeneration["options"]): VideoProviderEvent[] {
  return [
    ...(options?.renderCheckpoint?.providerEvents ?? []),
    ...(options?.recovery?.rendered?.providerEvents ?? []),
    ...(options?.musicCheckpoint?.event ? [options.musicCheckpoint.event] : []),
    ...(options?.studioLipSync?.checkpoint?.event &&
    !options.studioLipSync.checkpoint.scenes?.length
      ? [options.studioLipSync.checkpoint.event]
      : []),
    ...(options?.studioLipSync?.checkpoint?.scenes?.flatMap((scene) =>
      scene.event ? [scene.event] : [],
    ) ?? []),
    ...(options?.guidedStoryIntrinsicLipSync?.checkpoint?.scenes.flatMap((scene) =>
      [scene.animationEvent, scene.lipSyncEvent].filter(
        (event): event is VideoProviderEvent => Boolean(event),
      )
    ) ?? []),
  ];
}

/** Mark only settled intrinsic receipts before a failed job can be recovered. */
export function markGuidedStoryIntrinsicEventsAccounted(
  options: VideoJobOptions,
  labels: ReadonlySet<string>,
): void {
  for (const scene of options.guidedStoryIntrinsicLipSync?.checkpoint?.scenes ?? []) {
    if (scene.animationEvent && labels.has(scene.animationEvent.label)) {
      scene.animationEvent.accounted = true;
    }
    if (scene.lipSyncEvent && labels.has(scene.lipSyncEvent.label)) {
      scene.lipSyncEvent.accounted = true;
    }
  }
}

function previewCheckpointEvents(
  checkpoint: VideoStoryboardScene["previewCheckpoint"],
): VideoProviderEvent[] {
  if (!checkpoint) return [];
  const multi = checkpoint as typeof checkpoint & { events?: VideoProviderEvent[] };
  const events = [...(multi.events ?? [])];
  if (
    checkpoint.event &&
    !events.some((candidate) =>
      candidate.eventId === checkpoint.event!.eventId &&
      candidate.label === checkpoint.event!.label)
  ) {
    events.push(checkpoint.event);
  }
  return events;
}

function videoProviderEventId(job: VideoGeneration, label: string): string {
  const chainId =
    job.options?.recovery?.chainId ??
    job.options?.characterDialogue?.retry?.sourceJobId ??
    job.id;
  // A provider call made by a later child is a distinct paid operation. Reused
  // checkpoints carry their original event id and therefore still deduplicate.
  return `video-chain:${chainId}:${label}:job:${job.id}`;
}

async function requirePricedVideoCall(
  provider: string,
  model: string,
  durationSec: number,
  criteria: VideoPriceCriteria = videoPriceCriteria({}),
): Promise<void> {
  if (
    !(await isVideoModelPriced({
      provider,
      model,
      durationSec: Math.max(0.1, durationSec),
      variantCriteria: criteria,
    }).catch(() => false))
  ) {
    throw new VideoGenNotConfiguredError(
      `Video model ${provider}/${model} has no authoritative price. Configure its catalog price before generating.`,
    );
  }
}

/** A paid provider stage completed, but a later stage in the same job failed. */
class PartialVideoProviderWorkError extends Error {
  constructor(
    readonly providerEvents: VideoProviderEvent[],
    readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : "Video generation failed after provider work.");
    this.name = "PartialVideoProviderWorkError";
  }
}

const VIDEO_MODE_DISABLED_MESSAGES = {
  videoTextToVideo: "Text to Video is currently turned off.",
  videoAnimatePhoto: "Animate Photo is currently turned off.",
  videoSlideshow: "Photo Slideshow is currently turned off.",
  videoTopicToVideo: "Topic to Video is currently turned off.",
} as const;

/** Topic mode's reviewable sub-modes. Stock footage is searched rather than
 * prompted, so it has no prompt to review; the other three engines get their
 * plan kind from clipStoryboardSource instead. */
export function topicStoryboardEligible(
  job: VideoGeneration,
): "character" | "ai" | "ai_video" | null {
  if (job.engine !== "topic_to_video") return null;
  // Guided Story is always cast-aware even though its final scene clips are
  // animated image-to-video. Do not let a stale/miscombined source option send
  // it down a stock or generic b-roll branch.
  if (job.options?.guidedStory) return "character";
  const source = job.options?.visualsSource;
  return source === "character" || source === "ai" || source === "ai_video" ? source : null;
}

export function hasDeferredTemplateFunding(job: VideoGeneration): boolean {
  // Guided Story reserves its full immutable scene workload at enqueue rather
  // than using the native-template planning slice. It still defers preview
  // calls until the board exists so each paid image has the same durable
  // prepared → provider_succeeded → complete recovery boundary.
  return Boolean(
    job.engine === "topic_to_video" &&
      (job.options?.guidedStory || job.options?.storyboardFunding != null),
  );
}

export function plannedTemplateUnits(job: VideoGeneration, storyboard: VideoStoryboard): number {
  const options = job.options!;
  const scenes = storyboard.scenes.length;
  const privacyRecoveryUnits = storyboard.scenes.reduce(
    (sum, scene) => sum + (scene.privacyRecovery ? 1 : 0),
    0,
  );
  if (options.hybridStory && storyboard.mode === "hybrid_character_story") {
    return hybridRequiredUnits({
      options,
      beatKinds: storyboard.scenes.map((scene) =>
        scene.beatType === "story_animation" ? "story_animation" : "character_speaking",
      ),
      narrationAccountingMode: storyboard.narration?.event?.accountingMode,
      ignoreFrozen: true,
    }) + privacyRecoveryUnits;
  }
  const visualUnits =
    storyboard.visualsSource === "ai_video" ? scenes * 2 :
      storyboard.visualsSource === "ai" || storyboard.visualsSource === "character" ? scenes : 0;
  const multiplier = videoModelMultiplier(options.modelId);
  const total =
    // Review-added scenes are already in the immutable board's scene count.
    // Deferred funding advances its snapshot at insertion time, so counting
    // options.addedScenes here would charge every inserted scene twice.
    visualUnits * multiplier +
    (!options.musicPath && options.musicPrompt?.trim() ? 1 : 0);
  // Planning is an advance slice of this total, never an extra charge.
  return Math.max(options.storyboardFunding?.planningUnits ?? 1, total + privacyRecoveryUnits);
}

function formatRupees(paise: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.max(0, paise) / 100);
}

/** Fund the immutable template board's visual calls after its one-unit plan. */
export async function fundPlannedTemplateVisualWork(
  job: VideoGeneration,
  storyboard: VideoStoryboard,
): Promise<{ funded: boolean; job: VideoGeneration; error: string | null }> {
  if (!hasDeferredTemplateFunding(job)) return { funded: true, job, error: null };
  const options = job.options!;
  // Guided Story's complete preview + animation workload was reserved from its
  // immutable script at enqueue. Its deferred flag is a checkpointing concern,
  // not a second funding rail.
  if (options.guidedStory) return { funded: true, job, error: null };
  const target = plannedTemplateUnits(job, storyboard);
  // A wallet reserve can commit before its aggregate/job-options write. On a
  // retry, the aggregate is therefore the durable indication of held funds;
  // charging from only the stale planning snapshot would double-reserve.
  let current = Math.max(
    0,
    Math.trunc(options.storyboardFunding?.fundedUnits ?? 1),
    Math.trunc(job.walletReservedUnits ?? 0),
  );
  let missing = Math.max(0, target - current);
  let creditFundedJob: VideoGeneration | null = null;
  let walletShortfall:
    | { requiredPaise: number; balancePaise: number }
    | null = null;
  if (!missing && job.funding !== "wallet") {
    const nextOptions = {
      ...options,
      storyboardFunding: {
        version: 1 as const,
        sceneCount: storyboard.scenes.length,
        requiredUnits: target,
        fundedUnits: current,
        planningUnits: options.storyboardFunding?.planningUnits ?? 1,
      },
    };
    const updated = (await db.update(videoGenerationsTable).set({ options: nextOptions })
      .where(eq(videoGenerationsTable.id, job.id)).returning())[0]!;
    return { funded: true, job: updated, error: null };
  }
  let funded = false;
  if (job.funding === "wallet") {
    const topUp = await reserveVideoJobWalletTopUp(job.id, target);
    current = topUp.heldUnits;
    missing = Math.max(0, target - current);
    funded = topUp.funded;
    if (!funded) {
      walletShortfall = {
        requiredPaise: topUp.requiredPaise,
        balancePaise: topUp.balancePaise,
      };
    }
  } else {
    const tenant = (await db.select({ plan: tenantsTable.plan }).from(tenantsTable)
      .where(eq(tenantsTable.id, job.tenantId)).limit(1))[0];
    const limits = await getPlanLimits(tenant?.plan ?? "free");
    const usage = await getUsage(job.tenantId);
    // Keep the enqueue rail intact. A quota-funded planning slice never
    // silently falls through to credits; a credit-funded slice spends only
    // credits. This avoids a hybrid job whose refund/usage semantics differ
    // from the route's all-quota-or-all-credit decision.
    funded = job.funding === "quota"
      // Quota reservations are represented by the queued/paused job rather
      // than a usage event, so include its already-held planning slice here.
      ? limits.videos === -1 || usage.videos + current + missing <= limits.videos
      : job.funding === "credit"
        ? await db.transaction(async (tx) => {
            // Lock the job and debit in one transaction. Approval has already
            // conditionally claimed the status, but this also protects retries
            // after a process crash between debit and options persistence.
            const locked = (await tx.select().from(videoGenerationsTable)
              .where(eq(videoGenerationsTable.id, job.id)).for("update"))[0];
            if (!locked) return false;
            const lockedOptions = locked.options ?? options;
            const held = Math.max(0, Math.trunc(lockedOptions.storyboardFunding?.fundedUnits ?? 1));
            const lockedMissing = Math.max(0, target - held);
            if (!(await spendCredit(job.tenantId, "video", lockedMissing, tx))) return false;
            const nextOptions = {
              ...lockedOptions,
              storyboardFunding: {
                version: 1 as const,
                sceneCount: storyboard.scenes.length,
                requiredUnits: target,
                fundedUnits: target,
                planningUnits: lockedOptions.storyboardFunding?.planningUnits ?? 1,
              },
            };
            creditFundedJob = (await tx.update(videoGenerationsTable).set({ options: nextOptions })
              .where(eq(videoGenerationsTable.id, job.id)).returning())[0]!;
            return true;
          })
        : false;
  }
  if (!funded) {
    const nextOptions = {
      ...options,
      storyboardFunding: {
        version: 1 as const,
        sceneCount: storyboard.scenes.length,
        requiredUnits: target,
        fundedUnits: current,
        planningUnits: options.storyboardFunding?.planningUnits ?? 1,
      },
    };
    const persisted = (await db.update(videoGenerationsTable).set({ options: nextOptions })
      .where(eq(videoGenerationsTable.id, job.id)).returning())[0]!;
    return {
      funded: false,
      job: persisted,
      error: walletShortfall
        ? `Your storyboard needs ${target} total video units and ${missing} remain unfunded. Your wallet has ${formatRupees(walletShortfall.balancePaise)} available, but ${formatRupees(walletShortfall.requiredPaise)} is needed. Recharge at least ${formatRupees(walletShortfall.requiredPaise - walletShortfall.balancePaise)}, then approve again.`
        : `Your storyboard needs ${target} total video units, but ${missing} units remain unfunded. Add enough video credits or wait for quota to renew, then approve again.`,
    };
  }
  if (creditFundedJob) return { funded: true, job: creditFundedJob, error: null };
  const nextOptions = {
    ...options,
    storyboardFunding: {
      version: 1 as const,
      sceneCount: storyboard.scenes.length,
      requiredUnits: target,
      fundedUnits: target,
      planningUnits: options.storyboardFunding?.planningUnits ?? 1,
    },
  };
  const updated = (await db.update(videoGenerationsTable).set({ options: nextOptions })
    .where(eq(videoGenerationsTable.id, job.id)).returning())[0]!;
  return { funded: true, job: updated, error: null };
}

async function recoverGeneratedStoryboardKeyframe(params: {
  job: VideoGeneration;
  storyboard: VideoStoryboard;
  scene: VideoStoryboardScene;
  aspectRatio: VideoAspect;
  error: OpenRouterInputImagePrivacyError;
}): Promise<{ still: Buffer; event: VideoProviderEvent }> {
  const { job, storyboard, scene, error } = params;
  if (storyboard.mode === "guided_story") {
    throw new VideoJobInputError(
      `Guided Story scene ${scene.id} was rejected while animating its approved cast frame. The approved frame was kept unchanged and no replacement was generated. Start a new Guided Story attempt after adjusting the cast or visual direction.`,
    );
  }
  const preclaimedLegacyRecovery =
    job.options?.recovery?.privacyRecovery?.code === OPENROUTER_INPUT_IMAGE_PRIVACY_CODE &&
    job.options.recovery.privacyRecovery.sceneId === scene.id &&
    scene.privacyRecovery?.status === "pending";
  const generatedStoryScene =
    storyboard.visualsSource === "ai_video" &&
    (storyboard.mode !== "hybrid_character_story" || scene.beatType === "story_animation");
  if (!generatedStoryScene) {
    throw new VideoJobInputError(
      `Scene ${scene.id} uses an identity-backed or user-supplied image. It was not changed automatically. Edit or replace that scene image, then retry.`,
    );
  }
  if (scene.privacyRecovery && !preclaimedLegacyRecovery) {
    throw new VideoJobInputError(
      `Scene ${scene.id} was still rejected after its one privacy-safe recovery. Edit the scene to use an anonymous fictional or more stylized subject, then retry.`,
    );
  }
  if (!hasDeferredTemplateFunding(job)) {
    throw new VideoJobInputError(
      `Scene ${scene.id} needs a new privacy-safe keyframe, but this older job has no safe reservation path for an extra provider operation. Regenerate that scene before retrying.`,
    );
  }

  if (!preclaimedLegacyRecovery) {
    scene.privacyRecovery = {
      code: OPENROUTER_INPUT_IMAGE_PRIVACY_CODE,
      status: "attempting",
      inputIndex: error.inputIndex,
      originalPreviewPath: scene.previewPath,
    };
    // Claim the one allowed attempt before funding/provider work. If the process
    // dies after this write, a restart fails closed instead of calling again.
    await setJob(job.id, { storyboard });

    const funded = await fundPlannedTemplateVisualWork(job, storyboard);
    if (!funded.funded) {
      throw new VideoJobInputError(
        funded.error ??
          `Scene ${scene.id} could not reserve the additional unit needed for privacy-safe recovery.`,
      );
    }
    // Success/refund paths later in this execution must use the increased held
    // unit count and current wallet aggregate returned by the funding rail.
    Object.assign(job, funded.job);
  } else {
    // The route's pending marker means funding was reserved but no provider
    // call began. Flip it before the call so a worker restart fails closed
    // rather than purchasing a second replacement image.
    scene.privacyRecovery!.status = "attempting";
    await setJob(job.id, { storyboard });
  }
  const recovery = scene.privacyRecovery;
  if (!recovery) {
    throw new VideoJobInputError(`Scene ${scene.id} has no durable privacy-recovery claim.`);
  }

  const recoveryPrompt = privacySafeGeneratedVisualPrompt(scene.visual, true);
  const generated = await generateBrollStills({
    prompts: [recoveryPrompt],
    aspectRatio: params.aspectRatio,
  });
  const result = generated.results[0]!;
  const event: VideoProviderEvent = {
    eventId: videoProviderEventId(job, `privacy_keyframe:${scene.id}`),
    provider: result.provider,
    model: result.model,
    durationSec: null,
    requestBytes: Buffer.byteLength(recoveryPrompt),
    label: `privacy_keyframe:${scene.id}`,
    costPaise: await computeImageCostPaise({
      provider: result.provider,
      model: result.model,
      inputTokens: result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
    }).catch(() => null),
    unitWeight: 1,
  };
  const retainedEvents = previewCheckpointEvents(scene.previewCheckpoint);
  recovery.status = "provider_succeeded";
  scene.previewCheckpoint = {
    targetPath: "",
    status: "provider_succeeded",
    selectedEventId: event.eventId,
    events: [...retainedEvents, event],
  };
  // A successful provider call is a billable receipt even if the following
  // object upload fails, so persist it before touching storage.
  await setJob(job.id, { storyboard });

  scene.previewPath = await uploadToStorage(job.tenantId, result.buffer, "image/png");
  scene.previewCheckpoint = {
    ...scene.previewCheckpoint,
    targetPath: scene.previewPath,
    status: "complete",
  };
  recovery.status = "complete";
  await setJob(job.id, { storyboard });
  return { still: result.buffer, event };
}

export function allowsGeneratedStoryboardPrivacyRecovery(
  storyboard: Pick<VideoStoryboard, "mode" | "visualsSource">,
): boolean {
  // A Guided Story preview is the exact cast/outfit frame the user approved.
  // Replacing it after approval would bypass identity checks and spend work that
  // was not part of the immutable attempt's reservation.
  return storyboard.visualsSource === "ai_video" &&
    storyboard.mode !== "guided_story";
}

async function loadTenantObject(
  objectPath: string,
  tenantId: number,
  maxBytes: number,
  label: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  let file;
  try {
    file = await objectStorageService.getObjectEntityFile(objectPath, tenantId);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      throw new VideoJobInputError(`${label} not found.`);
    }
    throw err;
  }
  const [metadata] = await file.getMetadata();
  const size = Number(metadata.size ?? 0);
  if (size > maxBytes) {
    throw new VideoJobInputError(
      `${label} is too large (max ${Math.round(maxBytes / (1024 * 1024))} MB).`,
    );
  }
  const rawType = String(metadata.contentType ?? "").toLowerCase().split(";")[0].trim();
  const mimeType = rawType === "image/jpg" ? "image/jpeg" : rawType;
  const [buffer] = await file.download();
  return { buffer, mimeType };
}

async function loadSourceImage(
  objectPath: string,
  tenantId: number,
): Promise<SourceImage> {
  const { buffer, mimeType } = await loadTenantObject(
    objectPath,
    tenantId,
    MAX_SOURCE_IMAGE_BYTES,
    "Source image",
  );
  if (!ALLOWED_IMAGE_TYPES.has(mimeType)) {
    throw new VideoJobInputError(
      "Unsupported source image type. Please use PNG, JPEG, or WebP images.",
    );
  }
  return { buffer, mimeType };
}

/**
 * Canonical backdrops are immutable provider inputs: validate their retained
 * bytes immediately before any final pipeline can call a provider. Legacy
 * plates predate byte receipts and intentionally retain metadata-only support.
 * Final animation still uses the already-approved scene preview as its
 * image-to-video input; the plate is bound while that preview is made.
 */
async function verifyGuidedBackdropBytesBeforeRender(
  snapshot: NonNullable<VideoJobOptions["guidedStory"]>,
  tenantId: number,
): Promise<void> {
  if (!snapshot.backdrops) return;
  const seen = new Set<string>();
  for (const scene of snapshot.script.scenes) {
    const effective = effectiveGuidedBackdrop(snapshot, scene.id);
    const reference = effective?.reference;
    if (!reference?.imageSha256 || seen.has(reference.imagePath)) continue;
    seen.add(reference.imagePath);
    const { buffer } = await loadTenantObject(
      reference.imagePath,
      tenantId,
      MAX_SOURCE_IMAGE_BYTES,
      `Approved ${effective!.source} backdrop`,
    );
    const actual = createHash("sha256").update(buffer).digest("hex");
    if (actual !== reference.imageSha256) {
      throw new VideoJobInputError(
        `Guided Story ${effective!.source} backdrop bytes no longer match their approval.`,
      );
    }
  }
}

/** PUT bytes to a fresh presigned upload URL and return the /objects/... path. */
async function uploadToStorage(
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
    throw new Error(`Video upload failed with status ${putRes.status}`);
  }
  return objectStorageService.normalizeObjectEntityPath(uploadURL);
}

async function uploadToPreparedStorage(uploadURL: string, bytes: Buffer, contentType: string): Promise<void> {
  const putRes = await fetch(uploadURL, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: new Uint8Array(bytes),
    signal: AbortSignal.timeout(120_000),
  });
  if (!putRes.ok) {
    const error = new Error(`Video upload failed with status ${putRes.status}`);
    Object.assign(error, { status: putRes.status });
    throw error;
  }
}

/**
 * Prepared URLs can expire while a large storyboard waits on slow providers.
 * The provider result is still in memory, so renew only the storage target and
 * upload the same selected bytes rather than repeating paid generation.
 */
export async function uploadToPreparedOrFreshStorage(
  tenantId: number,
  preparedURL: string,
  bytes: Buffer,
  contentType: string,
): Promise<string> {
  try {
    await uploadToPreparedStorage(preparedURL, bytes, contentType);
    return objectStorageService.normalizeObjectEntityPath(preparedURL);
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (status !== 400 && status !== 403) throw err;
    const freshURL = await objectStorageService.getObjectEntityUploadURL(tenantId);
    await uploadToPreparedStorage(freshURL, bytes, contentType);
    return objectStorageService.normalizeObjectEntityPath(freshURL);
  }
}

async function objectExists(objectPath: string, tenantId: number): Promise<boolean> {
  try {
    const file = await objectStorageService.getObjectEntityFile(objectPath, tenantId);
    await file.getMetadata();
    return true;
  } catch (err) {
    if (err instanceof ObjectNotFoundError) return false;
    throw err;
  }
}

async function setJob(
  jobId: number,
  values: Partial<typeof videoGenerationsTable.$inferInsert>,
): Promise<void> {
  await db
    .update(videoGenerationsTable)
    .set(values)
    .where(eq(videoGenerationsTable.id, jobId));
}

/** Never persist arbitrary provider payloads/tokens in the customer-visible audit. */
function safeVideoErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof VideoGenNotConfiguredError) {
    // This class is created only from application-authored configuration
    // checks, never from arbitrary provider response bodies.
    return error.message;
  }
  if (
    error instanceof OpenRouterInputImagePrivacyError ||
    (error as { code?: unknown } | null)?.code === OPENROUTER_INPUT_IMAGE_PRIVACY_CODE
  ) {
    const inputIndex = error instanceof OpenRouterInputImagePrivacyError
      ? error.inputIndex
      : null;
    return `OpenRouter rejected${inputIndex == null ? " an input image" : ` input image ${inputIndex}`} because it may depict an identifiable real person. Use a fictional or more stylized generated scene, or choose a different image.`;
  }
  // Provider messages routinely contain request bodies, signed URLs and
  // echoed prompts. Customer-visible history is deliberately allow-list-only.
  return fallback;
}

function normalizedRequestId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{3,127}$/.test(trimmed) ? trimmed : null;
}

function providerRequestIdFromError(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const record = current as Record<string, unknown>;
    const value = record.requestId ?? record.request_id ?? record.traceId ??
      (record.response as Record<string, unknown> | undefined)?.requestId;
    const normalized = normalizedRequestId(value);
    if (normalized) return normalized;
    current = record.cause;
  }
  // Some provider SDKs preserve request ids only in the (otherwise safe)
  // message. Keep just that correlation token, never the raw provider body.
  const text = error instanceof Error ? error.message : "";
  return normalizedRequestId(
    text.match(/\b(?:request[_ -]?id|x-request-id|trace[_ -]?id)\s*[:=]\s*([A-Za-z0-9._-]{4,128})/i)?.[1],
  );
}

function safeFailureCode(error: unknown): string | null {
  if (error instanceof VideoModelResolutionError) {
    return error.code;
  }
  if (
    (error as { code?: unknown } | null)?.code ===
    OPENROUTER_INPUT_IMAGE_PRIVACY_CODE
  ) {
    return OPENROUTER_INPUT_IMAGE_PRIVACY_CODE;
  }
  if (error instanceof VideoGenNotConfiguredError) {
    return "provider_not_configured";
  }
  const status =
    error instanceof VideoGenProviderError ||
    error instanceof ImageGenProviderError
      ? error.status
      : undefined;
  if (status === 408 || status === 429 || (status != null && status >= 500)) {
    return "provider_transient_error";
  }
  if (status != null && status >= 400 && status < 500) {
    return "provider_rejected";
  }
  return "provider_error";
}

function safeProviderIdentifier(
  value: unknown,
  maxLength: number,
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return new RegExp(`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,${maxLength - 1}}$`).test(
    trimmed,
  )
    ? trimmed
    : null;
}

function failureAttempt(
  history: VideoGenerationErrorHistoryEntry[] | null | undefined,
  params: {
    scope: "scene" | "job";
    sceneId: string | null;
    operation: string;
    outcome: VideoGenerationErrorHistoryEntry["outcome"];
    error: unknown;
  },
): number {
  const relevant = (history ?? []).filter((entry) =>
    entry.scope === params.scope &&
    entry.sceneId === params.sceneId &&
    entry.operation === params.operation &&
    entry.outcome === params.outcome
  );
  const requestId = providerRequestIdFromError(params.error);
  const code = safeFailureCode(params.error);
  if (requestId) {
    const replay = relevant.find((entry) =>
      entry.providerRequestId === requestId && entry.code === code
    );
    if (replay) return replay.attempt;
  }
  return relevant.reduce((max, entry) => Math.max(max, entry.attempt), 0) + 1;
}

function appendFailureHistory(
  existing: VideoGenerationErrorHistoryEntry[] | null | undefined,
  entry: VideoGenerationErrorHistoryEntry,
): VideoGenerationErrorHistoryEntry[] {
  // A process can re-enter finalization after a persistence retry.  Do not
  // duplicate the same durable failure fingerprint.
  const history = existing ?? [];
  return history.some((item) => item.fingerprint === entry.fingerprint)
    ? history
    : [...history, entry];
}

function failureEntry(params: {
  job: VideoGeneration; scope: "scene" | "job"; scene?: VideoStoryboardScene | null;
  operation: string; error: unknown; outcome: VideoGenerationErrorHistoryEntry["outcome"];
  provider?: string | null; model?: string | null; attempt?: number;
}): VideoGenerationErrorHistoryEntry {
  const scene = params.scene ?? null;
  const attempt = params.attempt ?? 1;
  const recoveryAttempt = scene?.privacyRecovery ? 1 : 0;
  const notAttempted = params.outcome === "not_attempted";
  const code = notAttempted ? null : safeFailureCode(params.error);
  const requestId = notAttempted
    ? null
    : providerRequestIdFromError(params.error);
  const errorRecord =
    params.error && typeof params.error === "object"
      ? (params.error as Record<string, unknown>)
      : null;
  const provider =
    notAttempted
      ? null
      : safeProviderIdentifier(
          params.provider ?? errorRecord?.provider,
          64,
        );
  const model =
    notAttempted
      ? null
      : safeProviderIdentifier(params.model ?? errorRecord?.model, 128);
  const fingerprint = [
    params.job.id, params.scope, scene?.id ?? "job", params.operation,
    attempt, recoveryAttempt, params.outcome, code ?? "", requestId ?? "",
  ].join(":");
  return {
    jobId: params.job.id, jobNumber: params.job.id, scope: params.scope,
    sceneId: scene?.id ?? null,
    sceneNumber: scene ? (params.job.storyboard?.scenes.findIndex((item) => item.id === scene.id) ?? -1) + 1 : null,
    displayNumber: scene ? (params.job.storyboard?.scenes.findIndex((item) => item.id === scene.id) ?? -1) + 1 : null,
    operation: params.operation, provider, model,
    providerRequestId: requestId, code,
    message: notAttempted
      ? `Not attempted because an earlier scene stopped Job #${params.job.id}.`
      : safeVideoErrorMessage(
          params.error,
          "Video generation failed. Please try again.",
        ),
    occurredAt: new Date().toISOString(), attempt, recoveryAttempt, outcome: params.outcome, fingerprint,
  };
}

async function recordSceneFailure(job: VideoGeneration, scene: VideoStoryboardScene, operation: string, error: unknown, provider?: string | null, model?: string | null): Promise<void> {
  const latest = (await db.select({ errorHistory: videoGenerationsTable.errorHistory })
    .from(videoGenerationsTable).where(eq(videoGenerationsTable.id, job.id)).limit(1))[0];
  const attempt = failureAttempt(latest?.errorHistory, {
    scope: "scene", sceneId: scene.id, operation, outcome: "stopped", error,
  });
  const entry = failureEntry({ job, scope: "scene", scene, operation, error, provider, model, outcome: "stopped", attempt });
  await setJob(job.id, { errorHistory: appendFailureHistory(latest?.errorHistory, entry), providerRequestId: entry.providerRequestId });
}

async function recordPreviewFailureBoundary(
  job: VideoGeneration,
  scenes: VideoStoryboardScene[],
  sceneIndex: number,
  error: unknown,
  operation = "storyboard_preview",
): Promise<void> {
  const latest = (await db.select({ errorHistory: videoGenerationsTable.errorHistory })
    .from(videoGenerationsTable).where(eq(videoGenerationsTable.id, job.id)).limit(1))[0];
  const boardJob = {
    ...job,
    storyboard: {
      version: 1, visualsSource: "ai", timelineLocked: false, model: null,
      provider: null, regenerations: 0, narration: null, scenes,
    } as VideoStoryboard,
  };
  const scene = scenes[sceneIndex]!;
  const attempt = failureAttempt(latest?.errorHistory, {
    scope: "scene", sceneId: scene.id, operation, outcome: "stopped", error,
  });
  let history = appendFailureHistory(latest?.errorHistory, failureEntry({
    job: boardJob, scope: "scene", scene, operation, error, outcome: "stopped", attempt,
  }));
  for (const untouched of scenes.slice(sceneIndex + 1)) {
    history = appendFailureHistory(history, failureEntry({
      job: boardJob, scope: "scene", scene: untouched, operation,
      error, outcome: "not_attempted", attempt,
    }));
  }
  await setJob(job.id, {
    errorHistory: history,
    providerRequestId: providerRequestIdFromError(error),
  });
}

/** Bill one cloned localized-dub cue behind its own durable receipt. */
async function speakLocalizedBrandVoiceCue(args: {
  tenantId: number;
  jobId: number;
  cueIndex: number;
  voice: ClonedVoiceRef;
  text: string;
  modelId?: "eleven_multilingual_v2" | "eleven_v3";
  languageCode?: string;
}): Promise<Buffer> {
  const modelId = args.modelId ?? "eleven_multilingual_v2";
  // Do this before balance checks or reservations. A capability mismatch is
  // user-correctable and must never create a wallet operation.
  const elevenLabsLanguage = args.voice.provider === "elevenlabs"
    ? resolveElevenLabsSpeechLanguage(modelId, args.languageCode)
    : { modelId, languageCode: args.languageCode };
  const walletFunded = await isWalletFunded(args.tenantId);
  const rateSnapshot =
    args.voice.provider === "elevenlabs"
      ? (await getAiCostConfig()).elevenLabsInrPerCredit
      : null;
  if (walletFunded && !rateSnapshot) {
    throw new VideoGenNotConfiguredError(
      "ElevenLabs credit billing is not configured. Ask an administrator to set the ₹-per-credit rate before retrying.",
    );
  }
  if (!walletFunded) {
    return (
      await speakWithClonedVoiceReceipt(
        args.voice,
        args.text,
        undefined,
        elevenLabsLanguage.modelId,
        elevenLabsLanguage.languageCode,
      )
    ).audio;
  }
  const ceilingPaise = elevenLabsCreditsToPaise(
    elevenLabsCreditReservationCeiling(args.text),
    rateSnapshot!,
  );
  if (ceilingPaise === null || ceilingPaise <= 0) {
    throw new VideoGenNotConfiguredError(
      "ElevenLabs credit billing is not configured. Ask an administrator to set the ₹-per-credit rate before retrying.",
    );
  }
  const reservation = await reserveWallet(
    args.tenantId,
    "caption",
    { provider: args.voice.provider, model: modelId },
    1,
    ceilingPaise,
  );
  if (!reservation) {
    throw new VideoGenProviderError("The wallet does not have enough balance for cloned narration.");
  }
  let providerCostPaise: number | null = null;
  try {
    const operation = await executeWalletProviderOperation(
      {
        tenantId: args.tenantId,
        reservation,
        operationKind: "brand_voice_tts",
        operationKey: buildBrandVoiceTtsOperationKey(
          args.voice.voiceId,
          elevenLabsLanguage.modelId,
          args.text,
          { jobId: args.jobId, cueIndex: args.cueIndex },
          args.languageCode,
        ),
        settlement: {
          kind: "caption",
          costPaise: ceilingPaise,
          provider: args.voice.provider,
          model: modelId,
          refKind: "videoJob",
          refId: `${args.jobId}:${args.cueIndex}`,
        },
      },
      async (confirmSuccess, recordReceipt) =>
        speakWithClonedVoiceReceipt(args.voice, args.text, async (receipt) => {
          await recordReceipt({
            provider: args.voice.provider,
            model: modelId,
            providerCredits: receipt.providerCredits,
            providerRequestId: receipt.requestId ?? receipt.traceId,
            providerResultId: receipt.requestId ?? receipt.traceId,
          });
          if (!receipt.providerCredits) return;
          providerCostPaise = elevenLabsCreditsToPaise(receipt.providerCredits, rateSnapshot!);
          if (providerCostPaise === null) return;
          await confirmSuccess({
            provider: args.voice.provider,
            model: modelId,
            costPaise: providerCostPaise,
            providerCredits: receipt.providerCredits,
            providerRequestId: receipt.requestId ?? receipt.traceId,
            providerResultId: receipt.requestId ?? receipt.traceId,
          });
        }, elevenLabsLanguage.modelId, elevenLabsLanguage.languageCode),
      () => ({}),
      {
        isFailureConfirmed: isConfirmedVoiceCloneFailure,
        // A response without credits is acknowledged work, but its exact
        // price is unknown: leave it pending for recovery, never refund it.
        requireExplicitSuccessConfirmation: true,
      },
    );
    if (operation.confirmed) {
      await settleWalletProviderOperationDurably(operation.operationId).catch((error) =>
        logger.error(
          { err: error, operationId: operation.operationId },
          "Localized Brand Voice settlement failed after provider success",
        ),
      );
    }
    void recordUsage(args.tenantId, "caption", {
      funding: "wallet",
      provider: args.voice.provider,
      model: modelId,
      inputCharacters: args.text.length,
      ...(providerCostPaise !== null ? { costPaise: providerCostPaise } : {}),
    }).catch(() => {});
    return operation.value.audio;
  } catch (error) {
    // A downstream compositor failure happens after this helper returns and
    // never reaches here; only a confirmed provider rejection can refund.
    if (isConfirmedVoiceCloneFailure(error)) {
      await refundWallet(args.tenantId, reservation, "Localized Brand Voice provider call failed").catch(
        () => {},
      );
    }
    throw error;
  }
}

/** The video's music bed: an uploaded track wins; otherwise an AI-composed
 * bed when a musicPrompt was given (already funded as +1 unit). */
async function resolveMusic(
  job: VideoGeneration,
  options: NonNullable<VideoGeneration["options"]>,
  approxDurationSec: number,
  onStage: (stage: string) => void,
): Promise<Buffer | null> {
  if (options.musicPath) {
    return (
      await loadTenantObject(options.musicPath, job.tenantId, MAX_MUSIC_BYTES, "Music track")
    ).buffer;
  }
  if (options.musicCheckpoint?.path) {
    return (
      await loadTenantObject(options.musicCheckpoint.path, job.tenantId, MAX_MUSIC_BYTES, "Saved music track")
    ).buffer;
  }
  if (options.musicPrompt?.trim()) {
    onStage("Composing the music");
    const durationSec = musicGenDurationSec(approxDurationSec);
    const criteria = videoPriceCriteria({});
    await requirePricedVideoCall("replicate", MUSICGEN_MODEL, durationSec, criteria);
    const music = await generateMusicBed(options.musicPrompt, approxDurationSec);
    const event: VideoProviderEvent = {
      eventId: videoProviderEventId(job, "music"),
      provider: "replicate",
      model: MUSICGEN_MODEL,
      durationSec,
      requestBytes: Buffer.byteLength(options.musicPrompt),
      label: "music",
      unitWeight: hasDeferredTemplateFunding(job) ? 1 : undefined,
      criteria,
      costPaise: await computeVideoCostPaise({
        provider: "replicate",
        model: MUSICGEN_MODEL,
        durationSec,
        variantCriteria: criteria,
      }).catch(() => null),
    };
    const saved = structuredClone(options);
    saved.musicCheckpoint = {
      path: "",
      provider: event.provider,
      model: event.model,
      durationSec,
      event,
    };
    await db.update(videoGenerationsTable).set({ options: saved }).where(eq(videoGenerationsTable.id, job.id));
    const path = await uploadToStorage(job.tenantId, music, "audio/mpeg");
    saved.musicCheckpoint.path = path;
    await db.update(videoGenerationsTable).set({ options: saved }).where(eq(videoGenerationsTable.id, job.id));
    return music;
  }
  return null;
}

/** Write paid provider output before downstream ffmpeg/QA/final upload work. */
async function checkpointProviderRender(
  job: VideoGeneration,
  result: { buffer: Buffer; provider: string; model: string },
  label: string,
  durationSec: number,
  criteria = jobVideoPriceCriteria(
    job,
    job.engine === "lip_sync" || job.engine === "dialogue_lip_sync",
  ),
): Promise<VideoProviderEvent> {
  const event: VideoProviderEvent = {
    eventId: videoProviderEventId(job, label),
    provider: result.provider,
    model: result.model,
    durationSec,
    requestBytes: job.prompt ? Buffer.byteLength(job.prompt) : 0,
    label,
    criteria,
    costPaise: await computeVideoCostPaise({
      provider: result.provider,
      model: result.model,
      durationSec,
      variantCriteria: criteria,
    }).catch(() => null),
  };
  const latest = (
    await db.select({ options: videoGenerationsTable.options })
      .from(videoGenerationsTable)
      .where(eq(videoGenerationsTable.id, job.id))
      .limit(1)
  )[0];
  const options = structuredClone(latest?.options ?? job.options ?? { aspectRatio: "9:16" as const });
  options.renderCheckpoint = {
    stage: "provider_raw",
    path: "",
    provider: result.provider,
    model: result.model,
    durationSec: 0,
    providerEvents: [event],
  };
  await db.update(videoGenerationsTable).set({ options }).where(eq(videoGenerationsTable.id, job.id));
  const path = await uploadToStorage(job.tenantId, result.buffer, "video/mp4");
  options.renderCheckpoint.path = path;
  await db.update(videoGenerationsTable).set({ options }).where(eq(videoGenerationsTable.id, job.id));
  return event;
}

type ProduceResult =
  | { paused: true; storyboard: VideoStoryboard; fundingError?: string | null }
  | {
      paused?: false;
      buffer: Buffer;
      provider: string | null;
      model: string | null;
      qa: VideoQaExpectations;
      /** Only populated for localized_dub jobs; null otherwise. */
      localizedResult?: LocalizedDubResult | null;
      providerEvents?: VideoProviderEvent[];
    };

/** Render a non-topic plan: resolve its music bed against the length the plan
 * actually promises, then hand it to the clip renderer. */
async function renderApprovedClipStoryboard(
  job: VideoGeneration,
  options: NonNullable<VideoGeneration["options"]>,
  storyboard: VideoStoryboard,
  aspectRatio: NonNullable<VideoJobAspect>,
  onStage: (stage: string) => void,
): Promise<ProduceResult> {
  const sceneEvents: VideoProviderEvent[] = storyboard.scenes.flatMap((scene) =>
    scene.providerCheckpoint?.event ? [scene.providerCheckpoint.event] : [],
  );
  // Post-approval art-direction pass ("prompt" plans only): the second governed
  // prompt (video_scene_image) polishes the approved shot texts into final
  // generation prompts. Persisted before rendering, so a retry of this approved
  // plan renders from the SAME prompts instead of re-polishing differently.
  if (storyboard.visualsSource === "prompt") {
    onStage("Polishing your shot prompts");
    if (await polishStoryboardPrompts(job.tenantId, storyboard)) {
      await db
        .update(videoGenerationsTable)
        .set({ storyboard })
        .where(eq(videoGenerationsTable.id, job.id));
    }
  }
  const music = await resolveMusic(
    job,
    options,
    Math.max(1, Math.round(clipStoryboardTotalSec(storyboard))),
    onStage,
  );
  let result: Awaited<ReturnType<typeof renderClipStoryboard>>;
  try {
    result = await renderClipStoryboard({
    job,
    storyboard,
    aspectRatio,
    music,
    // Previews are tenant objects, so they go through the same size and type
    // validation as a freshly uploaded source image.
    load: (objectPath) => loadSourceImage(objectPath, job.tenantId),
    onStage,
    onCheckpoint: async ({ sceneIndex, buffer, provider, model, durationSec }) => {
      const scene = storyboard.scenes[sceneIndex]!;
      const event: VideoProviderEvent = {
        eventId: videoProviderEventId(job, `storyboard_scene:${scene.id}`),
        provider,
        model,
        durationSec,
        requestBytes: Buffer.byteLength(scene.renderVisual ?? scene.visual),
        label: `storyboard_scene:${scene.id}`,
        criteria: jobVideoPriceCriteria(job),
        costPaise: await computeVideoCostPaise({
          provider,
          model,
          durationSec,
          variantCriteria: jobVideoPriceCriteria(job),
        }).catch(() => null),
      };
      const path = await uploadToStorage(job.tenantId, buffer, "video/mp4");
      scene.providerCheckpoint = { path, provider, model, durationSec, event };
      sceneEvents.push(event);
      await db.update(videoGenerationsTable).set({ storyboard }).where(eq(videoGenerationsTable.id, job.id));
    },
    });
  } catch (error) {
    const failedScene = storyboard.scenes.find(
      (scene) => !scene.providerCheckpoint?.path,
    );
    if (failedScene) {
      await recordSceneFailure(
        job,
        failedScene,
        storyboard.visualsSource === "photo"
          ? "image_to_video_animation"
          : "scene_render",
        error,
      );
    }
    throw error;
  }
  return {
    buffer: result.buffer,
    provider: result.provider,
    model: result.model,
    qa:
      storyboard.visualsSource === "slide"
        ? { expectedDurationSec: result.totalSec, label: "slideshow" }
        : // Clip lengths are held per shot but fail-soft, so the join can drift
          // further than the QA gate's tolerance; only emptiness is a failure.
          { minDurationSec: 0.5, label: "storyboard video" },
    providerEvents: sceneEvents,
  };
}

type VideoJobAspect = NonNullable<VideoGeneration["options"]>["aspectRatio"];

/** Extract an exact cue-aligned section of the single persisted narration WAV. */
function hybridNarrationSlice(wav: Buffer, startSec: number, endSec: number): Buffer {
  const parsed = parseWav(wav);
  const align = parsed.format.blockAlign;
  const start = Math.floor((startSec * parsed.format.byteRate) / align) * align;
  const end = Math.ceil((endSec * parsed.format.byteRate) / align) * align;
  return buildWav(parsed.format, parsed.pcm.subarray(start, Math.min(end, parsed.pcm.length)));
}

function hybridCueRanges(board: VideoStoryboard): Array<{ start: number; end: number }> {
  const cues = board.narration?.cues ?? [];
  let cursor = 0;
  return board.scenes.map((scene) => {
    const count = splitIntoSentences(scene.text).length;
    if (!count || cursor + count > cues.length) {
      throw new VideoJobInputError("Hybrid storyboard narration no longer covers every beat.");
    }
    const start = cursor;
    cursor += count;
    return { start, end: cursor };
  }).map((range, index, ranges) => {
    if (index === ranges.length - 1 && cursor !== cues.length) {
      throw new VideoJobInputError("Hybrid storyboard narration has unassigned cues.");
    }
    return range;
  });
}

/**
 * Keep immutable dialogue slots intact without asking a provider to reread or
 * rewrite approved text.  The localized-dub fit contract permits at most 8%
 * acceleration, then appends silence; a remaining overrun is terminal.
 */
async function fitGuidedReplayWavToSlot(wav: Buffer, targetMs: number): Promise<Buffer> {
  const actualMs = Math.round((await probeNarrationWavDurationSec(wav)) * 1000);
  const fit = planAudioFit(actualMs, targetMs);
  if (fit.overrunMs > 0) {
    throw new VideoGenProviderError(
      `Guided Story dialogue exceeds its frozen slot by ${fit.overrunMs}ms after the maximum audio fit.`,
    );
  }
  const dir = await mkdtemp(join(tmpdir(), "kokao-guided-dialogue-fit-"));
  try {
    await writeFile(join(dir, "source.wav"), wav);
    const filters = [
      ...(fit.tempo === 1 ? [] : [`atempo=${fit.tempo}`]),
      `apad=pad_dur=${(fit.padMs / 1000).toFixed(3)}`,
    ];
    await runFfmpeg([
      "-y", "-i", "source.wav", "-af", filters.join(","),
      "-t", (targetMs / 1000).toFixed(3), "-c:a", "pcm_s16le", "fitted.wav",
    ], dir);
    const fittedMs = Math.round((await probeDurationSec("fitted.wav", dir) ?? 0) * 1000);
    if (!fittedMs || Math.abs(fittedMs - targetMs) > 100) {
      throw new VideoGenProviderError("Guided Story dialogue audio could not be fitted to its frozen slot.");
    }
    return await readLocalFile(join(dir, "fitted.wav"));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function produceVideo(
  job: VideoGeneration,
  onStage: (stage: string) => void,
): Promise<ProduceResult> {
  const options = job.options ?? { aspectRatio: "9:16" as const };
  const aspectRatio = options.aspectRatio ?? "9:16";
  // The model-shaped half of the options, resolved once: which catalog model
  // (if any), the duration snapped to a length it renders, and the
  // resolution / quality / audio flags it understands. With no picked model
  // every field is a pass-through and the job behaves exactly as before.
  const model = resolveModelOptions(options, 5);
  const raw = options.renderCheckpoint;
  if (
    raw?.stage === "provider_raw" &&
    raw.path &&
    (job.engine === "text_to_video" ||
      job.engine === "image_to_video" ||
      job.engine === "dialogue_lip_sync" ||
      job.engine === "lip_sync")
  ) {
    const source = (
      await loadTenantObject(raw.path, job.tenantId, MAX_SOURCE_VIDEO_BYTES, "Saved provider render")
    ).buffer;
    const directLipSync = job.engine === "dialogue_lip_sync" || job.engine === "lip_sync";
    const music = directLipSync
      ? null
      : await resolveMusic(job, options, options.durationSec ?? 5, onStage);
    const normalized = directLipSync
      ? source
      : await normalizeVideo(source, aspectRatio, model.resolution);
    return {
      buffer: music ? await mixMusicIntoVideo(normalized, music) : normalized,
      provider: raw.provider,
      model: raw.model,
      providerEvents: [],
      qa: { minDurationSec: 0.5, label: "resumed provider render" },
    };
  }

  // Storyboards for the three engines that are not topic mode. All three share
  // one plan-and-pause path, so it sits ahead of the engine branches rather than
  // being repeated inside each of them.
  const clipSource = job.engine === "topic_to_video" ? null : clipStoryboardSource(job);
  if (clipSource) {
    // A plan already on the row means this run is the resume: render what was
    // approved instead of planning again.
    if (job.storyboard) {
      return renderApprovedClipStoryboard(job, options, job.storyboard, aspectRatio, onStage);
    }
    if (options.reviewStoryboard) {
      const storyboard = await planClipStoryboard({
        job,
        source: clipSource,
        aspectRatio,
        upload: (bytes, contentType) => uploadToStorage(job.tenantId, bytes, contentType),
        onStage,
      });
      return { paused: true, storyboard };
    }
    // Review declined, but the job was funded for several shots. Plan in memory
    // and render it in one pass so the user still gets the shots they paid for.
    if (job.engine === "text_to_video" && clipShotCount(options.shotCount) > 1) {
      const storyboard = await planClipStoryboard({
        job,
        source: clipSource,
        aspectRatio,
        upload: (bytes, contentType) => uploadToStorage(job.tenantId, bytes, contentType),
        onStage,
      });
      // Planning can itself create durable preview/keyframe assets. Commit the
      // complete plan before music resolution or the first paid scene render,
      // so a crash in that gap resumes this exact board instead of planning and
      // generating its assets a second time.
      await setJob(job.id, { storyboard });
      return renderApprovedClipStoryboard(job, options, storyboard, aspectRatio, onStage);
    }
  }

  if (job.engine === "text_to_video") {
    // Optional music bed (upload / library / AI compose), mixed under the
    // clip after rendering. Resolved up front so a missing uploaded track
    // fails before any provider spend.
    const music = await resolveMusic(job, options, options.durationSec ?? 5, onStage);
    const withMusic = async (buf: Buffer) => (music ? mixMusicIntoVideo(buf, music) : buf);
    // With a character picked, the clip is identity-anchored: keyframe edit
    // of the locked outfit's reference, then image-to-video.
    if (options.characterId) {
      onStage("Filming your character");
      const result = await generateCharacterClip({
        tenantId: job.tenantId,
        characterId: options.characterId,
        outfitId: options.outfitId ?? null,
        wardrobeSnapshot: options.characterSnapshot,
        prompt: job.prompt ?? "",
        aspectRatio,
        durationSec: model.durationSec,
        motionPreset: options.motionPreset ?? null,
        cinematography: options.cinematography ?? null,
        seed: options.seed ?? null,
        model,
      });
      const event = await checkpointProviderRender(
        job, result, "text_to_video", result.effectiveDurationSec ?? model.durationSec,
      );
      return {
        // Providers routinely ignore the requested aspect/resolution;
        // normalize (fail-soft) so the delivered file matches the request.
        buffer: await withMusic(
          await normalizeVideo(result.buffer, aspectRatio, model.resolution),
        ),
        provider: result.provider,
        model: result.model,
        providerEvents: [event],
        qa: { minDurationSec: 0.5, label: "character clip" },
      };
    }
    onStage("Generating the video");
    // A named camera move is appended to the brief rather than replacing
    // anything: an unpicked job sends exactly the prompt it always did.
    const motionClause = motionPresetClause(options.motionPreset, options.cinematography);
    const brief = job.prompt ?? "";
    const result = await generateVideo({
      mode: "text",
      prompt: motionClause ? `${brief}\n\n${motionClause}` : brief,
      aspectRatio,
      seed: options.seed ?? null,
      ...model,
    });
    const event = await checkpointProviderRender(
      job, result, "text_to_video", result.effectiveDurationSec ?? model.durationSec,
    );
    return {
      buffer: await withMusic(
        await normalizeVideo(result.buffer, aspectRatio, model.resolution),
      ),
      provider: result.provider,
      model: result.model,
      providerEvents: [event],
      qa: { minDurationSec: 0.5, label: "text-to-video clip" },
    };
  }

  if (job.engine === "image_to_video") {
    const sourcePath = job.sourceImagePaths?.[0];
    if (!sourcePath) throw new VideoJobInputError("No source image provided.");
    const music = await resolveMusic(job, options, options.durationSec ?? 5, onStage);
    // Pad (never crop) the photo into the requested frame first, so the model
    // composes for that shape and the subject's face survives intact.
    const image = await fitImageToAspect(
      await loadSourceImage(sourcePath, job.tenantId),
      aspectRatio,
    );
    // A second photo is the END frame on models that interpolate: "start
    // here, end there". The route already refused the combination when the
    // picked model cannot do it, so reaching here means it can.
    const endPath = job.sourceImagePaths?.[1];
    const endImage =
      endPath && options.resolvedVideoModel?.supportsEndFrame === true
        ? await fitImageToAspect(await loadSourceImage(endPath, job.tenantId), aspectRatio)
        : undefined;
    onStage("Animating your image");
    // The motion hint is optional here, so a preset stands on its own when the
    // user typed nothing — which is the common case for "animate this photo".
    const hint = job.prompt?.trim() ?? "";
    const motionClause = motionPresetClause(options.motionPreset, options.cinematography);
    const result = await generateVideo({
      mode: "image",
      prompt: [hint, motionClause].filter(Boolean).join(" "),
      aspectRatio,
      seed: options.seed ?? null,
      image,
      ...(endImage ? { endImage } : {}),
      ...model,
    });
    const event = await checkpointProviderRender(
      job, result, "image_to_video", result.effectiveDurationSec ?? model.durationSec,
    );
    const normalized = await normalizeVideo(result.buffer, aspectRatio, model.resolution);
    return {
      buffer: music ? await mixMusicIntoVideo(normalized, music) : normalized,
      provider: result.provider,
      model: result.model,
      providerEvents: [event],
      qa: { minDurationSec: 0.5, label: "image-to-video clip" },
    };
  }

  if (job.engine === "slideshow") {
    const paths = job.sourceImagePaths ?? [];
    if (paths.length === 0) throw new VideoJobInputError("No photos provided.");
    onStage("Preparing your photos");
    const images: Buffer[] = [];
    for (const path of paths) {
      images.push((await loadSourceImage(path, job.tenantId)).buffer);
    }
    const slideDurationSec = options.slideDurationSec ?? 3;
    const music = await resolveMusic(
      job,
      options,
      expectedSlideshowDurationSec(images.length, slideDurationSec),
      onStage,
    );
    onStage("Composing the slideshow");
    const buffer = await renderSlideshow({
      images,
      aspectRatio,
      slideDurationSec,
      overlayText: options.overlayText ?? null,
      music,
    });
    return {
      buffer,
      provider: null,
      model: null,
      qa: {
        expectedDurationSec: expectedSlideshowDurationSec(images.length, slideDurationSec),
        label: "slideshow",
      },
    };
  }

  if (job.engine === "dialogue_lip_sync") {
    // Defense in depth: this pipeline crosses all three governed capabilities.
    // A job queued immediately before any switch is disabled must fail through
    // the ordinary terminal/refund path before making another provider call.
    if (!(await isFeatureEnabled("lipSync").catch(() => true))) {
      throw new VideoJobInputError("Lip-synced videos are currently turned off.");
    }
    if (!options.presetSnapshot && !(await isFeatureEnabled("brandVoiceClone").catch(() => true))) {
      throw new VideoJobInputError("Brand Voice is currently turned off.");
    }
    if (options.aiPersonConsent !== true) {
      throw new VideoJobInputError(
        "This job is missing the recorded AI-person likeness consent, so it was not generated.",
      );
    }
    const dialogueReplay = options.guidedStoryDialogueReplay;
    if (dialogueReplay) {
      if (dialogueReplay.locale !== "te" || dialogueReplay.subtitles !== false || !dialogueReplay.lines.length) {
        throw new VideoJobInputError("Guided Story dialogue replay has an invalid immutable snapshot.");
      }
      if (!job.storyboard) {
        throw new VideoJobInputError("Guided Story dialogue replay is missing its cloned approved storyboard.");
      }
      const replayStoryboard = job.storyboard;
      const targetDurationSec = dialogueReplay.lines.reduce(
        (total, line) => total + (line.endMs - line.startMs) / 1000,
        0,
      );
      if (Math.abs(targetDurationSec - dialogueReplay.estimates.durationSeconds) > 0.1) {
        throw new VideoJobInputError("Guided Story dialogue replay duration no longer matches its frozen lines.");
      }
      const checkpoint = job.storyboard?.dialogueReplayCheckpoint;
      const saved = new Map((checkpoint?.lines ?? []).map((line) => [line.lineId, line]));
      const replayLines = [...(checkpoint?.lines ?? [])];
      const events: VideoProviderEvent[] = [];
      const clips: Buffer[] = [];
      const save = async (state: NonNullable<typeof checkpoint>["state"], currentLineId: string | null, error: string | null = null) => {
        const board: VideoStoryboard = {
          ...replayStoryboard,
          dialogueReplayCheckpoint: {
            version: 1, operationId: `guided-dialogue-replay:${job.id}`, state,
            totalLines: dialogueReplay.lines.length, completedLines: replayLines.filter((line) => Boolean(line.clipPath || line.lipSyncPath)).length,
            estimates: dialogueReplay.estimates, currentLineId, error,
            requestedAt: checkpoint?.requestedAt ?? new Date().toISOString(),
            startedAt: checkpoint?.startedAt ?? new Date().toISOString(),
            finishedAt: state === "succeeded" || state === "failed" ? new Date().toISOString() : null,
            lines: replayLines,
          },
        };
        await setJob(job.id, { storyboard: board });
      };
      try {
        for (const [index, line] of dialogueReplay.lines.entries()) {
          const frozenDurationSec = (line.endMs - line.startMs) / 1000;
          if (frozenDurationSec <= 0) throw new VideoJobInputError(`Guided Story line ${line.lineId} has an invalid frozen duration.`);
          let receipt = saved.get(line.lineId);
          if (receipt?.lipSyncPath || receipt?.clipPath) {
            const path = receipt.lipSyncPath ?? receipt.clipPath!;
            clips.push((await loadTenantObject(path, job.tenantId, MAX_SOURCE_VIDEO_BYTES, "Saved Guided Story line")).buffer);
            for (const event of [receipt.animationEvent, receipt.lipSyncEvent]) if (event && !event.accounted) events.push(event);
            continue;
          }
          await save("synthesizing", line.lineId);
          // Each exact snapshot line is deliberately a separate TTS operation.
          const narration = receipt?.audioPath
            ? (await loadTenantObject(
                receipt.audioPath, job.tenantId, MAX_NARRATION_BYTES, "Saved Guided Story line narration",
              )).buffer
            : await (async () => {
                const rawNarration = line.speaker.type === "role"
                  ? await speakLocalizedBrandVoiceCue({
                      tenantId: job.tenantId, jobId: job.id, cueIndex: index,
                      voice: { provider: "elevenlabs", voiceId: line.speaker.voice.providerVoiceId },
                      text: line.text, modelId: "eleven_v3", languageCode: "te",
                    })
                  // The child options retain the source's frozen stock
                  // narrator selection. Ownerless replay never picks a role.
                  : (await synthesizeNarration(
                      [line.text], resolveNarrationVoice(options.voice, "alloy"),
                    )).wav;
                return fitGuidedReplayWavToSlot(rawNarration, Math.round(frozenDurationSec * 1000));
              })();
          const measuredSec = await probeNarrationWavDurationSec(narration);
          if (Math.abs(measuredSec - frozenDurationSec) > 0.02) {
            throw new VideoGenProviderError(`Saved Guided Story line ${line.lineId} audio no longer matches its frozen slot.`);
          }
          if (!receipt) {
            receipt = { lineId: line.lineId, audioPath: await uploadToStorage(job.tenantId, narration, "audio/wav"),
              durationMs: Math.round(measuredSec * 1000), provider: line.speaker.type === "role" ? "elevenlabs" : "stock",
              model: line.speaker.type === "role" ? "eleven_v3" : "stock" };
            replayLines.push(receipt);
          }
          await save("composing", line.lineId);
          const approvedPreview = await loadTenantObject(
            line.preview.path, job.tenantId, MAX_SOURCE_IMAGE_BYTES, "Approved Guided Story preview",
          );
          if (!ALLOWED_IMAGE_TYPES.has(approvedPreview.mimeType)) {
            throw new VideoJobInputError("Approved Guided Story preview is not a supported image.");
          }
          const still: SourceImage = { buffer: approvedPreview.buffer, mimeType: approvedPreview.mimeType };
          if (line.speaker.type === "offscreen") {
            const clip = await composeApprovedStillAudioClip(still.buffer, narration, frozenDurationSec);
            receipt.clipPath = await uploadToStorage(job.tenantId, clip, "video/mp4");
            clips.push(clip);
            await save("composing", line.lineId);
            continue;
          }
          if (receipt.animationEvent && !receipt.platePath) {
            throw new VideoGenProviderError(
              `Guided Story line ${line.lineId} has an animation receipt without a saved plate; provider outcome is unknown.`,
            );
          }
          if (receipt.lipSyncEvent && !receipt.lipSyncPath) {
            throw new VideoGenProviderError(
              `Guided Story line ${line.lineId} has a lip-sync receipt without saved output; provider outcome is unknown.`,
            );
          }
          // Animate the approved preview only; this is image-to-video, never image generation.
          let plate: Buffer;
          let animationEvent: VideoProviderEvent;
          if (receipt.platePath) {
            plate = (await loadTenantObject(
              receipt.platePath, job.tenantId, MAX_SOURCE_VIDEO_BYTES, "Saved Guided Story animation plate",
            )).buffer;
            animationEvent = receipt.animationEvent!;
          } else {
            const permittedDurations = options.resolvedVideoModel?.permittedDurationSec ?? [];
            const animationDurationSec = permittedDurations
              .filter((duration) => duration >= frozenDurationSec)
              .sort((a, b) => a - b)[0] ?? model.durationSec;
            if (animationDurationSec < frozenDurationSec) {
              throw new VideoJobInputError(`No frozen image-to-video duration can cover Guided Story line ${line.lineId}.`);
            }
            const animationModel = { ...model, durationSec: animationDurationSec };
            const identity = line.speaker.identity;
            const speakerPrompt = [
              "Animate this exact approved composition without reframing, replacing, or moving any character.",
              `Only ${identity.name} (${line.speaker.roleId}) is the active speaker for this shot.`,
              `Match the approved identity exactly: ${identity.characterDescription}.`,
              identity.outfitDescription
                ? `Keep the approved outfit unchanged: ${identity.outfitDescription}.`
                : null,
              "The active speaker makes natural speech mouth movements while every other visible character remains silent with lips closed and face stable.",
              "Keep the backdrop, camera, lighting, body positions, and all non-speaking faces stable. Do not add text or subtitles.",
            ].filter((part): part is string => Boolean(part)).join(" ");
            const animated = await generateVideo({
              mode: "image",
              prompt: speakerPrompt,
              aspectRatio,
              image: still,
              ...animationModel,
            });
            const animatedDurationSec = (await verifyRenderedVideo(animated.buffer, {
              minDurationSec: 0.1, label: "Guided Story approved-preview animation",
            })).durationSec;
            animationEvent = {
              eventId: videoProviderEventId(job, `guided_animation:${line.lineId}`), provider: animated.provider, model: animated.model,
              durationSec: animatedDurationSec, requestBytes: 0, label: `guided_animation:${line.lineId}`,
              criteria: jobVideoPriceCriteria(job), costPaise: await computeVideoCostPaise({
                provider: animated.provider, model: animated.model, durationSec: animatedDurationSec,
                variantCriteria: jobVideoPriceCriteria(job),
              }).catch(() => null),
            };
            receipt.animationEvent = animationEvent;
            await save("composing", line.lineId);
            plate = animated.buffer;
            receipt.platePath = await uploadToStorage(job.tenantId, plate, "video/mp4");
          }
          await save("composing", line.lineId);
          const synced = await generateLipSyncWithReplicate({
            source: { buffer: await loopVideoPlateToDuration(plate, frozenDurationSec), mimeType: "video/mp4" },
            // Replay plates deliberately animate only the approved owner. Sync
            // Lipsync 2 then uses its active-speaker detection to select that
            // moving face in multi-character frames. LatentSync has no such
            // selector and is never safe for this replay mode.
            audio: { buffer: narration, mimeType: "audio/wav" }, def: SYNC_LIPSYNC_2,
          }, (await (async () => { const def = getVideoGenProviderDef("replicate"); return def ? resolveVideoGenApiKey(def) : null; })()));
          const syncedDurationSec = (await verifyRenderedVideo(synced.buffer, {
            minDurationSec: 0.1, label: "Guided Story lip-sync provider output",
          })).durationSec;
          receipt.lipSyncEvent = {
            eventId: videoProviderEventId(job, `guided_lip_sync:${line.lineId}`), provider: synced.provider, model: synced.model,
            durationSec: syncedDurationSec, requestBytes: narration.length, label: `guided_lip_sync:${line.lineId}`,
            criteria: videoPriceCriteria({ hasReferenceVideo: true }), costPaise: await computeVideoCostPaise({
              provider: synced.provider, model: synced.model, durationSec: syncedDurationSec,
              variantCriteria: videoPriceCriteria({ hasReferenceVideo: true }),
            }).catch(() => null),
          };
          // The lip-sync receipt follows the same fail-closed ordering.
          await save("composing", line.lineId);
          const clip = await trimCharacterDialogueClipStrict(await normalizeVideo(synced.buffer, aspectRatio), frozenDurationSec, narration);
          receipt.lipSyncPath = await uploadToStorage(job.tenantId, clip, "video/mp4");
          clips.push(clip);
          events.push(animationEvent, receipt.lipSyncEvent);
          await save("composing", line.lineId);
        }
        const joined = await concatClips(clips);
        const music = await resolveMusic(job, options, targetDurationSec, onStage);
        const buffer = music ? await mixMusicIntoVideo(joined, music) : joined;
        await save("succeeded", null);
        return { buffer, provider: null, model: null, providerEvents: events,
          qa: { expectedDurationSec: targetDurationSec, expectAudio: true, label: "Guided Story dialogue replay" } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await save(
          /provider outcome is unknown/i.test(message) ? "outcome_unknown" : "failed",
          null,
          message,
        );
        const completed = replayLines.flatMap((line) =>
          [line.animationEvent, line.lipSyncEvent].filter(
            (event): event is VideoProviderEvent => Boolean(event && !event.accounted),
          ),
        );
        const labels = new Set<string>();
        throw new PartialVideoProviderWorkError(
          events.concat(completed).filter((event) => {
            if (labels.has(event.label)) return false;
            labels.add(event.label);
            return true;
          }),
          error,
        );
      }
    }
    const visualPrompt = job.prompt?.trim();
    if (!visualPrompt) throw new VideoJobInputError("No AI-person visual prompt provided.");
    const dialogue = options.dialogue?.trim();
    if (!dialogue) throw new VideoJobInputError("No dialogue provided.");
    const frozenPlan = options.characterDialogue;
    if (frozenPlan) {
      // This is intentionally a separate branch: legacy dialogue_lip_sync
      // remains the one-plate pipeline, including its stock fallback.
      if (!job.storyboard && options.reviewStoryboard !== false) {
        return {
          paused: true,
          storyboard: characterDialogueStoryboard(
            frozenPlan,
            options.presenterBroll ?? null,
          ),
        };
      }
      if (job.storyboard?.mode === "character_dialogue") {
        if (job.storyboard.scenes.length !== frozenPlan.scenes.length) {
          throw new VideoJobInputError(
            "Character Dialogue review cannot add or remove speaking scenes.",
          );
        }
        for (const [index, scene] of frozenPlan.scenes.entries()) {
          const reviewed = job.storyboard.scenes[index];
          if (!reviewed || reviewed.id !== scene.id || reviewed.text !== scene.text) {
            throw new VideoJobInputError(
              "Approved Character Dialogue text changed during storyboard review.",
            );
          }
          scene.visualPrompt = lipSyncSourcePlatePrompt(reviewed.visual);
          const beat = options.presenterBroll?.beats[index];
          if (beat && reviewed.brollVisual?.trim()) {
            beat.query = reviewed.brollVisual.trim();
          }
        }
        await setJob(job.id, {
          options: { ...options, characterDialogue: frozenPlan },
        });
      }
      const frozenVoice = frozenPlan.voice;
      // Existing jobs have no frozen catalog voice and retain their licensed
      // preset voice. New catalog-backed Character Dialogue jobs deliberately
      // let the explicit picker override a preset's default.
      const presetVoice = frozenVoice ? null : (options.presetSnapshot?.voice ?? null);
      // New jobs freeze their catalog voice at enqueue time. Keep the Brand
      // Kit lookup solely for rows queued before voice snapshots existed.
      const branding =
        presetVoice || frozenVoice
          ? null
          : await loadVideoBranding(job.tenantId, frozenPlan.brandKitId);
      if (
        !presetVoice &&
        !frozenVoice &&
        (!branding?.clonedVoice || branding.clonedVoice.provider !== "elevenlabs")
      ) {
        throw new VideoJobInputError("The saved character dialogue Brand Voice is no longer available.");
      }
      const clips: Buffer[] = [];
      const composedScenes: Array<{ text: string; narrationDurationSec: number }> = [];
      const events: VideoProviderEvent[] = [];
      const checkpointJob = async () => setJob(job.id, { options: { ...options, characterDialogue: frozenPlan } });
      for (const [sceneIndex, scene] of frozenPlan.scenes.entries()) {
        let sceneOperation = "scene_setup";
        try {
        const checkpoint = scene.checkpoint;
        if (checkpoint?.lipSyncPath) {
          clips.push((await loadTenantObject(checkpoint.lipSyncPath, job.tenantId, MAX_SOURCE_VIDEO_BYTES, "Saved scene")).buffer);
          if (!checkpoint.narrationDurationSec || !checkpoint.lipSyncEvent) {
            throw new VideoJobInputError(`Saved dialogue scene ${scene.id} has an incomplete checkpoint.`);
          }
          composedScenes.push({ text: scene.text, narrationDurationSec: checkpoint.narrationDurationSec });
          if (checkpoint.visualEvent && !checkpoint.visualEvent.accounted) events.push(checkpoint.visualEvent);
          if (!checkpoint.lipSyncEvent.accounted) events.push(checkpoint.lipSyncEvent);
          continue;
        }
        onStage(`Rendering dialogue scene ${scene.id}`);
        const narration = checkpoint?.narrationPath
          ? (await loadTenantObject(checkpoint.narrationPath, job.tenantId, MAX_NARRATION_BYTES, "Saved narration")).buffer
          : presetVoice
            ? (
                await synthesizeNarration(
                  [scene.text],
                  resolveNarrationVoice(options.voice, presetVoice.speaker),
                )
              ).wav
            : frozenVoice?.provider === "stock"
              ? (
                  await synthesizeNarration(
                    [scene.text],
                    frozenVoice.id.slice("stock:".length) as NarrationVoice,
                  )
                ).wav
              : frozenVoice?.provider === "elevenlabs" &&
                  frozenVoice.providerVoiceId
                ? await speakLocalizedBrandVoiceCue({
                    tenantId: job.tenantId,
                    jobId: frozenPlan.retry?.sourceJobId ?? job.id,
                    cueIndex: sceneIndex,
                    voice: {
                      provider: "elevenlabs",
                      voiceId: frozenVoice.providerVoiceId,
                    },
                    text: scene.text,
                    modelId: "eleven_v3",
                    languageCode: frozenPlan.locale,
                  })
            : await speakLocalizedBrandVoiceCue({
                tenantId: job.tenantId,
                jobId: frozenPlan.retry?.sourceJobId ?? job.id,
                cueIndex: sceneIndex,
                voice: branding!.clonedVoice!,
                text: scene.text,
                modelId: "eleven_v3",
                languageCode: frozenPlan.locale,
              });
        const narrationDurationSec = checkpoint?.narrationDurationSec ?? await probeNarrationWavDurationSec(narration);
        if (!checkpoint?.narrationPath) {
          scene.checkpoint = { ...checkpoint, narrationPath: await uploadToStorage(job.tenantId, narration, "audio/wav"), narrationDurationSec };
          await checkpointJob();
        }
        let plate: Buffer;
        let visualEvent: VideoProviderEvent;
        if (checkpoint?.platePath) {
          if (!checkpoint.visualEvent) {
            throw new VideoJobInputError(`Saved dialogue scene ${scene.id} has a plate without its provider event.`);
          }
          plate = (await loadTenantObject(checkpoint.platePath, job.tenantId, MAX_SOURCE_VIDEO_BYTES, "Saved character plate")).buffer;
          visualEvent = checkpoint.visualEvent;
        } else {
          const sourcePlatePrompt = lipSyncSourcePlatePrompt(scene.visualPrompt);
          if (sourcePlatePrompt !== scene.visualPrompt) {
            scene.visualPrompt = sourcePlatePrompt;
            await checkpointJob();
          }
          sceneOperation = "character_plate_generation";
          const visual = await generateCharacterClip({
            tenantId: job.tenantId, characterId: frozenPlan.characterId, outfitId: frozenPlan.outfitId,
            wardrobeSnapshot: options.characterSnapshot,
            prompt: sourcePlatePrompt, aspectRatio, durationSec: Math.min(30, narrationDurationSec + 0.35),
            model: resolveModelOptions(options, 5),
          });
          plate = visual.buffer;
          visualEvent = {
            eventId: videoProviderEventId(job, `character_plate:${scene.id}`),
            provider: visual.provider, model: visual.model,
            durationSec: visual.effectiveDurationSec ?? null,
            requestBytes: Buffer.byteLength(sourcePlatePrompt), label: `character_plate:${scene.id}`,
            criteria: jobVideoPriceCriteria(job),
            costPaise: await computeVideoCostPaise({
              provider: visual.provider, model: visual.model,
              durationSec: visual.effectiveDurationSec ?? null,
              variantCriteria: jobVideoPriceCriteria(job),
            }).catch(() => null),
          };
          // Persist the paid event before storage I/O. If App Storage itself
          // fails, accounting still retains the provider work instead of
          // silently refunding it.
          scene.checkpoint = { ...scene.checkpoint, visualEvent };
          await checkpointJob();
          scene.checkpoint = {
            ...scene.checkpoint,
            platePath: await uploadToStorage(job.tenantId, plate, "video/mp4"),
          };
          await checkpointJob();
        }
        if (visualEvent.durationSec == null) {
          const rawDurationSec = (await verifyRenderedVideo(plate, {
            minDurationSec: 0.1, label: "saved-character provider plate",
          })).durationSec;
          visualEvent.durationSec = rawDurationSec;
          visualEvent.costPaise = await computeVideoCostPaise({
            provider: visualEvent.provider, model: visualEvent.model, durationSec: rawDurationSec,
            variantCriteria: visualEvent.criteria,
          }).catch(() => null);
          scene.checkpoint = { ...scene.checkpoint, visualEvent };
          await checkpointJob();
        }
        try {
          const lipSyncDef =
            frozenPlan.lipSyncModel === SYNC_LIPSYNC_2.model
              ? SYNC_LIPSYNC_2
              : frozenPlan.lipSyncModel === LATENT_SYNC.model
                ? LATENT_SYNC
                : lipSyncModelForQuality(options.lipSyncQuality);
          await requirePricedVideoCall(
            "replicate",
            lipSyncDef.model,
            narrationDurationSec,
            videoPriceCriteria({ hasReferenceVideo: true }),
          );
          sceneOperation = "lip_sync";
          const synced = await generateLipSyncWithReplicate({
            source: {
              buffer: await loopVideoPlateToDuration(plate, narrationDurationSec + 0.35),
              mimeType: "video/mp4",
            },
            audio: { buffer: narration, mimeType: "audio/wav" },
            def: lipSyncDef,
          }, (await (async () => {
            const def = getVideoGenProviderDef("replicate");
            return def ? resolveVideoGenApiKey(def) : null;
          })()));
          const rawLipSyncDurationSec = (
            await verifyRenderedVideo(synced.buffer, {
              minDurationSec: 0.1,
              label: "saved-character lip-sync provider output",
            })
          ).durationSec;
          const lipSyncEvent: VideoProviderEvent = {
            eventId: videoProviderEventId(job, `lip_sync:${scene.id}`),
            provider: synced.provider, model: synced.model, durationSec: rawLipSyncDurationSec,
            requestBytes: narration.length, label: `lip_sync:${scene.id}`,
            criteria: videoPriceCriteria({ hasReferenceVideo: true }),
            costPaise: await computeVideoCostPaise({
              provider: synced.provider, model: synced.model, durationSec: rawLipSyncDurationSec,
              variantCriteria: videoPriceCriteria({ hasReferenceVideo: true }),
            }).catch(() => null),
          };
          scene.checkpoint = { ...scene.checkpoint, lipSyncEvent };
          await checkpointJob();
          sceneOperation = "scene_normalization";
          const normalized = await normalizeVideo(synced.buffer, aspectRatio);
          sceneOperation = "scene_composition";
          const trimmed = await trimCharacterDialogueClipStrict(
            normalized,
            narrationDurationSec,
            narration,
          );
          const lipSyncPath = await uploadToStorage(job.tenantId, trimmed, "video/mp4");
          scene.checkpoint = { ...scene.checkpoint, lipSyncPath };
          // Checkpoint each paid scene immediately. A process restart reuses it.
          await setJob(job.id, { options: { ...options, characterDialogue: frozenPlan } });
          clips.push(trimmed);
          composedScenes.push({ text: scene.text, narrationDurationSec });
          if (!visualEvent.accounted) events.push(visualEvent);
          events.push(lipSyncEvent);
        } catch (error) {
          const checkpointEvents = [
            scene.checkpoint?.visualEvent,
            scene.checkpoint?.lipSyncEvent,
          ].filter((event): event is VideoProviderEvent => Boolean(event && !event.accounted));
          const labels = new Set(events.map((event) => event.label));
          throw new PartialVideoProviderWorkError(
            events.concat(checkpointEvents.filter((event) => !labels.has(event.label))),
            error,
          );
        }
        } catch (error) {
          const surfaced =
            error instanceof PartialVideoProviderWorkError ? error.cause : error;
          await recordSceneFailure(
            job,
            {
              id: scene.id,
              text: scene.text,
              visual: scene.visualPrompt,
              durationSec: scene.estimatedDurationSec,
              previewPath: null,
              outfitId: frozenPlan.outfitId,
            },
            sceneOperation,
            surfaced,
            scene.checkpoint?.lipSyncEvent?.provider ??
              scene.checkpoint?.visualEvent?.provider ??
              null,
            scene.checkpoint?.lipSyncEvent?.model ??
              scene.checkpoint?.visualEvent?.model ??
              null,
          );
          if (error instanceof PartialVideoProviderWorkError) throw error;
          const checkpointEvents = [
            scene.checkpoint?.visualEvent,
            scene.checkpoint?.lipSyncEvent,
          ].filter((event): event is VideoProviderEvent => Boolean(event && !event.accounted));
          const labels = new Set(events.map((event) => event.label));
          throw new PartialVideoProviderWorkError(
            events.concat(checkpointEvents.filter((event) => !labels.has(event.label))),
            error,
          );
        }
      }
      let presenterEvents: VideoProviderEvent[] = [];
      try {
        const totalNarrationSec = composedScenes.reduce((sum, scene) => sum + scene.narrationDurationSec, 0);
        let music: Buffer | null = null;
        if (options.musicPath) {
        music = await resolveMusic(job, { ...options, musicPrompt: null }, totalNarrationSec, onStage);
        } else if (options.musicPrompt?.trim()) {
          const saved = frozenPlan.musicCheckpoint;
          if (saved?.path) {
            music = (await loadTenantObject(saved.path, job.tenantId, MAX_MUSIC_BYTES, "Saved music")).buffer;
            if (!saved.event.accounted) events.push(saved.event);
          } else {
            onStage("Composing the music");
            const requestedDurationSec = musicGenDurationSec(totalNarrationSec);
            const criteria = videoPriceCriteria({});
            await requirePricedVideoCall(
              "replicate",
              MUSICGEN_MODEL,
              requestedDurationSec,
              criteria,
            );
            music = await generateMusicBed(options.musicPrompt, totalNarrationSec);
            const event: VideoProviderEvent = {
              eventId: videoProviderEventId(job, "character_dialogue_music"),
              provider: "replicate", model: MUSICGEN_MODEL, durationSec: requestedDurationSec,
              requestBytes: Buffer.byteLength(options.musicPrompt), label: "character_dialogue_music",
              criteria,
              costPaise: await computeVideoCostPaise({
                provider: "replicate",
                model: MUSICGEN_MODEL,
                durationSec: requestedDurationSec,
                variantCriteria: criteria,
              }).catch(() => null),
            };
            frozenPlan.musicCheckpoint = { provider: "replicate", model: MUSICGEN_MODEL, durationSec: requestedDurationSec, event };
            await checkpointJob();
            frozenPlan.musicCheckpoint.path = await uploadToStorage(job.tenantId, music, "audio/mpeg");
            await checkpointJob();
            events.push(event);
          }
        }
        const composed = await composeCharacterDialogue({
          clips, scenes: composedScenes, fontCandidates: frozenPlan.fontCandidates,
          subtitles: options.subtitles ?? true,
          direction: frozenPlan.direction, music,
        });
        let finalBuffer = composed.buffer;
        if (options.presenterBroll && job.storyboard?.mode === "character_dialogue") {
          let cursorMs = 0;
          let snapshot = {
            ...options.presenterBroll,
            lines: composedScenes.map((scene, index) => {
              const startMs = cursorMs;
              cursorMs += Math.round(scene.narrationDurationSec * 1000);
              return {
                index: index + 1,
                startMs,
                endMs: cursorMs,
                text: scene.text,
              };
            }),
          };
          snapshot = {
            ...snapshot,
            durationMs: cursorMs,
            beats: snapshot.beats.map((beat, index) => ({
              ...beat,
              startMs: snapshot.lines[index]?.startMs ?? beat.startMs,
              endMs: snapshot.lines[index]?.endMs ?? beat.endMs,
              lineIndexes: [index + 1],
            })),
          };
          await setJob(job.id, { options: { ...options, presenterBroll: snapshot } });
          snapshot = await resolvePresenterBrollAssets({
            snapshot,
            aspectRatio,
            visualsSource:
              options.visualsSource === "ai" || options.visualsSource === "ai_video"
                ? options.visualsSource
                : "stock",
            stockSource: isStockSourceChoice(options.stockSource)
              ? options.stockSource
              : "auto",
            upload: (bytes, contentType) =>
              uploadToStorage(job.tenantId, bytes, contentType),
            load: async (objectPath) =>
              (
                await loadTenantObject(
                  objectPath,
                  job.tenantId,
                  MAX_SOURCE_VIDEO_BYTES,
                  "Dialogue B-roll asset",
                )
              ).buffer,
            onStage,
            onCheckpoint: async (next) => {
              snapshot = next;
              presenterEvents = unaccountedPresenterBrollEvents(next);
              await setJob(job.id, {
                options: { ...options, presenterBroll: next },
              });
            },
          });
          presenterEvents = unaccountedPresenterBrollEvents(snapshot);
          finalBuffer = await renderPresenterBroll({
            presenterVideo: composed.buffer,
            snapshot,
            aspectRatio,
            subtitles: false,
            captionStyle:
              options.captionStyle === "dynamic" ? "dynamic" : "classic",
            accentColor: branding?.accentColor ?? null,
            watermark: null,
            load: async (objectPath) =>
              (
                await loadTenantObject(
                  objectPath,
                  job.tenantId,
                  MAX_SOURCE_VIDEO_BYTES,
                  "Dialogue B-roll asset",
                )
              ).buffer,
            onStage,
          });
        }
        return {
          buffer: finalBuffer,
          provider: "replicate",
          model:
            frozenPlan.lipSyncModel ??
            lipSyncModelForQuality(options.lipSyncQuality).model,
          providerEvents: events.concat(presenterEvents),
          qa: { expectedDurationSec: composed.durationSec, minDurationSec: composed.durationSec, expectAudio: true, label: "saved-character dialogue video" },
        };
      } catch (error) {
        if (error instanceof PartialVideoProviderWorkError) throw error;
        const musicEvent = frozenPlan.musicCheckpoint?.event;
        throw new PartialVideoProviderWorkError(
          musicEvent && !musicEvent.accounted && !events.some((event) => event.label === musicEvent.label)
            ? events.concat(musicEvent, presenterEvents)
            : events.concat(presenterEvents),
          error,
        );
      }
    }

    // A supplied Brand Kit is an access-controlled voice selection, not
    // best-effort decoration. Re-resolve it tenant-scoped at execution time so
    // a foreign/manual row or a kit revoked after enqueue can never be read.
    // Do this before generating the visual so invalid access cannot spend.
    const branding = await loadVideoBranding(job.tenantId, options.brandKitId ?? null);
    if (options.brandKitId != null && !branding) {
      throw new VideoJobInputError("That Brand Voice is not available in this workspace.");
    }

    const voice = resolveNarrationVoice(options.voice, branding?.presetVoice);
    onStage("Voicing the dialogue");
    const narration = await synthesizeNarration(splitIntoSentences(dialogue), voice, {
      clonedVoice: branding?.clonedVoice ?? null,
      billing: {
        tenantId: job.tenantId,
        refKind: "videoJob",
        refId: String(job.id),
      },
    });
    // WAN's default model produces a short plate regardless of duration
    // wording. Synthesize first so the plate is composed to the real speech
    // length, rather than trusting an aspirational provider duration option.
    const plateDurationSec = Math.min(
      30.5,
      Math.max(options.durationSec ?? 5, narration.totalDurationSec + 0.35),
    );
    onStage("Creating the AI person");
    const visual = await generateVideo({
      mode: "text",
      prompt: lipSyncSourcePlatePrompt(visualPrompt),
      aspectRatio,
      durationSec: options.durationSec ?? 5,
      resolvedVideoModel: options.resolvedVideoModel,
    });
    // Provider success is the partial-work boundary. Start with an unmeasured
    // event: flat-per-video models can still resolve an exact cost, while a
    // per-second model remains unknown until probing. Wallet jobs cannot reach
    // successful settlement unless the measured event resolves exactly.
    const visualEvent: VideoProviderEvent = {
      eventId: videoProviderEventId(job, "ai_person_plate"),
      provider: visual.provider,
      model: visual.model,
      durationSec: null,
      requestBytes: Buffer.byteLength(visualPrompt),
      label: "ai_person_plate",
      criteria: jobVideoPriceCriteria(job),
      costPaise: await computeVideoCostPaise({
        provider: visual.provider,
        model: visual.model,
        durationSec: null,
        variantCriteria: jobVideoPriceCriteria(job),
      }).catch(() => null),
    };
    let result;
    try {
      // Price the provider's actual raw output, never locally repeated seconds.
      const rawVisualDurationSec = (
        await verifyRenderedVideo(visual.buffer, {
          minDurationSec: 0.1,
          label: "AI-person provider plate",
        })
      ).durationSec;
      visualEvent.durationSec = rawVisualDurationSec;
      visualEvent.costPaise = await computeVideoCostPaise({
        provider: visual.provider,
        model: visual.model,
        durationSec: rawVisualDurationSec,
        variantCriteria: visualEvent.criteria,
      }).catch(() => null);
      const extendedVisual = await loopVideoPlateToDuration(visual.buffer, plateDurationSec);
      const replicateDef = getVideoGenProviderDef("replicate");
      const apiKey = replicateDef ? await resolveVideoGenApiKey(replicateDef) : null;
      onStage("Syncing the lips");
      const dialogueLipSyncDef =
        options.characterDialogue?.lipSyncModel === SYNC_LIPSYNC_2.model
          ? SYNC_LIPSYNC_2
          : options.characterDialogue?.lipSyncModel === LATENT_SYNC.model
            ? LATENT_SYNC
            : lipSyncModelForQuality(options.lipSyncQuality);
      await requirePricedVideoCall(
        "replicate",
        dialogueLipSyncDef.model,
        narration.totalDurationSec,
        videoPriceCriteria({ hasReferenceVideo: true }),
      );
      result = await generateLipSyncWithReplicate(
        {
          source: { buffer: extendedVisual, mimeType: "video/mp4" },
          audio: { buffer: narration.wav, mimeType: "audio/wav" },
          def: dialogueLipSyncDef,
        },
        apiKey,
      );
    } catch (error) {
      throw new PartialVideoProviderWorkError([visualEvent], error);
    }
    const lipSyncEvent = await checkpointProviderRender(
      job,
      result,
      "lip_sync",
      narration.totalDurationSec,
    );
    const checkpointRow = (
      await db.select({ options: videoGenerationsTable.options })
        .from(videoGenerationsTable)
        .where(eq(videoGenerationsTable.id, job.id))
        .limit(1)
    )[0];
    if (checkpointRow?.options?.renderCheckpoint) {
      const checkpointOptions = structuredClone(checkpointRow.options);
      checkpointOptions.renderCheckpoint!.providerEvents = [visualEvent, lipSyncEvent];
      await db.update(videoGenerationsTable).set({ options: checkpointOptions }).where(eq(videoGenerationsTable.id, job.id));
    }
    const rawLipSyncDurationSec = (
      await verifyRenderedVideo(result.buffer, {
        minDurationSec: 0.1,
        label: "AI-person lip-sync provider output",
      })
    ).durationSec;
    const lipSyncCostPaise = await computeVideoCostPaise({
      provider: result.provider,
      model: result.model,
      durationSec: rawLipSyncDurationSec,
      variantCriteria: lipSyncEvent.criteria,
    }).catch(() => null);
    lipSyncEvent.durationSec = rawLipSyncDurationSec;
    lipSyncEvent.costPaise = lipSyncCostPaise;
    return {
      buffer: result.buffer,
      provider: result.provider,
      model: result.model,
      providerEvents: [
        visualEvent,
        lipSyncEvent,
      ],
      // The plate was preflighted against a conservative estimate. Validate
      // the delivered video against the real synthesized track as well, so a
      // provider-truncated plate can never be delivered with dialogue cut off.
      qa: {
        expectedDurationSec: narration.totalDurationSec,
        minDurationSec: narration.totalDurationSec,
        expectAudio: true,
        label: "dialogue lip-sync video",
      },
    };
  }

  if (job.engine === "lip_sync") {
    // Kill switch gates the execution path too, not just the enqueue route:
    // a job queued moments before the switch flipped fails cleanly (and is
    // refunded by the caller) instead of spending on a disabled feature.
    if (!(await isFeatureEnabled("lipSync").catch(() => true))) {
      throw new VideoJobInputError("Lip-synced videos are currently turned off.");
    }
    // Defense-in-depth on the consent hard gate: the route already refuses
    // unconsented requests, but a job row that reaches execution without the
    // recorded consent (recovery, manual insertion, legacy shape) must never
    // synthesize a likeness.
    if (options.lipSyncConsent !== true) {
      throw new VideoJobInputError(
        "This job is missing the recorded likeness consent, so it was not generated.",
      );
    }
    // Two shapes of source, and the route guarantees exactly one is set:
    // an existing video of a person, or a single portrait still.
    const portraitPath = options.sourceImagePath ?? null;
    const sourcePath = options.sourceVideoPath ?? null;
    if (!sourcePath && !portraitPath) {
      throw new VideoJobInputError("No base video or portrait provided.");
    }

    const selection = await getVideoGenSelection();
    const lipSyncDef = portraitPath
      ? portraitLipSyncModel(selection.lipSyncPortraitModel)
      : lipSyncModelForQuality(options.lipSyncQuality);
    if (!lipSyncDef) {
      throw new VideoJobInputError(
        "Portrait lip sync is not configured on this platform yet. Ask an admin to set a portrait lip-sync model, or upload a video instead.",
      );
    }

    let source: { buffer: Buffer; mimeType: string };
    if (portraitPath) {
      source = await loadTenantObject(
        portraitPath,
        job.tenantId,
        MAX_SOURCE_IMAGE_BYTES,
        "Portrait",
      );
      if (!ALLOWED_LIP_SYNC_IMAGE_TYPES.has(source.mimeType)) {
        throw new VideoJobInputError(
          "Unsupported portrait type. Please upload a PNG, JPEG, or WebP image.",
        );
      }
    } else {
      source = await loadTenantObject(
        sourcePath!,
        job.tenantId,
        MAX_SOURCE_VIDEO_BYTES,
        "Base video",
      );
      if (!ALLOWED_SOURCE_VIDEO_TYPES.has(source.mimeType)) {
        throw new VideoJobInputError(
          "Unsupported base video type. Please upload an MP4, MOV, or WebM video.",
        );
      }
    }

    // The voice track: an uploaded recording wins, otherwise the script is
    // synthesised as it always was. Uploading is the point — a real voice
    // note or an actor's take beats any stock narrator, and synthesising
    // stays the default so nothing about existing jobs changes.
    let audio: { buffer: Buffer; mimeType: string };
    if (options.audioPath) {
      onStage("Loading your voice track");
      audio = await loadTenantObject(
        options.audioPath,
        job.tenantId,
        MAX_LIP_SYNC_AUDIO_BYTES,
        "Voice track",
      );
      if (!ALLOWED_LIP_SYNC_AUDIO_TYPES.has(audio.mimeType)) {
        throw new VideoJobInputError(
          "Unsupported voice track type. Please upload an MP3, M4A, WAV, or OGG file.",
        );
      }
    } else {
      const script = job.prompt?.trim();
      if (!script) throw new VideoJobInputError("No script provided.");
      // Same voice resolution as topic videos: the kit's cloned brand voice
      // first (behind its own kill switch, whole-track fallback inside the
      // synthesizer), then the chosen or preset stock voice.
      const brandVoiceCloneEnabled = await isFeatureEnabled("brandVoiceClone").catch(() => true);
      const branding = await loadVideoBranding(job.tenantId, options.brandKitId ?? null).catch(
        (err) => {
          logger.warn({ err, jobId: job.id }, "Brand kit lookup failed; using stock voices");
          return null;
        },
      );
      const clonedVoice = brandVoiceCloneEnabled ? (branding?.clonedVoice ?? null) : null;
      const voice = resolveNarrationVoice(options.voice, branding?.presetVoice);
      onStage("Voicing your script");
      const narration = await synthesizeNarration(splitIntoSentences(script), voice, {
        clonedVoice,
        billing: {
          tenantId: job.tenantId,
          refKind: "videoJob",
          refId: String(job.id),
        },
      });
      audio = { buffer: narration.wav, mimeType: "audio/wav" };
    }

    const audioDurationSec = await probeNarrationWavDurationSec(audio.buffer);
    let preparedSource = source;
    if (sourcePath) {
      // Fit uploaded footage to the actual voice-track duration and give the
      // model enough face pixels before spending on it.
      onStage("Preparing your video");
      const prepared = await prepareLipSyncSource(source, audioDurationSec);
      if (prepared.tooSmall) {
        throw new VideoJobInputError(
          `Your video is only ${prepared.height}p. Lip sync needs at least ${MIN_USABLE_HEIGHT}p ` +
            "to redraw a mouth cleanly — please upload a higher-quality clip.",
        );
      }
      if (prepared.excessive) {
        throw new VideoJobInputError(
          `Your script runs about ${Math.ceil(prepared.overrunSec)}s longer than your video. ` +
            "Please shorten the script or upload a longer clip.",
        );
      }
      preparedSource = prepared.video;
    }

    // Lip sync is pinned to Replicate — it is the input contract (a face plus
    // audio) that makes this feature, not an interchangeable video model — so
    // the key is resolved directly rather than via provider selection.
    const replicateDef = getVideoGenProviderDef("replicate");
    const apiKey = replicateDef ? await resolveVideoGenApiKey(replicateDef) : null;
    const modelOverride =
      portraitPath || options.lipSyncQuality === "high"
        ? null
        : await resolveLipSyncModelRef();
    const effectiveLipSyncModel =
      modelOverride?.split(":")[0] || lipSyncDef.model;
    onStage("Syncing the lips");
    await requirePricedVideoCall(
      "replicate",
      effectiveLipSyncModel,
      options.durationSec ?? 5,
      videoPriceCriteria({ hasReferenceVideo: Boolean(sourcePath) }),
    );
    const result = await generateLipSyncWithReplicate(
      { source: preparedSource, audio, def: lipSyncDef },
      apiKey,
      modelOverride,
    );
    const event = await checkpointProviderRender(
      job,
      result,
      "lip_sync",
      options.durationSec ?? 5,
    );
    return {
      // The output keeps the source's own framing, so no aspect
      // normalization: padding someone's footage would only shrink them.
      buffer: result.buffer,
      provider: result.provider,
      model: result.model,
      providerEvents: [event],
      qa: {
        minDurationSec: 0.5,
        expectAudio: true,
        // The synced video must be as long as the voice it was synced to. A
        // model that truncates leaves the end of the script unspoken — which
        // is the failure the matched lengths above exist to prevent, so it is
        // asserted rather than assumed.
        expectedDurationSec: audioDurationSec,
        label: "lip-sync video",
      },
    };
  }

  if (job.engine === "topic_to_video") {
    // Brand kit → video (opt-in, fail-soft): voice for the script, accent
    // for the captions, logo for the corner watermark. Gated by the Brand
    // Video kill switch so already-queued branded jobs render unbranded
    // when the feature is turned off.
    const brandVideoEnabled = await isFeatureEnabled("brandVideo").catch(() => true);
    const branding = await loadVideoBranding(
      job.tenantId,
      brandVideoEnabled ? (options.brandKitId ?? null) : null,
    ).catch(
      (err) => {
        logger.warn({ err, jobId: job.id }, "Brand kit lookup failed; rendering unbranded");
        return null;
      },
    );
    let watermark: Buffer | null = null;
    if (branding?.watermarkPath) {
      try {
        watermark = (
          await loadTenantObject(
            branding.watermarkPath,
            job.tenantId,
            MAX_SOURCE_IMAGE_BYTES,
            "Brand logo",
          )
        ).buffer;
      } catch (err) {
        logger.warn({ err, jobId: job.id }, "Brand logo load failed; skipping watermark");
      }
    }

    // Brand voice (opt-in, fail-soft): narration spoken in the kit's cloned
    // voice. Gated by its own kill switch so already-queued jobs fall back to
    // the stock voices when the feature is turned off; the narration layer
    // additionally falls back whole-track when the provider fails.
    const brandVoiceCloneEnabled = await isFeatureEnabled("brandVoiceClone").catch(() => true);
    const clonedVoice = brandVoiceCloneEnabled ? (branding?.clonedVoice ?? null) : null;
    // An explicit stock-voice choice on the job wins; otherwise the kit's
    // preferred preset voice; otherwise the default narrator.
    const effectiveVoice: NarrationVoice = resolveNarrationVoice(
      options.voice,
      branding?.presetVoice,
    );

    // Reference style (opt-in, fail-soft): a saved profile's pacing and hook
    // shape steer the script writer. A deleted or foreign profile is ignored.
    // Gated by the Reference Styles kill switch so already-queued jobs render
    // unstyled when the feature is turned off.
    // New jobs capture legacy profile guidance in resolvedCreativeBrief at
    // enqueue. Only legacy rows without that snapshot may consult the mutable
    // profile table.
    const referenceStylesEnabled = await isFeatureEnabled("referenceStyles").catch(() => true);
    const referenceStyle =
      !options.resolvedCreativeBrief && referenceStylesEnabled
        ? await loadStyleGuidance(job.tenantId, options.styleProfileId ?? null).catch((err) => {
            logger.warn({ err, jobId: job.id }, "Style profile lookup failed; ignoring it");
            return null;
          })
        : null;
    const visualsSource =
      options.visualsSource === "character"
        ? "character"
        : options.visualsSource === "ai"
          ? "ai"
          : options.visualsSource === "ai_video"
            ? "ai_video"
            : "stock";

    // Curated presenter-overlay templates are topic jobs with a tenant-owned
    // continuous presenter plate. They keep the take's real audio and replace
    // the ordinary TTS/cut-driven topic pipeline with a durable timed B-roll
    // snapshot. The snapshot is persisted before review or render, so retries
    // never re-plan or re-search third-party libraries.
    if (options.presenterVideoPath && options.videoTemplateId) {
      const presenterPath = options.presenterVideoPath;
      if (!presenterPath.startsWith(`/objects/${job.tenantId}/`)) {
        throw new VideoJobInputError("Invalid presenter video path.");
      }
      const uploadedPresenter = await loadTenantObject(
        presenterPath,
        job.tenantId,
        MAX_SOURCE_VIDEO_BYTES,
        "Presenter video",
      );
      if (!ALLOWED_SOURCE_VIDEO_TYPES.has(uploadedPresenter.mimeType)) {
        throw new VideoJobInputError(
          "Unsupported presenter video type. Please upload an MP4, MOV, or WebM video.",
        );
      }
      const script = job.prompt?.trim();
      if (!script) throw new VideoJobInputError("No presenter script provided.");

      onStage("Preparing the presenter video");
      const presenterVideo = await normalizeVideo(uploadedPresenter.buffer, aspectRatio);
      const stockSource = isStockSourceChoice(options.stockSource) ? options.stockSource : "auto";
      let snapshot = options.presenterBroll;
      if (!snapshot) {
        throw new VideoJobInputError(
          "This presenter job has no funded B-roll plan. Start a new generation.",
        );
      }
      // Review is planning-only. Resolve stock/generated assets only after the
      // user approves, so a discard or expiry cannot leave provider spend.
      if (!job.storyboard && options.reviewStoryboard) {
        return { paused: true, storyboard: presenterStoryboard(snapshot) };
      }
      let presenterEvents: VideoProviderEvent[] = unaccountedPresenterBrollEvents(snapshot);
      const checkpoint = async (next: typeof snapshot) => {
        snapshot = next;
        presenterEvents = unaccountedPresenterBrollEvents(next);
        await setJob(job.id, {
          options: { ...options, presenterBroll: next },
        });
      };
      try {
        if (job.storyboard) {
          snapshot = await syncReviewedPresenterBroll({
            snapshot,
            storyboard: job.storyboard,
            aspectRatio,
            visualsSource,
            stockSource,
            upload: (bytes, contentType) => uploadToStorage(job.tenantId, bytes, contentType),
            load: async (objectPath) =>
              (
                await loadTenantObject(
                  objectPath,
                  job.tenantId,
                  MAX_SOURCE_VIDEO_BYTES,
                  "Presenter B-roll asset",
                )
              ).buffer,
            onStage,
            onCheckpoint: checkpoint,
          });
        }
        snapshot = await resolvePresenterBrollAssets({
          snapshot,
          aspectRatio,
          visualsSource,
          stockSource,
          upload: (bytes, contentType) => uploadToStorage(job.tenantId, bytes, contentType),
          load: async (objectPath) =>
            (
              await loadTenantObject(
                objectPath,
                job.tenantId,
                MAX_SOURCE_VIDEO_BYTES,
                "Presenter B-roll asset",
              )
            ).buffer,
          onStage,
          onCheckpoint: checkpoint,
        });
        presenterEvents = unaccountedPresenterBrollEvents(snapshot);
        await setJob(job.id, {
          options: { ...options, presenterBroll: snapshot },
          ...(job.storyboard ? { storyboard: presenterStoryboard(snapshot) } : {}),
        });

        let buffer = await renderPresenterBroll({
          presenterVideo,
          snapshot,
          aspectRatio,
          subtitles: options.subtitles ?? true,
          captionStyle: options.captionStyle === "dynamic" ? "dynamic" : "classic",
          accentColor: branding?.accentColor ?? null,
          watermark,
          load: async (objectPath, assetKind) => {
            const asset = await loadTenantObject(
              objectPath,
              job.tenantId,
              assetKind === "image" ? MAX_SOURCE_IMAGE_BYTES : MAX_SOURCE_VIDEO_BYTES,
              "Presenter B-roll asset",
            );
            const allowed =
              assetKind === "image"
                ? ALLOWED_IMAGE_TYPES.has(asset.mimeType)
                : ALLOWED_SOURCE_VIDEO_TYPES.has(asset.mimeType);
            if (!allowed) {
              throw new VideoJobInputError("A saved presenter B-roll asset has an unsupported type.");
            }
            return asset.buffer;
          },
          onStage,
        });
        let music: Buffer | null = null;
        if (options.musicPath) {
          music = await resolveMusic(
            job,
            { ...options, musicPrompt: null },
            snapshot.durationMs / 1000,
            onStage,
          );
        } else if (options.musicPrompt?.trim()) {
          const saved = options.presenterMusicCheckpoint;
          if (saved?.path) {
            music = (
              await loadTenantObject(saved.path, job.tenantId, MAX_MUSIC_BYTES, "Saved music")
            ).buffer;
            if (!saved.event.accounted) presenterEvents.push(saved.event);
          } else {
            onStage("Composing the music");
            const requestedDurationSec = musicGenDurationSec(snapshot.durationMs / 1000);
            const criteria = videoPriceCriteria({});
            await requirePricedVideoCall(
              "replicate",
              MUSICGEN_MODEL,
              requestedDurationSec,
              criteria,
            );
            music = await generateMusicBed(options.musicPrompt, snapshot.durationMs / 1000);
            const event: VideoProviderEvent = {
              eventId: videoProviderEventId(job, "presenter_music"),
              provider: "replicate",
              model: MUSICGEN_MODEL,
              durationSec: requestedDurationSec,
              requestBytes: Buffer.byteLength(options.musicPrompt),
              label: "presenter_music",
              criteria,
              costPaise: await computeVideoCostPaise({
                provider: "replicate",
                model: MUSICGEN_MODEL,
                durationSec: requestedDurationSec,
                variantCriteria: criteria,
              }).catch(() => null),
            };
            presenterEvents.push(event);
            const checkpoint = {
              provider: "replicate",
              model: MUSICGEN_MODEL,
              durationSec: requestedDurationSec,
              event,
            };
            await setJob(job.id, {
              options: { ...options, presenterBroll: snapshot, presenterMusicCheckpoint: checkpoint },
            });
            const path = await uploadToStorage(job.tenantId, music, "audio/mpeg");
            await setJob(job.id, {
              options: {
                ...options,
                presenterBroll: snapshot,
                presenterMusicCheckpoint: { ...checkpoint, path },
              },
            });
          }
        }
        if (music) buffer = await mixMusicIntoVideo(buffer, music);
        return {
          buffer,
          provider: null,
          model: null,
          // An empty list is intentional: stock-only presenter jobs have zero
          // paid video provider events rather than an unknown synthetic ffmpeg event.
          providerEvents: presenterEvents,
          qa: {
            expectedDurationSec: snapshot.durationMs / 1000,
            expectAudio: true,
            label: "presenter B-roll video",
          },
        };
      } catch (error) {
        throw new PartialVideoProviderWorkError(presenterEvents, error);
      }
    }

    // Script variant: chosen in the studio, layered over the shared script
    // rules by the Prompt Kit. An unknown value degrades to the base prompt
    // rather than failing the job.
    const scriptVariant = isPromptVariantKey(options.scriptVariant)
      ? options.scriptVariant
      : null;
    const creative = compileCreativeBrief(options.resolvedCreativeBrief);
    const compiledReferenceStyle = [
      referenceStyle,
      creative.script,
      creative.storyboard,
      creative.stock,
    ].filter(Boolean).join("\n") || null;

    const reviewable = topicStoryboardEligible(job);

    // Hybrid templates deliberately have their own planner: one narrated script
    // is recorded once, then its complete cue sequence is partitioned into the
    // portable character/animation role pattern before the review pause.
    if (!job.storyboard && options.hybridStory) {
      const hybrid = options.hybridStory;
      if (hybrid.lipSyncConsent !== true) {
        throw new VideoJobInputError("This hybrid story is missing recorded lip-sync consent.");
      }
      const drafted = await planTopicStoryboard({
        characterSnapshot: options.characterSnapshot,
        tenantId: job.tenantId, topic: job.prompt ?? "", aspectRatio, voice: effectiveVoice, clonedVoice,
        paragraphCount: options.paragraphCount ?? 1, templateRuntime: options.templateRuntime ?? null,
        visualsSource: "ai_video", characterId: null, outfitId: null, wardrobeNotes: null,
        brandVoice: branding?.voiceHint ?? null, referenceStyle: compiledReferenceStyle,
        creativeVisualGuidance: creative.visual, scriptVariant,
        suppliedPlan: null, materializePreviews: false,
        upload: (bytes, contentType) => uploadToStorage(job.tenantId, bytes, contentType), onStage,
      });
      if (!drafted.narration) throw new VideoJobInputError("Hybrid planner did not create narration.");
      const planned = planHybridStoryBeats({
        pattern: hybrid.pattern,
        sentences: drafted.narration.cues.map((cue) => cue.text),
      });
      let cueOffset = 0;
      const scenes = planned.map((beat, index) => {
        const count = splitIntoSentences(beat.text).length;
        const start = drafted.narration!.cues[cueOffset]?.startSec;
        cueOffset += count;
        const end = cueOffset < drafted.narration!.cues.length
          ? drafted.narration!.cues[cueOffset]!.startSec
          : drafted.narration!.totalDurationSec;
        if (start === undefined || end <= start) throw new VideoJobInputError("Hybrid planner produced invalid cue coverage.");
        const maxDuration = hybrid.pattern[beat.patternIndex]?.maxDurationSeconds;
        if (!maxDuration || end - start > maxDuration + 0.1) {
          throw new VideoJobInputError(
            `Hybrid ${beat.role} exceeds its template timing limit after narration was voiced.`,
          );
        }
        return {
          id: `h${index + 1}`, text: beat.text, visual: beat.visual, durationSec: end - start,
          previewPath: null, outfitId: beat.type === "character_speaking" ? hybrid.outfitId : null,
          beatType: beat.type, hybridRole: beat.role, patternIndex: beat.patternIndex,
        };
      });
      if (cueOffset !== drafted.narration.cues.length) {
        throw new VideoJobInputError("Hybrid planner did not assign all narration cues.");
      }
      const storyboard: VideoStoryboard = {
        ...drafted, mode: "hybrid_character_story", visualsSource: "ai_video", timelineLocked: true,
        durationBounds: null, scenes,
      };
      storyboard.narration!.event = {
        eventId: videoProviderEventId(job, "hybrid_narration"),
        provider: drafted.narration.provider ?? "tts",
        model: drafted.narration.model ?? effectiveVoice,
        durationSec: storyboard.narration!.totalDurationSec,
        requestBytes: Buffer.byteLength(storyboard.narration!.cues.map((cue) => cue.text).join(" ")),
        label: "hybrid_narration",
        costPaise: drafted.narration.costPaise ?? null,
        accountingMode: drafted.narration.accountingMode ?? "unmetered",
        unitWeight: hasDeferredTemplateFunding(job) ? 1 : undefined,
      };
      assertHybridStoryBeatPlan(planned.map((beat, index) => ({
        ...beat, startSec: scenes.slice(0, index).reduce((sum, scene) => sum + scene.durationSec, 0),
        endSec: scenes.slice(0, index + 1).reduce((sum, scene) => sum + scene.durationSec, 0),
      })));
      const funded = await fundPlannedTemplateVisualWork(job, storyboard);
      if (!funded.funded) return { paused: true, storyboard, fundingError: funded.error };
      await setJob(job.id, { storyboard, options: funded.job.options });
      if (options.reviewStoryboard !== false) return { paused: true, storyboard };
      return produceVideo({ ...job, storyboard, options: funded.job.options }, onStage);
    }

    // A storyboard already on the row means this run is the resume: the plan
    // was approved, so render it instead of planning again.
    if (job.storyboard) {
      let board = job.storyboard;
      const creativeIssues = lintStoryboardCreativeBrief(board, options.resolvedCreativeBrief);
      if (creativeIssues.length > 0) {
        throw new VideoJobInputError(
          `Storyboard cannot render until its creative brief issues are fixed: ${creativeIssues
            .map((issue) => `"${issue.term}"`)
            .join(", ")}.`,
        );
      }
      const legacyPrivacy = options.recovery?.privacyRecovery;
      if (legacyPrivacy) {
        const scene = board.scenes.find((candidate) => candidate.id === legacyPrivacy.sceneId);
        if (
          !scene ||
          scene.privacyRecovery?.status !== "pending" ||
          legacyPrivacy.code !== OPENROUTER_INPUT_IMAGE_PRIVACY_CODE
        ) {
          throw new VideoJobInputError(
            "The saved privacy-recovery scene changed before generation could resume.",
          );
        }
        await recoverGeneratedStoryboardKeyframe({
          job,
          storyboard: board,
          scene,
          aspectRatio,
          error: new OpenRouterInputImagePrivacyError(scene.privacyRecovery.inputIndex),
        });
      }
      if (board.mode === "hybrid_character_story") {
        const hybrid = options.hybridStory;
        if (!hybrid || hybrid.lipSyncConsent !== true) {
          throw new VideoJobInputError("This hybrid story is missing recorded lip-sync consent.");
        }
        if (!hybrid.characterSnapshot) {
          throw new VideoJobInputError("This hybrid story is missing its immutable character snapshot.");
        }
        const refreshed = await refreshEditedNarration({
          tenantId: job.tenantId,
          storyboard: board,
          voice: effectiveVoice,
          clonedVoice,
          upload: (bytes, contentType) => uploadToStorage(job.tenantId, bytes, contentType),
          onStage,
          maxSceneDurationSec: (scene) =>
            hybrid.pattern[scene.patternIndex ?? -1]?.maxDurationSeconds ?? null,
        });
        if (refreshed) {
          board = {
            ...refreshed,
            narration: refreshed.narration
              ? {
                  ...refreshed.narration,
                  event: {
                    eventId: videoProviderEventId(job, "hybrid_narration_review"),
                    provider: refreshed.narration.provider ?? "tts",
                    model: refreshed.narration.model ?? effectiveVoice,
                    durationSec: refreshed.narration.totalDurationSec,
                    requestBytes: Buffer.byteLength(
                      refreshed.narration.cues.map((cue) => cue.text).join(" "),
                    ),
                    label: "hybrid_narration_review",
                    costPaise: refreshed.narration.costPaise ?? null,
                    accountingMode: refreshed.narration.accountingMode ?? "unmetered",
                    unitWeight: hasDeferredTemplateFunding(job) ? 1 : undefined,
                  },
                }
              : null,
          };
          await setJob(job.id, { storyboard: board });
        }
        const beats = board.scenes.map((scene) => ({
          id: scene.id,
          type: scene.beatType ?? "story_animation",
          role: scene.hybridRole ?? "story_animation",
          patternIndex: scene.patternIndex ?? 0,
          text: scene.text,
          visual: scene.visual,
          startSec: 0,
          endSec: scene.durationSec,
        }));
        // Rebuild offsets from the persisted narration rather than trusting an
        // editable duration field.  Opening, closing and role order are hard
        // constraints of the selected portable template.
        let timeline = 0;
        for (const beat of beats) {
          const maxDuration = hybrid.pattern[beat.patternIndex]?.maxDurationSeconds;
          if (!maxDuration || beat.endSec > maxDuration + 0.1) {
            throw new VideoJobInputError("A hybrid beat exceeds its immutable pattern duration.");
          }
          beat.startSec = timeline;
          timeline += beat.endSec;
          beat.endSec = timeline;
        }
        assertHybridStoryBeatPlan(beats);
        if (!board.narration) throw new VideoJobInputError("Hybrid storyboard has no shared narration.");
        const ranges = hybridCueRanges(board);
        const narrationWav = (await loadTenantObject(
          board.narration.audioPath, job.tenantId, MAX_NARRATION_BYTES, "Hybrid narration",
        )).buffer;
        const clips: Buffer[] = [];
        const events: VideoProviderEvent[] = board.scenes.flatMap((scene) =>
          previewCheckpointEvents(scene.previewCheckpoint),
        );
        if (hybridNarrationIsAggregateOwned(board.narration.event?.accountingMode) &&
          board.narration.event) events.push(board.narration.event);
        for (const [index, scene] of board.scenes.entries()) {
          let sceneOperation = "scene_setup";
          try {
          const range = ranges[index]!;
          const startSec = board.narration.cues[range.start]!.startSec;
          const endSec = range.end < board.narration.cues.length
            ? board.narration.cues[range.end]!.startSec
            : board.narration.totalDurationSec;
          const narration = hybridNarrationSlice(narrationWav, startSec, endSec);
          const targetSec = endSec - startSec;
          if (scene.providerCheckpoint?.path && !scene.providerCheckpoint.event.label.startsWith("hybrid_plate:")) {
            clips.push((await loadTenantObject(
              scene.providerCheckpoint.path, job.tenantId, MAX_SOURCE_VIDEO_BYTES, "Saved hybrid beat",
            )).buffer);
            events.push(scene.providerCheckpoint.event);
            continue;
          }
          if (scene.beatType === "story_animation") {
            onStage(`Animating story beat ${scene.id}`);
            let still: Buffer;
            if (scene.previewPath) {
              still = (await loadTenantObject(scene.previewPath, job.tenantId, MAX_SOURCE_IMAGE_BYTES, "Hybrid keyframe")).buffer;
            } else {
              sceneOperation = "storyboard_image_generation";
              const generated = await generateBrollStills({ prompts: [scene.visual], aspectRatio });
              still = generated.images[0]!;
              const imageEvent: VideoProviderEvent = {
                eventId: videoProviderEventId(job, `hybrid_keyframe:${scene.id}`),
                provider: generated.provider, model: generated.model, durationSec: null,
                requestBytes: Buffer.byteLength(scene.visual), label: `hybrid_keyframe:${scene.id}`,
                costPaise: await computeImageCostPaise({ provider: generated.provider, model: generated.model }).catch(() => null),
                unitWeight: hasDeferredTemplateFunding(job) ? 1 : undefined,
              };
              scene.previewCheckpoint = { targetPath: "", status: "provider_succeeded", event: imageEvent };
              await setJob(job.id, { storyboard: board });
              scene.previewPath = await uploadToStorage(job.tenantId, still, "image/png");
              scene.previewCheckpoint = { ...scene.previewCheckpoint, targetPath: scene.previewPath, status: "complete" };
              await setJob(job.id, { storyboard: board });
              events.push(imageEvent);
            }
            sceneOperation = "image_to_video_animation";
            const animated = await animateBrollStills({
              images: [still], visuals: [scene.visual],
              scenes: [{ firstCue: 0, lastCue: 0, durationSec: targetSec, text: scene.text }],
              aspectRatio, motionPreset: options.motionPreset ?? null,
              cinematography: options.cinematography ?? null, seed: options.seed ?? null, modelOptions: model,
              onPrivacyImageRejected: async ({ error }) => {
                const recovered = await recoverGeneratedStoryboardKeyframe({
                  job,
                  storyboard: board,
                  scene,
                  aspectRatio,
                  error,
                });
                events.push(recovered.event);
                return recovered.still;
              },
            });
            const clip = animated.clips[0]!;
            const providerDurationSec = animated.effectiveDurationSecs[0] ?? targetSec;
            const event: VideoProviderEvent = {
              eventId: videoProviderEventId(job, `hybrid_animation:${scene.id}`),
              provider: animated.provider, model: animated.model, durationSec: providerDurationSec,
              requestBytes: Buffer.byteLength(scene.visual), label: `hybrid_animation:${scene.id}`,
              criteria: jobVideoPriceCriteria(job),
              costPaise: await computeVideoCostPaise({ provider: animated.provider, model: animated.model, durationSec: providerDurationSec, variantCriteria: jobVideoPriceCriteria(job) }).catch(() => null),
              unitWeight: hasDeferredTemplateFunding(job) ? 1 : undefined,
            };
            scene.providerCheckpoint = { path: await uploadToStorage(job.tenantId, clip, "video/mp4"), provider: animated.provider, model: animated.model, durationSec: providerDurationSec, event };
            await setJob(job.id, { storyboard: board });
            clips.push(clip); events.push(event);
          } else {
            onStage(`Rendering character beat ${scene.id}`);
            const savedPlate = scene.providerCheckpoint?.event.label === `hybrid_plate:${scene.id}`
              ? scene.providerCheckpoint
              : null;
            const plate = savedPlate
              ? {
                  buffer: (await loadTenantObject(savedPlate.path, job.tenantId, MAX_SOURCE_VIDEO_BYTES, "Saved hybrid plate")).buffer,
                  provider: savedPlate.provider,
                  model: savedPlate.model,
                  effectiveDurationSec: savedPlate.durationSec,
                }
              : await (async () => {
                sceneOperation = "character_plate_generation";
                return generateCharacterClip({
                tenantId: job.tenantId, characterId: hybrid.characterId, outfitId: hybrid.outfitId,
                snapshot: hybrid.characterSnapshot,
                prompt: lipSyncSourcePlatePrompt(scene.visual), aspectRatio, durationSec: Math.min(30, targetSec + .35),
                 model,
                keyframe: scene.previewPath
                  ? (await loadTenantObject(scene.previewPath, job.tenantId, MAX_SOURCE_IMAGE_BYTES, "Saved hybrid character keyframe")).buffer
                  : null,
                onKeyframeProviderSuccess: async (keyframe) => {
                  const keyframeEvent: VideoProviderEvent = {
                    eventId: videoProviderEventId(job, `hybrid_character_keyframe:${scene.id}`),
                    provider: keyframe.provider, model: keyframe.model, durationSec: null,
                    requestBytes: Buffer.byteLength(scene.visual),
                    label: `hybrid_character_keyframe:${scene.id}`,
                    costPaise: await computeImageCostPaise({
                      provider: keyframe.provider, model: keyframe.model,
                      inputTokens: keyframe.usage?.inputTokens, outputTokens: keyframe.usage?.outputTokens,
                    }).catch(() => null),
                    unitWeight: hasDeferredTemplateFunding(job) ? 1 : undefined,
                  };
                  // This image is the retry input for generateCharacterClip.
                  // Store its receipt before any later plate/video call.
                  scene.previewCheckpoint = { targetPath: "", status: "provider_succeeded", event: keyframeEvent };
                  await setJob(job.id, { storyboard: board });
                  scene.previewPath = await uploadToStorage(job.tenantId, keyframe.buffer, "image/png");
                  scene.previewCheckpoint = {
                    ...scene.previewCheckpoint, targetPath: scene.previewPath, status: "complete",
                  };
                  await setJob(job.id, { storyboard: board });
                  events.push(keyframeEvent);
                },
                });
              })();
            const plateDurationSec = plate.effectiveDurationSec ?? targetSec;
            const plateEvent: VideoProviderEvent = savedPlate?.event ?? {
              eventId: videoProviderEventId(job, `hybrid_plate:${scene.id}`), provider: plate.provider, model: plate.model,
              durationSec: plateDurationSec, requestBytes: Buffer.byteLength(scene.visual), label: `hybrid_plate:${scene.id}`,
              criteria: jobVideoPriceCriteria(job),
              costPaise: await computeVideoCostPaise({ provider: plate.provider, model: plate.model, durationSec: plateDurationSec, variantCriteria: jobVideoPriceCriteria(job) }).catch(() => null),
              unitWeight: hasDeferredTemplateFunding(job) ? 1 : undefined,
            };
            if (!savedPlate) {
              // Persist the acknowledged plate receipt before the external lip-sync call.
              scene.providerCheckpoint = { path: await uploadToStorage(job.tenantId, plate.buffer, "video/mp4"), provider: plate.provider, model: plate.model, durationSec: plateDurationSec, event: plateEvent };
              await setJob(job.id, { storyboard: board });
            }
            const latest = (await db.select({ options: videoGenerationsTable.options }).from(videoGenerationsTable)
              .where(eq(videoGenerationsTable.id, job.id)).limit(1))[0];
            if (latest?.options?.hybridStory?.lipSyncConsent !== true) {
              throw new VideoJobInputError("Hybrid lip-sync consent was withdrawn before rendering.");
            }
            const lipDef = lipSyncModelForQuality(options.lipSyncQuality);
            await requirePricedVideoCall("replicate", lipDef.model, targetSec, videoPriceCriteria({ hasReferenceVideo: true }));
            sceneOperation = "lip_sync";
            const synced = await generateLipSyncWithReplicate({
              source: { buffer: await loopVideoPlateToDuration(plate.buffer, targetSec + .35), mimeType: "video/mp4" },
              audio: { buffer: narration, mimeType: "audio/wav" }, def: lipDef,
            }, (await (async () => {
              const def = getVideoGenProviderDef("replicate");
              return def ? resolveVideoGenApiKey(def) : null;
            })()));
            sceneOperation = "scene_normalization";
            const normalized = await normalizeVideo(synced.buffer, aspectRatio);
            sceneOperation = "scene_composition";
            const trimmed = await trimCharacterDialogueClipStrict(
              normalized,
              targetSec,
              narration,
            );
            const lipEvent: VideoProviderEvent = {
              eventId: videoProviderEventId(job, `hybrid_lip_sync:${scene.id}`), provider: synced.provider, model: synced.model,
              durationSec: targetSec, requestBytes: narration.length, label: `hybrid_lip_sync:${scene.id}`,
              criteria: videoPriceCriteria({ hasReferenceVideo: true }),
              costPaise: await computeVideoCostPaise({ provider: synced.provider, model: synced.model, durationSec: targetSec, variantCriteria: videoPriceCriteria({ hasReferenceVideo: true }) }).catch(() => null),
              unitWeight: hasDeferredTemplateFunding(job) ? 1 : undefined,
            };
            // providerCheckpoint has one slot (the reusable final clip); retain
            // the prior plate receipt beside it so success settlement and a
            // later retry both retain every acknowledged provider operation.
            scene.previewCheckpoint = {
              targetPath: scene.previewCheckpoint?.targetPath ?? "",
              status: scene.previewCheckpoint?.status ?? "complete",
              events: [...previewCheckpointEvents(scene.previewCheckpoint), plateEvent],
            };
            scene.providerCheckpoint = { path: await uploadToStorage(job.tenantId, trimmed, "video/mp4"), provider: synced.provider, model: synced.model, durationSec: targetSec, event: lipEvent };
            await setJob(job.id, { storyboard: board });
            clips.push(trimmed); events.push(plateEvent, lipEvent);
          }
          } catch (error) {
            await recordSceneFailure(
              { ...job, storyboard: board },
              scene,
              sceneOperation,
              error instanceof PartialVideoProviderWorkError
                ? error.cause
                : error,
              scene.providerCheckpoint?.provider ??
                scene.previewCheckpoint?.event?.provider ??
                null,
              scene.providerCheckpoint?.model ??
                scene.previewCheckpoint?.event?.model ??
                null,
            );
            throw error;
          }
        }
        const final = await composeTopicVideo({
          clips, narrationWav, cues: board.narration.cues, totalDurationSec: board.narration.totalDurationSec,
          aspectRatio, subtitles: options.subtitles ?? true,
          captionStyle: options.captionStyle === "dynamic" ? "dynamic" : "classic",
          music: await resolveMusic(job, options, 30, onStage),
          accentColor: branding?.accentColor ?? null, watermark,
          sceneMap: board.scenes.map((_, index) => {
            const r = ranges[index]!;
            const start = board.narration!.cues[r.start]!.startSec;
            const end = r.end < board.narration!.cues.length ? board.narration!.cues[r.end]!.startSec : board.narration!.totalDurationSec;
            return { clipIndex: index, durationSec: end - start };
          }),
        });
        return { buffer: final, provider: "hybrid", model: "mixed", providerEvents: events,
          qa: { expectedDurationSec: board.narration.totalDurationSec, expectAudio: true, label: "hybrid character story" } };
      }
      // Deferred template previews are paid provider work. Mint and durably
      // record each destination before its provider call so a crash can never
      // silently turn a completed image into a second generation.
      const previewUploadUrls = new Map<string, string>();
      const previewAttemptIds = new WeakMap<object, string>();
      if (
        hasDeferredTemplateFunding(job) &&
        (board.mode === "guided_story" || board.visualsSource === "ai" || board.visualsSource === "ai_video" || board.visualsSource === "character")
      ) {
        for (const scene of board.scenes) {
          // Backward compatibility: boards materialized before preview
          // checkpoints existed already hold a usable paid preview. Reuse it
          // rather than clearing the path and charging for a replacement.
          if (scene.previewPath && !scene.previewCheckpoint) continue;
          if (scene.previewCheckpoint?.status === "complete" && scene.previewPath) continue;
          if (scene.previewCheckpoint?.status === "provider_succeeded") {
            const events = previewCheckpointEvents(scene.previewCheckpoint);
            if (events.length === 0) throw new VideoGenProviderError("Preview checkpoint is missing its provider receipt.");
            if (await objectExists(scene.previewCheckpoint.targetPath, job.tenantId)) {
              board = {
                ...board,
                scenes: board.scenes.map((candidate) => candidate.id === scene.id
                  ? { ...candidate, previewPath: scene.previewCheckpoint!.targetPath,
                    previewCheckpoint: { ...scene.previewCheckpoint!, status: "complete" } }
                  : candidate),
              };
              await setJob(job.id, { storyboard: board });
              continue;
            }
            throw new PartialVideoProviderWorkError(events, new VideoGenProviderError(
              "A generated storyboard preview could not be saved; it will not be regenerated.",
            ));
          }
          const uploadURL = await objectStorageService.getObjectEntityUploadURL(job.tenantId);
          const targetPath = objectStorageService.normalizeObjectEntityPath(uploadURL);
          previewUploadUrls.set(scene.id, uploadURL);
          board = {
            ...board,
            scenes: board.scenes.map((candidate) => candidate.id === scene.id
              ? { ...candidate, previewPath: null, previewCheckpoint: { targetPath, status: "prepared" } }
              : candidate),
          };
          await setJob(job.id, { storyboard: board });
        }
      }
      if (
        board.mode === "character_story" &&
        (!board.narration || board.scenes.some((scene) => !scene.previewPath))
      ) {
        if (!options.characterId) {
          throw new VideoJobInputError(
            "The approved Character Story no longer has a selected character.",
          );
        }
        board = await prepareCharacterStoryStoryboard({
          tenantId: job.tenantId,
          storyboard: board,
          characterId: options.characterId,
          selectedOutfitId: options.outfitId ?? 0,
          characterSnapshot: options.characterSnapshot,
          voice: effectiveVoice,
          clonedVoice,
          aspectRatio,
          upload: (bytes, contentType) =>
            uploadToStorage(job.tenantId, bytes, contentType),
          onCheckpoint: async (checkpoint) => {
            board = checkpoint;
            await setJob(job.id, { storyboard: checkpoint });
          },
          ...(hasDeferredTemplateFunding(job)
            ? {
                onKeyframeProviderSuccess: async ({ sceneIndex, attemptIndex, result }: {
                  sceneIndex: number;
                  attemptIndex: number;
                  result: import("../imageGen/types").ImageGenResult;
                }) => {
                  const scene = board.scenes[sceneIndex]!;
                  const checkpoint = scene.previewCheckpoint;
                  if (!checkpoint || checkpoint.status === "complete") {
                    throw new VideoGenProviderError("Character preview checkpoint was not prepared.");
                  }
                  const events = previewCheckpointEvents(checkpoint);
                  const operation = `storyboard_preview:${scene.id}:attempt:${events.length + 1}`;
                  const event: VideoProviderEvent = {
                    eventId: videoProviderEventId(job, operation),
                    provider: result.provider,
                    model: result.model,
                    durationSec: null,
                    requestBytes: Buffer.byteLength(scene.visual),
                    label: operation,
                    costPaise: await computeImageCostPaise({
                      provider: result.provider,
                      model: result.model,
                      inputTokens: result.usage?.inputTokens,
                      outputTokens: result.usage?.outputTokens,
                    }).catch(() => null),
                    unitWeight: attemptIndex === 0 ? videoModelMultiplier(options.modelId) : 0,
                  };
                  previewAttemptIds.set(result, event.eventId!);
                  events.push(event);
                  board = {
                    ...board,
                    scenes: board.scenes.map((candidate, i) => i === sceneIndex
                      ? { ...candidate, previewCheckpoint: {
                          ...checkpoint, status: "provider_succeeded", events, event: undefined,
                        } }
                      : candidate),
                  };
                  await setJob(job.id, { storyboard: board });
                },
                onKeyframeProviderFailure: async ({ sceneIndex, error }: {
                  sceneIndex: number;
                  attemptIndex: number;
                  error: unknown;
                }) => {
                  await recordSceneFailure(
                    { ...job, storyboard: board },
                    board.scenes[sceneIndex]!,
                    "storyboard_preview",
                    error,
                  );
                },
                uploadKeyframe: async ({ sceneIndex, result }: {
                  sceneIndex: number;
                  result: import("../imageGen/types").ImageGenResult;
                }) => {
                  const scene = board.scenes[sceneIndex]!;
                  const checkpoint = scene.previewCheckpoint;
                  if (!checkpoint || checkpoint.status !== "provider_succeeded") {
                    throw new VideoGenProviderError("Character preview has no provider receipt.");
                  }
                  const uploadURL = previewUploadUrls.get(scene.id);
                  if (!uploadURL) throw new VideoGenProviderError("Character preview upload target is unavailable.");
                  const previewPath = await uploadToPreparedOrFreshStorage(
                    job.tenantId,
                    uploadURL,
                    result.buffer,
                    "image/png",
                  );
                  board = {
                    ...board,
                    scenes: board.scenes.map((candidate, i) => i === sceneIndex
                      ? { ...candidate, previewPath, previewCheckpoint: {
                          ...checkpoint,
                          targetPath: previewPath,
                          status: "complete",
                          selectedEventId: previewAttemptIds.get(result),
                        } }
                      : candidate),
                  };
                  await setJob(job.id, { storyboard: board });
                  return previewPath;
                },
              }
            : {}),
          onStage,
        });
        await setJob(job.id, { storyboard: board });
      }
      // Deferred template planning intentionally stores a preview-less board:
      // its prompts are immutable, but no paid still is made until the exact
      // visual workload is funded. Materialize those same prompts on resume;
      // never call the planner again.
      if (
        hasDeferredTemplateFunding(job) &&
        (board.mode === "guided_story" || board.visualsSource === "ai" || board.visualsSource === "ai_video") &&
        board.scenes.some((scene) => !scene.previewPath)
      ) {
        const priorSelectedImages: Buffer[] = [];
        for (const [sceneIndex, scene] of board.scenes.entries()) {
          if (scene.previewPath) {
            priorSelectedImages.push((
              await loadTenantObject(scene.previewPath, job.tenantId, MAX_SOURCE_IMAGE_BYTES, "Storyboard preview")
            ).buffer);
            continue;
          }
          onStage(
            board.mode === "guided_story"
              ? `Generating guided storyboard frame ${sceneIndex + 1} of ${board.scenes.length}`
              : `Generating storyboard frame ${sceneIndex + 1} of ${board.scenes.length}`,
          );
          const previewPath = await regenerateStoryboardPreview({
            tenantId: job.tenantId,
            storyboard: board,
            scene,
            aspectRatio,
            characterId: null,
            upload: (bytes, contentType) => uploadToStorage(job.tenantId, bytes, contentType),
            priorImages: priorSelectedImages,
            imageSelectionPolicy: options.guidedStory?.imageModelSnapshot,
            onProviderSuccess: async ({ attemptIndex, result }) => {
              const current = board.scenes.find((candidate) => candidate.id === scene.id)!;
              const checkpoint = current.previewCheckpoint;
              if (!checkpoint || checkpoint.status === "complete") {
                throw new VideoGenProviderError("Storyboard preview checkpoint was not prepared.");
              }
              const events = previewCheckpointEvents(checkpoint);
              const operation = `storyboard_preview:${scene.id}:attempt:${events.length + 1}`;
              const event: VideoProviderEvent = {
                eventId: videoProviderEventId(job, operation),
                provider: result.provider,
                model: result.model,
                durationSec: null,
                requestBytes: Buffer.byteLength(scene.visual),
                label: operation,
                costPaise: await computeImageCostPaise({
                  provider: result.provider,
                  model: result.model,
                  inputTokens: result.usage?.inputTokens,
                  outputTokens: result.usage?.outputTokens,
                }).catch(() => null),
                unitWeight: attemptIndex === 0 ? videoModelMultiplier(options.modelId) : 0,
              };
              previewAttemptIds.set(result, event.eventId!);
              events.push(event);
              board = {
                ...board,
                scenes: board.scenes.map((candidate) => candidate.id === scene.id
                  ? { ...candidate, previewCheckpoint: {
                      ...checkpoint, status: "provider_succeeded", events, event: undefined,
                    } }
                  : candidate),
              };
              await setJob(job.id, { storyboard: board });
            },
            onProviderFailure: async ({ error }) => {
              const current = board.scenes.find((candidate) => candidate.id === scene.id)!;
              await recordSceneFailure(
                { ...job, storyboard: board },
                current,
                "storyboard_preview",
                error,
              );
            },
            uploadGenerated: async (result) => {
              const current = board.scenes.find((candidate) => candidate.id === scene.id)!;
              const checkpoint = current.previewCheckpoint;
              const uploadURL = previewUploadUrls.get(scene.id);
              if (!checkpoint || checkpoint.status !== "provider_succeeded" || !uploadURL) {
                throw new VideoGenProviderError("Storyboard preview has no provider receipt.");
              }
              const previewPath = await uploadToPreparedOrFreshStorage(
                job.tenantId,
                uploadURL,
                result.buffer,
                "image/png",
              );
              board = {
                ...board,
                scenes: board.scenes.map((candidate) => candidate.id === scene.id
                  ? { ...candidate, previewPath,
                    previewCheckpoint: {
                      ...checkpoint,
                      targetPath: previewPath,
                      status: "complete",
                      selectedEventId: previewAttemptIds.get(result),
                    } }
                  : candidate),
              };
              await setJob(job.id, { storyboard: board });
              priorSelectedImages.push(result.buffer);
              return previewPath;
            },
          });
          board = {
            ...board,
            scenes: board.scenes.map((candidate) =>
              candidate.id === scene.id ? { ...candidate, previewPath } : candidate,
            ),
          };
          await setJob(job.id, { storyboard: board });
        }
      }
      // Legacy and previously rebuilt Guided Story boards may have lost their
      // narration when only visual references changed. Re-voice from the exact
      // immutable script/voice snapshot before rendering instead of failing
      // after final approval.
      if (board.mode === "guided_story" && !board.narration) {
        const guidedSnapshot = options.guidedStory;
        if (!guidedSnapshot) {
          throw new VideoJobInputError("This Guided Story has no immutable narration snapshot.");
        }
        const narration = await synthesizeGuidedNarration({
          tenantId: job.tenantId,
          cast: guidedSnapshot.cast,
          script: guidedSnapshot.script,
          locale: guidedSnapshot.locale,
          upload: (bytes, contentType) =>
            uploadToStorage(job.tenantId, bytes, contentType),
          fallbackVoice: effectiveVoice,
          onStage,
        });
        board = { ...board, narration };
        await setJob(job.id, { storyboard: board });
      }
      // Scene texts edited (or scenes added) during review desynced the plan
      // from its recording, so re-voice it first. The refreshed narration and
      // recomputed scene lengths are persisted before the render starts —
      // a render retry must resume from the recording it will actually use.
      const refreshed = await refreshEditedNarration({
        tenantId: job.tenantId,
        storyboard: board,
        voice: effectiveVoice,
        clonedVoice,
        upload: (bytes, contentType) => uploadToStorage(job.tenantId, bytes, contentType),
        onStage,
      });
      if (refreshed) {
        await setJob(job.id, { storyboard: refreshed });
      }
      board = refreshed ?? board;
      const topicSceneEvents: VideoProviderEvent[] = board.scenes.flatMap((scene) =>
        [
          ...(scene.providerCheckpoint?.event ? [scene.providerCheckpoint.event] : []),
          ...previewCheckpointEvents(scene.previewCheckpoint),
        ],
      );
      // MusicGen tops out at 30s; the composer loops the bed, so 30 is enough.
      const music = await resolveMusic(job, options, 30, onStage);
      let result;
      try {
      result = await renderTopicStoryboard({
        storyboard: board,
        aspectRatio,
        characterLipSync: options.characterLipSync === true,
        lipSyncedSceneIds: new Set(
          (options.studioLipSync?.plan ?? []).map((scene) => scene.sceneId),
        ),
        subtitles: options.subtitles ?? true,
        captionStyle: options.captionStyle === "dynamic" ? "dynamic" : "classic",
        music,
        accentColor: branding?.accentColor ?? null,
        watermark,
        motionPreset: options.motionPreset ?? null,
        cinematography: options.cinematography ?? null,
        seed: options.seed ?? null,
        modelOptions: model,
        load: async (objectPath) =>
          (
            await loadTenantObject(
              objectPath,
              job.tenantId,
              MAX_NARRATION_BYTES,
              "Storyboard asset",
            )
          ).buffer,
        onStage,
        onPrivacyImageRejected:
          allowsGeneratedStoryboardPrivacyRecovery(board)
            ? async ({ sceneIndex, error }) => {
                const scene = board.scenes[sceneIndex]!;
                const recovered = await recoverGeneratedStoryboardKeyframe({
                  job,
                  storyboard: board,
                  scene,
                  aspectRatio,
                  error,
                });
                topicSceneEvents.push(recovered.event);
                return recovered.still;
              }
            : undefined,
        onCheckpoint: async ({ sceneIndex, buffer, provider, model: sceneModel, durationSec }) => {
          const scene = board.scenes[sceneIndex]!;
          const event: VideoProviderEvent = {
            eventId: videoProviderEventId(job, `topic_scene:${scene.id}`),
            provider,
            model: sceneModel,
            durationSec,
            requestBytes: Buffer.byteLength(scene.visual),
            label: `topic_scene:${scene.id}`,
            criteria: jobVideoPriceCriteria(job),
            costPaise: await computeVideoCostPaise({
              provider,
              model: sceneModel,
              durationSec,
              variantCriteria: jobVideoPriceCriteria(job),
            }).catch(() => null),
            unitWeight:
              hasDeferredTemplateFunding(job)
                ? board.visualsSource === "character"
                  ? 0
                  : videoModelMultiplier(options.modelId)
                : undefined,
          };
          const path = await uploadToStorage(job.tenantId, buffer, "video/mp4");
          scene.providerCheckpoint = { path, provider, model: sceneModel, durationSec, event };
          topicSceneEvents.push(event);
          await db.update(videoGenerationsTable).set({ storyboard: board }).where(eq(videoGenerationsTable.id, job.id));
        },
      });
      } catch (error) {
        // renderTopicStoryboard executes scene work in order for checkpointed
        // boards; the first scene without a receipt is the boundary that
        // failed, rather than a terminal-job guess.
        const failedScene = board.scenes.find((scene) => !scene.providerCheckpoint?.path);
        if (failedScene) {
          await recordSceneFailure(job, failedScene,
            board.visualsSource === "ai_video" ? "image_to_video_animation" : "scene_render",
            error);
        }
        throw error;
      }
      let finalBuffer = result.buffer;
      let presenterEvents: VideoProviderEvent[] = [];
      if (
        board.mode === "character_story" &&
        options.videoTemplateId &&
        options.presenterBroll
      ) {
        let cursorMs = 0;
        let snapshot = {
          ...options.presenterBroll,
          lines: board.scenes.map((scene, index) => {
            const startMs = cursorMs;
            cursorMs += Math.round(scene.durationSec * 1000);
            return { index: index + 1, startMs, endMs: cursorMs, text: scene.text };
          }),
        };
        snapshot = {
          ...snapshot,
          durationMs: cursorMs,
          beats: snapshot.beats.map((beat, index) => {
            const scene = board.scenes.find((candidate) => candidate.id === beat.id);
            return {
              ...beat,
              startMs: snapshot.lines[index]?.startMs ?? beat.startMs,
              endMs: snapshot.lines[index]?.endMs ?? beat.endMs,
              query: scene?.brollVisual?.trim() || beat.query,
              lineIndexes: [index + 1],
            };
          }),
        };
        await setJob(job.id, { options: { ...options, presenterBroll: snapshot } });
        snapshot = await resolvePresenterBrollAssets({
          snapshot,
          aspectRatio,
          visualsSource: "stock",
          stockSource: isStockSourceChoice(options.stockSource) ? options.stockSource : "auto",
          upload: (bytes, contentType) => uploadToStorage(job.tenantId, bytes, contentType),
          load: async (objectPath) =>
            (
              await loadTenantObject(
                objectPath,
                job.tenantId,
                MAX_SOURCE_VIDEO_BYTES,
                "Character Story B-roll asset",
              )
            ).buffer,
          onStage,
          onCheckpoint: async (next) => {
            snapshot = next;
            presenterEvents = unaccountedPresenterBrollEvents(next);
            await setJob(job.id, { options: { ...options, presenterBroll: next } });
          },
        });
        presenterEvents = unaccountedPresenterBrollEvents(snapshot);
        finalBuffer = await renderPresenterBroll({
          presenterVideo: result.buffer,
          snapshot,
          aspectRatio,
          subtitles: false,
          captionStyle: options.captionStyle === "dynamic" ? "dynamic" : "classic",
          accentColor: branding?.accentColor ?? null,
          watermark: null,
          load: async (objectPath, assetKind) =>
            (
              await loadTenantObject(
                objectPath,
                job.tenantId,
                assetKind === "image" ? MAX_SOURCE_IMAGE_BYTES : MAX_SOURCE_VIDEO_BYTES,
                "Character Story B-roll asset",
              )
            ).buffer,
          onStage,
        });
      }
      return {
        buffer: finalBuffer,
        provider: result.provider,
        model: result.model,
        providerEvents: [...topicSceneEvents, ...presenterEvents],
        qa: { expectedDurationSec: result.durationSec, expectAudio: true, label: "topic video" },
      };
    }

    // First run with review asked for: plan, then stop. No music is composed
    // and no clip is animated until the plan is approved.
    if (reviewable) {
      let storyboard = await planTopicStoryboard({
        characterSnapshot: options.characterSnapshot,
        tenantId: job.tenantId,
        topic: job.prompt ?? "",
        approvedScript: options.guidedStory
          ? options.guidedStory.script.scenes
              .flatMap((scene) => scene.lines)
              .map((line) => line.text)
              .join(" ")
          : null,
        guidedStory: options.guidedStory ?? null,
        aspectRatio,
        voice: effectiveVoice,
        clonedVoice,
        paragraphCount: options.paragraphCount ?? 1,
        templateRuntime: options.templateRuntime ?? null,
        visualsSource: reviewable,
        // Framing is planned now and rendered later, so the plan has to know
        // whether these scenes will be synced — a wide shot cannot be.
        characterLipSync: options.characterLipSync === true,
        characterId: options.characterId ?? null,
        outfitId: options.outfitId ?? null,
        wardrobeNotes: options.wardrobeNotes ?? null,
        brandVoice: branding?.voiceHint ?? null,
        referenceStyle: compiledReferenceStyle,
        creativeVisualGuidance: creative.visual,
        scriptVariant,
        suppliedPlan: isSuppliedPlan(options.suppliedPlan) ? options.suppliedPlan : null,
        materializePreviews: !hasDeferredTemplateFunding(job),
        upload: (bytes, contentType) => uploadToStorage(job.tenantId, bytes, contentType),
        onPreviewProviderFailure: async ({ scenes, sceneIndex, error }) => {
          await recordPreviewFailureBoundary(job, scenes, sceneIndex, error);
        },
        onStage,
      });
      let persistedOptions = options;
      if (
        storyboard.mode === "character_story" &&
        options.videoTemplateId &&
        options.characterId
      ) {
        const presenterBroll = characterStoryPresenterBroll(storyboard);
        storyboard = {
          ...storyboard,
          scenes: storyboard.scenes.map((scene, index) => ({
            ...scene,
            brollVisual: presenterBroll.beats[index]?.query ?? scene.text,
          })),
        };
        persistedOptions = { ...options, presenterBroll };
        await setJob(job.id, {
          options: persistedOptions,
        });
      }
      if (hasDeferredTemplateFunding(job)) {
        const fundingResult = await fundPlannedTemplateVisualWork(job, storyboard);
        if (!fundingResult.funded) {
          return { paused: true, storyboard, fundingError: fundingResult.error };
        }
        persistedOptions = fundingResult.job.options!;
      }
      if (options.reviewStoryboard) return { paused: true, storyboard };
      // No-review multi-operation jobs still use the same checkpoint-capable
      // renderer; they simply approve their generated plan immediately. The
      // planner may already have uploaded narration, stills, and character
      // keyframes, so persist the whole board before recursive rendering,
      // MusicGen, composition, or the first scene checkpoint.
      await setJob(job.id, { storyboard, options: persistedOptions });
      return produceVideo({ ...job, storyboard, options: persistedOptions }, onStage);
    }

    // MusicGen tops out at 30s; the composer loops the bed, so 30 is enough.
    const music = await resolveMusic(job, options, 30, onStage);
    const result = await generateTopicVideo({
      tenantId: job.tenantId,
      topic: job.prompt ?? "",
      aspectRatio,
      voice: effectiveVoice,
      clonedVoice,
      stockSource: isStockSourceChoice(options.stockSource) ? options.stockSource : "auto",
      subtitles: options.subtitles ?? true,
      captionStyle: options.captionStyle === "dynamic" ? "dynamic" : "classic",
      paragraphCount: options.paragraphCount ?? 1,
      templateRuntime: options.templateRuntime ?? null,
      music,
      visualsSource,
      characterId: options.characterId ?? null,
      characterLipSync: options.characterLipSync === true,
      outfitId: options.outfitId ?? null,
      wardrobeNotes: options.wardrobeNotes ?? null,
      characterSnapshot: options.characterSnapshot,
      brandVoice: branding?.voiceHint ?? null,
      referenceStyle: compiledReferenceStyle,
      creativeVisualGuidance: creative.visual,
      scriptVariant,
      suppliedPlan: isSuppliedPlan(options.suppliedPlan) ? options.suppliedPlan : null,
      accentColor: branding?.accentColor ?? null,
      watermark,
      motionPreset: options.motionPreset ?? null,
      cinematography: options.cinematography ?? null,
      seed: options.seed ?? null,
      modelOptions: model,
      onStage,
    });
    return {
      buffer: result.buffer,
      provider: result.provider,
      model: result.model,
      qa: {
        expectedDurationSec: result.durationSec,
        expectAudio: true,
        label: "topic video",
      },
    };
  }

  if (job.engine === "localized_dub") {
    // Re-check the kill switch at execution time: a job queued moments before
    // an admin flips the feature off fails through the normal terminal/refund
    // path rather than spending on a disabled feature.
    if (!(await isFeatureEnabled("videoLocalization").catch(() => true))) {
      throw new VideoJobInputError("Video localization is currently turned off.");
    }
    // Lip-sync (LatentSync) kill switch: localized_dub feeds its audio into
    // LatentSync after dubbing, so the lipSync switch gates this path too.
    if (!(await isFeatureEnabled("lipSync").catch(() => true))) {
      throw new VideoJobInputError("Lip-synced videos are currently turned off.");
    }

    const sourcePath = options.sourceVideoPath;
    if (!sourcePath) throw new VideoJobInputError("No source video provided.");

    // Defense-in-depth: re-assert tenant scope at load time (the route already
    // checked, but a hand-crafted DB row or recovery path must never escape it).
    if (!sourcePath.startsWith(`/objects/${job.tenantId}/`)) {
      throw new VideoJobInputError("Invalid source video path.");
    }

    const track = options.localizedTrack;
    if (!track) throw new VideoJobInputError("No localized track provided.");
    if (!track.scriptApproved) {
      throw new VideoJobInputError("Localized dub job is missing script approval.");
    }
    // Defense-in-depth on the consent hard gate (same as lip_sync engine).
    if (track.lipSyncConsent !== true) {
      throw new VideoJobInputError(
        "This job is missing the recorded likeness consent, so it was not generated.",
      );
    }
    if (!track.cues || track.cues.length === 0) {
      throw new VideoJobInputError("Localized dub job has no cues.");
    }
    // Defensive text check: a hand-crafted DB row or buggy migration could
    // sneak in a blank cue that would produce silent audio and confuse the QA
    // gate. Reject before spending any compute.
    for (const c of track.cues) {
      if (!c.text || c.text.trim().length === 0) {
        throw new VideoJobInputError(`Cue ${c.index} has blank text.`);
      }
    }

    const video = await loadTenantObject(
      sourcePath,
      job.tenantId,
      MAX_SOURCE_VIDEO_BYTES,
      "Source video",
    );
    if (!ALLOWED_SOURCE_VIDEO_TYPES.has(video.mimeType)) {
      throw new VideoJobInputError(
        "Unsupported source video type. Please upload an MP4, MOV, or WebM video.",
      );
    }

    const cues: ApprovedDubCue[] = track.cues.map((c) => ({
      index: c.index,
      startMs: c.startMs,
      endMs: c.endMs,
      text: c.text,
    }));

    const voiceMode = track.voiceMode ?? "stock";

    // ----------------------------------------------------------------
    // Build audio + collect orchestration metadata per voiceMode.
    // ----------------------------------------------------------------

    // Snapshot locale before any async helpers (narrows the nullable track once).
    const dubLocale = track.locale;
    const localeLabel = { te: "Telugu", ta: "Tamil", hi: "Hindi" }[dubLocale];
    let repairClientPromise: ReturnType<typeof getTextGenClient> | null = null;
    const repairedCueIndexes = new Map<string, number>();

    /**
     * Repair only the cue that exceeded the real synthesized-audio budget.
     * The original timings stay immutable; the revised text is re-synthesized
     * by the same voice inside orchestrateLocalizedDubFull.
     */
    async function repairOverflowingCue(
      cue: ApprovedDubCue,
      overrunMs: number,
      attempt: number,
    ): Promise<string> {
      if (!repairClientPromise) {
        repairClientPromise = (async () => {
          const tenant = (
            await db
              .select({ aiModel: tenantsTable.aiModel })
              .from(tenantsTable)
              .where(eq(tenantsTable.id, job.tenantId))
              .limit(1)
          )[0];
          return getTextGenClient(tenant?.aiModel ?? "gpt-5.4");
        })();
      }
      const textGen = await repairClientPromise;
      const slotMs = cue.endMs - cue.startMs;
      const completion = await textGen.client.chat.completions.create({
        model: textGen.model,
        messages: [
          {
            role: "system",
            content:
              `You shorten one ${localeLabel} subtitle for spoken timing. Preserve its full meaning, ` +
              "tone, names, numbers, and calls to action. Remove only expendable wording. " +
              "Do not translate it to another language, add facts, merge cues, or explain. " +
              'Reply with JSON only: {"text":"the revised line"}.',
          },
          {
            role: "user",
            content:
              `The line has a ${slotMs} ms slot and remains ${overrunMs} ms too long after the ` +
              `allowed 8% speed-up. Repair attempt ${attempt} of 2.\n\n${cue.text}`,
          },
        ],
        max_completion_tokens: 512,
        response_format: { type: "json_object" },
      });
      const raw = completion.choices[0]?.message?.content ?? "{}";
      const parsed = parseModelJsonObject(raw) as { text?: unknown } | null;
      const revised = typeof parsed?.text === "string" ? parsed.text.trim() : "";
      if (!revised) {
        throw new VideoGenProviderError(
          `Automatic timing repair returned no usable ${localeLabel} text for cue ${cue.index}.`,
        );
      }
      repairedCueIndexes.set(revised, cue.index);
      return revised;
    }

    // Helper: run LatentSync + burn subtitles and return the final video.
    async function lipSyncAndBurn(
      audioBuffer: Buffer,
      audioMime: string,
      burnCues: readonly ApprovedDubCue[],
    ): Promise<Buffer> {
      onStage("Syncing the lips");
      await requirePricedVideoCall(
        "replicate",
        LATENT_SYNC.model,
        Math.max(0.1, lastCueEntry.endMs / 1000),
        videoPriceCriteria({ hasReferenceVideo: true }),
      );
      const replicateDef = getVideoGenProviderDef("replicate");
      const replicateApiKey = replicateDef ? await resolveVideoGenApiKey(replicateDef) : null;
      const ls = await generateLipSyncWithReplicate(
        {
          source: video,
          audio: { buffer: audioBuffer, mimeType: audioMime },
          def: LATENT_SYNC,
        },
        replicateApiKey,
      );
      onStage("Burning subtitles");
      const { burnSubtitles } = await import("../localization/dub");
      return burnSubtitles({
        video: ls.buffer,
        cues: burnCues.map((c) => ({
          index: c.index,
          startMs: c.startMs,
          endMs: c.endMs,
          text: c.text,
        })),
        locale: dubLocale,
      });
    }

    const lastCueEntry = cues[cues.length - 1]!;
    const minDurationSec = Math.max(0, lastCueEntry.endMs / 1000 - 0.25);

    if (voiceMode === "source_voice") {
      // ElevenLabs first transfers the source speaker into the target
      // language. That clean result seeds a temporary voice used to speak the
      // EXACT approved cues, so provider-owned translations can never diverge
      // from the subtitles or immutable result snapshot.
      const brandVoiceCloneEnabled = await isFeatureEnabled("brandVoiceClone").catch(() => true);
      if (!brandVoiceCloneEnabled) {
        throw new VideoJobInputError("Brand voice cloning is currently turned off.");
      }
      const elDef = getVoiceCloneProviderDef("elevenlabs");
      const elApiKey = elDef ? await resolveVoiceCloneApiKey(elDef) : null;
      if (!elDef || !elApiKey) {
        throw new VideoGenNotConfiguredError(
          "Source-voice dubbing requires the ElevenLabs API key. " +
            "Ask an administrator to add it in the admin dashboard.",
        );
      }
      onStage("Preserving source voice with ElevenLabs");
      const elAudio = await elevenLabsDubSourceVoice({
        apiKey: elApiKey,
        videoBytes: video.buffer,
        videoMime: video.mimeType,
        targetLang: track.locale,
      });
      const referenceWav = await extractVoiceSampleWav(elAudio);
      const temporaryVoiceId = await elDef.clone({
        apiKey: elApiKey,
        name: `KOKAO localized source ${job.id}`,
        audio: referenceWav,
        mimeType: "audio/wav",
      });

      try {
        onStage("Fitting approved lines to the source voice");
        const dubResult = await orchestrateLocalizedDubFull(video.buffer, {
          locale: dubLocale,
          provider: "openai",
          model: "gpt-audio",
          speaker: "nova",
          cues,
        }, {
          speakCue: (text) =>
            elDef.speak({ apiKey: elApiKey, voiceId: temporaryVoiceId, text }),
          repairCue: repairOverflowingCue,
          renderVideo: false,
        });
        const burnedVideo = await lipSyncAndBurn(
          dubResult.dubTrackWav,
          "audio/wav",
          dubResult.finalCues,
        );

        const replicateDef2 = getVideoGenProviderDef("replicate");
        const localizedResult: LocalizedDubResult = {
          locale: dubLocale,
          voiceMode,
          provider: "elevenlabs",
          model: "dubbing+instant-voice",
          finalCues: Array.from(dubResult.finalCues).map((c) => ({
            index: c.index,
            startMs: c.startMs,
            endMs: c.endMs,
            text: c.text,
          })),
          repairedCueIndices: dubResult.repairedCueIndices,
          sourceVideoPath: sourcePath,
        };
        return {
          buffer: burnedVideo,
          provider: replicateDef2?.id ?? "replicate",
          model: "bytedance/latentsync",
          qa: { minDurationSec, expectAudio: true, label: "localized dub video" },
          localizedResult,
        };
      } finally {
        await elDef
          .remove({ apiKey: elApiKey, voiceId: temporaryVoiceId })
          .catch((err) => {
            logger.warn(
              { err, jobId: job.id },
              "Temporary source-voice clone cleanup failed",
            );
          });
      }
    }

    if (voiceMode === "brand_voice") {
      // Brand-kit cloned ElevenLabs voice — synthesise each cue, then assemble.
      const brandVoiceCloneEnabled = await isFeatureEnabled("brandVoiceClone").catch(() => true);
      if (!brandVoiceCloneEnabled) {
        throw new VideoJobInputError("Brand voice cloning is currently turned off.");
      }
      const branding = await loadVideoBranding(
        job.tenantId,
        options.brandKitId ?? null,
      ).catch((err) => {
        logger.warn({ err, jobId: job.id }, "Brand kit lookup failed for localized_dub brand_voice");
        return null;
      });
      if (!branding?.clonedVoice) {
        throw new VideoJobInputError(
          "Brand-voice dubbing requires a brand kit with a configured cloned voice. " +
            "Set up a cloned voice in the brand kit settings.",
        );
      }
      onStage("Dubbing with brand voice");

      const clonedVoiceRef = branding.clonedVoice;
      const dubResult = await orchestrateLocalizedDubFull(video.buffer, {
        locale: dubLocale,
        // provider/model/speaker are bypassed by the speakCue injection below.
        provider: "openai",
        model: "gpt-audio",
        speaker: "nova",
        cues,
      }, {
        speakCue: async (text) => {
          // The orchestrator calls cues sequentially. Original cue text gives
          // us the durable job/cue identity; a timing-repaired line remains
          // tied to that same cue through its unique position.
          const cueIndex =
            cues.find((cue) => cue.text === text)?.index ?? repairedCueIndexes.get(text) ?? 0;
          return speakLocalizedBrandVoiceCue({
            tenantId: job.tenantId,
            jobId: job.id,
            cueIndex,
            voice: clonedVoiceRef,
            text,
            languageCode: dubLocale,
          });
        },
        repairCue: repairOverflowingCue,
        renderVideo: false,
      });

      const burnedVideo = await lipSyncAndBurn(
        dubResult.dubTrackWav,
        "audio/wav",
        dubResult.finalCues,
      );
      const replicateDef2 = getVideoGenProviderDef("replicate");
      const localizedResult: LocalizedDubResult = {
        locale: dubLocale,
        voiceMode,
        provider: clonedVoiceRef.provider,
        model: "cloned-voice",
        finalCues: Array.from(dubResult.finalCues).map((c) => ({
          index: c.index,
          startMs: c.startMs,
          endMs: c.endMs,
          text: c.text,
        })),
        repairedCueIndices: dubResult.repairedCueIndices,
        sourceVideoPath: sourcePath,
      };
      return {
        buffer: burnedVideo,
        provider: replicateDef2?.id ?? "replicate",
        model: "bytedance/latentsync",
        qa: { minDurationSec, expectAudio: true, label: "localized dub video" },
        localizedResult,
      };
    }

    // stock mode: TTS synthesis using provider/model/speaker snapshot.
    {
      const narration = normalizeLocalizedNarrationSelection(track);
      onStage("Dubbing and burning subtitles");
      const dubResult = await orchestrateLocalizedDubFull(video.buffer, {
        locale: dubLocale,
        provider: narration.provider,
        model: narration.model,
        speaker: narration.speaker,
        voice: track.voice,
        cues,
      }, {
        repairCue: repairOverflowingCue,
        renderVideo: false,
      });

      const burnedVideo = await lipSyncAndBurn(
        dubResult.dubTrackWav,
        "audio/wav",
        dubResult.finalCues,
      );
      const replicateDef2 = getVideoGenProviderDef("replicate");
      const localizedResult: LocalizedDubResult = {
        locale: dubLocale,
        voiceMode,
        provider: narration.provider,
        model: narration.model,
        finalCues: Array.from(dubResult.finalCues).map((c) => ({
          index: c.index,
          startMs: c.startMs,
          endMs: c.endMs,
          text: c.text,
        })),
        repairedCueIndices: dubResult.repairedCueIndices,
        sourceVideoPath: sourcePath,
      };
      return {
        buffer: burnedVideo,
        provider: replicateDef2?.id ?? "replicate",
        model: "bytedance/latentsync",
        qa: { minDurationSec, expectAudio: true, label: "localized dub video" },
        localizedResult,
      };
    }
  }

  throw new VideoJobInputError(`Unknown video engine: ${job.engine}`);
}

function isStockSourceChoice(value: string | undefined): value is StockSourceChoice {
  return value === "auto" || value === "pexels" || value === "pixabay" || value === "wikimedia";
}

/**
 * Run one video job to completion. `funding` is how the route paid for it
 * ("quota" = counts against the monthly plan, "credit" = already debited).
 *
 * A job that asked for storyboard review stops halfway: it lands in
 * awaiting_review with its plan on the row, and nothing is metered or refunded
 * until the plan is approved (resumeVideoGenerationJob) or expires.
 */
export async function runVideoGenerationJob(
  jobId: number,
  funding: "quota" | "credit" | "wallet",
): Promise<void> {
  // Atomic claim: only one runner can move a job out of queued, so a retry or
  // a restart cannot double-spend a reservation.
  const claimed = (
    await db
      .update(videoGenerationsTable)
      .set({ status: "processing", stage: "Getting started", funding })
      .where(and(eq(videoGenerationsTable.id, jobId), eq(videoGenerationsTable.status, "queued")))
      .returning()
  )[0];
  if (!claimed) return;
  const guided = claimed.options?.guidedStory;
  if (guided) {
    const invalid =
      !guidedStoryBackdropsAreApproved(guided) ||
      (claimed.storyboard != null && (() => {
        const expected = guidedStoryStoryboard(guided);
        return expected.scenes.length !== claimed.storyboard.scenes.length ||
          expected.scenes.some((scene, index) =>
            !guidedStorySceneImmutableInputsMatch(claimed.storyboard!.scenes[index], scene));
      })());
    if (invalid) {
      await db.update(videoGenerationsTable).set({
        status: "failed",
        stage: null,
        error:
          "Guided Story execution is blocked: review and approve the shared backdrop reference, then start a new immutable attempt.",
        updatedAt: new Date(),
      }).where(eq(videoGenerationsTable.id, claimed.id));
      return;
    }
  }
  await executeVideoJob(claimed, funding);
}

/**
 * Materialize only the missing review frames of an immutable Guided Story.
 * The operation has its own persisted lifecycle and intentionally never moves
 * the parent job out of awaiting_review.
 */
export async function runGuidedPreviewRenderJob(jobId: number): Promise<void> {
  const claimed = await db.transaction(async (tx) => {
    const [fresh] = await tx.select().from(videoGenerationsTable)
      .where(eq(videoGenerationsTable.id, jobId)).for("update").limit(1);
    const operation = fresh?.options?.guidedPreviewRender;
    if (
      !fresh ||
      fresh.status !== "awaiting_review" ||
      fresh.storyboard?.mode !== "guided_story" ||
      !operation ||
      operation.state !== "queued"
    ) return null;
    const options = {
      ...fresh.options!,
      guidedPreviewRender: {
        ...operation,
        state: "running" as const,
        startedAt: operation.startedAt ?? new Date().toISOString(),
        error: null,
      },
    };
    return (await tx.update(videoGenerationsTable).set({
      options,
      stage: `Rendering missing previews (0 of ${operation.total})`,
      error: null,
      updatedAt: new Date(),
    }).where(eq(videoGenerationsTable.id, fresh.id)).returning())[0]!;
  });
  if (!claimed) return;

  let board = claimed.storyboard!;
  const operationId = claimed.options!.guidedPreviewRender!.operationId;
  const persist = async (
    nextBoard: VideoStoryboard,
    patch: Partial<NonNullable<VideoJobOptions["guidedPreviewRender"]>>,
  ): Promise<void> => {
    await db.transaction(async (tx) => {
      const [current] = await tx.select().from(videoGenerationsTable)
        .where(eq(videoGenerationsTable.id, jobId)).for("update").limit(1);
      const operation = current?.options?.guidedPreviewRender;
      if (
        !current?.options ||
        current.status !== "awaiting_review" ||
        !operation ||
        operation.operationId !== operationId ||
        operation.state !== "running"
      ) {
        throw new VideoJobInputError(
          "The Guided Story preview operation changed while it was running.",
        );
      }
      const nextOperation = { ...operation, ...patch };
      await tx.update(videoGenerationsTable).set({
        storyboard: nextBoard,
        options: { ...current.options, guidedPreviewRender: nextOperation },
        stage: nextOperation.state === "running"
          ? `Rendering missing previews (${nextOperation.completed} of ${nextOperation.total})`
          : null,
        error: nextOperation.error,
        updatedAt: new Date(),
      }).where(eq(videoGenerationsTable.id, jobId));
    });
  };

  try {
    const snapshot = claimed.options?.guidedStory;
    if (!snapshot) throw new VideoJobInputError("This Guided Story has no immutable generation snapshot.");
    if (
      !guidedStoryBackdropsAreApproved(snapshot)
    ) {
      throw new VideoJobInputError(
        "Review and approve the shared backdrop reference before generating scene previews.",
      );
    }
    if (!guidedCastApprovalsMatch({
      draftRevision: snapshot.draftRevision,
      cast: snapshot.cast,
      approvals: snapshot.castApprovals,
    })) {
      throw new VideoJobInputError(GUIDED_CAST_APPROVAL_REQUIRED_MESSAGE);
    }
    const expected = guidedStoryStoryboard(snapshot);
    if (
      expected.scenes.length !== board.scenes.length ||
      expected.scenes.some(
        (scene, index) =>
          !guidedStorySceneImmutableInputsMatch(board.scenes[index], scene),
      )
    ) {
      throw new VideoJobInputError(
        "The Guided Story cast or storyboard fingerprint changed. Start a new immutable attempt.",
      );
    }

    const requiredUnits = videoJobUnits(claimed.engine, claimed.options);
    const funding = claimed.options?.storyboardFunding;
    if (
      !claimed.funding ||
      (funding != null && (
        funding.requiredUnits == null ||
        funding.fundedUnits < funding.requiredUnits
      )) ||
      (claimed.funding === "wallet" &&
        (claimed.walletReservationId == null ||
          (claimed.walletReservedUnits ?? 0) < requiredUnits))
    ) {
      throw new VideoJobInputError(
        "The existing Guided Story reservation is invalid or insufficient for its saved storyboard.",
      );
    }

    let completed = board.scenes.filter((scene) =>
      Boolean(scene.previewPath &&
        (!scene.previewCheckpoint ||
          (scene.previewCheckpoint.status === "complete" &&
            scene.previewPath === scene.previewCheckpoint.targetPath))),
    ).length;
    const latestByRole = new Map<string, Buffer>();
    for (const sceneSnapshot of board.scenes) {
      let scene = board.scenes.find((candidate) => candidate.id === sceneSnapshot.id)!;
      if (scene.previewPath && !scene.previewCheckpoint) {
        scene.previewCheckpoint = {
          targetPath: scene.previewPath,
          status: "complete",
        };
        await persist(board, { completed });
      }
      if (
        scene.previewCheckpoint?.status === "complete" &&
        scene.previewPath &&
        scene.previewPath === scene.previewCheckpoint.targetPath
      ) {
        rememberGuidedContinuityImage(scene, (await loadTenantObject(
          scene.previewPath, claimed.tenantId, MAX_SOURCE_IMAGE_BYTES, "Guided Story preview",
        )).buffer, latestByRole);
        continue;
      }
      if (scene.previewCheckpoint?.status === "provider_succeeded") {
        const events = previewCheckpointEvents(scene.previewCheckpoint);
        if (events.length === 0) {
          throw new VideoGenProviderError("Preview checkpoint is missing its provider receipt.");
        }
        if (!(await objectExists(scene.previewCheckpoint.targetPath, claimed.tenantId))) {
          throw new PartialVideoProviderWorkError(events, new VideoGenProviderError(
            "A provider-succeeded Guided Story preview is unavailable and will not be regenerated.",
          ));
        }
        scene.previewPath = scene.previewCheckpoint.targetPath;
        scene.previewCheckpoint = { ...scene.previewCheckpoint, status: "complete" };
        completed += 1;
        await persist(board, { completed });
        rememberGuidedContinuityImage(scene, (await loadTenantObject(
          scene.previewPath, claimed.tenantId, MAX_SOURCE_IMAGE_BYTES, "Guided Story preview",
        )).buffer, latestByRole);
        continue;
      }
      if (scene.previewCheckpoint?.status === "provider_started") {
        throw new VideoGenProviderError(
          `Guided Story scene ${scene.id} has an uncertain provider outcome. It was not regenerated to avoid a duplicate charge.`,
        );
      }

      // A prepared checkpoint proves no provider receipt exists. Minting a new
      // signed target is safe after restart because no paid work is discarded.
      const uploadURL = await objectStorageService.getObjectEntityUploadURL(claimed.tenantId);
      const targetPath = objectStorageService.normalizeObjectEntityPath(uploadURL);
      scene.previewPath = null;
      scene.previewCheckpoint = { targetPath, status: "prepared" };
      await persist(board, { completed });

      const previewPath = await regenerateStoryboardPreview({
        tenantId: claimed.tenantId,
        storyboard: board,
        scene,
        aspectRatio: claimed.options?.aspectRatio ?? "9:16",
        characterId: null,
        upload: (bytes, contentType) => uploadToStorage(claimed.tenantId, bytes, contentType),
        priorImages: guidedContinuityImages(scene, latestByRole),
        imageSelectionPolicy: claimed.options?.guidedStory?.imageModelSnapshot,
        onProviderStart: async () => {
          scene = board.scenes.find((candidate) => candidate.id === sceneSnapshot.id)!;
          const checkpoint = scene.previewCheckpoint;
          if (!checkpoint || checkpoint.status !== "prepared") {
            throw new VideoGenProviderError(
              "Guided Story preview was not safely prepared before provider dispatch.",
            );
          }
          scene.previewCheckpoint = { ...checkpoint, status: "provider_started" };
          await persist(board, { completed });
        },
        onProviderSuccess: async ({ attemptIndex, result }) => {
          scene = board.scenes.find((candidate) => candidate.id === sceneSnapshot.id)!;
          const checkpoint = scene.previewCheckpoint;
          if (!checkpoint || checkpoint.status !== "provider_started") {
            throw new VideoGenProviderError("Guided Story preview checkpoint was not prepared.");
          }
          const events = previewCheckpointEvents(checkpoint);
          const label = `storyboard_preview:${scene.id}:attempt:${events.length + 1}`;
          events.push({
            eventId: videoProviderEventId(claimed, label),
            provider: result.provider,
            model: result.model,
            durationSec: null,
            requestBytes: Buffer.byteLength(scene.visual),
            label,
            costPaise: await computeImageCostPaise({
              provider: result.provider,
              model: result.model,
              inputTokens: result.usage?.inputTokens,
              outputTokens: result.usage?.outputTokens,
            }).catch(() => null),
            unitWeight: attemptIndex === 0 ? videoModelMultiplier(claimed.options?.modelId) : 0,
          });
          scene.previewCheckpoint = {
            ...checkpoint,
            status: "provider_succeeded",
            events,
            event: undefined,
          };
          await persist(board, { completed });
        },
        onProviderFailure: async ({ error }) => {
          await recordSceneFailure(
            { ...claimed, storyboard: board },
            scene,
            "storyboard_preview",
            error,
          );
        },
        uploadGenerated: async (result) => {
          scene = board.scenes.find((candidate) => candidate.id === sceneSnapshot.id)!;
          const checkpoint = scene.previewCheckpoint;
          if (!checkpoint || checkpoint.status !== "provider_succeeded") {
            throw new VideoGenProviderError("Guided Story preview has no provider receipt.");
          }
          const path = await uploadToPreparedOrFreshStorage(
            claimed.tenantId, uploadURL, result.buffer, "image/png",
          );
          scene.previewPath = path;
          scene.previewCheckpoint = {
            ...checkpoint,
            targetPath: path,
            status: "complete",
            selectedEventId: checkpoint.events?.at(-1)?.eventId,
          };
          completed += 1;
          await persist(board, { completed });
          rememberGuidedContinuityImage(scene, result.buffer, latestByRole);
          return path;
        },
      });
      scene.previewPath = previewPath;
    }
    await persist(board, {
      state: "succeeded",
      completed: board.scenes.length,
      error: null,
      finishedAt: new Date().toISOString(),
    });
  } catch (error) {
    const cause = error instanceof PartialVideoProviderWorkError ? error.cause : error;
    const message = cause instanceof Error
      ? cause.message
      : "Guided Story preview rendering failed.";
    await persist(board, {
      state: "failed",
      error: message,
      finishedAt: new Date().toISOString(),
    }).catch((persistError) => {
      logger.error({ err: persistError, jobId }, "Failed to persist Guided Story preview failure");
    });
  }
}
/*
 * The duplicate backdrop-only conflict branch is intentionally disabled: the
 * implementation above combines its backdrop gate with the cast-approval,
 * checkpoint, funding, and active-operation protections from main.
 *
 * Materialize only the missing review frames of an immutable Guided Story.
 * The operation has its own persisted lifecycle and intentionally never moves
 * the parent job out of awaiting_review.
 *
export async function runGuidedPreviewRenderJob(jobId: number): Promise<void> {
  const claimed = await db.transaction(async (tx) => {
    const [fresh] = await tx.select().from(videoGenerationsTable)
      .where(eq(videoGenerationsTable.id, jobId)).for("update").limit(1);
    const operation = fresh?.options?.guidedPreviewRender;
    if (
      !fresh ||
      fresh.status !== "awaiting_review" ||
      fresh.storyboard?.mode !== "guided_story" ||
      !operation ||
      operation.state !== "queued"
    ) return null;
    const options = {
      ...fresh.options!,
      guidedPreviewRender: {
        ...operation,
        state: "running" as const,
        startedAt: operation.startedAt ?? new Date().toISOString(),
        error: null,
      },
    };
    return (await tx.update(videoGenerationsTable).set({
      options,
      stage: `Rendering missing previews (0 of ${operation.total})`,
      error: null,
      updatedAt: new Date(),
    }).where(eq(videoGenerationsTable.id, fresh.id)).returning())[0]!;
  });
  if (!claimed) return;

  let board = claimed.storyboard!;
  const operationId = claimed.options!.guidedPreviewRender!.operationId;
  const persist = async (
    nextBoard: VideoStoryboard,
    patch: Partial<NonNullable<VideoJobOptions["guidedPreviewRender"]>>,
  ): Promise<void> => {
    await db.transaction(async (tx) => {
      const [current] = await tx.select().from(videoGenerationsTable)
        .where(eq(videoGenerationsTable.id, jobId)).for("update").limit(1);
      const operation = current?.options?.guidedPreviewRender;
      if (
        !current?.options ||
        current.status !== "awaiting_review" ||
        !operation ||
        operation.operationId !== operationId ||
        operation.state !== "running"
      ) {
        throw new VideoJobInputError(
          "The Guided Story preview operation changed while it was running.",
        );
      }
      const nextOperation = { ...operation, ...patch };
      await tx.update(videoGenerationsTable).set({
        storyboard: nextBoard,
        options: { ...current.options, guidedPreviewRender: nextOperation },
        stage: nextOperation.state === "running"
          ? `Rendering missing previews (${nextOperation.completed} of ${nextOperation.total})`
          : null,
        error: nextOperation.error,
        updatedAt: new Date(),
      }).where(eq(videoGenerationsTable.id, jobId));
    });
  };

  try {
    const snapshot = claimed.options?.guidedStory;
    if (!snapshot) throw new VideoJobInputError("This Guided Story has no immutable generation snapshot.");
    if (
      !guidedStoryBackdropsAreApproved(snapshot)
    ) {
      throw new VideoJobInputError(
        "Review and approve the shared backdrop reference before generating scene previews.",
      );
    }
    const expected = guidedStoryStoryboard(snapshot);
    if (
      expected.scenes.length !== board.scenes.length ||
      expected.scenes.some(
        (scene, index) =>
          !guidedStorySceneImmutableInputsMatch(board.scenes[index], scene),
      )
    ) {
      throw new VideoJobInputError(
        "The Guided Story cast or storyboard fingerprint changed. Start a new immutable attempt.",
      );
    }

    const requiredUnits = videoJobUnits(claimed.engine, claimed.options);
    const funding = claimed.options?.storyboardFunding;
    if (
      !claimed.funding ||
      (funding != null && (
        funding.requiredUnits == null ||
        funding.fundedUnits < funding.requiredUnits
      )) ||
      (claimed.funding === "wallet" &&
        (claimed.walletReservationId == null ||
          (claimed.walletReservedUnits ?? 0) < requiredUnits))
    ) {
      throw new VideoJobInputError(
        "The existing Guided Story reservation is invalid or insufficient for its saved storyboard.",
      );
    }

    let completed = board.scenes.filter((scene) =>
      Boolean(scene.previewPath &&
        (!scene.previewCheckpoint ||
          (scene.previewCheckpoint.status === "complete" &&
            scene.previewPath === scene.previewCheckpoint.targetPath))),
    ).length;
    const latestByRole = new Map<string, Buffer>();
    for (const sceneSnapshot of board.scenes) {
      let scene = board.scenes.find((candidate) => candidate.id === sceneSnapshot.id)!;
      if (scene.previewPath && !scene.previewCheckpoint) {
        scene.previewCheckpoint = {
          targetPath: scene.previewPath,
          status: "complete",
        };
        await persist(board, { completed });
      }
      if (
        scene.previewCheckpoint?.status === "complete" &&
        scene.previewPath &&
        scene.previewPath === scene.previewCheckpoint.targetPath
      ) {
        rememberGuidedContinuityImage(scene, (await loadTenantObject(
          scene.previewPath, claimed.tenantId, MAX_SOURCE_IMAGE_BYTES, "Guided Story preview",
        )).buffer, latestByRole);
        continue;
      }
      if (scene.previewCheckpoint?.status === "provider_succeeded") {
        const events = previewCheckpointEvents(scene.previewCheckpoint);
        if (events.length === 0) {
          throw new VideoGenProviderError("Preview checkpoint is missing its provider receipt.");
        }
        if (!(await objectExists(scene.previewCheckpoint.targetPath, claimed.tenantId))) {
          throw new PartialVideoProviderWorkError(events, new VideoGenProviderError(
            "A provider-succeeded Guided Story preview is unavailable and will not be regenerated.",
          ));
        }
        scene.previewPath = scene.previewCheckpoint.targetPath;
        scene.previewCheckpoint = { ...scene.previewCheckpoint, status: "complete" };
        completed += 1;
        await persist(board, { completed });
        rememberGuidedContinuityImage(scene, (await loadTenantObject(
          scene.previewPath, claimed.tenantId, MAX_SOURCE_IMAGE_BYTES, "Guided Story preview",
        )).buffer, latestByRole);
        continue;
      }
      if (scene.previewCheckpoint?.status === "provider_started") {
        throw new VideoGenProviderError(
          `Guided Story scene ${scene.id} has an uncertain provider outcome. It was not regenerated to avoid a duplicate charge.`,
        );
      }

      // A prepared checkpoint proves no provider receipt exists. Minting a new
      // signed target is safe after restart because no paid work is discarded.
      const uploadURL = await objectStorageService.getObjectEntityUploadURL(claimed.tenantId);
      const targetPath = objectStorageService.normalizeObjectEntityPath(uploadURL);
      scene.previewPath = null;
      scene.previewCheckpoint = { targetPath, status: "prepared" };
      await persist(board, { completed });

      const previewPath = await regenerateStoryboardPreview({
        tenantId: claimed.tenantId,
        storyboard: board,
        scene,
        aspectRatio: claimed.options?.aspectRatio ?? "9:16",
        characterId: null,
        upload: (bytes, contentType) => uploadToStorage(claimed.tenantId, bytes, contentType),
        priorImages: guidedContinuityImages(scene, latestByRole),
        imageSelectionPolicy: claimed.options?.guidedStory?.imageModelSnapshot,
        onProviderStart: async () => {
          scene = board.scenes.find((candidate) => candidate.id === sceneSnapshot.id)!;
          const checkpoint = scene.previewCheckpoint;
          if (!checkpoint || checkpoint.status !== "prepared") {
            throw new VideoGenProviderError(
              "Guided Story preview was not safely prepared before provider dispatch.",
            );
          }
          scene.previewCheckpoint = { ...checkpoint, status: "provider_started" };
          await persist(board, { completed });
        },
        onProviderSuccess: async ({ attemptIndex, result }) => {
          scene = board.scenes.find((candidate) => candidate.id === sceneSnapshot.id)!;
          const checkpoint = scene.previewCheckpoint;
          if (!checkpoint || checkpoint.status !== "provider_started") {
            throw new VideoGenProviderError("Guided Story preview checkpoint was not prepared.");
          }
          const events = previewCheckpointEvents(checkpoint);
          const label = `storyboard_preview:${scene.id}:attempt:${events.length + 1}`;
          events.push({
            eventId: videoProviderEventId(claimed, label),
            provider: result.provider,
            model: result.model,
            durationSec: null,
            requestBytes: Buffer.byteLength(scene.visual),
            label,
            costPaise: await computeImageCostPaise({
              provider: result.provider,
              model: result.model,
              inputTokens: result.usage?.inputTokens,
              outputTokens: result.usage?.outputTokens,
            }).catch(() => null),
            unitWeight: attemptIndex === 0 ? videoModelMultiplier(claimed.options?.modelId) : 0,
          });
          scene.previewCheckpoint = {
            ...checkpoint,
            status: "provider_succeeded",
            events,
            event: undefined,
          };
          await persist(board, { completed });
        },
        onProviderFailure: async ({ error }) => {
          await recordSceneFailure(
            { ...claimed, storyboard: board },
            scene,
            "storyboard_preview",
            error,
          );
        },
        uploadGenerated: async (result) => {
          scene = board.scenes.find((candidate) => candidate.id === sceneSnapshot.id)!;
          const checkpoint = scene.previewCheckpoint;
          if (!checkpoint || checkpoint.status !== "provider_succeeded") {
            throw new VideoGenProviderError("Guided Story preview has no provider receipt.");
          }
          const path = await uploadToPreparedOrFreshStorage(
            claimed.tenantId, uploadURL, result.buffer, "image/png",
          );
          scene.previewPath = path;
          scene.previewCheckpoint = {
            ...checkpoint,
            targetPath: path,
            status: "complete",
            selectedEventId: checkpoint.events?.at(-1)?.eventId,
          };
          completed += 1;
          await persist(board, { completed });
          rememberGuidedContinuityImage(scene, result.buffer, latestByRole);
          return path;
        },
      });
      scene.previewPath = previewPath;
    }
    await persist(board, {
      state: "succeeded",
      completed: board.scenes.length,
      error: null,
      finishedAt: new Date().toISOString(),
    });
  } catch (error) {
    const cause = error instanceof PartialVideoProviderWorkError ? error.cause : error;
    const message = cause instanceof Error
      ? cause.message
      : "Guided Story preview rendering failed.";
    await persist(board, {
      state: "failed",
      error: message,
      finishedAt: new Date().toISOString(),
    }).catch((persistError) => {
      logger.error({ err: persistError, jobId }, "Failed to persist Guided Story preview failure");
    });
  }
}
*/

/** Execute one explicitly-confirmed Guided Story scene correction. */
export async function runGuidedSceneCorrectionJob(
  jobId: number,
  sceneId: string,
  attemptId: string,
): Promise<void> {
  const claimed = await db.transaction(async (tx) => {
    const [job] = await tx.select().from(videoGenerationsTable)
      .where(eq(videoGenerationsTable.id, jobId)).for("update").limit(1);
    const scene = job?.storyboard?.scenes.find((item) => item.id === sceneId);
    const attempts = scene?.guidedStory?.corrections?.attempts;
    const attempt = attempts?.find((item) => item.id === attemptId);
    if (
      !job || job.status !== "awaiting_review" ||
      job.storyboard?.mode !== "guided_story" || !scene?.guidedStory ||
      !attempt ||
      !(attempt.state === "queued" ||
        (attempt.state === "provider_succeeded" && attempt.replacementPath)) ||
      attempt.inputFingerprint !== scene.guidedStory.inputFingerprint ||
      attempt.originalPreviewPath !== scene.previewPath
    ) return null;
    const resumeSavedReplacement =
      attempt.state === "provider_succeeded" && Boolean(attempt.replacementPath);
    if (!resumeSavedReplacement) {
      attempt.state = "running";
      attempt.startedAt = new Date().toISOString();
    }
    await tx.update(videoGenerationsTable).set({
      storyboard: job.storyboard,
      stage: `Correcting Guided Story scene ${sceneId}`,
      updatedAt: new Date(),
    }).where(eq(videoGenerationsTable.id, job.id));
    return { job, resumeSavedReplacement };
  });
  if (!claimed?.job.storyboard) return;
  const resumeSavedReplacement = claimed.resumeSavedReplacement;
  const claimedJob = claimed.job;
  const claimedStoryboard = claimedJob.storyboard!;
  const immutableSnapshot = claimedJob.options?.guidedStory;
  const immutableBackdropValid =
    Boolean(immutableSnapshot && guidedStoryBackdropsAreApproved(immutableSnapshot));
  if (
    immutableSnapshot &&
    !guidedCastApprovalsMatch({
      draftRevision: immutableSnapshot.draftRevision,
      cast: immutableSnapshot.cast,
      approvals: immutableSnapshot.castApprovals,
    })
  ) {
    // Continue through the ordinary immutable-input failure path below, which
    // returns reserved correction funding before any provider call.
  }
  const expectedBoard = immutableSnapshot
    && immutableBackdropValid
    && guidedCastApprovalsMatch({
      draftRevision: immutableSnapshot.draftRevision,
      cast: immutableSnapshot.cast,
      approvals: immutableSnapshot.castApprovals,
    })
    ? guidedStoryStoryboard(immutableSnapshot)
    : null;
  if (
    !expectedBoard ||
    expectedBoard.scenes.length !== claimedStoryboard.scenes.length ||
    expectedBoard.scenes.some((expected, index) =>
      !guidedStorySceneImmutableInputsMatch(claimedStoryboard.scenes[index], expected))
  ) {
    const scene = claimedStoryboard.scenes.find((item) => item.id === sceneId);
    const attempt = scene?.guidedStory?.corrections?.attempts.find((item) => item.id === attemptId);
    if (attempt) {
      if (attempt.funding === "wallet" && attempt.walletReservation) {
        await refundWallet(
          claimedJob.tenantId,
          attempt.walletReservation,
          "Guided correction immutable inputs changed",
        ).catch(() => {});
      } else if (attempt.funding === "credit") {
        await refundCredits(
          claimedJob.tenantId,
          "image",
          1,
          "Guided correction immutable inputs changed",
        ).catch(() => {});
      }
      attempt.state = "failed";
      attempt.error = "The immutable Guided Story inputs changed; no provider call was made.";
      attempt.finishedAt = new Date().toISOString();
      await setJob(jobId, { storyboard: claimedStoryboard, stage: null });
    }
    return;
  }

  const persistAttempt = async (
    mutate: (attempt: NonNullable<VideoStoryboardScene["guidedStory"]>["corrections"] extends infer C
      ? C extends { attempts: Array<infer A> } ? A : never : never,
      scene: VideoStoryboardScene) => void,
  ): Promise<VideoGeneration> => db.transaction(async (tx) => {
    const [job] = await tx.select().from(videoGenerationsTable)
      .where(eq(videoGenerationsTable.id, jobId)).for("update").limit(1);
    const scene = job?.storyboard?.scenes.find((item) => item.id === sceneId);
    const attempt = scene?.guidedStory?.corrections?.attempts.find((item) => item.id === attemptId);
    if (!job?.storyboard || !scene?.guidedStory || !attempt) {
      throw new VideoJobInputError("Guided scene correction no longer exists.");
    }
    mutate(attempt, scene);
    const [saved] = await tx.update(videoGenerationsTable).set({
      storyboard: job.storyboard,
      stage: attempt.state === "succeeded" || attempt.state === "failed" ||
        attempt.state === "outcome_unknown" ? null : job.stage,
      updatedAt: new Date(),
    }).where(and(
      eq(videoGenerationsTable.id, jobId),
      eq(videoGenerationsTable.status, "awaiting_review"),
    )).returning();
    if (!saved) throw new VideoJobInputError("Guided Story is no longer awaiting review.");
    return saved;
  });
  if (!immutableBackdropValid) {
    const attempt = claimedStoryboard.scenes
      .find((item) => item.id === sceneId)
      ?.guidedStory?.corrections?.attempts.find((item) => item.id === attemptId);
    if (attempt?.funding === "wallet" && attempt.walletReservation) {
      await refundWallet(
        claimedJob.tenantId,
        attempt.walletReservation,
        "Guided correction missing approved backdrop",
      ).catch(() => {});
    } else if (attempt?.funding === "credit") {
      await refundCredits(
        claimedJob.tenantId,
        "image",
        1,
        "Guided correction missing approved backdrop",
      ).catch(() => {});
    }
    await persistAttempt((current) => {
      current.state = "failed";
      current.error =
        "Review and approve the shared backdrop reference before retrying this scene correction.";
      current.finishedAt = new Date().toISOString();
    });
    return;
  }
  if (resumeSavedReplacement) {
    await persistAttempt((attempt, scene) => {
      scene.previewPath = attempt.replacementPath;
      scene.previewCheckpoint = { targetPath: attempt.replacementPath!, status: "complete" };
      scene.guidedStory!.inconsistencyFlags = scene.guidedStory!.inconsistencyFlags
        .filter((flag) => !flag.startsWith("user_reported:"));
      attempt.state = "succeeded";
      attempt.error = null;
      attempt.finishedAt = new Date().toISOString();
    });
    return;
  }

  let providerStarted = false;
  let provider = "";
  let model = "";
  let actualCostPaise: number | null = null;
  let responseBytes = 0;
  try {
    const guidedSnapshot = claimedJob.options?.guidedStory;
    if (
      guidedSnapshot &&
      !guidedCastApprovalsMatch({
        draftRevision: guidedSnapshot.draftRevision,
        cast: guidedSnapshot.cast,
        approvals: guidedSnapshot.castApprovals,
      })
    ) {
      throw new VideoJobInputError(GUIDED_CAST_APPROVAL_REQUIRED_MESSAGE);
    }
    if (guidedSnapshot) {
      await verifyGuidedBackdropBytesBeforeRender(guidedSnapshot, claimedJob.tenantId);
    }
    const scene = claimedStoryboard.scenes.find((item) => item.id === sceneId)!;
    const attempt = scene.guidedStory!.corrections!.attempts.find((item) => item.id === attemptId)!;
    const correctedScene: VideoStoryboardScene = {
      ...scene,
      visual: `${scene.visual}\nBackdrop policy: ${
        attempt.backdropMode === "scene_only_background"
          ? "Change only this scene's background as requested; do not alter the frozen cast or outfit references."
          : "Keep the frozen approved shared backdrop unchanged."
      }\nCorrection request (${attempt.category}): ${attempt.note}`,
    };
    const priorImages = await loadGuidedContinuityBeforeScene(
      claimedStoryboard,
      scene.id,
      claimedJob.tenantId,
    );
    let walletOperationId: number | null = null;
    const generate = async (
      confirmSuccess?: (meta?: { provider?: string; model?: string; costPaise?: number }) => Promise<void>,
    ) => regenerateStoryboardPreview({
      tenantId: claimedJob.tenantId,
      storyboard: claimedStoryboard,
      scene: correctedScene,
      aspectRatio: claimedJob.options?.aspectRatio ?? "9:16",
      upload: (bytes, contentType) => uploadToStorage(claimedJob.tenantId, bytes, contentType),
      priorImages,
      imageSelectionPolicy: claimedJob.options?.guidedStory?.imageModelSnapshot,
      onProviderStart: async () => {
        providerStarted = true;
        await persistAttempt((current) => { current.state = "provider_started"; });
      },
      onProviderSuccess: async ({ result }) => {
        provider = result.provider;
        model = result.model;
        responseBytes = result.buffer.length;
        actualCostPaise = await computeImageCostPaise({
          provider, model,
          inputTokens: result.usage?.inputTokens,
          outputTokens: result.usage?.outputTokens,
        }).catch(() => null);
        await confirmSuccess?.({
          provider, model,
          ...(actualCostPaise !== null ? { costPaise: actualCostPaise } : {}),
        });
        await persistAttempt((current) => {
          current.state = "provider_succeeded";
          current.provider = provider;
          current.model = model;
          current.actualCostPaise = actualCostPaise;
        });
      },
      uploadGenerated: async (result) => {
        const path = await uploadToStorage(claimedJob.tenantId, result.buffer, "image/png");
        await persistAttempt((current) => {
          current.replacementPath = path;
          current.state = "provider_succeeded";
        });
        return path;
      },
    });
    let replacementPath: string;
    if (attempt.funding === "wallet" && attempt.walletReservation) {
      const executed = await executeWalletProviderOperation({
        tenantId: claimedJob.tenantId,
        reservation: attempt.walletReservation,
        operationKind: "guided_scene_correction",
        operationKey: attempt.id,
        settlement: {
          kind: "image",
          costPaise: null,
          provider: null,
          model: null,
          refKind: "videoJob",
          refId: `${jobId}:guided-correction:${sceneId}:${attempt.version}`,
        },
      }, (confirmSuccess) => generate(confirmSuccess), () => ({
        provider, model,
        ...(actualCostPaise !== null ? { costPaise: actualCostPaise } : {}),
      }), {
        requireExplicitSuccessConfirmation: true,
        isFailureConfirmed: () => !providerStarted,
      });
      walletOperationId = executed.operationId;
      replacementPath = executed.value;
      await settleWalletProviderOperationDurably(executed.operationId);
    } else {
      replacementPath = await generate();
    }
    await persistAttempt((current, currentScene) => {
      // Commit the selected scene only after upload and this transaction are durable.
      currentScene.previewPath = replacementPath;
      currentScene.previewCheckpoint = {
        targetPath: replacementPath,
        status: "complete",
      };
      currentScene.guidedStory!.inconsistencyFlags =
        currentScene.guidedStory!.inconsistencyFlags.filter((flag) =>
          !flag.startsWith("user_reported:"));
      current.state = "succeeded";
      current.replacementPath = replacementPath;
      current.walletOperationId = walletOperationId;
      current.provider = provider;
      current.model = model;
      current.actualCostPaise = actualCostPaise;
      current.error = null;
      current.finishedAt = new Date().toISOString();
    });
    await recordUsage(claimedJob.tenantId, "image", {
      durationMs: 0,
      responseBytes,
      model,
      provider,
      funding: attempt.funding,
    }).catch((error) =>
      logger.error({ err: error, jobId, sceneId }, "Failed to record Guided correction usage"));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Guided scene correction failed.";
    const failedScene = claimedStoryboard.scenes.find((item) => item.id === sceneId);
    const failedAttempt = failedScene?.guidedStory?.corrections?.attempts.find(
      (item) => item.id === attemptId,
    );
    if (!providerStarted && failedAttempt) {
      if (failedAttempt.funding === "wallet" && failedAttempt.walletReservation) {
        await refundWallet(
          claimedJob.tenantId,
          failedAttempt.walletReservation,
          "Guided scene correction failed before provider dispatch",
        ).catch((refundError) =>
          logger.error({ err: refundError, jobId, sceneId }, "Failed to refund Guided correction wallet"));
      } else if (failedAttempt.funding === "credit") {
        await refundCredits(
          claimedJob.tenantId,
          "image",
          1,
          "Guided scene correction failed before provider dispatch",
        ).catch((refundError) =>
          logger.error({ err: refundError, jobId, sceneId }, "Failed to refund Guided correction credit"));
      }
    }
    await persistAttempt((attempt) => {
      attempt.state = providerStarted ? "outcome_unknown" : "failed";
      attempt.error = providerStarted
        ? `${message} The original preview was kept; provider outcome needs reconciliation before retrying.`
        : message;
      attempt.finishedAt = new Date().toISOString();
    }).catch((persistError) =>
      logger.error({ err: persistError, jobId, sceneId }, "Failed to persist Guided correction failure"));
  }
}

/** Requeue preview-only operations whose in-process callback was lost. */
export async function resumeInterruptedGuidedPreviewRenders(): Promise<number> {
  const rows = await db.select().from(videoGenerationsTable).where(
    eq(videoGenerationsTable.status, "awaiting_review"),
  );
  let resumed = 0;
  for (const row of rows) {
    const operation = row.options?.guidedPreviewRender;
    if (!operation || (operation.state !== "queued" && operation.state !== "running")) continue;
    if (operation.state === "running") {
      await db.transaction(async (tx) => {
        const [fresh] = await tx.select().from(videoGenerationsTable)
          .where(eq(videoGenerationsTable.id, row.id)).for("update").limit(1);
        const current = fresh?.options?.guidedPreviewRender;
        if (
          !fresh?.options ||
          fresh.status !== "awaiting_review" ||
          current?.operationId !== operation.operationId ||
          current.state !== "running"
        ) return;
        await tx.update(videoGenerationsTable).set({
          options: {
            ...fresh.options,
            guidedPreviewRender: {
              ...current,
              state: "failed",
              error:
                "Preview rendering was interrupted by a server restart. Retry the missing previews; uncertain provider work will remain safely blocked.",
              finishedAt: new Date().toISOString(),
            },
          },
          stage: null,
          error:
            "Preview rendering was interrupted by a server restart. Retry the missing previews.",
          updatedAt: new Date(),
        }).where(eq(videoGenerationsTable.id, row.id));
      });
      continue;
    }
    const { enqueueBackgroundJob } = await import("../backgroundJobs");
    if (enqueueBackgroundJob(() => runGuidedPreviewRenderJob(row.id))) resumed += 1;
  }
  return resumed;
}

/** Recover queued correction callbacks; uncertain dispatched calls fail closed. */
export async function resumeInterruptedGuidedSceneCorrections(): Promise<number> {
  const rows = await db.select().from(videoGenerationsTable).where(
    eq(videoGenerationsTable.status, "awaiting_review"),
  );
  let resumed = 0;
  for (const row of rows) {
    for (const scene of row.storyboard?.scenes ?? []) {
      for (const attempt of scene.guidedStory?.corrections?.attempts ?? []) {
        if (
          attempt.state === "queued" ||
          (attempt.state === "provider_succeeded" && attempt.replacementPath)
        ) {
          const { enqueueBackgroundJob } = await import("../backgroundJobs");
          if (enqueueBackgroundJob(() =>
            runGuidedSceneCorrectionJob(row.id, scene.id, attempt.id))) resumed += 1;
        } else if (
          attempt.state === "running" ||
          attempt.state === "provider_started" ||
          (attempt.state === "provider_succeeded" && !attempt.replacementPath)
        ) {
          attempt.state = "outcome_unknown";
          attempt.error =
            "Correction was interrupted. The original preview was kept and the provider outcome must be reconciled before retrying.";
          attempt.finishedAt = new Date().toISOString();
          await setJob(row.id, { storyboard: row.storyboard, stage: null });
        }
      }
    }
  }
  return resumed;
}

/**
 * Recompose a completed Topic Video strictly from tenant-owned checkpoints.
 * This path intentionally has no funding argument and never records usage.
 */
export async function runVideoRepairJob(jobId: number): Promise<void> {
  const claimed = (
    await db
      .update(videoGenerationsTable)
      .set({ status: "processing", stage: "Loading saved repair assets" })
      .where(and(eq(videoGenerationsTable.id, jobId), eq(videoGenerationsTable.status, "queued")))
      .returning()
  )[0];
  if (!claimed) return;
  const startedAt = Date.now();
  const repair = claimed.options?.repair;
  const board = claimed.storyboard;
  try {
    if (!repair || claimed.engine !== "topic_to_video" || !board?.narration) {
      throw new VideoJobInputError(
        "This video no longer has the saved narration and storyboard required for repair.",
      );
    }
    const options = claimed.options!;
    const completeVisuals =
      board.visualsSource === "ai"
        ? board.scenes.every((scene) => Boolean(scene.previewPath))
        : (board.visualsSource === "ai_video" || board.visualsSource === "character") &&
          board.scenes.every(
            (scene) => Boolean(scene.previewPath && scene.providerCheckpoint?.path),
          );
    if (!completeVisuals) {
      throw new VideoJobInputError(
        "One or more saved scene assets are missing. The original video is still available.",
      );
    }
    const latestOptions = structuredClone(options);
    latestOptions.repair!.state = "processing";
    await setJob(jobId, { options: latestOptions });

    const branding = await loadVideoBranding(claimed.tenantId, options.brandKitId ?? null).catch(
      () => null,
    );
    let watermark: Buffer | null = null;
    if (branding?.watermarkPath) {
      watermark = (
        await loadTenantObject(
          branding.watermarkPath,
          claimed.tenantId,
          MAX_SOURCE_IMAGE_BYTES,
          "Saved brand logo",
        )
      ).buffer;
    }
    const music = await resolveMusic(
      claimed,
      options,
      board.narration.totalDurationSec,
      (stage) => void setJob(jobId, { stage }).catch(() => {}),
    );
    const result = await renderTopicStoryboard({
      storyboard: board,
      aspectRatio: options.aspectRatio ?? "9:16",
      lipSyncedSceneIds: new Set(
        (options.studioLipSync?.plan ?? []).map((scene) => scene.sceneId),
      ),
      subtitles: options.subtitles ?? true,
      captionStyle: options.captionStyle === "dynamic" ? "dynamic" : "classic",
      music,
      accentColor: branding?.accentColor ?? null,
      watermark,
      motionPreset: options.motionPreset ?? null,
      cinematography: options.cinematography ?? null,
      seed: options.seed ?? null,
      modelOptions: resolveModelOptions(options, 5),
      load: async (objectPath) =>
        (
          await loadTenantObject(
            objectPath,
            claimed.tenantId,
            MAX_SOURCE_VIDEO_BYTES,
            "Saved repair asset",
          )
        ).buffer,
      onStage: (stage) => void setJob(jobId, { stage }).catch(() => {}),
      // Eligibility requires every paid scene checkpoint, so this callback is
      // a hard guard: local repair must never create provider output.
      onCheckpoint: async () => {
        throw new VideoJobInputError(
          "A saved scene render is incomplete, so this video cannot be repaired without new AI generation.",
        );
      },
    });
    await setJob(jobId, { stage: "Validating repaired video" });
    const finalCueEnd = Math.max(
      0,
      ...board.narration.cues.map((cue) => cue.endSec),
    );
    const { durationSec } = await verifyRepairedVideo(result.buffer, {
      expectedDurationSec: board.narration.totalDurationSec,
      finalNarrationEndSec: finalCueEnd,
    });
    const videoPath = await uploadToStorage(claimed.tenantId, result.buffer, "video/mp4");
    let thumbnailPath: string | null = null;
    try {
      thumbnailPath = await uploadToStorage(
        claimed.tenantId,
        await extractPosterFrame(result.buffer),
        "image/png",
      );
    } catch (error) {
      logger.warn({ err: error, jobId }, "Repair poster frame extraction failed");
    }
    const succeededOptions = structuredClone(latestOptions);
    succeededOptions.repair!.state = "succeeded";
    succeededOptions.renderCheckpoint = {
      stage: "final",
      path: videoPath,
      provider: "ffmpeg",
      model: "local-recomposition",
      durationSec,
      providerEvents: [],
    };
    await setJob(jobId, {
      status: "succeeded",
      options: succeededOptions,
      videoPath,
      thumbnailPath,
      provider: "ffmpeg",
      model: "local-recomposition",
      durationMs: Date.now() - startedAt,
      spendPaise: 0,
      stage: null,
      error: null,
    });
  } catch (error) {
    const failedOptions = structuredClone(
      claimed.options ?? { aspectRatio: "9:16" as const },
    );
    if (failedOptions.repair) failedOptions.repair.state = "failed";
    const message =
      error instanceof Error
        ? error.message
        : "Local repair failed. The original video is still available.";
    await setJob(jobId, {
      status: "failed",
      options: failedOptions,
      durationMs: Date.now() - startedAt,
      stage: null,
      error: message,
      providerRequestId: providerRequestIdFromError(error),
      errorHistory: appendFailureHistory(claimed.errorHistory, failureEntry({
        job: claimed, scope: "job", operation: "local_recomposition",
        error, provider: "ffmpeg", outcome: "stopped",
      })),
    });
  }
}

/**
 * Render an approved storyboard. Takes the row the approve route already
 * claimed (flipping awaiting_review → processing in one conditional UPDATE, so
 * two approvals cannot both start a render) rather than claiming again here.
 *
 * Funding was reserved when the job was first enqueued, so this settles exactly
 * as the straight-through path does.
 */
export async function resumeVideoGenerationJob(job: VideoGeneration): Promise<void> {
  const guided = job.options?.guidedStory;
  if (guided) {
    const backdropsApproved = guidedStoryBackdropsAreApproved(guided);
    const expected = backdropsApproved ? guidedStoryStoryboard(guided) : null;
    const invalid =
      !backdropsApproved ||
      !job.storyboard ||
      !expected ||
      expected.scenes.length !== job.storyboard.scenes.length ||
      expected.scenes.some((scene, index) =>
        !guidedStorySceneImmutableInputsMatch(job.storyboard!.scenes[index], scene));
    if (invalid) {
      await db.update(videoGenerationsTable).set({
        status: "failed",
        stage: null,
        error:
          "Guided Story execution is blocked: review and approve the shared backdrop reference, then start a new immutable attempt.",
        updatedAt: new Date(),
      }).where(eq(videoGenerationsTable.id, job.id));
      return;
    }
  }
  await executeVideoJob(job, job.funding ?? "quota");
}

/**
 * Regenerate one storyboard scene's preview still from its current prompt and
 * return the updated plan. Lives here rather than in the route because the
 * bridge to object storage belongs to the runner, not to topicVideo.
 *
 * Throws VideoGenProviderError when the provider (or the character behind a
 * character scene) fails.
 */
export async function refreshStoryboardScenePreview(
  job: VideoGeneration,
  storyboard: VideoStoryboard,
  scene: VideoStoryboardScene,
): Promise<VideoStoryboard> {
  const priorImages = await loadGuidedContinuityBeforeScene(
    storyboard,
    scene.id,
    job.tenantId,
  );
  const previewPath = await regenerateStoryboardPreview({
    tenantId: job.tenantId,
    storyboard,
    scene,
    aspectRatio: job.options?.aspectRatio ?? "9:16",
    characterId: job.options?.characterId ?? null,
    selectedOutfitId: job.options?.outfitId ?? null,
    characterSnapshot: job.options?.characterSnapshot,
    imageSelectionPolicy: job.options?.guidedStory?.imageModelSnapshot,
    upload: (bytes, contentType) => uploadToStorage(job.tenantId, bytes, contentType),
    priorImages,
  });
  // Note: does NOT touch the regenerations counter — the preview route spends
  // a re-roll with an atomic conditional UPDATE before calling this, so
  // incrementing here as well would double-count.
  return {
    ...storyboard,
    scenes: storyboard.scenes.map((s) => (s.id === scene.id ? {
      ...s,
      previewPath,
      guidedStory: s.guidedStory
        ? {
            ...s.guidedStory,
            inconsistencyFlags: s.guidedStory.inconsistencyFlags.filter(
              (flag) => flag !== "visual_edited_preview_required",
            ),
          }
        : s.guidedStory,
    } : s)),
  };
}

async function loadGuidedContinuityBeforeScene(
  storyboard: VideoStoryboard,
  sceneId: string,
  tenantId: number,
): Promise<Buffer[]> {
  const target = storyboard.scenes.find((scene) => scene.id === sceneId);
  if (!target?.guidedStory) return [];
  const latestByRole = new Map<string, Buffer>();
  for (const scene of storyboard.scenes) {
    if (scene.id === sceneId) break;
    const accepted =
      scene.guidedStory &&
      scene.previewPath &&
      (!scene.previewCheckpoint ||
        (scene.previewCheckpoint.status === "complete" &&
          scene.previewCheckpoint.targetPath === scene.previewPath));
    if (!accepted) continue;
    const image = (await loadTenantObject(
      scene.previewPath!,
      tenantId,
      MAX_SOURCE_IMAGE_BYTES,
      "Guided Story continuity preview",
    )).buffer;
    rememberGuidedContinuityImage(scene, image, latestByRole);
  }
  return guidedContinuityImages(target, latestByRole);
}

/**
 * Whether the tenant's plan carries the app watermark, subject to the
 * platform-wide "freeWatermark" kill switch (default-ON: a transient
 * flag-read error fails OPEN). Tenant/plan lookup errors fail soft to no
 * watermark — this must never break a render.
 */
async function shouldApplyAppWatermark(tenantId: number): Promise<boolean> {
  try {
    const tenant = (
      await db
        .select({ plan: tenantsTable.plan })
        .from(tenantsTable)
        .where(eq(tenantsTable.id, tenantId))
        .limit(1)
    )[0];
    if (!tenant) return false;
    const plan = await getPlan(tenant.plan);
    if (!plan.watermark) return false;
  } catch (error) {
    logger.warn({ err: error, tenantId }, "Watermark plan lookup failed; skipping watermark");
    return false;
  }
  return await isFeatureEnabled("freeWatermark").catch(() => true);
}

async function extractNativeAudio(video: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "kokao-studio-lipsync-"));
  try {
    await writeFile(join(dir, "base.mp4"), video);
    await runFfmpeg([
      "-y",
      "-i",
      "base.mp4",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "24000",
      "-c:a",
      "pcm_s16le",
      "native.wav",
    ], dir);
    return await readLocalFile(join(dir, "native.wav"));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function extractStudioLipSyncSegment(
  video: Buffer,
  startSec: number,
  durationSec: number,
): Promise<Buffer> {
  if (startSec <= 0 && !Number.isFinite(durationSec)) return video;
  const dir = await mkdtemp(join(tmpdir(), "kokao-studio-lipsync-segment-"));
  try {
    await writeFile(join(dir, "base.mp4"), video);
    await runFfmpeg([
      "-y", "-ss", Math.max(0, startSec).toFixed(3), "-i", "base.mp4",
      "-t", Math.max(0.1, durationSec).toFixed(3),
      "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-c:a", "aac",
      "-movflags", "+faststart", "segment.mp4",
    ], dir);
    return await readLocalFile(join(dir, "segment.mp4"));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Automatic Guided Story dialogue finishing. Unlike the optional Studio pass,
 * this uses the frozen role voice and approved still, then the same controlled
 * image-to-video + Sync Lipsync 2 primitives as Character Dialogue.
 */
async function finishGuidedStoryIntrinsicDialogue(
  job: VideoGeneration,
  base: Buffer,
  baseEvents: VideoProviderEvent[],
  onStage: (stage: string) => void,
): Promise<{ buffer: Buffer; events: VideoProviderEvent[] }> {
  const snapshot = job.options?.guidedStoryIntrinsicLipSync;
  if (!snapshot?.scenes.length) return { buffer: base, events: [] };
  const resolved = job.options?.resolvedVideoModel;
  if (
    resolved?.generateAudio === true &&
    hasNativeSynchronizedAudio(resolved.provider, resolved.model)
  ) {
    return { buffer: base, events: [] };
  }
  const board = job.storyboard;
  if (!board || board.mode !== "guided_story" || board.timelineLocked !== true) {
    throw new VideoJobInputError("Automatic Guided Story dialogue requires its locked storyboard.");
  }
  if (snapshot.checkpoint?.state === "complete" && snapshot.checkpoint.outputPath) {
    return {
      buffer: (await loadTenantObject(
        snapshot.checkpoint.outputPath,
        job.tenantId,
        MAX_SOURCE_VIDEO_BYTES,
        "Saved automatic Guided Story dialogue",
      )).buffer,
      events: snapshot.checkpoint.scenes.flatMap((scene) =>
        [scene.animationEvent, scene.lipSyncEvent].filter(
          (event): event is VideoProviderEvent => Boolean(event),
        )
      ),
    };
  }

  const basePath = snapshot.checkpoint?.basePath ??
    await uploadToStorage(job.tenantId, base, "video/mp4");
  let options = structuredClone(job.options!);
  const prior = new Map(
    (snapshot.checkpoint?.scenes ?? []).map((scene) => [scene.sceneId, scene]),
  );
  options.renderCheckpoint = {
    stage: "final",
    path: basePath,
    provider: null,
    model: null,
    durationSec: job.options?.guidedStory?.platform.durationSeconds ?? 0,
    providerEvents: baseEvents,
  };
  options.guidedStoryIntrinsicLipSync = {
    ...snapshot,
    checkpoint: {
      state: "prepared",
      basePath,
      scenes: snapshot.scenes.map((scene) =>
        prior.get(scene.sceneId) ?? { sceneId: scene.sceneId, state: "prepared" }
      ),
    },
  };
  const save = async () => setJob(job.id, { options });
  await save();

  const clips: Buffer[] = [];
  const events: VideoProviderEvent[] = [];
  let cursor = 0;
  const model = resolveModelOptions(options, 5);
  const replicateDef = getVideoGenProviderDef("replicate");
  const replicateKey = replicateDef ? await resolveVideoGenApiKey(replicateDef) : null;

  for (const planned of snapshot.scenes) {
    const scene = board.scenes.find((candidate) => candidate.id === planned.sceneId);
    const startSec = planned.startMs / 1000;
    const durationSec = (planned.endMs - planned.startMs) / 1000;
    const endSec = startSec + durationSec;
    if (startSec > cursor) {
      clips.push(await extractStudioLipSyncSegment(base, cursor, startSec - cursor));
    }
    const checkpoint = () =>
      options.guidedStoryIntrinsicLipSync!.checkpoint!.scenes.find(
        (item) => item.sceneId === planned.sceneId,
      )!;
    const update = async (
      patch: Partial<ReturnType<typeof checkpoint>>,
    ) => {
      Object.assign(checkpoint(), patch);
      await save();
    };
    if (
      !scene?.guidedStory ||
      scene.guidedStory.inputFingerprint !== planned.inputFingerprint ||
      scene.guidedStory.inconsistencyFlags.length ||
      scene.guidedStory.roleIds.length !== 1 ||
      scene.guidedStory.roleIds[0] !== planned.roleId ||
      !scene.previewPath ||
      scene.previewCheckpoint?.status !== "complete" ||
      scene.previewCheckpoint.targetPath !== scene.previewPath
    ) {
      await update({ state: "skipped", skipReason: "The approved one-face storyboard still is unavailable." });
      clips.push(await extractStudioLipSyncSegment(base, startSec, durationSec));
      cursor = endSec;
      continue;
    }
    const existing = checkpoint();
    if (existing.state === "complete" && existing.outputPath) {
      clips.push((await loadTenantObject(
        existing.outputPath, job.tenantId, MAX_SOURCE_VIDEO_BYTES,
        "Saved automatic Guided Story dialogue scene",
      )).buffer);
      if (existing.animationEvent) events.push(existing.animationEvent);
      if (existing.lipSyncEvent) events.push(existing.lipSyncEvent);
      cursor = endSec;
      continue;
    }
    if (existing.state === "skipped") {
      clips.push(await extractStudioLipSyncSegment(base, startSec, durationSec));
      cursor = endSec;
      continue;
    }
    if (
      existing.state === "animation_succeeded" ||
      existing.state === "lipsync_succeeded"
    ) {
      throw new VideoGenProviderError(
        `Automatic Guided Story dialogue scene ${planned.sceneId} has a provider receipt without saved output; provider outcome is unknown.`,
      );
    }

    try {
      onStage(`Voicing Guided Story scene ${planned.sceneId}`);
      const narration = existing.audioPath
        ? (await loadTenantObject(
            existing.audioPath, job.tenantId, MAX_NARRATION_BYTES,
            "Saved Guided Story dialogue audio",
          )).buffer
        : await fitGuidedReplayWavToSlot(
            planned.voiceProvider === "stock"
              ? (await synthesizeNarration(
                  [planned.text],
                  resolveNarrationVoice(planned.voiceId, null),
                )).wav
              : await speakLocalizedBrandVoiceCue({
                  tenantId: job.tenantId,
                  jobId: job.id,
                  cueIndex: snapshot.scenes.indexOf(planned),
                  voice: {
                    provider: planned.voiceProvider,
                    voiceId: planned.providerVoiceId!,
                  },
                  text: planned.text,
                  modelId: "eleven_v3",
                  languageCode: snapshot.locale,
                }),
            Math.round(durationSec * 1000),
          );
      if (!existing.audioPath) {
        await update({
          audioPath: await uploadToStorage(job.tenantId, narration, "audio/wav"),
        });
      }
      const approved = await loadTenantObject(
        scene.previewPath, job.tenantId, MAX_SOURCE_IMAGE_BYTES,
        "Approved Guided Story still",
      );
      if (!ALLOWED_IMAGE_TYPES.has(approved.mimeType)) {
        throw new VideoJobInputError("Approved Guided Story still is not a supported image.");
      }
      const permitted = options.resolvedVideoModel?.permittedDurationSec ?? [model.durationSec];
      const animationDurationSec = [...permitted]
        .filter((value) => value >= durationSec)
        .sort((a, b) => a - b)[0];
      if (!animationDurationSec) {
        throw new VideoJobInputError(`No funded animation duration covers scene ${planned.sceneId}.`);
      }
      let plate: Buffer;
      let animationEvent = existing.animationEvent;
      if (existing.platePath) {
        if (!animationEvent) {
          throw new VideoGenProviderError(
            `Automatic Guided Story dialogue scene ${planned.sceneId} has a saved plate without its provider receipt.`,
          );
        }
        plate = (await loadTenantObject(
          existing.platePath, job.tenantId, MAX_SOURCE_VIDEO_BYTES,
          "Saved Guided Story dialogue plate",
        )).buffer;
      } else {
        onStage(`Animating Guided Story scene ${planned.sceneId}`);
        const animated = await generateVideo({
          mode: "image",
          prompt: [
            "Animate this exact approved composition without reframing or replacement.",
            `Only ${planned.characterName} (${planned.roleId}) is visible and speaking.`,
            `Match the approved identity exactly: ${planned.characterDescription}.`,
            `Keep the approved outfit unchanged: ${planned.outfitDescription}.`,
            "One person, one face, fully visible mouth. Stable backdrop, camera, lighting and body position. No text or subtitles.",
          ].join(" "),
          aspectRatio: options.aspectRatio ?? "9:16",
          image: { buffer: approved.buffer, mimeType: approved.mimeType },
          ...model,
          durationSec: animationDurationSec,
          // A selected model must not re-enable provider-native audio after
          // this silent approved-still plate contract was chosen.
          generateAudio: false,
        });
        animationEvent = {
          eventId: videoProviderEventId(job, `guided_intrinsic_animation:${planned.sceneId}`),
          provider: animated.provider,
          model: animated.model,
          durationSec: animationDurationSec,
          requestBytes: approved.buffer.length,
          label: `guided_intrinsic_animation:${planned.sceneId}`,
          criteria: videoPriceCriteria({
            resolution: model.resolution,
            quality: model.quality,
            generateAudio: false,
          }),
          costPaise: planned.estimatedAnimationPaise,
        };
        await update({ state: "animation_succeeded", animationEvent });
        await verifyRenderedVideo(animated.buffer, {
          minDurationSec: 0.1,
          label: "Guided Story intrinsic animation",
        });
        plate = animated.buffer;
        await update({
          state: "animation_complete",
          platePath: await uploadToStorage(job.tenantId, plate, "video/mp4"),
        });
      }
      onStage(`Syncing Guided Story scene ${planned.sceneId}`);
      const synced = await generateLipSyncWithReplicate({
        source: {
          buffer: await loopVideoPlateToDuration(plate, durationSec),
          mimeType: "video/mp4",
        },
        audio: { buffer: narration, mimeType: "audio/wav" },
        def: SYNC_LIPSYNC_2,
      }, replicateKey);
      const lipSyncEvent: VideoProviderEvent = {
        eventId: videoProviderEventId(job, `guided_intrinsic_lipsync:${planned.sceneId}`),
        provider: synced.provider,
        model: synced.model,
        durationSec,
        requestBytes: narration.length,
        label: `guided_intrinsic_lipsync:${planned.sceneId}`,
        criteria: videoPriceCriteria({ hasReferenceVideo: true }),
        costPaise: planned.estimatedLipSyncPaise,
      };
      await update({ state: "lipsync_succeeded", animationEvent, lipSyncEvent });
      await verifyRenderedVideo(synced.buffer, {
        minDurationSec: 0.1,
        label: "Guided Story intrinsic lip-sync",
      });
      const output = await trimCharacterDialogueClipStrict(
        await normalizeVideo(synced.buffer, options.aspectRatio ?? "9:16"),
        durationSec,
        narration,
      );
      // The base soundtrack contains mixed dialogue and has no guaranteed
      // music-only stem. Preserve the exact WAV submitted to Sync Lipsync 2
      // rather than muxing potentially different speech back over its mouth.
      const outputPath = await uploadToStorage(job.tenantId, output, "video/mp4");
      await update({ state: "complete", outputPath, animationEvent, lipSyncEvent });
      clips.push(output);
      events.push(animationEvent!, lipSyncEvent);
    } catch (error) {
      const current = checkpoint();
      if (
        current.state === "animation_succeeded" ||
        current.state === "lipsync_succeeded"
      ) throw error;
      logger.warn(
        { err: error, jobId: job.id, sceneId: planned.sceneId },
        "automatic Guided Story dialogue failed without receipt; retaining base scene",
      );
      await update({
        state: "skipped",
        skipReason: error instanceof Error ? error.message.slice(0, 300) : "Dialogue finishing failed.",
      });
      clips.push(await extractStudioLipSyncSegment(base, startSec, durationSec));
    }
    cursor = endSec;
  }
  const totalSec = Math.max(
    cursor,
    ...board.scenes.map((scene) => scene.guidedStory?.endMs
      ? scene.guidedStory.endMs / 1000
      : 0),
  );
  if (cursor < totalSec) {
    clips.push(await extractStudioLipSyncSegment(base, cursor, totalSec - cursor));
  }
  const output = clips.length === 1 ? clips[0]! : await concatClips(clips);
  const outputPath = await uploadToStorage(job.tenantId, output, "video/mp4");
  options.guidedStoryIntrinsicLipSync!.checkpoint = {
    ...options.guidedStoryIntrinsicLipSync!.checkpoint!,
    state: "complete",
    outputPath,
  };
  await save();
  return {
    buffer: output,
    events: options.guidedStoryIntrinsicLipSync!.checkpoint!.scenes.flatMap(
      (scene) => [scene.animationEvent, scene.lipSyncEvent].filter(
        (event): event is VideoProviderEvent => Boolean(event),
      ),
    ),
  };
}

/**
 * Shared post-render finishing pass. Its input audio is extracted from the
 * completed base render, so approved narration/dialogue timing remains the
 * only timing authority. Dedicated lip-sync engines never enter this stage.
 */
async function finishWithStudioLipSync(
  job: VideoGeneration,
  base: Buffer,
  baseEvents: VideoProviderEvent[],
  onStage: (stage: string) => void,
): Promise<{
  buffer: Buffer;
  events: VideoProviderEvent[];
  outputPath: string | null;
}> {
  const snapshot = job.options?.studioLipSync;
  if (!snapshot) return { buffer: base, events: [], outputPath: null };
  if (job.engine === "lip_sync" || job.engine === "dialogue_lip_sync") {
    throw new VideoJobInputError("A dedicated lip-sync job cannot run the optional finishing pass.");
  }
  if (snapshot.checkpoint?.state === "complete" && snapshot.checkpoint.outputPath) {
    return {
      buffer: (
        await loadTenantObject(
          snapshot.checkpoint.outputPath,
          job.tenantId,
          MAX_SOURCE_VIDEO_BYTES,
          "Saved optional lip-sync output",
        )
      ).buffer,
      events: snapshot.checkpoint.scenes?.flatMap((scene) => scene.event ? [scene.event] : []) ??
        (snapshot.checkpoint.event ? [snapshot.checkpoint.event] : []),
      outputPath: snapshot.checkpoint.outputPath,
    };
  }
  // Retain the completed base before the optional provider starts. A finishing
  // failure can therefore be recovered or surfaced without regenerating scenes.
  const basePath = await uploadToStorage(job.tenantId, base, "video/mp4");
  const latest = (
    await db.select({ options: videoGenerationsTable.options })
      .from(videoGenerationsTable)
      .where(eq(videoGenerationsTable.id, job.id))
      .limit(1)
  )[0];
  const preparedOptions = structuredClone(latest?.options ?? job.options!);
  preparedOptions.renderCheckpoint = {
    stage: "final",
    path: basePath,
    provider: null,
    model: null,
    durationSec: snapshot.plan.reduce((sum, scene) => sum + scene.durationSec, 0),
    providerEvents: baseEvents,
  };
  const sceneCheckpoints = new Map(
    (snapshot.checkpoint?.scenes ?? []).map((scene) => [scene.sceneId, scene]),
  );
  preparedOptions.studioLipSync = {
    ...snapshot,
    checkpoint: { state: "prepared", scenes: snapshot.plan.map((scene) =>
      sceneCheckpoints.get(scene.sceneId) ?? { sceneId: scene.sceneId, state: "prepared" },
    ) },
  };
  await setJob(job.id, { options: preparedOptions });

  const clips: Buffer[] = [];
  let cursor = 0;
  let latestOptions = preparedOptions;
  for (const scene of snapshot.plan) {
    const existing = latestOptions.studioLipSync?.checkpoint?.scenes?.find(
      (item) => item.sceneId === scene.sceneId,
    );
    const startSec = scene.startSec ?? cursor;
    const endSec = scene.endSec ?? startSec + scene.durationSec;
    if (startSec > cursor) clips.push(await extractStudioLipSyncSegment(base, cursor, startSec - cursor));
    if (existing?.state === "complete" && existing.outputPath) {
      clips.push((await loadTenantObject(existing.outputPath, job.tenantId, MAX_SOURCE_VIDEO_BYTES, "Saved optional lip-sync scene")).buffer);
    } else {
      if (existing?.state === "provider_succeeded") {
        throw new VideoGenProviderError(`Optional lip-sync scene ${scene.sceneId} succeeded but its output was not retained; it will not be charged twice.`);
      }
      // A kill switch is intentionally checked immediately before each paid
      // dispatch, not only when the job was accepted.
      if (!(await isFeatureEnabled("studioLipSync"))) {
        throw new VideoJobInputError("Optional Studio lip-sync was turned off before provider dispatch.");
      }
      onStage(`Syncing eligible scene ${scene.sceneId} for video #${job.id}`);
      const replicateDef = getVideoGenProviderDef("replicate");
      const apiKey = replicateDef ? await resolveVideoGenApiKey(replicateDef) : null;
      let source: Buffer | null = null;
      let audioBytes = 0;
      let result: Awaited<ReturnType<typeof generateLipSyncWithReplicate>>;
      try {
        // The optional-scene boundary includes its local ffmpeg preparation.
        // A bad span or missing audio stream must preserve the finished base
        // video just like a provider refusal does.
        source = await extractStudioLipSyncSegment(
          base,
          startSec,
          endSec - startSec,
        );
        const audio = await extractNativeAudio(source);
        audioBytes = audio.byteLength;
        result = await generateLipSyncWithReplicate({ source: { buffer: source, mimeType: "video/mp4" }, audio: { buffer: audio, mimeType: "audio/wav" }, def: LATENT_SYNC }, apiKey);
      } catch (err) {
        const concurrentOptions = (
          await db.select({ options: videoGenerationsTable.options })
            .from(videoGenerationsTable)
            .where(eq(videoGenerationsTable.id, job.id))
            .limit(1)
        )[0]?.options;
        const concurrentCheckpoint =
          concurrentOptions?.studioLipSync?.checkpoint?.state === "complete" &&
          concurrentOptions.studioLipSync.checkpoint.outputPath
            ? concurrentOptions.studioLipSync.checkpoint
            : null;
        if (concurrentCheckpoint) {
          logger.warn(
            { jobId: job.id, sceneId: scene.sceneId },
            "Adopting Studio lip-sync output completed by a newer worker",
          );
          return {
            buffer: (
              await loadTenantObject(
                concurrentCheckpoint.outputPath!,
                job.tenantId,
                MAX_SOURCE_VIDEO_BYTES,
                "Concurrently completed optional lip-sync output",
              )
            ).buffer,
            events:
              concurrentCheckpoint.scenes?.flatMap((item) =>
                item.event ? [item.event] : []
              ) ??
              (concurrentCheckpoint.event ? [concurrentCheckpoint.event] : []),
            outputPath: concurrentCheckpoint.outputPath!,
          };
        }
        // This is optional finishing work over a completed base render. A
        // provider refusal costs this scene its sync, not the whole video.
        // Receipt-bearing provider_succeeded checkpoints still fail above.
        logger.warn(
          { err, jobId: job.id, sceneId: scene.sceneId },
          "optional lip-sync scene refused; shipping that scene unsynced",
        );
        const skipped = latestOptions.studioLipSync!.checkpoint!.scenes!.map((item) =>
          item.sceneId === scene.sceneId
            ? {
                ...item,
                state: "skipped" as const,
                skipReason:
                  err instanceof Error
                    ? err.message.slice(0, 300)
                    : "the provider refused this scene",
              }
            : item,
        );
        latestOptions = structuredClone(latestOptions);
        latestOptions.studioLipSync = {
          ...snapshot,
          checkpoint: { state: "prepared", scenes: skipped },
        };
        await setJob(job.id, { options: latestOptions });
        // If segment extraction succeeded, retain that exact unsynced span and
        // advance normally. If it failed, leave the cursor in place so the next
        // gap fill (or trailing fill) copies the original span from the base.
        if (source) {
          clips.push(source);
          cursor = endSec;
        }
        continue;
      }
      // Persist the durable provider receipt before *any* fallible work on the
      // returned bytes. A QA/upload crash is therefore a hard no-redispatch
      // barrier for this exact scene.
      const receiptEvent: VideoProviderEvent = {
        eventId: videoProviderEventId(job, `studio_lip_sync:${scene.sceneId}`), provider: snapshot.provider, model: snapshot.model,
        durationSec: scene.durationSec,
        requestBytes: source!.byteLength + audioBytes, label: `studio_lip_sync:${scene.sceneId}`,
        criteria: videoPriceCriteria({ hasReferenceVideo: true }),
        costPaise: scene.estimatedPricePaise,
      };
      const providerScenes = latestOptions.studioLipSync!.checkpoint!.scenes!.map((item) => item.sceneId === scene.sceneId ? { ...item, state: "provider_succeeded" as const, event: receiptEvent } : item);
      latestOptions = structuredClone(latestOptions);
      latestOptions.studioLipSync = { ...snapshot, checkpoint: { state: "prepared", scenes: providerScenes } };
      await setJob(job.id, { options: latestOptions });
      const durationSec = (await verifyRenderedVideo(result.buffer, { minDurationSec: 0.1, label: "optional Studio lip-sync output" })).durationSec;
      const event: VideoProviderEvent = {
        ...receiptEvent,
        durationSec,
        // Catalog price is immutable for this job: an admin price edit after
        // enqueue cannot change this acknowledged provider receipt.
        costPaise: scene.estimatedPricePaise,
      };
      const outputPath = await uploadToStorage(job.tenantId, result.buffer, "video/mp4");
      latestOptions.studioLipSync!.checkpoint!.scenes = providerScenes.map((item) => item.sceneId === scene.sceneId ? { ...item, state: "complete" as const, outputPath, event } : item);
      await setJob(job.id, { options: latestOptions });
      clips.push(result.buffer);
    }
    cursor = endSec;
  }
  // Guided plans can intentionally skip ambiguous scenes; keep those base
  // intervals byte-for-byte out of the provider path.
  const baseDurationSec = Math.max(
    cursor,
    job.options?.guidedStory?.platform.durationSeconds ?? 0,
    (job.durationMs ?? 0) / 1000,
    ...snapshot.plan.map((scene) => scene.endSec ?? 0),
  );
  if (cursor < baseDurationSec) {
    clips.push(await extractStudioLipSyncSegment(base, cursor, baseDurationSec - cursor));
  }
  const output = clips.length === 1 ? clips[0]! : await concatClips(clips);
  const events = latestOptions.studioLipSync!.checkpoint!.scenes!.flatMap((scene) => scene.event ? [scene.event] : []);
  const outputPath = await uploadToStorage(job.tenantId, output, "video/mp4");
  latestOptions.studioLipSync = { ...snapshot, checkpoint: { state: "complete", outputPath, event: events[events.length - 1], scenes: latestOptions.studioLipSync!.checkpoint!.scenes } };
  await setJob(job.id, { options: latestOptions });
  return { buffer: output, events, outputPath };
}

async function executeVideoJob(
  job: VideoGeneration,
  funding: "quota" | "credit" | "wallet",
): Promise<void> {
  const jobId = job.id;
  const startedAt = Date.now();
  let completedProviderEvents: VideoProviderEvent[] = [];
  // Identifies a finishing output completed by this worker. If the database
  // later contains a different completed output while this worker is failing,
  // a newer recovery worker won the race and this stale worker must not
  // overwrite that progress with a terminal failure.
  let completedStudioLipSyncOutputPath: string | null = null;

  // Live progress: fire-and-forget stage writes; clients poll them. A stage
  // write must never fail (or slow down) the actual pipeline.
  const onStage = (stage: string): void => {
    void setJob(jobId, { stage }).catch(() => {});
  };

  try {
    const guidedSnapshot = job.options?.guidedStory;
    if (
      guidedSnapshot &&
      !guidedCastApprovalsMatch({
        draftRevision: guidedSnapshot.draftRevision,
        cast: guidedSnapshot.cast,
        approvals: guidedSnapshot.castApprovals,
      })
    ) {
      throw new VideoJobInputError(GUIDED_CAST_APPROVAL_REQUIRED_MESSAGE);
    }
    if (guidedSnapshot) {
      await verifyGuidedBackdropBytesBeforeRender(guidedSnapshot, job.tenantId);
    }
    // The long-standing Video Studio master switch overrides every engine,
    // including lip sync. Re-check it here so a queued or paused job cannot
    // outlive an admin shutdown and spend after the whole studio is disabled.
    if (!(await isFeatureEnabled("videoGen").catch(() => true))) {
      throw new VideoJobInputError("Video Studio is currently turned off.");
    }
    // Re-check at execution time so jobs queued just before an admin flips a
    // mode off fail through the normal terminal/refund path without rendering.
    // Flag-read failures deliberately fail open, matching all kill switches.
    const modeFeature = videoModeFeature(job.engine);
    if (
      modeFeature &&
      !(await isFeatureEnabled(modeFeature).catch(() => true))
    ) {
      throw new VideoJobInputError(VIDEO_MODE_DISABLED_MESSAGES[modeFeature]);
    }
    // This is intentionally before produceVideo: an optional snapshot carries
    // an extra paid operation, so its own emergency switch must prevent even
    // base provider work from beginning after it is disabled.
    if (
      job.options?.studioLipSync &&
      !(await isFeatureEnabled("studioLipSync").catch(() => true))
    ) {
      throw new VideoJobInputError("Optional Studio lip-sync is currently turned off.");
    }
    const savedRender =
      job.options?.renderCheckpoint ??
      job.options?.recovery?.rendered;
    const produced: ProduceResult = savedRender?.path && (!("stage" in savedRender) || savedRender.stage !== "provider_raw")
      ? {
          buffer: (
            await loadTenantObject(
              savedRender.path,
              job.tenantId,
              MAX_SOURCE_VIDEO_BYTES,
              "Saved completed render",
            )
          ).buffer,
          provider: savedRender.provider,
          model: savedRender.model,
          providerEvents: [],
          qa: { minDurationSec: 0.5, label: "saved completed render" },
        }
      : await produceVideo(job, onStage);
    completedProviderEvents =
      ("providerEvents" in produced ? produced.providerEvents : undefined) ?? [];
    // Music/raw-provider checkpoints can be written by a nested stage after
    // this worker claimed its snapshot. Include them once for settlement and
    // usage; event ids make a resumed chain idempotent.
    const currentCheckpointRow = (
      await db.select({
        options: videoGenerationsTable.options,
        storyboard: videoGenerationsTable.storyboard,
        errorHistory: videoGenerationsTable.errorHistory,
        stage: videoGenerationsTable.stage,
      })
        .from(videoGenerationsTable)
        .where(eq(videoGenerationsTable.id, jobId))
        .limit(1)
    )[0];
    completedProviderEvents = [
      ...completedProviderEvents,
      ...durableCheckpointEvents(currentCheckpointRow?.options),
      ...(job.options?.guidedStoryDialogueReplay
        ? []
        : currentCheckpointRow?.storyboard?.scenes.flatMap((scene) =>
          [
            ...(scene.providerCheckpoint?.event ? [scene.providerCheckpoint.event] : []),
            ...previewCheckpointEvents(scene.previewCheckpoint),
          ],
        ) ?? []),
    ].filter((event, index, all) =>
      all.findIndex((candidate) => candidate.eventId === event.eventId && candidate.label === event.label) === index,
    ).filter((event) => event.accounted !== true);

    // The storyboard pause. Nothing is metered and nothing is refunded: the
    // reservation stays reserved against the render the user is about to
    // approve, and the sweep gives it back if they never do.
    if (produced.paused) {
      await setJob(jobId, {
        status: "awaiting_review",
        storyboard: produced.storyboard,
        storyboardExpiresAt: new Date(Date.now() + STORYBOARD_TTL_MS),
        durationMs: Date.now() - startedAt,
        error: produced.fundingError ?? null,
        stage: null,
      });
      return;
    }
    let { buffer } = produced;
    const { provider, model, qa, localizedResult } = produced;

    // Quality gate: never deliver (or charge for) a broken render. A failure
    // here throws VideoGenProviderError and lands in the refund path below.
    onStage("Running quality checks");
    let { durationSec: clipDurationSec } = await verifyRenderedVideo(buffer, qa);
    // Engines that return one provider render rather than a scene event list
    // still need a durable event before any downstream storage/DB operation.
    // Otherwise an upload failure could refund work the provider completed.
    if (
      !savedRender &&
      videoJobUnits(job.engine, job.options) > 0 &&
      completedProviderEvents.length === 0 &&
      provider &&
      model &&
      !isKnownFreeStockTopicRender(
        job.engine,
        job.options?.visualsSource,
        provider,
      )
    ) {
      completedProviderEvents = [{
        eventId: videoProviderEventId(job, "render"),
        provider,
        model,
        durationSec: clipDurationSec,
        requestBytes: job.prompt ? Buffer.byteLength(job.prompt) : 0,
        label: "render",
        criteria: jobVideoPriceCriteria(
          job,
          job.engine === "lip_sync" || job.engine === "dialogue_lip_sync",
        ),
        costPaise: await computeVideoCostPaise({
          provider,
          model,
          durationSec: clipDurationSec,
          variantCriteria: jobVideoPriceCriteria(
            job,
            job.engine === "lip_sync" || job.engine === "dialogue_lip_sync",
          ),
        }).catch(() => null),
      }];
    }
    if (job.options?.guidedStoryIntrinsicLipSync) {
      const finished = await finishGuidedStoryIntrinsicDialogue(
        job,
        buffer,
        completedProviderEvents,
        onStage,
      );
      buffer = finished.buffer;
      completedProviderEvents = [...completedProviderEvents, ...finished.events];
      clipDurationSec = (
        await verifyRenderedVideo(buffer, {
          ...qa,
          label: "automatic Guided Story dialogue output",
        })
      ).durationSec;
    }
    if (job.options?.studioLipSync) {
      const finished = await finishWithStudioLipSync(
        job,
        buffer,
        completedProviderEvents,
        onStage,
      );
      buffer = finished.buffer;
      completedStudioLipSyncOutputPath = finished.outputPath;
      if (finished.events.length > 0) {
        completedProviderEvents = [
          ...completedProviderEvents,
          ...finished.events,
        ].filter((event, index, all) =>
          all.findIndex((candidate) =>
            candidate.eventId === event.eventId && candidate.label === event.label
          ) === index
        );
      }
      clipDurationSec = (
        await verifyRenderedVideo(buffer, {
          ...qa,
          label: "optional Studio lip-sync output",
        })
      ).durationSec;
    }

    // Plans with the watermark switch ON get a "Made with KOKAO.in" pill in
    // the corner, subject to the platform-wide kill switch. Every step fails
    // SOFT to the unwatermarked video — this must never fail a paid render.
    if (await shouldApplyAppWatermark(job.tenantId)) {
      const aspect = job.options?.aspectRatio ?? "9:16";
      buffer = await applyAppWatermarkToVideo(buffer, aspect);
    }

    onStage("Saving to your library");
    let videoPath =
      completedStudioLipSyncOutputPath
        ? completedStudioLipSyncOutputPath
        : (savedRender?.path ?? null);
    if (!videoPath) {
      videoPath = await uploadToStorage(job.tenantId, buffer, "video/mp4");
      const latest = (
        await db
          .select({ options: videoGenerationsTable.options })
          .from(videoGenerationsTable)
          .where(eq(videoGenerationsTable.id, jobId))
          .limit(1)
      )[0];
      const checkpointOptions = structuredClone(
        latest?.options ?? job.options ?? { aspectRatio: "9:16" as const },
      );
      checkpointOptions.renderCheckpoint = {
        stage: "final",
        path: videoPath,
        provider,
        model,
        durationSec: clipDurationSec,
        providerEvents: completedProviderEvents,
      };
      // Persist the completed bytes before thumbnail extraction, settlement,
      // usage metering and the terminal status update. A retry can now perform
      // those local steps without invoking a provider.
      await setJob(jobId, { options: checkpointOptions });
    }
    // Thumbnail is best-effort: a poster failure must never fail the video.
    let thumbnailPath: string | null = null;
    try {
      const poster = await extractPosterFrame(buffer);
      thumbnailPath = await uploadToStorage(job.tenantId, poster, "image/png");
    } catch (err) {
      logger.warn({ err, jobId }, "Video poster frame extraction failed");
    }

    // A reviewed job ran in two halves; add this one to the planning time
    // already recorded so the cost meters see the whole job.
    const durationMs = (job.durationMs ?? 0) + (Date.now() - startedAt);
    // Multi-unit jobs (character story videos: one unit per scene) meter one
    // usage row per unit so quota accounting matches what was reserved.
    const units = videoJobUnits(job.engine, job.options);
    const usageUnits = units;
    const usageModel = model ?? `slideshow/${job.sourceImagePaths?.length ?? 0}-images`;
    const usageProvider = provider ?? "ffmpeg";
    // Actual provider cost from the admin price catalog ($/second of output
    // when priced per second, else flat $/video). Best-effort: a lookup
    // failure or an uncataloged model stores NULL (unknown), never a guess,
    // and must never fail the job itself.
    // Use the normalized event collection assembled above. It includes
    // per-scene checkpoints and the synthetic direct-render event when an
    // engine returned provider/model metadata without its own receipt list.
    // Local-only work (for example a slideshow without AI music) correctly
    // leaves this empty and is represented by supplemental zero-cost units.
    const providerEventsRaw = completedProviderEvents;
    // Frozen scene labels are durable operation keys. Defensive de-duping keeps
    // a resume/checkpoint merge from recording any paid visual or lip-sync work
    // twice while retaining distinct legacy events.
    const seenProviderEvents = new Set<string>();
    const providerEvents = providerEventsRaw.filter((event) => {
      if (event.accounted) return false;
      const key = `${event.provider}\0${event.model}\0${event.label}`;
      if (seenProviderEvents.has(key)) return false;
      seenProviderEvents.add(key);
      return true;
    });
    const eventCosts = await Promise.all(providerEvents.map(async (event) => {
      const computed =
        event.costPaise ??
        await computeVideoCostPaise({
          provider: event.provider,
          model: event.model,
          durationSec: event.durationSec,
          variantCriteria: event.criteria,
        }).catch(() => null);
      // Provider work is never assumed free. The pricing layer can return 0
      // for an uncataloged/free-tagged model or sub-paise rounding; preserve
      // that as unknown so quota history and wallet reconciliation never
      // silently record a paid provider call as zero cost.
      return typeof computed === "number" && computed > 0 ? computed : null;
    }));
    const costPaise =
      eventCosts.every((cost) => cost !== null)
        ? (eventCosts as number[]).reduce((sum, cost) => sum + cost, 0)
        : null;
    const reservations = await videoJobWalletReservations(job);
    // Legacy/single-reservation jobs have always carried their primary wallet
    // hold on the job row. Keep that durable fallback when no linked ledger
    // rows are returned; deferred jobs with top-ups use the enumerated list so
    // their aggregate amount is never mistaken for the primary reservation.
    if (reservations.length === 0) {
      const primary = reservationFromRow(job);
      if (primary) reservations.push(primary);
    }
    const reservation = reservations[0] ?? null;
    if (reservation && costPaise === null) {
      throw new VideoGenNotConfiguredError(
        "A completed video provider event has no authoritative price, so this wallet job cannot be finalized.",
      );
    }
    // Snapshot the TOTAL display spend BEFORE the terminal status flip:
    // clients stop polling/refetching the moment they see "succeeded", so a
    // spend written afterwards could be missed forever. The first unit
    // carries the render's real cost; supplemental units cost a known 0. Any
    // unit without a snapshot leaves the total null — clients fall back to
    // chargedRatePaise x units, never a partial sum.
    let unitSpends: (number | null)[] = [];
    let spendPaise: number | null = null;
    if (reservation) {
      try {
        const videoTarget = {
          paise: await exactChargePaise(costPaise),
          estimated: false,
        };
        const existingCharges =
          (await getVideoJobWalletChargesPaise(job.tenantId, [job.id])).get(job.id) ?? 0;
        spendPaise = existingCharges + videoTarget.paise;
        unitSpends = Array.from({ length: usageUnits }, (_, i) => {
          const base = Math.floor(videoTarget.paise / usageUnits);
          return base + (i < videoTarget.paise % usageUnits ? 1 : 0);
        });
      } catch {
        unitSpends = [];
        spendPaise = null;
      }
    } else {
      try {
        const config = await getAiSpendConfig();
        unitSpends = Array.from({ length: usageUnits }, (_, i) =>
          computeDisplayPaise("video", eventCosts[i] ?? (i < providerEvents.length ? null : 0), config),
        );
        spendPaise = unitSpends.every((s) => s !== null)
          ? (unitSpends as number[]).reduce((a, b) => a + b, 0)
          : null;
      } catch {
        unitSpends = [];
        spendPaise = null;
      }
    }
    await setJob(jobId, {
      status: "succeeded",
      spendPaise,
      videoPath,
      thumbnailPath,
      provider,
      model,
      durationMs,
      error: null,
      stage: null,
      // Persist the localized_dub result snapshot atomically with the status
      // flip so clients see consistent data the moment the job succeeds.
      ...(localizedResult != null ? { localizedResult } : {}),
    });
    if (job.options?.studioLipSync) {
      const recovered = job.options.recovery?.sourceJobId != null;
      recordStudioLipSyncEvent({
        name: recovered
          ? "studio_lipsync_recovery_completed"
          : "studio_lipsync_finishing_succeeded",
        tenantId: job.tenantId,
        workflow: studioLipSyncWorkflow(job),
        fundingRail: funding,
        sceneCount: job.options.studioLipSync.plan.length,
        outcome: recovered ? "recovered" : "succeeded",
      });
    }
    if (job.options?.guidedStoryDialogueReplay) {
      const replay = job.options.guidedStoryDialogueReplay;
      void recordServerEvent({
        name: "dialogue_replay_succeeded",
        tenantId: job.tenantId,
        params: {
          line_count: replay.estimates.lineCount,
          operation_count: replay.estimates.units,
          funding_rail: funding,
          has_ownerless_narration: replay.lines.some(
            (line) => line.speaker.type === "offscreen",
          ),
        },
      });
    }
    // Wallet: settle the reserved estimate. When the price catalog yields a
    // real cost for this render it settles at actual cost + fee; an
    // uncataloged model settles at the admin display rate and is flagged
    // `estimated` in the ledger.
    let walletSettlementCompleted = reservation === null;
    if (reservation) {
      try {
        const finalChargePaise = await exactChargePaise(costPaise);
        const totalReservedPaise = reservations.reduce((sum, item) => sum + item.amountPaise, 0);
        if (totalReservedPaise < finalChargePaise) {
          throw new Error(
            `Video job ${job.id} reserved ${totalReservedPaise} paise but requires ${finalChargePaise} paise`,
          );
        }
        let remainingChargePaise = finalChargePaise;
        let settlementError: unknown = null;
        for (const held of reservations) {
          const allocatedChargePaise = Math.min(held.amountPaise, remainingChargePaise);
          try {
            await settleWalletDurably(
              job.tenantId,
              held,
              {
                kind: "video",
                costPaise,
                provider: usageProvider,
                model: usageModel,
                refKind: "videoJob",
                refId: String(job.id),
              },
              { targetChargePaise: allocatedChargePaise },
            );
          } catch (error) {
            settlementError ??= error;
          }
          remainingChargePaise -= allocatedChargePaise;
        }
        if (settlementError) throw settlementError;
        walletSettlementCompleted = true;
      } catch (err) {
        walletSettlementCompleted = false;
        logger.error({ err, jobId }, "Failed to settle video job wallet charge");
      }
    }
    const isRetryChainCompletion =
      job.options?.recovery?.sourceJobId != null ||
      job.options?.characterDialogue?.retry?.sourceJobId != null;
    if (
      walletSettlementCompleted &&
      (reservation !== null || isRetryChainCompletion) &&
      (job.options?.characterDialogue || job.options?.recovery)
    ) {
      try {
        await reconcileVideoJobWalletCost(job.id);
      } catch (err) {
        logger.error({ err, jobId }, "Failed to reconcile retry-chain video wallet charge");
      }
    }
    for (let i = 0; i < providerEvents.length; i++) {
      const event = providerEvents[i]!;
      await recordUsage(job.tenantId, "video", {
        funding,
        durationMs: i === providerEvents.length - 1 ? durationMs : undefined,
        responseBytes: i === providerEvents.length - 1 ? buffer.length : undefined,
        model: event.model,
        provider: event.provider,
        requestBytes: event.requestBytes,
        ...(eventCosts[i] !== null ? { costPaise: eventCosts[i]! } : {}),
        ...(unitSpends[i] != null ? { displayPaiseOverride: unitSpends[i] } : {}),
      });
    }
    for (let i = providerEvents.length; i < usageUnits; i++) {
      await recordUsage(job.tenantId, "video", {
        funding,
        model: model ?? undefined,
        provider: provider ?? undefined,
        costPaise: 0,
        ...(unitSpends[i] != null ? { displayPaiseOverride: unitSpends[i] } : {}),
      });
    }
  } catch (error) {
    logger.error({ err: error, jobId }, "Video generation job failed");
    const partialWork = error instanceof PartialVideoProviderWorkError ? error : null;
    const latestCheckpointRow = (
      await db.select({
        options: videoGenerationsTable.options,
        storyboard: videoGenerationsTable.storyboard,
        status: videoGenerationsTable.status,
      })
        .from(videoGenerationsTable)
        .where(eq(videoGenerationsTable.id, jobId))
        .limit(1)
    )[0];
    const latestStudioOutput =
      latestCheckpointRow?.options?.studioLipSync?.checkpoint?.state === "complete"
        ? latestCheckpointRow.options.studioLipSync.checkpoint.outputPath ?? null
        : null;
    if (
      latestStudioOutput &&
      latestStudioOutput !== completedStudioLipSyncOutputPath
    ) {
      logger.warn(
        {
          jobId,
          staleWorkerStatus: latestCheckpointRow?.status,
          completedOutputPath: latestStudioOutput,
        },
        "Ignoring stale video worker failure after a newer worker completed Studio lip-sync",
      );
      return;
    }
    const partialEvents: VideoProviderEvent[] = [
      ...(partialWork ? partialWork.providerEvents : completedProviderEvents),
      ...durableCheckpointEvents(latestCheckpointRow?.options),
      ...(job.options?.guidedStoryDialogueReplay
        ? []
        : latestCheckpointRow?.storyboard?.scenes.flatMap((scene) =>
          [
            ...(scene.providerCheckpoint?.event ? [scene.providerCheckpoint.event] : []),
            ...previewCheckpointEvents(scene.previewCheckpoint),
          ],
        ) ?? []),
    ]
      // Recovery children inherit durable receipts from their source with
      // accounted=true. They are reusable checkpoints, not new provider work,
      // so a failed child must never record or settle them again.
      .filter((event) => event.accounted !== true)
      .filter((event, index, all) =>
        all.findIndex((candidate) => candidate.eventId === event.eventId && candidate.label === event.label) === index,
      );
    const surfacedError = partialWork?.cause ?? error;
    const message =
      surfacedError instanceof ImageGenProviderError
        ? imageProviderFailureMessage(surfacedError, latestCheckpointRow?.storyboard)
        : surfacedError instanceof VideoGenNotConfiguredError ||
            surfacedError instanceof VideoGenProviderError
          ? safeVideoErrorMessage(
              surfacedError,
              "The video provider could not complete this generation. Please try again.",
            )
          : surfacedError instanceof VideoJobInputError ||
              surfacedError instanceof CueOverrunError ||
              surfacedError instanceof LocalizedDubInputError
        ? surfacedError.message
        : "Video generation failed. Please try again.";
    await db.transaction(async (tx) => {
      const [latest] = await tx.select().from(videoGenerationsTable)
        .where(eq(videoGenerationsTable.id, jobId)).limit(1);
      let failedOptions = latest?.options ?? job.options;
      let failedStoryboard = latest?.storyboard ?? job.storyboard;
      const correlatedSceneAttempt = (latest?.errorHistory ?? [])
        .filter((entry) =>
          entry.scope === "scene" &&
          entry.outcome === "stopped" &&
          entry.providerRequestId === providerRequestIdFromError(surfacedError) &&
          entry.code === safeFailureCode(surfacedError)
        )
        .reduce((max, entry) => Math.max(max, entry.attempt), 0);
      const baseAttempt = correlatedSceneAttempt || failureAttempt(latest?.errorHistory, {
        scope: "job",
        sceneId: null,
        operation: latest?.stage ?? job.stage ?? "video_generation",
        outcome: "stopped",
        error: surfacedError,
      });
      const baseHistory = failureEntry({
        job, scope: "job", operation: latest?.stage ?? job.stage ?? "video_generation",
         error: surfacedError, outcome: "stopped", attempt: baseAttempt,
         provider: latest?.options?.resolvedVideoModel?.provider ??
           job.options?.resolvedVideoModel?.provider,
         model: latest?.options?.resolvedVideoModel?.model ??
           job.options?.resolvedVideoModel?.model,
      });
      let errorHistory = appendFailureHistory(latest?.errorHistory, baseHistory);
      // Make stopping behavior explicit for a reviewed board: any scene without
      // a durable render receipt was not attempted after this failure.
      let failedSceneSeen = false;
      for (const scene of failedStoryboard?.scenes ?? []) {
        // A scene-specific boundary has already recorded the stopping scene.
        // Only scenes after it that have no receipt are explicitly untouched.
        if (!failedSceneSeen) {
          failedSceneSeen = errorHistory.some((item) => item.scope === "scene" && item.sceneId === scene.id && item.outcome === "stopped");
          continue;
        }
        if (scene.providerCheckpoint?.path) continue;
        errorHistory = appendFailureHistory(errorHistory, {
          ...failureEntry({
            job, scope: "scene", scene, operation: "pipeline", error: surfacedError,
            outcome: "not_attempted", attempt: baseAttempt,
          }),
        });
      }
      if (failedOptions && partialEvents.length > 0) {
        failedOptions = structuredClone(failedOptions);
        const labels = new Set(partialEvents.map((event) => event.label));
        if (failedOptions.characterDialogue) {
          for (const scene of failedOptions.characterDialogue.scenes) {
            if (scene.checkpoint?.visualEvent && labels.has(scene.checkpoint.visualEvent.label)) {
              scene.checkpoint.visualEvent.accounted = true;
            }
            if (scene.checkpoint?.lipSyncEvent && labels.has(scene.checkpoint.lipSyncEvent.label)) {
              scene.checkpoint.lipSyncEvent.accounted = true;
            }
          }
          const musicEvent = failedOptions.characterDialogue.musicCheckpoint?.event;
          if (musicEvent && labels.has(musicEvent.label)) musicEvent.accounted = true;
        }
        for (const event of failedOptions.presenterBroll?.providerEvents ?? []) {
          if (labels.has(event.label)) event.accounted = true;
        }
        const presenterMusicEvent = failedOptions.presenterMusicCheckpoint?.event;
        if (presenterMusicEvent && labels.has(presenterMusicEvent.label)) {
          presenterMusicEvent.accounted = true;
        }
        for (const event of failedOptions.renderCheckpoint?.providerEvents ?? []) {
          if (labels.has(event.label)) event.accounted = true;
        }
        const studioLipSyncEvent = failedOptions.studioLipSync?.checkpoint?.event;
        if (studioLipSyncEvent && labels.has(studioLipSyncEvent.label)) {
          studioLipSyncEvent.accounted = true;
        }
        for (const scene of failedOptions.studioLipSync?.checkpoint?.scenes ?? []) {
          if (scene.event && labels.has(scene.event.label)) scene.event.accounted = true;
        }
        markGuidedStoryIntrinsicEventsAccounted(failedOptions, labels);
        if (failedOptions.musicCheckpoint?.event && labels.has(failedOptions.musicCheckpoint.event.label)) {
          failedOptions.musicCheckpoint.event.accounted = true;
        }
        if (failedStoryboard) {
          failedStoryboard = structuredClone(failedStoryboard);
          if (failedStoryboard.dialogueReplayCheckpoint) {
            for (const line of Object.values(
              failedStoryboard.dialogueReplayCheckpoint.lines,
            )) {
              if (
                line.animationEvent &&
                labels.has(line.animationEvent.label)
              ) {
                line.animationEvent.accounted = true;
              }
              if (
                line.lipSyncEvent &&
                labels.has(line.lipSyncEvent.label)
              ) {
                line.lipSyncEvent.accounted = true;
              }
            }
          }
          for (const scene of failedStoryboard.scenes) {
            const event = scene.providerCheckpoint?.event;
            if (event && labels.has(event.label)) event.accounted = true;
            for (const previewEvent of previewCheckpointEvents(scene.previewCheckpoint)) {
              if (labels.has(previewEvent.label)) previewEvent.accounted = true;
            }
          }
        }
      }
      await tx.update(videoGenerationsTable).set({
        status: "failed", error: message, stage: null, storyboardExpiresAt: null,
        provider: latest?.options?.resolvedVideoModel?.provider ??
          job.options?.resolvedVideoModel?.provider ?? null,
        model: latest?.options?.resolvedVideoModel?.model ??
          job.options?.resolvedVideoModel?.model ?? null,
        providerRequestId: baseHistory.providerRequestId,
        errorHistory,
        durationMs: (job.durationMs ?? 0) + (Date.now() - startedAt),
        ...(failedOptions?.studioLipSync && failedOptions.renderCheckpoint?.path
          ? { videoPath: failedOptions.renderCheckpoint.path }
          : {}),
        ...(failedOptions ? { options: failedOptions } : {}),
        ...(failedStoryboard ? { storyboard: failedStoryboard } : {}),
      }).where(eq(videoGenerationsTable.id, jobId));
    }).catch(() => {});
    if (job.options?.guidedStoryDialogueReplay) {
      const replay = job.options.guidedStoryDialogueReplay;
      void recordServerEvent({
        name: "dialogue_replay_failed",
        tenantId: job.tenantId,
        params: {
          line_count: replay.estimates.lineCount,
          operation_count: replay.estimates.units,
          funding_rail: funding,
          has_ownerless_narration: replay.lines.some(
            (line) => line.speaker.type === "offscreen",
          ),
          is_retry: job.options.recovery?.sourceJobId != null,
        },
      });
    }
    if (job.options?.studioLipSync) {
      recordStudioLipSyncEvent({
        name: "studio_lipsync_finishing_failed",
        tenantId: job.tenantId,
        workflow: studioLipSyncWorkflow(job),
        fundingRail: funding,
        sceneCount: job.options.studioLipSync.plan.length,
        outcome: "failed",
      });
    }
    const reservation = reservationFromRow(job);
    if (partialEvents.length > 0) {
      let displayPaiseOverride: number | undefined;
      try {
        const partialCost =
          partialEvents.every((event) => event.costPaise !== null)
            ? partialEvents.reduce((sum, event) => sum + event.costPaise!, 0)
            : null;
        const display = computeDisplayPaise("video", partialCost, await getAiSpendConfig());
        if (display !== null) displayPaiseOverride = display;
      } catch {
        // Usage remains authentic with an unknown display amount.
      }
      for (let i = 0; i < partialEvents.length; i++) {
        const event = partialEvents[i]!;
        await recordUsage(job.tenantId, "video", {
          funding,
          provider: event.provider,
          model: event.model,
          requestBytes: event.requestBytes,
          ...(event.costPaise !== null ? { costPaise: event.costPaise } : {}),
          ...(i === 0 && displayPaiseOverride !== undefined ? { displayPaiseOverride } : {}),
        }).catch((err) =>
          logger.error({ err, jobId }, "Failed to record partial video provider usage"),
        );
      }
      if (!reservation && funding === "credit") {
        const completedUnits = hasDeferredTemplateFunding(job)
          ? partialEvents.reduce((sum, event) => sum + (event.unitWeight ?? 1), 0)
          : partialEvents.length;
        const unusedUnits = Math.max(0, videoJobUnits(job.engine, job.options) - completedUnits);
        if (unusedUnits > 0) {
          await refundCredits(job.tenantId, "video", unusedUnits, "video failed after partial provider work").catch(
            (err) => logger.error({ err, jobId }, "Failed to refund unused video credits"),
          );
        }
      }
    } else if (!reservation && funding === "credit") {
      const units = videoJobUnits(job.engine, job.options);
      await refundCredits(job.tenantId, "video", units, "video generation failed").catch(
        (err) => logger.error({ err, jobId }, "Failed to refund video credits"),
      );
    }
    if (reservation) {
      // Settle every durable, as-yet-unaccounted receipt (base render,
      // keyframe/music, and optional Studio scenes alike) before releasing
      // unused held capacity. A receipt with an unknown catalog cost cannot
      // be silently invented; its durable settlement retry owns that case.
      const provenCost = partialEvents.every((event) => event.costPaise !== null)
        ? partialEvents.reduce((sum, event) => sum + event.costPaise!, 0)
        : null;
      if (provenCost !== null && provenCost > 0) {
        try {
          const heldReservations = await videoJobWalletReservations(job);
          let remaining = await exactChargePaise(provenCost);
          for (const held of heldReservations) {
            const targetChargePaise = Math.min(held.amountPaise, remaining);
            await settleWalletDurably(
              job.tenantId,
              held,
              {
                kind: "video",
                costPaise: provenCost,
                provider: partialEvents[0]?.provider ?? "unknown",
                model: partialEvents[0]?.model ?? "unknown",
                refKind: "videoJob",
                refId: String(jobId),
              },
              { targetChargePaise },
            );
            remaining -= targetChargePaise;
          }
          if (remaining > 0) {
            throw new Error(`Proven Studio receipts exceed reserved funding by ${remaining} paise`);
          }
        } catch (err) {
          logger.error({ err, jobId }, "Failed to settle proven partial video receipts");
        }
      }
      await refundFailedVideoJobWallet(jobId, "video generation failed").catch(
        (err) => logger.error({ err, jobId }, "Failed to zero failed video job wallet charge"),
      );
    }
  }
}

export function isKnownFreeStockTopicRender(
  engine: string,
  visualsSource: string | null | undefined,
  provider: string,
): boolean {
  return (
    engine === "topic_to_video" &&
    visualsSource === "stock" &&
    ["pexels", "pixabay", "wikimedia"].includes(provider)
  );
}
