import {
  videoGenFetch,
  errorDetail,
  VideoGenNotConfiguredError,
  VideoGenProviderError,
} from "./types";
import { withRetries, isTransientStatus } from "./retry";
import { getVideoGenProviderDef, resolveVideoGenApiKey } from "./index";

/**
 * AI background-music beds via Replicate's MusicGen (meta/musicgen), using
 * the SAME Replicate token the video engine already has — no new secrets.
 * MusicGen tops out at 30 seconds; the composers loop the bed with a
 * fade-out, so 30s covers any video length.
 */

export const MUSICGEN_MODEL = "meta/musicgen";
/** Community models must be invoked through /v1/predictions with a version.
 * The /v1/models/{owner}/{name}/predictions shortcut is only for official models. */
export const MUSICGEN_VERSION =
  "671ac645ce5e552cc63a54a2bbff63fcf798043055d2dac5fc9e36a837eedcfb";
const MIN_DURATION_SEC = 5;
const MAX_DURATION_SEC = 30;
/** MusicGen usually finishes in ~1-2 min; bound the wait. */
const MUSICGEN_DEADLINE_MS = 5 * 60 * 1000;

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

/** Generate an instrumental bed for the given mood/style description. */
export async function generateMusicBed(
  prompt: string,
  videoDurationSec: number,
): Promise<Buffer> {
  const def = getVideoGenProviderDef("replicate");
  const apiKey = def ? await resolveVideoGenApiKey(def) : null;
  if (!apiKey) {
    throw new VideoGenNotConfiguredError(
      "AI music needs Replicate: save an API token in the admin dashboard or set the REPLICATE_API_TOKEN secret (uploading a track works without it).",
    );
  }

  const duration = musicGenDurationSec(videoDurationSec);
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  const input = {
    // Steer toward a loopable instrumental bed rather than a song.
    prompt: `${prompt.trim()}. Instrumental background music, no vocals, steady consistent energy, loopable.`,
    duration,
    model_version: "stereo-large",
    output_format: "mp3",
    normalization_strategy: "loudness",
  };

  let prediction = await withRetries(
    async (): Promise<ReplicatePrediction> => {
      const res = await videoGenFetch(
        "https://api.replicate.com/v1/predictions",
        {
          method: "POST",
          headers: { ...headers, Prefer: "wait=60" },
          body: JSON.stringify({ version: MUSICGEN_VERSION, input }),
        },
      );
      if (!res.ok) {
        throw new VideoGenProviderError(
          `Music generation failed (${res.status}): ${await errorDetail(res)}`,
          res.status,
        );
      }
      return (await res.json()) as ReplicatePrediction;
    },
    { attempts: 3 },
  );

  const deadline = Date.now() + MUSICGEN_DEADLINE_MS;
  let consecutivePollFailures = 0;
  while (
    prediction.status &&
    ["starting", "processing"].includes(prediction.status) &&
    prediction.urls?.get &&
    Date.now() < deadline
  ) {
    await new Promise((r) => setTimeout(r, 4000));
    try {
      const poll = await videoGenFetch(prediction.urls.get, { method: "GET", headers });
      if (!poll.ok) {
        throw new VideoGenProviderError(
          `Music generation polling failed (${poll.status}): ${await errorDetail(poll)}`,
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
    throw new VideoGenProviderError(`Music generation did not succeed: ${detail}`);
  }
  const url = firstUrl(prediction.output);
  if (!url) {
    throw new VideoGenProviderError("Music generation returned no audio.");
  }
  const buffer = await withRetries(
    async () => {
      const audio = await videoGenFetch(url, { method: "GET" });
      if (!audio.ok) {
        throw new VideoGenProviderError(
          `Music download failed (${audio.status}).`,
          audio.status,
        );
      }
      return Buffer.from(await audio.arrayBuffer());
    },
    { attempts: 3 },
  );
  if (buffer.length === 0) {
    throw new VideoGenProviderError("Music generation returned an empty file.");
  }
  return buffer;
}

/** Exact duration sent to MusicGen; shared by checkpoint billing. */
export function musicGenDurationSec(videoDurationSec: number): number {
  return Math.min(MAX_DURATION_SEC, Math.max(MIN_DURATION_SEC, Math.ceil(videoDurationSec)));
}
