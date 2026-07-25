import type { NarrationCue } from "./narration";

/**
 * Word-level timing for dynamic captions — the short-form social style where
 * big 2-3 word groups pop in sync with the voice.
 *
 * The narration pipeline already knows each SENTENCE's exact boundaries (every
 * sentence is spoken separately and measured from its WAV header). Within a
 * sentence, TTS pacing is steady, so distributing the sentence's duration
 * across its words proportionally to their length lands within a frame or two
 * of the spoken word — no transcription model, no extra cost, fully
 * deterministic. (OpenMontage reaches the same effect with ASR timestamps;
 * exact sentence anchors make that unnecessary here.)
 */

export interface WordTiming {
  text: string;
  /** Seconds from the start of the narration track. */
  startSec: number;
  endSec: number;
}

export interface CaptionChunk {
  /** 1-3 words shown together. */
  text: string;
  startSec: number;
  endSec: number;
}

/** Target width of one dynamic caption (characters). */
const CHUNK_MAX_CHARS = 16;
/** At most this many words per dynamic caption. */
const CHUNK_MAX_WORDS = 3;
/** CJK scripts have no spaces; runs are split into groups this long. */
const CJK_GROUP_CHARS = 4;

const CJK_RE = /[぀-ヿ㐀-䶿一-鿿가-힯]/;

/** Split a cue's text into caption-word tokens (CJK runs become short groups). */
export function tokenizeCueText(text: string): string[] {
  const rough = text.trim().split(/\s+/).filter(Boolean);
  const tokens: string[] = [];
  for (const token of rough) {
    if (token.length > CJK_GROUP_CHARS * 2 && CJK_RE.test(token)) {
      for (let i = 0; i < token.length; i += CJK_GROUP_CHARS) {
        tokens.push(token.slice(i, i + CJK_GROUP_CHARS));
      }
    } else {
      tokens.push(token);
    }
  }
  return tokens;
}

/**
 * Per-word timings within one cue: the cue's measured duration is split
 * across its words proportionally to length (+1 for the following pause).
 */
export function cueWordTimings(cue: NarrationCue): WordTiming[] {
  const tokens = tokenizeCueText(cue.text);
  if (tokens.length === 0) return [];
  const span = Math.max(cue.endSec - cue.startSec, 0.05);
  const weights = tokens.map((token) => token.length + 1);
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);

  const timings: WordTiming[] = [];
  let cursor = cue.startSec;
  for (let i = 0; i < tokens.length; i++) {
    const width = (span * weights[i]!) / totalWeight;
    timings.push({ text: tokens[i]!, startSec: cursor, endSec: cursor + width });
    cursor += width;
  }
  // Absorb float drift so the last word ends exactly on the cue boundary.
  timings[timings.length - 1]!.endSec = cue.endSec;
  return timings;
}

/**
 * Group word timings into display chunks: up to 3 words / ~16 characters,
 * never spanning a sentence boundary. Each chunk runs from its first word's
 * start to its last word's end; the renderer holds it until the next chunk
 * appears so text never flickers off mid-pause.
 */
export function buildCaptionChunks(cues: NarrationCue[]): CaptionChunk[] {
  const chunks: CaptionChunk[] = [];
  for (const cue of cues) {
    const words = cueWordTimings(cue);
    let group: WordTiming[] = [];
    const flush = () => {
      if (group.length === 0) return;
      chunks.push({
        text: group.map((w) => w.text).join(" "),
        startSec: group[0]!.startSec,
        endSec: group[group.length - 1]!.endSec,
      });
      group = [];
    };
    for (const word of words) {
      const joined = [...group.map((w) => w.text), word.text].join(" ");
      if (group.length > 0 && (group.length >= CHUNK_MAX_WORDS || joined.length > CHUNK_MAX_CHARS)) {
        flush();
      }
      group.push(word);
    }
    flush();
  }
  return chunks;
}
