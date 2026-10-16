import sharp from "sharp";
import type { ReferenceImage } from "./imageGen/types";

/** Height each panel is scaled to inside a combined reference sheet. */
const PANEL_HEIGHT = 1024;
const GUTTER = 24;

/**
 * Image providers accept one reference image. To keep the SAME person across
 * several outfits, the model photo and the outfit photo are placed side by side
 * on one white sheet: the model on the left, the garment on the right. With no
 * model photo the outfit photo is sent as it is.
 */
export async function buildTryOnReference(
  outfit: ReferenceImage,
  model: ReferenceImage | null,
): Promise<ReferenceImage> {
  if (!model) return outfit;
  const panel = async (image: ReferenceImage) => {
    const { data, info } = await sharp(image.buffer)
      .rotate()
      .resize({ height: PANEL_HEIGHT, withoutEnlargement: false })
      .png()
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width };
  };
  const [left, right] = await Promise.all([panel(model), panel(outfit)]);
  const width = left.width + GUTTER + right.width;
  const buffer = await sharp({
    create: { width, height: PANEL_HEIGHT, channels: 3, background: "#ffffff" },
  })
    .composite([
      { input: left.data, left: 0, top: 0 },
      { input: right.data, left: left.width + GUTTER, top: 0 },
    ])
    .png()
    .toBuffer();
  return { buffer, mimeType: "image/png" };
}

/**
 * The instruction sent ahead of the user's scene text. Written for the
 * provider, not the user: it says which half of the sheet is identity and
 * which is wardrobe, and forbids copying text or mannequins.
 */
export function tryOnInstruction(hasModel: boolean, scene: string): string {
  const parts = hasModel
    ? [
        "The reference sheet has two parts: on the LEFT is the model, on the RIGHT is an outfit or product.",
        "Create one new photorealistic full-length photo of the SAME person from the left (same face, hair, skin tone and body) wearing exactly the outfit from the right.",
      ]
    : [
        "Create a photorealistic full-length fashion photo of a professional Indian model wearing exactly the outfit, or holding exactly the product, shown in the reference image.",
      ];
  parts.push(
    "Keep the outfit's colours, print, pattern, border, cut and fabric identical to the reference.",
    "Natural pose, soft even studio light, clean plain background, sharp focus, high detail.",
  );
  const trimmed = scene.trim();
  if (trimmed) parts.push(`Scene idea: ${trimmed}`);
  parts.push(
    "Do not copy any text, watermark, logo, mannequin, hanger or background from the reference.",
    "No on-screen text, captions, logos or watermarks.",
  );
  return parts.join(" ");
}
