import {
  asrFetch,
  AsrNotConfiguredError,
  AsrProviderError,
  type TranscribeInput,
  type TranscriptionResult,
} from "../types";

export const DEEPGRAM_MODEL = "nova-2";

/** Deepgram pre-recorded transcription: raw audio bytes in the request body. */
export async function transcribeWithDeepgram(
  input: TranscribeInput,
): Promise<TranscriptionResult> {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) throw new AsrNotConfiguredError("Deepgram", "DEEPGRAM_API_KEY");

  const res = await asrFetch(
    `https://api.deepgram.com/v1/listen?model=${DEEPGRAM_MODEL}&smart_format=true`,
    {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": input.mimeType,
      },
      body: new Uint8Array(input.buffer),
    },
  );
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new AsrProviderError(
      `Deepgram transcription failed (${res.status}): ${detail}`,
      res.status,
    );
  }
  const data = (await res.json()) as {
    results?: { channels?: { alternatives?: { transcript?: string }[] }[] };
  };
  const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript;
  if (typeof transcript !== "string") {
    throw new AsrProviderError("Deepgram returned an unexpected response (no transcript).");
  }
  return { text: transcript.trim(), provider: "deepgram", model: DEEPGRAM_MODEL };
}
