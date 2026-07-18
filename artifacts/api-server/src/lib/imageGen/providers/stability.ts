import {
  imageGenFetch,
  errorDetail,
  ImageGenNotConfiguredError,
  ImageGenProviderError,
  type ImageGenInput,
  type ImageGenResult,
} from "../types";

/** Stability model = endpoint variant: core (default), ultra, or sd3. */
export const STABILITY_MODEL = "core";
const STABILITY_VARIANTS = new Set(["core", "ultra", "sd3"]);

const ASPECT_BY_SIZE: Record<ImageGenInput["size"], string> = {
  "1024x1024": "1:1",
  "1536x1024": "3:2",
  "1024x1536": "2:3",
};

/** Stability AI Stable Image API (v2beta). Returns raw image bytes. */
export async function generateWithStability(
  input: ImageGenInput,
  apiKey: string | null,
): Promise<ImageGenResult> {
  if (!apiKey) {
    throw new ImageGenNotConfiguredError(
      "Stability AI is not configured: save an API key in the admin dashboard or set the STABILITY_API_KEY secret.",
    );
  }
  const variant = STABILITY_VARIANTS.has(input.model) ? input.model : STABILITY_MODEL;

  const form = new FormData();
  form.append("prompt", input.prompt);
  form.append("output_format", "png");
  form.append("aspect_ratio", ASPECT_BY_SIZE[input.size]);

  const res = await imageGenFetch(
    `https://api.stability.ai/v2beta/stable-image/generate/${variant}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "image/*" },
      body: form,
    },
  );
  if (!res.ok) {
    throw new ImageGenProviderError(
      `Stability image generation failed (${res.status}): ${await errorDetail(res)}`,
      res.status,
    );
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length === 0) {
    throw new ImageGenProviderError("Stability returned an empty image.");
  }
  return { buffer, provider: "stability", model: variant };
}
