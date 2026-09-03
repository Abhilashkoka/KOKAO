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
 * Higgsfield: one key across Veo 3.1, Kling and Seedance.
 *
 * The appeal is aggregation — a single billing relationship and one auth
 * header for models that otherwise mean three vendor accounts. The cost is
 * that every model keeps its own request shape, so the MODEL STRING HERE IS
 * THE ENDPOINT PATH ("veo3.1/image-to-video"). That reads oddly next to
 * Replicate's "owner/name", but it is what the API is: there is no model
 * parameter, the path selects the model.
 *
 * Async, like every serious video API: POST returns a request id, you poll
 * until it settles, then download. Output files expire after about a week,
 * which is why the caller uploads the bytes to tenant storage immediately —
 * a URL kept instead of the file would rot inside a fortnight.
 */

const HIGGSFIELD_BASE_URL = "https://api.higgsfield.ai";

export const HIGGSFIELD_T2V_MODEL = "veo3.1/fast";
export const HIGGSFIELD_I2V_MODEL = "veo3.1/fast/image-to-video";

/** Poll spacing. Video takes minutes; a tighter loop only wastes calls. */
const POLL_INTERVAL_MS = 5000;

/**
 * Veo accepts only these, as strings, and rejects anything else outright —
 * so the requested length is snapped to the nearest allowed value rather than
 * sent through and refused. The scene keeps its real duration regardless: the
 * compositor already trims or holds a provider clip to fit its scene.
 */
const VEO_DURATIONS = [4, 6, 8] as const;

/**
 * Veo's image-to-video endpoint documents only these two. A 1:1 or 4:5 job
 * would be refused, so it is mapped to the nearest orientation and the
 * compositor crops to the real aspect, exactly as it does for other providers
 * that do not offer every shape.
 */
function veoAspect(aspect: string): "16:9" | "9:16" {
  const [w, h] = aspect.split(":").map(Number);
  return w && h && w > h ? "16:9" : "9:16";
}

function veoDuration(durationSec: number): string {
  const nearest = VEO_DURATIONS.reduce((best, value) =>
    Math.abs(value - durationSec) < Math.abs(best - durationSec) ? value : best,
  );
  return String(nearest);
}

function veoResolution(resolution?: string | null): "720" | "1080" {
  return resolution === "1080p" || resolution === "1080" ? "1080" : "720";
}

/**
 * Whether this path is one of the Veo routes, which are the only ones
 * documented to take duration/resolution/aspect enums and generate_audio.
 * Kling and Seedance routes take prompt plus image and reject the rest.
 */
function isVeoPath(model: string): boolean {
  return model.startsWith("veo");
}

/**
 * The request body for a path.
 *
 * Exported for tests: the enums are the whole risk surface here. Sending a
 * duration Veo does not accept is a 400 after the user has waited, and every
 * one of these values is a documented enum rather than a free number.
 */
export function higgsfieldRequestBody(input: VideoGenInput): Record<string, unknown> {
  const prompt = compiledClipPrompt(input.prompt, input.durationSec);
  // Both existing providers hand images over as data URIs, so this follows
  // them. Higgsfield documents image_url only as "format: uri", which a data
  // URI satisfies by the letter; if it turns out to want a fetchable http(s)
  // URL, the fix is a signed storage URL rather than a different shape.
  const imageUrl = input.image
    ? `data:${input.image.mimeType};base64,${input.image.buffer.toString("base64")}`
    : null;

  if (!isVeoPath(input.model)) {
    // Kling and Seedance: prompt, plus the still when there is one.
    return { prompt, ...(imageUrl ? { image_url: imageUrl } : {}) };
  }
  const body: Record<string, unknown> = {
    prompt,
    duration: veoDuration(input.durationSec),
    resolution: veoResolution(input.resolution),
    aspect_ratio: veoAspect(input.aspectRatio),
    // Explicitly false unless asked. The compositor mixes its own narration
    // and music, and a clip that arrives carrying dialogue would collide with
    // that whole path — so audio is opt-in, never inherited.
    generate_audio: input.generateAudio === true,
  };
  if (imageUrl) body.image_url = imageUrl;
  if (input.endImage && input.model.includes("first-last-frame")) {
    body.first_frame_url = imageUrl;
    body.last_frame_url = `data:${input.endImage.mimeType};base64,${input.endImage.buffer.toString("base64")}`;
    delete body.image_url;
  }
  return body;
}

/** What a submit or poll response can carry, across the shapes seen in the wild. */
interface HiggsfieldRequestStatus {
  id?: string;
  request_id?: string;
  status?: string;
  state?: string;
  status_url?: string;
  error?: unknown;
  detail?: unknown;
  output?: unknown;
  result?: unknown;
  results?: unknown;
}

/**
 * The finished file's URL.
 *
 * Higgsfield's published OpenAPI truncates the RequestStatus schema, so the
 * exact nesting is not documented. Rather than guess one path and fail
 * mysteriously on a near miss, this walks the response for the first URL that
 * looks like a media file. A wrong guess here would surface as "returned no
 * video URL" on a job that actually succeeded and was billed.
 */
