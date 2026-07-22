import { db, videoGenSettingsTable, appCredentialsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { encryptJson, decryptJson } from "../secretCrypto";
import {
  generateWithReplicate,
  REPLICATE_T2V_MODEL,
  REPLICATE_I2V_MODEL,
} from "./providers/replicate";
import type { SourceImage, VideoAspect, VideoGenInput, VideoGenResult } from "./types";

export { VideoGenNotConfiguredError, VideoGenProviderError } from "./types";
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
    textModelOptions: [
      { value: REPLICATE_T2V_MODEL, label: "WAN 2.2 Fast (wan-video/wan-2.2-t2v-fast)" },
      { value: "google/veo-3-fast", label: "Google Veo 3 Fast (google/veo-3-fast)" },
      { value: "minimax/video-01", label: "MiniMax Video-01 (minimax/video-01)" },
      { value: "kwaivgi/kling-v2.1-standard", label: "Kling 2.1 (kwaivgi/kling-v2.1-standard)" },
    ],
    imageModelOptions: [
      { value: REPLICATE_I2V_MODEL, label: "WAN 2.2 Fast (wan-video/wan-2.2-i2v-fast)" },
      { value: "minimax/video-01", label: "MiniMax Video-01 (minimax/video-01)" },
      { value: "kwaivgi/kling-v2.1-standard", label: "Kling 2.1 (kwaivgi/kling-v2.1-standard)" },
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

/** Generate a video using the currently selected provider. */
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
  return def.generate(
    {
      prompt: params.prompt,
      aspectRatio: params.aspectRatio,
      durationSec: params.durationSec,
      model: effectiveVideoModel(def, params.mode, override),
      image: params.mode === "image" ? params.image : undefined,
    },
    apiKey,
  );
}
