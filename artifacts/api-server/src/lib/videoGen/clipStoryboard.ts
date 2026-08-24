import {
  type VideoGeneration,
  type VideoStoryboard,
  type VideoStoryboardScene,
  type VideoStoryboardSource,
  tenantsTable,
  db,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { getCharacterDetail, resolveOutfit, loadReferenceImage, generateSceneKeyframe } from "../characters";
import { getTextGenClient } from "../textGen";
import { getGovernedPrompt, logCompiledPrompt, type GovernedPrompt } from "../promptKit";
import { usageAccountingParams } from "../aiCost";
import { logger } from "../logger";
import { generateVideo } from "./index";
import { getMotionInstruction, motionPresetClause } from "./motionPrompt";
import { resolveModelOptions } from "./modelCatalog";
import { concatClips, enforceClipDuration, mixMusicIntoVideo, normalizeVideo, fitImageToAspect } from "./postprocess";
import { refineScenePrompts } from "./topicVideo/refineScenePrompts";
import {
  renderSlideshow,
  slideshowTotalSec,
  MIN_SLIDE_SECONDS,
  MAX_SLIDE_SECONDS,
  MAX_SLIDESHOW_IMAGES,
} from "./slideshow";
import { VideoGenProviderError, type SourceImage, type VideoAspect } from "./types";

/**
 * Storyboards for the three engines that are not topic mode: text_to_video,
 * image_to_video and slideshow.
 *
 * These plans differ from a topic plan in one structural way: there is no voiced
 * narration, so the timeline is FREE. Scene lengths are editable here, bounded
 * per source by what the renderer can actually deliver, which is where the
 * "one image every three to five seconds" pacing rule lives.
 *
 * What each plan costs to make is the thing that decides what is editable:
 *
 * - slideshow ("slide") plans, and animate-photo ("photo") plans, are free to
 *   produce. The previews are the user's own uploaded photos, already in tenant
 *   storage, so planning generates nothing at all.
 * - text_to_video splits the brief into shots. With a character locked, each
 *   shot gets an identity-anchored keyframe — the plan is a "character" plan,
 *   the keyframes are free previews, and the render animates the exact frames
 *   that were approved. Without a character there is nothing image-shaped to
 *   show, so a "prompt" plan is a shot list: prompts and lengths, no stills.
 *
 * Shot COUNT is fixed at enqueue time on every one of them, because the funding
 * reservation is computed from it. Editing a plan can never change what the job
 * costs, which is what makes editing free.
 */

/** Most shots one text_to_video job will split into. Each shot is a separate
 * generation, so this is also the ceiling on what one job can cost. */
export const MAX_CLIP_SHOTS = 10;

/** Fallback shot count when the "let the script decide" call fails: three
 * shots reads as a real edit without risking a large surprise reservation. */
const AUTO_SHOT_FALLBACK = 3;

/**
 * "Auto" shot count: one small LLM call, at ENQUEUE time, that reads the brief
 * and decides how many shots (1..MAX_CLIP_SHOTS) it naturally breaks into.
 *
 * It must run before funding is reserved — the count it returns is what the
 * job costs — which is why it lives here and not in the planner: the planner
 * runs after the money moved and can only fill in the shots, never add one.
 *
 * Fail-soft to AUTO_SHOT_FALLBACK: losing an enqueue over this call would be
 * the wrong trade, and the storyboard review step still shows the user
 * exactly how many shots they are paying for before anything renders.
 */
export async function decideShotCountFromBrief(
  tenantId: number,
  brief: string,
): Promise<number> {
  const tenant = (
    await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId)).limit(1)
  )[0];
  if (!tenant) throw new VideoGenProviderError("Tenant not found.");
  try {
    const textGen = await getTextGenClient(tenant.aiModel);
    const completion = await textGen.client.chat.completions.create({
      model: textGen.model,
      messages: [
        {
          role: "system",
          content:
            "You are a shot planner for short social videos. You reply with strict JSON only.",
        },
        {
          role: "user",
          content:
            `How many consecutive shots does this video brief naturally break into? ` +
            `Each shot is one continuous camera take of a few seconds. Think like a film ` +
            `editor: a strong short video has a narrative arc — an opening hook, one or ` +
            `more development beats, and a payoff — and each distinct beat gets one shot. ` +
            `Use the fewest shots that deliver that arc cleanly; a single moment is 1 shot. ` +
            `Between 1 and ${MAX_CLIP_SHOTS}.\n\n` +
            `Brief: ${brief.slice(0, 2000)}\n\n` +
            `Reply as {"shotCount": <number>}.`,
        },
      ],
      max_completion_tokens: 256,
      response_format: { type: "json_object" },
      ...usageAccountingParams(textGen.provider),
    });
    const parsed: unknown = JSON.parse(completion.choices[0]?.message?.content ?? "");
    const n = Math.trunc(Number((parsed as { shotCount?: unknown }).shotCount));
    if (!Number.isFinite(n) || n < 1) return AUTO_SHOT_FALLBACK;
    return Math.min(MAX_CLIP_SHOTS, n);
  } catch (err) {
    logger.warn({ err, tenantId }, "Auto shot count failed; using the fallback count");
    return AUTO_SHOT_FALLBACK;
  }
}

