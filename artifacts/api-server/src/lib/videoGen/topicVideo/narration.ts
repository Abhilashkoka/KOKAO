import { textToSpeech } from "@workspace/integrations-openai-ai-server/audio";
import { VideoGenProviderError } from "../types";
import { withRetries, withTimeout } from "../retry";

/** A single sentence should never take this long to speak; a hung TTS call
 * must not stall the whole multi-minute job. */
const TTS_TIMEOUT_MS = 90_000;

/**
 * Narration for the Topic to Video engine.
 *
 * The script is split into sentence-sized chunks; each chunk is spoken
 * separately so its exact audio duration is known from the WAV header. That
 * gives frame-accurate subtitle cues and scene cut points with zero extra AI
 * calls — a deliberate simplification of MoneyPrinterTurbo's word-boundary
 * approach (MIT, app/services/voice.py + subtitle.py) that needs no
 * transcription model.
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
}

/**
 * Speak every sentence, then stitch one narration track with per-sentence
 * timings. Sentences are spoken sequentially — the TTS proxy is the
 * bottleneck and parallel calls would just trip rate limits.
 */
export async function synthesizeNarration(
  sentences: string[],
  voice: NarrationVoice,
): Promise<Narration> {
  if (sentences.length === 0) {
    throw new VideoGenProviderError("There is no narration to speak.");
  }
  const parts: ParsedWav[] = [];
  for (const sentence of sentences) {
    // Bounded + retried: the TTS SDK call has no abort support of its own,
    // so a hung or transiently-failing upstream gets one clean second chance
    // instead of stalling (or instantly failing) the whole job.
    const audio = await withRetries(
      () =>
        withTimeout(() => textToSpeech(sentence, voice, "wav"), TTS_TIMEOUT_MS, "Narration"),
      { attempts: 2 },
    );
    if (audio.length === 0) {
      throw new VideoGenProviderError("Text-to-speech returned no audio. Please try again.");
    }
    parts.push(parseWav(audio));
  }
  const format = parts[0]!.format;
  for (const part of parts) {
    if (
      part.format.sampleRate !== format.sampleRate ||
      part.format.channels !== format.channels ||
      part.format.bitsPerSample !== format.bitsPerSample
    ) {
      throw new VideoGenProviderError("Text-to-speech returned inconsistent audio formats.");
    }
  }

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
