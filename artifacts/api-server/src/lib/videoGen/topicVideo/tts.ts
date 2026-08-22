import { textToSpeech } from "@workspace/integrations-openai-ai-server/audio";
import { getStoredAsrKey } from "../../asr";
import { orderByHealth, recordProviderFailure, recordProviderSuccess } from "../../providerHealth";
import { VideoGenProviderError, errorDetail } from "../types";
import { isTransientStatus, withRetries, withTimeout } from "../retry";
import type { NarrationVoice } from "./narration";
import type { TargetLocale } from "@workspace/localization";
import {
  SARVAM_STOCK_SPEAKERS,
  SARVAM_TTS_MODEL,
  createSarvamCueSpeaker,
  type SarvamStockSpeaker,
} from "../../sarvamTts";

/**
 * Text-to-speech provider registry for narration.
 *
 * Narration used to have exactly one path: the built-in OpenAI audio proxy. A
 * bad ten minutes upstream failed every topic video on the platform, after the
 * script had already been written and paid for. This registry makes narration
 * survive that — same shape as the image-gen and stock-source registries, and
 * the same in-process circuit breaker orders the candidates.
 *
 * Failover is at TRACK level, not per sentence. `synthesizeNarration` derives
 * cue timings from each sentence's WAV header and requires one consistent
 * audio format across the whole track, so half a track from OpenAI and half
 * from Deepgram would be rejected as inconsistent. Re-speaking the track on
 * the next provider costs a few seconds of TTS; failing the job costs the
 * tenant a video unit.
 */

/** A single sentence should never take this long to speak. */
export const TTS_TIMEOUT_MS = 90_000;
export const LOCALIZED_OPENAI_MODEL = "gpt-audio";

export interface LocalizedNarrationSelection {
  locale: TargetLocale;
  provider: "openai" | "sarvam";
  model: "gpt-audio" | "bulbul:v3";
  speaker: string;
}

const OPENAI_LOCALIZED_VOICES = new Set<NarrationVoice>([
  "alloy",
  "echo",
  "fable",
  "onyx",
  "nova",
  "shimmer",
]);

export function normalizeLocalizedNarrationSelection(input: {
  locale: string;
  provider?: string;
  model?: string;
  speaker?: string;
  voice?: string;
}): LocalizedNarrationSelection {
  if (input.locale !== "te" && input.locale !== "ta" && input.locale !== "hi") {
    throw new Error(`Unsupported locale: ${input.locale}. Use te, ta, or hi.`);
  }

  // Legacy queued jobs and older clients carried only OpenAI's `voice`.
  if (!input.provider) {
    if (!input.voice || !OPENAI_LOCALIZED_VOICES.has(input.voice as NarrationVoice)) {
      throw new Error(`Unsupported voice: ${input.voice ?? "missing"}.`);
    }
    return {
      locale: input.locale,
      provider: "openai",
      model: LOCALIZED_OPENAI_MODEL,
      speaker: input.voice,
    };
  }

  if (input.provider === "openai") {
    if (input.model !== LOCALIZED_OPENAI_MODEL) {
      throw new Error("OpenAI localized narration requires model gpt-audio.");
    }
    if (!input.speaker || !OPENAI_LOCALIZED_VOICES.has(input.speaker as NarrationVoice)) {
      throw new Error(`Unsupported OpenAI speaker: ${input.speaker ?? "missing"}.`);
    }
    if (input.voice && input.voice !== input.speaker) {
      throw new Error("OpenAI voice and speaker must identify the same stock voice.");
    }
    return {
      locale: input.locale,
      provider: "openai",
      model: LOCALIZED_OPENAI_MODEL,
      speaker: input.speaker,
    };
  }

  if (input.provider === "sarvam") {
    if (input.model !== SARVAM_TTS_MODEL) {
      throw new Error("Sarvam localized narration requires model bulbul:v3.");
    }
    if (
      !input.speaker ||
      !SARVAM_STOCK_SPEAKERS.includes(input.speaker as SarvamStockSpeaker)
    ) {
      throw new Error(`Unsupported Sarvam speaker: ${input.speaker ?? "missing"}.`);
    }
    if (input.voice) {
      throw new Error("Sarvam narration must use speaker, not the legacy OpenAI voice field.");
    }
    return {
      locale: input.locale,
      provider: "sarvam",
      model: SARVAM_TTS_MODEL,
      speaker: input.speaker,
    };
  }

  throw new Error(`Unsupported localized narration provider: ${input.provider}.`);
}

