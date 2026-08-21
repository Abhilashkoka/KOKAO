/**
 * Target locales for video localization, and the per-locale editorial policy
 * that makes a dub sound native instead of translated.
 *
 * The policy fields are not decoration — they are read by the transcreation
 * prompt builder (api-server/src/lib/localization/transcreate.ts) and by the
 * lint pass (./lint.ts). Changing a value here changes what the model is told
 * and what the validator flags, in both the web app and the server, because
 * both import this package.
 */

/** Locales the localization pipeline can produce. */
export const TARGET_LOCALES = ["te", "ta", "hi"] as const;
export type TargetLocale = (typeof TARGET_LOCALES)[number];

/** The locale a source script is written in. Only English is supported today. */
export const SOURCE_LOCALES = ["en"] as const;
export type SourceLocale = (typeof SOURCE_LOCALES)[number];

export function isTargetLocale(value: string): value is TargetLocale {
  return (TARGET_LOCALES as readonly string[]).includes(value);
}

/** Unicode script a locale is written in. Drives font choice and the purity lint. */
export type IndicScript = "telugu" | "tamil" | "devanagari";

/**
 * How much English a locale tolerates, separately for speech and for writing.
 *
 * These differ per language and the difference is the single biggest quality
 * lever in Indian ad copy. Urban speech in all three is heavily code-mixed, so
 * `speech` is "high" everywhere. Written tolerance is not: Tamil has a live
 * purism culture and Latin-script English inside written Tamil reads worse
 * there than anywhere else, while Devanagari with transliterated loanwords is
 * the completely standard register for Hindi advertising.
 */
export type MixTolerance = "high" | "medium" | "low";

/** A word the target language *has* but that nobody actually says. */
export interface AvoidedTerm {
  /** The over-formal coinage to flag if the model emits it. */
  term: string;
  /** What a real speaker says instead. */
  prefer: string;
  /** Shown to the user next to the warning. */
  reason: string;
}

export interface LocalePolicy {
  locale: TargetLocale;
  /** English name, for UI. */
  label: string;
  /** Endonym, rendered in its own script. */
  endonym: string;
  script: IndicScript;
  /** BCP-47 tag, for SRT track labelling and `<track srclang>`. */
  bcp47: string;
  englishInSpeech: MixTolerance;
  englishInText: MixTolerance;
  /**
   * Script that English loanwords should be written in inside on-screen text
   * and subtitles. Every supported locale wants them in the target script —
   * Latin words dropped into an Indic-script line read as a rendering bug.
   */
  loanwordScript: "target";
  /**
   * Multiplier on the English syllable count, at an equal speaking pace.
   * Used to budget a line against a fixed cue duration. Starting values from
   * comparative reads; correct them against real narration if you measure it.
   */
  syllableRatio: number;
  /** Coinages that are technically correct and conversationally dead. */
  avoid: readonly AvoidedTerm[];
  /** Guidance handed to the model, verbatim, as part of the system prompt. */
  registerNote: string;
  /** Guidance for whoever books voice talent. Surfaced in the UI, not the prompt. */
  castingNote: string;
  /**
   * Font families to request when burning subtitles, most preferred first.
   * Resolved against the host's fontconfig at render time.
   */
  fontCandidates: readonly string[];
}

const TELUGU: LocalePolicy = {
  locale: "te",
  label: "Telugu",
  endonym: "తెలుగు",
  script: "telugu",
  bcp47: "te-IN",
  englishInSpeech: "high",
  englishInText: "medium",
  loanwordScript: "target",
  syllableRatio: 1.4,
  avoid: [
    {
      term: "అనువర్తనం",
      prefer: "యాప్",
      reason: "Textbook coinage for 'app'. Nobody says it in speech.",
    },
    {
      term: "దిగుమతి చేసుకోండి",
      prefer: "డౌన్‌లోడ్ చేసుకోండి",
      reason: "'Import' used for 'download'. Reads as a translated manual.",
    },
    {
      term: "వేదిక",
      prefer: "చోటు / యాప్",
      reason: "'Platform' in the corporate sense. Cold in consumer copy.",
    },
    {
      term: "సూచన",
      prefer: "నోటిఫికేషన్",
      reason: "Formal word for 'notification'. Everyone says the English one.",
    },
  ],
  registerNote:
    "Write urban Telugu as spoken in Hyderabad. Code-mixing with English is normal " +
    "speech here, not slang — 'try chey', 'download chesuko', 'app open chey' are all " +
    "correct register. Write English loanwords in Telugu script (డౌన్‌లోడ్, యాప్), never " +
    "in Latin letters. Avoid grānthika and textbook coinages entirely.",
  castingNote:
    "Neutral urban Hyderabad read. Coastal Andhra and Telangana accents are audibly " +
    "different; a strongly regional read narrows the audience.",
  fontCandidates: ["Anek Telugu", "Noto Sans Telugu", "Noto Serif Telugu", "Gautami"],
};

