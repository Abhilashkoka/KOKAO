import { db, videoGenerationsTable, type VideoGeneration } from "@workspace/db";
import { eq } from "drizzle-orm";
import { ObjectStorageService, ObjectNotFoundError } from "../objectStorage";
import { recordUsage } from "../usage";
import { refundCredits } from "../credits";
import { logger } from "../logger";
import { generateVideo, VideoGenNotConfiguredError, VideoGenProviderError } from "./index";
import { renderSlideshow, extractPosterFrame } from "./slideshow";
import { normalizeVideo } from "./postprocess";
import {
  generateTopicVideo,
  NARRATION_VOICES,
  type NarrationVoice,
  type StockSourceChoice,
} from "./topicVideo";
import { generateCharacterClip } from "./characterClip";
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

const objectStorageService = new ObjectStorageService();

class VideoJobInputError extends Error {}

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

async function produceVideo(
  job: VideoGeneration,
): Promise<{ buffer: Buffer; provider: string | null; model: string | null }> {
  const options = job.options ?? { aspectRatio: "9:16" as const };
  const aspectRatio = options.aspectRatio ?? "9:16";

  if (job.engine === "text_to_video") {
    // With a character picked, the clip is identity-anchored: keyframe edit
    // of the locked outfit's reference, then image-to-video.
    if (options.characterId) {
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
        buffer: await normalizeVideo(result.buffer, aspectRatio),
        provider: result.provider,
        model: result.model,
      };
    }
    const result = await generateVideo({
      mode: "text",
      prompt: job.prompt ?? "",
      aspectRatio,
      durationSec: options.durationSec ?? 5,
    });
    return {
      buffer: await normalizeVideo(result.buffer, aspectRatio),
      provider: result.provider,
      model: result.model,
    };
  }

  if (job.engine === "image_to_video") {
    const sourcePath = job.sourceImagePaths?.[0];
    if (!sourcePath) throw new VideoJobInputError("No source image provided.");
    const image = await loadSourceImage(sourcePath, job.tenantId);
    const result = await generateVideo({
      mode: "image",
      prompt: job.prompt ?? "",
      aspectRatio,
      durationSec: options.durationSec ?? 5,
      image,
    });
    return {
      buffer: await normalizeVideo(result.buffer, aspectRatio),
      provider: result.provider,
      model: result.model,
    };
  }

  if (job.engine === "slideshow") {
    const paths = job.sourceImagePaths ?? [];
    if (paths.length === 0) throw new VideoJobInputError("No photos provided.");
    const images: Buffer[] = [];
    for (const path of paths) {
      images.push((await loadSourceImage(path, job.tenantId)).buffer);
    }
    const music = options.musicPath
      ? (
          await loadTenantObject(
            options.musicPath,
            job.tenantId,
            MAX_MUSIC_BYTES,
            "Music track",
          )
        ).buffer
      : null;
    const buffer = await renderSlideshow({
      images,
      aspectRatio,
      slideDurationSec: options.slideDurationSec ?? 3,
      overlayText: options.overlayText ?? null,
      music,
    });
    return { buffer, provider: null, model: null };
  }

  if (job.engine === "topic_to_video") {
    const music = options.musicPath
      ? (
          await loadTenantObject(
            options.musicPath,
            job.tenantId,
            MAX_MUSIC_BYTES,
            "Music track",
          )
        ).buffer
      : null;
    const result = await generateTopicVideo({
      tenantId: job.tenantId,
      topic: job.prompt ?? "",
      aspectRatio,
      voice: isNarrationVoice(options.voice) ? options.voice : "alloy",
      stockSource: isStockSourceChoice(options.stockSource) ? options.stockSource : "auto",
      subtitles: options.subtitles ?? true,
      paragraphCount: options.paragraphCount ?? 1,
      music,
      visualsSource:
        options.visualsSource === "character"
          ? "character"
          : options.visualsSource === "ai"
            ? "ai"
            : "stock",
      characterId: options.characterId ?? null,
      outfitId: options.outfitId ?? null,
      wardrobeNotes: options.wardrobeNotes ?? null,
    });
    return { buffer: result.buffer, provider: result.provider, model: result.model };
  }

  throw new VideoJobInputError(`Unknown video engine: ${job.engine}`);
}

function isNarrationVoice(value: string | undefined): value is NarrationVoice {
  return !!value && (NARRATION_VOICES as readonly string[]).includes(value);
}

function isStockSourceChoice(value: string | undefined): value is StockSourceChoice {
  return value === "auto" || value === "pexels" || value === "pixabay";
}

/**
 * Run one video job to completion. `funding` is how the route paid for it
 * ("quota" = counts against the monthly plan, "credit" = already debited).
 */
export async function runVideoGenerationJob(
  jobId: number,
  funding: "quota" | "credit",
): Promise<void> {
  const job = (
    await db
      .select()
      .from(videoGenerationsTable)
      .where(eq(videoGenerationsTable.id, jobId))
      .limit(1)
  )[0];
  if (!job || job.status !== "queued") return;

  await setJob(jobId, { status: "processing" });
  const startedAt = Date.now();

  try {
    const { buffer, provider, model } = await produceVideo(job);

    const videoPath = await uploadToStorage(job.tenantId, buffer, "video/mp4");
    // Thumbnail is best-effort: a poster failure must never fail the video.
    let thumbnailPath: string | null = null;
    try {
      const poster = await extractPosterFrame(buffer);
      thumbnailPath = await uploadToStorage(job.tenantId, poster, "image/png");
    } catch (err) {
      logger.warn({ err, jobId }, "Video poster frame extraction failed");
    }

    const durationMs = Date.now() - startedAt;
    await setJob(jobId, {
      status: "succeeded",
      videoPath,
      thumbnailPath,
      provider,
      model,
      durationMs,
      error: null,
    });
    // Multi-unit jobs (character story videos: one unit per scene) meter one
    // usage row per unit so quota accounting matches what was reserved.
    const units = videoJobUnits(job.engine, job.options);
    await recordUsage(job.tenantId, "video", {
      funding,
      durationMs,
      responseBytes: buffer.length,
      model: model ?? `slideshow/${job.sourceImagePaths?.length ?? 0}-images`,
      provider: provider ?? "ffmpeg",
      requestBytes: job.prompt ? Buffer.byteLength(job.prompt) : 0,
    });
    for (let i = 1; i < units; i++) {
      await recordUsage(job.tenantId, "video", {
        funding,
        model: model ?? undefined,
        provider: provider ?? undefined,
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
      durationMs: Date.now() - startedAt,
    }).catch(() => {});
    if (funding === "credit") {
      const units = videoJobUnits(job.engine, job.options);
      await refundCredits(job.tenantId, "video", units, "video generation failed").catch(
        (err) => logger.error({ err, jobId }, "Failed to refund video credits"),
      );
    }
  }
}
