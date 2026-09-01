import { db, charactersTable, characterOutfitsTable } from "@workspace/db";
import type { Character, CharacterOutfit, VideoJobAspect } from "@workspace/db";
import { and, eq, asc } from "drizzle-orm";
import { ObjectStorageService, ObjectNotFoundError } from "./objectStorage";
import { generateImage } from "./imageGen";
import type {
  ExactMaskedEdit,
  ImageSize,
  ReferenceImage,
  ImageGenResult,
} from "./imageGen/types";
import { bundledPresetAsset, presetPublicAssetRelativePath } from "./presetCharacters";
import sharp from "sharp";

/**
 * Character lock for the Video Studio.
 *
 * The only reliable way to keep the same character (and costume) across
 * AI-generated scenes today is reference anchoring: every generation starts
 * from the same canonical image. This module owns those anchors —
 * identity-preserving prompts, reference loading, and the image-edit calls
 * that create costume variants and per-scene keyframes — so the CRUD routes
 * and the video pipeline stay in lockstep about how identity is preserved.
 */

const objectStorageService = new ObjectStorageService();

/** Reference images must fit provider payloads (same cap as source images). */
export const MAX_CHARACTER_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export class CharacterInputError extends Error {}

/**
 * The image size that best matches a video aspect ratio.
 *
 * gpt-image-1 offers exactly three shapes, so every video ratio maps onto the
 * nearest of them by orientation and the keyframe is cover-cropped into the
 * true frame downstream: 4:5 and 3:4 render tall, 4:3 and 21:9 render wide,
 * and only a genuinely square request gets the square canvas. Rendering a 4:5
 * keyframe on the square canvas would crop the subject's head off at the top.
 */
export function imageSizeForAspect(aspect: VideoJobAspect): ImageSize {
  const [w, h] = aspect.split(":").map(Number);
  if (!w || !h || w === h) return "1024x1024";
  return h > w ? "1024x1536" : "1536x1024";
}

/** Prompt for a brand-new character reference from a text description. */
export function characterReferencePrompt(description: string): string {
  return (
    `Full-body character reference portrait: ${description}. ` +
    "Standing, facing the camera, full body visible from head to toe, " +
    "neutral light-grey studio background, soft even lighting, " +
    "photorealistic, high detail. No text, no watermark."
  );
}

/** Prompt for an identity-preserving costume variant of the reference. */
export function outfitVariantPrompt(character: Character, outfitDescription: string): string {
  return (
    "Show the exact same character from the image — identical face, hair, " +
    "body, and identity — now wearing: " +
    `${outfitDescription}. ` +
    "Keep the same standing full-body pose, the same neutral studio " +
    "background, and the same lighting. Only the clothing changes. " +
    "No text, no watermark."
  );
}

/** Prompt that places the locked character (in the locked outfit) into a scene. */
/**
 * Explicit framing language per shot size.
 *
 * "Cinematic composition" alone lost every time: the reference is a portrait
 * and the prompt's own identity-preservation language ("place the exact
 * character from the reference") pulls hard toward a face-forward frame. A
 * real sample came back as eight consecutive extreme close-ups. Naming the
 * shot in the terms a camera department would use is what actually moves it.
 */
const FRAMING: Record<"wide" | "medium" | "close", string> = {
  wide:
    "Wide shot: the character full-length inside the location, the place " +
    "clearly readable around them and the character occupying a modest part " +
    "of the frame.",
  medium:
    "Medium shot: the character framed from about the waist up, with enough " +
    "of the setting behind them to place the scene.",
  close:
    "Close-up: head and shoulders, the face occupying much of the frame, the " +
    "background soft behind them.",
};