/** Default seconds per shot when the request did not ask for a length. */
const DEFAULT_CLIP_SEC = 5;

/**
 * Editable length range per plan kind — the pacing rule, enforced in one place.
 *
 * AI clips are bounded by what the models offer: under ~3s there is not enough
 * footage for motion to read, and over ~10s no provider in the chain will
 * generate a single take. Slides are bounded by the encoder's own clamps.
 */
export function clipDurationBounds(
  source: VideoStoryboardSource,
): { minSec: number; maxSec: number } | null {
  if (source === "slide") return { minSec: MIN_SLIDE_SECONDS, maxSec: MAX_SLIDE_SECONDS };
  if (source === "character" || source === "prompt" || source === "photo") {
    return { minSec: 3, maxSec: 10 };
  }
  // "ai" is topic mode's b-roll: narration-timed, so it has no free timeline.
  return null;
}

/** Clamp one scene length into its plan's bounds. */
export function clampSceneDuration(storyboard: VideoStoryboard, durationSec: number): number {
  const bounds = storyboard.durationBounds ?? clipDurationBounds(storyboard.visualsSource);
  if (!bounds) return durationSec;
  if (!Number.isFinite(durationSec)) return bounds.minSec;
  return Math.min(bounds.maxSec, Math.max(bounds.minSec, Math.round(durationSec * 10) / 10));
}

/** How many shots a text_to_video job was funded for (1..MAX_CLIP_SHOTS). */
export function clipShotCount(shotCount: number | undefined): number {
  return Math.min(MAX_CLIP_SHOTS, Math.max(1, Math.trunc(shotCount ?? 1) || 1));
}

/** Which plan kind an engine produces, or null when it plans nothing editable. */
export function clipStoryboardSource(job: VideoGeneration): VideoStoryboardSource | null {
  if (job.engine === "text_to_video") {
    return job.options?.characterId ? "character" : "prompt";
  }
  if (job.engine === "image_to_video") return "photo";
  if (job.engine === "slideshow") return "slide";
  return null;
}

/** Total length of a plan: slides overlap by a crossfade, shots do not. */
export function clipStoryboardTotalSec(storyboard: VideoStoryboard): number {
  const secs = storyboard.scenes.map((scene) => scene.durationSec);
  if (storyboard.visualsSource === "slide") return slideshowTotalSec(secs);
  return secs.reduce((sum, sec) => sum + sec, 0);
}

/**
 * Split a brief into an ordered shot list. One LLM call, only when more than one
 * shot was asked for — a single shot is the brief itself.
 *
 * Fail-soft: if the split fails, every shot starts from the brief. The user paid
 * for those shots, so losing the job over a copywriting call would be the wrong
 * trade — and the storyboard they are about to edit is exactly where a repeated
 * prompt gets fixed.
 */
