import { db, appCredentialsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { encryptJson, decryptJson } from "./secretCrypto";
import { recordProviderFailure, recordProviderSuccess } from "./providerHealth";
import { VideoGenProviderError } from "./videoGen/types";
import { isTransientStatus, withRetries } from "./videoGen/retry";

/**
 * Sarvam AI text-to-speech provider for Indic narration cues.
 *
 * Endpoint: POST https://api.sarvam.ai/text-to-speech
 * Auth: api-subscription-key header
 * Model: bulbul:v3
 * Output: WAV 24kHz (base64-encoded "audios" array in the response body)
 *
 * The credential slot in app_credentials is `tts_sarvam`; the DB key wins
 * over the SARVAM_API_KEY env variable (same pattern as every other provider).
 *
 * This module is self-contained and import-safe from tts.ts / topicVideo — it
 * exports `createSarvamCueSpeaker` so callers can resolve the key once for a
 * whole track and reuse it across all cue calls.
 */

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

export const SARVAM_PROVIDER_ID = "sarvam";
export const SARVAM_APP_CREDENTIALS_PROVIDER = "tts_sarvam";
export const SARVAM_TTS_ENDPOINT = "https://api.sarvam.ai/text-to-speech";
export const SARVAM_TTS_MODEL = "bulbul:v3";
export const SARVAM_TTS_TIMEOUT_MS = 90_000;
export const SARVAM_ENV_KEY = "SARVAM_API_KEY";
export const SARVAM_STOCK_SPEAKERS = [
  "shubh",
  "aditya",
  "ritu",
  "priya",
  "neha",
  "rahul",
  "pooja",
  "rohan",
  "simran",
  "kavya",
  "amit",
  "dev",
  "ishita",
  "shreya",
  "ratan",
  "varun",
  "manan",
  "sumit",
  "roopa",
  "kabir",
  "aayan",
  "ashutosh",
  "advait",
  "anand",
  "tanya",
  "tarun",
  "sunny",
  "mani",
  "gokul",
  "vijay",
  "shruti",
  "suhani",
  "mohit",
  "kavitha",
  "rehan",
  "soham",
  "rupali",
] as const;
export type SarvamStockSpeaker = (typeof SARVAM_STOCK_SPEAKERS)[number];

/** Provider health circuit-breaker key (matches ttsHealthKey convention). */
export function sarvamTtsHealthKey(): string {
  return "tts:sarvam";
}

// --------------------------------------------------------------------------
// Locale mapping
// --------------------------------------------------------------------------

/**
 * Maps the NarrationVoice locale hint (from the cue) to a Sarvam BCP-47 locale.
 * Sarvam bulbul:v3 supports te-IN, ta-IN, hi-IN, kn-IN, ml-IN, mr-IN, bn-IN,
 * gu-IN, od-IN, pa-IN, and en-IN. We default to hi-IN for unrecognised locales
 * because Hindi is the widest-reach fallback on the Sarvam platform.
 *
 * The caller is expected to pass the locale string directly from the cue
 * metadata (e.g. "te-IN"). If no locale is known, omit it or pass undefined.
 */
export function resolveSarvamLocale(locale?: string): string {
  const aliases: Record<string, string> = {
    te: "te-IN",
    ta: "ta-IN",
    hi: "hi-IN",
    "te-IN": "te-IN",
    "ta-IN": "ta-IN",
    "hi-IN": "hi-IN",
  };
  const resolved = locale ? aliases[locale] : undefined;
  if (!resolved) {
    throw new VideoGenProviderError("Sarvam TTS supports Telugu, Tamil, and Hindi localized tracks.", 400);
  }
  return resolved;
}

// --------------------------------------------------------------------------
// Credential storage
// --------------------------------------------------------------------------

interface StoredSarvamCredential {
  apiKey?: string;
  statusOnly?: true;
  keyFingerprint?: string;
}

export interface SarvamCredentialSnapshot {
  apiKey: string;
  source: "database" | "env";
  keyFingerprint: string;
  encryptedVersion: string | null;
}

function fingerprintKey(apiKey: string): string {
  return createHash("sha256").update(apiKey, "utf8").digest("hex");
}

async function getCredentialRow() {
  return (
    await db
      .select()
      .from(appCredentialsTable)
      .where(eq(appCredentialsTable.provider, SARVAM_APP_CREDENTIALS_PROVIDER))
      .limit(1)
  )[0] ?? null;
}

/** Retrieve the superadmin-entered Sarvam API key (encrypted at rest), or null. */
export async function getStoredSarvamKey(): Promise<string | null> {
  const row = await getCredentialRow();
  if (!row) return null;
  try {
    const creds = decryptJson<StoredSarvamCredential>(row.encryptedCredentials);
    return creds.apiKey || null;
  } catch {
    return null;
  }
}

/** Save (or rotate) the Sarvam API key (encrypted at rest). */
export async function setStoredSarvamKey(apiKey: string): Promise<void> {
  const encrypted = encryptJson({ apiKey } satisfies StoredSarvamCredential);
  await db
    .insert(appCredentialsTable)
    .values({
      provider: SARVAM_APP_CREDENTIALS_PROVIDER,
      encryptedCredentials: encrypted,
    })
    .onConflictDoUpdate({
      target: appCredentialsTable.provider,
      set: {
        encryptedCredentials: encrypted,
        lastTestStatus: null,
        lastTestedAt: null,
        lastTestError: null,
        updatedAt: new Date(),
      },
    });
}

/** Remove the stored Sarvam API key row (env var becomes the fallback). */
export async function clearStoredSarvamKey(): Promise<void> {
  await db
    .delete(appCredentialsTable)
    .where(eq(appCredentialsTable.provider, SARVAM_APP_CREDENTIALS_PROVIDER));
}

export type SarvamKeySource = "database" | "env" | null;

/** Resolve the key and an immutable version marker for rotation-safe tests. */
export async function resolveSarvamCredentialSnapshot(): Promise<SarvamCredentialSnapshot | null> {
  const row = await getCredentialRow();
  if (row) {
    try {
      const creds = decryptJson<StoredSarvamCredential>(row.encryptedCredentials);
      if (creds.apiKey) {
        return {
          apiKey: creds.apiKey,
          source: "database",
          keyFingerprint: fingerprintKey(creds.apiKey),
          encryptedVersion: row.encryptedCredentials,
        };
      }
    } catch {
      // A corrupt row never falls through as a usable database credential.
    }
  }
  const envKey = process.env[SARVAM_ENV_KEY];
  return envKey
    ? {
        apiKey: envKey,
        source: "env",
        keyFingerprint: fingerprintKey(envKey),
        encryptedVersion: null,
      }
    : null;
}

/** Which source the effective key comes from. */
export async function getSarvamKeySource(): Promise<SarvamKeySource> {
  return (await resolveSarvamCredentialSnapshot())?.source ?? null;
}

/** The effective Sarvam API key: DB override wins over env. */
export async function resolveSarvamApiKey(): Promise<string | null> {
  return (await resolveSarvamCredentialSnapshot())?.apiKey ?? null;
}

/** True if a Sarvam key is available from any source. */
export async function isSarvamConfigured(): Promise<boolean> {
  return (await resolveSarvamApiKey()) !== null;
}

// --------------------------------------------------------------------------
// last-test-status persistence
// --------------------------------------------------------------------------

export interface SarvamTestStatus {
  lastTestStatus: "ok" | "error" | null;
  lastTestedAt: Date | null;
  lastTestError: string | null;
}

/** Persist a test outcome into the app_credentials row. */
export async function persistSarvamTestStatus(
  status: "ok" | "error",
  errorMessage?: string,
): Promise<void> {
  const credential = await resolveSarvamCredentialSnapshot();
  if (!credential) return;
  await persistSarvamTestStatusForCredential(credential, status, errorMessage);
}

/**
 * Persist a health-test result only if the credential that was tested is
 * still active. For env-only keys, a status-only encrypted marker row carries
 * the fingerprint and test metadata without copying the API key into the DB.
 */
export async function persistSarvamTestStatusForCredential(
  credential: SarvamCredentialSnapshot,
  status: "ok" | "error",
  errorMessage?: string,
): Promise<boolean> {
  const statusSet = {
    lastTestStatus: status,
    lastTestedAt: new Date(),
    lastTestError: errorMessage?.slice(0, 1000) ?? null,
    updatedAt: new Date(),
  };

  if (credential.source === "database") {
    if (!credential.encryptedVersion) return false;
    const updated = await db
      .update(appCredentialsTable)
      .set(statusSet)
      .where(
        and(
          eq(appCredentialsTable.provider, SARVAM_APP_CREDENTIALS_PROVIDER),
          eq(appCredentialsTable.encryptedCredentials, credential.encryptedVersion),
        ),
      )
      .returning({ id: appCredentialsTable.id });
    return updated.length === 1;
  }

  const currentEnvKey = process.env[SARVAM_ENV_KEY];
  if (!currentEnvKey || fingerprintKey(currentEnvKey) !== credential.keyFingerprint) {
    return false;
  }
  const marker = encryptJson({
    statusOnly: true,
    keyFingerprint: credential.keyFingerprint,
  } satisfies StoredSarvamCredential);
  const existing = await getCredentialRow();
  if (!existing) {
    const inserted = await db
      .insert(appCredentialsTable)
      .values({
        provider: SARVAM_APP_CREDENTIALS_PROVIDER,
        encryptedCredentials: marker,
        ...statusSet,
      })
      .onConflictDoNothing()
      .returning({ id: appCredentialsTable.id });
    return inserted.length === 1;
  }

  let existingCredential: StoredSarvamCredential;
  try {
    existingCredential = decryptJson<StoredSarvamCredential>(existing.encryptedCredentials);
  } catch {
    return false;
  }
  if (existingCredential.apiKey) return false;
  const updated = await db
    .update(appCredentialsTable)
    .set({ encryptedCredentials: marker, ...statusSet })
    .where(
      and(
        eq(appCredentialsTable.provider, SARVAM_APP_CREDENTIALS_PROVIDER),
        eq(appCredentialsTable.encryptedCredentials, existing.encryptedCredentials),
      ),
    )
    .returning({ id: appCredentialsTable.id });
  return updated.length === 1;
}

/** Read the last test status fields without decrypting the key. */
export async function getSarvamTestStatus(): Promise<SarvamTestStatus> {
  const row = await getCredentialRow();
  if (row) {
    try {
      const creds = decryptJson<StoredSarvamCredential>(row.encryptedCredentials);
      if (creds.statusOnly) {
        const envKey = process.env[SARVAM_ENV_KEY];
        if (!envKey || creds.keyFingerprint !== fingerprintKey(envKey)) {
          return { lastTestStatus: null, lastTestedAt: null, lastTestError: null };
        }
      }
    } catch {
      return { lastTestStatus: null, lastTestedAt: null, lastTestError: null };
    }
  }
  return {
    lastTestStatus: (row?.lastTestStatus as "ok" | "error" | null) ?? null,
    lastTestedAt: row?.lastTestedAt ?? null,
    lastTestError: row?.lastTestError ?? null,
  };
}

// --------------------------------------------------------------------------
// Error handling
// --------------------------------------------------------------------------

/**
 * Whether a Sarvam TTS error is transient (429 / 5xx / timeout / network).
 * Permanent 4xx errors (bad request, auth) are NOT transient — callers should
 * surface them immediately and not retry.
 */
export function isSarvamTransientError(error: unknown): boolean {
  if (error instanceof VideoGenProviderError) {
    if (error.status === undefined) return true; // timeout / network abort
    return isTransientStatus(error.status);
  }
  return error instanceof Error;
}

// --------------------------------------------------------------------------
// Core TTS call
// --------------------------------------------------------------------------

/**
 * Speak one cue using the Sarvam TTS API.
 *
 * - Sends exactly the text as-is (no audio sample — voice cloning is separate).
 * - Requests 24kHz audio and decodes the documented base64 WAV response so the
 *   bytes parse with the same WAV header reader as every other narration provider.
 * - Validates the response: non-empty base64 audio array, decodes to non-empty bytes.
 * - Hard AbortController timeout: 90 s.
 *
 * @param text    The approved cue text. Never sent to a cloning endpoint.
 * @param apiKey  The Sarvam API subscription key.
 * @param locale  BCP-47 locale (e.g. "te-IN").
 * @returns       WAV buffer at 24kHz suitable for parseWav.
 */
export async function speakWithSarvam(
  text: string,
  apiKey: string,
  locale: string,
  speaker: SarvamStockSpeaker,
): Promise<Buffer> {
  const target_language_code = resolveSarvamLocale(locale);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SARVAM_TTS_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(SARVAM_TTS_ENDPOINT, {
      method: "POST",
      headers: {
        "api-subscription-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        target_language_code,
        speaker,
        model: SARVAM_TTS_MODEL,
        speech_sample_rate: 24_000,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new VideoGenProviderError(
        `Sarvam TTS timed out after ${SARVAM_TTS_TIMEOUT_MS / 1000}s.`,
      );
    }
    throw new VideoGenProviderError(
      `Sarvam TTS network error: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      /* ignore read errors */
    }
    throw new VideoGenProviderError(
      `Sarvam TTS failed (${res.status})${detail ? `: ${detail}` : ""}`,
      res.status,
    );
  }

  let body: { audios?: string[] };
  try {
    body = (await res.json()) as { audios?: string[] };
  } catch {
    throw new VideoGenProviderError("Sarvam TTS returned a non-JSON response.");
  }

  const firstAudio = Array.isArray(body.audios) ? body.audios[0] : undefined;
  if (!firstAudio || typeof firstAudio !== "string") {
    throw new VideoGenProviderError("Sarvam TTS returned no audio data.");
  }

  if (firstAudio.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(firstAudio)) {
    throw new VideoGenProviderError("Sarvam TTS returned malformed base64 audio.");
  }
  const wavBytes = Buffer.from(firstAudio, "base64");

  if (
    wavBytes.length < 44 ||
    wavBytes.toString("ascii", 0, 4) !== "RIFF" ||
    wavBytes.toString("ascii", 8, 12) !== "WAVE"
  ) {
    // WAV header is 44 bytes minimum; anything smaller is corrupt.
    throw new VideoGenProviderError(
      `Sarvam TTS returned an audio buffer that is too small to be a valid WAV file (${wavBytes.length} bytes).`,
    );
  }

  return wavBytes;
}

// --------------------------------------------------------------------------
// Connectivity test (cheap, doesn't consume TTS quota meaningfully)
// --------------------------------------------------------------------------

/**
 * Test the Sarvam key with a minimal TTS call.  Short text minimises cost;
 * we validate only that the API responded with audio — not that it sounds right.
 * Persists the outcome to the app_credentials row.
 */
export async function testSarvamKey(apiKey: string): Promise<void> {
  await speakWithSarvam("नमस्ते", apiKey, "hi-IN", "shubh");
}

// --------------------------------------------------------------------------
// Adapter: createSarvamCueSpeaker
// --------------------------------------------------------------------------

/**
 * Factory that resolves the Sarvam API key ONCE and returns a speak function
 * reusable across the whole track.  Integrates with the providerHealth
 * circuit breaker at tts:sarvam.
 *
 * Usage in tts.ts / topicVideo:
 *
 *   const speaker = await createSarvamCueSpeaker();
 *   if (!speaker) { // not configured — skip or fall back }
 *   const wav = await speaker(cueText, locale);
 *
 * @returns null if no Sarvam key is available (provider not configured).
 */
export async function createSarvamCueSpeaker(speaker: SarvamStockSpeaker): Promise<
  ((text: string, locale: string) => Promise<Buffer>) | null
> {
  const apiKey = await resolveSarvamApiKey();
  if (!apiKey) return null;

  const healthKey = sarvamTtsHealthKey();

  return async function speakSarvamCue(text: string, locale: string): Promise<Buffer> {
    const startedAt = Date.now();

    const speak = (): Promise<Buffer> => speakWithSarvam(text, apiKey, locale, speaker);

    let audio: Buffer;
    try {
      audio = await withRetries(speak, {
        attempts: 3,
        isRetryable: isSarvamTransientError,
      });
    } catch (err) {
      if (isSarvamTransientError(err)) {
        recordProviderFailure(healthKey);
      }
      throw err;
    }

    if (audio.length === 0) {
      recordProviderFailure(healthKey);
      throw new VideoGenProviderError("Sarvam TTS returned no audio for cue.");
    }

    recordProviderSuccess(healthKey, Date.now() - startedAt);
    return audio;
  };
}

