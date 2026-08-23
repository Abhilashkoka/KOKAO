import sharp from "sharp";
import { createHash } from "node:crypto";

/**
 * A deliberately conservative threshold: identical frames score 0, while
 * clearly different real storyboard shots typically score well above 0.15.
 * Keeping this low catches provider repeats without rejecting the same
 * recurring character in genuinely different compositions.
 */
export const NEAR_DUPLICATE_IMAGE_THRESHOLD = 0.08;

const FINGERPRINT_SIZE = 32;

/** Reduce an image to a small normalized luminance map for cheap comparisons. */
export async function imageFingerprint(image: Buffer): Promise<Buffer> {
  try {
    return await sharp(image)
      .rotate()
      .flatten({ background: "#ffffff" })
      .resize(FINGERPRINT_SIZE, FINGERPRINT_SIZE, { fit: "fill" })
      .greyscale()
      .raw()
      .toBuffer();
  } catch {
    // Provider results should be decodable images, but exact-byte detection is
    // still useful for test doubles and for any malformed payload that reaches
    // this layer before its eventual provider-format validation.
    return createHash("sha256").update(image).digest();
  }
}

/** Normalized mean absolute pixel difference: 0 = identical, 1 = opposite. */
export function imageFingerprintDifference(left: Buffer, right: Buffer): number {
  if (left.length !== right.length || left.length === 0) return 1;
  let total = 0;
  for (let index = 0; index < left.length; index += 1) {
    total += Math.abs(left[index]! - right[index]!);
  }
  return total / (left.length * 255);
}

export function matchesPriorImage(
  candidate: Buffer,
  prior: readonly Buffer[],
  threshold = NEAR_DUPLICATE_IMAGE_THRESHOLD,
): boolean {
  return prior.some(
    (existing) => imageFingerprintDifference(candidate, existing) <= threshold,
  );
}