const TAMIL: LocalePolicy = {
  locale: "ta",
  label: "Tamil",
  endonym: "தமிழ்",
  script: "tamil",
  bcp47: "ta-IN",
  englishInSpeech: "high",
  englishInText: "low",
  loanwordScript: "target",
  syllableRatio: 1.45,
  avoid: [
    {
      term: "செய்யுங்கள்",
      prefer: "பண்ணுங்க",
      reason: "Literary Tamil in a voiceover reads as a government announcement.",
    },
    {
      term: "பயன்பாடு",
      prefer: "செயலி / ஆப்",
      reason: "Over-formal for 'app'. 'செயலி' is the living native word.",
    },
    {
      term: "தரவிறக்கம்",
      prefer: "டவுன்லோட்",
      reason: "Formal calque for 'download'. Rare in speech.",
    },
    {
      term: "தளம்",
      prefer: "இடம்",
      reason: "'Platform' in the corporate sense. Cold in consumer copy.",
    },
  ],
  registerNote:
    "Write spoken Tamil as heard in urban Chennai, not literary Tamil (செந்தமிழ்). " +
    "Tanglish is fine in the read — 'try pannunga', 'download pannunga'. But Tamil has " +
    "the strongest written-purism culture of the three languages: never leave English " +
    "in Latin letters inside Tamil text. Transliterate it into Tamil script, or use the " +
    "native word where a living one exists (செயலி for 'app' is real currency, unlike the " +
    "equivalent coinages in Telugu and Hindi).",
  castingNote:
    "Neutral Chennai urban read. Avoid Madurai or Kongu colouring unless deliberately targeted.",
  fontCandidates: ["Anek Tamil", "Noto Sans Tamil", "Noto Serif Tamil", "Latha"],
};

const HINDI: LocalePolicy = {
  locale: "hi",
  label: "Hindi",
  endonym: "हिन्दी",
  script: "devanagari",
  bcp47: "hi-IN",
  englishInSpeech: "high",
  englishInText: "medium",
  loanwordScript: "target",
  syllableRatio: 1.28,
  avoid: [
    {
      term: "अनुप्रयोग",
      prefer: "ऐप",
      reason: "Sanskritised coinage for 'app'. Reads as a government form.",
    },
    {
      term: "सूचना",
      prefer: "नोटिफिकेशन",
      reason: "Formal word for 'notification'. Everyone says the English one.",
    },
    {
      term: "संचिका",
      prefer: "फाइल",
      reason: "Sanskritised coinage for 'file'. Nobody says it.",
    },
    {
      term: "आवश्यकताएँ",
      prefer: "जो चाहिए",
      reason: "'Requirements'. Corporate register in consumer copy.",
    },
    {
      term: "मंच",
      prefer: "जगह",
      reason: "'Platform' in the corporate sense. Cold in consumer copy.",
    },
  ],
  registerNote:
    "Write Hinglish — it is the default register for Hindi advertising, not a concession. " +
    "Devanagari with transliterated English loanwords (डाउनलोड, ऐप, नोटिफिकेशन) is standard " +
    "and correct; never leave English in Latin letters. Prefer everyday Hindustani vocabulary " +
    "(वक़्त, शुक्रिया) over Sanskritised Hindi — the first reads warm, the second reads official.",
  castingNote:
    "Neutral Delhi / Mumbai urban read. Avoid strong Bhojpuri or Punjabi colouring unless it is a deliberate character.",
  fontCandidates: ["Anek Devanagari", "Noto Sans Devanagari", "Noto Serif Devanagari", "Mangal"],
};

export const LOCALE_POLICIES: Readonly<Record<TargetLocale, LocalePolicy>> = {
  te: TELUGU,
  ta: TAMIL,
  hi: HINDI,
};

export function localePolicy(locale: TargetLocale): LocalePolicy {
  return LOCALE_POLICIES[locale];
}

/** Unicode ranges per script, used by the syllable counter and the purity lint. */
export const SCRIPT_RANGES: Readonly<Record<IndicScript, { start: number; end: number }>> = {
  devanagari: { start: 0x0900, end: 0x097f },
  telugu: { start: 0x0c00, end: 0x0c7f },
  tamil: { start: 0x0b80, end: 0x0bff },
};
