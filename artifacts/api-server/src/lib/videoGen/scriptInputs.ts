import { db, videoStyleProfilesTable, type BrandKitPayload } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { loadActivePayload } from "../brandKit/service";

/**
 * Script inputs ("Block C") — resolution and sanitization.
 *
 * The script prompt needs a dozen values: who the video is for, how long it
 * runs, what it may claim, what it must never say. Asking a user for all of
 * that per video would be unusable, so most of it is resolved here from state
 * the app already holds — the brand kit and the reference style profile — and
 * only the genuine gaps are ever asked about.
 *
 * SECURITY: brand-derived values are resolved SERVER-SIDE from the ids on the
 * request. A client can ask "use kit 7", it can never assert "kit 7 permits the
 * word X". Restricted terms are merged, never replaced, for the same reason.
 * Everything that ends up in the prompt goes through `sanitizeLine` first.
 */

export type ScriptVariantKey = "marketing" | "training" | "social_short";

/** Speech rate used when nothing better is known. */
export const DEFAULT_WORDS_PER_MINUTE = 140;
/**
 * Renders reliably come out slower than the estimate, so the floor sits under
 * the default rather than at it. Ceiling guards against a style profile whose
 * measured rate came from a badly transcribed reference.
 */
const MIN_WORDS_PER_MINUTE = 90;
const MAX_WORDS_PER_MINUTE = 200;

export const MIN_DURATION_SEC = 10;
export const MAX_DURATION_SEC = 300;
export const DEFAULT_DURATION_SEC = 45;

/** Word budget tolerance, matching the prompt's own stated rule. */
export const WORD_BUDGET_TOLERANCE = 0.08;

export interface ScriptInputOverrides {
  audience?: string | null;
  desiredTakeaway?: string | null;
  cta?: string | null;
  toneNote?: string | null;
  presenterPersona?: string | null;
  sourceFacts?: string[] | null;
  bannedTerms?: string[] | null;
}

export interface ResolvedScriptInputs {
  durationSeconds: number;
  wordsPerMinute: number;
  wordBudget: number;
  wordBudgetMin: number;
  wordBudgetMax: number;
  audience: string | null;
  desiredTakeaway: string | null;
  cta: string | null;
  toneNote: string | null;
  presenterPersona: string | null;
  brandTerms: string[];
  bannedTerms: string[];
  sourceFacts: string[];
  referenceStyle: string | null;
  /** Compiled Layer-5 context handed to the prompt compiler. */
  runtimeContext: string;
}

// ---------------------------------------------------------------------------
// Sanitization

/**
 * Flatten a user-supplied value into one safe prompt line.
 *
 * Newlines are collapsed because the compiled prompt is section-structured:
 * a value containing "\n## Mandatory instructions" would otherwise appear to
 * open a new section. Control characters go for the same reason.
 */
export function sanitizeLine(raw: unknown, maxLength: number): string | null {
  if (typeof raw !== "string") return null;
  const flattened = raw
    // Control characters and newlines are stripped because the compiled
    // prompt is section-structured: a value carrying "\n## Mandatory
    // instructions" would otherwise look like a new section.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!flattened) return null;
  return flattened.slice(0, maxLength);
}

function sanitizeList(
  raw: unknown,
  maxItems: number,
  maxLength: number,
): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const line = sanitizeLine(item, maxLength);
    if (!line) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= maxItems) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Budget maths

export function clampDuration(seconds: unknown): number {
  const n = Math.trunc(Number(seconds));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DURATION_SEC;
  return Math.min(Math.max(n, MIN_DURATION_SEC), MAX_DURATION_SEC);
}

export function clampWordsPerMinute(wpm: unknown): number {
  const n = Number(wpm);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WORDS_PER_MINUTE;
  return Math.min(Math.max(Math.round(n), MIN_WORDS_PER_MINUTE), MAX_WORDS_PER_MINUTE);
}

