import { writeFile, readFile, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { getTextGenClient } from "../../textGen";
import { usageAccountingParams } from "../../aiCost";
import { getGovernedPrompt, logCompiledPrompt } from "../../promptKit";
import { generateImage, type ImageSize } from "../../imageGen";
import { logger } from "../../logger";
import { runFfmpeg } from "../slideshow";
import { generateVideo } from "../index";
import { getMotionInstruction } from "../motionPrompt";
import { ASPECT_DIMENSIONS, VideoGenProviderError, type VideoAspect } from "../types";
import { clipDurationForScene, type ScriptScene } from "./characterScenes";
import type { SceneSegment } from "./compose";
import { refineScenePrompts } from "./refineScenePrompts";

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

/** A shared look is one clause, not an essay; bound it so prompts stay sane. */
const MAX_STYLE_CHARS = 200;

/**
 * One LLM call turns the scenes into concrete photographic prompts, plus a
 * single style directive that gets appended to every one of them so the
 * finished video reads as one film instead of a stock-photo collage. B-roll
 * scenes are deliberately different subjects, so the *look* — palette, light,
 * lens, grade — is the only thing that can be held constant across them;
 * anchoring later scenes on the first scene's image would drag its subject
 * along with its style. Fails soft: a scene without a plan falls back to its
 * narration text, and an unusable style is simply dropped.
 */
export async function planBrollVisuals(params: {
  tenantAiModel: string;
  topic: string;
  scenes: ScriptScene[];
  /** Enables the governed prompt (Prompt Template Kit) when provided. */
  tenantId?: number | null;
  /** A saved/edited plan reused instead of asking the model (validated
   * upstream; still normalized through the same clamps as a live reply). */
  suppliedPlan?: unknown;
}): Promise<{ prompts: string[]; rawPlan: unknown | null }> {
  const fallback = params.scenes.map(
    (scene) => `Photorealistic cinematic still: ${scene.text.slice(0, 240)}`,
  );
  if (params.suppliedPlan != null) {
    // Reuse path: no LLM call. Unlike the live path this does NOT fail soft —
    // the user chose this exact plan, so an unusable one is an error, never a
    // silent fallback to something they didn't pick.
    const parsed = params.suppliedPlan as { prompts?: unknown; style?: unknown };
    const prompts = normalizeBrollPlan(parsed, params.scenes, fallback);
    if (!prompts) {
      throw new VideoGenProviderError(
        'The saved plan is missing its "prompts" list and cannot be reused.',
      );
    }
    return { prompts, rawPlan: params.suppliedPlan };
  }
  try {
    const textGen = await getTextGenClient(params.tenantAiModel);
    const sceneList = params.scenes.map((s, i) => `${i + 1}. ${s.text}`).join("\n");
    // Prompt Template Kit: a production template for the video_scene_image
    // flow replaces the built-in system prompt. Video jobs run in the
    // background with no per-user session (customizationId: null).
    // Fail-open: null keeps the built-in prompt exactly as before.
    const governed = params.tenantId
      ? await getGovernedPrompt({
          flowKey: "video_scene_image",
          tenantId: params.tenantId,
          clerkUserId: "",
          customizationId: null,
          runtimeContext: `Video topic: ${params.topic}. Scene count: ${params.scenes.length}.`,
          outputFormat:
            'Reply with strict JSON: {"style": "...", "prompts": ["...", ...]} — exactly one prompt entry per scene, in scene order. "style" is ONE short clause fixing the look of the whole video (palette, light, lens, grade), no subject matter. Each prompt describes ONE still image for its scene without restating the style.',
          placeholderValues: {
            topic: params.topic,
            sceneCount: String(params.scenes.length),
          },
        })
      : null;
    const startedAt = Date.now();
    const completion = await textGen.client.chat.completions.create({
      model: textGen.model,
      messages: [
        {
          role: "system",
          content: governed
            ? governed.text
            : "You art-direct b-roll imagery and reply with strict JSON only.",
        },
        {
          role: "user",
          content: `# Role: B-roll Art Director

A short video about "${params.topic}" has ${params.scenes.length} narrated scenes. Write one image-generation prompt per scene.

## Rules:
1. Reply with strict JSON: {"style": "...", "prompts": ["...", ...]} — exactly ${params.scenes.length} prompt entries, in scene order.
2. "style" is ONE short clause fixing the look of the whole video: palette, quality of light, lens/format, colour grade. No subject matter and no scene specifics — it is appended to every prompt.
3. Each prompt describes ONE photorealistic, cinematic still that visualizes that scene's meaning: concrete subject, setting, and one slow camera move (e.g. glide, push-in, rise). Vary the coverage across scenes — mix wide establishing shots, medium frames, and intimate close-ups so the sequence reads as a real edit. Include the quality and direction of light (e.g. golden-hour warmth, diffused overcast, shafts of sunlight) and a tactile detail or atmosphere (surface texture, dust in sunlight, water reflections). Do not restate the style.
4. No text, watermarks, logos, or recognizable brands in the image. No people looking into the camera.

## Scenes (narration):
${sceneList}`,
        },
      ],
      max_completion_tokens: 4096,
      response_format: { type: "json_object" },
      ...usageAccountingParams(textGen.provider),
    });
    if (governed && params.tenantId) {
      // Best-effort: a logging hiccup must not downgrade a successful plan to
      // the narration fallback (which would also drop the reusable rawPlan).
      try {
        await logCompiledPrompt({
          tenantId: params.tenantId,
          flowKey: "video_scene_image",
          governed,
          generationContext: { model: textGen.model, sceneCount: params.scenes.length },
          success: true,
          latencyMs: Date.now() - startedAt,
          tokenUsage: completion.usage
            ? {
                promptTokens: completion.usage.prompt_tokens ?? 0,
                completionTokens: completion.usage.completion_tokens ?? 0,
                totalTokens: completion.usage.total_tokens ?? 0,
              }
            : null,
        });
      } catch (error) {
        logger.warn({ err: error }, "Compiled prompt logging failed; continuing");
      }
    }
    const parsed = JSON.parse(completion.choices[0]?.message?.content ?? "") as {
      prompts?: unknown;
      style?: unknown;
    };
    const prompts = normalizeBrollPlan(parsed, params.scenes, fallback);
    const effectivePrompts = prompts ?? fallback;
    const refinedPrompts = await refineScenePrompts({
      tenantAiModel: params.tenantAiModel,
      prompts: effectivePrompts,
      tenantId: params.tenantId,
    });
    if (!prompts) return { prompts: refinedPrompts, rawPlan: null };
    // The untouched AI reply, kept on the storyboard for audit.
    return { prompts: refinedPrompts, rawPlan: parsed };
  } catch (error) {
    logger.warn({ err: error }, "B-roll visual planning failed; using narration text");
    return { prompts: fallback, rawPlan: null };
  }
}

/**
 * The one rulebook for turning a b-roll plan (live AI reply or reused saved
 * plan) into effective per-scene prompts: style clamped to one short clause
 * and appended to every prompt, blank/missing entries falling back to the
 * scene's narration text. Returns null when there is no prompts array at all.
 */
function normalizeBrollPlan(
  parsed: { prompts?: unknown; style?: unknown },
  scenes: ScriptScene[],
  fallback: string[],
): string[] | null {
  const prompts: unknown[] | null = Array.isArray(parsed.prompts) ? parsed.prompts : null;
  if (!prompts) return null;
  const style =
    typeof parsed.style === "string" ? parsed.style.trim().slice(0, MAX_STYLE_CHARS) : "";
  return scenes.map((_, i) => {
    const entry = prompts[i];
    const scenePrompt = typeof entry === "string" && entry.trim() ? entry.trim() : fallback[i]!;
    return style ? `${scenePrompt} Shared look across all scenes: ${style}` : scenePrompt;
  });
}

/**
 * The ffmpeg argv for one Ken Burns clip, rendered from "still.png" in the
 * working directory. Split out of `stillToClip` so the argument list is
 * testable without spawning an encoder.
 */
export function buildStillToClipArgs(
  durationSec: number,
  aspectRatio: VideoAspect,
  zoomIn: boolean,
): string[] {
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

  return [
    "-y",
    // Pin the image demuxer to the pipeline's FPS. At its 25fps default it fed
    // 25 frames per second into a chain that retimes to FPS, so the clip came
    // out ~17% short — short enough that the composer loop-filled it with
    // -stream_loop -1 and the Ken Burns move visibly restarted mid-scene —
    // and the per-frame zoom step under-travelled by the same fraction.
    "-framerate",
    String(FPS),
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
  ];
}

/** Turn a still image into a Ken Burns clip matching the scene's duration. */
export async function stillToClip(
  image: Buffer,
  durationSec: number,
  aspectRatio: VideoAspect,
  zoomIn: boolean,
): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "kokao-broll-"));
  try {
    await writeFile(join(dir, "still.png"), image);
    await runFfmpeg(buildStillToClipArgs(durationSec, aspectRatio, zoomIn), dir);
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
 * The cheap half: one still per prompt. These are also exactly the stills the
 * storyboard previews, so a reviewed job generates them once and animates the
 * approved ones rather than paying for a second set.
 */
export async function generateBrollStills(params: {
  prompts: string[];
  aspectRatio: VideoAspect;
}): Promise<{ images: Buffer[]; provider: string }> {
  const size = imageSizeForAspect(params.aspectRatio);
  let provider = "ai";
  const images = await mapWithConcurrency(params.prompts, IMAGE_CONCURRENCY, async (prompt) => {
    const image = await generateImage(prompt, size);
    provider = image.provider;
    return image.buffer;
  });
  return { images, provider };
}

/** The render half: a Ken Burns move per still, sized to its scene and
 * alternating in/out so consecutive scenes do not drift the same way. */
export async function stillsToClips(params: {
  images: Buffer[];
  scenes: ScriptScene[];
  aspectRatio: VideoAspect;
}): Promise<{ clips: Buffer[]; sceneMap: SceneSegment[] }> {
  const clips = await mapWithConcurrency(params.scenes, IMAGE_CONCURRENCY, async (scene, i) => {
    const image = params.images[i];
    if (!image) throw new VideoGenProviderError("A scene is missing its still image.");
    return stillToClip(image, scene.durationSec, params.aspectRatio, i % 2 === 0);
  });
  return {
    clips,
    sceneMap: params.scenes.map((scene, i) => ({
      clipIndex: i,
      durationSec: scene.durationSec,
    })),
  };
}

/** Image-to-video pipelines running at once (matches the character ceiling). */
const ANIMATE_CONCURRENCY = 3;

/**
 * The animated flavour of the render half: instead of a Ken Burns move, every
 * approved still goes through the image-to-video model — real AI motion,
 * anchored on exactly the frame the storyboard previewed. Clip lengths follow
 * Character mode's handling: the shortest provider length that covers the
 * scene, with the compositor trimming (or looping) the difference. Each scene
 * retries once; a scene that fails twice fails the job (the runner refunds
 * the reservation).
 */
export async function animateBrollStills(params: {
  images: Buffer[];
  /** Per-scene visual descriptions (the storyboard's approved prompts). */
  visuals: string[];
  scenes: ScriptScene[];
  aspectRatio: VideoAspect;
}): Promise<{ clips: Buffer[]; sceneMap: SceneSegment[]; provider: string; model: string }> {
  let provider = "";
  let model = "";
  // Governed motion instruction (Prompt Kit `video_motion`), resolved once
  // per job; fail-open to the built-in wording.
  const motion = await getMotionInstruction();
  const clips = await mapWithConcurrency(params.scenes, ANIMATE_CONCURRENCY, async (scene, i) => {
    const image = params.images[i];
    if (!image) throw new VideoGenProviderError("A scene is missing its still image.");
    const visual = params.visuals[i]?.trim() || scene.text.slice(0, 240);
    const durationSec = clipDurationForScene(scene.durationSec);
    const attempt = async (): Promise<Buffer> => {
      const clip = await generateVideo({
        mode: "image",
        prompt: `${visual}. ${motion}`,
        aspectRatio: params.aspectRatio,
        durationSec,
        image: { buffer: image, mimeType: "image/png" },
      });
      provider = clip.provider;
      model = clip.model;
      return clip.buffer;
    };
    try {
      return await attempt();
    } catch (err) {
      logger.warn({ err, scene: i }, "animated b-roll scene failed; retrying once");
      return await attempt();
    }
  });
  return {
    clips,
    sceneMap: params.scenes.map((scene, i) => ({
      clipIndex: i,
      durationSec: scene.durationSec,
    })),
    provider: provider || "replicate",
    model: model || "image-to-video",
  };
}

/**
 * Straight-through generated b-roll: plan the prompts, generate one still per
 * scene, Ken Burns each into a clip. Used when the job is not paused for
 * storyboard review; a reviewed job calls the halves either side of the pause.
 */
export async function generateBrollClips(params: {
  tenantAiModel: string;
  topic: string;
  scenes: ScriptScene[];
  aspectRatio: VideoAspect;
  /** Enables the governed prompt (Prompt Template Kit) when provided. */
  tenantId?: number | null;
  /** A saved/edited plan reused instead of asking the model. */
  suppliedPlan?: unknown;
  /** True = image-to-video motion per still ("ai_video"); false/omitted = the
   * Ken Burns move ("ai"). */
  animate?: boolean;
}): Promise<{ clips: Buffer[]; sceneMap: SceneSegment[]; provider: string }> {
  if (params.scenes.length === 0) {
    throw new VideoGenProviderError("There are no scenes to visualize.");
  }
  const { prompts } = await planBrollVisuals({
    tenantAiModel: params.tenantAiModel,
    topic: params.topic,
    scenes: params.scenes,
    tenantId: params.tenantId,
    suppliedPlan: params.suppliedPlan,
  });
  const { images, provider } = await generateBrollStills({
    prompts,
    aspectRatio: params.aspectRatio,
  });
  if (params.animate) {
    const animated = await animateBrollStills({
      images,
      visuals: prompts,
      scenes: params.scenes,
      aspectRatio: params.aspectRatio,
    });
    return { clips: animated.clips, sceneMap: animated.sceneMap, provider: animated.provider };
  }
  const { clips, sceneMap } = await stillsToClips({
    images,
    scenes: params.scenes,
    aspectRatio: params.aspectRatio,
  });
  return { clips, sceneMap, provider };
}
