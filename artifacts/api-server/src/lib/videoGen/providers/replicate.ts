import {
  videoGenFetch,
  errorDetail,
  VideoGenNotConfiguredError,
  VideoGenProviderError,
  VIDEO_GEN_TOTAL_DEADLINE_MS,
  compiledClipPrompt,
  type VideoGenInput,
  type VideoGenResult,
} from "../types";
import { withRetries, isTransientStatus } from "../retry";

/**
 * Default Replicate video models. Both are the fast WAN 2.2 variants: cheap,
 * quick, and solid quality for social clips. Superadmins can override either
 * from the admin dashboard (any "owner/name" model on Replicate works, e.g.
 * google/veo-3-fast, minimax/video-01, kwaivgi/kling-v2.1-standard).
 */
export const REPLICATE_T2V_MODEL = "wan-video/wan-2.2-t2v-fast";
export const REPLICATE_I2V_MODEL = "wan-video/wan-2.2-i2v-fast";

interface ReplicatePrediction {
  id?: string;
  status?: string;
  output?: unknown;
  error?: unknown;
  urls?: { get?: string };
}

function firstUrl(output: unknown): string | null {
  if (typeof output === "string") return output;
  if (Array.isArray(output) && typeof output[0] === "string") return output[0];
  return null;
}

/**
 * Replicate video models do not share one input schema, so unknown params get
 * a 422 back. Build the smallest input each model family accepts: prompt
 * everywhere, then family-specific names for the start image / aspect /
 * duration. Unrecognized models get the common WAN-style shape.
 */
function buildInput(input: VideoGenInput): Record<string, unknown> {
  const model = input.model.toLowerCase();
  const dataUri = input.image
    ? `data:${input.image.mimeType};base64,${input.image.buffer.toString("base64")}`
    : null;
  // Most video models have no (or a very limited) duration parameter, so the
  // requested length is always baked into the prompt too — models that pace
  // action to the prompt benefit, others ignore it harmlessly.
  const prompt = compiledClipPrompt(input.prompt, input.durationSec);

  if (model.includes("happyhorse")) {
    // Alibaba Happy Horse: reference images go in an "images" ARRAY (an
    // "image" key is silently ignored — the photo's subject never appears);
    // duration is an integer 3-15 seconds.
    return {
      prompt,
      aspect_ratio: input.aspectRatio,
      duration: Math.min(15, Math.max(3, Math.round(input.durationSec))),
      ...(dataUri ? { images: [dataUri] } : {}),
    };
  }
  if (model.includes("minimax")) {
    // MiniMax video-01: fixed 6s/720p clips; no aspect/duration params.
    return { prompt, ...(dataUri ? { first_frame_image: dataUri } : {}) };
  }
  if (model.includes("kling")) {
    // Kling only accepts 5 or 10 second clips.
    return {
      prompt,
      aspect_ratio: input.aspectRatio,
      duration: input.durationSec >= 10 ? 10 : 5,
      ...(dataUri ? { start_image: dataUri } : {}),
    };
  }
  if (model.includes("veo")) {
    // Veo on Replicate is 16:9-first; it rejects unknown params, keep minimal.
    return { prompt, ...(dataUri ? { image: dataUri } : {}) };
  }
  // WAN and most others accept aspect_ratio and an "image" start frame.
  return {
    prompt,
    aspect_ratio: input.aspectRatio,
    ...(dataUri ? { image: dataUri } : {}),
  };
}

/** Replicate: create a prediction (sync-preferred), poll until done, download the video. */
export async function generateWithReplicate(
  input: VideoGenInput,
  apiKey: string | null,
): Promise<VideoGenResult> {
  if (!apiKey) {
    throw new VideoGenNotConfiguredError(
      "Replicate is not configured: save an API token in the admin dashboard or set the REPLICATE_API_TOKEN secret.",
    );
  }
  const model = input.model.includes("/")
    ? input.model
    : input.image
      ? REPLICATE_I2V_MODEL
      : REPLICATE_T2V_MODEL;
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  // Create with bounded retries: 429s and transient 5xxs are routine on
  // busy video models and should never fail a multi-minute job outright.
  let prediction = await withRetries(
    async (): Promise<ReplicatePrediction> => {
      const res = await videoGenFetch(
        `https://api.replicate.com/v1/models/${model}/predictions`,
        {
          method: "POST",
          headers: { ...headers, Prefer: "wait=60" },
          body: JSON.stringify({ input: buildInput(input) }),
        },
      );
      if (!res.ok) {
        throw new VideoGenProviderError(
          `Replicate video prediction failed (${res.status}): ${await errorDetail(res)}`,
          res.status,
        );
      }
      return (await res.json()) as ReplicatePrediction;
    },
    { attempts: 3 },
  );

  // Video models regularly need minutes; poll within the overall deadline.
  // A few consecutive transient poll failures are tolerated — only a
  // persistent failure (or a definitive non-2xx that isn't transient) throws.
  const deadline = Date.now() + VIDEO_GEN_TOTAL_DEADLINE_MS;
  let consecutivePollFailures = 0;
  while (
    prediction.status &&
    ["starting", "processing"].includes(prediction.status) &&
    prediction.urls?.get &&
    Date.now() < deadline
  ) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const poll = await videoGenFetch(prediction.urls.get, { method: "GET", headers });
      if (!poll.ok) {
        throw new VideoGenProviderError(
          `Replicate polling failed (${poll.status}): ${await errorDetail(poll)}`,
          poll.status,
        );
      }
      prediction = (await poll.json()) as ReplicatePrediction;
      consecutivePollFailures = 0;
    } catch (error) {
      const transient =
        !(error instanceof VideoGenProviderError) || isTransientStatus(error.status);
      consecutivePollFailures += 1;
      if (!transient || consecutivePollFailures >= 3) throw error;
    }
  }

  if (prediction.status !== "succeeded") {
    const detail =
      typeof prediction.error === "string" ? prediction.error.slice(0, 300) : prediction.status;
    throw new VideoGenProviderError(`Replicate video prediction did not succeed: ${detail}`);
  }
  const url = firstUrl(prediction.output);
  if (!url) {
    throw new VideoGenProviderError("Replicate returned no video URL.");
  }
  const buffer = await withRetries(
    async () => {
      const video = await videoGenFetch(url, { method: "GET" });
      if (!video.ok) {
        throw new VideoGenProviderError(
          `Replicate video download failed (${video.status}).`,
          video.status,
        );
      }
      return Buffer.from(await video.arrayBuffer());
    },
    { attempts: 3 },
  );
  if (buffer.length === 0) {
    throw new VideoGenProviderError("Replicate returned an empty video.");
  }
  return { buffer, provider: "replicate", model };
}