export function sceneKeyframePrompt(
  character: Character,
  outfit: CharacterOutfit,
  sceneVisual: string,
  shotSize: "wide" | "medium" | "close" = "medium",
): string {
  const identity = character.description ? ` (${character.description})` : "";
  return (
    "The reference image is authoritative for identity and clothing only. " +
    `Place the exact character from the reference${identity} into this scene. ` +
    `Required outfit: ${outfit.name} — ${outfit.description}. ` +
    "Copy every visible garment, color, pattern, layer, accessory, and footwear " +
    "from the reference exactly. Do not redesign, substitute, infer, or add clothing. " +
    `Scene action and setting (ignore any conflicting wardrobe implied by it): ${sceneVisual}. ` +
    "Do not copy the reference's background, pose, camera angle, or framing. The " +
    "reference is a plain studio portrait; this is a new photograph taken on " +
    "location. The character is inside the setting described above and surrounded " +
    "by it — no studio backdrop, seamless wall, or empty grey field anywhere in " +
    "the frame. Pose and body language come from the scene action, not from the " +
    "reference. " +
    `${FRAMING[shotSize]} ` +
    "Keep the identical face, hair, body, identity, and exact referenced outfit. " +
    "Photorealistic, natural lighting that belongs to the setting. " +
    "No text, no watermark."
  );
}

/** A tenant's character with its outfits, ordered default-first. */
export interface CharacterDetail {
  character: Character;
  outfits: CharacterOutfit[];
}

export type CharacterSnapshot = NonNullable<
  import("@workspace/db").VideoJobOptions["characterSnapshot"]
>;

/** Rehydrate immutable enqueue-time character inputs for retries and review resumes. */
export function characterDetailFromSnapshot(
  tenantId: number,
  snapshot: CharacterSnapshot,
): CharacterDetail {
  return {
    character: { ...snapshot.character, tenantId } as Character,
    outfits: snapshot.outfits.map((outfit) => ({
      ...outfit,
      tenantId,
      characterId: snapshot.character.id,
    })) as CharacterOutfit[],
  };
}

export async function getCharacterDetail(
  tenantId: number,
  characterId: number,
): Promise<CharacterDetail | null> {
  const character = (
    await db
      .select()
      .from(charactersTable)
      .where(and(eq(charactersTable.id, characterId), eq(charactersTable.tenantId, tenantId)))
      .limit(1)
  )[0];
  if (!character) return null;
  const outfits = await db
    .select()
    .from(characterOutfitsTable)
    .where(
      and(
        eq(characterOutfitsTable.characterId, characterId),
        eq(characterOutfitsTable.tenantId, tenantId),
      ),
    )
    .orderBy(asc(characterOutfitsTable.id));
  outfits.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.id - b.id);
  return { character, outfits };
}

/**
 * Resolve the outfit a video should lock to: the requested one when given,
 * otherwise the character's default (or first) outfit.
 */
export function resolveOutfit(
  detail: CharacterDetail,
  outfitId: number | null | undefined,
): CharacterOutfit | null {
  if (outfitId != null) {
    const outfit = detail.outfits.find((o) => o.id === outfitId) ?? null;
    return outfit && isOutfitSelectable(outfit) ? outfit : null;
  }
  return (
    detail.outfits.find((o) => o.isDefault) ??
    detail.outfits.find(isOutfitSelectable) ??
    null
  );
}

/** Only defaults or explicitly approved, pixel-verified previews may be cast. */
export function isOutfitSelectable(outfit: CharacterOutfit): boolean {
  return (
    outfit.isDefault ||
    (outfit.status === "approved" && outfit.identityVerified === true)
  );
}

/** Load a tenant-scoped reference image from workspace storage. */
export async function loadReferenceImage(
  objectPath: string,
  tenantId: number,
): Promise<ReferenceImage> {
  let file;
  try {
    const presetPath = presetPublicAssetRelativePath(objectPath);
    if (presetPath) {
      const [stableId, asset] = presetPath.split("/");
      const buffer = bundledPresetAsset(stableId ?? "", asset ?? "");
      if (!buffer) throw new ObjectNotFoundError();
      // Bundled assets remain SVG for crisp browser delivery, but normalize to
      // PNG for all image-edit providers (notably OpenAI's multipart endpoint).
      return { buffer: await sharp(buffer).png().toBuffer(), mimeType: "image/png" };
    } else {
      // Identity-backed private references remain fail-closed to the owning
      // tenant. In particular, never fall back to a public or generated person.
      file = await objectStorageService.getObjectEntityFile(objectPath, tenantId);
    }
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      throw new CharacterInputError("Character reference image not found.");
    }
    throw err;
  }
  const [metadata] = await file.getMetadata();
  const size = Number(metadata.size ?? 0);
  if (size > MAX_CHARACTER_IMAGE_BYTES) {
    throw new CharacterInputError("Character reference image is too large (max 10 MB).");
  }
  const rawType = String(metadata.contentType ?? "")
    .toLowerCase()
    .split(";")[0]!
    .trim();
  const mimeType = rawType === "image/jpg" ? "image/jpeg" : rawType;
  if (!ALLOWED_IMAGE_TYPES.has(mimeType)) {
    throw new CharacterInputError(
      "Unsupported reference image type. Please use PNG, JPEG, or WebP.",
    );
  }
  const [buffer] = await file.download();
  return { buffer, mimeType };
}

