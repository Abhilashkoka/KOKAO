import {
  getCharacterDetail,
  resolveOutfit,
  loadReferenceImage,
  generateSceneKeyframe,
} from "../characters";
import { generateVideo } from "./index";
import { getMotionInstruction } from "./motionPrompt";
import { VideoGenProviderError, type VideoAspect } from "./types";
import type { ResolvedModelOptions } from "./modelCatalog";
import type { Cinematography } from "./cinematography";
import type { ImageGenResult } from "../imageGen/types";
import type { CharacterDetail } from "../characters";
import { characterDetailFromSnapshot, type CharacterSnapshot } from "../characters";

/**
 * A single character-locked AI clip (Text to Video with a character picked):
 * the prompt becomes an identity-anchored keyframe — an image edit of the
 * locked outfit's reference — which the image-to-video engine then animates.
 * The character in frame one is the tenant's character, not a model's guess.
 */
export async function generateCharacterClip(params: {
  tenantId: number;
  characterId: number;
  outfitId: number | null;
  prompt: string;
  aspectRatio: VideoAspect;
  durationSec: number;
  /** Named camera move for this clip; null = the built-in motion instruction. */
  motionPreset?: string | null;
  /** Optics for this clip; null = nothing added to the prompt. */
  cinematography?: Cinematography | null;
  /** Deterministic seed; null = the provider's choice. */
  seed?: number | null;
  /** The picked catalog model and its resolved flags; omitted = the platform
   * selection, which is what this path always used. */
  model?: ResolvedModelOptions;
  /** Reuse a durably saved identity keyframe on a runner retry. */
  keyframe?: Buffer | null;
  /** Called after the image provider acknowledges the keyframe, before I2V. */
  onKeyframeProviderSuccess?: (result: ImageGenResult) => Promise<void>;
  /** Immutable enqueue-time identity inputs for hybrid retries. */
  snapshot?: {
    referenceImagePath: string; characterName: string; characterDescription: string;
    outfitReferenceImagePath: string; outfitName: string; outfitDescription: string;
  };
  /** Generic enqueue-time wardrobe snapshot used by ordinary character jobs. */
  wardrobeSnapshot?: CharacterSnapshot | null;
}): Promise<{ buffer: Buffer; provider: string; model: string }> {
  const detail = params.wardrobeSnapshot
    ? characterDetailFromSnapshot(params.tenantId, params.wardrobeSnapshot)
    : params.snapshot
    ? ({
        character: { id: params.characterId, tenantId: params.tenantId, name: params.snapshot.characterName,
          description: params.snapshot.characterDescription, referenceImagePath: params.snapshot.referenceImagePath },
        outfits: [{ id: params.outfitId, tenantId: params.tenantId, characterId: params.characterId,
          name: params.snapshot.outfitName, description: params.snapshot.outfitDescription,
          referenceImagePath: params.snapshot.outfitReferenceImagePath, isDefault: true }],
      } as unknown as CharacterDetail)
      : await getCharacterDetail(params.tenantId, params.characterId);
  if (!detail) {
    throw new VideoGenProviderError("The selected character no longer exists.");
  }
  const outfit = resolveOutfit(detail, params.outfitId);
  if (!outfit) {
    throw new VideoGenProviderError("The selected outfit no longer exists.");
  }
  const reference = await loadReferenceImage(outfit.referenceImagePath, params.tenantId);
  const scene = params.prompt.trim() || "a cinematic portrait moment";
  const generatedKeyframe = params.keyframe ? null : await generateSceneKeyframe(
      detail.character,
      outfit,
      scene,
      params.aspectRatio,
      reference,
    );
  if (generatedKeyframe) await params.onKeyframeProviderSuccess?.(generatedKeyframe);
  const keyframe = generatedKeyframe ?? { buffer: params.keyframe! };
  const clip = await generateVideo({
    mode: "image",
    prompt: `${scene}. ${await getMotionInstruction(params.motionPreset, params.cinematography)}`,
    aspectRatio: params.aspectRatio,
    durationSec: params.durationSec,
    seed: params.seed ?? null,
    image: { buffer: keyframe.buffer, mimeType: "image/png" },
    ...(params.model ?? {}),
  });
  return { buffer: clip.buffer, provider: clip.provider, model: clip.model };
}
