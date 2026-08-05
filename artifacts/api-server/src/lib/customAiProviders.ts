import {
  db,
  customAiProvidersTable,
  type CustomAiProvider,
  type CustomVideoApiMapping,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { encryptJson, decryptJson } from "./secretCrypto";
import { assertPublicHost } from "./webFetch";

/**
 * Admin-added OpenAI-compatible AI providers ("bring your own provider").
 *
 * A saved provider is addressed everywhere as `custom:<id>` — the same
 * free-text provider columns the text/image/video settings rows already use,
 * so the per-use-case routing layers only need to recognize the prefix and
 * build a client from this row instead of a built-in catalog entry.
 *
 * Use-case gating: `textEnabled` / `imageEnabled` / `videoEnabled` control
 * which settings screens may select the provider. Captions always ride the
 * text provider, so text covers both.
 *
 * Deleting or disabling a provider that is CURRENTLY selected for a use case
 * is refused by the routes (routes/admin.ts) — the admin must switch that
 * use case away first, so generation never dangles on a missing row.
 */

export const CUSTOM_PROVIDER_PREFIX = "custom:";

/** Parse "custom:<id>" → numeric id, or null when it isn't a custom provider ref. */
export function parseCustomProviderId(provider: string): number | null {
  if (!provider.startsWith(CUSTOM_PROVIDER_PREFIX)) return null;
  const id = Number(provider.slice(CUSTOM_PROVIDER_PREFIX.length));
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function customProviderRef(id: number): string {
  return `${CUSTOM_PROVIDER_PREFIX}${id}`;
}

export async function listCustomAiProviders(): Promise<CustomAiProvider[]> {
  return db.select().from(customAiProvidersTable).orderBy(customAiProvidersTable.id);
}

export async function getCustomAiProvider(id: number): Promise<CustomAiProvider | null> {
  const [row] = await db
    .select()
    .from(customAiProvidersTable)
    .where(eq(customAiProvidersTable.id, id))
    .limit(1);
  return row ?? null;
}

/** Resolve a "custom:<id>" provider string to its row, or null. */
export async function resolveCustomProvider(provider: string): Promise<CustomAiProvider | null> {
  const id = parseCustomProviderId(provider);
  if (id === null) return null;
  return getCustomAiProvider(id);
}

interface StoredKey {
  apiKey: string;
}

/** The decrypted API key for a provider row, or null (keyless endpoints are allowed). */
export function decryptCustomProviderKey(row: CustomAiProvider): string | null {
  if (!row.encryptedApiKey) return null;
  try {
    const creds = decryptJson<StoredKey>(row.encryptedApiKey);
    return creds.apiKey || null;
  } catch {
    return null;
  }
}

/**
 * Validate an admin-entered base URL: https only, no private/internal hosts
 * (same SSRF bar as the custom image provider), no trailing slash stored.
 * Throws Error with a user-facing message.
 */
export async function validateCustomBaseUrl(rawUrl: string): Promise<string> {
  const trimmed = rawUrl.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Base URL is not a valid URL (expected e.g. https://api.example.com/v1)");
  }
  if (url.protocol !== "https:") {
    throw new Error("Base URL must use https");
  }
  try {
    await assertPublicHost(url.hostname);
  } catch {
    throw new Error("Base URL points to a blocked or private host");
  }
  return trimmed;
}

export type { CustomVideoApiMapping } from "@workspace/db";

/** Default pending statuses (mirrors the OpenRouter adapter's set). */
export const DEFAULT_VIDEO_PENDING_VALUES = ["pending", "processing", "queued", "running"];
export const DEFAULT_VIDEO_COMPLETED_VALUE = "completed";

/** A dot-separated JSON field path like "data.0.url" (segments non-empty). */
function isFieldPath(value: string): boolean {
  return value.split(".").every((seg) => seg.trim().length > 0);
}

function cleanPath(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Validate + normalize an admin-entered video API mapping. Returns null for
 * "use the OpenRouter template" (the stored default), a normalized mapping
 * for template "custom", and throws Error with a user-facing message listing
 * exactly what is missing or malformed otherwise.
 */
export function validateVideoApiMapping(raw: unknown): CustomVideoApiMapping | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Video API mapping must be an object");
  }
  const input = raw as Record<string, unknown>;
  if (input.template === "openrouter") return null;
  if (input.template !== "custom") {
    throw new Error('Video API mapping template must be "openrouter" or "custom"');
  }

  const problems: string[] = [];
  const submitPath = cleanPath(input.submitPath);
  const pollPath = cleanPath(input.pollPath);
  const promptField = cleanPath(input.promptField);
  const videoUrlPath = cleanPath(input.videoUrlPath);
  const jobIdPath = cleanPath(input.jobIdPath);
  const statusPath = cleanPath(input.statusPath);

  if (!submitPath) problems.push("submit path is required (e.g. /videos)");
  else if (!submitPath.startsWith("/")) problems.push('submit path must start with "/"');
  if (!promptField) problems.push("prompt field is required (e.g. prompt)");
  else if (!isFieldPath(promptField)) problems.push("prompt field is not a valid field path");
  if (!videoUrlPath) problems.push("video URL path is required (e.g. output.video_url)");
  else if (!isFieldPath(videoUrlPath)) problems.push("video URL path is not a valid field path");

  if (pollPath) {
    if (!pollPath.startsWith("/")) problems.push('poll path must start with "/"');
    if (!pollPath.includes("{id}")) problems.push('poll path must contain the "{id}" placeholder');
    if (!jobIdPath) problems.push("job id path is required when a poll path is set (e.g. id)");
    else if (!isFieldPath(jobIdPath)) problems.push("job id path is not a valid field path");
    if (!statusPath) problems.push("status path is required when a poll path is set (e.g. status)");
    else if (!isFieldPath(statusPath)) problems.push("status path is not a valid field path");
  }

  const optionalFields: [string, string][] = [
    ["modelField", cleanPath(input.modelField)],
    ["durationField", cleanPath(input.durationField)],
    ["aspectRatioField", cleanPath(input.aspectRatioField)],
    ["imageField", cleanPath(input.imageField)],
    ["errorPath", cleanPath(input.errorPath)],
  ];
  for (const [name, value] of optionalFields) {
    if (value && !isFieldPath(value)) problems.push(`${name} is not a valid field path`);
  }

  let pendingValues = DEFAULT_VIDEO_PENDING_VALUES;
  if (input.pendingValues !== undefined) {
    if (
      !Array.isArray(input.pendingValues) ||
      !input.pendingValues.every((v) => typeof v === "string")
    ) {
      problems.push("pending statuses must be a list of strings");
    } else {
      const cleaned = input.pendingValues.map((v) => v.trim()).filter(Boolean);
      if (cleaned.length > 0) pendingValues = cleaned;
    }
  }
  const completedValue =
    cleanPath(input.completedValue) || DEFAULT_VIDEO_COMPLETED_VALUE;

  if (problems.length > 0) {
    throw new Error(`Video API mapping is incomplete: ${problems.join("; ")}`);
  }

  const mapping: CustomVideoApiMapping = {
    template: "custom",
    submitPath,
    promptField,
    videoUrlPath,
    pendingValues,
    completedValue,
  };
  if (pollPath) {
    mapping.pollPath = pollPath;
    mapping.jobIdPath = jobIdPath;
    mapping.statusPath = statusPath;
  }
  const [modelField, durationField, aspectRatioField, imageField, errorPath] = optionalFields.map(
    ([, v]) => v,
  );
  if (modelField) mapping.modelField = modelField;
  if (durationField) mapping.durationField = durationField;
  if (aspectRatioField) mapping.aspectRatioField = aspectRatioField;
  if (imageField) mapping.imageField = imageField;
  if (errorPath) mapping.errorPath = errorPath;
  return mapping;
}

export interface CustomProviderInput {
  name: string;
  baseUrl: string;
  /** undefined = keep the existing key; null/"" = clear it; string = replace. */
  apiKey?: string | null;
  textEnabled: boolean;
  imageEnabled: boolean;
  videoEnabled: boolean;
  /** Normalized video API mapping (validateVideoApiMapping output).
   * undefined = keep existing (update) / OpenRouter template (create);
   * null = reset to the OpenRouter template. */
  videoApi?: CustomVideoApiMapping | null;
}

export async function createCustomAiProvider(
  input: CustomProviderInput,
): Promise<CustomAiProvider> {
  const [row] = await db
    .insert(customAiProvidersTable)
    .values({
      name: input.name.trim(),
      baseUrl: input.baseUrl,
      encryptedApiKey: input.apiKey ? encryptJson({ apiKey: input.apiKey } satisfies StoredKey) : null,
      textEnabled: input.textEnabled,
      imageEnabled: input.imageEnabled,
      videoEnabled: input.videoEnabled,
      videoApi: input.videoApi ?? null,
    })
    .returning();
  return row;
}

export async function updateCustomAiProvider(
  id: number,
  input: CustomProviderInput,
): Promise<CustomAiProvider | null> {
  const set: Partial<typeof customAiProvidersTable.$inferInsert> = {
    name: input.name.trim(),
    baseUrl: input.baseUrl,
    textEnabled: input.textEnabled,
    imageEnabled: input.imageEnabled,
    videoEnabled: input.videoEnabled,
    updatedAt: new Date(),
  };
  if (input.videoApi !== undefined) {
    set.videoApi = input.videoApi;
  }
  if (input.apiKey !== undefined) {
    set.encryptedApiKey = input.apiKey
      ? encryptJson({ apiKey: input.apiKey } satisfies StoredKey)
      : null;
  }
  const [row] = await db
    .update(customAiProvidersTable)
    .set(set)
    .where(eq(customAiProvidersTable.id, id))
    .returning();
  return row ?? null;
}

export async function deleteCustomAiProvider(id: number): Promise<boolean> {
  const rows = await db
    .delete(customAiProvidersTable)
    .where(eq(customAiProvidersTable.id, id))
    .returning({ id: customAiProvidersTable.id });
  return rows.length > 0;
}

/** Public (mask-safe) view of a provider row for admin API responses. */
export function customProviderView(row: CustomAiProvider) {
  return {
    id: customProviderRef(row.id),
    name: row.name,
    baseUrl: row.baseUrl,
    hasKey: Boolean(row.encryptedApiKey),
    textEnabled: row.textEnabled,
    imageEnabled: row.imageEnabled,
    videoEnabled: row.videoEnabled,
    // Null means "OpenRouter template" — surface it explicitly so the admin
    // UI can render the template choice without a null special case.
    videoApi: row.videoApi ?? { template: "openrouter" as const },
  };
}
export type CustomProviderView = ReturnType<typeof customProviderView>;
