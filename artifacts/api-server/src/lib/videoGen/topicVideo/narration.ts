import { logger } from "../../logger";
import { recordProviderFailure, recordProviderSuccess } from "../../providerHealth";
import { VideoGenProviderError } from "../types";
import { withRetries, withTimeout, isTransientStatus } from "../retry";
import {
  TTS_TIMEOUT_MS,
  orderedTtsProviders,
  resolveTtsApiKey,
  ttsHealthKey,
  type TtsProviderDef,
} from "./tts";
import {
  buildBrandVoiceTtsOperationKey,
  isConfirmedVoiceCloneFailure,
  resolveElevenLabsSpeechLanguage,
  speakWithClonedVoiceReceipt,
  type ClonedVoiceRef,
} from "../../voiceClone";
import {
  elevenLabsCreditReservationCeiling,
  getAiCostConfig,
  elevenLabsCreditsToPaise,
} from "../../aiCost";
import {
  executeWalletProviderOperation,
  isWalletFunded,
  refundWallet,
  reserveWallet,
  settleWalletProviderOperationDurably,
  type WalletReservation,
} from "../../wallet";
import { recordUsage } from "../../usage";

/**
 * Narration for the Topic to Video engine.
 *
 * The script is split into sentence-sized chunks; each chunk is spoken
 * separately so its exact audio duration is known from the WAV header. That
 * gives frame-accurate subtitle cues and scene cut points with zero extra AI
 * calls — a deliberate simplification of MoneyPrinterTurbo's word-boundary
 * approach (MIT, app/services/voice.py + subtitle.py) that needs no
 * transcription model.
 *
 * Which engine speaks the words lives in ./tts. Failover between speakers is
 * whole-track, not per sentence — see that file for why.
 */

export type NarrationVoice = "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";

export const NARRATION_VOICES: readonly NarrationVoice[] = [
  "alloy",
  "echo",
  "fable",
  "onyx",
  "nova",
  "shimmer",
] as const;

export function isNarrationVoice(value: string | undefined | null): value is NarrationVoice {
  return !!value && (NARRATION_VOICES as readonly string[]).includes(value);
}

/**
 * Which stock voice narrates a job: an explicit choice on the job wins;
 * otherwise the brand kit's preset voice; otherwise the default narrator.
 * The request schema deliberately has NO default for voice — an inserted
 * "alloy" would read as an explicit choice and silently override the kit.
 */
export function resolveNarrationVoice(
  explicitVoice: string | undefined | null,
  kitPresetVoice: string | undefined | null,
): NarrationVoice {
  if (isNarrationVoice(explicitVoice)) return explicitVoice;
  if (isNarrationVoice(kitPresetVoice)) return kitPresetVoice;
  return "alloy";
}

/** Silence inserted between sentences for natural pacing. */
const SENTENCE_GAP_SEC = 0.25;
/** Silence appended after the last sentence so the video doesn't cut hard. */
const TAIL_SILENCE_SEC = 0.6;
/** Subtitle cues longer than this get split on secondary punctuation. */
const MAX_CHUNK_CHARS = 90;
/** Fragments shorter than this merge into their neighbor. */
const MIN_CHUNK_CHARS = 10;

/**
 * Split a narration script into speakable, subtitle-sized chunks.
 * Handles Latin, CJK and Devanagari sentence terminators.
 */
export function splitIntoSentences(script: string): string[] {
  const normalized = script.replace(/\s+/g, " ").trim();
  if (!normalized) return [];

  // Primary split: sentence terminators (kept with their sentence).
  const primary = normalized.match(/[^.!?。！？।]+[.!?。！？।]*/g) ?? [normalized];

  const chunks: string[] = [];
  for (const raw of primary) {
    const sentence = raw.trim();
    if (!sentence) continue;
    if (sentence.length <= MAX_CHUNK_CHARS) {
      chunks.push(sentence);
      continue;
    }
    // Secondary split on commas/semicolons, greedily packing chunks.
    const parts = sentence.split(/(?<=[,;，；、])\s*/);
    let current = "";
    for (const part of parts) {
      if (current && (current + " " + part).length > MAX_CHUNK_CHARS) {
        chunks.push(current.trim());
        current = part;
      } else {
        current = current ? `${current} ${part}` : part;
      }
    }
    if (current.trim()) chunks.push(current.trim());
  }

  // Merge tiny fragments into the previous chunk so no cue flashes by.
  const merged: string[] = [];
  for (const chunk of chunks) {
    const prev = merged[merged.length - 1];
    if (prev !== undefined && (chunk.length < MIN_CHUNK_CHARS || prev.length < MIN_CHUNK_CHARS)) {
      merged[merged.length - 1] = `${prev} ${chunk}`;
    } else {
      merged.push(chunk);
    }
  }
  return merged;
}

