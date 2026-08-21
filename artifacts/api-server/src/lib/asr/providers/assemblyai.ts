import { groupWordsIntoSegments } from "../segments";
import {
  asrFetch,
  AsrNotConfiguredError,
  AsrProviderError,
  type TranscribeInput,
  type TranscriptionResult,
} from "../types";

export const ASSEMBLYAI_MODEL = "best";

const BASE = "https://api.assemblyai.com/v2";
const POLL_INTERVAL_MS = 1_500;
const POLL_DEADLINE_MS = 60_000;

/** AssemblyAI: upload the audio, create a transcript job, poll until done. */
export async function transcribeWithAssemblyAI(
  input: TranscribeInput,
  apiKey: string | null,
): Promise<TranscriptionResult> {
  if (!apiKey) throw new AsrNotConfiguredError("AssemblyAI", "ASSEMBLYAI_API_KEY");
  const headers = { Authorization: apiKey };

  const uploadRes = await asrFetch(`${BASE}/upload`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/octet-stream" },
    body: new Uint8Array(input.buffer),
  });
  if (!uploadRes.ok) {
    throw new AsrProviderError(`AssemblyAI upload failed (${uploadRes.status}).`, uploadRes.status);
  }
  const { upload_url: uploadUrl } = (await uploadRes.json()) as { upload_url?: string };
  if (!uploadUrl) throw new AsrProviderError("AssemblyAI upload returned no URL.");

  const createRes = await asrFetch(`${BASE}/transcript`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ audio_url: uploadUrl, speech_model: ASSEMBLYAI_MODEL }),
  });
  if (!createRes.ok) {
    const detail = (await createRes.text().catch(() => "")).slice(0, 300);
    throw new AsrProviderError(
      `AssemblyAI transcript request failed (${createRes.status}): ${detail}`,
      createRes.status,
    );
  }
  const { id } = (await createRes.json()) as { id?: string };
  if (!id) throw new AsrProviderError("AssemblyAI returned no transcript id.");

  const deadline = Date.now() + POLL_DEADLINE_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const pollRes = await asrFetch(`${BASE}/transcript/${id}`, { headers });
    if (!pollRes.ok) {
      throw new AsrProviderError(`AssemblyAI polling failed (${pollRes.status}).`, pollRes.status);
    }
    const data = (await pollRes.json()) as {
      status?: string;
      text?: string | null;
      error?: string;
      words?: { start?: number; end?: number; text?: string }[];
    };
    if (data.status === "completed") {
      // AssemblyAI reports word-level timings in milliseconds already, and
      // always returns them, so timestamps cost nothing extra here — they are
      // just grouped into sentence-shaped spans on the way out.
      const segments = input.timestamps
        ? groupWordsIntoSegments(
            (data.words ?? []).map((word) => ({
              startMs: Number(word.start),
              endMs: Number(word.end),
              text: word.text ?? "",
            })),
          )
        : [];
      return {
        text: (data.text ?? "").trim(),
        provider: "assemblyai",
        model: ASSEMBLYAI_MODEL,
        ...(segments.length > 0 ? { segments } : {}),
      };
    }
    if (data.status === "error") {
      throw new AsrProviderError(`AssemblyAI transcription failed: ${data.error ?? "unknown"}`);
    }
  }
  throw new AsrProviderError("AssemblyAI transcription timed out.");
}
