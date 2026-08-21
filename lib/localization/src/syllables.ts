/**
 * Syllable estimation for English and for the three Indic scripts.
 *
 * Why syllables and not words or characters: when a video's cut is locked, the
 * constraint on a translated line is *duration*, and duration tracks syllable
 * count far more closely than it tracks words (Telugu words are long) or
 * characters (Indic scripts pack a whole syllable into one or two code points).
 * A budget expressed in syllables is the only one a writer can actually hit.
 *
 * These are estimates, deliberately. They exist to catch a line that is 60%
 * too long before anyone books a studio, not to predict a read to the frame.
 * Measure a real narration track if you need exactness.
 */

import { SCRIPT_RANGES, localePolicy, type IndicScript, type TargetLocale } from "./locales";

/* ------------------------------------------------------------------ *
 * Indic character classes
 * ------------------------------------------------------------------ */

interface ScriptClasses {
  /** Independent vowel letters — each is a syllable on its own. */
  independentVowels: ReadonlyArray<[number, number]>;
  /** Consonant letters — each carries an inherent vowel unless silenced. */
  consonants: ReadonlyArray<[number, number]>;
  /** Virama / halant / pulli — kills the inherent vowel and joins clusters. */
  virama: number;
  /** Dependent vowel signs (matras) — replace the inherent vowel, add no syllable. */
  matras: ReadonlyArray<[number, number]>;
  /**
   * True when the script deletes word-internal and word-final inherent vowels
   * in pronunciation. Devanagari does (Hindi schwa deletion); Telugu and Tamil
   * pronounce every akshara.
   */
  deletesSchwa: boolean;
}

const CLASSES: Readonly<Record<IndicScript, ScriptClasses>> = {
  devanagari: {
    independentVowels: [
      [0x0904, 0x0914],
      [0x0960, 0x0961],
      [0x0972, 0x0977],
    ],
    consonants: [
      [0x0915, 0x0939],
      [0x0958, 0x095f],
      [0x0978, 0x097f],
    ],
    virama: 0x094d,
    matras: [
      [0x093a, 0x093b],
      [0x093e, 0x094c],
      [0x094e, 0x094f],
      [0x0955, 0x0957],
      [0x0962, 0x0963],
    ],
    deletesSchwa: true,
  },
  telugu: {
    independentVowels: [
      [0x0c05, 0x0c14],
      [0x0c60, 0x0c61],
    ],
    consonants: [
      [0x0c15, 0x0c39],
      [0x0c58, 0x0c5a],
      [0x0c5d, 0x0c5d],
    ],
    virama: 0x0c4d,
    matras: [
      [0x0c3e, 0x0c4c],
      [0x0c55, 0x0c56],
      [0x0c62, 0x0c63],
    ],
    deletesSchwa: false,
  },
  tamil: {
    independentVowels: [[0x0b85, 0x0b94]],
    consonants: [[0x0b95, 0x0bb9]],
    virama: 0x0bcd,
    matras: [
      [0x0bbe, 0x0bcc],
      [0x0bd7, 0x0bd7],
    ],
    deletesSchwa: false,
  },
};

