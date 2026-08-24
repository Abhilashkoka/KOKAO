import {
  videoGenFetch,
  errorDetail,
  VideoGenNotConfiguredError,
  VideoGenProviderError,
  VIDEO_GEN_TOTAL_DEADLINE_MS,
  compiledClipPrompt,
  providerAspect,
  type VideoGenInput,
  type VideoGenResult,
} from "../types";
import { withRetries, isTransientStatus } from "../retry";

/**
 * Default OpenRouter video models. Kling 3.0 Standard supports all three
 * aspect ratios we offer (16:9, 9:16, 1:1), a 3–15s duration range, and a
 * first_frame start image, at a mid-range per-second price — a safe default
 * for both engines. Superadmins can override either from the admin dashboard
 * (any model on openrouter.ai/api/v1/videos/models works).
 */
export const OPENROUTER_T2V_MODEL = "kwaivgi/kling-v3.0-std";
export const OPENROUTER_I2V_MODEL = "kwaivgi/kling-v3.0-std";

const OPENROUTER_VIDEOS_URL = "https://openrouter.ai/api/v1/videos";

interface OpenRouterVideoJob {
  id?: string;
  status?: string;
  error?: unknown;
  unsigned_urls?: string[];
}

/** Job states that mean "still working" per the OpenRouter videos API. */
const PENDING_STATUSES = new Set(["pending", "processing", "queued", "running"]);

/**
 * Clamp the requested clip length to what the chosen model accepts. Models
 * expose discrete supported_durations on OpenRouter; sending an unsupported
 * value is a 400, so snap to the nearest allowed one per known family and
 * fall back to a broadly-supported 3–15s clamp for anything else.
 */
function clampDuration(model: string, durationSec: number): number {
  const wanted = Math.max(1, Math.round(durationSec));
  const snap = (allowed: number[]): number =>
    allowed.reduce((best, d) => (Math.abs(d - wanted) < Math.abs(best - wanted) ? d : best));
  const m = model.toLowerCase();
  if (m.includes("veo")) return snap([4, 6, 8]);
  if (m.includes("sora")) return snap([4, 8, 12, 16, 20]);
  if (m.includes("kling-video-o1")) return snap([5, 10]);
  if (m.includes("wan-2.6") || m.includes("hailuo-2.3")) return snap([5, 10]);
  return Math.min(15, Math.max(3, wanted));
}

/**
 * Aspect ratios the OpenRouter video catalog accepts. Sora is 16:9/9:16 only;
 * everything else in the curated list also takes 1:1. An aspect the model
 * cannot render (4:5, 21:9, 4:3, 3:4) is requested as the nearest supported
 * ratio and cover-cropped to the true frame by normalizeVideo afterwards.
 */
function clampAspect(model: string, aspectRatio: string): string {
  const supported = model.toLowerCase().includes("sora")
    ? (["16:9", "9:16"] as const)
    : (["16:9", "9:16", "1:1"] as const);
  return providerAspect(aspectRatio as never, supported);
}

/**
 * OpenRouter video generation: submit an async job to /api/v1/videos, poll
 * the job until it reaches a terminal state, then download the clip from the
 * returned URL. A start image (image-to-video) goes in `frame_images` as the
 * first frame — supported by every catalog model that lists first_frame.
 */
