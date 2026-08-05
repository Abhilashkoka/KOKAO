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
import type { CustomVideoApiMapping } from "@workspace/db";
import {
  DEFAULT_VIDEO_PENDING_VALUES,
  DEFAULT_VIDEO_COMPLETED_VALUE,
} from "../../customAiProviders";

/**
 * Template-mapped video generation for custom providers whose video API does
 * NOT copy OpenRouter's shape. The admin describes the API once (endpoint
 * paths plus dot-notation JSON field paths, validated by
 * validateVideoApiMapping) and this generic adapter drives it:
 *
 *   submit  POST {baseUrl}{submitPath}   — body fields placed per mapping
 *   poll    GET  {baseUrl}{pollPath}     — "{id}" replaced with the job id
 *                                          (skipped when pollPath is empty:
 *                                          synchronous APIs return the video
 *                                          URL directly from the submit call)
 *   download the URL found at videoUrlPath (string or array of strings)
 *
 * Retry/deadline behavior deliberately mirrors the OpenRouter adapter so
 * failover classification upstream treats both identically.
 */

/** Read a dot path ("output.0.url") from a JSON value; undefined when absent. */
export function getAtPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const seg of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

/** Set a dot path on a plain-object body, creating intermediate objects. */
export function setAtPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segs = path.split(".");
  let current = target;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]!;
    const existing = current[seg];
    if (existing === null || typeof existing !== "object" || Array.isArray(existing)) {
      current[seg] = {};
    }
    current = current[seg] as Record<string, unknown>;
  }
  current[segs.at(-1)!] = value;
}

/** The first non-empty string at a path, unwrapping a string array if needed. */
function stringAtPath(value: unknown, path: string): string | null {
  const found = getAtPath(value, path);
  if (typeof found === "string" && found.length > 0) return found;
  if (Array.isArray(found)) {
    const first = found.find((v) => typeof v === "string" && v.length > 0);
    if (typeof first === "string") return first;
  }
  return null;
}

export async function generateWithMappedVideo(
  input: VideoGenInput,
  apiKey: string | null,
  opts: {
    baseUrl: string;
    label: string;
    mapping: CustomVideoApiMapping;
  },
): Promise<VideoGenResult> {
  const { mapping, label } = opts;
  // validateVideoApiMapping guarantees these for template "custom"; check
  // again here so a stale/hand-edited row fails with a clear message instead
  // of an undefined-path crash.
  if (mapping.template !== "custom" || !mapping.submitPath || !mapping.promptField || !mapping.videoUrlPath) {
    throw new VideoGenNotConfiguredError(
      `${label} has an incomplete video API mapping: edit the provider in the admin dashboard and fill in the submit path, prompt field and video URL path.`,
    );
  }
  if (mapping.pollPath && (!mapping.jobIdPath || !mapping.statusPath)) {
    throw new VideoGenNotConfiguredError(
      `${label} has an incomplete video API mapping: a poll path needs both a job id path and a status path.`,
    );
  }
  if (!apiKey) {
    throw new VideoGenNotConfiguredError(
      `${label} is not configured: save an API key in the admin dashboard.`,
    );
  }

  const base = opts.baseUrl.replace(/\/+$/, "");
  const submitUrl = `${base}${mapping.submitPath}`;
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  const body: Record<string, unknown> = {};
  setAtPath(body, mapping.promptField, compiledClipPrompt(input.prompt, input.durationSec));
  if (mapping.modelField) setAtPath(body, mapping.modelField, input.model);
  if (mapping.durationField) {
    setAtPath(body, mapping.durationField, Math.max(1, Math.round(input.durationSec)));
  }
  if (mapping.aspectRatioField) setAtPath(body, mapping.aspectRatioField, input.aspectRatio);
  if (input.image) {
    if (!mapping.imageField) {
      throw new VideoGenNotConfiguredError(
        `${label}'s video API mapping has no image field, so it cannot animate a photo. Add an image field to the mapping or switch the image-to-video engine to another provider.`,
      );
    }
    setAtPath(
      body,
      mapping.imageField,
      `data:${input.image.mimeType};base64,${input.image.buffer.toString("base64")}`,
    );
  }

  // Submit with bounded retries — 429s and transient 5xxs are routine and
  // must not fail a job the tenant already paid a video unit for.
  let job = await withRetries(
    async (): Promise<unknown> => {
      const res = await videoGenFetch(submitUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new VideoGenProviderError(
          `${label} video request failed (${res.status}): ${await errorDetail(res)}`,
          res.status,
        );
      }
      return res.json();
    },
    { attempts: 3 },
  );

  if (mapping.pollPath) {
    const jobId = stringAtPath(job, mapping.jobIdPath!) ?? numberIdAtPath(job, mapping.jobIdPath!);
    if (!jobId) {
      throw new VideoGenProviderError(
        `${label} returned no video job id at "${mapping.jobIdPath}".`,
      );
    }
    const pendingValues = new Set(mapping.pendingValues ?? DEFAULT_VIDEO_PENDING_VALUES);
    const completedValue = mapping.completedValue ?? DEFAULT_VIDEO_COMPLETED_VALUE;
    const pollUrl = `${base}${mapping.pollPath.replace("{id}", encodeURIComponent(jobId))}`;
    const deadline = Date.now() + VIDEO_GEN_TOTAL_DEADLINE_MS;
    let consecutivePollFailures = 0;
    let status = String(getAtPath(job, mapping.statusPath!) ?? "");
    while (pendingValues.has(status) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000));
      try {
        const poll = await videoGenFetch(pollUrl, { method: "GET", headers });
        if (!poll.ok) {
          throw new VideoGenProviderError(
            `${label} video polling failed (${poll.status}): ${await errorDetail(poll)}`,
            poll.status,
          );
        }
        job = await poll.json();
        status = String(getAtPath(job, mapping.statusPath!) ?? "");
        consecutivePollFailures = 0;
      } catch (error) {
        const transient =
          !(error instanceof VideoGenProviderError) || isTransientStatus(error.status);
        consecutivePollFailures += 1;
        if (!transient || consecutivePollFailures >= 3) throw error;
      }
    }
    if (status !== completedValue) {
      const detail =
        (mapping.errorPath && stringAtPath(job, mapping.errorPath)?.slice(0, 300)) ||
        status ||
        "unknown status";
      throw new VideoGenProviderError(`${label} video job did not complete: ${detail}`);
    }
  }

  const url = stringAtPath(job, mapping.videoUrlPath);
  if (!url) {
    throw new VideoGenProviderError(
      `${label} returned no video URL at "${mapping.videoUrlPath}".`,
    );
  }
  const buffer = await withRetries(
    async () => {
      const video = await videoGenFetch(url, { method: "GET" });
      if (!video.ok) {
        throw new VideoGenProviderError(
          `${label} video download failed (${video.status}).`,
          video.status,
        );
      }
      return Buffer.from(await video.arrayBuffer());
    },
    { attempts: 3 },
  );
  if (buffer.length === 0) {
    throw new VideoGenProviderError(`${label} returned an empty video.`);
  }
  return { buffer, provider: "custom", model: input.model };
}

/** Numeric job ids are common ("id": 12345) — stringify them for the URL. */
function numberIdAtPath(value: unknown, path: string): string | null {
  const found = getAtPath(value, path);
  return typeof found === "number" && Number.isFinite(found) ? String(found) : null;
}
