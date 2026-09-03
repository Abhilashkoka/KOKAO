import { assertPublicHost } from "../../webFetch";
import {
  errorDetail,
  imageGenFetch,
  ImageGenNotConfiguredError,
  ImageGenProviderError,
  type ImageGenInput,
  type ImageGenResult,
} from "../types";

const HIGGSFIELD_BASE_URL = "https://api.higgsfield.ai";
export const HIGGSFIELD_IMAGE_MODEL = "higgsfield-ai/soul/v2/standard";
const POLL_INTERVAL_MS = 2_000;
const MAX_POLLS = 60;

interface HiggsfieldStatus {
  status?: string;
  request_id?: string;
  status_url?: string;
  error?: string | null;
  images?: Array<{ url?: string }>;
}

function requestedAspect(size: ImageGenInput["size"]): string {
  if (size === "1536x1024") return "landscape 3:2";
  if (size === "1024x1536") return "portrait 2:3";
  return "square 1:1";
}

export function higgsfieldImageRequestBody(input: ImageGenInput): Record<string, unknown> {
  return {
    prompt: `${input.prompt}\n\nCompose the final image in a ${requestedAspect(input.size)} aspect ratio.`,
  };
}

export function higgsfieldImageTerminalState(
  status: string | undefined,
): "done" | "failed" | null {
  const value = (status ?? "").toLowerCase();
  if (value === "completed") return "done";
  if (["failed", "nsfw", "canceled", "cancelled"].includes(value)) return "failed";
  return null;
}

async function safeHiggsfieldUrl(raw: string, description: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ImageGenProviderError(`${description} is not a valid URL.`);
  }
  if (url.protocol !== "https:") {
    throw new ImageGenProviderError(`${description} must use https.`);
  }
  try {
    await assertPublicHost(url.hostname);
  } catch {
    throw new ImageGenProviderError(`${description} points to a blocked or private host.`);
  }
  return url.toString();
}

export async function generateWithHiggsfield(
  input: ImageGenInput,
  apiKey: string | null,
): Promise<ImageGenResult> {
  if (!apiKey) {
    throw new ImageGenNotConfiguredError(
      "Higgsfield is not configured: save an API key in the admin dashboard or set the HIGGSFIELD_API_KEY secret.",
    );
  }
  if (input.model !== HIGGSFIELD_IMAGE_MODEL) {
    throw new ImageGenProviderError("Unsupported Higgsfield image model.");
  }

  const headers = {
    Authorization: `Key ${apiKey}`,
    "Content-Type": "application/json",
  };
  const submit = await imageGenFetch(`${HIGGSFIELD_BASE_URL}/${input.model}`, {
    method: "POST",
    headers,
    body: JSON.stringify(higgsfieldImageRequestBody(input)),
  });
  if (!submit.ok) {
    throw new ImageGenProviderError(
      `Higgsfield image generation failed (${submit.status}): ${await errorDetail(submit)}`,
      submit.status,
    );
  }

  let status = (await submit.json()) as HiggsfieldStatus;
  const statusUrl = status.status_url ??
    (status.request_id
      ? `${HIGGSFIELD_BASE_URL}/requests/${status.request_id}/status`
      : null);
  if (!statusUrl) {
    throw new ImageGenProviderError("Higgsfield returned no request id to poll.");
  }
  const safeStatusUrl = await safeHiggsfieldUrl(statusUrl, "The Higgsfield status URL");

  for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
    const terminal = higgsfieldImageTerminalState(status.status);
    if (terminal === "done") {
      const outputUrl = status.images?.find((image) => image.url)?.url;
      if (!outputUrl) {
        throw new ImageGenProviderError("Higgsfield finished but returned no image URL.");
      }
      const safeOutputUrl = await safeHiggsfieldUrl(outputUrl, "The Higgsfield image URL");
      const output = await imageGenFetch(safeOutputUrl, {
        method: "GET",
        redirect: "manual",
      });
      if (!output.ok) {
        throw new ImageGenProviderError(
          `Higgsfield image download failed (${output.status}).`,
          output.status,
        );
      }
      return {
        buffer: Buffer.from(await output.arrayBuffer()),
        provider: "higgsfield",
        model: input.model,
      };
    }
    if (terminal === "failed") {
      throw new ImageGenProviderError(
        `Higgsfield image generation failed: ${status.error ?? status.status ?? "unknown error"}`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const poll = await imageGenFetch(safeStatusUrl, {
      method: "GET",
      headers,
      redirect: "manual",
    });
    if (!poll.ok) {
      throw new ImageGenProviderError(
        `Higgsfield image status check failed (${poll.status}): ${await errorDetail(poll)}`,
        poll.status,
      );
    }
    status = (await poll.json()) as HiggsfieldStatus;
  }

  throw new ImageGenProviderError("Higgsfield image generation timed out.");
}