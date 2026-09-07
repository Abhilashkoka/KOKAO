import {
  compiledClipPrompt,
  providerAspect,
  VideoGenNotConfiguredError,
  VideoGenProviderError,
  VIDEO_GEN_TOTAL_DEADLINE_MS,
  VIDEO_GEN_FETCH_TIMEOUT_MS,
  type VideoGenInput,
  type VideoGenResult,
} from "../types";
import { isTransientStatus } from "../retry";
import { assertPublicHost } from "../../webFetch";

/** BytePlus ModelArk's international (Singapore) API, not the mainland Ark endpoint. */
const BYTEPLUS_MODELARK_BASE_URL = "https://ark.ap-southeast.bytepluses.com/api/v3";
const TASKS_URL = `${BYTEPLUS_MODELARK_BASE_URL}/contents/generations/tasks`;
const POLL_INTERVAL_MS = 5000;
const MAX_VIDEO_BYTES = 250 * 1024 * 1024;
const MAX_MODELARK_RESPONSE_BYTES = 1024 * 1024;

/** Official Seedance 2.5 model identifier. Do not alias this to an aggregator slug. */
export const BYTEPLUS_SEEDANCE_25_MODEL = "dreamina-seedance-2-5-260628";

interface ModelArkTask {
  id?: string;
  request_id?: string;
  requestId?: string;
  status?: string;
  error?: unknown;
  content?: {
    video_url?: unknown;
  };
}

function safeProviderId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{3,127}$/.test(trimmed) ? trimmed : null;
}

function responseRequestId(response: Response): string | null {
  return safeProviderId(
    response.headers.get("x-request-id") ??
      response.headers.get("x-tt-logid") ??
      response.headers.get("trace-id"),
  );
}

export function bytePlusRequestBody(input: VideoGenInput): Record<string, unknown> {
  const content: Record<string, unknown>[] = [{
    type: "text",
    text: compiledClipPrompt(input.prompt, input.durationSec),
  }];
  if (input.image) {
    content.push({
      type: "image_url",
      image_url: {
        url: `data:${input.image.mimeType};base64,${input.image.buffer.toString("base64")}`,
      },
      role: "first_frame",
    });
  }
  if (input.endImage) {
    content.push({
      type: "image_url",
      image_url: {
        url: `data:${input.endImage.mimeType};base64,${input.endImage.buffer.toString("base64")}`,
      },
      role: "last_frame",
    });
  }
  return {
    model: BYTEPLUS_SEEDANCE_25_MODEL,
    content,
    generate_audio: input.generateAudio === true,
    // ModelArk rejects an explicit ratio for frame-guided generation because
    // the output ratio is inherited from the supplied frame.
    ...(!input.image && !input.endImage
      ? {
          ratio: providerAspect(input.aspectRatio, [
            "16:9",
            "9:16",
            "1:1",
            "4:3",
            "3:4",
            "21:9",
          ]),
        }
      : {}),
    duration: Math.round(input.durationSec),
    resolution: input.resolution ?? "1080p",
  };
}

/** Validate untrusted provider URLs before any server-side download. */
export async function safeBytePlusMediaUrl(
  value: unknown,
  description = "BytePlus video URL",
): Promise<string> {
  if (typeof value !== "string" || !value.trim()) {
    throw new VideoGenProviderError(`${description} was not a valid URL.`, 502);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new VideoGenProviderError(`${description} was not a valid URL.`, 502);
  }
  if (url.protocol !== "https:") {
    throw new VideoGenProviderError(`${description} must use https.`, 502);
  }
  try {
    await assertPublicHost(url.hostname);
  } catch {
    throw new VideoGenProviderError(`${description} points to a blocked or private host.`, 502);
  }
  return url.toString();
}

function taskError(task: ModelArkTask): string {
  if (typeof task.error === "string") return task.error.slice(0, 300);
  if (task.error && typeof task.error === "object") {
    try {
      return JSON.stringify(task.error).slice(0, 300);
    } catch {
      // Fall through to the terminal status.
    }
  }
  return task.status ?? "unknown status";
}

function generationTimeout(
  taskId?: string,
  requestId?: string | null,
): VideoGenProviderError {
  return new VideoGenProviderError(
    "BytePlus ModelArk generation timed out before completion.",
    undefined,
    taskId,
    requestId ?? undefined,
  );
}

/**
 * This local fetch retains the standard per-call timeout while adding the
 * job's remaining wall-clock budget, without changing shared fetch policy.
 */
interface DeadlineResponse {
  response: Response;
  signal: AbortSignal;
  timeoutKind: () => "generation" | "call" | null;
  dispose: () => Promise<void>;
}

function providerCallTimeout(): VideoGenProviderError {
  return new VideoGenProviderError(
    `Video provider call timed out after ${VIDEO_GEN_FETCH_TIMEOUT_MS / 1000}s.`,
  );
}

