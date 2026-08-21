/**
 * Mechanical checks on transcreated text.
 *
 * These catch, in milliseconds and for free, the three things a native
 * reviewer would otherwise catch three days later: English left in Latin
 * letters inside an Indic line, textbook coinages nobody says, and a brand or
 * interface term that got translated when it had to stay put.
 *
 * What they deliberately do not check is whether the line is any good. That is
 * what the blind back-translation is for.
 */

import { SCRIPT_RANGES, localePolicy, type TargetLocale } from "./locales";
import { untranslatableTerms, type BrandVoiceProfile } from "./voiceProfile";

export type LocalizationIssueCode =
  | "latin_in_indic"
  | "avoided_term"
  | "missing_untranslatable"
  | "wrong_script"
  | "over_budget";

export interface LocalizationIssue {
  code: LocalizationIssueCode;
  severity: "error" | "warning";
  message: string;
  /** The offending or expected fragment, when there is one to point at. */
  fragment?: string;
  /** What to write instead, when the rule knows. */
  suggestion?: string;
}

/** Runs of two or more Latin letters — single letters are usually noise. */
const LATIN_RUN_RE = /[A-Za-z][A-Za-z''-]*[A-Za-z]|[A-Za-z]/g;

function scriptCharCount(text: string, locale: TargetLocale): number {
  const { start, end } = SCRIPT_RANGES[localePolicy(locale).script];
  let count = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code >= start && code <= end) count += 1;
  }
  return count;
}

/**
 * Latin fragments that are allowed to sit inside an Indic line: the brand
 * name, anything on the profile's keep-list, and the interface labels the
 * viewer has to be able to find.
 */
function allowedLatin(profile: BrandVoiceProfile): Set<string> {
  const allowed = new Set<string>();
  for (const term of untranslatableTerms(profile)) {
    for (const word of term.split(/\s+/)) {
      const cleaned = word.replace(/[^A-Za-z]/g, "").toLowerCase();
      if (cleaned.length > 0) allowed.add(cleaned);
    }
  }
  return allowed;
}

export interface LintOptions {
  locale: TargetLocale;
  profile: BrandVoiceProfile;
  /** Syllable ceiling for this line, when it is being fitted to a cue. */
  syllableBudget?: number;
  /** Measured syllables of the line, paired with `syllableBudget`. */
  syllables?: number;
}

/**
 * Lint one transcreated line. Returns every issue found; an empty array means
 * the line is mechanically clean, not that it is well written.
 */
export function lintLocalizedText(text: string, options: LintOptions): LocalizationIssue[] {
  const { locale, profile } = options;
  const policy = localePolicy(locale);
  const issues: LocalizationIssue[] = [];
  const trimmed = text.trim();

  if (trimmed.length === 0) return issues;

  // 1. Did we get the target script at all?
  const scriptChars = scriptCharCount(trimmed, locale);
  if (scriptChars === 0) {
    issues.push({
      code: "wrong_script",
      severity: "error",
      message: `No ${policy.label} characters in this line. The model may have answered in English.`,
    });
    return issues;
  }

  // 2. Latin left inside an Indic line.
  const allowed = allowedLatin(profile);
  const seen = new Set<string>();
  for (const match of trimmed.matchAll(LATIN_RUN_RE)) {
    const fragment = match[0];
    const key = fragment.replace(/[^A-Za-z]/g, "").toLowerCase();
    if (key.length === 0 || allowed.has(key) || seen.has(key)) continue;
    seen.add(key);
    issues.push({
      code: "latin_in_indic",
      severity: policy.englishInText === "low" ? "error" : "warning",
      message:
        `"${fragment}" is in Latin letters inside ${policy.label} text. ` +
        `Write English loanwords in ${policy.label} script instead.`,
      fragment,
    });
  }

  // 3. Coinages that are correct and conversationally dead.
  for (const avoided of policy.avoid) {
    if (trimmed.includes(avoided.term)) {
      issues.push({
        code: "avoided_term",
        severity: "warning",
        message: `${avoided.reason} Prefer "${avoided.prefer}".`,
        fragment: avoided.term,
        suggestion: avoided.prefer,
      });
    }
  }

  // 4. Syllable budget, when the line is fitted to a cue.
  if (options.syllableBudget !== undefined && options.syllables !== undefined) {
    if (options.syllables > options.syllableBudget) {
      const over = options.syllables - options.syllableBudget;
      issues.push({
        code: "over_budget",
        severity: "error",
        message:
          `${options.syllables} syllables against a budget of ${options.syllableBudget} ` +
          `(${over} over). Cut a word — do not speed up the read.`,
      });
    }
  }

  return issues;
}

/**
 * Check that terms which must survive verbatim actually did.
 *
 * Run this over the whole track rather than per cue: a brand name legitimately
 * appears once in a thirty-cue script, and flagging its absence on the other
 * twenty-nine would be noise.
 */
export function lintUntranslatables(
  sourceText: string,
  targetText: string,
  profile: BrandVoiceProfile,
): LocalizationIssue[] {
  const issues: LocalizationIssue[] = [];
  const target = targetText.toLowerCase();
  const source = sourceText.toLowerCase();

  for (const term of untranslatableTerms(profile)) {
    const needle = term.toLowerCase();
    if (!source.includes(needle)) continue;
    if (target.includes(needle)) continue;
    issues.push({
      code: "missing_untranslatable",
      severity: "error",
      message:
        `"${term}" is in the English script but not in the translation. ` +
        `It must appear exactly as written — the viewer has to recognise it.`,
      fragment: term,
    });
  }

  return issues;
}

/** True when any issue in the list blocks delivery. */
export function hasBlockingIssue(issues: readonly LocalizationIssue[]): boolean {
  return issues.some((issue) => issue.severity === "error");
}