async function splitBriefIntoShots(
  tenantId: number,
  brief: string,
  shotCount: number,
): Promise<string[]> {
  if (shotCount <= 1) return [brief];
  const fallback = new Array(shotCount).fill(brief);
  const tenant = (
    await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId)).limit(1)
  )[0];
  if (!tenant) throw new VideoGenProviderError("Tenant not found.");
  try {
    const textGen = await getTextGenClient(tenant.aiModel);
    // Prompt Template Kit: this split is the "script" step of a clip
    // storyboard, so a production video_script template replaces the built-in
    // system prompt. Background job: no per-user customization. Fail-open.
    const governed = await getGovernedPrompt({
      flowKey: "video_script",
      tenantId,
      clerkUserId: "",
      customizationId: null,
      runtimeContext: `Task: split one video brief into ${shotCount} consecutive shots for a short social video (no narration, no on-screen text).`,
      outputFormat: `Respond with ONLY a JSON object of this exact shape: {"shots": ["...", "..."]} with exactly ${shotCount} strings.`,
      placeholderValues: { topic: brief.slice(0, 2000), paragraphCount: String(shotCount) },
    });
    const startedAt = Date.now();
    const completion = await textGen.client.chat.completions.create({
      model: textGen.model,
      messages: [
        {
          role: "system",
          content: governed
            ? governed.text
            : "You are a shot planner for short social videos. You reply with strict JSON only.",
        },
        {
          role: "user",
          content:
            `Break this video brief into exactly ${shotCount} consecutive shots that ` +
            "play as one cinematic piece.\n\n" +
            `Brief: ${brief.slice(0, 2000)}\n\n` +
            "Direct it like a brand film: give the sequence a narrative arc — open on " +
            "an evocative hook, build through distinct beats, land on a payoff — and " +
            "vary the coverage across shots (wide establishing, medium, intimate " +
            "close-up or macro detail) so the cut has rhythm. Each shot is one " +
            "continuous camera take of a few seconds, generated independently, so " +
            "describe it self-containedly and concretely: subject, action, framing, " +
            "one slow camera move (e.g. glide, push-in, rise), quality of light " +
            "(e.g. golden hour, shafts of sunlight, dusk glow) and mood or " +
            "atmosphere. Favor tactile, sensory detail over abstract adjectives. " +
            "Keep the same subject, wardrobe, location and visual style across " +
            "every shot so they cut together as one video. " +
            "No camera-cut instructions, no dialogue, no on-screen text.\n\n" +
            `Reply as {"shots": ["...", "..."]} with exactly ${shotCount} strings.`,
        },
      ],
      max_completion_tokens: 2048,
      response_format: { type: "json_object" },
      ...usageAccountingParams(textGen.provider),
    });
    await logGovernedTrace(governed, {
      tenantId,
      flowKey: "video_script",
      generationContext: { model: textGen.model, shotCount },
      startedAt,
      usage: completion.usage,
    });
    const parsed: unknown = JSON.parse(completion.choices[0]?.message?.content ?? "");
    const shots = (parsed as { shots?: unknown }).shots;
    if (!Array.isArray(shots)) return fallback;
    const cleaned = shots
      .map((shot) => (typeof shot === "string" ? shot.trim().slice(0, 1000) : ""))
      .filter((shot) => shot.length > 0);
    if (cleaned.length === 0) return fallback;
    // Pad a short reply from the brief and drop a long one, so the shot list
    // always matches the count the job was funded for.
    return Array.from({ length: shotCount }, (_, i) => cleaned[i] ?? brief);
  } catch (err) {
    logger.warn({ err, tenantId }, "Shot split failed; every shot starts from the brief");
    return fallback;
  }
}

/** Best-effort governed-prompt trace: a logging hiccup must never fail (or
 * downgrade) the planning call it describes. */
async function logGovernedTrace(
  governed: GovernedPrompt | null,
  input: {
    tenantId: number;
    flowKey: "video_script" | "video_scene_image";
    generationContext: Record<string, unknown>;
    startedAt: number;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
  },
): Promise<void> {
  if (!governed) return;
  try {
    await logCompiledPrompt({
      tenantId: input.tenantId,
      flowKey: input.flowKey,
      governed,
      generationContext: input.generationContext,
      success: true,
      latencyMs: Date.now() - input.startedAt,
      tokenUsage: input.usage
        ? {
            promptTokens: input.usage.prompt_tokens ?? 0,
            completionTokens: input.usage.completion_tokens ?? 0,
            totalTokens: input.usage.total_tokens ?? 0,
          }
        : null,
    });
  } catch (err) {
    logger.warn({ err, tenantId: input.tenantId }, "Compiled prompt logging failed; continuing");
  }
}

