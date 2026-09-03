import { db, videoGenSettingsTable, appCredentialsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../logger";
import {
  getProviderHealth,
  isProviderHealthy,
  recordProviderFailure,
  recordProviderSuccess,
} from "../providerHealth";
import { isVideoModelPriced } from "../aiCost";
import type { VideoJobOptions, VideoPriceCriteria } from "@workspace/db";
import { videoPriceCriteria } from "./pricing";
import {
  notifyVideoGenFailover,
  resolveVideoGenFailoverNotifications,
} from "../notifications";
import { encryptJson, decryptJson } from "../secretCrypto";
import {
  generateWithReplicate,
  REPLICATE_T2V_MODEL,
  REPLICATE_I2V_MODEL,
} from "./providers/replicate";
import {
  generateWithOpenRouterVideo,
  OPENROUTER_T2V_MODEL,
  OPENROUTER_I2V_MODEL,
} from "./providers/openrouter";
import { generateWithMappedVideo } from "./providers/mapped";
import {
  generateWithNvidiaNimVideo,
  NVIDIA_NIM_VIDEO_MODEL,
} from "./providers/nvidia";
import {
  isNvidiaCoreDeploymentActivatable,
  resolveNvidiaCoreDeployment,
} from "../nvidiaCore";
import { isTransientStatus } from "./retry";
import {
  parseCustomProviderId,
  resolveCustomProvider,
  decryptCustomProviderKey,
  customProviderRef,
} from "../customAiProviders";
import type { CustomAiProvider as CustomAiProviderRow } from "@workspace/db";
import { VideoGenNotConfiguredError, VideoGenProviderError } from "./types";
import type { SourceImage, VideoAspect, VideoGenInput, VideoGenResult } from "./types";
import {
  VIDEO_MODEL_CATALOG,
  findVideoModel,
  resolveModelOptions,
  supportsMode,
  type VideoModelDef,
} from "./modelCatalog";
import { applyManualOrder, getAiFallbackOrders } from "../aiFallbackSettings";

export { VideoGenNotConfiguredError, VideoGenProviderError, compiledClipPrompt } from "./types";
export type { SourceImage, VideoAspect, VideoGenInput, VideoGenResult } from "./types";

export const DEFAULT_VIDEO_GEN_PROVIDER = "replicate";

/** Which AI video engine a model override applies to. */
export type VideoGenMode = "text" | "image";

const NATIVE_SYNCHRONIZED_AUDIO_MODELS = new Set([
  "openrouter/bytedance/seedance-2.5",
]);

/**
 * Models whose normal generation call creates its own synchronized dialogue
 * audio. Guided Story must not replace that audio with a second Replicate pass.
 */
export function hasNativeSynchronizedAudio(provider: string, model: string): boolean {
  return NATIVE_SYNCHRONIZED_AUDIO_MODELS.has(
    `${provider.trim().toLowerCase()}/${model.trim().toLowerCase()}`,
  );
}

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

function catalogModelOptions(
  provider: VideoModelDef["provider"],
  mode: VideoGenMode,
): { value: string; label: string }[] {
  const seen = new Set<string>();
  return VIDEO_MODEL_CATALOG.flatMap((def) => {
    if (def.provider !== provider) return [];
    const model = def.models[mode];
    if (!model || seen.has(model)) return [];
    seen.add(model);
    return [{ value: model, label: `${def.label} (${model})` }];
  });
}

const RETIRED_REPLICATE_MODEL_OVERRIDES = new Set([
  "minimax/video-01",
  "google/veo-3.1",
]);

function normalizedPersistedModelOverride(
  provider: string,
  model: string | null | undefined,
): string | null {
  const trimmed = model?.trim() || null;
  return provider === "replicate" && trimmed && RETIRED_REPLICATE_MODEL_OVERRIDES.has(trimmed)
    ? null
    : trimmed;
}

/** Catalog of selectable AI video generation providers. Add new ones here only. */
export const VIDEO_GEN_PROVIDERS: readonly VideoGenProviderDef[] = [
  {
    id: "nvidia",
    label: "NVIDIA Visual GenAI NIM (self-hosted)",
    defaultTextToVideoModel: NVIDIA_NIM_VIDEO_MODEL,
    defaultImageToVideoModel: NVIDIA_NIM_VIDEO_MODEL,
    envKey: "",
    supportsModelOverride: false,
    textModelOptions: catalogModelOptions("nvidia", "text"),
    imageModelOptions: catalogModelOptions("nvidia", "image"),
    generate: generateWithNvidiaNimVideo,
  },
  {
    id: "replicate",
    label: "Replicate",
    defaultTextToVideoModel: REPLICATE_T2V_MODEL,
    defaultImageToVideoModel: REPLICATE_I2V_MODEL,
    envKey: "REPLICATE_API_TOKEN",
    supportsModelOverride: true,
    // Keep the legacy provider overrides on exactly the same curated catalog
    // that tenants can select. This prevents stale/delisted dropdown entries
    // from being priced or activated under a model the runtime no longer
    // advertises.
    textModelOptions: catalogModelOptions("replicate", "text"),
    imageModelOptions: catalogModelOptions("replicate", "image"),
    generate: generateWithReplicate,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    defaultTextToVideoModel: OPENROUTER_T2V_MODEL,
    defaultImageToVideoModel: OPENROUTER_I2V_MODEL,
    envKey: "OPENROUTER_API_KEY",
    supportsModelOverride: true,
    textModelOptions: catalogModelOptions("openrouter", "text"),
    imageModelOptions: catalogModelOptions("openrouter", "image"),
    generate: generateWithOpenRouterVideo,
  },
] as const;

export function getVideoGenProviderDef(id: string): VideoGenProviderDef | undefined {
  return VIDEO_GEN_PROVIDERS.find((p) => p.id === id);
}

/**
 * A provider def built on the fly from an admin-added custom provider row
 * ("custom:<id>", customAiProviders.ts). The row's videoApi mapping decides
 * the API shape: null or template "openrouter" means the OpenRouter-shaped
 * async video API (POST {baseUrl}/videos, poll GET {baseUrl}/videos/{id},
 * download unsigned_urls); template "custom" drives the generic mapped
 * adapter (providers/mapped.ts) with the admin-configured endpoint and JSON
 * field paths. There are no default models: the admin must set both engine
 * model overrides in the video settings (the PUT route enforces this).
 */
export function customVideoGenDef(row: CustomAiProviderRow): VideoGenProviderDef {
  return {
    id: customProviderRef(row.id),
    label: `${row.name} (custom)`,
    defaultTextToVideoModel: "",
    defaultImageToVideoModel: "",
    // Key lives on the row, not in env — resolveVideoGenApiKey branches on
    // the custom prefix, so this is never read for custom defs.
    envKey: "",
    supportsModelOverride: true,
    generate: async (input, apiKey) => {
      const mapping = row.videoApi;
      const result =
        mapping && mapping.template === "custom"
          ? await generateWithMappedVideo(input, apiKey, {
              baseUrl: row.baseUrl,
              label: row.name,
              mapping,
            })
          : await generateWithOpenRouterVideo(input, apiKey, {
              baseUrl: row.baseUrl,
              label: row.name,
            });
      // Keep the custom identity so usage/cost rows attribute to
      // "custom:<id>", not the generic adapter id.
      return { ...result, provider: customProviderRef(row.id) };
    },
  };
}

/**
 * Like getVideoGenProviderDef but also resolves "custom:<id>" refs against
 * the custom_ai_providers table (only when video use is enabled).
 */
export async function resolveVideoGenProviderDef(
  id: string,
): Promise<VideoGenProviderDef | undefined> {
  const staticDef = getVideoGenProviderDef(id);
  if (staticDef) return staticDef;
  if (parseCustomProviderId(id) === null) return undefined;
  const row = await resolveCustomProvider(id);
  if (!row || !row.videoEnabled) return undefined;
  return customVideoGenDef(row);
}

/** app_credentials row name for a provider's stored video-gen key. */
function videoGenCredentialProvider(providerId: string): string {
  return `videogen_${providerId}`;
}

interface StoredVideoGenKey {
  apiKey: string;
}

/** Decrypted apiKey from one app_credentials row, or null. */
async function storedKeyForCredentialProvider(credProvider: string): Promise<string | null> {
  const row = (
    await db
      .select()
      .from(appCredentialsTable)
      .where(eq(appCredentialsTable.provider, credProvider))
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

/** The API key saved by a superadmin in the admin screen (encrypted at rest), or null. */
export async function getStoredVideoGenKey(providerId: string): Promise<string | null> {
  const own = await storedKeyForCredentialProvider(videoGenCredentialProvider(providerId));
  if (own) return own;
  // A Replicate token is account-wide, not capability-specific. Older Admin
  // screens stored it under whichever card the user filled first, so let video,
  // music, lip-sync and text reuse the image-generation row as well.
  if (providerId === "replicate") {
    return storedKeyForCredentialProvider("imagegen_replicate");
  }
  // OpenRouter deliberately shares the key the admin saved for TEXT
  // generation (stored under textgen_openrouter) — one key, one place to
  // rotate it — mirroring how Replicate text gen borrows the video-gen key.
  if (providerId === "openrouter") {
    return storedKeyForCredentialProvider("textgen_openrouter");
  }
  return null;
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

/**
 * Where the provider credential/configuration comes from. Admin-entered DB
 * keys win over environment secrets. NVIDIA video is different: its
 * self-hosted deployment (including an optional endpoint key) is stored in
 * the NVIDIA deployment record, so that record is its database source even
 * when the endpoint deliberately requires no key.
 */
export async function getVideoGenKeySource(def: VideoGenProviderDef): Promise<VideoGenKeySource> {
  if (def.id === "nvidia") {
    return (await resolveNvidiaCoreDeployment("video")) ? "database" : null;
  }
  if (parseCustomProviderId(def.id) !== null) {
    // Custom providers keep their key on their own row (keyless is allowed,
    // so a missing key still counts as configured-from-database).
    return "database";
  }
  if (await getStoredVideoGenKey(def.id)) return "database";
  if (process.env[def.envKey]) return "env";
  return null;
}

/** The effective API key for a provider (DB first, then env), or null. */
export async function resolveVideoGenApiKey(def: VideoGenProviderDef): Promise<string | null> {
  if (def.id === "nvidia") {
    const deployment = await resolveNvidiaCoreDeployment("video");
    if (!deployment || !(await isNvidiaCoreDeploymentActivatable("video"))) return null;
    // Keyless self-hosted NIMs are valid. The adapter resolves the deployment
    // itself and never sends this sentinel as a bearer token.
    return deployment.resolvedApiKey ?? "no-key-required";
  }
  if (parseCustomProviderId(def.id) !== null) {
    const row = await resolveCustomProvider(def.id);
    if (!row) return null;
    // Keyless self-hosted endpoints are allowed; the generator requires a
    // non-null bearer, so send a placeholder the server will ignore.
    return decryptCustomProviderKey(row) ?? "no-key-required";
  }
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
  /**
   * Catalog models tenants may pick per generation. null = every model (the
   * untouched default); [] = none, so every job runs on the platform
   * selection exactly as it did before per-generation choice existed.
   */
  enabledModelIds: string[] | null;
  /** Replicate model for portrait lip sync; null = portrait mode is off. */
  lipSyncPortraitModel: string | null;
  /** Initial value of the per-job optional Studio control. */
  studioLipSyncDefault: boolean;
}

/** The current selection. A missing settings row uses the platform default;
 * an invalid persisted provider is intentionally preserved so enqueue can
 * reject it rather than silently switching an intended provider/model. */
export async function getVideoGenSelection(): Promise<VideoGenSelection> {
  const row = (await db.select().from(videoGenSettingsTable).limit(1))[0];
  const id = row?.provider ?? DEFAULT_VIDEO_GEN_PROVIDER;
  const def = await resolveVideoGenProviderDef(id);
  if (!def) {
    return {
      provider: id,
      textToVideoModel: null,
      imageToVideoModel: null,
      enabledModelIds: row?.enabledModelIds ?? null,
      lipSyncPortraitModel: row?.lipSyncPortraitModel ?? null,
      studioLipSyncDefault: row?.studioLipSyncDefault ?? false,
    };
  }
  return {
    provider: id,
    // The two retired legacy dropdown values must not remain active invisibly
    // after disappearing from the catalog. Other free-text overrides were
    // explicitly entered by an admin and remain supported.
    textToVideoModel: normalizedPersistedModelOverride(id, row?.textToVideoModel),
    imageToVideoModel: normalizedPersistedModelOverride(id, row?.imageToVideoModel),
    enabledModelIds: row?.enabledModelIds ?? null,
    lipSyncPortraitModel: row?.lipSyncPortraitModel ?? null,
    studioLipSyncDefault: row?.studioLipSyncDefault ?? false,
  };
}

/**
 * The catalog models a tenant may actually pick right now: on the admin's
 * allowlist (or all of them, when there is none) AND served by a provider
 * whose key is saved. Offering a model whose provider is unconfigured would
 * be offering a job that preflight is about to refuse.
 */
export async function isCatalogVideoModelPriced(
  provider: string,
  nativeModel: string,
): Promise<boolean | null> {
  const matches = VIDEO_MODEL_CATALOG.filter(
    (model) =>
      model.provider === provider &&
      (model.models.text === nativeModel || model.models.image === nativeModel),
  );
  if (matches.length === 0) return null;

  for (const model of matches) {
    for (const mode of ["text", "image"] as const) {
      if (model.models[mode] !== nativeModel) continue;
      const qualities = model.hasQuality ? ["basic", "high"] : [null];
      const audioValues = model.canGenerateAudio ? [false, true] : [null];
      for (const durationSec of model.durations) {
        for (const resolution of model.resolutions) {
          for (const quality of qualities) {
            for (const generateAudio of audioValues) {
              if (!(await isVideoModelPriced({
                provider: model.provider,
                model: nativeModel,
                durationSec,
                variantCriteria: videoPriceCriteria({
                  resolution,
                  quality,
                  generateAudio,
                }),
              }).catch(() => false))) {
                return false;
              }
            }
          }
        }
      }
    }
  }
  return true;
}

export async function availableVideoModels(
  options: { ignoreAllowlist?: boolean } = {},
): Promise<VideoModelDef[]> {
  const { enabledModelIds } = await getVideoGenSelection();
  const allowed =
    options.ignoreAllowlist || enabledModelIds === null
      ? null
      : new Set(enabledModelIds);
  const configured = new Map<string, boolean>();
  for (const def of VIDEO_GEN_PROVIDERS) {
    configured.set(def.id, await isVideoGenProviderConfigured(def));
  }
  const available: VideoModelDef[] = [];
  for (const model of VIDEO_MODEL_CATALOG) {
    if (
      (allowed !== null && !allowed.has(model.id)) ||
      configured.get(model.provider) !== true
    ) continue;
    let priced = true;
    for (const nativeModel of new Set(
      [model.models.text, model.models.image].filter(
        (candidate): candidate is string => Boolean(candidate),
      ),
    )) {
      if ((await isCatalogVideoModelPriced(model.provider, nativeModel)) !== true) {
        priced = false;
        break;
      }
    }
    if (priced) available.push(model);
  }
  return available;
}

export type ResolvedVideoModelSnapshot = NonNullable<
  VideoJobOptions["resolvedVideoModel"]
>;

export class VideoModelResolutionError extends VideoGenNotConfiguredError {
  constructor(
    message: string,
    readonly code:
      | "video_model_invalid"
      | "video_model_incompatible"
      | "video_provider_unconfigured"
      | "video_model_unpriced",
    readonly provider: string | null,
    readonly model: string | null,
  ) {
    super(message);
    this.name = "VideoModelResolutionError";
  }
}

/** Resolve the mutable admin/default selection into a durable execution contract. */
export async function resolveVideoModelSnapshot(args: {
  mode: VideoGenMode;
  modelId?: string | null;
  durationSec: number;
  resolution?: string | null;
  quality?: string | null;
  generateAudio?: boolean | null;
  /** Composite render paths can make several fixed scene-duration calls. */
  permittedDurationSec?: number[];
}): Promise<ResolvedVideoModelSnapshot> {
  const picked = findVideoModel(args.modelId);
  if (args.modelId && !picked) {
    throw new VideoModelResolutionError(
      "That video model is not available.",
      "video_model_invalid",
      null,
      null,
    );
  }
  if (picked && !supportsMode(picked, args.mode)) {
    throw new VideoModelResolutionError(
      `${picked.label} does not support ${args.mode === "text" ? "text-to-video" : "image-to-video"}.`,
      "video_model_incompatible",
      picked.provider,
      picked.models[args.mode] ?? null,
    );
  }
  const selection = picked ? null : await getVideoGenSelection();
  const provider = picked?.provider ?? selection!.provider;
  const def = await resolveVideoGenProviderDef(provider);
  const model = picked?.models[args.mode] ??
    (def
      ? effectiveVideoModel(
          def,
          args.mode,
          args.mode === "text"
            ? selection!.textToVideoModel
            : selection!.imageToVideoModel,
        )
      : "");
  if (!def || !model) {
    throw new VideoModelResolutionError(
      `AI video provider ${provider} has no ${args.mode}-to-video model configured.`,
      "video_model_invalid",
      provider,
      model || null,
    );
  }
  const catalogModel = picked ?? VIDEO_MODEL_CATALOG.find((candidate) =>
    candidate.provider === provider && candidate.models[args.mode] === model,
  );
  if (!(await isVideoGenProviderConfigured(def))) {
    throw new VideoModelResolutionError(
      `AI video provider ${provider} is not configured.`,
      "video_provider_unconfigured",
      provider,
      model,
    );
  }
  const normalized = catalogModel
    ? resolveModelOptions(
        {
          modelId: catalogModel.id,
          durationSec: args.durationSec,
          resolution: args.resolution,
          quality: args.quality,
          generateAudio: args.generateAudio,
        },
        args.durationSec,
      )
    : {
        durationSec: args.durationSec,
        resolution: args.resolution ?? null,
        quality: args.quality ?? null,
        generateAudio: args.generateAudio ?? null,
      };
  const targetDurations = [...new Set(
    (args.permittedDurationSec?.length ? args.permittedDurationSec : [normalized.durationSec])
      .map((duration) => Math.round(duration * 100) / 100),
  )];
  // Composite scene targets are mapped onto real provider capabilities now,
  // not at dispatch time from mutable catalog data. Equal-distance ties choose
  // the shorter clip to avoid silently purchasing/rendering excess footage.
  const permittedDurationSec = catalogModel && args.permittedDurationSec?.length
    ? [...new Set(targetDurations.map((target) =>
        [...catalogModel.durations].sort((a, b) =>
          Math.abs(a - target) - Math.abs(b - target) || a - b
        )[0]!,
      ))]
    : targetDurations;
  if (!(await Promise.all(permittedDurationSec.map((durationSec) => isVideoModelPriced({
    provider, model, durationSec, variantCriteria: videoPriceCriteria(normalized),
  }).catch(() => false)))).every(Boolean)) {
    throw new VideoModelResolutionError(
      `Video model ${provider}/${model} has no authoritative provider-specific price for the requested variant.`,
      "video_model_unpriced",
      provider,
      model,
    );
  }
  return {
    version: 1,
    source: picked ? "explicit" : "default",
    mode: args.mode,
    provider,
    model,
    catalogModelId: catalogModel?.id ?? null,
    durationSec: normalized.durationSec,
    permittedDurationSec,
    durationPolicy: args.permittedDurationSec?.length ? "nearest" : "exact",
    resolution: normalized.resolution,
    quality: normalized.quality,
    generateAudio: normalized.generateAudio,
    supportsEndFrame: catalogModel?.supportsEndFrame === true,
  };
}

/**
 * Resolve the optional model override for standard video lip sync. The stored
 * setting wins, then the environment; null keeps the pinned model definition.
 */
export async function resolveLipSyncModelRef(): Promise<string | null> {
  try {
    const row = (await db.select().from(videoGenSettingsTable).limit(1))[0];
    const stored = row?.lipSyncModel?.trim();
    if (stored) return stored;
  } catch (error) {
    logger.warn(
      { err: error },
      "Lip-sync model lookup failed; using the pinned default",
    );
  }
  return process.env.LIPSYNC_MODEL?.trim() || null;
}

/**
 * Whether character story videos should speak rather than be narrated over.
 * OFF unless switched on: it doubles the price of every character video, so it
 * is not something a deploy should start doing to existing tenants. Same
 * precedence as the model override — stored setting, then environment.
 */
export async function resolveCharacterLipSync(): Promise<boolean> {
  try {
    const row = (await db.select().from(videoGenSettingsTable).limit(1))[0];
    if (row?.characterLipSync) return true;
  } catch (error) {
    logger.warn({ err: error }, "Character lip-sync lookup failed; leaving it off");
  }
  return /^(1|true|on|yes)$/i.test(process.env.CHARACTER_LIPSYNC?.trim() ?? "");
}

/**
 * Persist the platform-wide selection (superadmin only; the route validates
 * the provider id against the catalog).
 *
 * Omitted optional settings retain their current values so older admin clients
 * cannot silently clear newer controls.
 */
export async function setVideoGenSelection(
  selection: Omit<
    VideoGenSelection,
    "enabledModelIds" | "lipSyncPortraitModel" | "studioLipSyncDefault"
  > &
    Partial<
      Pick<
        VideoGenSelection,
        "enabledModelIds" | "lipSyncPortraitModel" | "studioLipSyncDefault"
      >
    >,
): Promise<void> {
  const current =
    selection.enabledModelIds === undefined ||
    selection.lipSyncPortraitModel === undefined ||
    selection.studioLipSyncDefault === undefined
      ? await getVideoGenSelection()
      : null;
  const row = {
    provider: selection.provider,
    textToVideoModel: selection.textToVideoModel,
    imageToVideoModel: selection.imageToVideoModel,
    enabledModelIds:
      selection.enabledModelIds === undefined
        ? (current?.enabledModelIds ?? null)
        : selection.enabledModelIds,
    lipSyncPortraitModel:
      selection.lipSyncPortraitModel === undefined
        ? (current?.lipSyncPortraitModel ?? null)
        : (selection.lipSyncPortraitModel?.trim() || null),
    studioLipSyncDefault:
      selection.studioLipSyncDefault === undefined
        ? (current?.studioLipSyncDefault ?? false)
        : selection.studioLipSyncDefault,
  };
  await db
    .insert(videoGenSettingsTable)
    .values({ id: 1, ...row })
    .onConflictDoUpdate({
      target: videoGenSettingsTable.id,
      set: { ...row, updatedAt: new Date() },
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
 * other catalog choices for this engine. A queue backed up behind one hosted
 * model is the common failure, and the same account's other models are
 * usually fine — so the model chain is walked first, and only when the WHOLE
 * provider looks down does provider-level failover kick in (below).
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
 * A healthy, configured, PRICED substitute provider for a down primary — or
 * null. Only the static catalog qualifies (custom providers have no default
 * models to fall back to, and there is no safe way to guess a model for
 * them). The pricing gate mirrors text-gen failover: the substitute
 * provider's default model for this engine must have a price row in
 * ai_model_prices, or no failover happens — a diverted job must still record
 * its true cost against the serving provider.
 */
export interface VideoGenFailoverCandidate {
  def: VideoGenProviderDef;
  model: string;
  apiKey: string;
}

export async function resolveVideoGenFailoverCandidate(
  primaryProviderId: string,
  mode: VideoGenMode,
  variantCriteria = videoPriceCriteria({}),
): Promise<VideoGenFailoverCandidate | null> {
  const family = mode === "text" ? "text-to-video" : "image-to-video";
  const savedOrder = (await getAiFallbackOrders())[family];
  const historical = VIDEO_GEN_PROVIDERS
    .filter((def) => savedOrder !== undefined || def.id !== primaryProviderId)
    .flatMap((def) => {
      const defaultModel = mode === "text" ? def.defaultTextToVideoModel : def.defaultImageToVideoModel;
      // Historical chain had one default model/provider. A configured manual
      // chain may deliberately select any catalog model, including another
      // model from the same provider.
      const models = savedOrder === undefined
        ? [defaultModel]
        : [...new Set([defaultModel, ...((mode === "text" ? def.textModelOptions : def.imageModelOptions) ?? []).map((option) => option.value)])];
      return models
        .filter((model) => savedOrder !== undefined || def.id !== primaryProviderId)
        .map((model) => ({ def, model }));
    });
  const candidates = applyManualOrder(
    historical,
    savedOrder,
    (candidate) => `${candidate.def.id}::${candidate.model}`,
  );
  for (const { def, model } of candidates) {
    if (!isProviderHealthy(videoGenHealthKey(def.id))) continue;
    const apiKey = await resolveVideoGenApiKey(def);
    if (!apiKey) continue;
    if (!model) continue;
    // Pricing gate: no price row for the substitute → no failover. Same
    // lookup semantics as cost capture (model-only fallback included).
    try {
      if (!(await isVideoModelPriced({ provider: def.id, model, durationSec: 5, variantCriteria }))) continue;
    } catch {
      continue;
    }
    return { def, model, apiKey };
  }
  return null;
}

/**
 * Static providers (other than the primary) that COULD serve a failover for
 * at least one engine: configured, with a priced default model. Health is
 * deliberately not filtered here — preflight combines these keys with the
 * primary's and passes when ANY of them is healthy, the same bar the runtime
 * failover uses.
 */
export async function videoGenFailoverProviderIds(
  primaryProviderId: string,
  variantCriteria = videoPriceCriteria({}),
): Promise<string[]> {
  const ids: string[] = [];
  for (const def of VIDEO_GEN_PROVIDERS) {
    if (def.id === primaryProviderId) continue;
    if (!(await resolveVideoGenApiKey(def))) continue;
    const priced = await Promise.all(
      [def.defaultTextToVideoModel, def.defaultImageToVideoModel]
        .filter(Boolean)
        .map((model) =>
          isVideoModelPriced({ provider: def.id, model, durationSec: 5, variantCriteria }).catch(() => false),
        ),
    );
    if (priced.some(Boolean)) ids.push(def.id);
  }
  return ids;
}

/** How long one admin notification covers an ongoing outage (in-memory). */
const NOTIFY_WINDOW_MS = 10 * 60 * 1000;
const lastNotifiedAt = new Map<string, number>();

/** Test-only: re-arm the once-per-window notification throttle. */
export function resetVideoGenFailoverNotifyThrottleForTests(): void {
  lastNotifiedAt.clear();
}

/**
 * Fire the superadmin alert at most once per outage window per primary
 * provider. The DB layer additionally dedupes on the unread row (updates it
 * in place), so even across the window boundary one outage means one banner.
 * Best-effort: never throws, never blocks the generation.
 */
function notifyOncePerWindow(args: {
  fromProvider: string;
  toProvider: string;
  model: string;
  lastError: string | null;
}): void {
  const now = Date.now();
  const last = lastNotifiedAt.get(args.fromProvider) ?? 0;
  if (now - last < NOTIFY_WINDOW_MS) return;
  lastNotifiedAt.set(args.fromProvider, now);
  void notifyVideoGenFailover(args).catch(() => {});
}

/** Test seam: candidate resolution can be overridden in unit tests. */
export interface VideoGenFailoverDeps {
  resolveCandidate?: (
    primaryProviderId: string,
    mode: VideoGenMode,
    variantCriteria?: VideoPriceCriteria,
  ) => Promise<VideoGenFailoverCandidate | null>;
}

/**
 * Generate a video using the currently selected provider.
 *
 * Reliability, in two tiers:
 *  1. a transient upstream failure (429/5xx/network/timeout) retries on the
 *     provider's next catalog model rather than failing a job the tenant has
 *     already paid a video unit for;
 *  2. when the WHOLE selected provider is down — its model chain exhausted
 *     on transient errors, or its breaker already open — the job is served
 *     by another configured static provider (pricing gate respected, the
 *     result attributes cost to the provider that really served it), and a
 *     deduped superadmin alert fires once per outage window.
 *
 * Permanent failures — a prompt the safety filter rejected, a missing key —
 * fail immediately, because another model or provider would reject them too.
 */
export async function generateVideo(
  params: {
    mode: VideoGenMode;
    prompt: string;
    aspectRatio: VideoAspect;
    durationSec: number;
    image?: SourceImage;
    /** Optional last frame, on models that interpolate between two stills. */
    endImage?: SourceImage;
    /** Deterministic sampling seed; omitted means "the provider's choice". */
    seed?: number | null;
    /**
     * A catalog model this job explicitly picked (lib/videoGen/modelCatalog.ts).
     * When set it overrides the platform selection for this job only: its
     * provider serves the request and its slug heads the model chain. Absent
     * means the admin's platform selection, exactly as before per-generation
     * model choice existed.
     */
    modelId?: string | null;
    /** Required immutable enqueue-time provider/model contract. */
    resolvedVideoModel?: ResolvedVideoModelSnapshot | null;
    resolution?: string | null;
    quality?: string | null;
    generateAudio?: boolean | null;
  },
  deps: VideoGenFailoverDeps = {},
): Promise<VideoGenResult> {
  const snapshot = params.resolvedVideoModel;
  if (!snapshot || snapshot.version !== 1) {
    throw new VideoModelResolutionError(
      "This job has no frozen video provider/model snapshot.",
      "video_model_invalid",
      null,
      null,
    );
  }
  if (snapshot.mode !== params.mode) {
    throw new VideoModelResolutionError(
      `Frozen video model ${snapshot.provider}/${snapshot.model} is incompatible with this ${params.mode}-to-video request.`,
      "video_model_incompatible",
      snapshot.provider,
      snapshot.model,
    );
  }
  const permittedDurations = snapshot.permittedDurationSec ?? [snapshot.durationSec];
  const dispatchDurationSec = permittedDurations.includes(params.durationSec)
    ? params.durationSec
    : snapshot.durationPolicy === "nearest"
      ? [...permittedDurations].sort((a, b) =>
          Math.abs(a - params.durationSec) - Math.abs(b - params.durationSec) || a - b
        )[0]
      : undefined;
  if (dispatchDurationSec === undefined) {
    throw new VideoModelResolutionError(
      `Video duration ${params.durationSec}s is outside this job's funded video model contract.`,
      "video_model_incompatible",
      snapshot.provider,
      snapshot.model,
    );
  }
  const def = await resolveVideoGenProviderDef(snapshot.provider);
  if (!def) {
    throw new VideoModelResolutionError(
      `Frozen video provider ${snapshot.provider} is no longer configured.`,
      "video_provider_unconfigured",
      snapshot.provider,
      snapshot.model,
    );
  }
  const key = videoGenHealthKey(def.id);

  const input = (model: string, withEndFrame = true): VideoGenInput => ({
    prompt: params.prompt,
    aspectRatio: params.aspectRatio,
    durationSec: dispatchDurationSec,
    model,
    seed: params.seed ?? null,
    resolution: snapshot.resolution,
    quality: snapshot.quality,
    generateAudio: snapshot.generateAudio,
    image: params.mode === "image" ? params.image : undefined,
    endImage: params.mode === "image" && withEndFrame ? params.endImage : undefined,
  });

  /**
   * Run one model, and if it rejects the request outright WITH an end frame
   * attached, try it once more without.
   *
   * The catalog says which models interpolate between two stills, but model
   * input schemas move under us: a hosted model can drop or rename the key
   * between one week and the next. When that happens the honest outcome is a
   * plain animation from the start frame — the user still gets the video they
   * paid a unit for — rather than a hard failure over an optional extra.
   */
  const runModel = async (
    generate: (i: VideoGenInput) => Promise<VideoGenResult>,
    provider: string,
    model: string,
  ): Promise<VideoGenResult> => {
    if (
      !(await isVideoModelPriced({
        provider,
        model,
        durationSec: dispatchDurationSec,
        variantCriteria: videoPriceCriteria({
          resolution: snapshot.resolution,
          quality: snapshot.quality,
          generateAudio: snapshot.generateAudio,
        }),
      }))
    ) {
      throw new VideoModelResolutionError(
        `Video model ${provider}/${model} has no authoritative price. Configure its catalog price before generating.`,
        "video_model_unpriced",
        provider,
        model,
      );
    }
    try {
      return {
        ...(await generate(input(model))),
        effectiveDurationSec: dispatchDurationSec,
      };
    } catch (error) {
      const rejected =
        error instanceof VideoGenProviderError &&
        typeof error.status === "number" &&
        error.status >= 400 &&
        error.status < 500;
      if (!rejected || !params.endImage || params.mode !== "image") throw error;
      logger.warn(
        { model, err: error },
        "Model rejected the request with an end frame; retrying from the start frame only",
      );
      return {
        ...(await generate(input(model, false))),
        effectiveDurationSec: dispatchDurationSec,
      };
    }
  };

  const apiKey = await resolveVideoGenApiKey(def);
  if (!apiKey) {
    throw new VideoModelResolutionError(
      `Frozen video provider ${snapshot.provider} has no usable credential.`,
      "video_provider_unconfigured",
      snapshot.provider,
      snapshot.model,
    );
  }
  try {
    const result = await runModel(
      (input) => def.generate(input, apiKey),
      snapshot.provider,
      snapshot.model,
    );
    recordProviderSuccess(key);
    return result;
  } catch (error) {
    if (isTransientVideoGenError(error)) {
      recordProviderFailure(key, error instanceof Error ? error.message : undefined);
    }
    throw error;
  }
}