async function fetchWithinDeadline(
  deadline: number,
  url: string,
  init: RequestInit,
): Promise<DeadlineResponse> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw generationTimeout();
  const controller = new AbortController();
  const timeoutMs = Math.min(remaining, VIDEO_GEN_FETCH_TIMEOUT_MS);
  let kind: "generation" | "call" = remaining <= VIDEO_GEN_FETCH_TIMEOUT_MS
    ? "generation"
    : "call";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return {
      response,
      signal: controller.signal,
      timeoutKind: () => timedOut ? kind : null,
      dispose: async () => {
        clearTimeout(timer);
        if (!response.body?.locked) await response.body?.cancel().catch(() => {});
      },
    };
  } catch (error) {
    clearTimeout(timer);
    if (timedOut) throw kind === "generation" ? generationTimeout() : providerCallTimeout();
    throw error;
  }
}

async function readBoundedResponse(
  active: DeadlineResponse,
  maximumBytes: number,
  description: string,
): Promise<Buffer> {
  const { response } = active;
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new VideoGenProviderError(`${description} exceeds its download limit.`, 502);
  }
  if (!response.body) {
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const pendingRead = reader.read();
    let removeAbortListener: (() => void) | undefined;
    try {
      const part = await Promise.race([
        pendingRead,
        new Promise<never>((_, reject) => {
          const aborted = () => reject(
            active.timeoutKind() === "generation" ? generationTimeout() : providerCallTimeout(),
          );
          if (active.signal.aborted) aborted();
          else {
            active.signal.addEventListener("abort", aborted, { once: true });
            removeAbortListener = () => active.signal.removeEventListener("abort", aborted);
          }
        }),
      ]);
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => {});
        throw new VideoGenProviderError(`${description} exceeds its download limit.`, 502);
      }
      chunks.push(part.value);
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      removeAbortListener?.();
    }
  }
  return Buffer.concat(chunks);
}

async function readModelArkText(active: DeadlineResponse): Promise<string> {
  return (await readBoundedResponse(
    active,
    MAX_MODELARK_RESPONSE_BYTES,
    "BytePlus ModelArk response",
  )).toString("utf8");
}

async function modelArkErrorDetail(active: DeadlineResponse): Promise<string> {
  const body = await readModelArkText(active);
  return body.slice(0, 300) || "no error detail";
}

async function parseModelArkTask(active: DeadlineResponse): Promise<ModelArkTask> {
  try {
    return JSON.parse(await readModelArkText(active)) as ModelArkTask;
  } catch (error) {
    if (error instanceof VideoGenProviderError) throw error;
    throw new VideoGenProviderError("BytePlus ModelArk response was not valid JSON.", 502);
  }
}

async function readVideoWithinDeadline(active: DeadlineResponse): Promise<Buffer> {
  try {
    return await readBoundedResponse(
      active,
      MAX_VIDEO_BYTES,
      "BytePlus ModelArk video",
    );
  } catch (error) {
    if (
      error instanceof VideoGenProviderError &&
      error.message === "BytePlus ModelArk video exceeds its download limit."
    ) {
      throw new VideoGenProviderError("BytePlus ModelArk video exceeds the 250 MiB download limit.", 502);
    }
    throw error;
  }
}

/** Follow only a short, validated redirect chain; provider URLs are untrusted. */
async function downloadBytePlusVideo(url: string, deadline: number): Promise<Buffer> {
  let current = await safeBytePlusMediaUrl(url);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const active = await fetchWithinDeadline(deadline, current, {
      method: "GET",
      redirect: "manual",
    });
    const { response } = active;
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await active.dispose();
      if (redirects === 3) {
        throw new VideoGenProviderError("BytePlus ModelArk video redirect limit exceeded.", 502);
      }
      const location = response.headers.get("location");
      if (!location) {
        throw new VideoGenProviderError("BytePlus ModelArk video redirect had no location.", 502);
      }
      current = await safeBytePlusMediaUrl(new URL(location, current).toString());
      continue;
    }
    if (!response.ok) {
      throw new VideoGenProviderError(
        `BytePlus ModelArk video download failed (${response.status}).`,
        response.status,
      );
    }
    try {
      return await readVideoWithinDeadline(active);
    } finally {
      await active.dispose();
    }
  }
  throw new VideoGenProviderError("BytePlus ModelArk video redirect limit exceeded.", 502);
}