/**
 * The "art direction" step of a prompt-source clip storyboard: after the user
 * approves (or declines to review) the shot scripts, one video_scene_image
 * governed LLM call turns each approved script into a polished generation
 * prompt.
 *
 * Fail-soft per the storyboard contract: the user already approved these
 * texts, so if the polish call fails, the approved text itself is the prompt.
 * Character shots never come here — their approved keyframe IS the visual,
 * and rewriting the prompt after approval would break what-you-approve-is-
 * what-renders.
 */
async function refineShotVisuals(
  tenantId: number,
  shots: string[],
): Promise<string[]> {
  if (shots.length === 0) return shots;
  try {
    const tenant = (
      await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId)).limit(1)
    )[0];
    if (!tenant) return shots;
    return await refineScenePrompts({
      tenantAiModel: tenant.aiModel,
      tenantId,
      prompts: shots,
    });
  } catch (err) {
    logger.warn({ err, tenantId }, "Shot prompt polish failed; using the approved texts as-is");
    return shots;
  }
}

/**
 * Fill in `renderVisual` on a "prompt" plan's scenes, once. The polish result
 * is persisted by the caller so retries of the same approved plan always
 * render from the SAME prompts — the polish must never make an approved
 * storyboard non-deterministic.
 *
 * Returns true when any scene changed (i.e. the caller should persist).
 */
export async function polishStoryboardPrompts(
  tenantId: number,
  storyboard: VideoStoryboard,
): Promise<boolean> {
  if (storyboard.visualsSource !== "prompt") return false;
  const pending = storyboard.scenes.filter((scene) => scene.renderVisual == null);
  if (pending.length === 0) return false;
  const polished = await refineShotVisuals(
    tenantId,
    pending.map((scene) => scene.visual),
  );
  pending.forEach((scene, i) => {
    scene.renderVisual = polished[i] ?? scene.visual;
  });
  return true;
}

export interface ClipStoryboardPlanParams {
  job: VideoGeneration;
  source: VideoStoryboardSource;
  aspectRatio: VideoAspect;
  /** Reads a tenant photo back for keyframing; unused by slide/photo plans. */
  upload: (bytes: Buffer, contentType: string) => Promise<string>;
  onStage?: (stage: string) => void;
}

