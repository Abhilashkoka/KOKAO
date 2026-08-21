import { openai, toFile } from "@workspace/integrations-openai-ai-server";
import { normalizeSegments, secondsToMs } from "../segments";
import { AsrProviderError, type TranscribeInput, type TranscriptionResult } from "../types";

export const OPENAI_ASR_MODEL = "whisper-1";

/** OpenAI Whisper via the existing Replit AI integration proxy (no extra key). */
export async function transcribeWithOpenAI(
  input: TranscribeInput,
  _apiKey: string | null,
): Promise<TranscriptionResult> {
  try {
    const file = await toFile(input.buffer, input.filename, { type: input.mimeType });
    const result = (await openai.audio.transcriptions.create({
      file,
      model: OPENAI_ASR_MODEL,
      // verbose_json is the only Whisper format carrying segment timings.
      response_format: input.timestamps ? "verbose_json" : "json",
    })) as { text: string; segments?: { start?: number; end?: number; text?: string }[] };
    const segments = input.timestamps
      ? normalizeSegments(
          (result.segments ?? []).map((segment) => ({
            startMs: secondsToMs(segment.start),
            endMs: secondsToMs(segment.end),
            text: segment.text ?? "",
          })),
        )
      : [];
    return {
      text: result.text.trim(),
      provider: "openai",
      model: OPENAI_ASR_MODEL,
      ...(segments.length > 0 ? { segments } : {}),
    };
  } catch (err) {
    if (err instanceof AsrProviderError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new AsrProviderError(`OpenAI transcription failed: ${message}`);
  }
}
