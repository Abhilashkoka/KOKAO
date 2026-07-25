import type { VideoJobOptions } from "@workspace/db";
import { CHARACTER_SCENES_PER_PARAGRAPH } from "./topicVideo/characterScenes";

/**
 * How many video quota units / credits one generation job costs.
 *
 * Every engine is a single generation — one unit — except character story
 * videos, where every scene is its own real AI generation (keyframe +
 * image-to-video), so a job costs one unit per scene: Short (1 paragraph)
 * = 4, Medium = 8, Long = 12. The route reserves this amount up front and
 * the job runner refunds the same amount if the job fails.
 */
export function videoJobUnits(engine: string, options: VideoJobOptions | null): number {
  let units = 1;
  if (engine === "topic_to_video" && options?.visualsSource === "character") {
    const paragraphs = Math.min(Math.max(Math.trunc(options.paragraphCount ?? 1) || 1, 1), 3);
    units = CHARACTER_SCENES_PER_PARAGRAPH * paragraphs;
  } else if (engine === "topic_to_video" && options?.visualsSource === "ai") {
    // AI b-roll: every scene is a generated image (no image-to-video calls),
    // so it prices at half the character rate: Short = 2, Medium = 4, Long = 6.
    const paragraphs = Math.min(Math.max(Math.trunc(options.paragraphCount ?? 1) || 1, 1), 3);
    units = 2 * paragraphs;
  }
  // An AI-composed music bed is its own real generation: +1 unit. Only
  // charged when no uploaded track takes precedence.
  if (
    (engine === "topic_to_video" || engine === "slideshow") &&
    !options?.musicPath &&
    options?.musicPrompt?.trim()
  ) {
    units += 1;
  }
  return units;
}