export function higgsfieldOutputUrl(payload: unknown, depth = 0): string | null {
  if (depth > 6 || payload == null) return null;
  if (typeof payload === "string") {
    return /^https?:\/\//.test(payload) && /\.(mp4|mov|webm|m4v)(\?|$)/i.test(payload)
      ? payload
      : null;
  }
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = higgsfieldOutputUrl(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof payload === "object") {
    // Prefer the conventional carriers before walking everything else.
    const record = payload as Record<string, unknown>;
    for (const key of ["url", "video_url", "output_url", "file_url", "raw_url"]) {
      const found = higgsfieldOutputUrl(record[key], depth + 1);
      if (found) return found;
    }
    for (const value of Object.values(record)) {
      const found = higgsfieldOutputUrl(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Terminal states, tolerant of the vocabulary these APIs vary on. */
export function higgsfieldTerminalState(status: string | undefined): "done" | "failed" | null {
  const value = (status ?? "").toLowerCase();
  if (["completed", "complete", "succeeded", "success", "finished", "ready"].includes(value)) {
    return "done";
  }
  if (["failed", "error", "errored", "cancelled", "canceled", "expired"].includes(value)) {
    return "failed";
  }
  return null;
}

export async function generateWithHiggsfield(
  input: VideoGenInput,
  apiKey: string | null,
): Promise<VideoGenResult> {
  if (!apiKey) {
    throw new VideoGenNotConfiguredError(
      "Higgsfield needs its API key before it can generate video.",
    );
  }
  // The key is the documented "<key id>:<key secret>" pair, stored as one
  // secret and passed through verbatim. Splitting it into two settings would
  // buy nothing and give the admin two ways to get it half right.
  const headers = {
    Authorization: `Key ${apiKey}`,
    "Content-Type": "application/json",
  };
  const path = input.model.startsWith("/") ? input.model : `/${input.model}`;

  let status = await withRetries(
    async () => {
      const res = await videoGenFetch(`${HIGGSFIELD_BASE_URL}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(higgsfieldRequestBody(input)),
      });
      if (!res.ok) {
        throw new VideoGenProviderError(
          `Higgsfield request failed (${res.status}): ${await errorDetail(res)}`,
          res.status,
        );
      }
      return (await res.json()) as HiggsfieldRequestStatus;
    },
    { attempts: 3 },
  );

  const requestId = status.id ?? status.request_id;
  const statusUrl =
    status.status_url ??
    (requestId ? `${HIGGSFIELD_BASE_URL}/requests/${requestId}/status` : null);
  if (!statusUrl) {
    throw new VideoGenProviderError("Higgsfield returned no request id to poll.");
  }

  const deadline = Date.now() + VIDEO_GEN_TOTAL_DEADLINE_MS;
  let consecutivePollFailures = 0;
  while (
    higgsfieldTerminalState(status.status ?? status.state) === null &&
    Date.now() < deadline
  ) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    try {
      const poll = await videoGenFetch(statusUrl, { method: "GET", headers });
      if (!poll.ok) {
        throw new VideoGenProviderError(
          `Higgsfield polling failed (${poll.status}): ${await errorDetail(poll)}`,
          poll.status,
        );
      }
      status = (await poll.json()) as HiggsfieldRequestStatus;
      consecutivePollFailures = 0;
    } catch (error) {
      // A couple of dropped polls mid-generation are not a failed generation;
      // a definitive non-transient response is.
      const transient =
        !(error instanceof VideoGenProviderError) || isTransientStatus(error.status);
      consecutivePollFailures += 1;
      if (!transient || consecutivePollFailures >= 3) throw error;
    }
  }

  if (higgsfieldTerminalState(status.status ?? status.state) !== "done") {
    const detail =
      typeof status.error === "string"
        ? status.error.slice(0, 300)
        : typeof status.detail === "string"
          ? status.detail.slice(0, 300)
          : (status.status ?? status.state ?? "no terminal status before the deadline");
    throw new VideoGenProviderError(`Higgsfield generation did not succeed: ${detail}`);
  }

  const url = higgsfieldOutputUrl(status);
  if (!url) {
    throw new VideoGenProviderError("Higgsfield returned no video URL.");
  }
  const buffer = await withRetries(
    async () => {
      const res = await videoGenFetch(url, { method: "GET" });
      if (!res.ok) {
        throw new VideoGenProviderError(
          `Higgsfield video download failed (${res.status}).`,
          res.status,
        );
      }
      return Buffer.from(await res.arrayBuffer());
    },
    { attempts: 3 },
  );

  return {
    buffer,
    provider: "higgsfield",
    model: input.model,
    ...(isVeoPath(input.model)
      ? { effectiveDurationSec: Number(veoDuration(input.durationSec)) }
      : {}),
  };
}