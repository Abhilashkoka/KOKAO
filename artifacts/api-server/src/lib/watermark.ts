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
 * Render the watermark pill alone as a PNG buffer sized for a frame of the
 * given width (used by the video pipeline, which overlays it via ffmpeg).
 * Returns null when the pill would not fit or rendering fails.
 */
export async function renderWatermarkPill(
  frameWidth: number,
  frameHeight: number,
): Promise<{ png: Buffer; width: number; height: number; margin: number } | null> {
  try {
    const overlay = buildOverlaySvg(frameWidth);
    const margin = Math.max(8, Math.round(frameWidth * 0.02));
    if (overlay.width + margin > frameWidth || overlay.height + margin > frameHeight) {
      return null;
    }
    const png = await sharp(overlay.svg).png().toBuffer();
    return { png, width: overlay.width, height: overlay.height, margin };
  } catch {
    return null;
  }
}

/**
 * Vertical video watermark: "Made with KOKAO.in" reading bottom-to-top,
 * white at ~60% with a soft blurred shadow so it stays legible on both
 * light and dark scenes. No pill. Placed on the LEFT edge, vertically
 * centred — the right edge (like/comment/share) and bottom (caption) of a
 * Reel are covered by the platform UI.
 */
function buildVerticalOverlaySvg(
  frameWidth: number,
  frameHeight: number,
): { svg: Buffer; width: number; height: number } {
  const shortEdge = Math.min(frameWidth, frameHeight);
  const fontSize = Math.max(16, Math.min(44, Math.round(shortEdge * 0.032)));
  const blur = Math.max(2, Math.round(fontSize * 0.12));
  const textLength = Math.ceil(WATERMARK_TEXT.length * fontSize * 0.6);
  // Rotated canvas: text length runs vertically; room for shadow spread.
  const width = Math.round(fontSize * 1.8);
  const height = textLength + fontSize;
  const cx = width / 2;
  const cy = height / 2;
  const text = escapeXml(WATERMARK_TEXT);
  const common = `text-anchor="middle" dy="0.35em" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="700" letter-spacing="${(fontSize * 0.06).toFixed(1)}"`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs><filter id="s" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${blur}"/></filter></defs>
  <g transform="translate(${cx},${cy}) rotate(-90)">
    <text ${common} y="${Math.round(fontSize * 0.06)}" fill="black" fill-opacity="0.45" filter="url(#s)">${text}</text>
    <text ${common} fill="white" fill-opacity="0.6">${text}</text>
  </g>
</svg>`;
  return { svg: Buffer.from(svg), width, height };
}

/**
 * Render the vertical video watermark as a PNG for the given frame size.
 * Returns null when it would not fit or rendering fails.
 */
export async function renderVerticalWatermark(
  frameWidth: number,
  frameHeight: number,
): Promise<{ png: Buffer; width: number; height: number; margin: number } | null> {
  try {
    const overlay = buildVerticalOverlaySvg(frameWidth, frameHeight);
    const margin = Math.max(6, Math.round(Math.min(frameWidth, frameHeight) * 0.015));
    if (overlay.width + margin > frameWidth || overlay.height + margin * 2 > frameHeight) {
      return null;
    }
    const png = await sharp(overlay.svg).png().toBuffer();
    return { png, width: overlay.width, height: overlay.height, margin };
  } catch {
    return null;
  }
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
