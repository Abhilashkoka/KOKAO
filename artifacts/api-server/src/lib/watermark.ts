import sharp from "sharp";

/**
 * "Made with KOKAO.in" watermark stamped on AI-generated images for
 * free-plan workspaces. Controlled by the platform-wide "freeWatermark"
 * kill switch (admin Feature Controls card).
 *
 * Fails SOFT: if compositing throws for any reason, the caller gets the
 * original image back — a broken watermark must never break generation.
 */

export const WATERMARK_TEXT = "Made with KOKAO.in";

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build the SVG overlay: a semi-transparent dark pill with white text,
 * sized relative to the image width so it looks right on any resolution.
 */
function buildOverlaySvg(imageWidth: number): { svg: Buffer; width: number; height: number } {
  // Text at ~2.6% of image width, clamped so tiny/huge images stay legible.
  const fontSize = Math.max(14, Math.min(48, Math.round(imageWidth * 0.026)));
  const padX = Math.round(fontSize * 0.9);
  const padY = Math.round(fontSize * 0.55);
  // Approximate glyph width for a sans-serif face; generous so text never clips.
  const textWidth = Math.ceil(WATERMARK_TEXT.length * fontSize * 0.58);
  const width = textWidth + padX * 2;
  const height = fontSize + padY * 2;
  const radius = Math.round(height / 2);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect x="0" y="0" width="${width}" height="${height}" rx="${radius}" ry="${radius}" fill="black" fill-opacity="0.45"/>
  <text x="${width / 2}" y="${height / 2}" dy="0.36em" text-anchor="middle"
        font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="600"
        fill="white" fill-opacity="0.92">${escapeXml(WATERMARK_TEXT)}</text>
</svg>`;
  return { svg: Buffer.from(svg), width, height };
}

/**
 * Stamp the watermark pill in the bottom-right corner of a PNG/JPEG buffer.
 * Output is always PNG (matches how generated images are stored).
 */
export async function applyMadeWithWatermark(image: Buffer): Promise<Buffer> {
  try {
    const base = sharp(image);
    const meta = await base.metadata();
    const imgWidth = meta.width ?? 1024;
    const imgHeight = meta.height ?? 1024;
    const overlay = buildOverlaySvg(imgWidth);
    const margin = Math.max(8, Math.round(imgWidth * 0.02));
    // If the pill somehow wouldn't fit, skip rather than error.
    if (overlay.width + margin > imgWidth || overlay.height + margin > imgHeight) {
      return image;
    }
    return await base
      .composite([
        {
          input: overlay.svg,
          left: imgWidth - overlay.width - margin,
          top: imgHeight - overlay.height - margin,
        },
      ])
      .png()
      .toBuffer();
  } catch {
    return image;
  }
}
