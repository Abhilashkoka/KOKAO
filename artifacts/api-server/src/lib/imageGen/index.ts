import { db, imageGenSettingsTable, appCredentialsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../logger";
import { recordProviderFailure, recordProviderSuccess, orderByHealth } from "../providerHealth";
import { isFeatureEnabled } from "../featureFlags";
import { rankProviders, explainWinner, type ScoredProvider } from "../providerScore";
import { imageUnitCostsPaise, isImageModelPriced } from "../aiCost";
import { encryptJson, decryptJson } from "../secretCrypto";
import {
  clearNvidiaHostedApiKey,
  getNvidiaCoreConfigView,
  isNvidiaCoreDeploymentActivatable,
  resolveNvidiaCoreDeployment,
  resolveNvidiaHostedApiKey,
  setNvidiaHostedApiKey,
} from "../nvidiaCore";
import {
  parseCustomProviderId,
  resolveCustomProvider,
  decryptCustomProviderKey,
  customProviderRef,
} from "../customAiProviders";
import type { CustomAiProvider as CustomAiProviderRow } from "@workspace/db";
import { generateWithOpenAIBuiltin, OPENAI_BUILTIN_MODEL } from "./providers/openaiBuiltin";
import { generateWithGemini, GEMINI_IMAGE_MODEL } from "./providers/gemini";
import { generateWithStability, STABILITY_MODEL } from "./providers/stability";
import { generateWithReplicate, REPLICATE_MODEL } from "./providers/replicate";
import { generateWithOpenAICompatible } from "./providers/openaiCompatible";
import { generateWithBfl, BFL_MODEL } from "./providers/bfl";
import { generateWithSeedream, SEEDREAM_MODEL } from "./providers/seedream";
import { generateWithOpenRouter, OPENROUTER_IMAGE_MODEL } from "./providers/openrouter";
import { generateWithNvidia, NVIDIA_SDXL_MODEL } from "./providers/nvidia";
import sharp from "sharp";
import {
  ImageGenNotConfiguredError,
  ImageGenProviderError,
  ImagePreservationError,
  type ExactMaskedEdit,
  type ImageGenInput,
  type ImageGenResult,
  type ImageSize,
  type ReferenceImage,
  type RoutedImageGenResult,
} from "./types";

export { ImageGenNotConfiguredError, ImageGenProviderError, ImagePreservationError } from "./types";
export type {
  ExactMaskedEdit,
  ImageGenInput,
  ImageGenResult,
  ImageSize,
  NormalizedProtectedRectangle,
  ReferenceImage,
  RoutedImageGenResult,
} from "./types";

export const DEFAULT_IMAGE_GEN_PROVIDER = "openai";

/**
 * Sentinel provider id meaning "let the scorer pick, per generation".
 *
 * It lives in the same free-text `provider` settings column as a real catalog
 * id rather than in a second column, because the two are mutually exclusive
 * choices about the same thing — a boolean beside the id would let the
 * settings row express "auto, but also pinned to bfl", which has no meaning.
 * A test asserts no catalog id ever collides with it.
 */
export const IMAGE_GEN_AUTO = "auto";

export interface ImageGenProviderDef {
  id: string;
  label: string;
  defaultModel: string;
  /** Secret required to use this provider; null = uses the built-in OpenAI integration. */
  envKey: string | null;
  /** Whether the admin may override the model name for this provider. */
  supportsModelOverride: boolean;
  /** Whether this provider needs an admin-entered base URL ("custom" only). */
  requiresBaseUrl: boolean;
  /** Suggested model choices shown in the admin UI (free text still allowed). */
  modelOptions?: readonly { value: string; label: string }[];
  /** Whether this provider accepts a reference image (image-to-image). When
   * false, reference guidance reaches the provider as prompt text only. */
  supportsImageInput: boolean;
  /**
   * Whether this provider can return a PNG with a real alpha channel when
   * asked (ImageGenInput.transparent). Layered generation is hard-filtered on
   * this the same way reference images are filtered on supportsImageInput:
   * a matte-from-white fallback looks fine in a thumbnail and falls apart the
   * moment a designer moves the layer, so "nearly transparent" is worse than
   * an honest error. Today only gpt-image-1 qualifies.
   */
  supportsTransparency: boolean;
  /** Whether this adapter supports a multipart source-image + exact alpha mask edit. */
  supportsExactMaskedEdits: boolean;
  /**
   * Editorial output-quality tier in 0..1, used only when automatic routing is
   * on. A judgement about this model family for the kind of work KOKAO does —
   * brand and product imagery with legible text — not a benchmark score.
   * Deliberately coarse: three or four distinct values is all the resolution
   * this deserves, because pretending to two decimals of accuracy would invite
   * arguments the number cannot settle. Omitted means "no opinion", which
   * scores neutrally rather than badly.
   */
  quality?: number;
  /** Require an exact provider/model flat price before any paid work starts. */
  requiresPrice?: boolean;
  generate: (input: ImageGenInput, apiKey: string | null) => Promise<ImageGenResult>;
}

/** Catalog of selectable image generation providers. Add new ones here only. */
export const IMAGE_GEN_PROVIDERS: readonly ImageGenProviderDef[] = [
  {
    id: "openai",
    label: "OpenAI (built in, no key needed)",
    defaultModel: OPENAI_BUILTIN_MODEL,
    envKey: null,
    supportsModelOverride: false,
    requiresBaseUrl: false,
    supportsImageInput: true,
    supportsTransparency: true,
    supportsExactMaskedEdits: true,
    quality: 0.85,
    generate: generateWithOpenAIBuiltin,
  },
  {
    id: "gemini",
    label: "Google Gemini",
    defaultModel: GEMINI_IMAGE_MODEL,
    envKey: "GEMINI_API_KEY",
    supportsModelOverride: true,
    requiresBaseUrl: false,
    modelOptions: [
      { value: GEMINI_IMAGE_MODEL, label: "Nano Banana (gemini-2.5-flash-image)" },
      { value: "gemini-3-pro-image-preview", label: "Nano Banana Pro (gemini-3-pro-image-preview)" },
    ],
    supportsImageInput: true,
    supportsTransparency: false,
    supportsExactMaskedEdits: false,
    quality: 0.9,
    generate: generateWithGemini,
  },
  {
    id: "bfl",
    label: "Black Forest Labs (FLUX)",
    defaultModel: BFL_MODEL,
    envKey: "BFL_API_KEY",
    supportsModelOverride: true,
    requiresBaseUrl: false,
    modelOptions: [
      { value: "flux-2-pro", label: "FLUX.2 Pro (flux-2-pro)" },
      { value: "flux-2-flex", label: "FLUX.2 Flex (flux-2-flex)" },
      { value: "flux-pro-1.1", label: "FLUX 1.1 Pro (flux-pro-1.1)" },
      { value: "flux-pro-1.1-ultra", label: "FLUX 1.1 Pro Ultra (flux-pro-1.1-ultra)" },
      { value: "flux-dev", label: "FLUX Dev (flux-dev)" },
    ],
    supportsImageInput: false,
    supportsTransparency: false,
    supportsExactMaskedEdits: false,
    quality: 0.9,
    generate: generateWithBfl,
  },
  {
    id: "seedream",
    label: "ByteDance Seedream",
    defaultModel: SEEDREAM_MODEL,
    envKey: "ARK_API_KEY",
    supportsModelOverride: true,
    requiresBaseUrl: false,
    modelOptions: [
      { value: SEEDREAM_MODEL, label: "Seedream 5.0 Pro (seedream-5-0-pro)" },
      { value: "seedream-5-0-260128", label: "Seedream 5.0 Lite (seedream-5-0-260128)" },
      { value: "seedream-4-5-251128", label: "Seedream 4.5 (seedream-4-5-251128)" },
      { value: "seedream-4-0", label: "Seedream 4.0 (seedream-4-0)" },
    ],
    supportsImageInput: true,
    supportsTransparency: false,
    supportsExactMaskedEdits: false,
    quality: 0.8,
    generate: generateWithSeedream,
  },
  {
    id: "stability",
    label: "Stability AI",
    defaultModel: STABILITY_MODEL,
    envKey: "STABILITY_API_KEY",
    supportsModelOverride: true,
    requiresBaseUrl: false,
    supportsImageInput: false,
    supportsTransparency: false,
    supportsExactMaskedEdits: false,
    quality: 0.7,
    generate: generateWithStability,
  },
  {
    id: "replicate",
    label: "Replicate",
    defaultModel: REPLICATE_MODEL,
    envKey: "REPLICATE_API_TOKEN",
    supportsModelOverride: true,
    requiresBaseUrl: false,
    supportsImageInput: false,
    supportsTransparency: false,
    supportsExactMaskedEdits: false,
    quality: 0.7,
    generate: generateWithReplicate,
  },
  {
    id: "openrouter",
    label: "OpenRouter (routes to many image models)",
    defaultModel: OPENROUTER_IMAGE_MODEL,
    envKey: "OPENROUTER_API_KEY",
    supportsModelOverride: true,
    requiresBaseUrl: false,
    modelOptions: [
      { value: "google/gemini-2.5-flash-image", label: "Nano Banana (google/gemini-2.5-flash-image)" },
      { value: "google/gemini-3-pro-image-preview", label: "Nano Banana Pro (google/gemini-3-pro-image-preview)" },
      { value: "openai/gpt-image-1", label: "OpenAI GPT Image (openai/gpt-image-1)" },
    ],
    supportsImageInput: true,
    supportsTransparency: false,
    supportsExactMaskedEdits: false,
    quality: 0.85,
    generate: generateWithOpenRouter,
  },
  {
    id: "nvidia",
    label: "NVIDIA API Catalog / image NIM",
    defaultModel: NVIDIA_SDXL_MODEL,
    envKey: "NVIDIA_API_KEY",
    supportsModelOverride: false,
    requiresBaseUrl: false,
    modelOptions: [
      { value: NVIDIA_SDXL_MODEL, label: `Stable Diffusion XL (${NVIDIA_SDXL_MODEL})` },
    ],
    supportsImageInput: false,
    supportsTransparency: false,
    supportsExactMaskedEdits: false,
    quality: 0.75,
    requiresPrice: true,
    generate: generateWithNvidia,
  },
  {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    defaultModel: "",
    envKey: "CUSTOM_IMAGE_API_KEY",
    supportsModelOverride: true,
    requiresBaseUrl: true,
    supportsImageInput: false,
    supportsTransparency: false,
    supportsExactMaskedEdits: false,
    generate: generateWithOpenAICompatible,
  },
] as const;

export function getImageGenProviderDef(id: string): ImageGenProviderDef | undefined {
  return IMAGE_GEN_PROVIDERS.find((p) => p.id === id);
}

/**
 * A provider def built on the fly from an admin-added custom provider row
 * ("custom:<id>", customAiProviders.ts). The base URL and key live on the
 * row, so the generate closure injects them itself: `requiresBaseUrl` stays
 * false (nothing to enter in the image settings card) and `envKey` stays
 * null (configured-ness comes from the row, not a key lookup). Excluded from
 * automatic routing — auto candidates come from the static catalog only.
 */
export function customImageGenDef(row: CustomAiProviderRow): ImageGenProviderDef {
  const apiKey = decryptCustomProviderKey(row);
  return {
    id: customProviderRef(row.id),
    label: `${row.name} (custom)`,
    defaultModel: "",
    envKey: null,
    supportsModelOverride: true,
    requiresBaseUrl: false,
    supportsImageInput: false,
    supportsTransparency: false,
    supportsExactMaskedEdits: false,
    generate: async (input) => {
      const result = await generateWithOpenAICompatible(
        { ...input, baseUrl: row.baseUrl },
        // OpenAI-compatible endpoints usually need a bearer; keyless
        // self-hosted ones get a placeholder the server ignores.
        apiKey ?? "no-key-required",
      );
      // Keep the custom identity so usage/cost rows attribute to
      // "custom:<id>", not the generic "custom" adapter id.
      return { ...result, provider: customProviderRef(row.id) };
    },
  };
}

/**
 * Like getImageGenProviderDef but also resolves "custom:<id>" refs against
 * the custom_ai_providers table (only when image use is enabled).
 */
export async function resolveImageGenProviderDef(
  id: string,
): Promise<ImageGenProviderDef | undefined> {
  const staticDef = getImageGenProviderDef(id);
  if (staticDef) return staticDef;
  if (parseCustomProviderId(id) === null) return undefined;
  const row = await resolveCustomProvider(id);
  if (!row || !row.imageEnabled) return undefined;
  return customImageGenDef(row);
}

/** app_credentials row name for a provider's stored image-gen key. */
function imageGenCredentialProvider(providerId: string): string {
  return `imagegen_${providerId}`;
}

interface StoredImageGenKey {
  apiKey: string;
}

/** The API key saved by a superadmin in the admin screen (encrypted at rest), or null. */
export async function getStoredImageGenKey(providerId: string): Promise<string | null> {
  // NVIDIA has one hosted credential shared by every capability. Keep the
  // legacy image-provider key endpoint wired to that central encrypted row.
  if (providerId === "nvidia") {
    return (await resolveNvidiaCoreDeployment("image"))?.resolvedApiKey ?? null;
  }
  const row = (
    await db
      .select()
      .from(appCredentialsTable)
      .where(eq(appCredentialsTable.provider, imageGenCredentialProvider(providerId)))
      .limit(1)
  )[0];
  if (row) {
    try {
      const creds = decryptJson<StoredImageGenKey>(row.encryptedCredentials);
      if (creds.apiKey) return creds.apiKey;
    } catch {
      // Try the shared Replicate credential below when this legacy row is bad.
    }
  }
  if (providerId !== "replicate") return null;
  const shared = (
    await db
      .select()
      .from(appCredentialsTable)
      .where(eq(appCredentialsTable.provider, "videogen_replicate"))
      .limit(1)
  )[0];
  if (!shared) return null;
  try {
    const creds = decryptJson<StoredImageGenKey>(shared.encryptedCredentials);
    return creds.apiKey || null;
  } catch {
    return null;
  }
}

/** Save (encrypted) or overwrite the admin-entered API key for a provider. */
export async function setStoredImageGenKey(providerId: string, apiKey: string): Promise<void> {
  if (providerId === "nvidia") {
    await setNvidiaHostedApiKey(apiKey);
    return;
  }
  const encrypted = encryptJson({ apiKey } satisfies StoredImageGenKey);
  await db
    .insert(appCredentialsTable)
    .values({ provider: imageGenCredentialProvider(providerId), encryptedCredentials: encrypted })
    .onConflictDoUpdate({
      target: appCredentialsTable.provider,
      set: { encryptedCredentials: encrypted, updatedAt: new Date() },
    });
}

/** Remove the admin-entered API key (env secret, if any, becomes the fallback). */
export async function clearStoredImageGenKey(providerId: string): Promise<void> {
  if (providerId === "nvidia") {
    await clearNvidiaHostedApiKey();
    return;
  }
  await db
    .delete(appCredentialsTable)
    .where(eq(appCredentialsTable.provider, imageGenCredentialProvider(providerId)));
}

export type ImageGenKeySource = "database" | "env" | null;

/** Where the effective key comes from: admin-entered DB key wins, env secret is fallback. */
export async function getImageGenKeySource(def: ImageGenProviderDef): Promise<ImageGenKeySource> {
  if (def.envKey === null) return null;
  if (def.id === "nvidia") {
    const deployment = await resolveNvidiaCoreDeployment("image");
    if (!deployment?.resolvedApiKey) return null;
    const source = deployment.apiKey
      ? "database"
      : (await getNvidiaCoreConfigView()).hostedKeySource;
    return source === "database" || source === "env" ? source : null;
  }
  if (await getStoredImageGenKey(def.id)) return "database";
  if (process.env[def.envKey]) return "env";
  return null;
}

/** The effective API key for a provider (DB first, then env), or null. */
export async function resolveImageGenApiKey(def: ImageGenProviderDef): Promise<string | null> {
  if (def.envKey === null) return null;
  if (def.id === "nvidia") {
    return (await resolveNvidiaCoreDeployment("image"))?.resolvedApiKey ?? null;
  }
  const stored = await getStoredImageGenKey(def.id);
  if (stored) return stored;
  return process.env[def.envKey] ?? null;
}

export async function isImageGenProviderConfigured(def: ImageGenProviderDef): Promise<boolean> {
  if (def.id === "nvidia") return isNvidiaCoreDeploymentActivatable("image");
  return def.envKey === null || (await resolveImageGenApiKey(def)) !== null;
}

export interface ImageGenSelection {
  provider: string;
  /** Admin model override (null = provider default). */
  model: string | null;
  customBaseUrl: string | null;
}

/** The current selection (falls back to the default when the settings row is
 * missing or names a provider no longer in the catalog). */
export async function getImageGenSelection(): Promise<ImageGenSelection> {
  const row = (await db.select().from(imageGenSettingsTable).limit(1))[0];
  const id = row?.provider ?? DEFAULT_IMAGE_GEN_PROVIDER;
  // Automatic routing has no single provider, so it also has no model override
  // and no base URL — reported as null rather than as whatever a previously
  // pinned provider left behind in those columns.
  if (id === IMAGE_GEN_AUTO) {
    return { provider: IMAGE_GEN_AUTO, model: null, customBaseUrl: null };
  }
  if (!(await resolveImageGenProviderDef(id))) {
    return { provider: DEFAULT_IMAGE_GEN_PROVIDER, model: null, customBaseUrl: null };
  }
  return {
    provider: id,
    model: row?.model ?? null,
    customBaseUrl: row?.customBaseUrl ?? null,
  };
}

/** Persist the platform-wide selection (superadmin only; the route validates
 * the provider id against the catalog). */
export async function setImageGenSelection(selection: ImageGenSelection): Promise<void> {
  await db
    .insert(imageGenSettingsTable)
    .values({ id: 1, ...selection })
    .onConflictDoUpdate({
      target: imageGenSettingsTable.id,
      set: { ...selection, updatedAt: new Date() },
    });
}

/** The model that will actually be used for a provider given the settings. */
export function effectiveModel(def: ImageGenProviderDef, override: string | null): string {
  if (def.supportsModelOverride && override?.trim()) return override.trim();
  return def.defaultModel;
}

export function imageGenHealthKey(providerId: string): string {
  return `imagegen:${providerId}`;
}

/** Whether an image-gen failure is the PROVIDER's fault (429/5xx/network),
 * as opposed to a bad prompt or invalid key that would fail anywhere. */
function isTransientImageGenError(error: unknown): boolean {
  if (error instanceof ImagePreservationError) return false;
  if (error instanceof ImageGenProviderError) {
    if (error.status === undefined) return true; // timeout / network-shaped
    return (
      error.status === 429 ||
      error.status === 500 ||
      error.status === 502 ||
      error.status === 503 ||
      error.status === 504
    );
  }
  // Raw fetch TypeError / socket resets — transient by nature.
  return error instanceof Error;
}

/** How many OTHER configured providers to try after a transient failure. */
const IMAGE_GEN_FALLBACK_LIMIT = 2;

/**
 * Latency that scores neutrally for image work. Image models routinely take
 * ten to thirty seconds, so the text-shaped default would rate every one of
 * them as slow and make the axis useless.
 */
const IMAGE_LATENCY_REFERENCE_MS = 15_000;
const PRESERVATION_WIDTH = 1024;
const PRESERVATION_HEIGHT = 1536;
const PRESERVATION_ASPECT = PRESERVATION_WIDTH / PRESERVATION_HEIGHT;

function preservationError(
  message: string,
  providerWorkCompleted = false,
): ImagePreservationError {
  return new ImagePreservationError(
    `Protected image edit failed: ${message}`,
    providerWorkCompleted,
  );
}

async function dimensionsForPreservation(
  buffer: Buffer,
  label: string,
  providerWorkCompleted = false,
): Promise<{ width: number; height: number }> {
  try {
    const metadata = await sharp(buffer).metadata();
    if (metadata.width && metadata.height) {
      return { width: metadata.width, height: metadata.height };
    }
  } catch {
    // Converted to the stable caller-facing error below.
  }
  throw preservationError(
    `${label} is not a readable image.`,
    providerWorkCompleted,
  );
}

function assertAlignableAspect(
  width: number,
  height: number,
  label: string,
  providerWorkCompleted = false,
): void {
  // Permit only dimension-rounding noise. Cropping or stretching would move
  // the caller's normalized protected rectangle and make restoration unsafe.
  if (Math.abs(width / height - PRESERVATION_ASPECT) > 0.001) {
    throw preservationError(
      `${label} does not have the required 2:3 aspect ratio.`,
      providerWorkCompleted,
    );
  }
}

async function prepareExactMaskedEdit(
  referenceImage: ReferenceImage,
  edit: ExactMaskedEdit,
): Promise<{ referenceImage: ReferenceImage; editMask: ReferenceImage }> {
  const rect = edit.protectedRectangle;
  if (
    ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
    rect.x < 0 ||
    rect.y < 0 ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    rect.x + rect.width > 1 ||
    rect.y + rect.height > 1
  ) {
    throw preservationError("the protected rectangle must be within the normalized unit square.");
  }

  const [sourceDimensions, maskDimensions] = await Promise.all([
    dimensionsForPreservation(referenceImage.buffer, "canonical image"),
    dimensionsForPreservation(edit.mask.buffer, "clothing mask"),
  ]);
  assertAlignableAspect(sourceDimensions.width, sourceDimensions.height, "canonical image");
  if (
    maskDimensions.width !== sourceDimensions.width ||
    maskDimensions.height !== sourceDimensions.height
  ) {
    throw preservationError("the clothing mask dimensions do not match the canonical image.");
  }

  const [canonical, mask] = await Promise.all([
    sharp(referenceImage.buffer)
      .resize(PRESERVATION_WIDTH, PRESERVATION_HEIGHT, { fit: "fill" })
      .png()
      .toBuffer(),
    sharp(edit.mask.buffer)
      .resize(PRESERVATION_WIDTH, PRESERVATION_HEIGHT, { fit: "fill", kernel: "nearest" })
      .ensureAlpha()
      .png()
      .toBuffer(),
  ]);
  return {
    referenceImage: { buffer: canonical, mimeType: "image/png" },
    editMask: { buffer: mask, mimeType: "image/png" },
  };
}

/** Restore and byte-verify the protected canonical rectangle in provider output. */
export async function restoreProtectedImagePixels(
  providerBuffer: Buffer,
  canonicalBuffer: Buffer,
  rect: ExactMaskedEdit["protectedRectangle"],
): Promise<Buffer> {
  const dimensions = await dimensionsForPreservation(
    providerBuffer,
    "provider result",
    true,
  );
  assertAlignableAspect(
    dimensions.width,
    dimensions.height,
    "provider result",
    true,
  );

  const [canonical, generated] = await Promise.all([
    sharp(canonicalBuffer)
      .resize(PRESERVATION_WIDTH, PRESERVATION_HEIGHT, { fit: "fill" })
      .ensureAlpha()
      .raw()
      .toBuffer(),
    sharp(providerBuffer)
      .resize(PRESERVATION_WIDTH, PRESERVATION_HEIGHT, { fit: "fill" })
      .ensureAlpha()
      .raw()
      .toBuffer(),
  ]);
  const left = Math.floor(rect.x * PRESERVATION_WIDTH);
  const top = Math.floor(rect.y * PRESERVATION_HEIGHT);
  const right = Math.ceil((rect.x + rect.width) * PRESERVATION_WIDTH);
  const bottom = Math.ceil((rect.y + rect.height) * PRESERVATION_HEIGHT);
  for (let y = top; y < bottom; y += 1) {
    const start = (y * PRESERVATION_WIDTH + left) * 4;
    const end = (y * PRESERVATION_WIDTH + right) * 4;
    canonical.copy(generated, start, start, end);
  }
  const output = await sharp(generated, {
    raw: { width: PRESERVATION_WIDTH, height: PRESERVATION_HEIGHT, channels: 4 },
  })
    .png()
    .toBuffer();
  const verified = await sharp(output).ensureAlpha().raw().toBuffer();
  for (let y = top; y < bottom; y += 1) {
    const start = (y * PRESERVATION_WIDTH + left) * 4;
    const end = (y * PRESERVATION_WIDTH + right) * 4;
    if (!verified.subarray(start, end).equals(canonical.subarray(start, end))) {
      throw preservationError(
        "protected pixels could not be verified after encoding.",
        true,
      );
    }
  }
  return output;
}

async function runImageGenProvider(
  def: ImageGenProviderDef,
  input: Omit<
    ImageGenInput,
    "model" | "baseUrl" | "referenceImage" | "editMask" | "transparent"
  >,
  selection: ImageGenSelection,
  referenceImage: ReferenceImage | undefined,
  isSelected: boolean,
  transparent: boolean,
  editMask?: ReferenceImage,
): Promise<ImageGenResult> {
  const apiKey = await resolveImageGenApiKey(def);
  const model = isSelected ? effectiveModel(def, selection.model) : def.defaultModel;
  if (
    def.requiresPrice &&
    !(await isImageModelPriced({ provider: def.id, model }))
  ) {
    throw new ImageGenNotConfiguredError(
      `Image model ${def.id}/${model} has no authoritative price. Configure its catalog price before generating.`,
    );
  }
  const key = imageGenHealthKey(def.id);
  const startedAt = Date.now();
  try {
    const result = await def.generate(
      {
        ...input,
        // Model/baseUrl overrides belong to the SELECTED provider only; a
        // fallback provider runs with its own default model.
        model,
        baseUrl:
          isSelected && def.requiresBaseUrl ? (selection.customBaseUrl ?? undefined) : undefined,
        referenceImage: def.supportsImageInput ? referenceImage : undefined,
        editMask: def.supportsExactMaskedEdits ? editMask : undefined,
        transparent: transparent && def.supportsTransparency ? true : undefined,
      },
      apiKey,
    );
    // Only successes are timed. A failure's duration says how fast the vendor
    // said no, which is not the number routing wants to know.
    recordProviderSuccess(key, Date.now() - startedAt);
    return result;
  } catch (error) {
    if (isTransientImageGenError(error)) {
      recordProviderFailure(key, error instanceof Error ? error.message : undefined);
    }
    throw error;
  }
}

/**
 * Providers eligible to be chosen automatically: configured, not dependent on
 * an admin-entered base URL, able to take a reference image when one is
 * present, and able to return alpha when transparency was asked for. Task fit
 * is a filter here rather than a low score in the scorer, because a provider
 * that cannot accept the reference image is not a worse answer to this
 * request — it is not an answer to it.
 */
async function autoCandidates(
  referenceImage: ReferenceImage | undefined,
  transparent = false,
  exactMaskedEdit = false,
): Promise<ImageGenProviderDef[]> {
  const out: ImageGenProviderDef[] = [];
  for (const candidate of IMAGE_GEN_PROVIDERS) {
    if (candidate.requiresBaseUrl) continue;
    if (referenceImage && !candidate.supportsImageInput) continue;
    if (transparent && !candidate.supportsTransparency) continue;
    if (exactMaskedEdit && !candidate.supportsExactMaskedEdits) continue;
    if (!(await isImageGenProviderConfigured(candidate))) continue;
    if (
      candidate.requiresPrice &&
      !(await isImageModelPriced({ provider: candidate.id, model: candidate.defaultModel }))
    ) {
      continue;
    }
    out.push(candidate);
  }
  return out;
}

/**
 * The current automatic-routing ranking. Exported because the admin screen
 * shows exactly what the router would do, from the same call — a ranking the
 * UI computed its own way would eventually disagree with the one that runs.
 */
export async function rankImageGenProviders(
  referenceImage?: ReferenceImage,
  transparent = false,
  exactMaskedEdit = false,
): Promise<ScoredProvider[]> {
  const defs = await autoCandidates(referenceImage, transparent, exactMaskedEdit);
  // Priced against each provider's DEFAULT model: under auto routing that is
  // the model that will actually run, since a model override belongs to an
  // explicitly pinned provider.
  const costs = await imageUnitCostsPaise(
    defs.map((d) => ({ id: d.id, provider: d.id, model: d.defaultModel })),
  );
  return rankProviders(
    defs.map((d) => ({
      id: d.id,
      key: imageGenHealthKey(d.id),
      quality: d.quality,
      costPaise: costs.get(d.id) ?? null,
    })),
    { latencyReferenceMs: IMAGE_LATENCY_REFERENCE_MS },
  );
}

function shortMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 120) : "an unknown error";
}

