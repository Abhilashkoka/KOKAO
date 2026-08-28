import { isNvidiaCoreDeploymentActivatable, resolveNvidiaCoreDeployment } from "../../nvidiaCore";
import { NVIDIA_WAN_2_2_VIDEO_MODEL, nvidiaNimVideoEndpoint } from "../../nvidia";
import { boundedProviderFetch } from "../../aiProviderFetch";
import {
  errorDetail,
  providerAspect,
  VIDEO_GEN_TOTAL_DEADLINE_MS,
  VideoGenNotConfiguredError,
  VideoGenProviderError,
  type VideoGenInput,
  type VideoGenResult,
} from "../types";

export const NVIDIA_NIM_VIDEO_MODEL = NVIDIA_WAN_2_2_VIDEO_MODEL;

function decodeVideo(value: unknown): Buffer {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new VideoGenProviderError("NVIDIA NIM returned invalid base64 video data.");
  }
  const buffer = Buffer.from(value, "base64");
  // ISO BMFF/MP4 starts with a sized `ftyp` box. Reject HTML, JSON and other
  // accidental base64 payloads before they reach ffmpeg or object storage.
  if (
    buffer.length < 12 ||
    buffer.toString("ascii", 4, 8) !== "ftyp" ||
    buffer.readUInt32BE(0) < 8 ||
    buffer.readUInt32BE(0) > buffer.length
  ) {
    throw new VideoGenProviderError("NVIDIA NIM response was not a valid MP4 file.");
  }
  return buffer;
}

/** NVIDIA Visual GenAI NIM 1.6 synchronous OpenAI video contract. */
export async function generateWithNvidiaNimVideo(
  input: VideoGenInput,
  _apiKey: string | null,
): Promise<VideoGenResult> {
  const deployment = await resolveNvidiaCoreDeployment("video");
  if (!deployment || !(await isNvidiaCoreDeploymentActivatable("video"))) {
    throw new VideoGenNotConfiguredError(
      "NVIDIA video requires an enabled, tested, explicitly priced self-hosted NIM deployment.",
    );
  }
  if (deployment.kind !== "self-hosted" || deployment.model !== NVIDIA_NIM_VIDEO_MODEL) {
    throw new VideoGenNotConfiguredError("NVIDIA hosted video is not supported.");
  }

  const seconds = Math.min(12, Math.max(1, Math.round(input.durationSec)));
  const aspect = providerAspect(input.aspectRatio, ["16:9", "9:16"]);
  const body: Record<string, unknown> = {
    prompt: input.prompt.trim(),
    size: aspect === "9:16" ? "480x832" : "832x480",
    model: NVIDIA_NIM_VIDEO_MODEL,
    seconds,
  };
  if (typeof input.seed === "number" && Number.isFinite(input.seed)) {
    body.seed = Math.trunc(input.seed);
  }
  if (input.image) {
    body.input_reference =
      `data:${input.image.mimeType};base64,${input.image.buffer.toString("base64")}`;
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (deployment.resolvedApiKey) {
    headers.Authorization = `Bearer ${deployment.resolvedApiKey}`;
  }
  // Unlike hosted job APIs this NIM route is synchronous, so give the single
  // request the normal whole-generation budget while still enforcing a hard
  // upper bound.
  const response = await boundedProviderFetch(
    nvidiaNimVideoEndpoint(deployment.baseUrl),
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
    VIDEO_GEN_TOTAL_DEADLINE_MS,
    () =>
      new VideoGenProviderError(
        `NVIDIA NIM video generation timed out after ${VIDEO_GEN_TOTAL_DEADLINE_MS / 1000}s.`,
      ),
  );
  if (!response.ok) {
    throw new VideoGenProviderError(
      `NVIDIA NIM video request failed (${response.status}): ${await errorDetail(response)}`,
      response.status,
    );
  }
  const payload = (await response.json().catch(() => null)) as
    | { data?: { b64_json?: unknown } }
    | null;
  const buffer = decodeVideo(payload?.data?.b64_json);
  return { buffer, provider: "nvidia", model: NVIDIA_NIM_VIDEO_MODEL };
}