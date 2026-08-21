/**
 * Normalising transcript timings across providers.
 *
 * Every ASR vendor reports spans differently — Whisper gives sentence-ish
 * segments in seconds, Deepgram gives utterances in seconds, AssemblyAI gives
 * words in milliseconds. The localization pipeline wants one shape: ordered,
 * non-empty, millisecond spans that do not overlap. These helpers do that
 * conversion in one place so the providers stay thin.
 */

import type { TranscriptSegment } from "./types";

/** A word with its own timing, as AssemblyAI returns them. */
export interface TimedWord {
  startMs: number;
  endMs: number;
  text: string;
}

/**
 * Drop junk and enforce ordering.
 *
 * A segment with no text, a non-finite bound, or zero length is noise rather
 * than data. Overlapping spans are trimmed rather than dropped: a provider
 * occasionally reports a segment that starts a few milliseconds before the
 * previous one ended, and losing the line would be worse than nudging it.
 */
export function normalizeSegments(raw: readonly TranscriptSegment[]): TranscriptSegment[] {
  const cleaned = raw
    .map((segment) => ({
      startMs: Math.max(0, Math.round(segment.startMs)),
      endMs: Math.max(0, Math.round(segment.endMs)),
      text: segment.text.trim().replace(/\s+/g, " "),
    }))
    .filter(
      (segment) =>
        segment.text.length > 0 &&
        Number.isFinite(segment.startMs) &&
        Number.isFinite(segment.endMs) &&
        segment.endMs > segment.startMs,
    )
    .sort((a, b) => a.startMs - b.startMs);

  const out: TranscriptSegment[] = [];
  for (const segment of cleaned) {
    const previous = out[out.length - 1];
    if (previous && segment.startMs < previous.endMs) {
      if (segment.endMs <= previous.endMs) continue; // fully swallowed
      out.push({ ...segment, startMs: previous.endMs });
      continue;
    }
    out.push(segment);
  }
  return out;
}

/**
 * Seconds from a provider that reports floats, as milliseconds.
 *
 * Returns NaN — never 0 — for a timing the provider omitted, so
 * `normalizeSegments` drops the span instead of pinning it to the start of the
 * video. `Number(null)` is 0, which is exactly the wrong answer here.
 */
export function secondsToMs(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "string") return NaN;
  if (typeof value === "string" && value.trim() === "") return NaN;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : NaN;
}

/** Longest a grouped segment may run before it is broken regardless of punctuation. */
const MAX_SEGMENT_MS = 7000;

/**
 * Group word-level timings into sentence-shaped segments.
 *
 * Breaks on sentence-final punctuation, and on length so a speaker who never
 * pauses does not produce one twenty-second span that no subtitle can hold.
 */
export function groupWordsIntoSegments(words: readonly TimedWord[]): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  let current: TimedWord[] = [];

  const flush = (): void => {
    if (current.length === 0) return;
    segments.push({
      startMs: current[0]!.startMs,
      endMs: current[current.length - 1]!.endMs,
      text: current.map((word) => word.text).join(" "),
    });
    current = [];
  };

  for (const word of words) {
    if (!word.text.trim()) continue;
    current.push(word);
    const endsSentence = /[.!?。！？]["')\]]?$/.test(word.text.trim());
    const tooLong = word.endMs - current[0]!.startMs >= MAX_SEGMENT_MS;
    if (endsSentence || tooLong) flush();
  }
  flush();

  return normalizeSegments(segments);
}
