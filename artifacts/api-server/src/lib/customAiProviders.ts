import { db, customAiProvidersTable, type CustomAiProvider } from "@workspace/db";
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

export interface CustomProviderInput {
  name: string;
  baseUrl: string;
  /** undefined = keep the existing key; null/"" = clear it; string = replace. */
  apiKey?: string | null;
  textEnabled: boolean;
  imageEnabled: boolean;
  videoEnabled: boolean;
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
  };
}
export type CustomProviderView = ReturnType<typeof customProviderView>;
