import {
  db,
  isPromptVariantKey,
  videoGenerationsTable,
  tenantsTable,
  type VideoGeneration,
  type VideoStoryboard,
  type VideoStoryboardScene,
  type LocalizedDubResult,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { ObjectStorageService, ObjectNotFoundError } from "../objectStorage";
import { recordUsage } from "../usage";
import {
  computeVideoCostPaise,
  elevenLabsCreditReservationCeiling,
  elevenLabsCreditsToPaise,
  getAiCostConfig,
} from "../aiCost";
import { computeDisplayPaise, getAiSpendConfig } from "../aiSpend";
import { refundCredits } from "../credits";
import {
  actualChargePaise,
  executeWalletProviderOperation,
  getVideoJobWalletChargesPaise,
  isWalletFunded,
  refundWallet,
  reservationFromRow,
  reserveWallet,
  settleWallet,
  settleWalletDurably,
  settleWalletProviderOperationDurably,
  type WalletReservation,
} from "../wallet";
import { logger } from "../logger";
import {
  generateVideo,
  getVideoGenProviderDef,
  getVideoGenSelection,
  resolveVideoGenApiKey,
  VideoGenNotConfiguredError,
  VideoGenProviderError,
} from "./index";
import { generateLipSyncWithReplicate } from "./providers/replicate";
import { synthesizeNarration, splitIntoSentences } from "./topicVideo/narration";
import { renderSlideshow, extractPosterFrame, expectedSlideshowDurationSec } from "./slideshow";
import {
  normalizeVideo,
  mixMusicIntoVideo,
  fitImageToAspect,
  applyAppWatermarkToVideo,
  loopVideoPlateToDuration,
  concatClips,
} from "./postprocess";
import { composeCharacterDialogue, probeNarrationWavDurationSec, trimCharacterDialogueClipStrict } from "./characterDialogueCompose";
import { lipSyncSourcePlatePrompt } from "./characterDialogue";
import { getPlan } from "../plans";
import { generateMusicBed, MUSICGEN_MODEL, musicGenDurationSec } from "./musicGen";
import { loadVideoBranding } from "./branding";
import { loadStyleGuidance } from "./referenceAnalyzer";
import { isFeatureEnabled, videoModeFeature } from "../featureFlags";
import { verifyRenderedVideo, type VideoQaExpectations } from "./qaGate";
import {
  generateTopicVideo,
  planTopicStoryboard,
  renderTopicStoryboard,
  refreshEditedNarration,
  regenerateStoryboardPreview,
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
import { videoJobUnits } from "./units";
import { motionPresetClause } from "./motionPrompt";
import { resolveModelOptions, findVideoModel, supportsEndFrame } from "./modelCatalog";
import {
  LATENT_SYNC,
  SYNC_LIPSYNC_2,
  lipSyncModelForQuality,
  portraitLipSyncModel,
  ALLOWED_LIP_SYNC_AUDIO_TYPES,
  ALLOWED_LIP_SYNC_IMAGE_TYPES,
  MAX_LIP_SYNC_AUDIO_BYTES,
} from "./lipSyncModels";
import type { SourceImage } from "./types";
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
  isConfirmedVoiceCloneFailure,
  resolveVoiceCloneApiKey,
  getVoiceCloneProviderDef,
  speakWithClonedVoiceReceipt,
  type ClonedVoiceRef,
} from "../voiceClone";
import { getTextGenClient } from "../textGen";
import { parseModelJsonObject } from "../modelJson";
import {
  presenterStoryboard,
  renderPresenterBroll,
  resolvePresenterBrollAssets,
  syncReviewedPresenterBroll,
} from "./presenterBroll";

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

class VideoJobInputError extends Error {}

interface VideoProviderEvent {
  provider: string;
  model: string;
  durationSec: number | null;
  requestBytes: number;
  label: string;
  costPaise: number | null;
  accounted?: boolean;
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
function topicStoryboardEligible(
  job: VideoGeneration,
): "character" | "ai" | "ai_video" | null {
  if (job.engine !== "topic_to_video") return null;
  const source = job.options?.visualsSource;
  return source === "character" || source === "ai" || source === "ai_video" ? source : null;
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

async function setJob(
  jobId: number,
  values: Partial<typeof videoGenerationsTable.$inferInsert>,
): Promise<void> {
  await db
    .update(videoGenerationsTable)
    .set(values)
    .where(eq(videoGenerationsTable.id, jobId));
}

/** Bill one cloned localized-dub cue behind its own durable receipt. */
async function speakLocalizedBrandVoiceCue(args: {
  tenantId: number;
  jobId: number;
  cueIndex: number;
  voice: ClonedVoiceRef;
  text: string;
  modelId?: "eleven_multilingual_v2" | "eleven_v3";
}): Promise<Buffer> {
  const modelId = args.modelId ?? "eleven_multilingual_v2";
  const walletFunded = await isWalletFunded(args.tenantId);
  const rateSnapshot =
    args.voice.provider === "elevenlabs"
      ? (await getAiCostConfig()).elevenLabsInrPerCredit
      : null;
  if (walletFunded && !rateSnapshot) {
    throw new VideoGenProviderError("ElevenLabs credit billing is not configured for cloned narration.");
  }
  if (!walletFunded) {
    return (await speakWithClonedVoiceReceipt(args.voice, args.text, undefined, modelId)).audio;
  }
  const ceilingPaise = elevenLabsCreditsToPaise(
    elevenLabsCreditReservationCeiling(args.text),
    rateSnapshot!,
  );
  if (ceilingPaise === null || ceilingPaise <= 0) {
    throw new VideoGenProviderError("ElevenLabs credit billing is not configured for cloned narration.");
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
          modelId,
          args.text,
          { jobId: args.jobId, cueIndex: args.cueIndex },
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
        }, modelId),
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
  if (options.musicPrompt?.trim()) {
    onStage("Composing the music");
    return generateMusicBed(options.musicPrompt, approxDurationSec);
  }
  return null;
}

type ProduceResult =
  | { paused: true; storyboard: VideoStoryboard }
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
  const result = await renderClipStoryboard({
    job,
    storyboard,
    aspectRatio,
    music,
    // Previews are tenant objects, so they go through the same size and type
    // validation as a freshly uploaded source image.
    load: (objectPath) => loadSourceImage(objectPath, job.tenantId),
    onStage,
  });
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
  };
}