/** Plan a non-topic video and stop, before anything expensive runs. */
export async function planClipStoryboard(
  params: ClipStoryboardPlanParams,
): Promise<VideoStoryboard> {
  const { job, source, aspectRatio } = params;
  const options = job.options ?? { aspectRatio };
  const bounds = clipDurationBounds(source)!;
  const clamp = (sec: number): number =>
    Math.min(bounds.maxSec, Math.max(bounds.minSec, sec));

  // Photos are the plan for the two engines the user supplied images for. Their
  // previews cost nothing: they are the very paths that were uploaded.
  if (source === "photo" || source === "slide") {
    const paths = job.sourceImagePaths ?? [];
    if (paths.length === 0) {
      throw new VideoGenProviderError(
        source === "photo" ? "No source image provided." : "No photos provided.",
      );
    }
    const used = source === "photo" ? paths.slice(0, 1) : paths.slice(0, MAX_SLIDESHOW_IMAGES);
    const perScene =
      source === "photo"
        ? clamp(options.durationSec ?? DEFAULT_CLIP_SEC)
        : clamp(options.slideDurationSec ?? 3);
    return {
      version: 1,
      visualsSource: source,
      timelineLocked: false,
      durationBounds: bounds,
      model: null,
      provider: null,
      regenerations: 0,
      narration: null,
      scenes: used.map((path, i) => ({
        id: `s${i + 1}`,
        text: "",
        // A slide's caption starts empty; the whole-video overlayText, if the
        // request set one, keeps captioning the whole video until a slide
        // caption replaces it.
        visual: source === "photo" ? (job.prompt ?? "").trim() : "",
        durationSec: perScene,
        previewPath: path,
        outfitId: null,
      })),
    };
  }

  // text_to_video: split the brief, then (with a character locked) draw the
  // keyframe each shot will be animated from.
  const brief = (job.prompt ?? "").trim();
  if (!brief) throw new VideoGenProviderError("A prompt is required.");
  const shotCount = clipShotCount(options.shotCount);
  const perScene = clamp(options.durationSec ?? DEFAULT_CLIP_SEC);
  params.onStage?.(shotCount > 1 ? "Planning your shots" : "Planning your shot");
  const visuals = await splitBriefIntoShots(job.tenantId, brief, shotCount);

  if (source === "prompt") {
    return {
      version: 1,
      visualsSource: "prompt",
      timelineLocked: false,
      durationBounds: bounds,
      model: null,
      provider: null,
      regenerations: 0,
      narration: null,
      scenes: visuals.map((visual, i) => ({
        id: `s${i + 1}`,
        text: "",
        visual,
        durationSec: perScene,
        previewPath: null,
        outfitId: null,
      })),
    };
  }

  // Character-locked shots: one identity-anchored keyframe each, from the SAME
  // outfit reference, so the person and their clothes carry across every shot
  // without the user having to ask for it.
  const detail = await getCharacterDetail(job.tenantId, options.characterId ?? 0);
  if (!detail) throw new VideoGenProviderError("The selected character no longer exists.");
  const outfit = resolveOutfit(detail, options.outfitId ?? null);
  if (!outfit) throw new VideoGenProviderError("The selected outfit no longer exists.");
  const reference = await loadReferenceImage(outfit.referenceImagePath, job.tenantId);
  params.onStage?.("Drawing your shots");
  const previewPaths: (string | null)[] = [];
  for (const visual of visuals) {
    // Best-effort per shot: a missing still leaves that card blank and the
    // render regenerates it, rather than losing the whole plan to one failure.
    try {
      const keyframe = await generateSceneKeyframe(
        detail.character,
        outfit,
        visual,
        aspectRatio,
        reference,
      );
      previewPaths.push(await params.upload(keyframe.buffer, "image/png"));
    } catch (err) {
      logger.warn({ err, jobId: job.id }, "Storyboard keyframe failed; leaving the shot blank");
      previewPaths.push(null);
    }
  }
  return {
    version: 1,
    visualsSource: "character",
    timelineLocked: false,
    durationBounds: bounds,
    model: null,
    provider: null,
    regenerations: 0,
    narration: null,
    scenes: visuals.map((visual, i) => ({
      id: `s${i + 1}`,
      text: "",
      visual,
      durationSec: perScene,
      previewPath: previewPaths[i] ?? null,
      outfitId: outfit.id,
    })),
  };
}

export interface ClipStoryboardRenderParams {
  job: VideoGeneration;
  storyboard: VideoStoryboard;
  aspectRatio: VideoAspect;
  music?: Buffer | null;
  /** Reads photos and keyframes back out of tenant storage. */
  load: (objectPath: string) => Promise<{ buffer: Buffer; mimeType: string }>;
  onStage?: (stage: string) => void;
}