export async function generateWithOpenRouterVideo(
  input: VideoGenInput,
  apiKey: string | null,
  opts?: {
    /** OpenAI/OpenRouter-compatible API root (default https://openrouter.ai/api/v1).
     * Used by admin-added custom providers exposing the same async video API. */
    baseUrl?: string;
    /** Provider label for error messages (default "OpenRouter"). */
    label?: string;
  },
): Promise<VideoGenResult> {
  const label = opts?.label ?? "OpenRouter";
  const videosUrl = opts?.baseUrl
    ? `${opts.baseUrl.replace(/\/+$/, "")}/videos`
    : OPENROUTER_VIDEOS_URL;
  if (!apiKey) {
    throw new VideoGenNotConfiguredError(
      `${label} is not configured: save an API key in the admin dashboard` +
        (opts?.baseUrl ? "." : " or set the OPENROUTER_API_KEY secret."),
    );
  }
  const model = input.model.includes("/")
    ? input.model
    : input.image
      ? OPENROUTER_I2V_MODEL
      : OPENROUTER_T2V_MODEL;
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  const body: Record<string, unknown> = {
    model,
    prompt: compiledClipPrompt(input.prompt, input.durationSec),
    aspect_ratio: clampAspect(model, input.aspectRatio),
    duration: clampDuration(model, input.durationSec),
  };
  // OpenRouter normalizes its video request body and drops keys a model does
  // not understand, so unlike Replicate these are safe to send unguarded.
  if (typeof input.seed === "number" && Number.isFinite(input.seed)) {
    body.seed = Math.trunc(input.seed);
  }
  if (input.resolution) body.resolution = input.resolution;
  if (input.quality) body.quality = input.quality;
  if (typeof input.generateAudio === "boolean") body.generate_audio = input.generateAudio;
  if (input.image) {
    body.frame_images = [
      {
        type: "image_url",
        frame_type: "first_frame",
        image_url: {
          url: `data:${input.image.mimeType};base64,${input.image.buffer.toString("base64")}`,
        },
      },
    ];
  }

  // Submit with bounded retries: 429s and transient 5xxs are routine and
  // should never fail a job the tenant already paid a video unit for.
  let job = await withRetries(
    async (): Promise<OpenRouterVideoJob> => {
      const res = await videoGenFetch(videosUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new VideoGenProviderError(
          `OpenRouter video request failed (${res.status}): ${await errorDetail(res)}`,
          res.status,
        );
      }
      return (await res.json()) as OpenRouterVideoJob;
    },
    { attempts: 3 },
  );
  if (!job.id) {
    throw new VideoGenProviderError("OpenRouter returned no video job id.");
  }
  const jobId = job.id;

  // Video jobs regularly need minutes; poll within the overall deadline. A
  // few consecutive transient poll failures are tolerated — only a
  // persistent failure (or a definitive non-2xx that isn't transient) throws.
  const pollUrl = `${videosUrl}/${jobId}`;
  const deadline = Date.now() + VIDEO_GEN_TOTAL_DEADLINE_MS;
  let consecutivePollFailures = 0;
  while (job.status && PENDING_STATUSES.has(job.status) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const poll = await videoGenFetch(pollUrl, { method: "GET", headers });
      if (!poll.ok) {
        throw new VideoGenProviderError(
          `OpenRouter video polling failed (${poll.status}): ${await errorDetail(poll)}`,
          poll.status,
        );
      }
      job = (await poll.json()) as OpenRouterVideoJob;
      consecutivePollFailures = 0;
    } catch (error) {
      const transient =
        !(error instanceof VideoGenProviderError) || isTransientStatus(error.status);
      consecutivePollFailures += 1;
      if (!transient || consecutivePollFailures >= 3) throw error;
    }
  }

  if (job.status !== "completed") {
    const detail = typeof job.error === "string" ? job.error.slice(0, 300) : job.status;
    throw new VideoGenProviderError(`OpenRouter video job did not complete: ${detail}`);
  }
  const url =
    job.unsigned_urls?.find((u) => typeof u === "string" && u.length > 0) ??
    `${videosUrl}/${encodeURIComponent(jobId)}/content?index=0`;
  let downloadHeaders: Record<string, string> | undefined;
  try {
    // OpenRouter's content endpoint requires the bearer token, while provider
    // storage URLs must not receive it. Match origins before forwarding the
    // credential so a provider-returned third-party URL cannot exfiltrate it.
    if (new URL(url).origin === new URL(videosUrl).origin) {
      downloadHeaders = { Authorization: `Bearer ${apiKey}` };
    }
  } catch {
    throw new VideoGenProviderError("OpenRouter returned an invalid video URL.");
  }
  const buffer = await withRetries(
    async () => {
      const video = await videoGenFetch(url, {
        method: "GET",
        ...(downloadHeaders ? { headers: downloadHeaders } : {}),
      });
      if (!video.ok) {
        throw new VideoGenProviderError(
          `OpenRouter video download failed (${video.status}).`,
          video.status,
        );
      }
      return Buffer.from(await video.arrayBuffer());
    },
    { attempts: 3 },
  );
  if (buffer.length === 0) {
    throw new VideoGenProviderError("OpenRouter returned an empty video.");
  }
  return { buffer, provider: "openrouter", model };
}
