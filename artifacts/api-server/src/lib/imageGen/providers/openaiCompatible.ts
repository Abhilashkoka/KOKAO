import {
  imageGenFetch,
  errorDetail,
  ImageGenNotConfiguredError,
  ImageGenProviderError,
  type ImageGenInput,
  type ImageGenResult,
} from "../types";
import { assertPublicHost } from "../../webFetch";

/** SSRF guard: only https URLs whose host resolves to a public address. */
async function assertSafeUrl(rawUrl: string, what: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ImageGenProviderError(`${what} is not a valid URL.`);
  }
  if (url.protocol !== "https:") {
    throw new ImageGenProviderError(`${what} must use https.`);
  }
  try {
    await assertPublicHost(url.hostname);
  } catch {
    throw new ImageGenProviderError(`${what} points to a blocked or private host.`);
  }
  return url;
}

interface ImagesResponse {
  data?: Array<{ b64_json?: string; url?: string }>;
}

/**
 * Any provider exposing the OpenAI-compatible POST {baseUrl}/images/generations
 * endpoint (Together, fal.ai, Fireworks, Nebius, self-hosted, or OpenAI itself
 * with the admin's own key). Base URL and model come from the admin settings.
 */
export async function generateWithOpenAICompatible(
  input: ImageGenInput,
  apiKey: string | null,
): Promise<ImageGenResult> {
  if (!apiKey) {
    throw new ImageGenNotConfiguredError(
      "The custom image provider is not configured: save its API key in the admin dashboard.",
    );
  }
  const baseUrl = (input.baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!baseUrl) {
    throw new ImageGenNotConfiguredError(
      "The custom image provider needs a base URL (for example https://api.example.com/v1). Set it in the admin dashboard.",
    );
  }
  if (!/^https:\/\//i.test(baseUrl)) {
    throw new ImageGenNotConfiguredError("The custom provider base URL must start with https://");
  }
  if (!input.model) {
    throw new ImageGenNotConfiguredError(
      "The custom image provider needs a model name. Set it in the admin dashboard.",
    );
  }

  const endpoint = await assertSafeUrl(`${baseUrl}/images/generations`, "The custom provider base URL");
  const res = await imageGenFetch(endpoint.toString(), {
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
    }),
  });
  if (!res.ok) {
    throw new ImageGenProviderError(
      `Custom provider image generation failed (${res.status}): ${await errorDetail(res)}`,
      res.status,
    );
  }
  const data = (await res.json()) as ImagesResponse;
  const first = data.data?.[0];
  if (first?.b64_json) {
    return {
      buffer: Buffer.from(first.b64_json, "base64"),
      provider: "custom",
      model: input.model,
    };
  }
  // Some OpenAI-compatible servers only return a hosted URL.
  if (first?.url && /^https:\/\//i.test(first.url)) {
    const imageUrl = await assertSafeUrl(first.url, "The provider's image URL");
    const img = await imageGenFetch(imageUrl.toString(), {
      method: "GET",
      redirect: "manual",
    });
    if (!img.ok) {
      throw new ImageGenProviderError(
        `Custom provider image download failed (${img.status}).`,
        img.status,
      );
    }
    return {
      buffer: Buffer.from(await img.arrayBuffer()),
      provider: "custom",
      model: input.model,
    };
  }
  throw new ImageGenProviderError("Custom provider returned no image data.");
}