export function wordBudgetFor(
  durationSeconds: number,
  wordsPerMinute: number,
): { budget: number; min: number; max: number } {
  const budget = Math.round((durationSeconds / 60) * wordsPerMinute);
  return {
    budget,
    min: Math.max(1, Math.floor(budget * (1 - WORD_BUDGET_TOLERANCE))),
    max: Math.ceil(budget * (1 + WORD_BUDGET_TOLERANCE)),
  };
}

/** Spoken words in a clean script. Used to verify the model met its budget. */
export function countSpokenWords(script: string): number {
  const words = script.trim().match(/[^\s]+/g);
  return words ? words.length : 0;
}

// ---------------------------------------------------------------------------
// Brand + style resolution

interface BrandDerived {
  audience: string | null;
  toneNote: string | null;
  cta: string | null;
  brandTerms: string[];
  bannedTerms: string[];
}

function fromBrandPayload(payload: BrandKitPayload): BrandDerived {
  const audience = payload.identity.audience.filter(Boolean).slice(0, 3);
  const traits = payload.voice.traits.filter(Boolean).slice(0, 5);
  const delivery = payload.brand_voice?.delivery_style?.trim();
  const toneParts = [
    traits.length > 0 ? traits.join(", ") : null,
    delivery ? `delivered ${delivery}` : null,
  ].filter(Boolean);
  const brandTerms = [
    payload.identity.brand_name,
    payload.identity.tagline,
  ].filter((t): t is string => Boolean(t && t.trim()));
  const bannedTerms = [
    ...payload.voice.donts,
    ...payload.brand_controls.restricted_terms,
  ].filter(Boolean);
  return {
    audience: audience.length > 0 ? audience.join(", ") : null,
    toneNote: toneParts.length > 0 ? toneParts.join("; ") : null,
    cta: payload.voice.cta_style?.trim() || null,
    brandTerms,
    bannedTerms,
  };
}

/** Structural guidance + measured pace from a reference style profile. */
async function loadStyleInputs(
  tenantId: number,
  styleProfileId: number | null | undefined,
): Promise<{ guidance: string | null; wordsPerMinute: number | null }> {
  if (!styleProfileId) return { guidance: null, wordsPerMinute: null };
  try {
    const row = (
      await db
        .select()
        .from(videoStyleProfilesTable)
        .where(
          and(
            eq(videoStyleProfilesTable.id, styleProfileId),
            eq(videoStyleProfilesTable.tenantId, tenantId),
          ),
        )
        .limit(1)
    )[0];
    if (!row) return { guidance: null, wordsPerMinute: null };
    const parts = [
      row.payload.hookShape?.trim()
        ? `Hook shape: ${row.payload.hookShape.trim()}`
        : null,
      row.payload.energy?.trim() ? `Energy: ${row.payload.energy.trim()}` : null,
      row.payload.scriptGuidance?.trim() || null,
    ].filter(Boolean);
    const measured = row.payload.pacing?.wordsPerMinute;
    return {
      guidance: parts.length > 0 ? parts.join(". ") : null,
      // A reference with no detected speech reports 0; that is "unknown", not
      // "silent", so it must not drag the budget to the floor.
      wordsPerMinute: measured && measured > 0 ? measured : null,
    };
  } catch {
    // Fail-soft: a missing style profile must never fail a generation.
    return { guidance: null, wordsPerMinute: null };
  }
}

// ---------------------------------------------------------------------------

/**
 * Resolve every script input, with client overrides layered over brand
 * defaults. Banned terms are the exception: brand restrictions are UNIONED
 * with client-supplied ones so a client can add to the list but never shorten
 * it.
 */
