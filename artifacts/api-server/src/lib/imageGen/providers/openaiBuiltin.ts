import { openai, toFile } from "@workspace/integrations-openai-ai-server";
import { ImageGenProviderError, type ImageGenInput, type ImageGenResult } from "../types";

export const OPENAI_BUILTIN_MODEL = "gpt-image-1";

/** Extract token usage from an OpenAI images response (gpt-image-1 reports it). */
function usageFrom(response: {
  usage?: { input_tokens?: number; output_tokens?: number };
}): ImageGenResult["usage"] {
  const u = response.usage;
  if (!u) return undefined;
  return {
    inputTokens: typeof u.input_tokens === "number" ? u.input_tokens : null,
    outputTokens: typeof u.output_tokens === "number" ? u.output_tokens : null,
  };
}

/** Built-in OpenAI via the Replit integration proxy (no API key needed). */
export async function generateWithOpenAIBuiltin(
  input: ImageGenInput,
  _apiKey: string | null,
): Promise<ImageGenResult> {
  if (input.referenceImage) {
    // Image-to-image: gpt-image-1 edits keyed on the reference image.
    const ext = input.referenceImage.mimeType === "image/jpeg" ? "jpg" : "png";
    const file = await toFile(input.referenceImage.buffer, `reference.${ext}`, {
      type: input.referenceImage.mimeType,
    });
    const response = await openai.images.edit({
      model: OPENAI_BUILTIN_MODEL,
      image: file,
      prompt: input.prompt,
      size: input.size,
    });
    const b64 = response.data?.[0]?.b64_json ?? "";
    if (!b64) throw new ImageGenProviderError("OpenAI returned no image data.");
    return {
      buffer: Buffer.from(b64, "base64"),
      provider: "openai",
      model: OPENAI_BUILTIN_MODEL,
      usage: usageFrom(response),
    };
  }
  const response = await openai.images.generate({
    model: OPENAI_BUILTIN_MODEL,
    prompt: input.prompt,
    size: input.size,
  });
  const b64 = response.data?.[0]?.b64_json ?? "";
  if (!b64) throw new ImageGenProviderError("OpenAI returned no image data.");
  return {
    buffer: Buffer.from(b64, "base64"),
    provider: "openai",
    model: OPENAI_BUILTIN_MODEL,
    usage: usageFrom(response),
  };
}
