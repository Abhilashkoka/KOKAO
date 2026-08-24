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
}): Promise<{ buffer: Buffer; provider: string; model: string }> {
  const detail = await getCharacterDetail(params.tenantId, params.characterId);
  if (!detail) {
    throw new VideoGenProviderError("The selected character no longer exists.");
  }
  const outfit = resolveOutfit(detail, params.outfitId);
  if (!outfit) {
    throw new VideoGenProviderError("The selected outfit no longer exists.");
  }
  const reference = await loadReferenceImage(outfit.referenceImagePath, params.tenantId);
  const scene = params.prompt.trim() || "a cinematic portrait moment";
  const keyframe = await generateSceneKeyframe(
    detail.character,
    outfit,
    scene,
    params.aspectRatio,
    reference,
  );
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
