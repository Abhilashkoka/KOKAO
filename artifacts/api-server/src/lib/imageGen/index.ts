import { db, imageGenSettingsTable, appCredentialsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { encryptJson, decryptJson } from "../secretCrypto";
import { generateWithOpenAIBuiltin, OPENAI_BUILTIN_MODEL } from "./providers/openaiBuiltin";
import { generateWithGemini, GEMINI_IMAGE_MODEL } from "./providers/gemini";
import { generateWithStability, STABILITY_MODEL } from "./providers/stability";
import { generateWithReplicate, REPLICATE_MODEL } from "./providers/replicate";
import { generateWithOpenAICompatible } from "./providers/openaiCompatible";
import { generateWithBfl, BFL_MODEL } from "./providers/bfl";
import { generateWithSeedream, SEEDREAM_MODEL } from "./providers/seedream";
import { generateWithOpenRouter, OPENROUTER_IMAGE_MODEL } from "./providers/openrouter";
import type { ImageGenInput, ImageGenResult, ImageSize, ReferenceImage } from "./types";

export { ImageGenNotConfiguredError, ImageGenProviderError } from "./types";
export type { ImageGenInput, ImageGenResult, ImageSize, ReferenceImage } from "./types";

export const DEFAULT_IMAGE_GEN_PROVIDER = "openai";

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
    generate: generateWithOpenRouter,
  },
  {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    defaultModel: "",
    envKey: "CUSTOM_IMAGE_API_KEY",
    supportsModelOverride: true,
    requiresBaseUrl: true,
    supportsImageInput: false,
    generate: generateWithOpenAICompatible,
  },
] as const;

export function getImageGenProviderDef(id: string): ImageGenProviderDef | undefined {
  return IMAGE_GEN_PROVIDERS.find((p) => p.id === id);
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
  const row = (
    await db
      .select()
      .from(appCredentialsTable)
      .where(eq(appCredentialsTable.provider, imageGenCredentialProvider(providerId)))
      .limit(1)
  )[0];
  if (!row) return null;
  try {
    const creds = decryptJson<StoredImageGenKey>(row.encryptedCredentials);
    return creds.apiKey || null;
  } catch {
    return null;
  }
}

/** Save (encrypted) or overwrite the admin-entered API key for a provider. */
export async function setStoredImageGenKey(providerId: string, apiKey: string): Promise<void> {
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
  await db
    .delete(appCredentialsTable)
    .where(eq(appCredentialsTable.provider, imageGenCredentialProvider(providerId)));
}

export type ImageGenKeySource = "database" | "env" | null;

/** Where the effective key comes from: admin-entered DB key wins, env secret is fallback. */
export async function getImageGenKeySource(def: ImageGenProviderDef): Promise<ImageGenKeySource> {
  if (def.envKey === null) return null;
  if (await getStoredImageGenKey(def.id)) return "database";
  if (process.env[def.envKey]) return "env";
  return null;
}

/** The effective API key for a provider (DB first, then env), or null. */
export async function resolveImageGenApiKey(def: ImageGenProviderDef): Promise<string | null> {
  if (def.envKey === null) return null;
  const stored = await getStoredImageGenKey(def.id);
  if (stored) return stored;
  return process.env[def.envKey] ?? null;
}

export async function isImageGenProviderConfigured(def: ImageGenProviderDef): Promise<boolean> {
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
  if (!getImageGenProviderDef(id)) {
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

/** Generate an image using the currently selected provider. The reference
 * image is only forwarded when that provider supports image input; callers
 * should bake reference guidance into the prompt text either way. */
export async function generateImage(
  prompt: string,
  size: ImageSize,
  referenceImage?: ReferenceImage,
): Promise<ImageGenResult> {
  const selection = await getImageGenSelection();
  const def =
    getImageGenProviderDef(selection.provider) ??
    getImageGenProviderDef(DEFAULT_IMAGE_GEN_PROVIDER)!;
  const apiKey = await resolveImageGenApiKey(def);
  return def.generate(
    {
      prompt,
      size,
      model: effectiveModel(def, selection.model),
      baseUrl: def.requiresBaseUrl ? (selection.customBaseUrl ?? undefined) : undefined,
      referenceImage: def.supportsImageInput ? referenceImage : undefined,
    },
    apiKey,
  );
}