export async function createLocalizedCueSpeaker(
  selection: LocalizedNarrationSelection,
): Promise<(text: string) => Promise<Buffer>> {
  if (selection.provider === "openai") {
    const voice = selection.speaker as NarrationVoice;
    return (text) => speakIndicCue(text, voice);
  }
  const sarvamSpeaker = await createSarvamCueSpeaker(
    selection.speaker as SarvamStockSpeaker,
  );
  if (!sarvamSpeaker) {
    throw new VideoGenProviderError(
      "Sarvam narration is not configured. Ask a superadmin to add and test the Sarvam API key.",
    );
  }
  return (text) => sarvamSpeaker(text, selection.locale);
}

export interface TtsProviderDef {
  id: string;
  label: string;
  /** Secret required to use this provider; null = built-in OpenAI integration. */
  envKey: string | null;
  speak: (text: string, voice: NarrationVoice, apiKey: string | null) => Promise<Buffer>;
}

/**
 * Deepgram Aura voices closest in character to each OpenAI voice, so a
 * failover changes the narrator as little as the two catalogs allow.
 * https://developers.deepgram.com/docs/tts-models
 */
const DEEPGRAM_VOICES: Record<NarrationVoice, string> = {
  alloy: "aura-arcas-en", // natural, smooth, clear
  echo: "aura-orion-en", // approachable, calm
  fable: "aura-angus-en", // warm, friendly
  onyx: "aura-zeus-en", // deep, trustworthy
  nova: "aura-asteria-en", // clear, confident, energetic
  shimmer: "aura-luna-en", // friendly, engaging
};

async function speakWithOpenAI(text: string, voice: NarrationVoice): Promise<Buffer> {
  return textToSpeech(text, voice, "wav");
}

/**
 * Deepgram Aura. Asked for linear16 in a WAV container at 24kHz so the bytes
 * parse with the same header reader as the built-in provider's output.
 */
