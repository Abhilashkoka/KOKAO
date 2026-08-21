/**
 * Transcreate a timed English script into Telugu, Tamil or Hindi.
 *
 * Not translation. A translated line is grammatical, accurate, and the wrong
 * register — it is how an ad ends up sounding like a government circular. What
 * has to survive is the brand's register, stance and rhythm; the words are
 * free to change completely. See @workspace/localization for the rules this
 * builds its prompt from.
 *
 * The hard constraint is time. The picture is locked, so every line has a fixed
 * number of milliseconds to land in, and Telugu and Tamil need roughly 40% more
 * syllables than English to say the same thing. Each cue therefore carries an
 * explicit syllable budget into the prompt, and the result is measured against
 * it afterwards rather than trusted.
 */

import type OpenAI from "openai";

import {
  describeVoiceProfile,
  estimateEnglishSyllables,
  estimateSyllables,
  hasBlockingIssue,
  lintLocalizedText,
  lintUntranslatables,
  localePolicy,
  syllableBudget,
  validateCue,
  wrapCueText,
  type BrandVoiceProfile,
  type CueIssue,
  type LocalizationIssue,
  type TargetLocale,
} from "@workspace/localization";

import { parseModelJsonObject } from "../modelJson";

/** One English cue on the timing spine. */
export interface SourceCue {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
}

/** One transcreated cue, measured and linted. */
export interface TranscreatedCue {
  index: number;
  startMs: number;
  endMs: number;
  /** The target-language line, wrapped for subtitle display. */
  text: string;
  /**
   * A blind back-translation into English produced in the same pass.
   *
   * The point is drift, not accuracy: if this reads differently from the
   * source, the transcreation broke at the level of meaning, and no amount of
   * polishing the wording will fix it.
   */
  backTranslation: string;
  sourceSyllables: number;
  syllables: number;
  syllableBudget: number;
  /** Editorial problems: wrong script, stray Latin, dead coinages, over budget. */
  issues: LocalizationIssue[];
  /** Timed-text problems: line length, reading speed, duration. */
  cueIssues: CueIssue[];
}

export interface TranscreateResult {
  locale: TargetLocale;
  cues: TranscreatedCue[];
  /** Track-level issues, e.g. a brand name that vanished from the whole script. */
  trackIssues: LocalizationIssue[];
  /** True when anything in the track blocks delivery. */
  blocked: boolean;
  /** Raw model output, for the "what was sent" disclosure in the UI. */
  systemPrompt: string;
  rawResponse: string;
}

/**
 * Cues per model call.
 *
 * Small enough that the model keeps every line's budget in view and does not
 * start drifting into summary, large enough that a 60-second ad is one or two
 * calls. Each chunk is independent, so a chunk that comes back malformed only
 * costs its own lines.
 */
const CUES_PER_CALL = 25;

/** Hard ceiling on script length, so one request cannot run up an unbounded bill. */
export const MAX_SOURCE_CUES = 300;

function buildSystemPrompt(locale: TargetLocale, profile: BrandVoiceProfile): string {
  const policy = localePolicy(locale);

  return [
    `You are a senior advertising copywriter who writes in ${policy.label} (${policy.endonym}) ` +
      `for Indian consumer brands. You are transcreating, not translating: the English below is ` +
      `a reference for meaning and intent, never a template for word order.`,
    "",
    "THE BRAND VOICE — these survive into every language, unchanged:",
    describeVoiceProfile(profile),
    "",
    `WRITING IN ${policy.label.toUpperCase()}:`,
    policy.registerNote,
    "",
    "TIMING — this is the hard constraint:",
    "The video is already edited. Each line has a fixed slot and a syllable budget for it.",
    `${policy.label} needs roughly ${policy.syllableRatio}x the syllables of English to say the ` +
      "same thing, and the budget already accounts for that. If a line will not fit, cut a word " +
      "or drop an adjective. Never pad, and never write a line you would have to rush to read.",
    "",
    "WORD ORDER:",
    `${policy.label} puts the verb at the end. An English line engineered so the punch lands on ` +
      "the last word will land somewhere else once translated. Rebuild the sentence so the " +
      "emphatic idea still arrives last, rather than preserving the English order.",
    "",
    "OUTPUT:",
    'Reply with JSON only: {"lines":[{"index":<number>,"text":"<target line>","back":"<literal English back-translation>"}]}',
    "Return one object per input line, with the same index. Do not merge or split lines.",
    '"back" must be a literal, unpolished back-translation of what you actually wrote — it is a ' +
      "check on meaning drift, so do not restore the original English wording from memory.",
  ].join("\n");
}

