import {
  imageGenFetch,
  errorDetail,
  ImageGenNotConfiguredError,
  ImageGenProviderError,
  type ImageGenInput,
  type ImageGenResult,
} from "../types";

export const OPENROUTER_IMAGE_MODEL = "google/gemini-2.5-flash-image";

interface OpenRouterChatResponse {
  choices?: Array<{
    message?: {
      images?: Array<{ image_url?: { url?: string } }>;
    };
  }>;
}

/** Parse a data URL ("data:image/png;base64,....") into a Buffer. */
function bufferFromDataUrl(url: string): Buffer | null {
  const match = /^data:[^;,]+;base64,(.+)$/.exec(url);
  if (!match) return null;
  try {
    return Buffer.from(match[1]!, "base64");
  } catch {
    return null;
  }
}

/**
 * OpenRouter image generation: image-output models are served through the
 * chat completions endpoint with `modalities: ["image", "text"]`; the result
 * comes back as a base64 data URL in `message.images`.
 */
export async function generateWithOpenRouter(
  input: ImageGenInput,
  apiKey: string | null,
): Promise<ImageGenResult> {
  if (!apiKey) {
    throw new ImageGenNotConfiguredError(
      "OpenRouter is not configured: save an API key in the admin dashboard or set the OPENROUTER_API_KEY secret.",
    );
  }

  // OpenRouter has no size parameter; steer the aspect ratio via the prompt.
  const aspect =
    input.size === "1024x1024"
      ? "a square (1:1) image"
      : input.size === "1536x1024"
        ? "a landscape (3:2) image"
        : "a portrait (2:3) image";
  const promptText = `${input.prompt}\n\nGenerate ${aspect}.`;

  const content: Array<Record<string, unknown>> = [];
  if (input.referenceImage) {
    content.push({
      type: "image_url",
      image_url: {
        url: `data:${input.referenceImage.mimeType};base64,${input.referenceImage.buffer.toString("base64")}`,
      },
    });
  }
  content.push({ type: "text", text: promptText });

  const res = await imageGenFetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: input.model,
      messages: [{ role: "user", content }],
      modalities: ["image", "text"],
      // OpenRouter otherwise applies the model's full text-output ceiling
      // (currently tens of thousands of tokens) to its affordability check.
      // We consume only message.images; reserve the minimum possible text
      // output so a healthy image request is not rejected for unused text
      // capacity when the provider account is low.
      max_tokens: 1,
    }),
  });
  if (!res.ok) {
    throw new ImageGenProviderError(
      `OpenRouter image generation failed (${res.status}): ${await errorDetail(res)}`,
      res.status,
    );
  }
  const data = (await res.json()) as OpenRouterChatResponse;
  const url = data.choices?.[0]?.message?.images?.find((i) => i.image_url?.url)?.image_url?.url;
  const buffer = url ? bufferFromDataUrl(url) : null;
  if (!buffer) {
    throw new ImageGenProviderError(
      "OpenRouter returned no image data. Make sure the selected model supports image output.",
    );
  }
  return { buffer, provider: "openrouter", model: input.model };
}
