import { loadActiveCasePrompt, substitutePlaceholders } from "../promptKit";
import { logger } from "../logger";
import { findMotionPreset } from "./motionPresets";
import { cinematographyClause, type Cinematography } from "./cinematography";

/**
 * The motion instruction appended to every image-to-video prompt (character
 * scenes, character clips, and animated AI b-roll). Governed by the Prompt
 * Template Kit's `video_motion` flow: when a production template exists, its
 * block content REPLACES the built-in suffix; otherwise the built-in wording
 * ships unchanged (fail-open — governance must never break generation).
 *
 * Unlike full governed prompts this is a one-clause suffix, not a system
 * prompt, so the compilation is deliberately minimal: block contents joined in
 * order, no layer headers, no customization layer (video jobs run in the
 * background with no per-user session).
 *
 * A NAMED MOTION PRESET WINS OUTRIGHT. The default ("subtle natural motion")
 * and a preset like "crash zoom in" are contradictory instructions, and
 * sending both produces a muddle — so when the user picked a preset it is the
 * whole motion instruction. Governance still applies to the DEFAULT, which is
 * what an unpicked job gets. The preset catalog is versioned in source rather
 * than in the Prompt Kit because its ids are persisted on jobs and storyboard
 * scenes and must resolve identically on a retry months later.
 */
export const DEFAULT_MOTION_INSTRUCTION = "Subtle natural motion, cinematic.";

export async function getMotionInstruction(
  presetId?: string | null,
  cinematography?: Cinematography | null,
): Promise<string> {
  const optics = cinematographyClause(cinematography);
  const withOptics = (motion: string): string =>
    optics ? `${motion} ${optics}` : motion;
  const preset = findMotionPreset(presetId);
  if (preset) return withOptics(preset.prompt);
  try {
    const active = await loadActiveCasePrompt("video_motion");
    if (!active) return withOptics(DEFAULT_MOTION_INSTRUCTION);
    const text = [...active.version.contentSnapshot]
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
      .map((block) => substitutePlaceholders(block.content.trim(), {}).text.trim())
      .filter((t) => t.length > 0)
      .join(" ");
    return withOptics(text || DEFAULT_MOTION_INSTRUCTION);
  } catch (err) {
    logger.warn({ err }, "video_motion prompt lookup failed; using the built-in instruction");
    return withOptics(DEFAULT_MOTION_INSTRUCTION);
  }
}

/**
 * The motion clause for a TEXT-to-video shot, where there is no built-in
 * suffix to replace: an unpicked shot renders exactly the prompt it always
 * did, and a picked one gains the preset sentence. Returns null when there is
 * nothing to append, so callers leave their prompt untouched.
 */
export function motionPresetClause(
  presetId?: string | null,
  cinematography?: Cinematography | null,
): string | null {
  const parts = [
    findMotionPreset(presetId)?.prompt ?? null,
    cinematographyClause(cinematography),
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(" ") : null;
}
