import { boundedProviderFetch } from "../aiProviderFetch";

/** Supported output sizes (mirrors the /ai/generate-image contract). */
export type ImageSize = "1024x1024" | "1536x1024" | "1024x1536";

/** A tenant-uploaded reference image passed to providers that support image input. */
export interface ReferenceImage {
  /** Raw image bytes. */
  buffer: Buffer;
  /** e.g. "image/png" or "image/jpeg". */
  mimeType: string;
}

/** Input to an image generation provider. */
export interface ImageGenInput {
  prompt: string;
  size: ImageSize;
  /** Effective model name (settings override or the provider default). */
  model: string;
  /** Only set for the OpenAI-compatible "custom" provider. */
  baseUrl?: string;
  /** Only set when the selected provider supports image input. */
  referenceImage?: ReferenceImage;
}

/** Result returned by every provider. */
export interface ImageGenResult {
  buffer: Buffer;
  provider: string;
  model: string;
  /**
   * Token usage when the provider reports it (OpenAI gpt-image-1, Gemini).
   * Used for token-based cost computation; absent for flat-priced providers.
   */
  usage?: {
    inputTokens: number | null;
    outputTokens: number | null;
  };
}

/**
 * An image result plus how the router arrived at it. Separate from
 * `ImageGenResult` because a provider adapter has no idea it was one of
 * several candidates — only the router does.
 */
export interface RoutedImageGenResult extends ImageGenResult {
  /** 0 = the first provider tried, 1 = the first fallback, and so on. */
  fallbackStep: number;
  /** Human-readable "why this provider"; undefined when there was no choice. */
  routingReason?: string;
}

/** Thrown when the selected provider is missing its API key or base URL. */
export class ImageGenNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageGenNotConfiguredError";
  }
}

/** Thrown when the provider call fails (bad prompt, upstream error, timeout). */
export class ImageGenProviderError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ImageGenProviderError";
  }
}

/** Per-request timeout. Image models can take a while (up to ~2 min). */
export const IMAGE_GEN_FETCH_TIMEOUT_MS = 120_000;

/** Bounded-timeout fetch for image provider calls. */
export async function imageGenFetch(url: string, init: RequestInit): Promise<Response> {
  return boundedProviderFetch(
    url,
    init,
    IMAGE_GEN_FETCH_TIMEOUT_MS,
    () =>
      new ImageGenProviderError(
        `Image generation timed out after ${IMAGE_GEN_FETCH_TIMEOUT_MS / 1000}s.`,
      ),
  );
}

export { errorDetail } from "../aiProviderFetch";
