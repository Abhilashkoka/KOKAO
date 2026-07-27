import {
  db,
  videoGenerationsTable,
  type VideoGeneration,
  type VideoStoryboard,
  type VideoStoryboardScene,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { ObjectStorageService, ObjectNotFoundError } from "../objectStorage";
import { recordUsage } from "../usage";
import { computeVideoCostPaise } from "../aiCost";
import { refundCredits } from "../credits";
import { logger } from "../logger";
import { generateVideo, VideoGenNotConfiguredError, VideoGenProviderError } from "./index";
import { renderSlideshow, extractPosterFrame, expectedSlideshowDurationSec } from "./slideshow";
import { normalizeVideo, mixMusicIntoVideo, fitImageToAspect } from "./postprocess";
import { generateMusicBed } from "./musicGen";
import { loadVideoBranding } from "./branding";
import { loadStyleGuidance } from "./referenceAnalyzer";
import { isFeatureEnabled } from "../featureFlags";
import { verifyRenderedVideo, type VideoQaExpectations } from "./qaGate";
import {
  generateTopicVideo,
  planTopicStoryboard,
  renderTopicStoryboard,
  refreshEditedNarration,
  regenerateStoryboardPreview,
  NARRATION_VOICES,
  type NarrationVoice,
  type StockSourceChoice,
} from "./topicVideo";
import { generateCharacterClip } from "./characterClip";
import {
  clipShotCount,
  clipStoryboardSource,
  clipStoryboardTotalSec,
  planClipStoryboard,
  renderClipStoryboard,
} from "./clipStoryboard";
import { videoJobUnits } from "./units";
import type { SourceImage } from "./types";

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

/** Topic mode's reviewable sub-modes. Stock footage is searched rather than
 * prompted, so it has no prompt to review; the other three engines get their
 * plan kind from clipStoryboardSource instead. */
function topicStoryboardEligible(job: VideoGeneration): "character" | "ai" | null {
  if (job.engine !== "topic_to_video") return null;
  const source = job.options?.visualsSource;
  return source === "character" || source === "ai" ? source : null;
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
        durationSec: options.durationSec ?? 5,
      });
      return {
        // Providers routinely ignore the requested aspect/resolution;
        // normalize (fail-soft) so the delivered file matches the request.
        buffer: await withMusic(await normalizeVideo(result.buffer, aspectRatio)),
        provider: result.provider,
        model: result.model,
        qa: { minDurationSec: 0.5, label: "character clip" },
      };
    }
    onStage("Generating the video");
    const result = await generateVideo({
      mode: "text",
      prompt: job.prompt ?? "",
      aspectRatio,
      durationSec: options.durationSec ?? 5,
    });
    return {
      buffer: await withMusic(await normalizeVideo(result.buffer, aspectRatio)),
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
    onStage("Animating your image");
    const result = await generateVideo({
      mode: "image",
      prompt: job.prompt ?? "",
      aspectRatio,
      durationSec: options.durationSec ?? 5,
      image,
    });
    return {
      buffer: music
        ? await mixMusicIntoVideo(await normalizeVideo(result.buffer, aspectRatio), music)
        : await normalizeVideo(result.buffer, aspectRatio),
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
          : "stock";
    const reviewable = topicStoryboardEligible(job);

    // A storyboard already on the row means this run is the resume: the plan
    // was approved, so render it instead of planning again.
    if (job.storyboard) {
      // Scene texts edited (or scenes added) during review desynced the plan
      // from its recording, so re-voice it first. The refreshed narration and
      // recomputed scene lengths are persisted before the render starts —
      // a render retry must resume from the recording it will actually use.
      const refreshed = await refreshEditedNarration({
        storyboard: job.storyboard,
        voice: isNarrationVoice(options.voice) ? options.voice : "alloy",
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
        voice: isNarrationVoice(options.voice) ? options.voice : "alloy",
        paragraphCount: options.paragraphCount ?? 1,
        visualsSource: reviewable,
        characterId: options.characterId ?? null,
        outfitId: options.outfitId ?? null,
        wardrobeNotes: options.wardrobeNotes ?? null,
        brandVoice: branding?.voiceHint ?? null,
        referenceStyle,
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
      voice: isNarrationVoice(options.voice) ? options.voice : "alloy",
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
      accentColor: branding?.accentColor ?? null,
      watermark,
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

  throw new VideoJobInputError(`Unknown video engine: ${job.engine}`);
}

function isNarrationVoice(value: string | undefined): value is NarrationVoice {
  return !!value && (NARRATION_VOICES as readonly string[]).includes(value);
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
  funding: "quota" | "credit",
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

async function executeVideoJob(
  job: VideoGeneration,
  funding: "quota" | "credit",
): Promise<void> {
  const jobId = job.id;
  const startedAt = Date.now();

  // Live progress: fire-and-forget stage writes; clients poll them. A stage
  // write must never fail (or slow down) the actual pipeline.
  const onStage = (stage: string): void => {
    void setJob(jobId, { stage }).catch(() => {});
  };

  try {
    const produced = await produceVideo(job, onStage);

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
    const { buffer, provider, model, qa } = produced;

    // Quality gate: never deliver (or charge for) a broken render. A failure
    // here throws VideoGenProviderError and lands in the refund path below.
    onStage("Running quality checks");
    const { durationSec: clipDurationSec } = await verifyRenderedVideo(buffer, qa);

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
    await setJob(jobId, {
      status: "succeeded",
      videoPath,
      thumbnailPath,
      provider,
      model,
      durationMs,
      error: null,
      stage: null,
    });
    // Multi-unit jobs (character story videos: one unit per scene) meter one
    // usage row per unit so quota accounting matches what was reserved.
    const units = videoJobUnits(job.engine, job.options);
    const usageModel = model ?? `slideshow/${job.sourceImagePaths?.length ?? 0}-images`;
    const usageProvider = provider ?? "ffmpeg";
    // Actual provider cost from the admin price catalog ($/second of output
    // when priced per second, else flat $/video). Best-effort: a lookup
    // failure or an uncataloged model stores NULL (unknown), never a guess,
    // and must never fail the job itself.
    const costPaise = await computeVideoCostPaise({
      provider: usageProvider,
      model: usageModel,
      durationSec: clipDurationSec,
    }).catch(() => null);
    await recordUsage(job.tenantId, "video", {
      funding,
      durationMs,
      responseBytes: buffer.length,
      model: usageModel,
      provider: usageProvider,
      requestBytes: job.prompt ? Buffer.byteLength(job.prompt) : 0,
      ...(costPaise !== null ? { costPaise } : {}),
    });
    for (let i = 1; i < units; i++) {
      await recordUsage(job.tenantId, "video", {
        funding,
        model: model ?? undefined,
        provider: provider ?? undefined,
        // The whole render's actual cost sits on the FIRST usage row;
        // supplemental unit rows cost 0 so cost reports never mistake them
        // for events with an unknown (uncataloged) cost.
        costPaise: 0,
      });
    }
  } catch (error) {
    logger.error({ err: error, jobId }, "Video generation job failed");
    const message =
      error instanceof VideoJobInputError ||
      error instanceof VideoGenNotConfiguredError ||
      error instanceof VideoGenProviderError
        ? error.message
        : "Video generation failed. Please try again.";
    await setJob(jobId, {
      status: "failed",
      error: message,
      stage: null,
      storyboardExpiresAt: null,
      durationMs: (job.durationMs ?? 0) + (Date.now() - startedAt),
    }).catch(() => {});
    if (funding === "credit") {
      const units = videoJobUnits(job.engine, job.options);
      await refundCredits(job.tenantId, "video", units, "video generation failed").catch(
        (err) => logger.error({ err, jobId }, "Failed to refund video credits"),
      );
    }
  }
}
