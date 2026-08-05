import OpenAI from "openai";
import { db, textGenSettingsTable, appCredentialsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { encryptJson, decryptJson } from "./secretCrypto";
import { openai as builtinOpenAI } from "@workspace/integrations-openai-ai-server";
import { resolveAiModel, isSupportedAiModel, SUPPORTED_AI_MODELS, DEFAULT_AI_MODEL } from "./aiModels";
import { createReplicateChatClient } from "./replicateTextGen";
import { withTextGenFailover } from "./textGenFailover";
import { getStoredVideoGenKey } from "./videoGen";

/**
 * Text generation routing layer.
 *
 * A platform-wide switch (superadmin only) selects which backend serves
 * caption/topic/campaign text:
 *   - "builtin"    — the built-in OpenAI integration (default; no settings
 *                    row behaves exactly like before this layer existed)
 *   - "openrouter" — OpenRouter with the admin's own API key, model list
 *                    curated by the admin
 *   - "replicate"  — Replicate-hosted language models via the predictions
 *                    API shim (replicateTextGen.ts). Reuses the Replicate
 *                    key already saved for video generation.
 *
 * Rollback: flip the provider back to "builtin"; tenants' stored model names
 * fall back through resolveTextModel() automatically, so nobody is stranded
 * on an unavailable model.
 *
 * NOTE: the /ai/research endpoint always uses the built-in OpenAI Responses
 * API (OpenRouter has no web_search tool support). All plain chat-completions
 * text (captions, topics, campaigns, URL summaries) goes through this switch.
 */

export const TEXT_GEN_PROVIDERS = ["builtin", "openrouter", "replicate"] as const;
export type TextGenProvider = (typeof TEXT_GEN_PROVIDERS)[number];
export const DEFAULT_TEXT_GEN_PROVIDER: TextGenProvider = "builtin";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_ENV_KEY = "OPENROUTER_API_KEY";
/** app_credentials row for the admin-entered OpenRouter key. */
const OPENROUTER_CREDENTIAL_PROVIDER = "textgen_openrouter";
const MAX_MODELS = 20;

export class TextGenNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TextGenNotConfiguredError";
  }
}

export interface TextGenSelection {
  provider: TextGenProvider;
  /** OpenRouter model ids tenants may choose from (empty for builtin). */
  models: string[];
  /** Fallback model when a tenant's saved model is not in `models`. */
  defaultModel: string | null;
}

