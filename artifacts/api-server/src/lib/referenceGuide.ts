import { openai } from "@workspace/integrations-openai-ai-server";
import { ObjectStorageService, ObjectNotFoundError } from "./objectStorage";
import type { ReferenceImage } from "./imageGen";
import { logger } from "./logger";

/**
 * Reference-image support for AI Studio image generation.
 *
 * Two layers:
 *  1. A vision pass analyzes the tenant-uploaded reference image into a short
 *     text "reference guide" merged into the image prompt (works with every
 *     provider). Fails soft: on any error the generation proceeds without it.
 *  2. Providers that support image input additionally receive the raw image
 *     (see supportsImageInput in the imageGen catalog).
 */

/** Hard cap on reference image size (bytes) — keeps vision + provider payloads sane. */
export const MAX_REFERENCE_IMAGE_BYTES = 10 * 1024 * 1024;

/** Image types we accept as references (what vision + providers understand). */
const ALLOWED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export class ReferenceImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReferenceImageError";
  }
}

const objectStorageService = new ObjectStorageService();

/**
 * Load a tenant's uploaded reference image from object storage. The path is
 * attacker-influenceable, so it funnels through getObjectEntityFile which
 * asserts the `/objects/<tenantId>/` prefix (404 on mismatch).
 */
export async function loadReferenceImage(
  objectPath: string,
  tenantId: number,
): Promise<ReferenceImage> {
  let file;
  try {
    file = await objectStorageService.getObjectEntityFile(objectPath, tenantId);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      throw new ReferenceImageError("Reference image not found.");
    }
    throw err;
  }

  const [metadata] = await file.getMetadata();
  const size = Number(metadata.size ?? 0);
  if (size > MAX_REFERENCE_IMAGE_BYTES) {
    throw new ReferenceImageError(
      "Reference image is too large. Please use an image under 10 MB.",
    );
  }
  const rawType = String(metadata.contentType ?? "").toLowerCase().split(";")[0].trim();
  const mimeType = rawType === "image/jpg" ? "image/jpeg" : rawType;
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    throw new ReferenceImageError(
      "Unsupported reference image type. Please use a PNG, JPEG, or WebP image.",
    );
  }

  const [buffer] = await file.download();
  return { buffer, mimeType };
}

const REFERENCE_GUIDE_SYSTEM = `You are an art director. You will be shown a reference image a user uploaded to guide an AI image generation. Describe, in a compact style guide of at most 120 words, the visual elements the generated image should take from this reference: overall style and mood, color palette (with approximate color names), lighting, composition and framing, textures, and any distinctive artistic techniques. Do NOT describe the literal subject or objects in the image unless they are clearly stylistic elements. Output plain prose only, no headings or lists.`;

/**
 * Vision pass: turn the reference image into a short textual style guide.
 * Fails soft — returns null on any error so generation continues without it.
 */
export async function buildReferenceGuide(options: {
  model: string;
  image: ReferenceImage;
}): Promise<string | null> {
  try {
    const dataUrl = `data:${options.image.mimeType};base64,${options.image.buffer.toString("base64")}`;
    const completion = await openai.chat.completions.create({
      model: options.model,
      messages: [
        { role: "system", content: REFERENCE_GUIDE_SYSTEM },
        {
          role: "user",
          content: [
            { type: "text", text: "Analyze this reference image." },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
      max_completion_tokens: 1024,
    });
    const guide = completion.choices[0]?.message?.content?.trim();
    return guide || null;
  } catch (err) {
    logger.error({ err }, "Reference image analysis failed; continuing without guide");
    return null;
  }
}
