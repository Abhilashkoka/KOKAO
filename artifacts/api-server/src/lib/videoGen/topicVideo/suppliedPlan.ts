/**
 * Supplied plans: reusing a saved AI scene plan (storyboard.aiPlan) as the
 * input for a new video, instead of asking the model to invent a new one.
 *
 * The plan JSON may have been hand-edited, so it is validated STRICTLY here —
 * a malformed or rule-breaking plan is rejected with a clear message, never
 * silently "fixed". What passes validation still goes through the exact same
 * normalization clamps as a live AI reply (costume lock, style clamp, per-scene
 * fallbacks), so a supplied plan can never break character consistency or the
 * rules of the generation process.
 */

export type SuppliedPlanFlow = "broll" | "character";

export interface SuppliedPlan {
  flow: SuppliedPlanFlow;
  raw: unknown;
}

/** Guardrail against pathological jsonb growth: a plan bigger than this is
 * not a plan, it is a payload. */
export const MAX_SUPPLIED_PLAN_BYTES = 100_000;

/** Upper bounds mirroring what the planners could ever produce. */
const MAX_PLAN_ENTRIES = 100;
const MAX_PROMPT_CHARS = 2_000;
const MAX_STYLE_CHARS_RAW = 500;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a supplied plan for a flow. Returns a user-facing error message,
 * or null when the plan is usable. Kept dependency-free so the route can call
 * it before any funding is reserved.
 */
export function validateSuppliedPlan(flow: SuppliedPlanFlow, raw: unknown): string | null {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(raw) ?? "", "utf8");
  } catch {
    return "The plan JSON could not be read.";
  }
  if (bytes > MAX_SUPPLIED_PLAN_BYTES) {
    return "The plan JSON is too large.";
  }
  if (!isPlainObject(raw)) {
    return "The plan must be a JSON object.";
  }
  if (flow === "broll") {
    const prompts = raw.prompts;
    if (!Array.isArray(prompts) || prompts.length === 0) {
      return 'A b-roll plan needs a non-empty "prompts" array of strings.';
    }
    if (prompts.length > MAX_PLAN_ENTRIES) {
      return `A plan supports at most ${MAX_PLAN_ENTRIES} prompts.`;
    }
    for (const [i, entry] of prompts.entries()) {
      if (typeof entry !== "string" || !entry.trim()) {
        return `Prompt ${i + 1} must be a non-empty string.`;
      }
      if (entry.length > MAX_PROMPT_CHARS) {
        return `Prompt ${i + 1} is too long (max ${MAX_PROMPT_CHARS} characters).`;
      }
    }
    if (raw.style != null && typeof raw.style !== "string") {
      return 'The "style" entry must be a string when present.';
    }
    if (typeof raw.style === "string" && raw.style.length > MAX_STYLE_CHARS_RAW) {
      return `The "style" entry is too long (max ${MAX_STYLE_CHARS_RAW} characters).`;
    }
    return null;
  }
  // character flow
  const scenes = raw.scenes;
  if (!Array.isArray(scenes) || scenes.length === 0) {
    return 'A character plan needs a non-empty "scenes" array.';
  }
  if (scenes.length > MAX_PLAN_ENTRIES) {
    return `A plan supports at most ${MAX_PLAN_ENTRIES} scenes.`;
  }
  for (const [i, entry] of scenes.entries()) {
    if (!isPlainObject(entry)) {
      return `Scene ${i + 1} must be an object with a "visual" entry.`;
    }
    if (typeof entry.visual !== "string" || !entry.visual.trim()) {
      return `Scene ${i + 1} needs a non-empty "visual" description.`;
    }
    if (entry.visual.length > MAX_PROMPT_CHARS) {
      return `Scene ${i + 1}'s visual is too long (max ${MAX_PROMPT_CHARS} characters).`;
    }
    if (entry.outfitId != null && typeof entry.outfitId !== "number") {
      return `Scene ${i + 1}'s "outfitId" must be a number when present.`;
    }
  }
  return null;
}

/** Runtime type guard for the shape persisted in job options (jsonb). */
export function isSuppliedPlan(value: unknown): value is SuppliedPlan {
  return (
    isPlainObject(value) &&
    (value.flow === "broll" || value.flow === "character") &&
    "raw" in value
  );
}
