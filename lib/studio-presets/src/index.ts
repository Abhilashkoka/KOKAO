/**
 * Studio tweak chips shared by the web and mobile Studio screens. Keeping the
 * labels and AI instructions in one place guarantees both platforms show the
 * same chips and send the AI the exact same instruction text.
 */
export const CAPTION_TWEAKS = [
  { label: "Shorter", instruction: "Make the caption shorter and more concise." },
  { label: "Punchier", instruction: "Make the caption punchier and more attention-grabbing." },
  { label: "More formal", instruction: "Make the caption more formal and professional." },
] as const;

export type CaptionTweak = (typeof CAPTION_TWEAKS)[number];

export const IMAGE_TWEAKS = [
  { label: "Brighter", instruction: "Make the image brighter with more light and airy tones." },
  { label: "Minimal", instruction: "Make the image more minimal, clean, and uncluttered." },
  { label: "More vibrant", instruction: "Make the image more vibrant with bold, saturated colors." },
] as const;

export type ImageTweak = (typeof IMAGE_TWEAKS)[number];

/**
 * Portable starting points for curated video templates. These values describe
 * treatment only: they intentionally contain no tenant IDs, object paths,
 * subjects, claims, or other workspace-owned content.
 */
export interface CreativeDirectionPresetValue {
  version: 1;
  narrative?: {
    hookStyle?: "direct_claim" | "question" | "problem_first" | "demonstration" | "myth_bust" | "story";
    tone?: "authoritative" | "conversational" | "warm" | "playful" | "urgent" | "inspirational" | "skeptical";
    pacing?: "slow" | "measured" | "brisk" | "rapid";
    ctaStyle?: "none" | "soft" | "direct";
    guidance?: string;
    requiredVocabulary?: string[];
    forbiddenVocabulary?: string[];
  };
  structure?: {
    sceneCount?: { min: number; max: number };
    beats?: Array<{
      purpose: "hook" | "context" | "problem" | "demonstration" | "evidence" | "solution" | "payoff" | "cta";
      instruction: string;
      weight?: number;
    }>;
  };
  visual?: {
    style?: "documentary" | "editorial" | "cinematic" | "commercial" | "graphic" | "natural";
    lighting?: "natural" | "soft" | "high_key" | "low_key" | "dramatic";
    colorGrade?: "natural" | "warm" | "cool" | "vibrant" | "muted" | "high_contrast";
    composition?: "centered" | "rule_of_thirds" | "close_detail" | "wide_context" | "presenter_overlay";
    motion?: "locked" | "subtle" | "handheld" | "dynamic";
    palette?: string[];
    negativeTerms?: string[];
    subjectRule?: string;
    stockQueryGuidance?: string;
  };
  sonic?: {
    mood?: "none" | "calm" | "optimistic" | "playful" | "dramatic" | "tense";
    energy?: 1 | 2 | 3 | 4 | 5;
    rhythm?: "sparse" | "steady" | "driving";
    guidance?: string;
  };
  captions?: {
    rhythm?: "sentence" | "phrase" | "word_group";
    emphasis?: "none" | "keywords" | "numbers";
  };
}

export const CREATIVE_DIRECTION_PRESETS: ReadonlyArray<{
  id: string;
  name: string;
  description: string;
  value: CreativeDirectionPresetValue;
}> = [
  {
    id: "clear-explainer",
    name: "Clear explainer",
    description: "Measured, credible teaching with practical evidence.",
    value: {
      version: 1,
      narrative: { hookStyle: "problem_first", tone: "authoritative", pacing: "measured", ctaStyle: "soft" },
      structure: { sceneCount: { min: 5, max: 8 }, beats: [
        { purpose: "hook", instruction: "Open on the viewer's problem.", weight: 1 },
        { purpose: "solution", instruction: "Teach one useful method in clear steps.", weight: 4 },
        { purpose: "payoff", instruction: "Show the practical result.", weight: 1 },
      ] },
      visual: { style: "documentary", lighting: "natural", colorGrade: "natural", composition: "rule_of_thirds", motion: "subtle" },
      sonic: { mood: "calm", energy: 2, rhythm: "steady" },
      captions: { rhythm: "sentence", emphasis: "keywords" },
    },
  },
  {
    id: "fast-social-tip",
    name: "Fast social tip",
    description: "A direct, energetic idea designed for short-form feeds.",
    value: {
      version: 1,
      narrative: { hookStyle: "direct_claim", tone: "conversational", pacing: "rapid", ctaStyle: "none", forbiddenVocabulary: ["follow for more"] },
      structure: { sceneCount: { min: 3, max: 5 }, beats: [
        { purpose: "hook", instruction: "State the useful idea without preamble.", weight: 1 },
        { purpose: "demonstration", instruction: "Show the idea working.", weight: 2 },
        { purpose: "payoff", instruction: "Land the result and stop.", weight: 1 },
      ] },
      visual: { style: "natural", lighting: "natural", colorGrade: "vibrant", composition: "close_detail", motion: "dynamic" },
      sonic: { mood: "optimistic", energy: 4, rhythm: "driving" },
      captions: { rhythm: "word_group", emphasis: "keywords" },
    },
  },
  {
    id: "premium-product",
    name: "Premium product",
    description: "Polished demonstration with restrained motion and detail.",
    value: {
      version: 1,
      narrative: { hookStyle: "demonstration", tone: "warm", pacing: "measured", ctaStyle: "direct" },
      structure: { sceneCount: { min: 4, max: 7 }, beats: [
        { purpose: "hook", instruction: "Show the result before explaining it.", weight: 1 },
        { purpose: "demonstration", instruction: "Demonstrate a small number of repeatable steps.", weight: 4 },
        { purpose: "cta", instruction: "Close with one concrete next step.", weight: 1 },
      ] },
      visual: { style: "commercial", lighting: "soft", colorGrade: "warm", composition: "close_detail", motion: "subtle", negativeTerms: ["clutter", "logo wall"] },
      sonic: { mood: "optimistic", energy: 3, rhythm: "steady" },
      captions: { rhythm: "phrase", emphasis: "numbers" },
    },
  },
] as const;