/** Generate a fresh character reference image from a description. */
export async function generateCharacterReference(description: string): Promise<ImageGenResult> {
  return generateImage(characterReferencePrompt(description), "1024x1536");
}

/** Build an explicit alpha mask: clothing may change; protected identity pixels may not. */
export async function createOutfitMaskedEdit(
  baseReference: ReferenceImage,
  protectedRectangle: ExactMaskedEdit["protectedRectangle"],
): Promise<ExactMaskedEdit> {
  const metadata = await sharp(baseReference.buffer).metadata();
  if (!metadata.width || !metadata.height) {
    throw new CharacterInputError("Character reference image is not readable.");
  }
  const width = metadata.width;
  const height = metadata.height;
  const left = Math.floor(protectedRectangle.x * width);
  const top = Math.floor(protectedRectangle.y * height);
  const right = Math.ceil(
    (protectedRectangle.x + protectedRectangle.width) * width,
  );
  const bottom = Math.ceil(
    (protectedRectangle.y + protectedRectangle.height) * height,
  );
  // Start fully opaque (preserve everything), then open only the body/clothing
  // column below the protected face-and-hair box for provider editing.
  const pixels = Buffer.alloc(width * height * 4, 255);
  const clothingLeft = Math.floor(width * 0.04);
  const clothingRight = Math.ceil(width * 0.96);
  for (let y = bottom; y < height; y += 1) {
    for (let x = clothingLeft; x < clothingRight; x += 1) {
      const offset = (y * width + x) * 4;
      pixels[offset + 3] = 0;
    }
  }
  return {
    mask: {
      buffer: await sharp(pixels, {
        raw: { width, height, channels: 4 },
      })
        .png()
        .toBuffer(),
      mimeType: "image/png",
    },
    protectedRectangle,
  };
}

/** Generate an identity-preserving costume variant from the base reference. */
export async function generateOutfitVariant(
  character: Character,
  outfitDescription: string,
  baseReference: ReferenceImage,
  exactMaskedEdit?: ExactMaskedEdit,
  onProviderSuccess?: (meta: {
    provider: string;
    model: string;
  }) => Promise<void>,
): Promise<ImageGenResult> {
  return generateImage(
    outfitVariantPrompt(character, outfitDescription),
    "1024x1536",
    baseReference,
    // requireReferenceInput: a costume variant that ignored the base reference
    // would be a different person in the right clothes. See generateSceneKeyframe.
    exactMaskedEdit
      ? { exactMaskedEdit, onProviderSuccess, requireReferenceInput: true }
      : { requireReferenceInput: true },
  );
}

/** Generate a per-scene keyframe with the locked character and outfit. */
export async function generateSceneKeyframe(
  character: Character,
  outfit: CharacterOutfit,
  sceneVisual: string,
  aspect: VideoJobAspect,
  outfitReference: ReferenceImage,
  shotSize: "wide" | "medium" | "close" = "medium",
): Promise<ImageGenResult> {
  return generateImage(
    sceneKeyframePrompt(character, outfit, sceneVisual, shotSize),
    imageSizeForAspect(aspect),
    outfitReference,
    // The whole point of this call is "the approved character, again". A
    // provider that cannot read the reference does not do a worse job of that
    // — it does a different job, inventing a new face and a new costume per
    // scene from prompt text alone, with nothing in the result to say so.
    // requireReferenceInput reroutes to a capable provider, or refuses.
    { requireReferenceInput: true },
  );
}
