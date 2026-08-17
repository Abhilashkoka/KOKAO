import type { VideoJobOptions } from "@workspace/db";
import { CHARACTER_SCENES_PER_PARAGRAPH } from "./topicVideo/characterScenes";
import { clipShotCount } from "./clipStoryboard";

/**
 * How many video quota units / credits one generation job costs.
 *
 * Every engine is a single generation — one unit — except the two that are
 * really many generations wearing one job:
 *
 * - character story videos, where every scene is its own keyframe +
 *   image-to-video pair, so a job costs one unit per scene: Short (1 paragraph)
 *   = 4, Medium = 8, Long = 12.
 * - multi-shot text_to_video, where every shot is its own clip generation, so a
 *   job costs one unit per shot.
 *
 * The route reserves this amount up front and the job runner refunds the same
 * amount if the job fails.
 */
export function videoJobUnits(engine: string, options: VideoJobOptions | null): number {
  let units = 1;
  if (engine === "text_to_video") {
    // Shot count is fixed at enqueue precisely because it prices the job; the
    // storyboard editor can reword a shot but never add or remove one.
    units = clipShotCount(options?.shotCount);
  } else if (engine === "topic_to_video" && options?.visualsSource === "character") {
    const paragraphs = Math.min(Math.max(Math.trunc(options.paragraphCount ?? 1) || 1, 1), 3);
    units = CHARACTER_SCENES_PER_PARAGRAPH * paragraphs;
  } else if (engine === "topic_to_video" && options?.visualsSource === "ai") {
    // AI b-roll: every scene is a generated image (no image-to-video calls),
    // so it prices at half the character rate: Short = 2, Medium = 4, Long = 6.
    const paragraphs = Math.min(Math.max(Math.trunc(options.paragraphCount ?? 1) || 1, 1), 3);
    units = 2 * paragraphs;
  } else if (engine === "topic_to_video" && options?.visualsSource === "ai_video") {
    // Animated AI b-roll: generated images PLUS an image-to-video call per
    // scene, but no character keyframe editing — so it sits between b-roll
    // and character: Short = 3, Medium = 6, Long = 9.
    const paragraphs = Math.min(Math.max(Math.trunc(options.paragraphCount ?? 1) || 1, 1), 3);
    units = 3 * paragraphs;
  }
  // Scenes added during storyboard review were each funded as one extra unit
  // when they were inserted; counting them here keeps every price
  // recomputation (usage on success, refunds on failure/discard) in sync with
  // what was actually reserved.
  units += Math.max(0, Math.trunc(options?.addedScenes ?? 0));
  // An AI-composed music bed is its own real generation: +1 unit, on any
  // engine. Only charged when no uploaded track takes precedence.
  if (!options?.musicPath && options?.musicPrompt?.trim()) {
    units += 1;
  }
  return units;
}