type VideoJobAspect = NonNullable<VideoGeneration["options"]>["aspectRatio"];

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
        prompt: job.prompt ?? "",
        aspectRatio,
        durationSec: model.durationSec,
        motionPreset: options.motionPreset ?? null,
        cinematography: options.cinematography ?? null,
        seed: options.seed ?? null,
        model,
      });
      return {
        // Providers routinely ignore the requested aspect/resolution;
        // normalize (fail-soft) so the delivered file matches the request.
        buffer: await withMusic(
          await normalizeVideo(result.buffer, aspectRatio, model.resolution),
        ),
        provider: result.provider,
        model: result.model,
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
    return {
      buffer: await withMusic(
        await normalizeVideo(result.buffer, aspectRatio, model.resolution),
      ),
      provider: result.provider,
      model: result.model,
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
      endPath && supportsEndFrame(findVideoModel(options.modelId))
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
    const normalized = await normalizeVideo(result.buffer, aspectRatio, model.resolution);
    return {
      buffer: music ? await mixMusicIntoVideo(normalized, music) : normalized,
      provider: result.provider,
      model: result.model,
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
    if (!(await isFeatureEnabled("brandVoiceClone").catch(() => true))) {
      throw new VideoJobInputError("Brand Voice is currently turned off.");
    }
    if (options.aiPersonConsent !== true) {
      throw new VideoJobInputError(
        "This job is missing the recorded AI-person likeness consent, so it was not generated.",
      );
    }
    const visualPrompt = job.prompt?.trim();
    if (!visualPrompt) throw new VideoJobInputError("No AI-person visual prompt provided.");
    const dialogue = options.dialogue?.trim();
    if (!dialogue) throw new VideoJobInputError("No dialogue provided.");
    const frozenPlan = options.characterDialogue;
    if (frozenPlan) {
      // This is intentionally a separate branch: legacy dialogue_lip_sync
      // remains the one-plate pipeline, including its stock fallback.
      const branding = await loadVideoBranding(job.tenantId, frozenPlan.brandKitId);
      if (!branding?.clonedVoice || branding.clonedVoice.provider !== "elevenlabs") {
        throw new VideoJobInputError("The saved character dialogue Brand Voice is no longer available.");
      }
      const clips: Buffer[] = [];
      const composedScenes: Array<{ text: string; narrationDurationSec: number }> = [];
      const events: VideoProviderEvent[] = [];
      const checkpointJob = async () => setJob(job.id, { options: { ...options, characterDialogue: frozenPlan } });
      for (const [sceneIndex, scene] of frozenPlan.scenes.entries()) {
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
          : await speakLocalizedBrandVoiceCue({
              tenantId: job.tenantId,
              jobId: frozenPlan.retry?.sourceJobId ?? job.id,
              cueIndex: sceneIndex,
              voice: branding.clonedVoice, text: scene.text, modelId: "eleven_v3",
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
          const visual = await generateCharacterClip({
            tenantId: job.tenantId, characterId: frozenPlan.characterId, outfitId: frozenPlan.outfitId,
            prompt: scene.visualPrompt, aspectRatio, durationSec: Math.min(30, narrationDurationSec + 0.35),
          });
          plate = visual.buffer;
          visualEvent = {
            provider: visual.provider, model: visual.model, durationSec: null,
            requestBytes: Buffer.byteLength(scene.visualPrompt), label: `character_plate:${scene.id}`,
            costPaise: await computeVideoCostPaise({ provider: visual.provider, model: visual.model, durationSec: null }).catch(() => null),
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
          }).catch(() => null);
          scene.checkpoint = { ...scene.checkpoint, visualEvent };
          await checkpointJob();
        }
        try {
          const synced = await generateLipSyncWithReplicate({
            source: {
              buffer: await loopVideoPlateToDuration(plate, narrationDurationSec + 0.35),
              mimeType: "video/mp4",
            },
            audio: { buffer: narration, mimeType: "audio/wav" },
            def:
              frozenPlan.lipSyncModel === SYNC_LIPSYNC_2.model
                ? SYNC_LIPSYNC_2
                : frozenPlan.lipSyncModel === LATENT_SYNC.model
                  ? LATENT_SYNC
                  : lipSyncModelForQuality(options.lipSyncQuality),
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
            provider: synced.provider, model: synced.model, durationSec: rawLipSyncDurationSec,
            requestBytes: narration.length, label: `lip_sync:${scene.id}`,
            costPaise: await computeVideoCostPaise({ provider: synced.provider, model: synced.model, durationSec: rawLipSyncDurationSec }).catch(() => null),
          };
          scene.checkpoint = { ...scene.checkpoint, lipSyncEvent };
          await checkpointJob();
          const normalized = await normalizeVideo(synced.buffer, aspectRatio);
            const trimmed = await trimCharacterDialogueClipStrict(normalized, narrationDurationSec, narration);
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
            music = await generateMusicBed(options.musicPrompt, totalNarrationSec);
            const event: VideoProviderEvent = {
              provider: "replicate", model: MUSICGEN_MODEL, durationSec: requestedDurationSec,
              requestBytes: Buffer.byteLength(options.musicPrompt), label: "character_dialogue_music",
              costPaise: await computeVideoCostPaise({ provider: "replicate", model: MUSICGEN_MODEL, durationSec: requestedDurationSec }).catch(() => null),
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
          direction: frozenPlan.direction, music,
        });
        return {
          buffer: composed.buffer,
          provider: "replicate",
          model:
            frozenPlan.lipSyncModel ??
            lipSyncModelForQuality(options.lipSyncQuality).model,
          providerEvents: events,
          qa: { expectedDurationSec: composed.durationSec, minDurationSec: composed.durationSec, expectAudio: true, label: "saved-character dialogue video" },
        };
      } catch (error) {
        if (error instanceof PartialVideoProviderWorkError) throw error;
        const musicEvent = frozenPlan.musicCheckpoint?.event;
        throw new PartialVideoProviderWorkError(
          musicEvent && !musicEvent.accounted && !events.some((event) => event.label === musicEvent.label)
            ? events.concat(musicEvent)
            : events,
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
    });
    // Provider success is the partial-work boundary. Start with an unmeasured
    // event: flat-per-video models can still resolve an exact cost, while a
    // per-second model remains unknown and therefore settles through the
    // wallet's explicit estimated/admin fallback if probing fails.
    const visualEvent: VideoProviderEvent = {
      provider: visual.provider,
      model: visual.model,
      durationSec: null,
      requestBytes: Buffer.byteLength(visualPrompt),
      label: "ai_person_plate",
      costPaise: await computeVideoCostPaise({
        provider: visual.provider,
        model: visual.model,
        durationSec: null,
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
      }).catch(() => null);
      const extendedVisual = await loopVideoPlateToDuration(visual.buffer, plateDurationSec);
      const replicateDef = getVideoGenProviderDef("replicate");
      const apiKey = replicateDef ? await resolveVideoGenApiKey(replicateDef) : null;
      onStage("Syncing the lips");
      result = await generateLipSyncWithReplicate(
        {
          source: { buffer: extendedVisual, mimeType: "video/mp4" },
          audio: { buffer: narration.wav, mimeType: "audio/wav" },
          def:
            options.characterDialogue?.lipSyncModel === SYNC_LIPSYNC_2.model
              ? SYNC_LIPSYNC_2
              : options.characterDialogue?.lipSyncModel === LATENT_SYNC.model
                ? LATENT_SYNC
                : lipSyncModelForQuality(options.lipSyncQuality),
        },
        apiKey,
      );
    } catch (error) {
      throw new PartialVideoProviderWorkError([visualEvent], error);
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
    }).catch(() => null);
    return {
      buffer: result.buffer,
      provider: result.provider,
      model: result.model,
      providerEvents: [
        visualEvent,
        {
          provider: result.provider,
          model: result.model,
          durationSec: rawLipSyncDurationSec,
          requestBytes: narration.wav.length,
          label: "lip_sync",
          costPaise: lipSyncCostPaise,
        },
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

    // Lip sync is pinned to Replicate — it is the input contract (a face plus
    // audio) that makes this feature, not an interchangeable video model — so
    // the key is resolved directly rather than via provider selection.
    const replicateDef = getVideoGenProviderDef("replicate");
    const apiKey = replicateDef ? await resolveVideoGenApiKey(replicateDef) : null;
    onStage("Syncing the lips");
    const result = await generateLipSyncWithReplicate(
      { source, audio, def: lipSyncDef },
      apiKey,
    );
    return {
      // The output keeps the source's own framing, so no aspect
      // normalization: padding someone's footage would only shrink them.
      buffer: result.buffer,
      provider: result.provider,
      model: result.model,
      qa: { minDurationSec: 0.5, expectAudio: true, label: "lip-sync video" },
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
    const referenceStylesEnabled = await isFeatureEnabled("referenceStyles").catch(() => true);
    const referenceStyle = referenceStylesEnabled
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
        onCheckpoint: async (checkpoint) => {
          await setJob(job.id, {
            options: { ...options, presenterBroll: checkpoint },
          });
        },
      });

      if (job.storyboard) {
        const synced = await syncReviewedPresenterBroll({
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
          onCheckpoint: async (checkpoint) => {
            await setJob(job.id, {
              options: { ...options, presenterBroll: checkpoint },
            });
          },
        });
        if (synced !== snapshot) {
          snapshot = synced;
          const syncedBoard = presenterStoryboard(snapshot);
          await setJob(job.id, {
            options: { ...options, presenterBroll: snapshot },
            storyboard: syncedBoard,
          });
        }
      } else if (options.reviewStoryboard) {
        return { paused: true, storyboard: presenterStoryboard(snapshot) };
      }

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
      const music = await resolveMusic(job, options, snapshot.durationMs / 1000, onStage);
      if (music) buffer = await mixMusicIntoVideo(buffer, music);
      return {
        buffer,
        provider: null,
        model: null,
        qa: {
          expectedDurationSec: snapshot.durationMs / 1000,
          expectAudio: true,
          label: "presenter B-roll video",
        },
      };
    }

    // Script variant: chosen in the studio, layered over the shared script
    // rules by the Prompt Kit. An unknown value degrades to the base prompt
    // rather than failing the job.
    const scriptVariant = isPromptVariantKey(options.scriptVariant)
      ? options.scriptVariant
      : null;

    const reviewable = topicStoryboardEligible(job);

    // A storyboard already on the row means this run is the resume: the plan
    // was approved, so render it instead of planning again.
    if (job.storyboard) {
      // Scene texts edited (or scenes added) during review desynced the plan
      // from its recording, so re-voice it first. The refreshed narration and
      // recomputed scene lengths are persisted before the render starts —
      // a render retry must resume from the recording it will actually use.
      const refreshed = await refreshEditedNarration({
        tenantId: job.tenantId,
        storyboard: job.storyboard,
        voice: effectiveVoice,
        clonedVoice,
        upload: (bytes, contentType) => uploadToStorage(job.tenantId, bytes, contentType),
        onStage,
      });
      if (refreshed) {
        await setJob(job.id, { storyboard: refreshed });
      }
      const board = refreshed ?? job.storyboard;
      // MusicGen tops out at 30s; the composer loops the bed, so 30 is enough.
      const music = await resolveMusic(job, options, 30, onStage);
      const result = await renderTopicStoryboard({
        storyboard: board,
        aspectRatio,
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
      });
      return {
        buffer: result.buffer,
        provider: result.provider,
        model: result.model,
        qa: { expectedDurationSec: result.durationSec, expectAudio: true, label: "topic video" },
      };
    }

    // First run with review asked for: plan, then stop. No music is composed
    // and no clip is animated until the plan is approved.
    if (reviewable && options.reviewStoryboard) {
      const storyboard = await planTopicStoryboard({
        tenantId: job.tenantId,
        topic: job.prompt ?? "",
        aspectRatio,
        voice: effectiveVoice,
        clonedVoice,
        paragraphCount: options.paragraphCount ?? 1,
        visualsSource: reviewable,
        characterId: options.characterId ?? null,
        outfitId: options.outfitId ?? null,
        wardrobeNotes: options.wardrobeNotes ?? null,
        brandVoice: branding?.voiceHint ?? null,
        referenceStyle,
        scriptVariant,
        suppliedPlan: isSuppliedPlan(options.suppliedPlan) ? options.suppliedPlan : null,
        upload: (bytes, contentType) => uploadToStorage(job.tenantId, bytes, contentType),
        onStage,
      });
      return { paused: true, storyboard };
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
      music,
      visualsSource,
      characterId: options.characterId ?? null,
      outfitId: options.outfitId ?? null,
      wardrobeNotes: options.wardrobeNotes ?? null,
      brandVoice: branding?.voiceHint ?? null,
      referenceStyle,
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
  await executeVideoJob(claimed, funding);
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
  const previewPath = await regenerateStoryboardPreview({
    tenantId: job.tenantId,
    storyboard,
    scene,
    aspectRatio: job.options?.aspectRatio ?? "9:16",
    characterId: job.options?.characterId ?? null,
    upload: (bytes, contentType) => uploadToStorage(job.tenantId, bytes, contentType),
  });
  // Note: does NOT touch the regenerations counter — the preview route spends
  // a re-roll with an atomic conditional UPDATE before calling this, so
  // incrementing here as well would double-count.
  return {
    ...storyboard,
    scenes: storyboard.scenes.map((s) => (s.id === scene.id ? { ...s, previewPath } : s)),
  };
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

async function executeVideoJob(
  job: VideoGeneration,
  funding: "quota" | "credit" | "wallet",
): Promise<void> {
  const jobId = job.id;
  const startedAt = Date.now();
  let completedProviderEvents: VideoProviderEvent[] = [];

  // Live progress: fire-and-forget stage writes; clients poll them. A stage
  // write must never fail (or slow down) the actual pipeline.
  const onStage = (stage: string): void => {
    void setJob(jobId, { stage }).catch(() => {});
  };

  try {
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
    const produced = await produceVideo(job, onStage);
    completedProviderEvents =
      ("providerEvents" in produced ? produced.providerEvents : undefined) ?? [];

    // The storyboard pause. Nothing is metered and nothing is refunded: the
    // reservation stays reserved against the render the user is about to
    // approve, and the sweep gives it back if they never do.
    if (produced.paused) {
      await setJob(jobId, {
        status: "awaiting_review",
        storyboard: produced.storyboard,
        storyboardExpiresAt: new Date(Date.now() + STORYBOARD_TTL_MS),
        durationMs: Date.now() - startedAt,
        error: null,
        stage: null,
      });
      return;
    }
    let { buffer } = produced;
    const { provider, model, qa, localizedResult } = produced;

    // Quality gate: never deliver (or charge for) a broken render. A failure
    // here throws VideoGenProviderError and lands in the refund path below.
    onStage("Running quality checks");
    const { durationSec: clipDurationSec } = await verifyRenderedVideo(buffer, qa);

    // Plans with the watermark switch ON get a "Made with KOKAO.in" pill in
    // the corner, subject to the platform-wide kill switch. Every step fails
    // SOFT to the unwatermarked video — this must never fail a paid render.
    if (await shouldApplyAppWatermark(job.tenantId)) {
      const aspect = job.options?.aspectRatio ?? "9:16";
      buffer = await applyAppWatermarkToVideo(buffer, aspect);
    }

    onStage("Saving to your library");
    const videoPath = await uploadToStorage(job.tenantId, buffer, "video/mp4");
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
    const providerEventsRaw =
      ("providerEvents" in produced ? produced.providerEvents : undefined) ??
      [{
        provider: usageProvider,
        model: usageModel,
        durationSec: clipDurationSec,
        requestBytes: job.prompt ? Buffer.byteLength(job.prompt) : 0,
        label: "render",
        costPaise: null,
      }];
    // Frozen scene labels are durable operation keys. Defensive de-duping keeps
    // a resume/checkpoint merge from recording any paid visual or lip-sync work
    // twice while retaining distinct legacy events.
    const seenProviderEvents = new Set<string>();
    const providerEvents = providerEventsRaw.filter((event) => {
      const key = `${event.provider}\0${event.model}\0${event.label}`;
      if (seenProviderEvents.has(key)) return false;
      seenProviderEvents.add(key);
      return true;
    });
    const eventCosts = await Promise.all(providerEvents.map(async (event) =>
      event.costPaise ??
      await computeVideoCostPaise({
        provider: event.provider,
        model: event.model,
        durationSec: event.durationSec,
      }).catch(() => null),
    ));
    const costPaise =
      eventCosts.every((cost) => cost !== null)
        ? (eventCosts as number[]).reduce((sum, cost) => sum + cost, 0)
        : null;
    // Snapshot the TOTAL display spend BEFORE the terminal status flip:
    // clients stop polling/refetching the moment they see "succeeded", so a
    // spend written afterwards could be missed forever. The first unit
    // carries the render's real cost; supplemental units cost a known 0. Any
    // unit without a snapshot leaves the total null — clients fall back to
    // chargedRatePaise x units, never a partial sum.
    let unitSpends: (number | null)[] = [];
    let spendPaise: number | null = null;
    const reservation = reservationFromRow(job);
    if (reservation) {
      try {
        const videoTarget = await actualChargePaise({
          kind: "video",
          costPaise,
          units: reservation.units,
        });
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
    // Wallet: settle the reserved estimate. When the price catalog yields a
    // real cost for this render it settles at actual cost + fee; an
    // uncataloged model settles at the admin display rate and is flagged
    // `estimated` in the ledger.
    if (reservation) {
        await settleWalletDurably(job.tenantId, reservation, {
        kind: "video",
        costPaise,
        provider: usageProvider,
        model: usageModel,
        refKind: "videoJob",
        refId: String(job.id),
      }).catch((err) =>
        logger.error({ err, jobId }, "Failed to settle video job wallet charge"),
      );
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
    const partialEvents =
      partialWork ? partialWork.providerEvents : completedProviderEvents;
    const surfacedError = partialWork?.cause ?? error;
    const message =
      surfacedError instanceof VideoJobInputError ||
      surfacedError instanceof VideoGenNotConfiguredError ||
      surfacedError instanceof VideoGenProviderError ||
      surfacedError instanceof CueOverrunError ||
      surfacedError instanceof LocalizedDubInputError
        ? surfacedError.message
        : "Video generation failed. Please try again.";
    await db.transaction(async (tx) => {
      const [latest] = await tx.select().from(videoGenerationsTable)
        .where(eq(videoGenerationsTable.id, jobId)).limit(1);
      let failedOptions = latest?.options ?? job.options;
      if (failedOptions?.characterDialogue && partialEvents.length > 0) {
        failedOptions = structuredClone(failedOptions);
        const labels = new Set(partialEvents.map((event) => event.label));
        for (const scene of failedOptions.characterDialogue!.scenes) {
          if (scene.checkpoint?.visualEvent && labels.has(scene.checkpoint.visualEvent.label)) {
            scene.checkpoint.visualEvent.accounted = true;
          }
          if (scene.checkpoint?.lipSyncEvent && labels.has(scene.checkpoint.lipSyncEvent.label)) {
            scene.checkpoint.lipSyncEvent.accounted = true;
          }
        }
        const musicEvent = failedOptions.characterDialogue!.musicCheckpoint?.event;
        if (musicEvent && labels.has(musicEvent.label)) musicEvent.accounted = true;
      }
      await tx.update(videoGenerationsTable).set({
        status: "failed", error: message, stage: null, storyboardExpiresAt: null,
        durationMs: (job.durationMs ?? 0) + (Date.now() - startedAt),
        ...(failedOptions ? { options: failedOptions } : {}),
      }).where(eq(videoGenerationsTable.id, jobId));
    }).catch(() => {});
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
      if (reservation) {
        // Settling below the two-unit ceiling releases the unused LatentSync
        // hold while retaining the provider work that really completed.
        await settleWallet(job.tenantId, {
          ...reservation,
          // Unknown per-second cost falls back to the admin rate for completed
          // provider units only, not the original two-unit reservation.
          units: partialEvents.length,
        }, {
          kind: "video",
          costPaise: partialEvents.every((event) => event.costPaise !== null)
            ? partialEvents.reduce((sum, event) => sum + event.costPaise!, 0)
            : null,
          provider: partialEvents.map((event) => event.provider).join("+"),
          model: partialEvents.map((event) => event.model).join("+"),
          refKind: "videoJob",
          refId: String(job.id),
        }).catch((err) =>
          logger.error({ err, jobId }, "Failed to settle partial video provider work"),
        );
      } else if (funding === "credit") {
        const unusedUnits = Math.max(0, videoJobUnits(job.engine, job.options) - partialEvents.length);
        if (unusedUnits > 0) {
          await refundCredits(job.tenantId, "video", unusedUnits, "video failed after partial provider work").catch(
            (err) => logger.error({ err, jobId }, "Failed to refund unused video credits"),
          );
        }
      }
    } else if (reservation) {
      await refundWallet(job.tenantId, reservation, "video generation failed").catch(
        (err) => logger.error({ err, jobId }, "Failed to refund video job wallet"),
      );
    } else if (funding === "credit") {
      const units = videoJobUnits(job.engine, job.options);
      await refundCredits(job.tenantId, "video", units, "video generation failed").catch(
        (err) => logger.error({ err, jobId }, "Failed to refund video credits"),
      );
    }
  }
}
