import { openai, toFile } from "@workspace/integrations-openai-ai-server";
import { AsrProviderError, type TranscribeInput, type TranscriptionResult } from "../types";

export const OPENAI_ASR_MODEL = "whisper-1";

/** OpenAI Whisper via the existing Replit AI integration proxy (no extra key). */
export async function transcribeWithOpenAI(
  input: TranscribeInput,
  _apiKey: string | null,
): Promise<TranscriptionResult> {
  try {
    const file = await toFile(input.buffer, input.filename, { type: input.mimeType });
    const result = await openai.audio.transcriptions.create({
      file,
      model: OPENAI_ASR_MODEL,
      response_format: "json",
    });
    return { text: result.text.trim(), provider: "openai", model: OPENAI_ASR_MODEL };
  } catch (err) {
    if (err instanceof AsrProviderError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new AsrProviderError(`OpenAI transcription failed: ${message}`);
  }
}
