import {
  asrFetch,
  AsrNotConfiguredError,
  AsrProviderError,
  type TranscribeInput,
  type TranscriptionResult,
} from "../types";

export const GROQ_MODEL = "whisper-large-v3-turbo";

/** Groq-hosted Whisper: OpenAI-compatible transcription endpoint. */
export async function transcribeWithGroq(
  input: TranscribeInput,
  apiKey: string | null,
): Promise<TranscriptionResult> {
  if (!apiKey) throw new AsrNotConfiguredError("Groq", "GROQ_API_KEY");

  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(input.buffer)], { type: input.mimeType }),
    input.filename,
  );
  form.append("model", GROQ_MODEL);
  form.append("response_format", "json");

  const res = await asrFetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new AsrProviderError(`Groq transcription failed (${res.status}): ${detail}`, res.status);
  }
  const data = (await res.json()) as { text?: string };
  if (typeof data.text !== "string") {
    throw new AsrProviderError("Groq returned an unexpected response (no text).");
  }
  return { text: data.text.trim(), provider: "groq", model: GROQ_MODEL };
}
