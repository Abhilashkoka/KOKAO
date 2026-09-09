import type { GuidedStoryLocale, GuidedStoryScript } from "@workspace/db";
import { transliterate } from "transliteration";

export type NativeAudioAssessment =
  | { outcome: "pass"; detectedLocale: GuidedStoryLocale | null }
  | { outcome: "no_speech"; detectedLocale: null }
  | { outcome: "wrong_language"; detectedLocale: string }
  | { outcome: "dialogue_drift"; detectedLocale: GuidedStoryLocale | null };

export type NativeAudioQualityCode =
  | "native_audio_unverified"
  | "native_audio_missing_speech"
  | "native_audio_wrong_language"
  | "native_audio_dialogue_drift";

export class NativeAudioQualityError extends Error {
  constructor(
    public readonly code: NativeAudioQualityCode,
    message: string,
  ) {
    super(message);
    this.name = "NativeAudioQualityError";
  }
}

const SCRIPT_PATTERNS: Array<[GuidedStoryLocale, RegExp]> = [
  ["te", /\p{Script=Telugu}/gu],
  ["ta", /\p{Script=Tamil}/gu],
  ["hi", /\p{Script=Devanagari}/gu],
  ["en", /\p{Script=Latin}/gu],
];

function normalizedWords(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase()
    .match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
}

export function guidedSpokenText(script: GuidedStoryScript): string {
  return script.scenes
    .flatMap((scene) => [...scene.lines].sort((a, b) => a.startMs - b.startMs))
    .map((line) => line.text.trim())
    .filter(Boolean)
    .join(" ");
}

export function guidedSpokenPhoneticText(script: GuidedStoryScript): string {
  return script.scenes
    .flatMap((scene) => [...scene.lines].sort((a, b) => a.startMs - b.startMs))
    .map((line) =>
      line.romanizedPronunciation?.trim() || line.text.trim()
    )
    .filter(Boolean)
    .join(" ");
}

export function detectTranscriptLocale(text: string): GuidedStoryLocale | null {
  const counts = SCRIPT_PATTERNS.map(([locale, pattern]) => [
    locale,
    text.match(pattern)?.length ?? 0,
  ] as const).sort((left, right) => right[1] - left[1]);
  const [winner, count] = counts[0]!;
  const recognized = counts.reduce((sum, entry) => sum + entry[1], 0);
  if (count < 4 || recognized === 0 || count / recognized < 0.7) return null;
  return winner;
}

function normalizeProviderLanguage(value: string | null | undefined): string | null {
  const base = value?.trim().toLowerCase().replaceAll("_", "-").split("-")[0] ?? "";
  const aliases: Record<string, string> = {
    english: "en",
    eng: "en",
    hindi: "hi",
    hin: "hi",
    telugu: "te",
    tel: "te",
    tamil: "ta",
    tam: "ta",
    spanish: "es",
    spa: "es",
    french: "fr",
    fra: "fr",
    fre: "fr",
    german: "de",
    deu: "de",
    ger: "de",
    portuguese: "pt",
    por: "pt",
    italian: "it",
    ita: "it",
    dutch: "nl",
    nld: "nl",
    chinese: "zh",
    zho: "zh",
    mandarin: "zh",
    japanese: "ja",
    jpn: "ja",
    korean: "ko",
    kor: "ko",
    arabic: "ar",
    ara: "ar",
  };
  const normalized = aliases[base] ?? base;
  return /^[a-z]{2,3}$/.test(normalized) ? normalized : null;
}

function orderedSimilarity<T>(expected: T[], actual: T[]): number {
  if (expected.length === 0) return 1;
  const prior = new Array<number>(actual.length + 1).fill(0);
  for (const expectedItem of expected) {
    let diagonal = 0;
    for (let index = 1; index <= actual.length; index++) {
      const above = prior[index]!;
      prior[index] = expectedItem === actual[index - 1]
        ? diagonal + 1
        : Math.max(prior[index]!, prior[index - 1]!);
      diagonal = above;
    }
  }
  const orderedMatches = prior[actual.length]!;
  return (2 * orderedMatches) / (expected.length + actual.length);
}

