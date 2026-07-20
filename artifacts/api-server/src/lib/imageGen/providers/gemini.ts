import {
  imageGenFetch,
  errorDetail,
  ImageGenNotConfiguredError,
  ImageGenProviderError,
  type ImageGenInput,
  type ImageGenResult,
} from "../types";

export const GEMINI_IMAGE_MODEL = "gemini-2.5-flash-image";

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ inlineData?: { data?: string } }> };
  }>;
}

/** Google Gemini image generation (Generative Language API). */
export async function generateWithGemini(
  input: ImageGenInput,
  apiKey: string | null,
): Promise<ImageGenResult> {
  if (!apiKey) {
    throw new ImageGenNotConfiguredError(
      "Google Gemini is not configured: save an API key in the admin dashboard or set the GEMINI_API_KEY secret.",
    );
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:generateContent`;
  const res = await imageGenFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            // Reference image (image-to-image) goes first so the model treats
            // it as the visual anchor for the text instruction that follows.
            ...(input.referenceImage
              ? [
                  {
                    inlineData: {
                      mimeType: input.referenceImage.mimeType,
                      data: input.referenceImage.buffer.toString("base64"),
                    },
                  },
                ]
              : []),
            { text: input.prompt },
          ],
        },
      ],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
    }),
  });
  if (!res.ok) {
    throw new ImageGenProviderError(
      `Gemini image generation failed (${res.status}): ${await errorDetail(res)}`,
      res.status,
    );
  }
  const data = (await res.json()) as GeminiResponse;
  const b64 = data.candidates
    ?.flatMap((c) => c.content?.parts ?? [])
    .find((p) => p.inlineData?.data)?.inlineData?.data;
  if (!b64) {
    throw new ImageGenProviderError("Gemini returned no image data.");
  }
  return { buffer: Buffer.from(b64, "base64"), provider: "gemini", model: input.model };
}
