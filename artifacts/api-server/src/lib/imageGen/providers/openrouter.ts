import {
  imageGenFetch,
  errorDetail,
  ImageGenNotConfiguredError,
  ImageGenProviderError,
  type ImageGenInput,
  type ImageGenResult,
} from "../types";

export const OPENROUTER_IMAGE_MODEL = "google/gemini-2.5-flash-image";

interface OpenRouterImageResponse {
  data?: Array<{
    b64_json?: string;
    media_type?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

function bufferFromBase64(value: string | undefined): Buffer | null {
  if (!value) return null;
  try {
    const buffer = Buffer.from(value, "base64");
    return buffer.length > 0 ? buffer : null;
  } catch {
    return null;
  }
}

/**
 * OpenRouter image generation uses the dedicated Images API. The response
 * contains raw base64 image bytes in `data[].b64_json`.
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

  const aspectRatio =
    input.size === "1024x1024"
      ? "1:1"
      : input.size === "1536x1024"
        ? "3:2"
        : "2:3";

  const res = await imageGenFetch("https://openrouter.ai/api/v1/images", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: input.model,
      prompt: input.prompt,
      aspect_ratio: aspectRatio,
      n: 1,
      ...(input.referenceImage
        ? {
            input_references: [
              {
                type: "image_url",
                image_url: {
                  url: `data:${input.referenceImage.mimeType};base64,${input.referenceImage.buffer.toString("base64")}`,
                },
              },
            ],
          }
        : {}),
    }),
  });
  if (!res.ok) {
    throw new ImageGenProviderError(
      `OpenRouter image generation failed (${res.status}): ${await errorDetail(res)}`,
      res.status,
    );
  }
  const data = (await res.json()) as OpenRouterImageResponse;
  const buffer = bufferFromBase64(data.data?.find((item) => item.b64_json)?.b64_json);
  if (!buffer) {
    throw new ImageGenProviderError(
      "OpenRouter returned no image data. Make sure the selected model supports image output.",
    );
  }
  const usage = data.usage
    ? {
        inputTokens:
          typeof data.usage.prompt_tokens === "number" ? data.usage.prompt_tokens : null,
        outputTokens:
          typeof data.usage.completion_tokens === "number"
            ? data.usage.completion_tokens
            : null,
      }
    : undefined;
  return { buffer, provider: "openrouter", model: input.model, usage };
}
