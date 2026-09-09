import {
  compiledClipPrompt,
  providerAspect,
  videoGenFetch,
  VideoGenNotConfiguredError,
  VideoGenProviderError,
  type VideoGenInput,
  type VideoGenResult,
} from "../types";
import { isTransientStatus } from "../retry";
import https from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { assertPublicHost, resolvePublicHost } from "../../webFetch";
import { isAtlasGenerationReferenceId } from "../../atlascloud/assetId";

/** Atlas Cloud's documented, directly callable Seedance 2.5 endpoints. */
export const ATLASCLOUD_SEEDANCE_25_T2V_MODEL = "bytedance/seedance-2.5/text-to-video";
export const ATLASCLOUD_SEEDANCE_25_I2V_MODEL = "bytedance/seedance-2.5/image-to-video";
export const ATLASCLOUD_SEEDANCE_25_REFERENCE_MODEL =
  "bytedance/seedance-2.5/reference-to-video";

const BASE_URL = "https://api.atlascloud.ai/api/v1/model";
const GENERATE_URL = `${BASE_URL}/generateVideo`;
const POLL_INTERVAL_MS = 5_000;
// Atlas reference-to-video predictions regularly outlive the shared ten-minute
// provider budget. Keep polling the accepted task instead of presenting a
// provider failure while Atlas is still producing the scene.
const ATLASCLOUD_VIDEO_GEN_TOTAL_DEADLINE_MS = 30 * 60 * 1000;
const MAX_VIDEO_BYTES = 250 * 1024 * 1024;
const PENDING = new Set(["processing", "pending", "queued", "running"]);

interface Prediction {
  id?: unknown;
  status?: unknown;
  outputs?: unknown;
  error?: unknown;
  usage?: unknown;
  cost_usd?: unknown;
  actual_cost_usd?: unknown;
  actualCostUsd?: unknown;
}

interface Envelope {
  code?: unknown;
  message?: unknown;
  data?: Prediction;
}

function safeId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{3,127}$/.test(id) ? id : null;
}

function responseRequestId(response: Response): string | null {
  return safeId(
    response.headers.get("x-request-id") ??
      response.headers.get("x-correlation-id") ??
      response.headers.get("trace-id"),
  );
}

function detail(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 300);
  if (value && typeof value === "object") {
    try { return JSON.stringify(value).slice(0, 300); } catch { /* use fallback */ }
  }
  return "unknown provider error";
}