async function speakWithDeepgram(
  text: string,
  voice: NarrationVoice,
  apiKey: string | null,
): Promise<Buffer> {
  if (!apiKey) {
    throw new VideoGenProviderError("Deepgram text-to-speech is not configured.");
  }
  const params = new URLSearchParams({
    model: DEEPGRAM_VOICES[voice],
    encoding: "linear16",
    container: "wav",
    sample_rate: "24000",
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`https://api.deepgram.com/v1/speak?${params.toString()}`, {
      method: "POST",
      headers: { Authorization: `Token ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new VideoGenProviderError(`Narration timed out after ${TTS_TIMEOUT_MS / 1000}s.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new VideoGenProviderError(
      `Deepgram text-to-speech failed (${res.status}): ${await errorDetail(res)}`,
      res.status,
    );
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Catalog of narration voices providers, best-first. The built-in OpenAI proxy
 * stays the primary: no key to configure and it is the voice tenants have
 * already heard.
 */
export const TTS_PROVIDERS: readonly TtsProviderDef[] = [
  {
    id: "openai",
    label: "OpenAI (built in, no key needed)",
    envKey: null,
    speak: (text, voice) => speakWithOpenAI(text, voice),
  },
  {
    id: "deepgram",
    label: "Deepgram Aura",
    envKey: "DEEPGRAM_API_KEY",
    speak: speakWithDeepgram,
  },
] as const;

export function ttsHealthKey(providerId: string): string {
  return `tts:${providerId}`;
}

/**
 * The effective key for a provider. Deepgram deliberately reuses the key the
 * admin already saved for speech-to-text: it is the same Deepgram account, and
 * asking for it twice would be a worse admin screen, not a safer one.
 */
export async function resolveTtsApiKey(def: TtsProviderDef): Promise<string | null> {
  if (def.envKey === null) return null;
  const stored = await getStoredAsrKey(def.id);
  if (stored) return stored;
  return process.env[def.envKey] ?? null;
}

export async function isTtsProviderConfigured(def: TtsProviderDef): Promise<boolean> {
  return def.envKey === null || (await resolveTtsApiKey(def)) !== null;
}

/**
 * Configured providers, healthiest first, catalog order preserved within each
 * health class — so the built-in provider leads unless its breaker is open.
 */
export async function orderedTtsProviders(): Promise<TtsProviderDef[]> {
  const configured: TtsProviderDef[] = [];
  for (const def of TTS_PROVIDERS) {
    if (await isTtsProviderConfigured(def)) configured.push(def);
  }
  return orderByHealth(configured, (def) => ttsHealthKey(def.id));
}

/**
 * Whether a TTS error for an Indic cue is worth retrying.
 *
 * Retryable:
 *   - VideoGenProviderError with a transient HTTP status (429/500/502/503/504)
 *   - VideoGenProviderError with NO status (timeout produced by withTimeout, or
 *     a network-level abort) — same logic as isTransientTtsError in narration.ts
 *   - Any plain Error that is not a VideoGenProviderError (fetch TypeError, etc.)
 *
 * Not retryable:
 *   - VideoGenProviderError with a permanent 4xx status (400/401/403/404/422…):
 *     these indicate bad content or a configuration problem that a retry cannot
 *     fix, and recording one failure is enough for the circuit breaker.
 */
function isIndicTtsRetryable(error: unknown): boolean {
  if (error instanceof VideoGenProviderError) {
    if (error.status === undefined) return true; // timeout / network
    return isTransientStatus(error.status);
  }
  return error instanceof Error;
}

/**
 * Speak one Indic cue using the built-in OpenAI TTS provider only.
 *
 * Deepgram's Aura catalog is English-only, so there is no failover for Indic
 * dubs — only the built-in OpenAI proxy is attempted.
 *
 * Retry policy: transient HTTP errors (429/5xx), timeouts, and network
 * failures get up to 3 attempts with exponential back-off. Permanent 4xx
 * errors (bad content, auth) are not retried — they would fail identically
 * every time and recording multiple failures would unfairly trip the breaker.
 *
 * Provider-health recording:
 *   - A transient/network failure that exhausts all retries records ONE failure.
 *   - A permanent caller/content error does not affect provider health.
 *   - Success records success with the observed latency.
 *
 * @param text   The exact approved cue text. Never rephrased or split.
 * @param voice  An OpenAI stock voice from the six supported voices.
 * @returns      WAV bytes suitable for parseWav.
 */
export async function speakIndicCue(text: string, voice: NarrationVoice): Promise<Buffer> {
  const healthKey = ttsHealthKey("openai");
  const startedAt = Date.now();

  const speak = (): Promise<Buffer> =>
    withTimeout(
      () => speakWithOpenAI(text, voice),
      TTS_TIMEOUT_MS,
      "Indic TTS",
    );

  let audio: Buffer;
  try {
    audio = await withRetries(speak, { attempts: 3, isRetryable: isIndicTtsRetryable });
  } catch (err) {
    if (isIndicTtsRetryable(err)) {
      recordProviderFailure(healthKey);
    }
    throw err;
  }

  if (audio.length === 0) {
    recordProviderFailure(healthKey);
    throw new VideoGenProviderError("Text-to-speech returned no audio for cue.");
  }

  recordProviderSuccess(healthKey, Date.now() - startedAt);
  return audio;
}
