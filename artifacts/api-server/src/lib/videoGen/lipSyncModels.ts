/**
 * Lip-sync models, in the two shapes the feature comes in.
 *
 * Until now this was one pinned Replicate community model — LatentSync —
 * reachable only one way: the tenant had to have FILMED a video of a person,
 * and the words had to come from KOKAO's own text-to-speech. Two things were
 * missing around it:
 *
 *  - PORTRAIT mode: a single headshot plus audio becomes a talking video, so a
 *    founder gets a spokesperson without ever standing in front of a camera.
 *  - BRING YOUR OWN AUDIO: a recorded voice note, a podcast clip, a take from
 *    an actor. Synthesising is a default, not a requirement.
 *
 * BYO audio works on both modes and needs no configuration. Portrait mode
 * needs a model that accepts an IMAGE plus audio, and the honest position is
 * that there is no such model pinned in this repo yet: rather than ship a
 * guessed Replicate slug and version hash that would 404 on the first paid
 * job, the portrait model is admin-configured (video_gen_settings
 * .lip_sync_portrait_model) and preflight refuses portrait jobs with a message
 * naming exactly what to set until it is. See VIDEO_UPGRADES_SETUP.md.
 */

export type LipSyncMode = "video" | "portrait";

export interface LipSyncModelDef {
  /** Stable id; persisted on jobs. */
  id: string;
  label: string;
  mode: LipSyncMode;
  /** Replicate model slug ("owner/name"). */
  model: string;
  /**
   * Version hash for a Replicate COMMUNITY model. Community models must be
   * invoked through /v1/predictions with an explicit version; the
   * official-model endpoint 404s for them even though the page exists.
   */
  version?: string;
  /** Input key the source file goes under ("video" or "image"). */
  sourceField: string;
  /** Input key the audio track goes under. */
  audioField: string;
}

/**
 * ByteDance LatentSync: lip-syncs an existing video of a person to a new audio
 * track by redrawing the mouth region. Pinned — it is the input contract
 * (video + audio) that makes the spokesperson feature work.
 */
export const LATENT_SYNC: LipSyncModelDef = {
  id: "latentsync",
  label: "LatentSync",
  mode: "video",
  model: "bytedance/latentsync",
  version: "637ce1919f807ca20da3a448ddc2743535d2853649574cd52a933120e9b9e293",
  sourceField: "video",
  audioField: "audio",
};

export const LIP_SYNC_MODELS: readonly LipSyncModelDef[] = [LATENT_SYNC];

/**
 * Build a portrait-mode def from the admin's configured model string.
 *
 * Accepts "owner/name" (an official Replicate model) or "owner/name:version"
 * (a community model). Returns null when nothing is configured, which is what
 * preflight turns into an actionable 400.
 */
export function portraitLipSyncModel(configured: string | null | undefined): LipSyncModelDef | null {
  const raw = configured?.trim();
  if (!raw) return null;
  const [slug, version] = raw.split(":");
  if (!slug || !slug.includes("/")) return null;
  return {
    id: "portrait",
    label: slug,
    mode: "portrait",
    model: slug,
    ...(version ? { version } : {}),
    sourceField: "image",
    audioField: "audio",
  };
}

/** Audio a tenant may upload as the voice track. */
export const ALLOWED_LIP_SYNC_AUDIO_TYPES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/x-m4a",
  "audio/aac",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "audio/ogg",
]);

/** Portrait stills a tenant may upload as the face. */
export const ALLOWED_LIP_SYNC_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

/** Cap on an uploaded voice track; a few minutes of speech is well under it. */
export const MAX_LIP_SYNC_AUDIO_BYTES = 25 * 1024 * 1024;
