import { openai, toFile } from "@workspace/integrations-openai-ai-server";
import sharp from "sharp";
import { ImageGenOutputValidationError, ImageGenProviderError, type ImageGenInput, type ImageGenResult } from "../types";

export const OPENAI_BUILTIN_MODEL = "gpt-image-2";

/** Keep modality counts: GPT Image 2 charges text and image inputs differently. */
function usageFrom(response: {
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { text_tokens?: number; image_tokens?: number };
  };
}): ImageGenResult["usage"] {
  const u = response.usage;
  if (!u) return undefined;
  return {
    inputTokens: typeof u.input_tokens === "number" ? u.input_tokens : null,
    outputTokens: typeof u.output_tokens === "number" ? u.output_tokens : null,
    inputTokenDetails: u.input_tokens_details,
  };
}

async function imageBuffer(
  b64: string | undefined,
  model: string,
  usage: ImageGenResult["usage"],
  transparent?: boolean,
): Promise<Buffer> {
  if (!b64) throw new ImageGenProviderError("OpenAI returned no image data.");
  const buffer = Buffer.from(b64, "base64");
  // GPT Image 2 transparency is preview functionality. Never silently return
  // an opaque asset when an account/proxy does not support it.
  if (transparent) {
    const stats = await sharp(buffer).stats();
    if (stats.isOpaque) {
      throw new ImageGenOutputValidationError(
        "OpenAI did not return the requested transparent image. GPT Image 2 transparency is in preview.",
        { buffer, model, provider: "openai", usage },
      );
    }
  }
  return buffer;
}

/** Built-in OpenAI via the Replit integration proxy (no API key needed). */
export async function generateWithOpenAIBuiltin(
  input: ImageGenInput,
  _apiKey: string | null,
): Promise<ImageGenResult> {
  // Explicit legacy selections are consent-bound snapshots, not defaults to
  // upgrade. Never report one model while sending another.
  const model = input.model || OPENAI_BUILTIN_MODEL;
  if (model !== OPENAI_BUILTIN_MODEL && model !== "gpt-image-1") {
    throw new ImageGenProviderError(`Unsupported built-in OpenAI image model: ${model}`);
  }
  const output = {
    output_format: "png" as const,
    ...(input.transparent ? { background: "transparent" as const } : {}),
  };
  if (input.editMask && !input.referenceImage) {
    throw new ImageGenProviderError("An image edit mask requires a reference image.");
  }
  if (input.editMask && input.editMask.buffer.length >= 4 * 1024 * 1024) {
    throw new ImageGenProviderError("OpenAI image edit masks must be smaller than 4 MB.");
  }
  if (input.referenceImage) {
    // Image 2 automatically uses high input fidelity; do not send input_fidelity.
    const ext = input.referenceImage.mimeType === "image/jpeg" ? "jpg" : input.referenceImage.mimeType === "image/webp" ? "webp" : "png";
    const [file, mask] = await Promise.all([
      toFile(input.referenceImage.buffer, `reference.${ext}`, {
        type: input.referenceImage.mimeType,
      }),
      input.editMask
        ? toFile(input.editMask.buffer, "mask.png", { type: "image/png" })
        : Promise.resolve(undefined),
    ]);
    const response = await openai.images.edit({
      model,
      ...output,
      image: file,
      ...(mask ? { mask } : {}),
      prompt: input.prompt,
      size: input.size,
    });
    return {
      buffer: await imageBuffer(response.data?.[0]?.b64_json, model, usageFrom(response), input.transparent),
      provider: "openai",
      model,
      usage: usageFrom(response),
    };
  }
  const response = await openai.images.generate({
    model,
    prompt: input.prompt,
    size: input.size,
    ...output,
  });
  return {
    buffer: await imageBuffer(response.data?.[0]?.b64_json, model, usageFrom(response), input.transparent),
    provider: "openai",
    model,
    usage: usageFrom(response),
  };
}