interface WavFormat {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  byteRate: number;
  blockAlign: number;
}

interface ParsedWav {
  format: WavFormat;
  /** Raw PCM bytes from the data chunk. */
  pcm: Buffer;
  durationSec: number;
}

/** Minimal RIFF/WAVE parser: fmt + data chunks only, PCM assumed. */
export function parseWav(buffer: Buffer): ParsedWav {
  if (
    buffer.length < 44 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new VideoGenProviderError("Text-to-speech returned unexpected audio data.");
  }
  let offset = 12;
  let format: WavFormat | null = null;
  let pcm: Buffer | null = null;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const body = buffer.subarray(offset + 8, Math.min(offset + 8 + chunkSize, buffer.length));
    if (chunkId === "fmt ") {
      format = {
        channels: body.readUInt16LE(2),
        sampleRate: body.readUInt32LE(4),
        byteRate: body.readUInt32LE(8),
        blockAlign: body.readUInt16LE(12),
        bitsPerSample: body.readUInt16LE(14),
      };
    } else if (chunkId === "data") {
      pcm = Buffer.from(body);
    }
    offset += 8 + chunkSize + (chunkSize % 2); // chunks are word-aligned
  }
  if (!format || !pcm || format.byteRate === 0) {
    throw new VideoGenProviderError("Text-to-speech returned unexpected audio data.");
  }
  return { format, pcm, durationSec: pcm.length / format.byteRate };
}

