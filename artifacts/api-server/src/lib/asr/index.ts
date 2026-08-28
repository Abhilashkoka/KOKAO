import { db, asrSettingsTable, appCredentialsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../logger";
import { recordProviderFailure, recordProviderSuccess, orderByHealth } from "../providerHealth";
import { isFeatureEnabled } from "../featureFlags";
import { rankProviders } from "../providerScore";
import { encryptJson, decryptJson } from "../secretCrypto";
import { transcribeWithGroq, GROQ_MODEL } from "./providers/groq";
import { transcribeWithOpenAI, OPENAI_ASR_MODEL } from "./providers/openaiWhisper";
import { transcribeWithDeepgram, DEEPGRAM_MODEL } from "./providers/deepgram";
import { transcribeWithAssemblyAI, ASSEMBLYAI_MODEL } from "./providers/assemblyai";
import { transcribeWithNvidia, NVIDIA_ASR_MODEL } from "./providers/nvidia";
import {
  isNvidiaCoreDeploymentActivatable,
  resolveNvidiaCoreDeployment,
} from "../nvidiaCore";
import { AsrProviderError } from "./types";
import type { TranscribeInput, TranscriptionResult } from "./types";

export { AsrNotConfiguredError, AsrProviderError } from "./types";
export type { TranscribeInput, TranscriptionResult } from "./types";

export const DEFAULT_ASR_PROVIDER = "groq";

export interface AsrProviderDef {
  id: string;
  label: string;
  model: string;
  /** Secret required to use this provider; null = uses the built-in OpenAI integration. */
  envKey: string | null;
  transcribe: (input: TranscribeInput, apiKey: string | null) => Promise<TranscriptionResult>;
  /** Optional provider-specific configuration (e.g. a keyless self-hosted NIM). */
  isConfigured?: () => Promise<boolean>;
  resolveApiKey?: () => Promise<string | null>;
}

/** Catalog of selectable speech-to-text providers. Add new ones here only. */
export const ASR_PROVIDERS: readonly AsrProviderDef[] = [
  {
    id: "groq",
    label: "Groq (Whisper large-v3-turbo)",
    model: GROQ_MODEL,
    envKey: "GROQ_API_KEY",
    transcribe: transcribeWithGroq,
  },
  {
    id: "openai",
    label: "OpenAI (Whisper)",
    model: OPENAI_ASR_MODEL,
    envKey: null,
    transcribe: transcribeWithOpenAI,
  },
  {
    id: "deepgram",
    label: "Deepgram (Nova-2)",
    model: DEEPGRAM_MODEL,
    envKey: "DEEPGRAM_API_KEY",
    transcribe: transcribeWithDeepgram,
  },
  {
    id: "assemblyai",
    label: "AssemblyAI",
    model: ASSEMBLYAI_MODEL,
    envKey: "ASSEMBLYAI_API_KEY",
    transcribe: transcribeWithAssemblyAI,
  },
  {
    id: "nvidia",
    label: "NVIDIA (configured NIM)",
    model: NVIDIA_ASR_MODEL,
    envKey: "NVIDIA_API_KEY",
    transcribe: transcribeWithNvidia,
    isConfigured: async () => isNvidiaCoreDeploymentActivatable("asr"),
    resolveApiKey: async () =>
      (await resolveNvidiaCoreDeployment("asr"))?.resolvedApiKey ?? null,
  },
] as const;

export function getProviderDef(id: string): AsrProviderDef | undefined {
  return ASR_PROVIDERS.find((p) => p.id === id);
}

/** app_credentials row name for a provider's stored ASR key. */
function asrCredentialProvider(providerId: string): string {
  return `asr_${providerId}`;
}

interface StoredAsrKey {
  apiKey: string;
}

/** The API key saved by a superadmin in the admin screen (encrypted at rest), or null. */
export async function getStoredAsrKey(providerId: string): Promise<string | null> {
  const row = (
    await db
      .select()
      .from(appCredentialsTable)
      .where(eq(appCredentialsTable.provider, asrCredentialProvider(providerId)))
      .limit(1)
  )[0];
  if (!row) return null;
  try {
    const creds = decryptJson<StoredAsrKey>(row.encryptedCredentials);
    return creds.apiKey || null;
  } catch {
    return null;
  }
}

/** Save (encrypted) or overwrite the admin-entered API key for a provider. */
export async function setStoredAsrKey(providerId: string, apiKey: string): Promise<void> {
  const encrypted = encryptJson({ apiKey } satisfies StoredAsrKey);
  await db
    .insert(appCredentialsTable)
    .values({ provider: asrCredentialProvider(providerId), encryptedCredentials: encrypted })
    .onConflictDoUpdate({
      target: appCredentialsTable.provider,
      set: { encryptedCredentials: encrypted, updatedAt: new Date() },
    });
}

/** Remove the admin-entered API key (env secret, if any, becomes the fallback). */
export async function clearStoredAsrKey(providerId: string): Promise<void> {
  await db
    .delete(appCredentialsTable)
    .where(eq(appCredentialsTable.provider, asrCredentialProvider(providerId)));
}

export type AsrKeySource = "database" | "env" | null;

/** Where the effective key comes from: admin-entered DB key wins, env secret is fallback. */
export async function getAsrKeySource(def: AsrProviderDef): Promise<AsrKeySource> {
  if (def.resolveApiKey) {
    const deployment = await resolveNvidiaCoreDeployment("asr");
    if (deployment?.apiKey) return "database";
    if (deployment?.kind === "hosted" && deployment.resolvedApiKey) {
      return process.env.NVIDIA_API_KEY ? "env" : "database";
    }
    return null;
  }
  if (def.envKey === null) return null;
  if (await getStoredAsrKey(def.id)) return "database";
  if (process.env[def.envKey]) return "env";
  return null;
}

/** The effective API key for a provider (DB first, then env), or null. */
export async function resolveAsrApiKey(def: AsrProviderDef): Promise<string | null> {
  if (def.resolveApiKey) return def.resolveApiKey();
  if (def.envKey === null) return null;
  const stored = await getStoredAsrKey(def.id);
  if (stored) return stored;
  return process.env[def.envKey] ?? null;
}

export async function isProviderConfigured(def: AsrProviderDef): Promise<boolean> {
  if (def.isConfigured) return def.isConfigured();
  return def.envKey === null || (await resolveAsrApiKey(def)) !== null;
}

/** The currently selected provider id (falls back to the default when the
 * settings row is missing or names a provider no longer in the catalog). */
export async function getSelectedAsrProviderId(): Promise<string> {
  const row = (await db.select().from(asrSettingsTable).limit(1))[0];
  const id = row?.provider ?? DEFAULT_ASR_PROVIDER;
  return getProviderDef(id) ? id : DEFAULT_ASR_PROVIDER;
}

/** Persist the platform-wide provider selection (superadmin only, id must be
 * validated against the catalog by the caller's route). */
export async function setSelectedAsrProviderId(id: string): Promise<void> {
  await db
    .insert(asrSettingsTable)
    .values({ id: 1, provider: id })
    .onConflictDoUpdate({
      target: asrSettingsTable.id,
      set: { provider: id, updatedAt: new Date() },
    });
}

export function asrHealthKey(providerId: string): string {
  return `asr:${providerId}`;
}

/** Whether a transcription failure is the PROVIDER's fault (429/5xx/network),
 * as opposed to unusable audio or a bad key that would fail anywhere. */
function isTransientAsrError(error: unknown): boolean {
  if (error instanceof AsrProviderError) {
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
const ASR_FALLBACK_LIMIT = 2;

/**
 * Latency that scores neutrally for transcription. Speech models take roughly
 * as long as the audio is long, and a KOKAO voice note is a caption brief
 * rather than a podcast, so twenty seconds is the middle of the real range.
 */
const ASR_LATENCY_REFERENCE_MS = 20_000;

async function runAsrProvider(
  def: AsrProviderDef,
  input: TranscribeInput,
): Promise<TranscriptionResult> {
  const apiKey = await resolveAsrApiKey(def);
  const key = asrHealthKey(def.id);
  const startedAt = Date.now();
  try {
    const result = await def.transcribe(input, apiKey);
    recordProviderSuccess(key, Date.now() - startedAt);
    return result;
  } catch (error) {
    if (isTransientAsrError(error)) {
      recordProviderFailure(key, error instanceof Error ? error.message : undefined);
    }
    throw error;
  }
}

/**
 * Transcribe a voice note using the currently selected provider.
 *
 * Reliability: the selected provider is always attempted first (that attempt
 * doubles as the circuit breaker's half-open probe). If it fails with a
 * TRANSIENT error, up to two other configured providers are tried before the
 * caller sees a failure. A permanent error (unusable audio, invalid key) never
 * triggers fallback, because a second provider would reject the same bytes.
 *
 * Fallbacks are ranked rather than merely partitioned by breaker state: with
 * no per-second price for any of these vendors and no editorial tier worth
 * defending, that comes down to recent success rate and observed speed — which
 * is exactly what matters when the alternative is a tenant watching a spinner
 * for a second full transcription.
 *
 * A voice note the tenant just recorded cannot be re-recorded on demand, so a
 * bad ten minutes at one vendor should not lose it.
 */
export async function transcribeAudio(input: TranscribeInput): Promise<TranscriptionResult> {
  const id = await getSelectedAsrProviderId();
  const def = getProviderDef(id) ?? getProviderDef(DEFAULT_ASR_PROVIDER)!;

  let primaryError: unknown;
  try {
    return await runAsrProvider(def, input);
  } catch (error) {
    primaryError = error;
    if (!isTransientAsrError(error)) throw error;
  }

  const alternates: AsrProviderDef[] = [];
  for (const candidate of ASR_PROVIDERS) {
    if (candidate.id === def.id) continue;
    if (await isProviderConfigured(candidate)) alternates.push(candidate);
  }
  // Kill switch (fail-open): with providerScoring off, fallbacks are ordered
  // by circuit-breaker health only, as they were before scoring existed.
  const scoringOn = await isFeatureEnabled("providerScoring").catch(() => true);
  const ordered = scoringOn
    ? rankProviders(
        alternates.map((c) => ({ id: c.id, key: asrHealthKey(c.id) })),
        { latencyReferenceMs: ASR_LATENCY_REFERENCE_MS },
      )
        .slice(0, ASR_FALLBACK_LIMIT)
        .map((r) => alternates.find((c) => c.id === r.id)!)
    : orderByHealth(alternates, (c) => asrHealthKey(c.id)).slice(0, ASR_FALLBACK_LIMIT);

  for (const candidate of ordered) {
    logger.warn(
      { primary: def.id, fallback: candidate.id, err: primaryError },
      "Speech-to-text provider failed transiently; trying fallback provider",
    );
    try {
      return await runAsrProvider(candidate, input);
    } catch (error) {
      if (!isTransientAsrError(error)) throw error;
    }
  }

  throw primaryError;
}
