import type { GuidedStoryScript, VideoStoryboard } from "@workspace/db";
import type { EffectiveCompliance } from "./profile";
import type { ComplianceField, ComplianceSeverity } from "./rulePacks";

export interface ComplianceText {
  field: ComplianceField;
  /** Human label shown to the reviewer ("Scene 2 · narration"). */
  location: string;
  text: string;
}

export interface ComplianceFinding {
  ruleId: string;
  title: string;
  severity: ComplianceSeverity;
  source: string;
  field: ComplianceField;
  location: string;
  /** The matched phrase as it appears in the (normalised) text. */
  match: string;
  /** ~80 chars of surrounding text for context. */
  excerpt: string;
}

export interface ComplianceReport {
  profession: EffectiveCompliance["profession"];
  packId: string;
  packVersion: string;
  findings: ComplianceFinding[];
  blocking: number;
  review: number;
}

/** Lower-case, straight quotes, collapsed whitespace, Indic digits → ASCII. */
export function normaliseForCheck(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966))
    .toLocaleLowerCase("en-IN")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 35);
  const end = Math.min(text.length, index + length + 35);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function isVerified(match: string, verified: string[]): boolean {
  const m = normaliseForCheck(match);
  return verified.some((claim) => {
    const c = normaliseForCheck(claim);
    return c.includes(m) || m.includes(c);
  });
}

/**
 * Deterministic negative-list check. Pure and synchronous so the same
 * function backs the edit gate, the approval gate, the render gate and the
 * review panel without drift.
 */
export function checkCompliance(
  items: ComplianceText[],
  compliance: EffectiveCompliance | null,
): ComplianceReport | null {
  if (!compliance) return null;
  const findings: ComplianceFinding[] = [];
  const seen = new Set<string>();
  const verified = compliance.facts.verified_claims;
  const hasQualifications = compliance.facts.qualifications.length > 0;
  const negatives = [...new Set([...compliance.extraNegativeTerms, ...compliance.restrictedTerms])]
    .map((term) => normaliseForCheck(term))
    .filter(Boolean);

  const push = (finding: ComplianceFinding) => {
    const key = `${finding.ruleId}|${finding.location}|${finding.match}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(finding);
  };

  for (const item of items) {
    const text = normaliseForCheck(item.text ?? "");
    if (!text) continue;
    for (const rule of compliance.pack.rules) {
      if (!rule.fields.includes(item.field)) continue;
      if (rule.waivedBy === "qualifications" && hasQualifications) continue;
      for (const pattern of rule.patterns) {
        const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
        for (const m of text.matchAll(new RegExp(pattern.source, flags))) {
          const match = m[0];
          if (rule.id.endsWith("unverified_numbers") && isVerified(match, verified)) continue;
          push({
            ruleId: rule.id,
            title: rule.title,
            severity: rule.severity,
            source: rule.source,
            field: item.field,
            location: item.location,
            match,
            excerpt: excerptAround(text, m.index ?? 0, match.length),
          });
        }
      }
    }
    for (const term of negatives) {
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRegExp(term)})(?=$|[^\\p{L}\\p{N}])`, "gu");
      for (const m of text.matchAll(re)) {
        const index = (m.index ?? 0) + (m[1]?.length ?? 0);
        push({
          ruleId: "brand.negative_terms",
          title: "Brand negative list",
          severity: "block",
          source: "Brand Kit — restricted / never-use terms",
          field: item.field,
          location: item.location,
          match: term,
          excerpt: excerptAround(text, index, term.length),
        });
      }
    }
  }
  return {
    profession: compliance.profession,
    packId: compliance.pack.id,
    packVersion: compliance.pack.version,
    findings,
    blocking: findings.filter((f) => f.severity === "block").length,
    review: findings.filter((f) => f.severity === "review").length,
  };
}

/** Every piece of text in a storyboard that can reach the final video. */
export function storyboardComplianceTexts(board: VideoStoryboard): ComplianceText[] {
  const items: ComplianceText[] = [];
  const spoken = new Set<string>();
  board.scenes.forEach((scene, index) => {
    const label = `Scene ${index + 1}`;
    if (scene.text?.trim()) {
      spoken.add(normaliseForCheck(scene.text));
      items.push({ field: "spoken", location: `${label} · narration`, text: scene.text });
    }
    for (const line of scene.guidedStory?.lineOwnership ?? []) {
      const kind = line.kind === "dialogue" ? "dialogue" : "narration";
      // Hindi / Telugu / Tamil lines are also checked through their faithful
      // English meaning, since the negative list is written in English.
      for (const [text, suffix] of [
        [line.text, ""],
        [line.englishTranslation, " (English meaning)"],
      ] as const) {
        if (text?.trim() && !spoken.has(normaliseForCheck(text))) {
          spoken.add(normaliseForCheck(text));
          items.push({ field: "spoken", location: `${label} · ${kind}${suffix}`, text });
        }
      }
    }
    const visuals = [scene.visual, scene.brollVisual, scene.renderVisual].filter(
      (v): v is string => typeof v === "string" && v.trim() !== "",
    );
    for (const visual of new Set(visuals)) {
      items.push({ field: "visual", location: `${label} · visual prompt`, text: visual });
    }
  });
  // Voiced narration is cut from the scene texts; only scan it on its own
  // when the scenes carry no spoken text (e.g. presenter-recorded plans).
  if (spoken.size === 0) {
    const narration = (board.narration?.cues ?? []).map((cue) => cue.text).join(" ");
    if (narration.trim()) items.push({ field: "spoken", location: "Narration", text: narration });
  }
  return items;
}

export function describeFindings(findings: ComplianceFinding[], limit = 6): string {
  const shown = findings.slice(0, limit).map((f) => `${f.location}: "${f.match}" (${f.title})`);
  const more = findings.length > limit ? `; and ${findings.length - limit} more` : "";
  return `${shown.join("; ")}${more}`;
}

/** Every line, translation and visual direction in a Guided Story script. */
export function guidedScriptComplianceTexts(script: GuidedStoryScript): ComplianceText[] {
  const items: ComplianceText[] = [];
  if (script.title?.trim()) items.push({ field: "on_screen", location: "Title", text: script.title });
  if (script.logline?.trim()) items.push({ field: "caption", location: "Logline", text: script.logline });
  script.scenes.forEach((scene, index) => {
    const label = `Scene ${index + 1}`;
    if (scene.visualDirection?.trim()) {
      items.push({ field: "visual", location: `${label} · visual direction`, text: scene.visualDirection });
    }
    for (const line of scene.lines) {
      const kind = line.kind === "dialogue" ? "dialogue" : "narration";
      if (line.text?.trim()) items.push({ field: "spoken", location: `${label} · ${kind}`, text: line.text });
      if (line.englishTranslation?.trim()) {
        items.push({
          field: "spoken",
          location: `${label} · ${kind} (English meaning)`,
          text: line.englishTranslation,
        });
      }
    }
  });
  return items;
}
