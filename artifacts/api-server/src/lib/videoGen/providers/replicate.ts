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
import { LATENT_SYNC, type LipSyncModelDef } from "../lipSyncModels";

/**
 * Default Replicate video models. Both are the fast WAN 2.2 variants: cheap,
 * quick, and solid quality for social clips. Superadmins can override either
 * from the admin dashboard (any "owner/name" model on Replicate works, e.g.
 * google/veo-3-fast, minimax/video-01, kwaivgi/kling-v2.1-standard).
 */
export const REPLICATE_T2V_MODEL = "wan-video/wan-2.2-t2v-fast";
export const REPLICATE_I2V_MODEL = "wan-video/wan-2.2-i2v-fast";

/**
 * The default video-mode lip-sync model, re-exported for callers that still
 * name it directly. The definition (and the portrait-mode counterpart) lives
 * in lib/videoGen/lipSyncModels.ts now that there is more than one shape.
 */
export const REPLICATE_LIP_SYNC_MODEL = LATENT_SYNC.model;
export const REPLICATE_LIP_SYNC_VERSION = LATENT_SYNC.version!;

interface ReplicatePrediction {
  id?: string;
  status?: string;
  output?: unknown;
  error?: unknown;
  urls?: { get?: string };
}

function failedPredictionStatus(error: unknown): number {
  const detail = typeof error === "string" ? error.toLowerCase() : "";
  return /nsfw|safety|content policy|moderation|invalid input|validation/.test(detail)
    ? 422
    : 503;
}

function replicatePredictionError(
  message: string,
  status: number,
  model: string,
  requestId?: string | null,
): VideoGenProviderError {
  return Object.assign(new VideoGenProviderError(message, status), {
    provider: "replicate",
    model: model.split(":")[0] || model,
    requestId: requestId?.trim() || undefined,
  });
}

function firstUrl(output: unknown): string | null {
  if (typeof output === "string") return output;
  if (Array.isArray(output) && typeof output[0] === "string") return output[0];
  return null;
}

/**
 * Aspect ratios each Replicate family actually accepts. Anything the user
 * asked for that is not on the family's list is requested as the nearest
 * supported ratio and cover-cropped to the true frame afterwards by
 * normalizeVideo — see providerAspect().
 */
const WAN_ASPECTS = ["16:9", "9:16", "1:1"] as const;
const KLING_ASPECTS = ["16:9", "9:16", "1:1"] as const;

/**
 * Families that accept a `seed`. Replicate 422s on unknown input keys, and a
 * 422 costs the tenant a paid video unit, so a family is only listed here
 * once its schema is known to carry a seed. Veo and MiniMax deliberately are
 * not: their inputs are minimal by design and reject extras.
 */
function acceptsSeed(model: string): boolean {
  return model.includes("wan") || model.includes("happyhorse") || model.includes("seedance");
}

/**
 * Families whose schema carries a `resolution` string. Same 422 rule as the
 * seed: an unlisted family never sees the key. Where the model cannot be
 * told, the resolution is still honoured — normalizeVideo encodes the final
 * file at the requested frame either way; asking the model just avoids
 * paying for pixels that get thrown away.
 */
function acceptsResolution(model: string): boolean {
  return model.includes("wan") || model.includes("seedance") || model.includes("veo");
}

/** Veo is the family on Replicate that generates its own audio. */
function acceptsGenerateAudio(model: string): boolean {
  return model.includes("veo");
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
  const endUri =
    input.image && input.endImage
      ? `data:${input.endImage.mimeType};base64,${input.endImage.buffer.toString("base64")}`
      : null;
  // Most video models have no (or a very limited) duration parameter, so the
  // requested length is always baked into the prompt too — models that pace
  // action to the prompt benefit, others ignore it harmlessly.
  const prompt = compiledClipPrompt(input.prompt, input.durationSec);
  // Only sent to families whose schema carries it; see acceptsSeed().
  const seed =
    typeof input.seed === "number" && Number.isFinite(input.seed) && acceptsSeed(model)
      ? { seed: Math.trunc(input.seed) }
      : {};
  const resolution =
    input.resolution && acceptsResolution(model) ? { resolution: input.resolution } : {};

  if (model.includes("happyhorse")) {
    // Alibaba Happy Horse: reference images go in an "images" ARRAY (an
    // "image" key is silently ignored — the photo's subject never appears);
    // duration is an integer 3-15 seconds.
    return {
      prompt,
      aspect_ratio: providerAspect(input.aspectRatio, WAN_ASPECTS),
      duration: Math.min(15, Math.max(3, Math.round(input.durationSec))),
      ...(dataUri ? { images: [dataUri] } : {}),
      ...seed,
      ...resolution,
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
      aspect_ratio: providerAspect(input.aspectRatio, KLING_ASPECTS),
      duration: input.durationSec >= 10 ? 10 : 5,
      ...(dataUri ? { start_image: dataUri } : {}),
      // Kling names the last frame end_image; WAN calls it last_image.
      ...(endUri ? { end_image: endUri } : {}),
    };
  }
  if (model.includes("veo")) {
    // Veo on Replicate is 16:9-first and rejects unknown params, so the input
    // stays minimal — but resolution and audio ARE in its schema, and audio is
    // the whole reason to reach for Veo over a cheaper model.
    return {
      prompt,
      ...(dataUri ? { image: dataUri } : {}),
      ...resolution,
      ...(typeof input.generateAudio === "boolean" && acceptsGenerateAudio(model)
        ? { generate_audio: input.generateAudio }
        : {}),
    };
  }
  // WAN and most others accept aspect_ratio and an "image" start frame.
  return {
    prompt,
    aspect_ratio: providerAspect(input.aspectRatio, WAN_ASPECTS),
    ...seed,
    ...resolution,
    ...(dataUri ? { image: dataUri } : {}),
    ...(endUri ? { last_image: endUri } : {}),
  };
}

