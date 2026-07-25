import { textToSpeech } from "@workspace/integrations-openai-ai-server/audio";
import { getStoredAsrKey } from "../../asr";
import { orderByHealth } from "../../providerHealth";
import { VideoGenProviderError, errorDetail } from "../types";
import type { NarrationVoice } from "./narration";

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
