import type {
  ResolvedCreativeBrief,
  VideoStoryboard,
} from "@workspace/db";

export interface CreativeBriefFragments {
  script: string | null;
  storyboard: string | null;
  visual: string | null;
  stock: string | null;
  captionStyle: "classic" | "dynamic" | null;
  music: string | null;
}

function sentence(label: string, value: unknown): string | null {
  return typeof value === "string" && value.trim() ? `${label}: ${value.trim()}.` : null;
}

/**
 * Compile only bounded, treatment-level fragments. The subject guard is
 * repeated in visual/stock fragments because those strings may be handed to
 * different providers independently.
 */
export function compileCreativeBrief(
  brief: ResolvedCreativeBrief | null | undefined,
): CreativeBriefFragments {
  const direction = brief?.direction;
  if (!direction) {
    return {
      script: null,
      storyboard: null,
      visual: null,
      stock: null,
      captionStyle: null,
      music: null,
    };
  }
  const narrative = direction.narrative;
  const structure = direction.structure;
  const visual = direction.visual;
  const sonic = direction.sonic;
  const script = [
    brief?.legacyReferenceStyleGuidance
      ? `Reference treatment guidance: ${brief.legacyReferenceStyleGuidance}`
      : null,
    narrative?.hookStyle ? `Hook style: ${narrative.hookStyle}.` : null,
    narrative?.tone ? `Tone: ${narrative.tone}.` : null,
    narrative?.pacing ? `Pacing: ${narrative.pacing}.` : null,
    narrative?.ctaStyle ? `CTA style: ${narrative.ctaStyle}.` : null,
    sentence("Writing guidance", narrative?.guidance),
    narrative?.requiredVocabulary?.length
      ? `Use this required vocabulary exactly: ${narrative.requiredVocabulary.join("; ")}.`
      : null,
    narrative?.forbiddenVocabulary?.length
      ? `Never use this forbidden vocabulary: ${narrative.forbiddenVocabulary.join("; ")}.`
      : null,
    narrative?.evidenceRules?.length
      ? `Claim rules: ${narrative.evidenceRules.map((rule) => `${rule.kind}: ${rule.instruction}`).join("; ")}.`
      : null,
  ].filter((part): part is string => Boolean(part)).join("\n") || null;
  const storyboard = [
    structure?.sceneCount
      ? `Keep the plan between ${structure.sceneCount.min} and ${structure.sceneCount.max} scenes when the existing format permits.`
      : null,
    structure?.beats?.length
      ? `Preferred beat arc: ${structure.beats.map((beat) => `${beat.purpose}: ${beat.instruction}`).join(" | ")}.`
      : null,
  ].filter((part): part is string => Boolean(part)).join("\n") || null;
  const visualFragment = [
    "Treatment only: preserve each scene's existing subject, action, identity, product, and safety constraints; never add, remove, or replace subject matter.",
    visual?.style ? `Visual style: ${visual.style}.` : null,
    visual?.lighting ? `Lighting: ${visual.lighting}.` : null,
    visual?.colorGrade ? `Color grade: ${visual.colorGrade}.` : null,
    visual?.composition ? `Composition: ${visual.composition}.` : null,
    visual?.motion ? `Motion: ${visual.motion}.` : null,
    visual?.palette?.length ? `Palette: ${visual.palette.join(", ")}.` : null,
    visual?.negativeTerms?.length ? `Avoid visual treatments: ${visual.negativeTerms.join(", ")}.` : null,
    sentence("Framing/treatment rule", visual?.subjectRule),
  ].filter((part): part is string => Boolean(part));
  const hasVisual = Boolean(
    visual && Object.values(visual).some((value) => value !== undefined),
  );
  const stock = visual?.stockQueryGuidance
    ? `Stock-query treatment only; preserve the scene subject and do not introduce a different subject: ${visual.stockQueryGuidance.trim()}.`
    : null;
  const dynamic =
    direction.captions?.rhythm === "word_group" ||
    direction.captions?.emphasis === "keywords" ||
    direction.captions?.emphasis === "numbers";
  const classic =
    direction.captions?.rhythm === "sentence" ||
    direction.captions?.rhythm === "phrase" ||
    direction.captions?.emphasis === "none";
  const music = sonic && sonic.mood !== "none" && Object.values(sonic).some((value) => value !== undefined)
    ? [
        sonic.mood ? `mood ${sonic.mood}` : null,
        sonic.energy ? `energy ${sonic.energy} of 5` : null,
        sonic.rhythm ? `${sonic.rhythm} rhythm` : null,
        sonic.guidance?.trim() || null,
      ].filter(Boolean).join(", ")
    : null;
  return {
    script,
    storyboard,
    visual: hasVisual ? visualFragment.join("\n") : null,
    stock,
    captionStyle: dynamic ? "dynamic" : classic ? "classic" : null,
    music,
  };
}

/** Append style after the subject-bearing prompt, never in place of it. */
export function appendCreativeFragment(subjectPrompt: string, fragment: string | null): string {
  return fragment ? `${subjectPrompt}\n\n${fragment}` : subjectPrompt;
}

export interface CreativeBriefLintIssue {
  kind: "required_vocabulary" | "forbidden_vocabulary" | "unverified_claim";
  term: string;
}

/** Deterministic review gate over the complete spoken storyboard. */
export function lintStoryboardCreativeBrief(
  storyboard: VideoStoryboard,
  brief: ResolvedCreativeBrief | null | undefined,
): CreativeBriefLintIssue[] {
  if (!brief) return [];
  const spoken = storyboard.scenes.map((scene) => scene.text).join(" ");
  const normalized = spoken.toLocaleLowerCase("en-US");
  const narrative = brief.direction.narrative;
  const issues: CreativeBriefLintIssue[] = [];
  for (const term of narrative?.requiredVocabulary ?? []) {
    if (!normalized.includes(term.toLocaleLowerCase("en-US"))) {
      issues.push({ kind: "required_vocabulary", term });
    }
  }
  for (const term of narrative?.forbiddenVocabulary ?? []) {
    if (normalized.includes(term.toLocaleLowerCase("en-US"))) {
      issues.push({ kind: "forbidden_vocabulary", term });
    }
  }
  if (
    (storyboard.verificationFindings ?? []).some((marker) => /\[\s*verify\b/i.test(marker)) ||
    /\[\s*verify\b/i.test(spoken)
  ) {
    issues.push({ kind: "unverified_claim", term: "[VERIFY]" });
  }
  return issues;
}