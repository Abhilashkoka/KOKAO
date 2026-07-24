import { writeFile, readFile, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { getTextGenClient } from "../../textGen";
import { usageAccountingParams } from "../../aiCost";
import { generateImage, type ImageSize } from "../../imageGen";
import { logger } from "../../logger";
import { runFfmpeg } from "../slideshow";
import { ASPECT_DIMENSIONS, VideoGenProviderError, type VideoAspect } from "../types";
import type { ScriptScene } from "./characterScenes";
import type { SceneSegment } from "./compose";

/**
 * AI b-roll for Topic to Video: instead of licensed stock footage, every
 * scene's visual is GENERATED — a brand-safe image from the scene's meaning,
 * turned into a moving clip with a gentle Ken Burns move. Fully owned by the
 * tenant, always on-topic, and it never raises a licensing question.
 *
 * Cost model: images only (no image-to-video calls), so it prices well below
 * character videos — see videoJobUnits.
 */

export const AI_BROLL_SCENES_PER_PARAGRAPH = 4;
/** Parallel image generations; mirrors the character-scene ceiling. */
const IMAGE_CONCURRENCY = 3;
const FPS = 30;

function imageSizeForAspect(aspect: VideoAspect): ImageSize {
  if (aspect === "9:16") return "1024x1536";
  if (aspect === "16:9") return "1536x1024";
  return "1024x1024";
}

/**
 * One LLM call turns the scenes into concrete photographic prompts. Fails
 * soft: a scene without a plan falls back to its narration text.
 */
export async function planBrollVisuals(params: {
  tenantAiModel: string;
  topic: string;
  scenes: ScriptScene[];
}): Promise<string[]> {
  const fallback = params.scenes.map(
    (scene) => `Photorealistic cinematic still: ${scene.text.slice(0, 240)}`,
  );
  try {
    const textGen = await getTextGenClient(params.tenantAiModel);
    const sceneList = params.scenes.map((s, i) => `${i + 1}. ${s.text}`).join("\n");
    const completion = await textGen.client.chat.completions.create({
      model: textGen.model,
      messages: [
        {
          role: "system",
          content: "You art-direct b-roll imagery and reply with strict JSON only.",
        },
        {
          role: "user",
          content: `# Role: B-roll Art Director

A short video about "${params.topic}" has ${params.scenes.length} narrated scenes. Write one image-generation prompt per scene.

## Rules:
1. Reply with strict JSON: {"prompts": ["...", ...]} — exactly ${params.scenes.length} entries, in scene order.
2. Each prompt describes ONE photorealistic, cinematic still that visualizes that scene's meaning: concrete subject, setting, lighting, camera angle.
3. No text, watermarks, logos, or recognizable brands in the image. No people looking into the camera.
4. Keep a consistent visual mood across all scenes (same time of day / palette family).

## Scenes (narration):
${sceneList}`,
        },
      ],
      max_completion_tokens: 4096,
      response_format: { type: "json_object" },
      ...usageAccountingParams(textGen.provider),
    });
    const parsed = JSON.parse(completion.choices[0]?.message?.content ?? "") as {
      prompts?: unknown;
    };
    const prompts: unknown[] | null = Array.isArray(parsed.prompts) ? parsed.prompts : null;
    if (!prompts) return fallback;
    return params.scenes.map((_, i) => {
      const entry = prompts[i];
      return typeof entry === "string" && entry.trim() ? entry.trim() : fallback[i]!;
    });
  } catch (error) {
    logger.warn({ err: error }, "B-roll visual planning failed; using narration text");
    return fallback;
  }
}

/** Turn a still image into a Ken Burns clip matching the scene's duration. */
export async function stillToClip(
  image: Buffer,
  durationSec: number,
  aspectRatio: VideoAspect,
  zoomIn: boolean,
): Promise<Buffer> {
  const { width, height } = ASPECT_DIMENSIONS[aspectRatio];
  const superW = width * 2;
  const superH = height * 2;
  const seconds = Math.max(0.5, durationSec);
  const frames = Math.max(1, Math.round(seconds * FPS));
  const zoomSpan = 0.08;
  const zoomStep = (zoomSpan / frames).toFixed(6);
  const zoomExpr = zoomIn
    ? `min(1+${zoomStep}*on,${(1 + zoomSpan).toFixed(3)})`
    : `max(${(1 + zoomSpan).toFixed(3)}-${zoomStep}*on,1.001)`;

  const dir = await mkdtemp(join(tmpdir(), "kokao-broll-"));
  try {
    await writeFile(join(dir, "still.png"), image);
    await runFfmpeg(
      [
        "-y",
        "-loop",
        "1",
        "-t",
        seconds.toFixed(3),
        "-i",
        "still.png",
        "-vf",
        `scale=${superW}:${superH}:force_original_aspect_ratio=increase,` +
          `crop=${superW}:${superH},` +
          `zoompan=z='${zoomExpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':` +
          `d=1:s=${width}x${height}:fps=${FPS},` +
          `setsar=1,format=yuv420p`,
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "clip.mp4",
      ],
      dir,
    );
    return await readFile(join(dir, "clip.mp4"));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Generate one owned clip per scene: image from the scene's plan, then a
 * Ken Burns move sized to the scene's duration (alternating in/out).
 */
export async function generateBrollClips(params: {
  tenantAiModel: string;
  topic: string;
  scenes: ScriptScene[];
  aspectRatio: VideoAspect;
}): Promise<{ clips: Buffer[]; sceneMap: SceneSegment[]; provider: string }> {
  if (params.scenes.length === 0) {
    throw new VideoGenProviderError("There are no scenes to visualize.");
  }
  const prompts = await planBrollVisuals({
    tenantAiModel: params.tenantAiModel,
    topic: params.topic,
    scenes: params.scenes,
  });
  const size = imageSizeForAspect(params.aspectRatio);

  let provider = "ai";
  const clips = await mapWithConcurrency(params.scenes, IMAGE_CONCURRENCY, async (scene, i) => {
    const image = await generateImage(prompts[i]!, size);
    provider = image.provider;
    return stillToClip(image.buffer, scene.durationSec, params.aspectRatio, i % 2 === 0);
  });

  return {
    clips,
    sceneMap: params.scenes.map((scene, i) => ({
      clipIndex: i,
      durationSec: scene.durationSec,
    })),
    provider,
  };
}
