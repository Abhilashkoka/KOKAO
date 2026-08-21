/**
 * Subtitle cues: the shared shape, the spec limits, validation, and SRT/VTT.
 *
 * The numeric limits are the Netflix timed-text figures, which all three
 * target languages happen to share. They are the industry floor rather than a
 * house style — a file that passes them will be accepted anywhere, and a file
 * that fails them is objectively hard to read, not merely unfashionable.
 */

/** One subtitle cue. Times are milliseconds from the start of the video. */
export interface SubtitleCue {
  /** 1-based position in the file. */
  index: number;
  startMs: number;
  endMs: number;
  /** Cue text. May contain a single "\n" to split across two lines. */
  text: string;
}

export const SUBTITLE_LIMITS = {
  /** Maximum characters on one line. */
  maxCharsPerLine: 42,
  /** Maximum lines in one cue. */
  maxLines: 2,
  /** Maximum reading speed for adult programming, characters per second. */
  maxCharsPerSecond: 22,
  /** Maximum reading speed for children's programming. */
  maxCharsPerSecondChildren: 18,
  /** Shortest cue that can be read at all: 5/6 of a second. */
  minDurationMs: 833,
  /** Longest a single cue should sit on screen. */
  maxDurationMs: 7000,
} as const;

export type CueIssueCode =
  | "line_too_long"
  | "too_many_lines"
  | "reading_speed"
  | "duration_too_short"
  | "duration_too_long"
  | "overlaps_previous"
  | "orphan_top_line"
  | "top_heavy"
  | "empty";

export interface CueIssue {
  code: CueIssueCode;
  /** "error" breaks the spec; "warning" is a style call a human may override. */
  severity: "error" | "warning";
  message: string;
}

export interface ValidateCueOptions {
  /** Apply the stricter children's reading speed. */
  childrenContent?: boolean;
  /** End time of the preceding cue, to detect overlap. */
  previousEndMs?: number;
}

/** Characters that count toward reading speed — everything but the line break. */
export function cueCharCount(text: string): number {
  return text.replace(/\n/g, "").length;
}

export function cueDurationMs(cue: SubtitleCue): number {
  return Math.max(0, cue.endMs - cue.startMs);
}

export function charsPerSecond(cue: SubtitleCue): number {
  const seconds = cueDurationMs(cue) / 1000;
  if (seconds <= 0) return Infinity;
  return cueCharCount(cue.text) / seconds;
}

/**
 * Check one cue against the spec. Returns every issue found, most severe
 * first, so a UI can show the blocking problems without hiding the nits.
 */
export function validateCue(cue: SubtitleCue, options: ValidateCueOptions = {}): CueIssue[] {
  const issues: CueIssue[] = [];
  const lines = cue.text.split("\n");
  const duration = cueDurationMs(cue);

  if (cue.text.trim().length === 0) {
    issues.push({ code: "empty", severity: "error", message: "Cue has no text." });
    return issues;
  }

  if (lines.length > SUBTITLE_LIMITS.maxLines) {
    issues.push({
      code: "too_many_lines",
      severity: "error",
      message: `${lines.length} lines. Maximum is ${SUBTITLE_LIMITS.maxLines}.`,
    });
  }

  lines.forEach((line, i) => {
    if (line.length > SUBTITLE_LIMITS.maxCharsPerLine) {
      issues.push({
        code: "line_too_long",
        severity: "error",
        message: `Line ${i + 1} is ${line.length} characters. Maximum is ${SUBTITLE_LIMITS.maxCharsPerLine}.`,
      });
    }
  });

  const cpsLimit = options.childrenContent
    ? SUBTITLE_LIMITS.maxCharsPerSecondChildren
    : SUBTITLE_LIMITS.maxCharsPerSecond;
  const cps = charsPerSecond(cue);
  if (cps > cpsLimit) {
    issues.push({
      code: "reading_speed",
      severity: "error",
      message: `${cps.toFixed(1)} characters per second. Maximum is ${cpsLimit}. Shorten the line or hold the cue longer.`,
    });
  }

  if (duration > 0 && duration < SUBTITLE_LIMITS.minDurationMs) {
    issues.push({
      code: "duration_too_short",
      severity: "error",
      message: `On screen for ${duration}ms. Minimum is ${SUBTITLE_LIMITS.minDurationMs}ms.`,
    });
  }
  if (duration > SUBTITLE_LIMITS.maxDurationMs) {
    issues.push({
      code: "duration_too_long",
      severity: "warning",
      message: `On screen for ${(duration / 1000).toFixed(1)}s. Consider splitting above ${SUBTITLE_LIMITS.maxDurationMs / 1000}s.`,
    });
  }

  if (options.previousEndMs !== undefined && cue.startMs < options.previousEndMs) {
    issues.push({
      code: "overlaps_previous",
      severity: "error",
      message: "Starts before the previous cue ends.",
    });
  }

  if (lines.length === 2) {
    const [top, bottom] = lines as [string, string];
    if (top.trim().split(/\s+/).length <= 2 && bottom.length > top.length) {
      issues.push({
        code: "orphan_top_line",
        severity: "warning",
        message: "Only one or two words on the top line. Rebalance the break.",
      });
    } else if (top.length > bottom.length) {
      issues.push({
        code: "top_heavy",
        severity: "warning",
        message: "Top line is longer than the bottom. Prefer a bottom-heavy break.",
      });
    }
  }

  return issues.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
}

