import {
  imageGenFetch,
  errorDetail,
  ImageGenNotConfiguredError,
  ImageGenProviderError,
  type ImageGenInput,
  type ImageGenResult,
} from "../types";

export const REPLICATE_MODEL = "black-forest-labs/flux-schnell";

const ASPECT_BY_SIZE: Record<ImageGenInput["size"], string> = {
  "1024x1024": "1:1",
  "1536x1024": "3:2",
  "1024x1536": "2:3",
};

interface ReplicatePrediction {
  id?: string;
  status?: string;
  output?: unknown;
  error?: unknown;
  urls?: { get?: string };
}

function firstUrl(output: unknown): string | null {
  if (typeof output === "string") return output;
  if (Array.isArray(output) && typeof output[0] === "string") return output[0];
  return null;
}

/** Replicate: create a prediction (sync-preferred), poll if needed, download the image. */
export async function generateWithReplicate(
  input: ImageGenInput,
  apiKey: string | null,
): Promise<ImageGenResult> {
  if (!apiKey) {
    throw new ImageGenNotConfiguredError(
      "Replicate is not configured: save an API token in the admin dashboard or set the REPLICATE_API_TOKEN secret.",
    );
  }
  // Model is "owner/name" (optionally with a version suffix we ignore here).
  const model = input.model.includes("/") ? input.model : REPLICATE_MODEL;
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  const res = await imageGenFetch(
    `https://api.replicate.com/v1/models/${model}/predictions`,
    {
      method: "POST",
      headers: { ...headers, Prefer: "wait=60" },
      body: JSON.stringify({
        input: { prompt: input.prompt, aspect_ratio: ASPECT_BY_SIZE[input.size] },
      }),
    },
  );
  if (!res.ok) {
    throw new ImageGenProviderError(
      `Replicate prediction failed (${res.status}): ${await errorDetail(res)}`,
      res.status,
    );
  }
  let prediction = (await res.json()) as ReplicatePrediction;

  // Poll if the sync wait did not finish it.
  const deadline = Date.now() + 90_000;
  while (
    prediction.status &&
    ["starting", "processing"].includes(prediction.status) &&
    prediction.urls?.get &&
    Date.now() < deadline
  ) {
    await new Promise((r) => setTimeout(r, 2000));
    const poll = await imageGenFetch(prediction.urls.get, { method: "GET", headers });
    if (!poll.ok) {
      throw new ImageGenProviderError(
        `Replicate polling failed (${poll.status}): ${await errorDetail(poll)}`,
        poll.status,
      );
    }
    prediction = (await poll.json()) as ReplicatePrediction;
  }

  if (prediction.status !== "succeeded") {
    const detail =
      typeof prediction.error === "string" ? prediction.error.slice(0, 300) : prediction.status;
    throw new ImageGenProviderError(`Replicate prediction did not succeed: ${detail}`);
  }
  const url = firstUrl(prediction.output);
  if (!url) {
    throw new ImageGenProviderError("Replicate returned no image URL.");
  }
  const img = await imageGenFetch(url, { method: "GET" });
  if (!img.ok) {
    throw new ImageGenProviderError(`Replicate image download failed (${img.status}).`, img.status);
  }
  const buffer = Buffer.from(await img.arrayBuffer());
  if (buffer.length === 0) {
    throw new ImageGenProviderError("Replicate returned an empty image.");
  }
  return { buffer, provider: "replicate", model };
}