function sanitizeModels(models: unknown): string[] {
  if (!Array.isArray(models)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of models) {
    if (typeof m !== "string") continue;
    const trimmed = m.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}

/** The current selection (falls back to builtin when the row is missing or invalid). */
export async function getTextGenSelection(): Promise<TextGenSelection> {
  const row = (await db.select().from(textGenSettingsTable).limit(1))[0];
  if (!row || !(TEXT_GEN_PROVIDERS as readonly string[]).includes(row.provider)) {
    return { provider: DEFAULT_TEXT_GEN_PROVIDER, models: [], defaultModel: null };
  }
  const models = sanitizeModels(row.models);
  const defaultModel =
    row.defaultModel && models.includes(row.defaultModel) ? row.defaultModel : (models[0] ?? null);
  return { provider: row.provider as TextGenProvider, models, defaultModel };
}

/** Persist the platform-wide selection (superadmin only; the route validates input). */
export async function setTextGenSelection(selection: TextGenSelection): Promise<void> {
  await db
    .insert(textGenSettingsTable)
    .values({ id: 1, ...selection })
    .onConflictDoUpdate({
      target: textGenSettingsTable.id,
      set: { ...selection, updatedAt: new Date() },
    });
}

interface StoredTextGenKey {
  apiKey: string;
}

/** The OpenRouter API key saved by a superadmin (encrypted at rest), or null. */
export async function getStoredOpenRouterKey(): Promise<string | null> {
  const row = (
    await db
      .select()
      .from(appCredentialsTable)
      .where(eq(appCredentialsTable.provider, OPENROUTER_CREDENTIAL_PROVIDER))
      .limit(1)
  )[0];
  if (!row) return null;
  try {
    const creds = decryptJson<StoredTextGenKey>(row.encryptedCredentials);
    return creds.apiKey || null;
  } catch {
    return null;
  }
}

/** Save (encrypted) or overwrite the admin-entered OpenRouter key. */
export async function setStoredOpenRouterKey(apiKey: string): Promise<void> {
  const encrypted = encryptJson({ apiKey } satisfies StoredTextGenKey);
  await db
    .insert(appCredentialsTable)
    .values({ provider: OPENROUTER_CREDENTIAL_PROVIDER, encryptedCredentials: encrypted })
    .onConflictDoUpdate({
      target: appCredentialsTable.provider,
      set: { encryptedCredentials: encrypted, updatedAt: new Date() },
    });
}

/** Remove the admin-entered key (the env secret, if set, becomes the fallback). */
export async function clearStoredOpenRouterKey(): Promise<void> {
  await db
    .delete(appCredentialsTable)
    .where(eq(appCredentialsTable.provider, OPENROUTER_CREDENTIAL_PROVIDER));
}

export type TextGenKeySource = "database" | "env" | null;

const REPLICATE_ENV_KEY = "REPLICATE_API_TOKEN";

/**
 * The Replicate key for text generation. Deliberately the SAME key the admin
 * saved for video generation (stored under videogen_replicate) — one key, one
 * place to rotate it — with the env secret as fallback.
 */
export async function resolveReplicateTextKey(): Promise<string | null> {
  const stored = await getStoredVideoGenKey("replicate");
  if (stored) return stored;
  return process.env[REPLICATE_ENV_KEY] ?? null;
}

/** Where the effective Replicate key comes from (shared with video generation). */
export async function getReplicateTextKeySource(): Promise<TextGenKeySource> {
  if (await getStoredVideoGenKey("replicate")) return "database";
  if (process.env[REPLICATE_ENV_KEY]) return "env";
  return null;
}

/** Where the effective OpenRouter key comes from (admin key wins over env secret). */
export async function getOpenRouterKeySource(): Promise<TextGenKeySource> {
  if (await getStoredOpenRouterKey()) return "database";
  if (process.env[OPENROUTER_ENV_KEY]) return "env";
  return null;
}

/** The effective OpenRouter key (DB first, then env), or null. */
export async function resolveOpenRouterKey(): Promise<string | null> {
  const stored = await getStoredOpenRouterKey();
  if (stored) return stored;
  return process.env[OPENROUTER_ENV_KEY] ?? null;
}

/**
 * Map a tenant's saved model to one the ACTIVE provider serves. Builtin uses
 * the fixed proxy list; OpenRouter uses the admin-curated list with the
 * configured default as the fallback.
 */
export function resolveTextModel(selection: TextGenSelection, tenantModel: string): string {
  if (selection.provider !== "builtin") {
    if (selection.models.includes(tenantModel)) return tenantModel;
    const fallback = selection.defaultModel ?? selection.models[0];
    if (!fallback) {
      throw new TextGenNotConfiguredError(
        `${selection.provider === "openrouter" ? "OpenRouter" : "Replicate"} is selected for ` +
          "text generation but no models are configured. " +
          "Add models in the admin dashboard or switch back to the built-in provider.",
      );
    }
    return fallback;
  }
  return resolveAiModel(tenantModel);
}

/** Whether a tenant may save this model name under the active provider. */
export async function isAllowedTenantModel(model: string): Promise<boolean> {
  const selection = await getTextGenSelection();
  if (selection.provider !== "builtin") return selection.models.includes(model);
  return isSupportedAiModel(model);
}

/** The model choices the Settings dropdown should offer right now. */
export async function listTenantModelChoices(): Promise<{
  provider: TextGenProvider;
  models: string[];
  defaultModel: string;
}> {
  const selection = await getTextGenSelection();
  if (selection.provider !== "builtin") {
    return {
      provider: selection.provider,
      models: selection.models,
      defaultModel: selection.defaultModel ?? selection.models[0] ?? "",
    };
  }
  return { provider: "builtin", models: [...SUPPORTED_AI_MODELS], defaultModel: DEFAULT_AI_MODEL };
}

export interface TextGenClient {
  client: OpenAI;
  provider: TextGenProvider;
  /** The model to pass to chat.completions for this tenant. */
  model: string;
}

/**
 * The chat-completions client + model for a tenant, honoring the platform
 * routing switch. Fails loudly (not silently back to builtin) when OpenRouter
 * is selected but its key is missing, so the admin always knows which
 * backend is live.
 *
 * By default the returned client is wrapped with outage failover
 * (textGenFailover.ts): transient provider failures record breaker state and
 * divert to the built-in provider when it is healthy and priced, with a
 * deduped superadmin alert. Misconfiguration still throws here, before any
 * wrapping — failover never masks a TextGenNotConfiguredError. Pass
 * `{ failover: false }` where the TRUE provider error matters more than the
 * content (e.g. the admin prompt playground).
 */
export async function getTextGenClient(
  tenantModel: string,
  opts?: { failover?: boolean },
): Promise<TextGenClient> {
  const selection = await getTextGenSelection();
  let base: TextGenClient;
  if (selection.provider === "openrouter") {
    const apiKey = await resolveOpenRouterKey();
    if (!apiKey) {
      throw new TextGenNotConfiguredError(
        "OpenRouter is selected for text generation but no API key is configured. " +
          "Save a key in the admin dashboard or switch back to the built-in provider.",
      );
    }
    base = {
      client: new OpenAI({ apiKey, baseURL: OPENROUTER_BASE_URL }),
      provider: "openrouter",
      model: resolveTextModel(selection, tenantModel),
    };
  } else if (selection.provider === "replicate") {
    const apiKey = await resolveReplicateTextKey();
    if (!apiKey) {
      throw new TextGenNotConfiguredError(
        "Replicate is selected for text generation but no API key is configured. " +
          "Save a Replicate key under Video Generation in the admin dashboard " +
          "or switch back to the built-in provider.",
      );
    }
    base = {
      client: createReplicateChatClient(apiKey),
      provider: "replicate",
      model: resolveTextModel(selection, tenantModel),
    };
  } else {
    base = {
      client: builtinOpenAI,
      provider: "builtin",
      model: resolveTextModel(selection, tenantModel),
    };
  }
  if (opts?.failover === false) return base;
  return withTextGenFailover(base, tenantModel);
}
