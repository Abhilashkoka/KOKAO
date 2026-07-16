/**
 * Minimal image-header parsing used by the Meta duplicate-post probes.
 *
 * When a publish has NO caption, the probe cannot match by text, so it falls
 * back to matching by the photo itself: the uploaded image's pixel dimensions
 * are compared against the candidate post's attachment. Meta recompresses
 * images (so byte checksums never match) and may serve a scaled-down
 * rendition, but the aspect ratio survives — hence `dimensionsCompatible`
 * accepts an exact match OR a same-aspect-ratio rendition that is not larger
 * than the original.
 *
 * Only PNG and JPEG are parsed — the formats the app stores (AI images are
 * PNG; user uploads are PNG/JPEG). Unknown formats return null and the caller
 * decides how to degrade.
 */

export type ImageDimensions = { width: number; height: number };

/** Parse width/height from a PNG or JPEG header. Returns null if unknown. */
export function getImageDimensions(bytes: Uint8Array): ImageDimensions | null {
  return parsePng(bytes) ?? parseJpeg(bytes);
}

function parsePng(b: Uint8Array): ImageDimensions | null {
  // PNG signature + IHDR chunk (always first): width/height are big-endian
  // 32-bit ints at offsets 16 and 20.
  if (b.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < sig.length; i++) if (b[i] !== sig[i]) return null;
  const width = readU32BE(b, 16);
  const height = readU32BE(b, 20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function parseJpeg(b: Uint8Array): ImageDimensions | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = b[i + 1]!;
    // Padding / standalone markers carry no length payload.
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const length = (b[i + 2]! << 8) | b[i + 3]!;
    // SOF0-SOF15 (excluding DHT/JPG/DAC pseudo-markers C4, C8, CC) carry the
    // frame dimensions: height at +5, width at +7 (big-endian 16-bit).
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isSof) {
      const height = (b[i + 5]! << 8) | b[i + 6]!;
      const width = (b[i + 7]! << 8) | b[i + 8]!;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (length < 2) return null;
    i += 2 + length;
  }
  return null;
}

function readU32BE(b: Uint8Array, offset: number): number {
  return (
    ((b[offset]! << 24) >>> 0) +
    (b[offset + 1]! << 16) +
    (b[offset + 2]! << 8) +
    b[offset + 3]!
  );
}

/**
 * Does a candidate post's reported image size plausibly correspond to the
 * image we uploaded? Exact match, or a scaled-DOWN rendition with the same
 * aspect ratio (Meta serves downscaled renditions of large uploads; it never
 * upscales). Aspect ratio is compared by cross-multiplication so there is no
 * floating-point tolerance to tune.
 */
export function dimensionsCompatible(
  expected: ImageDimensions,
  actual: ImageDimensions,
): boolean {
  if (expected.width === actual.width && expected.height === actual.height) {
    return true;
  }
  return (
    actual.width <= expected.width &&
    actual.height <= expected.height &&
    expected.width * actual.height === actual.width * expected.height
  );
}
