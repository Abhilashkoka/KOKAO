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

export type WearStyle = "ethnic" | "formal" | "casual";

/** The setting for each kind of outfit. */
const BACKDROP: Record<WearStyle | "default", string> = {
  ethnic: "Soft, warm, festive studio light on a clean plain backdrop.",
  formal: "Crisp, even studio light on a minimal light-grey backdrop.",
  casual:
    "A natural lifestyle setting in soft daylight, such as a sunny city street or a cafe terrace, with the background gently blurred.",
  default: "Soft even studio light on a clean plain background.",
};

/**
 * The instruction sent ahead of the user's scene text. Written for the
 * provider, not the user: it says which half of the sheet is identity and
 * which is wardrobe. The garment's own print, graphics and logos are part of
 * the outfit and are kept; everything else in the photo (shop text, price
 * tags, watermarks, mannequins, hangers, background) is not copied.
 */
export function tryOnInstruction(
  hasModel: boolean,
  scene: string,
  gender: "woman" | "man" | null = null,
  style: WearStyle | null = null,
): string {
  const who =
    gender === "man"
      ? "a professional Indian male model"
      : gender === "woman"
        ? "a professional Indian female model"
        : "a professional Indian model";
  const parts = hasModel
    ? [
        "The reference sheet has two parts: on the LEFT is the model, on the RIGHT is an outfit or product.",
        "Create one new photorealistic full-length photo of the SAME person from the left (same face, hair, skin tone and body) wearing exactly the outfit from the right.",
      ]
    : [
        `Create a photorealistic full-length fashion photo of ${who} wearing exactly the outfit, or holding exactly the product, shown in the reference image.`,
      ];
  parts.push(
    "Keep the outfit's colours, print, pattern, border, cut and fabric identical to the reference, including any graphic, logo or lettering that is printed or stitched on the garment itself.",
    `Natural pose, sharp focus, high detail. ${BACKDROP[style ?? "default"]}`,
  );
  const trimmed = scene.trim();
  if (trimmed) parts.push(`Scene idea: ${trimmed}`);
  parts.push(
    "Do not copy anything that is not part of the garment: no shop or background text, price tag, watermark, mannequin, hanger or background from the reference.",
    "No on-screen text, captions or watermarks added to the image.",
  );
  return parts.join(" ");
}