function nonNegativeNumber(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Read only semantically explicit receipt fields. In particular, total_tokens,
 * input_tokens and output_tokens are intentionally ignored because Atlas may
 * use those names for text accounting.
 */
export function atlasVideoReceipt(prediction: Prediction): {
  providerReportedActualUsd?: number;
  videoTokens?: number;
} {
  const usage =
    prediction.usage && typeof prediction.usage === "object"
      ? prediction.usage as Record<string, unknown>
      : {};
  const cost = nonNegativeNumber(
    prediction.actual_cost_usd ?? prediction.cost_usd ?? prediction.actualCostUsd,
  );
  const tokens = nonNegativeNumber(
    usage.video_tokens ?? usage.video_token_count ?? usage.videoTokens ??
      (prediction as Record<string, unknown>).video_tokens ??
      (prediction as Record<string, unknown>).video_token_count,
  );
  return {
    ...(cost !== null ? { providerReportedActualUsd: cost } : {}),
    ...(tokens !== null ? { videoTokens: tokens } : {}),
  };
}

async function parse(response: Response, operation: string): Promise<Prediction> {
  const envelope = await response.json().catch(() => null) as Envelope | null;
  if (!response.ok) {
    const providerDetail = response.status === 402
      ? "the configured Atlas Cloud account has insufficient provider credits or unavailable billing"
      : detail(envelope?.message);
    throw new VideoGenProviderError(
      `Atlas Cloud ${operation} failed (${response.status}): ${providerDetail}`,
      response.status,
    );
  }
  if (!envelope || !envelope.data || typeof envelope.data !== "object") {
    throw new VideoGenProviderError(`Atlas Cloud ${operation} returned invalid JSON.`, 502);
  }
  // Atlas returns a numeric application code in its documented envelope. HTTP
  // 200 alone must not be mistaken for an accepted paid generation.
  if (typeof envelope.code === "number" && envelope.code !== 0 && envelope.code !== 200) {
    throw new VideoGenProviderError(
      `Atlas Cloud ${operation} failed: ${detail(envelope.message)}`,
      502,
    );
  }
  return envelope.data;
}

/** Documented Atlas input shape; image inputs are base64, not Asset Library uploads. */
export function atlasCloudRequestBody(input: VideoGenInput): Record<string, unknown> {
  const imageMode = Boolean(input.image);
  const assetIds = input.assetIds ?? [];
  if (assetIds.some((id) => !isAtlasGenerationReferenceId(id))) {
    throw new VideoGenProviderError(
      "Atlas Cloud generation received an invalid Asset Library generation reference.",
      400,
    );
  }
  const referenceMode = input.model === ATLASCLOUD_SEEDANCE_25_REFERENCE_MODEL;
  const model = referenceMode
    ? ATLASCLOUD_SEEDANCE_25_REFERENCE_MODEL
    : imageMode || assetIds.length ? ATLASCLOUD_SEEDANCE_25_I2V_MODEL : input.model;
  const body: Record<string, unknown> = {
    model,
    prompt: compiledClipPrompt(
      assetIds.length && referenceMode
        ? `${input.prompt}\n\nUse ${assetIds.map((_, i) => `@Image${i + 1}`).join(" and ")} as the approved fictional character references.`
        : input.prompt,
      input.durationSec,
    ),
    duration: Math.max(4, Math.min(30, Math.round(input.durationSec))),
    resolution: input.resolution ?? "1080p",
    ratio: imageMode ? "adaptive" : providerAspect(input.aspectRatio, [
      "16:9", "4:3", "1:1", "3:4", "9:16", "21:9",
    ]),
    generate_audio: input.generateAudio ?? true,
    output_format: "mp4",
  };
  if (input.image) {
    body.image = `data:${input.image.mimeType};base64,${input.image.buffer.toString("base64")}`;
  }
  if (input.endImage) {
    body.last_image =
      `data:${input.endImage.mimeType};base64,${input.endImage.buffer.toString("base64")}`;
  }
  if (assetIds.length && referenceMode) {
    body.reference_images = assetIds.map((id) => `asset://${id}`);
    delete body.ratio;
  } else if (assetIds.length === 1) {
    body.image = `asset://${assetIds[0]}`;
    body.ratio = "adaptive";
  }
  return body;
}

async function safeOutputUrl(value: unknown): Promise<string> {
  if (typeof value !== "string" || !value.trim()) {
    throw new VideoGenProviderError("Atlas Cloud returned no valid video output URL.", 502);
  }
  let url: URL;
  try { url = new URL(value); } catch {
    throw new VideoGenProviderError("Atlas Cloud returned no valid video output URL.", 502);
  }
  if (url.protocol !== "https:") {
    throw new VideoGenProviderError("Atlas Cloud video output must use https.", 502);
  }
  try { await assertPublicHost(url.hostname); } catch {
    throw new VideoGenProviderError("Atlas Cloud video output points to a blocked or private host.", 502);
  }
  return url.toString();
}

export type AtlasPinnedDownload = (url: string) => Promise<Buffer>;

export interface AtlasPinnedDownloadDependencies {
  request: (
    options: https.RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => ClientRequest;
  resolveHost: typeof resolvePublicHost;
  deadlineMs?: number;
  maxBytes?: number;
}

const atlasPinnedDownloadDependencies: AtlasPinnedDownloadDependencies = {
  request: (options, callback) => https.request(options, callback),
  resolveHost: resolvePublicHost,
};

export async function pinnedDownload(
  url: string,
  dependencies: AtlasPinnedDownloadDependencies = atlasPinnedDownloadDependencies,
): Promise<Buffer> {
  const parsed = new URL(url);
  const addresses = await dependencies.resolveHost(parsed.hostname).catch(() => {
    throw new VideoGenProviderError("Atlas Cloud video output points to a blocked or private host.", 502);
  });
  const uniqueAddresses = addresses.filter(
    (address, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.address === address.address && candidate.family === address.family,
      ) === index,
  );
  if (uniqueAddresses.length === 0) {
    throw new VideoGenProviderError("Atlas Cloud video output has no public address.", 502);
  }
  const overallDeadline = Date.now() + (dependencies.deadlineMs ?? 180_000);
  let lastError: unknown;
  for (const address of uniqueAddresses) {
    const remainingMs = overallDeadline - Date.now();
    if (remainingMs <= 0) break;
    try {
      return await new Promise((resolve, reject) => {
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        let req: ClientRequest | undefined;
        const finish = (buffer: Buffer) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolve(buffer);
        };
        const fail = (message: string) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          reject(new VideoGenProviderError(message, 502));
        };
        try {
          req = dependencies.request({
            hostname: parsed.hostname, port: parsed.port || 443,
            path: `${parsed.pathname}${parsed.search}`, method: "GET", servername: parsed.hostname,
            lookup: (_host, lookupOptions, callback) => {
              if (lookupOptions.all) {
                callback(null, [{
                  address: address.address,
                  family: address.family,
                }]);
                return;
              }
              callback(null, address.address, address.family);
            },
          }, (res) => {
            const status = res.statusCode ?? 500;
            if (status < 200 || status >= 300) {
              res.destroy();
              fail("Atlas Cloud video download redirect/error is not allowed.");
              return;
            }
            const chunks: Buffer[] = []; let total = 0;
            res.on("data", (chunk: Buffer) => {
              if (settled) return;
              total += chunk.length;
              if (total > (dependencies.maxBytes ?? MAX_VIDEO_BYTES)) {
                fail("Atlas Cloud video exceeds the 250 MiB download limit.");
                req?.destroy();
                res.destroy();
              } else {
                chunks.push(chunk);
              }
            });
            res.on("end", () => finish(Buffer.concat(chunks)));
            res.on("error", () => fail("Atlas Cloud video download failed."));
          });
          req.on("error", () => fail("Atlas Cloud video download was blocked or timed out."));
          req.end();
          if (!settled) {
            timer = setTimeout(() => {
              fail("Atlas Cloud video download was blocked or timed out.");
              req?.destroy(new Error("deadline"));
            }, Math.min(remainingMs, dependencies.deadlineMs ?? 90_000));
          }
        } catch {
          fail("Atlas Cloud video download was blocked or timed out.");
        }
      });
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : "";
      if (
        !message.includes("blocked or timed out") &&
        !message.includes("download failed")
      ) {
        throw error;
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new VideoGenProviderError("Atlas Cloud video download was blocked or timed out.", 502);
}

let pinnedDownloadImpl: AtlasPinnedDownload = pinnedDownload;
/** Test-only transport seam; production always uses the address-pinned request. */
export function setAtlasPinnedDownloadForTest(impl: AtlasPinnedDownload | null): void {
  pinnedDownloadImpl = impl ?? pinnedDownload;
}

async function download(url: string): Promise<Buffer> {
  return pinnedDownloadImpl(url);
}

export async function generateWithAtlasCloud(
  input: VideoGenInput,
  apiKey: string | null,
): Promise<VideoGenResult> {
  if (!apiKey) {
    throw new VideoGenNotConfiguredError(
      "Atlas Cloud is not configured: save an API key in the admin dashboard or set ATLASCLOUD_API_KEY.",
    );
  }
  const assetMode = Boolean(input.assetIds?.length);
  const expected = assetMode
    ? input.model
    : input.image ? ATLASCLOUD_SEEDANCE_25_I2V_MODEL : ATLASCLOUD_SEEDANCE_25_T2V_MODEL;
  if (
    (!assetMode && input.model !== expected) ||
    (assetMode &&
      input.model !== ATLASCLOUD_SEEDANCE_25_REFERENCE_MODEL &&
      (input.model !== ATLASCLOUD_SEEDANCE_25_I2V_MODEL || input.assetIds!.length !== 1))
  ) {
    throw new VideoGenProviderError(`Atlas Cloud only supports the official ${expected} model for this request.`, 400);
  }
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  const deadline = Date.now() + ATLASCLOUD_VIDEO_GEN_TOTAL_DEADLINE_MS;
  let requestId = safeId(input.providerRequestId);
  let taskId = safeId(input.providerTaskId);
  if (input.providerTaskId && !taskId) {
    throw new VideoGenProviderError("Stored Atlas Cloud prediction id was invalid.", 502);
  }
  let prediction: Prediction;
  if (taskId) {
    prediction = { id: taskId, status: "processing" };
  } else {
    // The documented API has no idempotency key. Never retry this create call:
    // an ambiguous POST may have already purchased a prediction.
    await input.onProviderSubmitStarted?.();
    let response: Response;
    try {
      response = await videoGenFetch(GENERATE_URL, {
        method: "POST", headers, body: JSON.stringify(atlasCloudRequestBody(input)),
      });
    } catch {
      throw new VideoGenProviderError(
        "Atlas Cloud submit outcome is uncertain and requires manual reconciliation; it will not be retried.",
        502,
      );
    }
    requestId = responseRequestId(response) ?? requestId;
    if (response.status >= 400 && response.status < 500 && response.status !== 408) {
      await input.onProviderSubmitRejected?.();
    }
    prediction = await parse(response, "generation request");
    taskId = safeId(prediction.id);
    if (!taskId) throw new VideoGenProviderError("Atlas Cloud returned no valid prediction id.", 502);
    try {
      await input.onProviderTaskAccepted?.({ taskId, requestId });
    } catch {
      throw new VideoGenProviderError(
        "Atlas Cloud accepted the prediction, but its recovery checkpoint could not be saved.",
        503, taskId, requestId ?? undefined,
      );
    }
  }

  let failures = 0;
  while (PENDING.has(String(prediction.status).toLowerCase())) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)));
    try {
      const response = await videoGenFetch(
        `${BASE_URL}/prediction/${encodeURIComponent(taskId)}`,
        { method: "GET", headers },
      );
      requestId = responseRequestId(response) ?? requestId;
      prediction = await parse(response, "prediction polling");
      failures = 0;
    } catch (error) {
      failures += 1;
      if (!(error instanceof VideoGenProviderError) || !isTransientStatus(error.status) || failures >= 3) {
        throw new VideoGenProviderError(
          error instanceof Error ? error.message : "Atlas Cloud prediction polling failed.",
          error instanceof VideoGenProviderError ? error.status : undefined, taskId, requestId ?? undefined,
        );
      }
    }
  }
  if (String(prediction.status).toLowerCase() !== "completed") {
    const timedOut = Date.now() >= deadline && PENDING.has(String(prediction.status).toLowerCase());
    throw new VideoGenProviderError(
      timedOut ? "Atlas Cloud generation timed out before completion." :
        `Atlas Cloud generation did not complete: ${detail(prediction.error ?? prediction.status)}`,
      undefined, taskId, requestId ?? undefined,
    );
  }
  let buffer: Buffer | null = null;
  let downloadError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const outputs = Array.isArray(prediction.outputs) ? prediction.outputs : [];
    const url = await safeOutputUrl(outputs[0]);
    try {
      buffer = await download(url);
      break;
    } catch (error) {
      downloadError = error;
      if (attempt === 2) break;
      try {
        const response = await videoGenFetch(
          `${BASE_URL}/prediction/${encodeURIComponent(taskId)}`,
          { method: "GET", headers },
        );
        requestId = responseRequestId(response) ?? requestId;
        const refreshed = await parse(response, "completed prediction refresh");
        if (String(refreshed.status).toLowerCase() === "completed") {
          prediction = refreshed;
        }
      } catch {
        // Keep the last completed receipt and retry its already-validated URL.
      }
    }
  }
  if (!buffer) {
    throw new VideoGenProviderError(
      downloadError instanceof Error
        ? downloadError.message
        : "Atlas Cloud video download was blocked or timed out.",
      downloadError instanceof VideoGenProviderError ? downloadError.status : 502,
      taskId,
      requestId ?? undefined,
    );
  }
  if (!buffer.length) throw new VideoGenProviderError("Atlas Cloud returned an empty video.", 502, taskId);
  return {
    buffer, provider: "atlascloud", model: expected,
    effectiveDurationSec: Math.max(4, Math.min(30, Math.round(input.durationSec))),
    providerTaskId: taskId, ...(requestId ? { providerRequestId: requestId } : {}),
    ...atlasVideoReceipt(prediction),
  };
}