/** Validate a whole track, threading each cue's end time into the next check. */
export function validateCues(
  cues: readonly SubtitleCue[],
  options: Omit<ValidateCueOptions, "previousEndMs"> = {},
): Map<number, CueIssue[]> {
  const byIndex = new Map<number, CueIssue[]>();
  let previousEndMs: number | undefined;
  for (const cue of cues) {
    const issues = validateCue(cue, { ...options, previousEndMs });
    if (issues.length > 0) byIndex.set(cue.index, issues);
    previousEndMs = cue.endMs;
  }
  return byIndex;
}

/**
 * Break a single line into at most two, bottom-heavy.
 *
 * Prefers a break at a word boundary that leaves the top line shorter than the
 * bottom one, which is what every timed-text style guide asks for and what
 * reads fastest. Text that already fits is returned untouched; a single token
 * longer than the limit is left alone rather than hard-split, because
 * hard-splitting an Indic word breaks its conjuncts.
 */
export function wrapCueText(text: string, maxCharsPerLine = SUBTITLE_LIMITS.maxCharsPerLine): string {
  const flat = text.replace(/\s*\n\s*/g, " ").trim();
  if (flat.length <= maxCharsPerLine) return flat;

  const words = flat.split(/\s+/);
  if (words.length < 2) return flat;

  let best: { top: string; bottom: string } | null = null;
  for (let split = 1; split < words.length; split += 1) {
    const top = words.slice(0, split).join(" ");
    const bottom = words.slice(split).join(" ");
    if (top.length > maxCharsPerLine || bottom.length > maxCharsPerLine) continue;
    // Bottom-heavy: prefer the split with the shortest top line that still fits.
    if (best === null || top.length < best.top.length) best = { top, bottom };
  }

  if (best === null) return flat;
  return `${best.top}\n${best.bottom}`;
}

/* ------------------------------------------------------------------ *
 * SRT and WebVTT
 * ------------------------------------------------------------------ */

function pad(value: number, width: number): string {
  return String(Math.floor(value)).padStart(width, "0");
}

/** Format milliseconds as an SRT timecode: HH:MM:SS,mmm */
export function formatSrtTime(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const hours = Math.floor(clamped / 3_600_000);
  const minutes = Math.floor((clamped % 3_600_000) / 60_000);
  const seconds = Math.floor((clamped % 60_000) / 1000);
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(clamped % 1000, 3)}`;
}

/** Format milliseconds as a WebVTT timecode: HH:MM:SS.mmm */
export function formatVttTime(ms: number): string {
  return formatSrtTime(ms).replace(",", ".");
}

const SRT_TIME_RE = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

function parseSrtTime(value: string): number | null {
  const match = SRT_TIME_RE.exec(value.trim());
  if (!match) return null;
  const [, h, m, s, msRaw] = match as unknown as [string, string, string, string, string];
  const ms = Number(msRaw.padEnd(3, "0"));
  return Number(h) * 3_600_000 + Number(m) * 60_000 + Number(s) * 1000 + ms;
}

/**
 * Serialise cues as SRT.
 *
 * Emitted as UTF-8 with no byte-order mark: a BOM on an SRT file is the single
 * most common reason a player renders the first cue as garbage. Callers must
 * not add one when writing the file.
 */
export function toSrt(cues: readonly SubtitleCue[]): string {
  return (
    cues
      .map((cue, i) => {
        const index = cue.index > 0 ? cue.index : i + 1;
        return `${index}\n${formatSrtTime(cue.startMs)} --> ${formatSrtTime(cue.endMs)}\n${cue.text}\n`;
      })
      .join("\n") + (cues.length > 0 ? "" : "")
  );
}

/** Serialise cues as WebVTT, for `<track>` elements and browser players. */
export function toVtt(cues: readonly SubtitleCue[]): string {
  const body = cues
    .map((cue, i) => {
      const index = cue.index > 0 ? cue.index : i + 1;
      return `${index}\n${formatVttTime(cue.startMs)} --> ${formatVttTime(cue.endMs)}\n${cue.text}\n`;
    })
    .join("\n");
  return `WEBVTT\n\n${body}`;
}

/**
 * Parse SRT or WebVTT into cues.
 *
 * Tolerant on input by design — files arrive from every editor there is. Strips
 * a leading BOM, accepts CRLF or LF, accepts a missing or non-numeric index
 * line, accepts "." or "," as the millisecond separator, and skips blocks with
 * no parseable timecode rather than throwing the whole file away.
 */
export function parseSubtitleFile(source: string): SubtitleCue[] {
  const normalized = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const withoutHeader = normalized.replace(/^WEBVTT[^\n]*\n(?:[^\n]*\n)*?\n/, "");
  const blocks = withoutHeader.split(/\n{2,}/);
  const cues: SubtitleCue[] = [];

  for (const block of blocks) {
    const lines = block.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length === 0) continue;

    const arrowAt = lines.findIndex((line) => line.includes("-->"));
    if (arrowAt === -1) continue;

    const [rawStart, rawEnd] = lines[arrowAt]!.split("-->");
    if (rawStart === undefined || rawEnd === undefined) continue;
    const startMs = parseSrtTime(rawStart);
    const endMs = parseSrtTime(rawEnd);
    if (startMs === null || endMs === null) continue;

    const text = lines.slice(arrowAt + 1).join("\n").trim();
    if (text.length === 0) continue;

    const declared = arrowAt > 0 ? Number(lines[arrowAt - 1]!.trim()) : NaN;
    cues.push({
      index: Number.isInteger(declared) && declared > 0 ? declared : cues.length + 1,
      startMs,
      endMs,
      text,
    });
  }

  return cues;
}