function phoneticCharacters(text: string): string[] {
  const normalized = transliterate(text)
    .normalize("NFKD")
    .toLocaleLowerCase()
    // Collapse common romanization choices before removing vowels. This is
    // deliberately lossy: the sequence comparison below remains strict enough
    // to reject reordered or unrelated speech while tolerating ASR spelling,
    // word-boundary, and cross-Indic-script variation.
    .replaceAll("ph", "f")
    .replaceAll("bh", "b")
    .replaceAll("dh", "d")
    .replaceAll("th", "t")
    .replaceAll("kh", "k")
    .replaceAll("gh", "g")
    .replaceAll("ch", "c")
    .replaceAll("sh", "s")
    .replaceAll("zh", "l")
    .replaceAll("c", "k")
    .replaceAll("q", "k")
    .replaceAll("w", "v")
    .replaceAll("x", "ks")
    .replace(/[^a-z0-9]/g, "")
    .replace(/[aeiouy]/g, "")
    .replace(/(.)\1+/g, "$1");
  return [...normalized];
}

function dialogueSimilarity(
  expected: string,
  actual: string,
  expectedPhoneticDialogue?: string,
): number {
  const exactWordScore = orderedSimilarity(
    normalizedWords(expected),
    normalizedWords(actual),
  );
  if (!expectedPhoneticDialogue?.trim()) return exactWordScore;
  const phoneticScore = orderedSimilarity(
    phoneticCharacters(expectedPhoneticDialogue),
    phoneticCharacters(actual),
  );
  return Math.max(exactWordScore, phoneticScore);
}

function transcriptAnalysis(args: {
  expectedDialogue: string;
  expectedPhoneticDialogue?: string;
  transcript: string;
  providerDetectedLanguage?: string | null;
}) {
  return {
    providerDetectedLocale: normalizeProviderLanguage(args.providerDetectedLanguage),
    transcriptDetectedLocale: detectTranscriptLocale(args.transcript),
    transcriptWordCount: normalizedWords(args.transcript).length,
    dialogueSimilarity: dialogueSimilarity(
      args.expectedDialogue,
      args.transcript,
      args.expectedPhoneticDialogue,
    ),
  };
}

/** Bounded diagnostics only: no transcript text or arbitrary provider payload. */
export function nativeAudioTranscriptDiagnostics(args: {
  expectedDialogue: string;
  expectedPhoneticDialogue?: string;
  transcript: string;
  providerDetectedLanguage?: string | null;
}) {
  const analysis = transcriptAnalysis(args);
  return {
    ...analysis,
    dialogueSimilarity: Math.round(analysis.dialogueSimilarity * 1_000) / 1_000,
  };
}

export function assessNativeAudioTranscript(args: {
  expectedLocale: GuidedStoryLocale;
  expectedDialogue: string;
  expectedPhoneticDialogue?: string;
  transcript: string;
  providerDetectedLanguage?: string | null;
}): NativeAudioAssessment {
  const transcript = args.transcript.trim();
  const analysis = transcriptAnalysis({ ...args, transcript });
  if (analysis.transcriptWordCount === 0) {
    return { outcome: "no_speech", detectedLocale: null };
  }
  const providerLocale = analysis.providerDetectedLocale;
  const strongExpectedScript =
    analysis.transcriptDetectedLocale === args.expectedLocale &&
    ["te", "ta", "hi"].includes(args.expectedLocale);
  const strongExpectedPhonetics =
    Boolean(args.expectedPhoneticDialogue?.trim()) &&
    ["te", "ta", "hi"].includes(args.expectedLocale) &&
    analysis.dialogueSimilarity >= 0.75;
  // One- or two-word clips are too ambiguous for a provider language label to
  // justify a terminal wrong-language verdict ("no", names, and numbers often
  // straddle languages). A strong Telugu/Tamil/Devanagari transcript is also
  // better evidence than a conflicting provider label. A strong ordered
  // phonetic match against the frozen pronunciation is also independent
  // evidence that the spoken content is correct when ASR labels a phonetically
  // written cross-script transcript as another Indic language.
  if (
    providerLocale &&
    providerLocale !== args.expectedLocale &&
    analysis.transcriptWordCount >= 4 &&
    !strongExpectedScript &&
    !strongExpectedPhonetics
  ) {
    return { outcome: "wrong_language", detectedLocale: providerLocale };
  }
  const detectedLocale =
    providerLocale === args.expectedLocale || strongExpectedPhonetics
      ? args.expectedLocale
      : analysis.transcriptDetectedLocale;
  if (
    detectedLocale &&
    detectedLocale !== args.expectedLocale &&
    !strongExpectedPhonetics
  ) {
    return { outcome: "wrong_language", detectedLocale };
  }
  // Script detection can be uncertain for names, numbers, and very short lines.
  // In that case exact-dialogue similarity remains the safer independent signal.
  if (analysis.dialogueSimilarity < 0.75) {
    return { outcome: "dialogue_drift", detectedLocale };
  }
  return { outcome: "pass", detectedLocale };
}