/** Generate an image using the currently selected provider. The reference
 * image is only forwarded to providers that support image input; callers
 * should bake reference guidance into the prompt text either way.
 *
 * Reliability: the first provider is always attempted (that attempt doubles as
 * the circuit breaker's half-open probe). If it fails with a TRANSIENT error
 * (429/5xx/network/timeout), up to two other configured providers are tried
 * before the job is failed. A permanent error (bad prompt, invalid key) never
 * triggers fallback.
 *
 * Selection: a pinned provider goes first, always. With `auto` the scorer
 * picks per generation and the whole chain comes from the ranking.
 *
 * `opts.transparent` (layered generation) narrows the whole chain to providers
 * that can return real alpha, INCLUDING a pinned one: honouring a pin that
 * cannot do the job would hand back an opaque layer that silently ruins the
 * composite, so the pin is overridden and the reason is logged. */
export async function generateImage(
  prompt: string,
  size: ImageSize,
  referenceImage?: ReferenceImage,
  opts?: {
    transparent?: boolean;
    exactMaskedEdit?: ExactMaskedEdit;
    onProviderSuccess?: (meta: {
      provider: string;
      model: string;
    }) => Promise<void>;
  },
): Promise<RoutedImageGenResult> {
  const transparent = opts?.transparent === true;
  const exactMaskedEdit = opts?.exactMaskedEdit;
  if (exactMaskedEdit && !referenceImage) {
    throw preservationError("a canonical reference image is required.");
  }
  const prepared = exactMaskedEdit
    ? await prepareExactMaskedEdit(referenceImage!, exactMaskedEdit)
    : undefined;
  const routedReference = prepared?.referenceImage ?? referenceImage;
  // Exact preservation has one canonical coordinate system and output size.
  const routedSize = exactMaskedEdit ? "1024x1536" : size;
  const selection = await getImageGenSelection();
  // Kill switch (fail-open): with providerScoring off, an `auto` selection is
  // treated as unconfigured and falls through to the built-in default below.
  const auto =
    selection.provider === IMAGE_GEN_AUTO &&
    (await isFeatureEnabled("providerScoring").catch(() => true));
  const input = { prompt, size: routedSize };

  // Under auto the ranking IS the decision, so it is computed up front. With a
  // pinned provider the chain is extended only after a failure, so the happy
  // path costs exactly the queries it did before this existed.
  const chain: ImageGenProviderDef[] = [];
  let firstReason: string | undefined;
  if (auto) {
    const ranked = await rankImageGenProviders(routedReference, transparent, !!exactMaskedEdit);
    logger.info(
      { ranking: ranked.map((r) => ({ id: r.id, score: r.score, why: r.reason })) },
      "Image provider ranking",
    );
    for (const scored of ranked.slice(0, 1 + IMAGE_GEN_FALLBACK_LIMIT)) {
      const candidate = getImageGenProviderDef(scored.id);
      if (candidate) chain.push(candidate);
    }
    firstReason = explainWinner(ranked);
  }
  if (chain.length === 0) {
    // Pinned, or auto with nothing configured to rank. Falling through to the
    // built-in provider means an unconfigured deployment fails with that
    // provider's own error rather than a routing-flavoured one.
    const pinned =
      (await resolveImageGenProviderDef(selection.provider)) ??
      getImageGenProviderDef(DEFAULT_IMAGE_GEN_PROVIDER)!;
    if (
      (transparent && !pinned.supportsTransparency) ||
      (!!exactMaskedEdit && !pinned.supportsExactMaskedEdits)
    ) {
      // Capability beats the pin — see the doc comment above.
      const capable = await autoCandidates(
        routedReference,
        transparent,
        !!exactMaskedEdit,
      );
      if (capable.length === 0) {
        throw new ImageGenNotConfiguredError(
          exactMaskedEdit
            ? "Protected image edits need a provider with exact mask support (currently the built-in OpenAI provider)."
            : "Layered images need an image provider that can return transparent PNGs " +
                "(currently the built-in OpenAI provider). Enable one in the admin dashboard.",
        );
      }
      chain.push(...capable.slice(0, 1 + IMAGE_GEN_FALLBACK_LIMIT));
      firstReason = exactMaskedEdit
        ? `${chain[0].id} serves protected editing: the pinned provider ${pinned.id} cannot apply exact masks`
        : `${chain[0].id} serves layered generation: the pinned provider ${pinned.id} cannot return transparency`;
    } else {
      chain.push(pinned);
      firstReason = undefined;
    }
  }

  let primaryError: unknown;
  let extended = auto;
  for (let step = 0; step < chain.length; step += 1) {
    const def = chain[step];
    if (step > 0) {
      logger.warn(
        { primary: chain[0].id, fallback: def.id, err: primaryError },
        "Image provider failed transiently; trying fallback provider",
      );
    }
    try {
      const result = await runImageGenProvider(
        def,
        input,
        selection,
        routedReference,
        // Model and base-URL overrides belong to an explicitly pinned
        // provider in first position, and to nothing else.
        !auto && step === 0,
        transparent,
        prepared?.editMask,
      );
      // Wallet callers persist the paid provider acknowledgement before local
      // decoding/alignment/pixel restoration can reject the output.
      await opts?.onProviderSuccess?.({
        provider: result.provider,
        model: result.model,
      });
      const buffer = exactMaskedEdit
        ? await restoreProtectedImagePixels(
            result.buffer,
            prepared!.referenceImage.buffer,
            exactMaskedEdit.protectedRectangle,
          )
        : result.buffer;
      return {
        ...result,
        buffer,
        fallbackStep: step,
        routingReason:
          step === 0
            ? firstReason
            : `${def.id} served after ${chain[0].id} failed: ${shortMessage(primaryError)}`,
      };
    } catch (error) {
      if (step === 0) primaryError = error;
      // A permanent error would fail at every provider, so trying more of them
      // just costs the tenant time.
      if (!isTransientImageGenError(error)) throw error;
    }
    if (step === chain.length - 1 && !extended) {
      extended = true;
      if (await isFeatureEnabled("providerScoring").catch(() => true)) {
        const ranked = await rankImageGenProviders(
          routedReference,
          transparent,
          !!exactMaskedEdit,
        );
        for (const scored of ranked) {
          if (scored.id === chain[0].id) continue;
          const candidate = getImageGenProviderDef(scored.id);
          if (candidate) chain.push(candidate);
          if (chain.length > IMAGE_GEN_FALLBACK_LIMIT) break;
        }
      } else {
        // Kill switch off: fallbacks ordered by circuit-breaker health only.
        const candidates = orderByHealth(
          await autoCandidates(routedReference, transparent, !!exactMaskedEdit),
          (d) => imageGenHealthKey(d.id),
        );
        for (const candidate of candidates) {
          if (candidate.id === chain[0].id) continue;
          chain.push(candidate);
          if (chain.length > IMAGE_GEN_FALLBACK_LIMIT) break;
        }
      }
    }
  }

  throw primaryError;
}