function buildUserPrompt(cues: readonly SourceCue[], locale: TargetLocale): string {
  const rows = cues.map((cue) => {
    const source = estimateEnglishSyllables(cue.text);
    const budget = syllableBudget(source, locale);
    const seconds = Math.max(0, cue.endMs - cue.startMs) / 1000;
    return `${cue.index}. [${seconds.toFixed(1)}s, max ${budget} syllables] ${cue.text}`;
  });
  return `Transcreate these lines:\n\n${rows.join("\n")}`;
}

interface ModelLine {
  index: number;
  text: string;
  back: string;
}

function parseModelLines(raw: string): Map<number, ModelLine> {
  const byIndex = new Map<number, ModelLine>();
  const parsed = parseModelJsonObject(raw) as { lines?: unknown } | null;
  if (!parsed || !Array.isArray(parsed.lines)) return byIndex;

  for (const entry of parsed.lines) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as { index?: unknown; text?: unknown; back?: unknown };
    const index = Number(row.index);
    if (!Number.isInteger(index)) continue;
    const text = typeof row.text === "string" ? row.text.trim() : "";
    if (!text) continue;
    byIndex.set(index, {
      index,
      text,
      back: typeof row.back === "string" ? row.back.trim() : "",
    });
  }
  return byIndex;
}

/** Split cues into model-sized chunks, preserving order. */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface TranscreateOptions {
  cues: readonly SourceCue[];
  locale: TargetLocale;
  profile: BrandVoiceProfile;
  client: OpenAI;
  model: string;
  /** Extra params for usage accounting, passed straight through. */
  requestParams?: Record<string, unknown>;
  /** Apply the stricter children's reading speed when validating cues. */
  childrenContent?: boolean;
}

/**
 * Run the transcreation and measure the result.
 *
 * A cue the model failed to return comes back with empty text and a blocking
 * issue rather than being silently dropped — a missing line in a dub is far
 * worse than a flagged one, because nobody notices until the render.
 */
export async function transcreateCues(options: TranscreateOptions): Promise<TranscreateResult> {
  const { cues, locale, profile, client, model } = options;
  const systemPrompt = buildSystemPrompt(locale, profile);

  const lines = new Map<number, ModelLine>();
  const rawParts: string[] = [];

  for (const group of chunk(cues, CUES_PER_CALL)) {
    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: buildUserPrompt(group, locale) },
      ],
      max_completion_tokens: 8192,
      response_format: { type: "json_object" },
      ...(options.requestParams ?? {}),
    });

    const raw = completion.choices[0]?.message?.content ?? "{}";
    rawParts.push(raw);
    for (const [index, line] of parseModelLines(raw)) lines.set(index, line);
  }

  const out: TranscreatedCue[] = cues.map((cue) => {
    const sourceSyllables = estimateEnglishSyllables(cue.text);
    const budget = syllableBudget(sourceSyllables, locale);
    const line = lines.get(cue.index);

    if (!line) {
      return {
        index: cue.index,
        startMs: cue.startMs,
        endMs: cue.endMs,
        text: "",
        backTranslation: "",
        sourceSyllables,
        syllables: 0,
        syllableBudget: budget,
        issues: [
          {
            code: "wrong_script",
            severity: "error",
            message: "The model did not return this line. Re-run, or write it by hand.",
          },
        ],
        cueIssues: [],
      };
    }

    const wrapped = wrapCueText(line.text);
    const syllables = estimateSyllables(wrapped, locale);

    return {
      index: cue.index,
      startMs: cue.startMs,
      endMs: cue.endMs,
      text: wrapped,
      backTranslation: line.back,
      sourceSyllables,
      syllables,
      syllableBudget: budget,
      issues: lintLocalizedText(wrapped, { locale, profile, syllables, syllableBudget: budget }),
      cueIssues: validateCue(
        { index: cue.index, startMs: cue.startMs, endMs: cue.endMs, text: wrapped },
        { childrenContent: options.childrenContent },
      ),
    };
  });

  const trackIssues = lintUntranslatables(
    cues.map((c) => c.text).join(" "),
    out.map((c) => c.text).join(" "),
    profile,
  );

  const blocked =
    hasBlockingIssue(trackIssues) ||
    out.some(
      (cue) =>
        hasBlockingIssue(cue.issues) ||
        cue.cueIssues.some((issue) => issue.severity === "error"),
    );

  return {
    locale,
    cues: out,
    trackIssues,
    blocked,
    systemPrompt,
    rawResponse: rawParts.join("\n"),
  };
}
