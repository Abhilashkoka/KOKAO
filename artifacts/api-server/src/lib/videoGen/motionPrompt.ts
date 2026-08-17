import { loadActiveCasePrompt, substitutePlaceholders } from "../promptKit";
import { logger } from "../logger";

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
 */
export const DEFAULT_MOTION_INSTRUCTION = "Subtle natural motion, cinematic.";

export async function getMotionInstruction(): Promise<string> {
  try {
    const active = await loadActiveCasePrompt("video_motion");
    if (!active) return DEFAULT_MOTION_INSTRUCTION;
    const text = [...active.version.contentSnapshot]
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
      .map((block) => substitutePlaceholders(block.content.trim(), {}).text.trim())
      .filter((t) => t.length > 0)
      .join(" ");
    return text || DEFAULT_MOTION_INSTRUCTION;
  } catch (err) {
    logger.warn({ err }, "video_motion prompt lookup failed; using the built-in instruction");
    return DEFAULT_MOTION_INSTRUCTION;
  }
}
