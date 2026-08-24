import { boundedProviderFetch } from "../aiProviderFetch";

/** Supported output aspect ratios (mirrors the /ai/generate-video contract). */
export type VideoAspect = "16:9" | "9:16" | "1:1" | "4:5" | "4:3" | "3:4" | "21:9";

/**
 * Pixel dimensions per aspect ratio: the frame the slideshow encoder builds
 * and the frame every AI clip is cover-cropped into by normalizeVideo.
 *
 * Short edge is pinned at 1080 wherever that keeps both edges even, so a 4:5
 * reel and a 9:16 reel carry the same vertical resolution and the same
 * upload-size budget. 21:9 is the exception: pinning its short edge to 1080
 * would ask providers for a 2520-wide frame nothing renders natively, so it
 * takes 1920 on the long edge like 16:9 does.
 */
export const ASPECT_DIMENSIONS: Record<VideoAspect, { width: number; height: number }> = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
  "4:3": { width: 1440, height: 1080 },
  "3:4": { width: 1080, height: 1440 },
  "21:9": { width: 1920, height: 824 },
};

/** Every aspect ratio the API accepts, in picker order. */
export const VIDEO_ASPECTS = Object.keys(ASPECT_DIMENSIONS) as VideoAspect[];

/**
 * The delivered frame for an aspect at a given short edge.
 *
 * ASPECT_DIMENSIONS above is the 1080-class table every video used to get
 * unconditionally; a job that asks for less renders smaller rather than being
 * upscaled to look like something it is not. Both edges are rounded to even
 * numbers because H.264 yuv420p requires it.
 */
export function frameFor(
  aspectRatio: VideoAspect,
  shortEdge: number,
): { width: number; height: number } {
  const base = ASPECT_DIMENSIONS[aspectRatio];
  const baseShort = Math.min(base.width, base.height);
  if (shortEdge >= baseShort) return base;
  const scale = shortEdge / baseShort;
  const even = (n: number): number => Math.max(2, Math.round(n * scale / 2) * 2);
  return { width: even(base.width), height: even(base.height) };
}

/**
 * The aspect ratio to ASK THE PROVIDER for.
 *
 * Video models accept a small fixed set of ratios and 400 (or silently
 * ignore) anything else — no hosted model takes 4:5. Rather than refuse the
 * ratios users actually publish in, request the closest ratio the model does
 * support and let normalizeVideo cover-crop the result to the exact frame.
 * The user gets a true 1080x1350 file; the provider is only ever asked for a
 * shape it understands.
 *
 * `supported` is the model family's own list. The nearest match is by log
 * ratio, so 4:5 lands on 1:1 rather than 9:16 (a smaller crop, less subject
 * lost) and 21:9 lands on 16:9.
 */
export function providerAspect(
  requested: VideoAspect,
  supported: readonly string[] = ["16:9", "9:16", "1:1"],
): string {
  if (supported.includes(requested)) return requested;
  const ratioOf = (aspect: string): number => {
    const [w, h] = aspect.split(":").map(Number);
    return w && h ? Math.log(w / h) : 0;
  };
  const target = ratioOf(requested);
  // Ratios land on a tie more often than you would guess (3:4 sits exactly
  // between 1:1 and 9:16, 4:3 exactly between 1:1 and 16:9), and floating
  // point would otherwise let noise in the fifteenth decimal decide — the
  // same request rendering differently on different days. Compare with an
  // epsilon and break the tie on ORIENTATION: a portrait request takes the
  // portrait source, a landscape one the landscape source, so the model
  // composes for the shape the user actually asked for.
  const EPSILON = 1e-9;
  const orientation = (r: number): number => (Math.abs(r) < EPSILON ? 0 : Math.sign(r));
  const wanted = orientation(target);
  return supported.reduce((best, candidate) => {
    const gap = Math.abs(ratioOf(candidate) - target);
    const bestGap = Math.abs(ratioOf(best) - target);
    if (gap < bestGap - EPSILON) return candidate;
    if (gap > bestGap + EPSILON) return best;
    const candidateMatches = orientation(ratioOf(candidate)) === wanted;
    const bestMatches = orientation(ratioOf(best)) === wanted;
    // Still tied after orientation: keep the earlier entry, which is the
    // model family's own preferred default.
    return candidateMatches && !bestMatches ? candidate : best;
  });
}

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
  /**
   * Optional LAST frame, on the models that interpolate between two stills.
   * "Start here, end there" is the control that makes product reveals and
   * before/after transitions possible; without it a photo could only ever be
   * animated into whatever the model felt like.
   */
  endImage?: SourceImage;
  /**
   * Deterministic sampling seed. Omitted (or null) means "let the provider
   * choose", which is the behaviour every job had before seeds existed.
   * Passed only to model families known to accept it — Veo and MiniMax reject
   * unknown parameters outright, so they never see it.
   */
  seed?: number | null;
  /** Requested output resolution ("480p" | "720p" | "1080p"); provider hint. */
  resolution?: string | null;
  /** Quality switch on models that expose one ("basic" | "high"). */
  quality?: string | null;
  /** Ask the model for its own audio (dialogue, SFX) where it supports it. */
  generateAudio?: boolean | null;
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

/**
 * The exact prompt string sent to the video model for a single AI clip: the
 * caller's prompt plus a pacing hint, since most video models have no (or a
 * very limited) duration parameter. Exported so the API can show users
 * precisely what the AI receives — keep this and the providers in lockstep.
 */
export function compiledClipPrompt(prompt: string, durationSec: number): string {
  return `${prompt.trim()}\n\nTarget clip length: about ${durationSec} seconds of continuous action, paced to fill the full duration.`;
}