/**
 * Upload a file to Replicate's Files API and return a URL usable as a
 * prediction input. Data URIs are capped far below video sizes, so any
 * video/audio input has to go through here.
 */
async function uploadReplicateFile(
  bytes: Buffer,
  mimeType: string,
  filename: string,
  apiKey: string,
): Promise<string> {
  return withRetries(
    async () => {
      const form = new FormData();
      form.append("content", new Blob([new Uint8Array(bytes)], { type: mimeType }), filename);
      const res = await videoGenFetch("https://api.replicate.com/v1/files", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
      if (!res.ok) {
        throw new VideoGenProviderError(
          `Replicate file upload failed (${res.status}): ${await errorDetail(res)}`,
          res.status,
        );
      }
      const json = (await res.json()) as { urls?: { get?: string } };
      const url = json.urls?.get;
      if (!url) throw new VideoGenProviderError("Replicate file upload returned no URL.");
      return url;
    },
    { attempts: 3 },
  );
}

/**
 * Lip-sync a base video to a narration track with LatentSync. The model's
 * whole input schema is {video, audio} (plus tuning knobs left at their
 * defaults), so both files are uploaded first — LatentSync inputs are far
 * beyond data-URI limits.
 */
export async function generateLipSyncWithReplicate(
  args: {
    /** The face to animate: an existing video of a person, or a portrait. */
    source: { buffer: Buffer; mimeType: string };
    audio: { buffer: Buffer; mimeType: string };
    /** Which model, and what its input keys are called. */
    def: LipSyncModelDef;
  },
  apiKey: string | null,
  /**
   * Model reference to run: "owner/name" or "owner/name:version". Defaults to
   * the pinned LatentSync build. Overridable so one lip-sync model can be
   * compared against another on the same footage without a deploy — what
   * makes this feature is the {video, audio} contract, not which model
   * honors it.
   */
  modelRef?: string | null,
): Promise<VideoGenResult> {
  if (!apiKey) {
    throw new VideoGenNotConfiguredError(
      "Replicate is not configured: save an API token in the admin dashboard or set the REPLICATE_API_TOKEN secret.",
    );
  }
  const { def } = args;
  const defaultRef = def.version ? `${def.model}:${def.version}` : def.model;
  const ref = modelRef?.trim() || defaultRef;
  const [sourceUrl, audioUrl] = [
    await uploadReplicateFile(
      args.source.buffer,
      args.source.mimeType,
      def.mode === "portrait" ? "source-portrait" : "source-video",
      apiKey,
    ),
    await uploadReplicateFile(args.audio.buffer, args.audio.mimeType, "voice-audio", apiKey),
  ];
  const buffer = await runReplicatePrediction(
    ref,
    { [def.sourceField]: sourceUrl, [def.audioField]: audioUrl },
    apiKey,
  );
  // Record the model that actually ran (version suffix stripped) so a job row
  // names the build that produced the file, not the default it overrode.
  return { buffer, provider: "replicate", model: ref.split(":")[0] || REPLICATE_LIP_SYNC_MODEL };
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
  const buffer = await runReplicatePrediction(model, buildInput(input), apiKey);
  return { buffer, provider: "replicate", model };
}

/** Create a prediction, poll it to completion, download and return the output video. */
async function runReplicatePrediction(
  model: string,
  input: Record<string, unknown>,
  apiKey: string,
): Promise<Buffer> {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  // Create with bounded retries: 429s and transient 5xxs are routine on
  // busy video models and should never fail a multi-minute job outright.
  const isVersionedCommunityModel = model.includes(":");
  const predictionUrl = isVersionedCommunityModel
    ? "https://api.replicate.com/v1/predictions"
    : `https://api.replicate.com/v1/models/${model}/predictions`;
  const predictionBody = isVersionedCommunityModel
    ? { version: model, input }
    : { input };
  let prediction = await withRetries(
    async (): Promise<ReplicatePrediction> => {
      const res = await videoGenFetch(
        predictionUrl,
        {
          method: "POST",
          headers: { ...headers, Prefer: "wait=60" },
          body: JSON.stringify(predictionBody),
        },
      );
      if (!res.ok) {
        throw replicatePredictionError(
          `Replicate video prediction failed (${res.status}): ${await errorDetail(res)}`,
          res.status,
          model,
          res.headers.get("x-request-id"),
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
    throw replicatePredictionError(
      `Replicate video prediction did not succeed: ${detail}`,
      failedPredictionStatus(prediction.error),
      model,
      prediction.id,
    );
  }
  const url = firstUrl(prediction.output);
  if (!url) {
    throw replicatePredictionError(
      "Replicate returned no video URL.",
      503,
      model,
      prediction.id,
    );
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
  return buffer;
}
