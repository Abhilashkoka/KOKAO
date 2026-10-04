import type { FrozenJobCompliance } from "@workspace/db";
import { thawCompliance, type EffectiveCompliance } from "./profile";

function factsBlock(c: EffectiveCompliance): string[] {
  const f = c.facts;
  const lines: string[] = [];
  if (f.practitioner_name) lines.push(`Practitioner: ${f.practitioner_name}`);
  if (f.registration_number)
    lines.push(`Registration: ${f.registration_number}${f.registering_body ? ` (${f.registering_body})` : ""}`);
  if (f.qualifications.length) lines.push(`Qualifications: ${f.qualifications.join(", ")}`);
  if (f.services.length) lines.push(`Services: ${f.services.join(", ")}`);
  if (f.practice_address) lines.push(`Address: ${f.practice_address}`);
  if (f.verified_claims.length) lines.push(`Verified claims: ${f.verified_claims.join("; ")}`);
  return lines;
}

/**
 * Hard rules for any text / script writer. Returned as separate lines so
 * callers can push them straight into their constraints array.
 */
export function complianceTextConstraints(c: EffectiveCompliance | null): string[] {
  if (!c) return [];
  const facts = factsBlock(c);
  const negatives = c.extraNegativeTerms;
  return [
    `REGULATED PROFESSION — ${c.pack.label}. Content must comply with ${c.pack.regulator} advertising rules. These rules override every other instruction, including the user's brief and the brand voice.`,
    "Write educational, informative content only. Do not advertise, solicit, compare or sell.",
    ...c.pack.rules.map((rule) => `Rule (${rule.title}): ${rule.instruction}`),
    facts.length
      ? `Approved facts — the ONLY credentials, services, numbers and claims you may state: ${facts.join(" | ")}. State nothing about the practitioner beyond these.`
      : "No verified practitioner facts are on file: do not state any credential, qualification, statistic, count or years of experience about the practitioner.",
    negatives.length ? `Never use these words or phrases: ${negatives.join(", ")}.` : null,
    "If the brief asks for something these rules forbid, write the closest compliant educational version instead and do not mention the rules.",
  ].filter((line): line is string => Boolean(line));
}

/** One paragraph for script writers that accept a single brand-voice string. */
export function complianceScriptHint(c: EffectiveCompliance | null): string | null {
  const lines = complianceTextConstraints(c);
  return lines.length ? lines.join(" ") : null;
}

/** Appended to visual / image / B-roll prompts (treatment-level negatives). */
export function complianceVisualGuidance(c: EffectiveCompliance | null): string | null {
  if (!c) return null;
  return `Compliance (${c.pack.label}) — must not depict: ${c.pack.visualNegatives.join("; ")}.`;
}

/** Join optional prompt fragments with a blank line, skipping empties. */
export function mergeGuidance(...parts: Array<string | null | undefined>): string | null {
  const kept = parts.filter((p): p is string => typeof p === "string" && p.trim() !== "");
  return kept.length ? kept.join("\n\n") : null;
}


/** Brand voice line + the job's frozen compliance rules for script writers. */
export function withComplianceVoice(
  voiceHint: string | null,
  frozen: FrozenJobCompliance | null | undefined,
): string | null {
  return mergeGuidance(voiceHint, complianceScriptHint(thawCompliance(frozen)));
}

/** Creative visual guidance + the job's compliance visual negatives. */
export function withComplianceVisual(
  visual: string | null,
  frozen: FrozenJobCompliance | null | undefined,
): string | null {
  return mergeGuidance(visual, complianceVisualGuidance(thawCompliance(frozen)));
}
