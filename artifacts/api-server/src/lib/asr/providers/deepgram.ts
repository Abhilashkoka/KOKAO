import { normalizeSegments, secondsToMs } from "../segments";
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
  apiKey: string | null,
): Promise<TranscriptionResult> {
  if (!apiKey) throw new AsrNotConfiguredError("Deepgram", "DEEPGRAM_API_KEY");

  // utterances=true adds speech-delimited spans; without it Deepgram returns a
  // single flat transcript with nowhere to hang a subtitle cue.
  const query = `model=${DEEPGRAM_MODEL}&smart_format=true${input.timestamps ? "&utterances=true" : ""}`;
  const res = await asrFetch(
    `https://api.deepgram.com/v1/listen?${query}`,
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
    results?: {
      channels?: { alternatives?: { transcript?: string }[] }[];
      utterances?: { start?: number; end?: number; transcript?: string }[];
    };
  };
  const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript;
  if (typeof transcript !== "string") {
    throw new AsrProviderError("Deepgram returned an unexpected response (no transcript).");
  }
  const segments = input.timestamps
    ? normalizeSegments(
        (data.results?.utterances ?? []).map((utterance) => ({
          startMs: secondsToMs(utterance.start),
          endMs: secondsToMs(utterance.end),
          text: utterance.transcript ?? "",
        })),
      )
    : [];
  return {
    text: transcript.trim(),
    provider: "deepgram",
    model: DEEPGRAM_MODEL,
    ...(segments.length > 0 ? { segments } : {}),
  };
}
