import sharp from "sharp";
import { openai, toFile } from "@workspace/integrations-openai-ai-server";
import type { Tenant } from "@workspace/db";
import { ImageGenProviderError } from "./imageGen";
import { OPENAI_BUILTIN_MODEL } from "./imageGen/providers/openaiBuiltin";
import { loadReferenceImage, ReferenceImageError } from "./referenceGuide";
import { applyMadeWithWatermark } from "./watermark";
import { getPlan } from "./plans";
import { isFeatureEnabled } from "./featureFlags";
import { uploadBufferToStorage } from "./storageUpload";
import { buildImageCostMeta } from "./aiCost";
import type { UsageMeta } from "./usage";

/**
 * Mask-based AI image editing (inpainting) for the web image editor.
 *
 * Deliberately narrower than the generation pipeline: it always uses the
 * built-in OpenAI provider (gpt-image-1 images.edit is the only routed
 * provider with first-class mask support), so there is no provider routing,
 * no design-skill pass, and no reference-guide pass. Funding is NOT handled
 * here — the route reserves before and settles/releases after, exactly like
 * image generation.
 *
 * Mask semantics follow OpenAI: a PNG the same size as the source where
 * TRANSPARENT pixels mark the region to regenerate; opaque pixels are kept.
 */

/** Hard cap on the decoded mask (matches the reference-image cap). */
export const MAX_MASK_BYTES = 10 * 1024 * 1024;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

export class ImageEditInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageEditInputError";
  }
}

export interface ImageEditInput {
  tenantId: number;
  tenant: Tenant;
  /** Tenant-owned /objects/... path of the source image. Pre-validated by the caller via loadSourceImage. */
  sourceBuffer: Buffer;
  sourceMimeType: string;
  maskB64: string;
  prompt: string;
}

export interface ImageEditOutcome {
  imagePath: string;
  b64Json: string;
  meta: Omit<UsageMeta, "funding">;
}

/**
 * Load and tenant-validate the source image. Throws ReferenceImageError with
 * a user-safe message on any ownership/type/size problem (the loader asserts
 * the /objects/<tenantId>/ prefix, so foreign paths 404 into "not found").
 */
export async function loadSourceImage(objectPath: string, tenantId: number) {
  return loadReferenceImage(objectPath, tenantId);
}

/** Decode + sanity-check the mask (base64 PNG, bounded size). */
export function decodeMask(maskB64: string): Buffer {
  let mask: Buffer;
  try {
    mask = Buffer.from(maskB64, "base64");
  } catch {
    throw new ImageEditInputError("The mask is not valid base64 data.");
  }
  if (mask.length === 0) {
    throw new ImageEditInputError("The mask is empty.");
  }
  if (mask.length > MAX_MASK_BYTES) {
    throw new ImageEditInputError("The mask is too large. Please use a mask under 10 MB.");
  }
  if (!mask.subarray(0, 4).equals(PNG_MAGIC)) {
    throw new ImageEditInputError("The mask must be a PNG image.");
  }
  return mask;
}

/**
 * Assert the decoded mask's pixel dimensions match the source image's.
 * OpenAI's images.edit rejects mismatched masks anyway, but only AFTER the
 * route has reserved funding — so the route calls this before reserving to
 * fail fast with a clear 400 instead.
 *
 * Strict on the mask (an undecodable "PNG" is a client error); fail-open on
 * the source (it was already tenant/type/size-validated by the loader, and
 * blocking an exotic-but-valid source here would be a regression).
 */
export async function assertMaskMatchesSource(mask: Buffer, sourceBuffer: Buffer): Promise<void> {
  let maskMeta: { width?: number; height?: number };
  try {
    maskMeta = await sharp(mask).metadata();
  } catch {
    throw new ImageEditInputError("The mask must be a valid PNG image.");
  }
  if (typeof maskMeta.width !== "number" || typeof maskMeta.height !== "number") {
    throw new ImageEditInputError("The mask must be a valid PNG image.");
  }

  let srcMeta: { width?: number; height?: number };
  try {
    srcMeta = await sharp(sourceBuffer).metadata();
  } catch {
    return;
  }
  if (typeof srcMeta.width !== "number" || typeof srcMeta.height !== "number") {
    return;
  }

  if (maskMeta.width !== srcMeta.width || maskMeta.height !== srcMeta.height) {
    throw new ImageEditInputError(
      `The mask must be the same size as the image (image is ${srcMeta.width}\u00d7${srcMeta.height}, mask is ${maskMeta.width}\u00d7${maskMeta.height}). Please redraw the mask and try again.`,
    );
  }
}

/** Run the edit end-to-end. Throws provider/upload errors to the caller. */
export async function performImageEdit(input: ImageEditInput): Promise<ImageEditOutcome> {
  const startedAt = Date.now();
  const mask = decodeMask(input.maskB64);

  const ext = input.sourceMimeType === "image/jpeg" ? "jpg" : "png";
  const [imageFile, maskFile] = await Promise.all([
    toFile(input.sourceBuffer, `source.${ext}`, { type: input.sourceMimeType }),
    toFile(mask, "mask.png", { type: "image/png" }),
  ]);

  const response = await openai.images.edit({
    model: OPENAI_BUILTIN_MODEL,
    image: imageFile,
    mask: maskFile,
    prompt: input.prompt,
  });
  const b64 = response.data?.[0]?.b64_json ?? "";
  if (!b64) throw new ImageGenProviderError("OpenAI returned no image data.");
  const rawBuffer = Buffer.from(b64, "base64");

  // Same per-plan watermark contract as performImageGeneration: plan switch
  // ON + platform kill switch ON (both fail soft/open respectively).
  const wantWatermark =
    (await getPlan(input.tenant.plan).catch(() => null))?.watermark === true &&
    (await isFeatureEnabled("freeWatermark").catch(() => true));
  const buffer = wantWatermark ? await applyMadeWithWatermark(rawBuffer) : rawBuffer;

  const imagePath = await uploadBufferToStorage(input.tenantId, buffer, "image/png");
  const b64Json = buffer.toString("base64");

  const usage = (response as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
  return {
    imagePath,
    b64Json,
    meta: {
      requestBytes: Buffer.byteLength(input.prompt) + input.sourceBuffer.length + mask.length,
      responseBytes: buffer.length + Buffer.byteLength(b64Json),
      durationMs: Date.now() - startedAt,
      model: OPENAI_BUILTIN_MODEL,
      ...(await buildImageCostMeta({
        provider: "openai",
        model: OPENAI_BUILTIN_MODEL,
        usage: usage
          ? {
              inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : null,
              outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : null,
            }
          : undefined,
      })),
    },
  };
}

export { ReferenceImageError };