/** Render an approved non-topic storyboard. */
export async function renderClipStoryboard(params: ClipStoryboardRenderParams): Promise<{
  buffer: Buffer;
  provider: string | null;
  model: string | null;
  totalSec: number;
}> {
  const { storyboard, aspectRatio } = params;
  const scenes = storyboard.scenes;
  if (scenes.length === 0) {
    throw new VideoGenProviderError("This storyboard has no scenes.");
  }
  // Lengths are re-clamped at render: a plan stored before the bounds existed,
  // or one whose bounds moved since, still renders inside what ffmpeg and the
  // providers accept.
  const durations = scenes.map((scene) => clampSceneDuration(storyboard, scene.durationSec));

  if (storyboard.visualsSource === "slide") {
    params.onStage?.("Preparing your photos");
    const images: Buffer[] = [];
    for (const scene of scenes) {
      if (!scene.previewPath) {
        throw new VideoGenProviderError("A photo in this storyboard is missing.");
      }
      images.push((await params.load(scene.previewPath)).buffer);
    }
    params.onStage?.("Composing the slideshow");
    const buffer = await renderSlideshow({
      images,
      aspectRatio,
      slideDurationSec: durations[0]!,
      slideDurationsSec: durations,
      slideCaptions: scenes.map((scene) => scene.visual),
      music: params.music ?? null,
    });
    return { buffer, provider: null, model: null, totalSec: slideshowTotalSec(durations) };
  }

  // One AI clip per shot. Every clip is normalized to the same frame spec and
  // held to its planned length before they are joined, so the cuts land where
  // the storyboard said they would.
  let photo: SourceImage | null = null;
  if (storyboard.visualsSource === "photo") {
    const path = scenes[0]?.previewPath;
    if (!path) throw new VideoGenProviderError("No source image provided.");
    const loaded = await params.load(path);
    // Pad (never crop) the photo into the requested frame, so the animation
    // model composes for that shape and the subject's face survives intact.
    photo = await fitImageToAspect(
      { buffer: loaded.buffer, mimeType: loaded.mimeType },
      aspectRatio,
    );
  }

  // The picked catalog model, resolved once for the whole board: every shot
  // in a video renders on the same model, at the same resolution.
  const modelOptions = resolveModelOptions(params.job.options, 5);
  const clips: Buffer[] = [];
  let provider: string | null = null;
  let model: string | null = null;
  for (const [i, scene] of scenes.entries()) {
    const shotLabel = scenes.length > 1 ? ` ${i + 1} of ${scenes.length}` : "";
    let image = photo;
    if (storyboard.visualsSource === "character") {
      params.onStage?.(`Filming shot${shotLabel}`);
      // The approved keyframe IS the first frame, which is what makes editing
      // free. Missing means the plan's still failed to generate, not that a
      // different frame may be substituted — those jobs fail and refund.
      if (!scene.previewPath) {
        throw new VideoGenProviderError(
          "Some storyboard images are no longer available. Please start a new video.",
        );
      }
      const loaded = await params.load(scene.previewPath);
      image = { buffer: loaded.buffer, mimeType: loaded.mimeType };
    } else {
      params.onStage?.(`Generating shot${shotLabel}`);
    }
    // Per-shot camera move: the scene's own preset wins, then the job's, then
    // the built-in instruction. This is the payoff of having a storyboard at
    // all — shot 1 can crash zoom while shot 2 holds locked off.
    const motionPreset = scene.motionPreset ?? params.job.options?.motionPreset ?? null;
    const seed = scene.seed ?? params.job.options?.seed ?? null;
    const promptPlanText = scene.renderVisual ?? scene.visual;
    const promptPlanMotion = motionPresetClause(motionPreset);
    const result = await generateVideo({
      mode: image ? "image" : "text",
      prompt:
        storyboard.visualsSource === "character"
          ? `${scene.visual}. ${await getMotionInstruction(motionPreset)}`
          : // "prompt" plans render the persisted post-approval polish when one
            // was written (see polishStoryboardPrompts); otherwise the approved
            // text itself. A picked camera move is appended; without one the
            // prompt is byte-identical to what it always was.
            promptPlanMotion
            ? `${promptPlanText}\n\n${promptPlanMotion}`
            : promptPlanText,
      aspectRatio,
      seed,
      ...(image ? { image } : {}),
      ...modelOptions,
      // Shot lengths come from the approved storyboard, which the duration
      // bounds already held to what the renderer can deliver — so the board
      // wins over the model's generic snap here.
      durationSec: durations[i]!,
    });
    provider = result.provider;
    model = result.model;
    clips.push(
      await enforceClipDuration(
        await normalizeVideo(result.buffer, aspectRatio, modelOptions.resolution),
        durations[i]!,
      ),
    );
  }

  if (clips.length > 1) params.onStage?.("Joining your shots");
  let buffer = await concatClips(clips);
  if (params.music) buffer = await mixMusicIntoVideo(buffer, params.music);
  return {
    buffer,
    provider,
    model,
    totalSec: durations.reduce((sum, sec) => sum + sec, 0),
  };
}

/** The scene shape the studio edits, re-exported so callers need one import. */
export type { VideoStoryboardScene };
