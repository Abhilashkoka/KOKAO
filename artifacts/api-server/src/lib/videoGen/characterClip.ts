import {
  getCharacterDetail,
  resolveOutfit,
  loadReferenceImage,
  generateSceneKeyframe,
} from "../characters";
import { generateVideo } from "./index";
import { VideoGenProviderError, type VideoAspect } from "./types";

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
    prompt: `${scene}. Subtle natural motion, cinematic.`,
    aspectRatio: params.aspectRatio,
    durationSec: params.durationSec,
    image: { buffer: keyframe.buffer, mimeType: "image/png" },
  });
  return { buffer: clip.buffer, provider: clip.provider, model: clip.model };
}