/** Build a complete WAV file from a format description and raw PCM bytes. */
export function buildWav(format: WavFormat, pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(format.channels, 22);
  header.writeUInt32LE(format.sampleRate, 24);
  header.writeUInt32LE(format.byteRate, 28);
  header.writeUInt16LE(format.blockAlign, 32);
  header.writeUInt16LE(format.bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** PCM silence of the given duration, aligned to whole frames. */
function silence(format: WavFormat, seconds: number): Buffer {
  const bytes = Math.round((format.byteRate * seconds) / format.blockAlign) * format.blockAlign;
  return Buffer.alloc(Math.max(bytes, 0));
}

export interface NarrationCue {
  text: string;
  /** Seconds from the start of the narration track. */
  startSec: number;
  endSec: number;
}

export interface Narration {
  /** Complete WAV file: all sentences with gaps and a trailing pause. */
  wav: Buffer;
  cues: NarrationCue[];
  totalDurationSec: number;
  /** Provider selected for the complete track (never mixed across cues). */
  provider?: string;
  model?: string;
  accountingMode?: "aggregate" | "unmetered" | "independently_settled";
  costPaise?: number | null;
}

/**
 * Whether a narration failure is the SPEAKER's fault (429/5xx/network/timeout,
 * or audio bytes that came back unusable), as opposed to something that would
 * fail identically on every provider.
 */
function isTransientTtsError(error: unknown): boolean {
  if (error instanceof VideoGenProviderError) {
    // No status = timeout, network shape, or unusable audio from this upstream.
    if (error.status === undefined) return true;
    return isTransientStatus(error.status);
  }
  return error instanceof Error;
}

/**
 * Speak the whole track on one provider. Throws unless every sentence came
 * back as usable audio in a single consistent format — a half-spoken track is
 * worth nothing to the caller, so partial results never escape this function.
 */
async function narrateWith(
  def: TtsProviderDef,
  sentences: string[],
  voice: NarrationVoice,
): Promise<ParsedWav[]> {
  const apiKey = await resolveTtsApiKey(def);
  const parts: ParsedWav[] = [];
  for (const sentence of sentences) {
    // Bounded + retried: the TTS call may have no abort support of its own,
    // so a hung or transiently-failing upstream gets one clean second chance
    // before the whole track moves to another provider.
    const audio = await withRetries(
      () => withTimeout(() => def.speak(sentence, voice, apiKey), TTS_TIMEOUT_MS, "Narration"),
      { attempts: 2 },
    );
    if (audio.length === 0) {
      throw new VideoGenProviderError("Text-to-speech returned no audio. Please try again.");
    }
    parts.push(parseWav(audio));
  }
  const first = parts[0]!.format;
  for (const part of parts) {
    if (
      part.format.sampleRate !== first.sampleRate ||
      part.format.channels !== first.channels ||
      part.format.bitsPerSample !== first.bitsPerSample
    ) {
      throw new VideoGenProviderError("Text-to-speech returned inconsistent audio formats.");
    }
  }
  return parts;
}

/**
 * Speak the whole track in a CLONED brand voice. Same contract as
 * narrateWith: all sentences in one consistent format or throw. Any failure
 * here (transient, misconfiguration, deleted voice) is handled by the caller
 * falling back to the stock voices for the ENTIRE track — a brand video with
 * a stock narrator beats a dead job, and mixing voices mid-track is never
 * acceptable.
 */
async function narrateWithBrandVoice(
  clonedVoice: ClonedVoiceRef,
  sentences: string[],
  billing?: BrandVoiceNarrationBilling | null,
  languageCode?: string,
  modelId?: "eleven_multilingual_v2" | "eleven_v3",
): Promise<ParsedWav[]> {
  // Validate before checking/reserving wallet funds. Legacy Topic narration
  // defaults to multilingual v2; Guided Story explicitly selects v3.
  const speechConfig = clonedVoice.provider === "elevenlabs"
    ? resolveElevenLabsSpeechLanguage(modelId ?? "eleven_multilingual_v2", languageCode)
    : { modelId: modelId ?? "eleven_multilingual_v2", languageCode };
  const walletFunded = billing ? await isWalletFunded(billing.tenantId) : false;
  const rateSnapshot =
    billing && clonedVoice.provider === "elevenlabs"
      ? (await getAiCostConfig()).elevenLabsInrPerCredit
      : null;
  if (walletFunded && !rateSnapshot) {
    throw new VideoGenProviderError(
      "ElevenLabs credit billing is not configured for cloned narration.",
    );
  }
  const parts: ParsedWav[] = [];
  for (const sentence of sentences) {
    const result = await withRetries(
      () =>
        withTimeout(
          async () => {
            let reservation: WalletReservation | null = null;
            let operationId: number | null = null;
            let confirmed = false;
            let providerCredits: string | null = null;
            let providerRequestId: string | null = null;
            let providerCostPaise: number | null = null;
            if (walletFunded && billing) {
              const ceilingPaise =
                rateSnapshot
                  ? elevenLabsCreditsToPaise(
                      elevenLabsCreditReservationCeiling(sentence),
                      rateSnapshot,
                    )
                  : null;
              if (ceilingPaise === null || ceilingPaise <= 0) {
                throw new VideoGenProviderError(
                  "ElevenLabs credit billing is not configured for cloned narration.",
                );
              }
              reservation = await reserveWallet(
                billing.tenantId,
                "caption",
                { provider: clonedVoice.provider, model: speechConfig.modelId },
                1,
                ceilingPaise,
              );
              if (!reservation) {
                throw new VideoGenProviderError(
                  "The wallet does not have enough balance for cloned narration.",
                );
              }
              try {
                const operation = await executeWalletProviderOperation(
                  {
                    tenantId: billing.tenantId,
                    reservation,
                    operationKind: "brand_voice_tts",
                    operationKey: buildBrandVoiceTtsOperationKey(
                      clonedVoice.voiceId,
                      speechConfig.modelId,
                      sentence,
                      undefined,
                      languageCode,
                    ),
                    settlement: {
                      kind: "caption",
                      costPaise: ceilingPaise,
                      provider: clonedVoice.provider,
                      model: speechConfig.modelId,
                      refKind: billing.refKind ?? "videoJob",
                      refId: billing.refId,
                    },
                  },
                  (confirmSuccess, recordReceipt) =>
                    speakWithClonedVoiceReceipt(
                      clonedVoice,
                      sentence,
                      async (receipt) => {
                        providerCredits = receipt.providerCredits;
                        providerRequestId = receipt.requestId ?? receipt.traceId;
                        await recordReceipt({
                          provider: clonedVoice.provider,
                          model: speechConfig.modelId,
                          providerCredits,
                          providerRequestId,
                          providerResultId: providerRequestId,
                        });
                        if (!providerCredits || !rateSnapshot) return;
                        providerCostPaise = elevenLabsCreditsToPaise(
                          providerCredits,
                          rateSnapshot,
                        );
                        if (providerCostPaise === null) return;
                        await confirmSuccess({
                          provider: clonedVoice.provider,
                          model: speechConfig.modelId,
                          costPaise: providerCostPaise,
                          providerCredits,
                          providerRequestId,
                          providerResultId: providerRequestId,
                        });
                      },
                       speechConfig.modelId,
                       speechConfig.languageCode,
                    ),
                  () => ({}),
                  {
                    isFailureConfirmed: isConfirmedVoiceCloneFailure,
                    requireExplicitSuccessConfirmation: true,
                  },
                );
                operationId = operation.operationId;
                confirmed = operation.confirmed;
                if (confirmed) {
                  await settleWalletProviderOperationDurably(operationId).catch((error) =>
                    logger.error(
                      { err: error, operationId },
                      "Cloned narration wallet settlement failed after provider success",
                    ),
                  );
                }
                const speech = operation.value;
                void recordUsage(billing.tenantId, "caption", {
                  funding: "wallet",
                  provider: clonedVoice.provider,
                  model: speechConfig.modelId,
                  inputCharacters: sentence.length,
                  ...(speech.receipt.providerCredits !== null
                    ? { providerCredits: speech.receipt.providerCredits }
                    : {}),
                  ...(speech.receipt.requestId ?? speech.receipt.traceId
                    ? {
                        providerRequestId:
                          speech.receipt.requestId ?? speech.receipt.traceId ?? undefined,
                      }
                    : {}),
                  ...(providerCostPaise !== null
                    ? { costPaise: providerCostPaise }
                    : {}),
                }).catch((error) =>
                  logger.error(
                    { err: error, operationId },
                    "Failed to record cloned narration usage",
                  ),
                );
                return speech;
              } catch (error) {
                // executeWalletProviderOperation has already marked an
                // authoritative 4xx rejection failed. Refund only that
                // resolved outcome; a timeout/5xx remains pending for safe
                // recovery rather than becoming an orphaned, refunded call.
                if (isConfirmedVoiceCloneFailure(error)) {
                  await refundWallet(
                    billing.tenantId,
                    reservation,
                    "Cloned narration provider call failed",
                  ).catch(() => {});
                }
                throw error;
              }
            }
            const speech = await speakWithClonedVoiceReceipt(
              clonedVoice,
              sentence,
              undefined,
              speechConfig.modelId,
              speechConfig.languageCode,
            );
            if (billing) {
              const costPaise =
                speech.receipt.providerCredits && rateSnapshot
                  ? elevenLabsCreditsToPaise(
                      speech.receipt.providerCredits,
                      rateSnapshot,
                    )
                  : null;
              void recordUsage(billing.tenantId, "caption", {
                funding: "unmetered",
                provider: clonedVoice.provider,
                model: speechConfig.modelId,
                inputCharacters: sentence.length,
                ...(speech.receipt.providerCredits !== null
                  ? { providerCredits: speech.receipt.providerCredits }
                  : {}),
                ...(speech.receipt.requestId ?? speech.receipt.traceId
                  ? {
                      providerRequestId:
                        speech.receipt.requestId ?? speech.receipt.traceId ?? undefined,
                    }
                  : {}),
                ...(costPaise !== null ? { costPaise } : {}),
              }).catch(() => {});
            }
            return speech;
          },
          TTS_TIMEOUT_MS,
          "Brand-voice narration",
        ),
      { attempts: 2 },
    );
    const audio = result.audio;
    if (audio.length === 0) {
      throw new VideoGenProviderError("The brand voice returned no audio.");
    }
    parts.push(parseWav(audio));
  }
  const first = parts[0]!.format;
  for (const part of parts) {
    if (
      part.format.sampleRate !== first.sampleRate ||
      part.format.channels !== first.channels ||
      part.format.bitsPerSample !== first.bitsPerSample
    ) {
      throw new VideoGenProviderError("The brand voice returned inconsistent audio formats.");
    }
  }
  return parts;
}

export interface SynthesizeNarrationOptions {
  /** Cloned brand voice to speak the track in (whole track). Stock voices
   * remain the fallback when it fails or is unconfigured. */
  clonedVoice?: ClonedVoiceRef | null;
  /** Guided role audio must never silently change performers. */
  requireClonedVoice?: boolean;
  billing?: BrandVoiceNarrationBilling | null;
  /** Provider-supported ISO language code frozen by the owning workflow. */
  languageCode?: string;
  /** Guided Story selects v3; Topic narration retains the v2 default. */
  brandVoiceModelId?: "eleven_multilingual_v2" | "eleven_v3";
}

export interface BrandVoiceNarrationBilling {
  tenantId: number;
  refKind?: string | null;
  refId?: string | null;
}

/**
 * Speak every sentence, then stitch one narration track with per-sentence
 * timings. Sentences are spoken sequentially — the TTS proxy is the
 * bottleneck and parallel calls would just trip rate limits.
 *
 * If the speaker fails transiently, the ENTIRE track is re-spoken on the next
 * configured provider (healthiest first). Mixing two providers inside one
 * track would produce inconsistent sample rates and be rejected below, and
 * re-speaking costs seconds where failing costs the tenant a video unit.
 *
 * When a cloned brand voice is supplied it is tried FIRST, whole track. Any
 * brand-voice failure — provider down, key removed, voice deleted — falls
 * back to the stock voices below; the callers gate the feature switch and
 * only pass a clonedVoice when brand-voice narration should be attempted.
 */
export async function synthesizeNarration(
  sentences: string[],
  voice: NarrationVoice,
  options?: SynthesizeNarrationOptions,
): Promise<Narration> {
  if (sentences.length === 0) {
    throw new VideoGenProviderError("There is no narration to speak.");
  }

  let spoken: ParsedWav[] | null = null;
  let lastError: unknown;

  if (options?.clonedVoice) {
    try {
      spoken = await narrateWithBrandVoice(
        options.clonedVoice,
        sentences,
        options.billing,
        options.languageCode,
        options.brandVoiceModelId,
      );
      recordProviderSuccess(ttsHealthKey(`brand:${options.clonedVoice.provider}`));
    } catch (error) {
      recordProviderFailure(
        ttsHealthKey(`brand:${options.clonedVoice.provider}`),
        error instanceof Error ? error.message : undefined,
      );
      logger.warn(
        { provider: options.clonedVoice.provider, err: error },
        "Brand-voice narration failed; falling back to the stock voices for the whole track",
      );
      if (options.requireClonedVoice) throw error;
    }
  }

  if (spoken) {
    return {
      ...stitchNarration(spoken, sentences),
      provider: options!.clonedVoice!.provider,
      model: options!.brandVoiceModelId ?? "eleven_multilingual_v2",
      accountingMode: "independently_settled",
      costPaise: null,
    };
  }

  const providers = await orderedTtsProviders();
  if (providers.length === 0) {
    throw new VideoGenProviderError("No text-to-speech provider is configured.");
  }
  for (let i = 0; i < providers.length; i++) {
    const def = providers[i]!;
    try {
      spoken = await narrateWith(def, sentences, voice);
      recordProviderSuccess(ttsHealthKey(def.id));
      return {
        ...stitchNarration(spoken, sentences),
        provider: def.id,
        model: voice,
        // Managed stock TTS exposes no authoritative wallet receipt or audio
        // price. Keep product-unit accounting, but never invent a paid cost.
        accountingMode: "unmetered",
        costPaise: null,
      };
    } catch (error) {
      // A permanent failure (bad key, rejected text) will repeat everywhere.
      if (!isTransientTtsError(error)) throw error;
      recordProviderFailure(
        ttsHealthKey(def.id),
        error instanceof Error ? error.message : undefined,
      );
      lastError = error;
      const next = providers[i + 1];
      if (next) {
        logger.warn(
          { provider: def.id, fallback: next.id, err: error },
          "Narration provider failed transiently; re-speaking the track on the fallback",
        );
      }
    }
  }
  if (!spoken) {
    throw lastError ?? new VideoGenProviderError("Text-to-speech failed. Please try again.");
  }
  return stitchNarration(spoken, sentences);
}

/** Stitch spoken sentence parts into one WAV with gaps, cues, and a tail. */
function stitchNarration(parts: ParsedWav[], sentences: string[]): Narration {
  const format = parts[0]!.format;

  const gap = silence(format, SENTENCE_GAP_SEC);
  const tail = silence(format, TAIL_SILENCE_SEC);
  const cues: NarrationCue[] = [];
  const pcmParts: Buffer[] = [];
  let cursor = 0;
  parts.forEach((part, i) => {
    cues.push({
      text: sentences[i]!,
      startSec: cursor,
      endSec: cursor + part.durationSec,
    });
    pcmParts.push(part.pcm);
    cursor += part.durationSec;
    if (i < parts.length - 1) {
      pcmParts.push(gap);
      cursor += gap.length / format.byteRate;
    }
  });
  pcmParts.push(tail);
  cursor += tail.length / format.byteRate;

  return {
    wav: buildWav(format, Buffer.concat(pcmParts)),
    cues,
    totalDurationSec: cursor,
  };
}
