/** Supported output sizes (mirrors the /ai/generate-image contract). */
export type ImageSize = "1024x1024" | "1536x1024" | "1024x1536";

/** Input to an image generation provider. */
export interface ImageGenInput {
  prompt: string;
  size: ImageSize;
  /** Effective model name (settings override or the provider default). */
  model: string;
  /** Only set for the OpenAI-compatible "custom" provider. */
  baseUrl?: string;
}

/** Result returned by every provider. */
export interface ImageGenResult {
  buffer: Buffer;
  provider: string;
  model: string;
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_GEN_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new ImageGenProviderError(
        `Image generation timed out after ${IMAGE_GEN_FETCH_TIMEOUT_MS / 1000}s.`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Short upstream error detail for logs/messages without dumping whole bodies. */
export async function errorDetail(res: Response): Promise<string> {
  return (await res.text().catch(() => "")).slice(0, 300);
}
