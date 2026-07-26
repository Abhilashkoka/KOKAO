import { boundedProviderFetch } from "../aiProviderFetch";

/** Supported output aspect ratios (mirrors the /ai/generate-video contract). */
export type VideoAspect = "16:9" | "9:16" | "1:1";

/** Pixel dimensions used by the slideshow encoder per aspect ratio. */
export const ASPECT_DIMENSIONS: Record<VideoAspect, { width: number; height: number }> = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
};

/** A tenant-provided source image for image-to-video generation. */
export interface SourceImage {
  /** Raw image bytes. */
  buffer: Buffer;
  /** e.g. "image/png" or "image/jpeg". */
  mimeType: string;
}

/** Input to an AI video generation provider. */
export interface VideoGenInput {
  /** The brief (text_to_video) or motion hint (image_to_video; may be empty). */
  prompt: string;
  aspectRatio: VideoAspect;
  /** Requested clip length in seconds (providers clamp to what they support). */
  durationSec: number;
  /** Effective model name (settings override or the provider default). */
  model: string;
  /** Only set for image_to_video. */
  image?: SourceImage;
}

/** Result returned by every provider. */
export interface VideoGenResult {
  /** MP4 (or provider-native container) video bytes. */
  buffer: Buffer;
  provider: string;
  model: string;
}

/** Thrown when the selected provider is missing its API key. */
export class VideoGenNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VideoGenNotConfiguredError";
  }
}

/** Thrown when the provider call fails (bad prompt, upstream error, timeout). */
export class VideoGenProviderError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "VideoGenProviderError";
  }
}

/**
 * Per-HTTP-call timeout. Video predictions are polled, so no single request
 * should hang long — the overall generation deadline lives in the provider's
 * polling loop (VIDEO_GEN_TOTAL_DEADLINE_MS).
 */
export const VIDEO_GEN_FETCH_TIMEOUT_MS = 120_000;

/** Overall wall-clock budget for one AI video generation (create + poll + download). */
export const VIDEO_GEN_TOTAL_DEADLINE_MS = 10 * 60 * 1000;

/** Bounded-timeout fetch for video provider calls. */
export async function videoGenFetch(url: string, init: RequestInit): Promise<Response> {
  return boundedProviderFetch(
    url,
    init,
    VIDEO_GEN_FETCH_TIMEOUT_MS,
    () =>
      new VideoGenProviderError(
        `Video provider call timed out after ${VIDEO_GEN_FETCH_TIMEOUT_MS / 1000}s.`,
      ),
  );
}

export { errorDetail } from "../aiProviderFetch";
