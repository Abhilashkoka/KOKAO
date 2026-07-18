import { generateImageBuffer } from "@workspace/integrations-openai-ai-server";
import type { ImageGenInput, ImageGenResult } from "../types";

export const OPENAI_BUILTIN_MODEL = "gpt-image-1";

/** Built-in OpenAI via the Replit integration proxy (no API key needed). */
export async function generateWithOpenAIBuiltin(
  input: ImageGenInput,
  _apiKey: string | null,
): Promise<ImageGenResult> {
  const buffer = await generateImageBuffer(input.prompt, input.size);
  return { buffer, provider: "openai", model: OPENAI_BUILTIN_MODEL };
}