function inRanges(code: number, ranges: ReadonlyArray<[number, number]>): boolean {
  for (const [start, end] of ranges) {
    if (code >= start && code <= end) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Akshara parsing
 * ------------------------------------------------------------------ */

interface Unit {
  /** True when this unit carries a pronounced vowel (independent, matra, or inherent). */
  bearing: boolean;
  /** True when the unit's vowel is inherent (a schwa that deletion may silence). */
  inherent: boolean;
}

/**
 * Split one whitespace-delimited token into orthographic syllables (aksharas).
 *
 * A unit is either an independent vowel, or a consonant cluster (consonants
 * joined by viramas) plus at most one dependent vowel sign. A cluster whose
 * final consonant carries a virama with nothing after it is a dead consonant —
 * a coda, not a syllable — so it is not vowel-bearing.
 */
function parseUnits(token: string, cls: ScriptClasses): Unit[] {
  const units: Unit[] = [];
  const chars = Array.from(token);
  let i = 0;

  while (i < chars.length) {
    const code = chars[i]!.codePointAt(0)!;

    if (inRanges(code, cls.independentVowels)) {
      units.push({ bearing: true, inherent: false });
      i += 1;
      continue;
    }

    if (inRanges(code, cls.consonants)) {
      i += 1;
      let endedOnVirama = false;

      // Absorb the rest of the cluster: (virama consonant)*
      for (;;) {
        const next = i < chars.length ? chars[i]!.codePointAt(0)! : -1;
        if (next !== cls.virama) break;
        i += 1;
        endedOnVirama = true;
        const after = i < chars.length ? chars[i]!.codePointAt(0)! : -1;
        if (after >= 0 && inRanges(after, cls.consonants)) {
          i += 1;
          endedOnVirama = false;
        } else {
          break;
        }
      }

      if (endedOnVirama) {
        // Dead consonant: a coda attached to the previous syllable.
        units.push({ bearing: false, inherent: false });
        continue;
      }

      // At most one dependent vowel sign closes the unit.
      const sign = i < chars.length ? chars[i]!.codePointAt(0)! : -1;
      if (sign >= 0 && inRanges(sign, cls.matras)) {
        i += 1;
        units.push({ bearing: true, inherent: false });
      } else {
        units.push({ bearing: true, inherent: true });
      }
      continue;
    }

    // Anusvara, visarga, nukta, avagraha, punctuation, digits, spaces: no syllable.
    i += 1;
  }

  return units;
}

/**
 * Apply Hindi schwa deletion to a parsed token, right to left.
 *
 * Two rules cover almost all real copy:
 *   1. A word-final inherent vowel is deleted — सब is "sab", not "sa-ba".
 *   2. A medial inherent vowel is deleted when it sits between two syllables
 *      that are still pronounced — करना is "kar-naa", not "ka-ra-naa".
 *
 * Right-to-left order matters: rule 1 can silence the neighbour that rule 2
 * looks at, which is exactly why जगह stays "ja-gah" instead of collapsing.
 */
function applySchwaDeletion(units: Unit[]): void {
  if (units.length === 0) return;

  const last = units[units.length - 1]!;
  if (last.inherent) {
    last.bearing = false;
    last.inherent = false;
  }

  for (let i = units.length - 2; i >= 1; i -= 1) {
    const unit = units[i]!;
    if (!unit.inherent) continue;
    const before = units[i - 1]!;
    const after = units[i + 1]!;
    if (before.bearing && after.bearing) {
      unit.bearing = false;
      unit.inherent = false;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

const ENGLISH_WORD_RE = /[a-z]+(?:'[a-z]+)?/g;

/**
 * Estimate syllables in English text with the standard vowel-group heuristic:
 * count runs of vowels, drop a silent final "e", never return less than one
 * syllable for a word that has letters in it.
 */
export function estimateEnglishSyllables(text: string): number {
  const words = text.toLowerCase().match(ENGLISH_WORD_RE);
  if (!words) return 0;

  let total = 0;
  for (const word of words) {
    const groups = word.match(/[aeiouy]+/g);
    let count = groups ? groups.length : 0;

    // Silent terminal "e" — but "-le" after a consonant is its own syllable
    // ("table", "little"), so only drop the ending when it is not that shape.
    if (word.length > 2 && word.endsWith("e") && !/[^aeiou]le$/.test(word)) {
      count -= 1;
    }
    total += Math.max(1, count);
  }
  return total;
}

/** Estimate syllables in text written in one of the supported Indic scripts. */
export function estimateIndicSyllables(text: string, script: IndicScript): number {
  const cls = CLASSES[script];
  const range = SCRIPT_RANGES[script];
  let total = 0;

  for (const token of text.split(/\s+/)) {
    if (!token) continue;

    // A token may be pure Latin (a brand name left untranslated). Fall back to
    // the English heuristic so mixed lines are still budgeted sensibly.
    const hasScript = Array.from(token).some((ch) => {
      const code = ch.codePointAt(0)!;
      return code >= range.start && code <= range.end;
    });
    if (!hasScript) {
      total += estimateEnglishSyllables(token);
      continue;
    }

    const units = parseUnits(token, cls);
    if (cls.deletesSchwa) applySchwaDeletion(units);
    total += units.reduce((sum, unit) => sum + (unit.bearing ? 1 : 0), 0);
  }

  return total;
}

/** Estimate syllables for a target locale, dispatching on its script. */
export function estimateSyllables(text: string, locale: TargetLocale): number {
  return estimateIndicSyllables(text, localePolicy(locale).script);
}

/**
 * The syllable ceiling for a translated line, given the English it replaces.
 *
 * Rounded up, because a line one syllable over is not worth flagging and a
 * false positive on every cue trains people to ignore the warnings.
 */
export function syllableBudget(englishSyllables: number, locale: TargetLocale): number {
  return Math.ceil(englishSyllables * localePolicy(locale).syllableRatio);
}

/**
 * Syllables per second in the source read. Useful for reporting how hard a
 * cue is before translation: a cue already at 6 syl/sec in English has no
 * headroom in any of the three target languages.
 */
export function syllablesPerSecond(syllables: number, durationMs: number): number {
  if (durationMs <= 0) return 0;
  return (syllables * 1000) / durationMs;
}