export async function resolveScriptInputs(params: {
  tenantId: number;
  durationSeconds?: number | null;
  brandKitId?: number | null;
  styleProfileId?: number | null;
  overrides?: ScriptInputOverrides;
}): Promise<ResolvedScriptInputs> {
  const overrides = params.overrides ?? {};

  let brand: BrandDerived = {
    audience: null,
    toneNote: null,
    cta: null,
    brandTerms: [],
    bannedTerms: [],
  };
  if (params.brandKitId) {
    try {
      const resolved = await loadActivePayload(params.tenantId, params.brandKitId);
      if (resolved) brand = fromBrandPayload(resolved.payload);
    } catch {
      // Fail-soft, same contract as loadVideoBranding.
    }
  }

  const style = await loadStyleInputs(params.tenantId, params.styleProfileId);

  const durationSeconds = clampDuration(params.durationSeconds);
  const wordsPerMinute = clampWordsPerMinute(
    style.wordsPerMinute ?? DEFAULT_WORDS_PER_MINUTE,
  );
  const { budget, min, max } = wordBudgetFor(durationSeconds, wordsPerMinute);

  const bannedTerms = sanitizeList(
    [...brand.bannedTerms, ...(overrides.bannedTerms ?? [])],
    40,
    60,
  );

  const inputs: Omit<ResolvedScriptInputs, "runtimeContext"> = {
    durationSeconds,
    wordsPerMinute,
    wordBudget: budget,
    wordBudgetMin: min,
    wordBudgetMax: max,
    audience: sanitizeLine(overrides.audience, 500) ?? brand.audience,
    desiredTakeaway: sanitizeLine(overrides.desiredTakeaway, 500),
    cta: sanitizeLine(overrides.cta, 200) ?? brand.cta,
    toneNote: sanitizeLine(overrides.toneNote, 300) ?? brand.toneNote,
    presenterPersona: sanitizeLine(overrides.presenterPersona, 300),
    brandTerms: sanitizeList(brand.brandTerms, 10, 120),
    bannedTerms,
    sourceFacts: sanitizeList(overrides.sourceFacts, 10, 300),
    referenceStyle: sanitizeLine(style.guidance, 1200),
  };

  return { ...inputs, runtimeContext: buildRuntimeContext(inputs) };
}

/**
 * Render the resolved inputs as the compiler's Context layer.
 *
 * Only non-empty values are emitted, so a script generated with no brand kit
 * and no answers gets a short, clean context instead of a wall of "unknown".
 */
export function buildRuntimeContext(
  inputs: Omit<ResolvedScriptInputs, "runtimeContext">,
): string {
  const lines: string[] = [
    `Target runtime: ${inputs.durationSeconds} seconds.`,
    `Word budget: ${inputs.wordBudget} spoken words (acceptable range ${inputs.wordBudgetMin}-${inputs.wordBudgetMax}), at ${inputs.wordsPerMinute} words per minute.`,
  ];
  if (inputs.audience) lines.push(`Audience: ${inputs.audience}.`);
  if (inputs.desiredTakeaway) {
    lines.push(`The one takeaway: ${inputs.desiredTakeaway}.`);
  }
  if (inputs.cta) lines.push(`Call to action: ${inputs.cta}.`);
  if (inputs.toneNote) lines.push(`Tone: ${inputs.toneNote}.`);
  if (inputs.presenterPersona) {
    lines.push(`Presenter: ${inputs.presenterPersona}.`);
  }
  if (inputs.brandTerms.length > 0) {
    lines.push(
      `Use these names exactly as written: ${inputs.brandTerms.join("; ")}.`,
    );
  }
  if (inputs.bannedTerms.length > 0) {
    lines.push(`Never use these terms: ${inputs.bannedTerms.join("; ")}.`);
  }
  if (inputs.referenceStyle) {
    lines.push(
      `Reference style — match this structure and pacing, never its subject: ${inputs.referenceStyle}`,
    );
  }
  if (inputs.sourceFacts.length > 0) {
    lines.push(
      "Approved facts — the ONLY claims the script may assert as fact:",
      ...inputs.sourceFacts.map((f) => `- ${f}`),
    );
  } else {
    lines.push(
      "No approved facts were supplied. Assert no statistic, price, date or named claim; mark any the script needs as [VERIFY: ...].",
    );
  }
  return lines.join("\n");
}
