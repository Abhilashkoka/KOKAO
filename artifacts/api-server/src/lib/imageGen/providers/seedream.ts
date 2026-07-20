import {
  imageGenFetch,
  errorDetail,
  ImageGenNotConfiguredError,
  ImageGenProviderError,
  type ImageGenInput,
  type ImageGenResult,
} from "../types";
import { assertPublicHost } from "../../webFetch";

export const SEEDREAM_MODEL = "seedream-5-0-pro";

const ARK_IMAGES_ENDPOINT = "https://ark.ap-southeast.bytepluses.com/api/v3/images/generations";

interface ArkImagesResponse {
  data?: Array<{ b64_json?: string; url?: string }>;
  error?: { message?: string };
}

async function assertSafeImageUrl(rawUrl: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ImageGenProviderError("Seedream returned an invalid image URL.");
  }
  if (url.protocol !== "https:") {
    throw new ImageGenProviderError("Seedream returned a non-https image URL.");
  }
  try {
    await assertPublicHost(url.hostname);
  } catch {
    throw new ImageGenProviderError("Seedream returned an image URL on a blocked or private host.");
  }
  return url.toString();
}

/**
 * ByteDance Seedream models via the BytePlus ModelArk API. The endpoint is
 * OpenAI-compatible (POST /images/generations with Bearer auth); watermarking
 * is disabled explicitly. Prefers inline base64 but handles URL-only replies.
 */
export async function generateWithSeedream(
  input: ImageGenInput,
  apiKey: string | null,
): Promise<ImageGenResult> {
  if (!apiKey) {
    throw new ImageGenNotConfiguredError(
      "ByteDance Seedream is not configured: save an API key in the admin dashboard or set the ARK_API_KEY secret.",
    );
  }
  const res = await imageGenFetch(ARK_IMAGES_ENDPOINT, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: input.model,
      prompt: input.prompt,
      size: input.size,
      response_format: "b64_json",
      n: 1,
      watermark: false,
    }),
  });
  if (!res.ok) {
    throw new ImageGenProviderError(
      `Seedream image generation failed (${res.status}): ${await errorDetail(res)}`,
      res.status,
    );
  }
  const data = (await res.json()) as ArkImagesResponse;
  const first = data.data?.[0];
  if (first?.b64_json) {
    return {
      buffer: Buffer.from(first.b64_json, "base64"),
      provider: "seedream",
      model: input.model,
    };
  }
  if (first?.url && /^https:\/\//i.test(first.url)) {
    const imageUrl = await assertSafeImageUrl(first.url);
    const img = await imageGenFetch(imageUrl, { method: "GET", redirect: "manual" });
    if (!img.ok) {
      throw new ImageGenProviderError(
        `Seedream image download failed (${img.status}).`,
        img.status,
      );
    }
    return {
      buffer: Buffer.from(await img.arrayBuffer()),
      provider: "seedream",
      model: input.model,
    };
  }
  throw new ImageGenProviderError("Seedream returned no image data.");
}
