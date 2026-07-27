import { db, videoGenSettingsTable, appCredentialsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../logger";
import { recordProviderFailure, recordProviderSuccess } from "../providerHealth";
import { encryptJson, decryptJson } from "../secretCrypto";
import {
  generateWithReplicate,
  REPLICATE_T2V_MODEL,
  REPLICATE_I2V_MODEL,
} from "./providers/replicate";
import { isTransientStatus } from "./retry";
import { VideoGenNotConfiguredError, VideoGenProviderError } from "./types";
import type { SourceImage, VideoAspect, VideoGenInput, VideoGenResult } from "./types";

export { VideoGenNotConfiguredError, VideoGenProviderError, compiledClipPrompt } from "./types";
export type { SourceImage, VideoAspect, VideoGenInput, VideoGenResult } from "./types";

export const DEFAULT_VIDEO_GEN_PROVIDER = "replicate";

/** Which AI video engine a model override applies to. */
export type VideoGenMode = "text" | "image";

export interface VideoGenProviderDef {
  id: string;
  label: string;
  defaultTextToVideoModel: string;
  defaultImageToVideoModel: string;
  /** Secret required to use this provider. */
  envKey: string;
  /** Whether the admin may override the model names for this provider. */
  supportsModelOverride: boolean;
  /** Suggested model choices shown in the admin UI (free text still allowed). */
  textModelOptions?: readonly { value: string; label: string }[];
  imageModelOptions?: readonly { value: string; label: string }[];
  generate: (input: VideoGenInput, apiKey: string | null) => Promise<VideoGenResult>;
}

/** Catalog of selectable AI video generation providers. Add new ones here only. */
export const VIDEO_GEN_PROVIDERS: readonly VideoGenProviderDef[] = [
  {
    id: "replicate",
    label: "Replicate",
    defaultTextToVideoModel: REPLICATE_T2V_MODEL,
    defaultImageToVideoModel: REPLICATE_I2V_MODEL,
    envKey: "REPLICATE_API_TOKEN",
    supportsModelOverride: true,
    // Curated per-engine choices. All slugs verified on replicate.com; the
    // input builder in providers/replicate.ts knows the WAN, MiniMax, Kling
    // and Veo input shapes (anything else gets the common WAN-style shape).
    textModelOptions: [
      { value: REPLICATE_T2V_MODEL, label: "WAN 2.2 Fast — cheap & quick, default (wan-video/wan-2.2-t2v-fast)" },
      { value: "wan-video/wan-2.5-t2v", label: "WAN 2.5 — higher quality, slower (wan-video/wan-2.5-t2v)" },
      { value: "google/veo-3-fast", label: "Google Veo 3 Fast — strong quality with audio (google/veo-3-fast)" },
      { value: "google/veo-3", label: "Google Veo 3 — top quality, premium price (google/veo-3)" },
      { value: "google/veo-3.1", label: "Google Veo 3.1 — newest Veo (google/veo-3.1)" },
      { value: "minimax/video-01", label: "MiniMax Video-01 — good motion (minimax/video-01)" },
      { value: "minimax/hailuo-02", label: "MiniMax Hailuo 02 — improved realism (minimax/hailuo-02)" },
      { value: "kwaivgi/kling-v2.1-standard", label: "Kling 2.1 Standard — balanced (kwaivgi/kling-v2.1-standard)" },
      { value: "kwaivgi/kling-v2.1-master", label: "Kling 2.1 Master — best Kling quality (kwaivgi/kling-v2.1-master)" },
      { value: "bytedance/seedance-1-pro", label: "Seedance 1 Pro — cinematic (bytedance/seedance-1-pro)" },
    ],
    imageModelOptions: [
      { value: REPLICATE_I2V_MODEL, label: "WAN 2.2 Fast — cheap & quick, default (wan-video/wan-2.2-i2v-fast)" },
      { value: "wan-video/wan-2.5-i2v", label: "WAN 2.5 — higher quality, slower (wan-video/wan-2.5-i2v)" },
      { value: "minimax/video-01", label: "MiniMax Video-01 — good motion (minimax/video-01)" },
      { value: "minimax/hailuo-02", label: "MiniMax Hailuo 02 — improved realism (minimax/hailuo-02)" },
      { value: "kwaivgi/kling-v2.1-standard", label: "Kling 2.1 Standard — balanced (kwaivgi/kling-v2.1-standard)" },
      { value: "kwaivgi/kling-v2.1-master", label: "Kling 2.1 Master — best Kling quality (kwaivgi/kling-v2.1-master)" },
      { value: "google/veo-3.1", label: "Google Veo 3.1 — animates a photo with audio (google/veo-3.1)" },
      { value: "bytedance/seedance-1-pro", label: "Seedance 1 Pro — cinematic (bytedance/seedance-1-pro)" },
    ],
    generate: generateWithReplicate,
  },
] as const;

export function getVideoGenProviderDef(id: string): VideoGenProviderDef | undefined {
  return VIDEO_GEN_PROVIDERS.find((p) => p.id === id);
}

/** app_credentials row name for a provider's stored video-gen key. */
function videoGenCredentialProvider(providerId: string): string {
  return `videogen_${providerId}`;
}

interface StoredVideoGenKey {
  apiKey: string;
}

/** The API key saved by a superadmin in the admin screen (encrypted at rest), or null. */
export async function getStoredVideoGenKey(providerId: string): Promise<string | null> {
  const row = (
    await db
      .select()
      .from(appCredentialsTable)
      .where(eq(appCredentialsTable.provider, videoGenCredentialProvider(providerId)))
      .limit(1)
  )[0];
  if (!row) return null;
  try {
    const creds = decryptJson<StoredVideoGenKey>(row.encryptedCredentials);
    return creds.apiKey || null;
  } catch {
    return null;
  }
}

/** Save (encrypted) or overwrite the admin-entered API key for a provider. */
export async function setStoredVideoGenKey(providerId: string, apiKey: string): Promise<void> {
  const encrypted = encryptJson({ apiKey } satisfies StoredVideoGenKey);
  await db
    .insert(appCredentialsTable)
    .values({ provider: videoGenCredentialProvider(providerId), encryptedCredentials: encrypted })
    .onConflictDoUpdate({
      target: appCredentialsTable.provider,
      set: { encryptedCredentials: encrypted, updatedAt: new Date() },
    });
}

/** Remove the admin-entered API key (env secret, if any, becomes the fallback). */
export async function clearStoredVideoGenKey(providerId: string): Promise<void> {
  await db
    .delete(appCredentialsTable)
    .where(eq(appCredentialsTable.provider, videoGenCredentialProvider(providerId)));
}

export type VideoGenKeySource = "database" | "env" | null;

/** Where the effective key comes from: admin-entered DB key wins, env secret is fallback. */
export async function getVideoGenKeySource(def: VideoGenProviderDef): Promise<VideoGenKeySource> {
  if (await getStoredVideoGenKey(def.id)) return "database";
  if (process.env[def.envKey]) return "env";
  return null;
}

/** The effective API key for a provider (DB first, then env), or null. */
export async function resolveVideoGenApiKey(def: VideoGenProviderDef): Promise<string | null> {
  const stored = await getStoredVideoGenKey(def.id);
  if (stored) return stored;
  return process.env[def.envKey] ?? null;
}

export async function isVideoGenProviderConfigured(def: VideoGenProviderDef): Promise<boolean> {
  return (await resolveVideoGenApiKey(def)) !== null;
}

export interface VideoGenSelection {
  provider: string;
  /** Admin model overrides (null = provider default for that engine). */
  textToVideoModel: string | null;
  imageToVideoModel: string | null;
}

/** The current selection (falls back to the default when the settings row is
 * missing or names a provider no longer in the catalog). */
export async function getVideoGenSelection(): Promise<VideoGenSelection> {
  const row = (await db.select().from(videoGenSettingsTable).limit(1))[0];
  const id = row?.provider ?? DEFAULT_VIDEO_GEN_PROVIDER;
  if (!getVideoGenProviderDef(id)) {
    return {
      provider: DEFAULT_VIDEO_GEN_PROVIDER,
      textToVideoModel: null,
      imageToVideoModel: null,
    };
  }
  return {
    provider: id,
    textToVideoModel: row?.textToVideoModel ?? null,
    imageToVideoModel: row?.imageToVideoModel ?? null,
  };
}

/** Persist the platform-wide selection (superadmin only; the route validates
 * the provider id against the catalog). */
export async function setVideoGenSelection(selection: VideoGenSelection): Promise<void> {
  await db
    .insert(videoGenSettingsTable)
    .values({ id: 1, ...selection })
    .onConflictDoUpdate({
      target: videoGenSettingsTable.id,
      set: { ...selection, updatedAt: new Date() },
    });
}

/** The model that will actually be used for a provider/engine given the settings. */
export function effectiveVideoModel(
  def: VideoGenProviderDef,
  mode: VideoGenMode,
  override: string | null,
): string {
  if (def.supportsModelOverride && override?.trim()) return override.trim();
  return mode === "text" ? def.defaultTextToVideoModel : def.defaultImageToVideoModel;
}

export function videoGenHealthKey(providerId: string): string {
  return `videogen:${providerId}`;
}

/** Whether a video failure is the UPSTREAM's fault (429/5xx/network/timeout),
 * as opposed to a rejected prompt or bad key that would fail on any model. */
function isTransientVideoGenError(error: unknown): boolean {
  // A missing API token is terminal. Every model in the chain authenticates
  // with the same credential, so walking it cannot help — and it says nothing
  // about whether the provider is up, so it must not reach the breaker. Both
  // halves follow from returning false here: the loop throws on a
  // non-transient primary failure before it would record anything, and it
  // only records failures it classified as transient.
  if (error instanceof VideoGenNotConfiguredError) return false;
  if (error instanceof VideoGenProviderError) {
    if (error.status === undefined) return true; // timeout / network-shaped
    return isTransientStatus(error.status);
  }
  // Raw fetch TypeError / socket resets — transient by nature.
  return error instanceof Error;
}

/** How many OTHER models to try after a transient failure. */
const VIDEO_GEN_FALLBACK_LIMIT = 2;

/**
 * The models to try, in order: the effective one first, then the provider's
 * other catalog choices for this engine.
 *
 * There is exactly one AI video provider today, so failover happens at MODEL
 * level rather than provider level. That is not a lesser fallback here: a
 * queue backed up behind one hosted model is the common failure, and the same
 * account's other models are usually fine.
 */
function videoModelChain(
  def: VideoGenProviderDef,
  mode: VideoGenMode,
  override: string | null,
): string[] {
  const primary = effectiveVideoModel(def, mode, override);
  const options = mode === "text" ? def.textModelOptions : def.imageModelOptions;
  const alternates = (options ?? [])
    .map((option) => option.value)
    .filter((model) => model !== primary)
    .slice(0, VIDEO_GEN_FALLBACK_LIMIT);
  return [primary, ...alternates];
}

/**
 * Generate a video using the currently selected provider.
 *
 * Reliability: a transient upstream failure (429/5xx/network/timeout) retries
 * on the provider's next catalog model rather than failing a job the tenant
 * has already paid a video unit for. Permanent failures — a prompt the safety
 * filter rejected, a missing key — fail immediately, because another model
 * would reject them too.
 */
export async function generateVideo(params: {
  mode: VideoGenMode;
  prompt: string;
  aspectRatio: VideoAspect;
  durationSec: number;
  image?: SourceImage;
}): Promise<VideoGenResult> {
  const selection = await getVideoGenSelection();
  const def =
    getVideoGenProviderDef(selection.provider) ??
    getVideoGenProviderDef(DEFAULT_VIDEO_GEN_PROVIDER)!;
  const apiKey = await resolveVideoGenApiKey(def);
  const override =
    params.mode === "text" ? selection.textToVideoModel : selection.imageToVideoModel;
  const models = videoModelChain(def, params.mode, override);
  const key = videoGenHealthKey(def.id);

  let primaryError: unknown;
  for (let i = 0; i < models.length; i++) {
    const model = models[i]!;
    try {
      const result = await def.generate(
        {
          prompt: params.prompt,
          aspectRatio: params.aspectRatio,
          durationSec: params.durationSec,
          model,
          image: params.mode === "image" ? params.image : undefined,
        },
        apiKey,
      );
      recordProviderSuccess(key);
      return result;
    } catch (error) {
      const transient = isTransientVideoGenError(error);
      if (i === 0) {
        primaryError = error;
        // A rejected prompt or a missing key fails identically everywhere.
        if (!transient) throw error;
      }
      if (transient) {
        recordProviderFailure(key, error instanceof Error ? error.message : undefined);
      }
      // A fallback model this account cannot reach ("model not found", "no
      // access") is that model's problem, not the tenant's — keep walking the
      // chain, and report the model they actually configured if none works.
      const next = models[i + 1];
      if (next) {
        logger.warn(
          { provider: def.id, model, fallbackModel: next, err: error },
          "Video model failed; retrying on the next model",
        );
      }
    }
  }

  throw primaryError ?? new VideoGenProviderError("Video generation failed. Please try again.");
}
