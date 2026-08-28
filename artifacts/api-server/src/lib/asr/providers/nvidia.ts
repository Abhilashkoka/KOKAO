import {
  isNvidiaCoreDeploymentActivatable,
  resolveNvidiaCoreDeployment,
  NVIDIA_TIMEOUT_MS,
} from "../../nvidiaCore";
import { normalizeSegments, secondsToMs } from "../segments";
import {
  AsrNotConfiguredError,
  AsrProviderError,
  type TranscribeInput,
  type TranscriptionResult,
} from "../types";
import { boundedProviderFetch, errorDetail } from "../../aiProviderFetch";

export const NVIDIA_ASR_MODEL = "administrator-configured-nim";

export async function transcribeWithNvidia(
  input: TranscribeInput,
  _apiKey: string | null,
): Promise<TranscriptionResult> {
  const deployment = await resolveNvidiaCoreDeployment("asr");
  if (!deployment) throw new AsrNotConfiguredError("NVIDIA ASR", "NVIDIA NIM deployment");
  if (!(await isNvidiaCoreDeploymentActivatable("asr"))) {
    throw new AsrProviderError(
      "NVIDIA ASR must pass its connection test and have an explicit USD 0 self-hosted cost confirmation before use.",
      503,
    );
  }
  if (deployment.kind === "hosted" && !deployment.resolvedApiKey) {
    throw new AsrNotConfiguredError("NVIDIA ASR", "NVIDIA_API_KEY");
  }
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(input.buffer)], { type: input.mimeType }), input.filename);
  form.append("model", deployment.model);
  form.append("response_format", input.timestamps ? "verbose_json" : "json");
  if (input.language?.trim()) form.append("language", input.language.trim());
  const headers: Record<string, string> = {};
  if (deployment.resolvedApiKey) headers.Authorization = `Bearer ${deployment.resolvedApiKey}`;
  const res = await boundedProviderFetch(
    `${deployment.baseUrl}/audio/transcriptions`,
    { method: "POST", headers, body: form, redirect: "error" },
    NVIDIA_TIMEOUT_MS,
    () => new AsrProviderError(`NVIDIA transcription timed out after ${NVIDIA_TIMEOUT_MS / 1000}s.`),
  );
  if (!res.ok) {
    throw new AsrProviderError(
      `NVIDIA transcription failed (${res.status}): ${await errorDetail(res)}`,
      res.status,
    );
  }
  const data = (await res.json().catch(() => null)) as
    | { text?: string; segments?: Array<{ start?: number; end?: number; text?: string }> }
    | null;
  if (!data || typeof data.text !== "string") {
    throw new AsrProviderError("NVIDIA transcription returned an incompatible response");
  }
  const segments = input.timestamps
    ? normalizeSegments(
        (data.segments ?? []).map((segment) => ({
          startMs: secondsToMs(segment.start),
          endMs: secondsToMs(segment.end),
          text: segment.text ?? "",
        })),
      )
    : [];
  return {
    text: data.text.trim(),
    provider: "nvidia",
    model: deployment.model,
    ...(segments.length ? { segments } : {}),
  };
}