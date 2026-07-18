import {
  imageGenFetch,
  errorDetail,
  ImageGenNotConfiguredError,
  ImageGenProviderError,
  type ImageGenInput,
  type ImageGenResult,
} from "../types";
import { assertPublicHost } from "../../webFetch";

export const BFL_MODEL = "flux-2-pro";

/** Model ids double as BFL endpoint names; only allow known-safe path segments. */
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9.-]{0,63}$/;

interface BflSubmitResponse {
  id?: string;
  polling_url?: string;
}

interface BflPollResponse {
  status?: string;
  result?: { sample?: string };
}

const POLL_INTERVAL_MS = 1500;
const MAX_POLLS = 60;

async function assertSafeBflUrl(rawUrl: string, what: string): Promise<string> {
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
  return url.toString();
}

/**
 * Black Forest Labs FLUX models via the official BFL API.
 * Submit returns a polling URL; we poll until the image is ready, then
 * download the (short-lived) result URL. The model id is the endpoint name
 * (flux-2-pro, flux-pro-1.1, flux-pro-1.1-ultra, flux-dev, ...).
 */
export async function generateWithBfl(
  input: ImageGenInput,
  apiKey: string | null,
): Promise<ImageGenResult> {
  if (!apiKey) {
    throw new ImageGenNotConfiguredError(
      "Black Forest Labs (FLUX) is not configured: save an API key in the admin dashboard or set the BFL_API_KEY secret.",
    );
  }
  const model = input.model.trim().toLowerCase();
  if (!MODEL_ID_PATTERN.test(model)) {
    throw new ImageGenProviderError("Invalid FLUX model name.");
  }

  const [wStr, hStr] = input.size.split("x");
  const width = Number(wStr) || 1024;
  const height = Number(hStr) || 1024;

  const submit = await imageGenFetch(`https://api.bfl.ai/v1/${model}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-key": apiKey,
    },
    body: JSON.stringify({ prompt: input.prompt, width, height }),
  });
  if (!submit.ok) {
    throw new ImageGenProviderError(
      `FLUX image generation failed (${submit.status}): ${await errorDetail(submit)}`,
      submit.status,
    );
  }
  const submitted = (await submit.json()) as BflSubmitResponse;
  if (!submitted.polling_url) {
    throw new ImageGenProviderError("FLUX did not return a polling URL.");
  }
  const pollingUrl = await assertSafeBflUrl(submitted.polling_url, "The FLUX polling URL");

  for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const poll = await imageGenFetch(pollingUrl, {
      method: "GET",
      headers: { "x-key": apiKey },
      redirect: "manual",
    });
    if (!poll.ok) {
      throw new ImageGenProviderError(
        `FLUX status check failed (${poll.status}): ${await errorDetail(poll)}`,
        poll.status,
      );
    }
    const data = (await poll.json()) as BflPollResponse;
    const status = (data.status ?? "").toLowerCase();
    if (status === "ready") {
      const sample = data.result?.sample;
      if (!sample) {
        throw new ImageGenProviderError("FLUX finished but returned no image URL.");
      }
      const imageUrl = await assertSafeBflUrl(sample, "The FLUX image URL");
      const img = await imageGenFetch(imageUrl, { method: "GET", redirect: "manual" });
      if (!img.ok) {
        throw new ImageGenProviderError(`FLUX image download failed (${img.status}).`, img.status);
      }
      return { buffer: Buffer.from(await img.arrayBuffer()), provider: "bfl", model };
    }
    if (
      status === "error" ||
      status === "failed" ||
      status === "content moderated" ||
      status === "request moderated" ||
      status === "task not found"
    ) {
      throw new ImageGenProviderError(`FLUX generation failed: ${data.status}`);
    }
    // Otherwise still pending/processing; keep polling.
  }
  throw new ImageGenProviderError("FLUX generation timed out while waiting for the result.");
}
