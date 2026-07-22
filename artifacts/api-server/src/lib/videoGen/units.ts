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
  if (engine === "topic_to_video" && options?.visualsSource === "character") {
    const paragraphs = Math.min(Math.max(Math.trunc(options.paragraphCount ?? 1) || 1, 1), 3);
    return CHARACTER_SCENES_PER_PARAGRAPH * paragraphs;
  }
  return 1;
}