export async function generateWithBytePlusModelArk(
  input: VideoGenInput,
  apiKey: string | null,
): Promise<VideoGenResult> {
  if (!apiKey) {
    throw new VideoGenNotConfiguredError(
      "BytePlus ModelArk is not configured: save an API key in the admin dashboard or set ARK_API_KEY.",
    );
  }
  if (input.model !== BYTEPLUS_SEEDANCE_25_MODEL) {
    throw new VideoGenProviderError(
      `BytePlus ModelArk only supports the official ${BYTEPLUS_SEEDANCE_25_MODEL} model in this integration.`,
      400,
    );
  }
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  // ModelArk does not document an idempotency key for task creation. Retrying
  // a timed-out POST could purchase two generations, so submit exactly once.
  const deadline = Date.now() + VIDEO_GEN_TOTAL_DEADLINE_MS;
  let task: ModelArkTask;
  let requestId: string | null = safeProviderId(input.providerRequestId);
  const resumedTaskId = safeProviderId(input.providerTaskId);
  if (input.providerTaskId && !resumedTaskId) {
    throw new VideoGenProviderError("Stored BytePlus ModelArk task id was invalid.", 502);
  }
  if (resumedTaskId) {
    task = { id: resumedTaskId, status: "queued" };
  } else {
    const createActive = await fetchWithinDeadline(deadline, TASKS_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(bytePlusRequestBody(input)),
    });
    requestId = responseRequestId(createActive.response);
    if (!createActive.response.ok) {
      const detail = await modelArkErrorDetail(createActive).finally(() => createActive.dispose());
      throw new VideoGenProviderError(
        `BytePlus ModelArk request failed (${createActive.response.status}): ${detail}`,
        createActive.response.status,
        undefined,
        requestId ?? undefined,
      );
    }
    task = await parseModelArkTask(createActive).finally(() => createActive.dispose());
    requestId = safeProviderId(task.request_id ?? task.requestId) ?? requestId;
    const taskId = safeProviderId(task.id);
    if (!taskId) {
      throw new VideoGenProviderError(
        "BytePlus ModelArk returned no valid task id.",
        502,
        undefined,
        requestId ?? undefined,
      );
    }
    task.id = taskId;
    try {
      await input.onProviderTaskAccepted?.({ taskId, requestId });
    } catch {
      throw new VideoGenProviderError(
        "BytePlus ModelArk accepted the task, but its recovery checkpoint could not be saved.",
        503,
        taskId,
        requestId ?? undefined,
      );
    }
  }

  const taskId = task.id!;
  const pollUrl = `${TASKS_URL}/${encodeURIComponent(taskId)}`;
  let consecutivePollFailures = 0;
  while (
    task.status !== "succeeded" &&
    task.status !== "failed" &&
    Date.now() < deadline
  ) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw generationTimeout(taskId, requestId);
    await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)));
    if (Date.now() >= deadline) throw generationTimeout(taskId, requestId);
    try {
      const active = await fetchWithinDeadline(deadline, pollUrl, { method: "GET", headers });
      const { response } = active;
      requestId = responseRequestId(response) ?? requestId;
      if (!response.ok) {
        const detail = await modelArkErrorDetail(active).finally(() => active.dispose());
        throw new VideoGenProviderError(
          `BytePlus ModelArk polling failed (${response.status}): ${detail}`,
          response.status,
        );
      }
      task = await parseModelArkTask(active).finally(() => active.dispose());
      requestId = safeProviderId(task.request_id ?? task.requestId) ?? requestId;
      consecutivePollFailures = 0;
    } catch (error) {
      const transient =
        !(error instanceof VideoGenProviderError) || isTransientStatus(error.status);
      consecutivePollFailures += 1;
      if (!transient || consecutivePollFailures >= 3) {
        throw new VideoGenProviderError(
          error instanceof Error ? error.message : "BytePlus ModelArk polling failed.",
          error instanceof VideoGenProviderError ? error.status : undefined,
          taskId,
          requestId ?? undefined,
        );
      }
    }
  }
  if (Date.now() >= deadline && task.status !== "succeeded" && task.status !== "failed") {
    throw generationTimeout(taskId, requestId);
  }
  if (task.status !== "succeeded") {
    throw new VideoGenProviderError(
      `BytePlus ModelArk generation did not succeed: ${taskError(task)}`,
      undefined,
      taskId,
      requestId ?? undefined,
    );
  }

  let buffer: Buffer;
  try {
    const outputUrl = await safeBytePlusMediaUrl(task.content?.video_url);
    buffer = await downloadBytePlusVideo(outputUrl, deadline);
  } catch (error) {
    throw new VideoGenProviderError(
      error instanceof Error ? error.message : "BytePlus ModelArk video download failed.",
      error instanceof VideoGenProviderError ? error.status : undefined,
      taskId,
      requestId ?? undefined,
    );
  }
  if (buffer.length === 0) {
    throw new VideoGenProviderError("BytePlus ModelArk returned an empty video.", 502);
  }
  return {
    buffer,
    provider: "byteplus",
    model: BYTEPLUS_SEEDANCE_25_MODEL,
    effectiveDurationSec: Math.round(input.durationSec),
    providerTaskId: taskId,
    ...(requestId ? { providerRequestId: requestId } : {}),
  };
}