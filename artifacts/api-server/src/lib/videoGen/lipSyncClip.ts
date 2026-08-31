import { generateLipSyncWithReplicate } from "./providers/replicate";
import {
  getVideoGenProviderDef,
  resolveVideoGenApiKey,
  resolveLipSyncModelRef,
} from "./index";

/**
 * Lip-sync one generated shot to its slice of the narration.
 *
 * The lip_sync engine reaches the model through the job runner, which the
 * scene generators cannot import without a cycle. This is the same call with
 * the key and model lookups folded in, so a shot can be synced from wherever
 * it was generated.
 *
 * Deliberately thin: it is not a provider adapter. Lip sync is still pinned to
 * Replicate, because {video, audio} is the contract that makes the feature —
 * giving it the full VideoGenProviderDef treatment is a separate job, and
 * doing it here would mean two half-migrations instead of one clean one.
 */
export async function lipSyncClip(args: {
  video: Buffer;
  audio: Buffer;
}): Promise<{ buffer: Buffer; provider: string; model: string }> {
  const def = getVideoGenProviderDef("replicate");
  const apiKey = def ? await resolveVideoGenApiKey(def) : null;
  return generateLipSyncWithReplicate(
    {
      video: { buffer: args.video, mimeType: "video/mp4" },
      audio: { buffer: args.audio, mimeType: "audio/wav" },
    },
    apiKey,
    await resolveLipSyncModelRef(),
  );
}
