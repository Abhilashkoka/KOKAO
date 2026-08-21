/**
 * The brand voice as data.
 *
 * A brand voice does not translate — it transcreates. What survives the trip
 * into another language is not the sentences but a small set of invariants:
 * how formal you are, who you speak as, how you cut a line, what you never
 * say, and which words are never touched. Those invariants are this file. They
 * are fed verbatim into the transcreation prompt and checked by ./lint.ts.
 *
 * The defaults below are a starting point, not a description of any particular
 * brand. Edit `DEFAULT_VOICE_PROFILE` once and every language inherits it.
 */

/** Who the brand speaks as. Changes the whole grammar of a line in Indic languages. */
export type VoiceStance = "peer" | "guide" | "authority";

export interface BrandVoiceProfile {
  /**
   * The product name. Never translated and never transliterated: splitting a
   * name across three scripts fragments the brand and breaks store search.
   */
  brandName: string;
  /** Where the brand sits on formal ↔ casual, in one nameable phrase. */
  register: string;
  stance: VoiceStance;
  /** Sentence length, fragments, where lines break. */
  rhythm: string;
  /** Level and type of humour, or its deliberate absence. */
  humour: string;
  /** Things the brand never says. Travels across languages perfectly. */
  antiList: readonly string[];
  /**
   * Terms that must appear verbatim in Latin script in every language —
   * the product name, and anything else whose spelling is load-bearing.
   */
  keepLatin: readonly string[];
  /**
   * Labels the viewer has to find in the app.
   *
   * This is the rule most often broken and the one that costs installs. If the
   * app's button says "Continue", the Hindi voiceover says "Continue" — not
   * "जारी रखें" — or the viewer hunts for a control that does not exist. Set
   * `uiIsLocalized` and fill this with the *localized* strings instead once the
   * app itself ships in these languages.
   */
  uiStrings: readonly string[];
  /**
   * Whether the app's own interface is localized into the target languages.
   * When false, `uiStrings` are enforced as untranslatable Latin.
   */
  uiIsLocalized: boolean;
}

/**
 * Words real people say in English regardless of the language around them.
 * Translating these is the loudest possible signal that a translator, rather
 * than a writer, touched the copy.
 */
export const COMMON_ENGLISH_TERMS: readonly string[] = [
  "app",
  "download",
  "link",
  "share",
  "upload",
  "account",
  "screenshot",
  "notification",
  "OTP",
  "UPI",
  "login",
  "profile",
  "story",
  "reel",
  "post",
];

export const DEFAULT_VOICE_PROFILE: BrandVoiceProfile = {
  brandName: "kokao",
  register: "Casual-professional. Talks like a capable friend, not a company.",
  stance: "peer",
  rhythm: "Short sentences. Fragments are fine. One idea per line.",
  humour: "Light and dry. Never at the user's expense, never forced.",
  antiList: [
    "Corporate filler — 'seamless', 'leverage', 'solution', 'empower'",
    "Hype punctuation — exclamation marks, all-caps shouting",
    "Fake urgency — 'hurry', 'last chance', countdowns that do not exist",
    "Talking down — 'simply', 'just', 'it's easy'",
  ],
  keepLatin: ["kokao"],
  uiStrings: [],
  uiIsLocalized: false,
};

/**
 * Every term that must survive verbatim in Latin script for a given profile.
 * The UI strings only join the list while the app itself is English-only.
 */
export function untranslatableTerms(profile: BrandVoiceProfile): string[] {
  const terms = [...profile.keepLatin];
  if (!profile.uiIsLocalized) terms.push(...profile.uiStrings);
  return terms.filter((term) => term.trim().length > 0);
}

/**
 * Render the profile as the prose block handed to the model.
 *
 * Kept here rather than in the server so the web app can show the writer
 * exactly what the model was told, which is the difference between a
 * black box and something a copywriter can argue with.
 */
export function describeVoiceProfile(profile: BrandVoiceProfile): string {
  const parts = [
    `Brand: ${profile.brandName}`,
    `Register: ${profile.register}`,
    `Stance: speaks as a ${profile.stance}.`,
    `Rhythm: ${profile.rhythm}`,
    `Humour: ${profile.humour}`,
  ];

  if (profile.antiList.length > 0) {
    parts.push(`Never do any of these:\n${profile.antiList.map((x) => `- ${x}`).join("\n")}`);
  }

  const keep = untranslatableTerms(profile);
  if (keep.length > 0) {
    parts.push(
      `Leave these exactly as written, in Latin script, in every language: ${keep.join(", ")}.`,
    );
  }

  if (profile.uiStrings.length > 0 && !profile.uiIsLocalized) {
    parts.push(
      "Those interface labels appear on screen in English inside the app. The viewer has to " +
        "find them, so the narration must say them in English even mid-sentence.",
    );
  }

  parts.push(
    `Words people genuinely say in English, whatever language they are speaking — keep these ` +
      `in English (written in the target script): ${COMMON_ENGLISH_TERMS.join(", ")}.`,
  );

  return parts.join("\n\n");
}
