/**
 * Portable creative intent carried by a curated video template.
 *
 * This contract deliberately contains no open-ended metadata or asset
 * references. It describes how to tell and present a tenant's story, never
 * what the story is or which tenant-owned thing should appear in it.
 */

export const CREATIVE_DIRECTION_LIMITS = {
  proseChars: 800,
  shortProseChars: 240,
  vocabularyItems: 24,
  vocabularyItemChars: 64,
  beats: 12,
  evidenceRules: 8,
  paletteItems: 9,
  negativeTerms: 16,
  scenes: 31,
} as const;

export type CreativeHookStyle =
  | "direct_claim"
  | "question"
  | "problem_first"
  | "demonstration"
  | "myth_bust"
  | "story";
export type CreativeTone =
  | "authoritative"
  | "conversational"
  | "warm"
  | "playful"
  | "urgent"
  | "inspirational"
  | "skeptical";
export type CreativePacing = "slow" | "measured" | "brisk" | "rapid";
export type CreativeCtaStyle = "none" | "soft" | "direct";
export type CreativeBeatPurpose =
  | "hook"
  | "context"
  | "problem"
  | "demonstration"
  | "evidence"
  | "solution"
  | "payoff"
  | "cta";
export type CreativeEvidenceKind =
  | "demonstration"
  | "example"
  | "source"
  | "data"
  | "qualification";
export type CreativeVisualStyle =
  | "documentary"
  | "editorial"
  | "cinematic"
  | "commercial"
  | "graphic"
  | "natural";
export type CreativeLighting = "natural" | "soft" | "high_key" | "low_key" | "dramatic";
export type CreativeColorGrade =
  | "natural"
  | "warm"
  | "cool"
  | "vibrant"
  | "muted"
  | "high_contrast";
export type CreativeComposition =
  | "centered"
  | "left_aligned"
  | "rule_of_thirds"
  | "close_detail"
  | "wide_context"
  | "presenter_overlay";
export type CreativeMotion = "locked" | "subtle" | "handheld" | "dynamic";
export type CreativeSonicMood =
  | "none"
  | "calm"
  | "optimistic"
  | "playful"
  | "dramatic"
  | "tense";
export type CreativeRhythm = "minimal" | "sparse" | "steady" | "driving";
export type CreativeCaptionRhythm = "sentence" | "phrase" | "word_group";
export type CreativeCaptionEmphasis = "none" | "keywords" | "numbers";

export interface CreativeDirectionV1 {
  version: 1;
  narrative?: {
    hookStyle?: CreativeHookStyle;
    tone?: CreativeTone;
    pacing?: CreativePacing;
    ctaStyle?: CreativeCtaStyle;
    /** Reusable writing direction; it must not name the subject of a scene. */
    guidance?: string;
    requiredVocabulary?: string[];
    forbiddenVocabulary?: string[];
    evidenceRules?: Array<{
      kind: CreativeEvidenceKind;
      instruction: string;
    }>;
  };
  structure?: {
    sceneCount?: { min: number; max: number };
    beats?: Array<{
      purpose: CreativeBeatPurpose;
      instruction: string;
      /** Relative share of the runtime. All weights are advisory. */
      weight?: number;
    }>;
  };
  visual?: {
    style?: CreativeVisualStyle;
    lighting?: CreativeLighting;
    colorGrade?: CreativeColorGrade;
    composition?: CreativeComposition;
    motion?: CreativeMotion;
    palette?: string[];
    negativeTerms?: string[];
    /** Rules about treatment/framing only, never the scene's subject. */
    subjectRule?: string;
    stockQueryGuidance?: string;
  };
  sonic?: {
    mood?: CreativeSonicMood;
    energy?: 1 | 2 | 3 | 4 | 5;
    rhythm?: CreativeRhythm;
    guidance?: string;
  };
  captions?: {
    rhythm?: CreativeCaptionRhythm;
    emphasis?: CreativeCaptionEmphasis;
  };
}

export type CreativeDirection = CreativeDirectionV1;

export type CreativeDirectionSourceKind =
  | "format"
  | "template"
  | "vertical"
  | "brand"
  | "user";

export interface CreativeDirectionProvenanceEntry {
  source: CreativeDirectionSourceKind;
  /** Stable database/version reference when one exists; never an object path. */
  reference?: string;
  fields: string[];
}

/**
 * Immutable render-time result. Jobs persist this value so editing a template
 * cannot change retries or a storyboard resumed later.
 */
export interface ResolvedCreativeBrief {
  version: 1;
  direction: CreativeDirection;
  /** The user's subject is recorded separately and is never merged as style. */
  topic?: string;
  /**
   * Legacy reference-analysis guidance, captured at enqueue for old profiles
   * that predate portable creativeDirection. Never resolve this again on a
   * retry: the profile may have changed or been deleted.
   */
  legacyReferenceStyleGuidance?: string;
  provenance: CreativeDirectionProvenanceEntry[];
  clamps: Array<{
    field: string;
    reason: string;
    source: CreativeDirectionSourceKind;
  }>;
}