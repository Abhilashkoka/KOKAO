import { db, charactersTable, characterOutfitsTable } from "@workspace/db";
import type { Character, CharacterOutfit } from "@workspace/db";
import { and, eq, asc } from "drizzle-orm";
import { ObjectStorageService, ObjectNotFoundError } from "./objectStorage";
import { generateImage } from "./imageGen";
import type { ImageSize, ReferenceImage, ImageGenResult } from "./imageGen/types";

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

/** The image size that best matches a video aspect ratio (gpt-image-1 set). */
export function imageSizeForAspect(aspect: "16:9" | "9:16" | "1:1"): ImageSize {
  if (aspect === "9:16") return "1024x1536";
  if (aspect === "16:9") return "1536x1024";
  return "1024x1024";
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
export function sceneKeyframePrompt(
  character: Character,
  outfit: CharacterOutfit,
  sceneVisual: string,
): string {
  const identity = character.description ? ` (${character.description})` : "";
  return (
    `Place the exact character from the image${identity} into this scene: ` +
    `${sceneVisual}. ` +
    "Keep the identical face, hair, and identity, and keep the exact same " +
    `outfit they are wearing (${outfit.description}). ` +
    "Cinematic composition, photorealistic, natural lighting. " +
    "No text, no watermark."
  );
}

/** A tenant's character with its outfits, ordered default-first. */
export interface CharacterDetail {
  character: Character;
  outfits: CharacterOutfit[];
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
    return detail.outfits.find((o) => o.id === outfitId) ?? null;
  }
  return detail.outfits.find((o) => o.isDefault) ?? detail.outfits[0] ?? null;
}

/** Load a tenant-scoped reference image from workspace storage. */
export async function loadReferenceImage(
  objectPath: string,
  tenantId: number,
): Promise<ReferenceImage> {
  let file;
  try {
    file = await objectStorageService.getObjectEntityFile(objectPath, tenantId);
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

/** Generate an identity-preserving costume variant from the base reference. */
export async function generateOutfitVariant(
  character: Character,
  outfitDescription: string,
  baseReference: ReferenceImage,
): Promise<ImageGenResult> {
  return generateImage(outfitVariantPrompt(character, outfitDescription), "1024x1536", baseReference);
}

/** Generate a per-scene keyframe with the locked character and outfit. */
export async function generateSceneKeyframe(
  character: Character,
  outfit: CharacterOutfit,
  sceneVisual: string,
  aspect: "16:9" | "9:16" | "1:1",
  outfitReference: ReferenceImage,
): Promise<ImageGenResult> {
  return generateImage(
    sceneKeyframePrompt(character, outfit, sceneVisual),
    imageSizeForAspect(aspect),
    outfitReference,
  );
}
