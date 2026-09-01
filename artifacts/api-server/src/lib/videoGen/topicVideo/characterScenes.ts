import type { Character, CharacterOutfit } from "@workspace/db";
import { getTextGenClient } from "../../textGen";
import { usageAccountingParams } from "../../aiCost";
import { getGovernedPrompt, logCompiledPrompt } from "../../promptKit";
import { generateSceneKeyframe, loadReferenceImage } from "../../characters";
import type { ImageGenResult } from "../../imageGen/types";
import { generateVideo } from "../index";
import { getMotionInstruction } from "../motionPrompt";
import type { ResolvedModelOptions } from "../modelCatalog";
import type { Cinematography } from "../cinematography";
import { trimClipToStart } from "../postprocess";
import { MIN_SYNC_HEIGHT } from "../lipSyncSource";
import { lipSyncClip } from "../lipSyncClip";
import { VideoGenProviderError, type VideoAspect } from "../types";
import { logger } from "../../logger";
import { sliceNarration, type NarrationCue } from "./narration";
import type { SceneSegment } from "./compose";
import { refineScenePrompts } from "./refineScenePrompts";
import { imageFingerprint, matchesPriorImage } from "./imageDistinctness";

/**
 * Character story scenes: instead of stock footage, every scene of a topic
 * video is generated with the tenant's locked character. Identity is anchored
 * per scene — outfit reference image → keyframe edit → image-to-video — so
 * the same character (and the same costume, unless the wardrobe plan changes
 * it) appears throughout.
 */

/** Scenes per script paragraph — also the billing rate for character videos. */
export const CHARACTER_SCENES_PER_PARAGRAPH = 4;
/** How many keyframe+animate pipelines run at once. */
const SCENE_CONCURRENCY = 3;
/** Providers accept short clips; scenes are trimmed/looped by the compositor. */
const SCENE_CLIP_CHOICES = [5, 8, 10] as const;

export interface ScriptScene {
  /** Cue index range (inclusive) this scene spans. */
  firstCue: number;
  lastCue: number;
  durationSec: number;
  text: string;
}

/**
 * Partition the narration cues into exactly `sceneCount` contiguous scenes
 * of roughly equal duration (fewer when there aren't enough cues).
 */
export function groupCuesIntoScenes(
  cues: NarrationCue[],
  totalDurationSec: number,
  sceneCount: number,
): ScriptScene[] {
  const count = Math.max(1, Math.min(sceneCount, cues.length));
  const cueEnds = cues.map((cue, i) =>
    i + 1 < cues.length ? cues[i + 1]!.startSec : totalDurationSec,
  );
  const scenes: ScriptScene[] = [];
  let firstCue = 0;
  for (let scene = 0; scene < count; scene++) {
    const idealBoundary = (totalDurationSec * (scene + 1)) / count;
    let lastCue = firstCue;
    // Extend while the next cue still ends before the ideal boundary, keeping
    // enough cues in reserve so every remaining scene gets at least one.
    while (
      lastCue + 1 < cues.length &&
      cues.length - (lastCue + 1) > count - scene - 1 &&
      cueEnds[lastCue]! < idealBoundary
    ) {
      lastCue++;
    }
    if (scene === count - 1) lastCue = cues.length - 1;
    const startSec = cues[firstCue]!.startSec;
    const endSec = cueEnds[lastCue]!;
    scenes.push({
      firstCue,
      lastCue,
      durationSec: Math.max(endSec - startSec, 0.2),
      text: cues
        .slice(firstCue, lastCue + 1)
        .map((c) => c.text)
        .join(" "),
    });
    firstCue = lastCue + 1;
  }
  return scenes;
}

/**
 * How tight a scene is framed. A structured field rather than something hoped
 * for inside the visual sentence: the sentence competes with camera movement,
 * light, texture and non-repetition instructions, and coverage is what loses.
 * Every shot in a real sample came back an extreme close-up despite the prompt
 * asking for variety.
 */
export type ShotSize = "wide" | "medium" | "close";

export const SHOT_SIZES: readonly ShotSize[] = ["wide", "medium", "close"];

export interface ScenePlanEntry {
  /** What the scene should show, written for image generation. */
  visual: string;
  /** The outfit worn in this scene (from the character's wardrobe). */
  outfitId: number;
  /** How tight the framing is. Never "wide" where the character speaks. */
  shotSize: ShotSize;
}

/**
 * Framing when the model gives none, rotated by scene index so a plan that
 * ignores the field still cuts between sizes instead of repeating one.
 *
 * Speaking scenes alternate medium and close only. A wide shot puts the face
 * at a fraction of frame height, and the lip-sync model crops around it — the
 * same face-pixel constraint that governs the upload path, arriving here as a
 * composition rule.
 */
export function normalizeShotSize(
  stored: unknown,
  index: number,
  speaking: boolean,
): ShotSize {
  const size = SHOT_SIZES.includes(stored as ShotSize)
    ? (stored as ShotSize)
    : defaultShotSize(index, speaking);
  // The face-pixel rule holds on replay too: a board approved before lip sync
  // was switched on can carry a wide shot into a job that now has to sync it.
  return speaking && size === "wide" ? "medium" : size;
}

export function defaultShotSize(index: number, speaking: boolean): ShotSize {
  if (speaking) return index % 2 === 0 ? "medium" : "close";
  // Non-speaking scenes can open wide; nothing has to read a mouth.
  return (["wide", "medium", "close", "medium"] as const)[index % 4]!;
}

/**
 * One LLM call plans every scene: a concrete visual description featuring the
 * character, plus which outfit they wear — honoring the locked default and
 * the user's wardrobe notes (costume changes at story moments).
 */
export async function planSceneVisuals(params: {
  tenantAiModel: string;
  topic: string;
  /** Enables the governed prompt (Prompt Template Kit) when provided. */
  tenantId?: number | null;
  character: Character;
  outfits: CharacterOutfit[];
  lockedOutfitId: number;
  wardrobeNotes: string;
  scenes: ScriptScene[];
  /** A saved/edited plan reused instead of asking the model (validated
   * upstream; the costume-lock clamp below still applies in full). */
  suppliedPlan?: unknown;
  /** Whether these scenes will be lip-synced; bans wide framing when true. */
  speaking?: boolean;
}): Promise<{ plan: ScenePlanEntry[]; rawPlan: unknown | null }> {
  const speaking = params.speaking === true;
  // Costume uniformity is the default. Unless the user wrote wardrobe
  // instructions, the character wears the locked outfit in every scene: the
  // rules below ask the director for that, and the clamp at the end of this
  // function enforces it whatever the model actually replies.
  const wardrobeNotes = params.wardrobeNotes.trim();
  const costumeLocked = wardrobeNotes === "";

  if (params.suppliedPlan != null) {
    // Reuse path: no LLM call. Unlike the live path this does NOT fail soft —
    // the user chose this exact plan, so an unusable one is an error, never a
    // silent fallback. The clamp below still enforces the costume lock and
    // wardrobe validity, so a hand-edited plan cannot change the rules.
    const parsed = params.suppliedPlan as { scenes?: unknown };
    if (!Array.isArray(parsed.scenes)) {
      throw new VideoGenProviderError(
        'The saved plan is missing its "scenes" list and cannot be reused.',
      );
    }
    return {
      plan: clampScenePlan({
        planned: parsed.scenes as {
          visual?: unknown;
          outfitId?: unknown;
          shotSize?: unknown;
        }[],
        scenes: params.scenes,
        costumeLocked,
        lockedOutfitId: params.lockedOutfitId,
        validIds: new Set(params.outfits.map((o) => o.id)),
        speaking,
      }),
      rawPlan: params.suppliedPlan,
    };
  }

  const textGen = await getTextGenClient(params.tenantAiModel);
  const wardrobe = params.outfits
    .map((o) => `- id ${o.id}: "${o.name}" — ${o.description}`)
    .join("\n");
  const sceneList = params.scenes
    .map((s, i) => `${i + 1}. ${s.text}`)
    .join("\n");
  // Coverage is a separate, enumerated field because as prose it lost every
  // time: the visual sentence already carries camera movement, light, texture
  // and a non-repetition rule, and a real sample came back as eight identical
  // extreme close-ups.
  const shotSizeRules = speaking
    ? `3. "shotSize" is "medium" or "close" — never "wide". The character speaks in every scene here and their mouth has to be large enough to read. Alternate the two; never use the same value for three scenes in a row.`
    : `3. "shotSize" is "wide", "medium" or "close". Open on a "wide" that establishes the place, then vary. Never use the same value for three scenes in a row.`;
  const outfitRules = costumeLocked
    ? `4. "outfitId" must be exactly ${params.lockedOutfitId} for every scene. The character wears one costume for the whole video — never change it, however much the story might suggest one.`
    : `4. "outfitId" must be one of the wardrobe ids. Default to ${params.lockedOutfitId} and change it only where the wardrobe instructions below explicitly call for a change.
5. Keep outfit changes rare and motivated; never alternate every scene.`;
  const prompt = `# Role: Video Scene Director

A short video features one recurring character. For every scene below, describe the single visual moment to generate, always featuring the character.

## Character:
${params.character.name}${params.character.description ? ` — ${params.character.description}` : ""}

## Wardrobe (outfit ids the character owns):
${wardrobe}

## Rules:
1. Return a JSON object: {"scenes": [{"visual": "...", "outfitId": <id>, "shotSize": "wide"|"medium"|"close"}, ...]} with exactly ${params.scenes.length} entries, in scene order.
2. "visual" is one vivid sentence describing what the character is doing and where, matching that scene's narration. Include one slow camera move (e.g. glide, push-in, rise), the quality and direction of light (e.g. golden-hour warmth, shafts of sunlight, diffused overcast), and a tactile detail or atmosphere (surface texture, dust in sunlight, reflections). Treat the list as an edit: consecutive scenes must differ in at least two of setting, action, shot scale, camera angle/movement, subject placement, and background geometry. Never repeat the same pose, activity, location, or composition in adjacent scenes. Do not mention the character's name or clothing, and do not describe the framing in this sentence — "shotSize" carries it.
${shotSizeRules}
${outfitRules}
${costumeLocked ? "" : `\n## Wardrobe instructions from the user:\n${wardrobeNotes}\n`}
## Scenes (narration):
${sceneList}`;

  // Prompt Template Kit: a production template for the video_scene_image flow
  // replaces the built-in system prompt (shared with b-roll planning — both
  // stages produce the visual description for every scene's still). Video
  // jobs run in the background with no per-user session (customizationId:
  // null). Fail-open: null keeps the built-in prompt exactly as before.
  let governed: Awaited<ReturnType<typeof getGovernedPrompt>> = null;
  try {
    governed = params.tenantId
      ? await getGovernedPrompt({
        flowKey: "video_scene_image",
        tenantId: params.tenantId,
        clerkUserId: "",
        customizationId: null,
        runtimeContext: `Video topic: ${params.topic}. Scene count: ${params.scenes.length}. The video features one recurring character.`,
        outputFormat:
          'Return a JSON object: {"scenes": [{"visual": "...", "outfitId": <id>}, ...]} with exactly one entry per scene, in scene order, following the wardrobe rules in the user message.',
        placeholderValues: {
          topic: params.topic,
          sceneCount: String(params.scenes.length),
        },
        })
      : null;
  } catch (error) {
    // Fail-open: a prompt-kit failure must never break video generation.
    logger.warn({ err: error }, "Governed scene prompt lookup failed; using built-in prompt");
    governed = null;
  }
  const startedAt = Date.now();
  const completion = await textGen.client.chat.completions.create({
    model: textGen.model,
    messages: [
      {
        role: "system",
        content: governed
          ? governed.text
          : "You plan video scenes and reply with strict JSON only.",
      },
      { role: "user", content: prompt },
    ],
    max_completion_tokens: 8192,
    response_format: { type: "json_object" },
    ...usageAccountingParams(textGen.provider),
  });
  if (governed && params.tenantId) {
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

  const validIds = new Set(params.outfits.map((o) => o.id));
  let planned: { visual?: unknown; outfitId?: unknown }[] = [];
  // The untouched AI reply, kept on the storyboard for audit.
  let rawPlan: unknown | null = null;
  try {
    const parsed = JSON.parse(completion.choices[0]?.message?.content ?? "");
    if (Array.isArray(parsed?.scenes)) {
      planned = parsed.scenes;
      rawPlan = parsed;
    }
  } catch {
    // fall through to defaults below
  }
  const plan = clampScenePlan({
    planned,
    scenes: params.scenes,
    costumeLocked,
    lockedOutfitId: params.lockedOutfitId,
    validIds,
    speaking,
  });
  const refinedVisuals = await refineScenePrompts({
    tenantAiModel: params.tenantAiModel,
    prompts: plan.map((entry) => entry.visual),
    tenantId: params.tenantId,
  });
  plan.forEach((entry, i) => {
    entry.visual = refinedVisuals[i] ?? entry.visual;
  });
  return { plan, rawPlan };
}

/**
 * The one rulebook for turning a scene plan (live AI reply or reused saved
 * plan) into effective scene entries. The enforcement half of the costume
 * lock lives here: with no wardrobe instructions the locked outfit wins
 * outright, so neither a model that ignores rule 3 nor a hand-edited plan can
 * change the character's clothes between scenes; with instructions, an outfit
 * outside the wardrobe still falls back to the locked one.
 */
function clampScenePlan(args: {
  planned: { visual?: unknown; outfitId?: unknown; shotSize?: unknown }[];
  scenes: ScriptScene[];
  costumeLocked: boolean;
  lockedOutfitId: number;
  validIds: Set<number>;
  /** Whether these scenes will be lip-synced; bans "wide" when they are. */
  speaking: boolean;
}): ScenePlanEntry[] {
  return args.scenes.map((scene, i) => {
    const entry = args.planned[i];
    const visual =
      typeof entry?.visual === "string" && entry.visual.trim()
        ? entry.visual.trim()
        : scene.text.slice(0, 300);
    const outfitId = args.costumeLocked
      ? args.lockedOutfitId
      : typeof entry?.outfitId === "number" && args.validIds.has(entry.outfitId)
        ? entry.outfitId
        : args.lockedOutfitId;
    // Framing is clamped rather than trusted, for the same reason the costume
    // lock is: the plan may be hand-edited or replayed from a saved job, and a
    // wide shot on a speaking scene produces a mouth too small to sync.
    const requested = SHOT_SIZES.includes(entry?.shotSize as ShotSize)
      ? (entry!.shotSize as ShotSize)
      : defaultShotSize(i, args.speaking);
    const shotSize: ShotSize =
      args.speaking && requested === "wide" ? "medium" : requested;
    return { visual, outfitId, shotSize };
  });
}

/** The provider clip length that covers a scene with the least excess. */
export function clipDurationForScene(sceneDurationSec: number): number {
  for (const choice of SCENE_CLIP_CHOICES) {
    if (sceneDurationSec <= choice) return choice;
  }
  return SCENE_CLIP_CHOICES[SCENE_CLIP_CHOICES.length - 1]!;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface CharacterSceneClips {
  clips: Buffer[];
  sceneMap: SceneSegment[];
  provider: string;
  model: string;
}

/**
 * The cheap half: one identity-locked keyframe per scene, from the outfit's
 * reference photo. These PNGs are also exactly what the storyboard shows as
 * its preview stills, so a reviewed job generates them once and animates the
 * approved ones — no image is ever paid for twice.
 */
export async function generateSceneKeyframes(params: {
  tenantId: number;
  character: Character;
  outfits: CharacterOutfit[];
  plan: ScenePlanEntry[];
  aspectRatio: VideoAspect;
  onProviderSuccess?: (args: { sceneIndex: number; attemptIndex: number; result: ImageGenResult }) => Promise<void>;
}): Promise<ImageGenResult[]> {
  const outfitsById = new Map(params.outfits.map((o) => [o.id, o]));
  // Load each worn outfit's reference once, not per scene.
  const references = new Map<number, Awaited<ReturnType<typeof loadReferenceImage>>>();
  for (const outfitId of new Set(params.plan.map((p) => p.outfitId))) {
    const outfit = outfitsById.get(outfitId);
    if (!outfit) throw new VideoGenProviderError("Scene plan references a missing outfit.");
    references.set(outfitId, await loadReferenceImage(outfit.referenceImagePath, params.tenantId));
  }
  const generateAt = async (entry: ScenePlanEntry, i: number, forceFresh = false) => {
    const outfit = outfitsById.get(entry.outfitId)!;
    const reference = references.get(entry.outfitId)!;
    const attempt = () =>
      generateSceneKeyframe(
        params.character,
        outfit,
        forceFresh
          ? `${entry.visual}\n\nFresh-shot requirement: keep the same character and outfit, but create a substantially different composition from all earlier storyboard frames. Change the pose, camera distance or angle, subject placement, and background geometry. Do not reproduce a prior image.`
          : entry.visual,
        params.aspectRatio,
        reference,
        entry.shotSize,
      );
    let result: ImageGenResult;
    try {
      result = await attempt();
    } catch (err) {
      logger.warn({ err, scene: i }, "character keyframe generation failed; retrying once");
      result = await attempt();
    }
    // Persistence/upload failures occur after acknowledged provider work and
    // must never be mistaken for a provider rejection eligible for a rerun.
    await params.onProviderSuccess?.({ sceneIndex: i, attemptIndex: forceFresh ? 1 : 0, result });
    return result;
  };
  const keyframes = await mapWithConcurrency(params.plan, params.onProviderSuccess ? 1 : SCENE_CONCURRENCY, (entry, i) =>
    generateAt(entry, i),
  );
  const fingerprints: Buffer[] = [];
  for (const [index, entry] of params.plan.entries()) {
    let keyframe = keyframes[index]!;
    let fingerprint = await imageFingerprint(keyframe.buffer);
    if (matchesPriorImage(fingerprint, fingerprints)) {
      logger.warn(
        { scene: index },
        "Character keyframe repeated an earlier shot; regenerating once",
      );
      keyframe = await generateAt(entry, index, true);
      fingerprint = await imageFingerprint(keyframe.buffer);
      if (matchesPriorImage(fingerprint, fingerprints)) {
        throw new VideoGenProviderError(
          `Scene ${index + 1} repeated an earlier generated image after a retry. No duplicate frame was used.`,
        );
      }
      keyframes[index] = keyframe;
    }
    fingerprints.push(fingerprint);
  }
  return keyframes;
}

/**
 * Voice the character actually speaks with, when the caller wants the scenes
 * lip-synced rather than narrated over.
 */
export interface SceneLipSync {
  /** The whole narration track; each shot receives only its own slice. */
  wav: Buffer;
}

/**
 * The expensive half: image-to-video per keyframe. Each scene retries once; a
 * scene that fails twice fails the job (the runner refunds the reservation).
 *
 * With `lipSync`, each shot is additionally cut to its exact scene length and
 * synced to that scene's slice of the narration — one speaker per shot, which
 * is the only arrangement the identity lock can hold anyway (the keyframe
 * prompt anchors one face; a second face in frame drifts). The sync runs
 * inside the same concurrency window as the animation, so a job's wall clock
 * grows by roughly one sync per scene divided by SCENE_CONCURRENCY, not by
 * one per scene.
 *
 * Shots that come back synced are flagged in the sceneMap. The compositor
 * needs that flag: without it, it will seek into, loop, swap or split the
 * footage, all of which desync the mouth without raising anything.
 */
export async function animateSceneKeyframes(params: {
  keyframes: Buffer[];
  plan: ScenePlanEntry[];
  scenes: ScriptScene[];
  aspectRatio: VideoAspect;
  /** Job-level camera-move preset; null = the governed default instruction. */
  motionPreset?: string | null;
  /** Job-level optics; null = nothing added to the prompt. */
  cinematography?: Cinematography | null;
  /** Job-level sampling seed; null = the provider's choice. */
  seed?: number | null;
  /** Picked catalog model and its resolved flags; omitted = platform default. */
  modelOptions?: ResolvedModelOptions;
  savedClips?: Array<Buffer | null>;
  onCheckpoint?: (args: { sceneIndex: number; buffer: Buffer; provider: string; model: string; durationSec: number }) => Promise<void>;
  lipSync?: SceneLipSync | null;
}): Promise<CharacterSceneClips> {
  let provider = "";
  let model = "";
  // Motion instruction resolved once per job rather than per scene: a picked
  // preset wins outright, else the governed Prompt Kit wording (fail-open).
  const motion = await getMotionInstruction(
    params.motionPreset,
    params.cinematography,
  );
  const lipSync = params.lipSync ?? null;
  const synced: boolean[] = new Array(params.scenes.length).fill(false);
  // Scenes tile the narration in order, so a scene's start is the sum of the
  // scenes before it. Derived here rather than read off cue indices: the
  // storyboard-resume path rebuilds ScriptScene with synthetic cue numbers,
  // and those would slice the wrong span.
  const sceneStartSec: number[] = [];
  params.scenes.reduce((elapsed, scene) => {
    sceneStartSec.push(elapsed);
    return elapsed + scene.durationSec;
  }, 0);
  const clips = await mapWithConcurrency(params.plan, SCENE_CONCURRENCY, async (entry, i) => {
    if (params.savedClips?.[i]) return params.savedClips[i]!;
    const keyframe = params.keyframes[i];
    if (!keyframe) throw new VideoGenProviderError("A scene is missing its keyframe image.");
    const scene = params.scenes[i]!;
    const durationSec = clipDurationForScene(scene.durationSec);
    const attempt = async (): Promise<Buffer> => {
      const clip = await generateVideo({
        mode: "image",
        prompt: `${entry.visual}. ${motion}`,
        aspectRatio: params.aspectRatio,
        seed: params.seed ?? null,
        image: { buffer: keyframe, mimeType: "image/png" },
        ...(params.modelOptions ?? {}),
        // Scene lengths come from the narration timing; the audio is already
        // recorded, so the model's own duration snap must not override it.
        durationSec,
      });
      provider = clip.provider;
      model = clip.model;
      await params.onCheckpoint?.({
        sceneIndex: i, buffer: clip.buffer, provider, model,
        durationSec: clip.effectiveDurationSec ?? durationSec,
      });
      return clip.buffer;
    };
    let clip: Buffer;
    try {
      clip = await attempt();
    } catch (err) {
      logger.warn({ err, scene: i }, "character scene animation failed; retrying once");
      clip = await attempt();
    }
    if (!lipSync) return clip;

    // The scene's own span of the track. Providers hand back discrete lengths,
    // so the clip is cut to the scene first: the model takes video and audio
    // as separate files and assumes they start together.
    const startSec = sceneStartSec[i] ?? 0;
    const audio = sliceNarration(lipSync.wav, startSec, startSec + scene.durationSec);
    // Same face-pixel floor the uploaded-source path enforces: the model works
    // on a small crop around the face, and a shot the video provider returned
    // at 480p starves it before it starts. Folded into the trim so the mouth
    // region takes one encode, not two.
    const trimmed = await trimClipToStart(clip, scene.durationSec, MIN_SYNC_HEIGHT);
    try {
      const result = await lipSyncClip({ video: trimmed, audio });
      synced[i] = true;
      return result.buffer;
    } catch (err) {
      // Fail-soft, and only here: the shot already exists and is already paid
      // for, so an unsynced shot beats failing the whole job. It ships without
      // the flag, so the compositor treats it as ordinary footage.
      logger.warn({ err, scene: i }, "scene lip sync failed; using the unsynced shot");
      return trimmed;
    }
  });

  return {
    clips,
    sceneMap: params.scenes.map((scene, i) => ({
      clipIndex: i,
      durationSec: scene.durationSec,
      ...(synced[i] ? { lipSynced: true } : {}),
    })),
    provider: provider || "replicate",
    model: model || "image-to-video",
  };
}

/**
 * Straight-through character scenes: outfit reference → identity-locked
 * keyframe → image-to-video, per scene. Used when the job is not paused for
 * storyboard review; a reviewed job calls the two halves either side of the
 * pause instead.
 */
export async function generateCharacterSceneClips(params: {
  tenantId: number;
  character: Character;
  outfits: CharacterOutfit[];
  plan: ScenePlanEntry[];
  scenes: ScriptScene[];
  aspectRatio: VideoAspect;
  /** Job-level camera-move preset; null = the governed default instruction. */
  motionPreset?: string | null;
  /** Job-level optics; null = nothing added to the prompt. */
  cinematography?: Cinematography | null;
  /** Job-level sampling seed; null = the provider's choice. */
  seed?: number | null;
  /** Picked catalog model and its resolved flags; omitted = platform default. */
  modelOptions?: ResolvedModelOptions;
  lipSync?: SceneLipSync | null;
}): Promise<CharacterSceneClips> {
  const keyframes = (await generateSceneKeyframes(params)).map((keyframe) => keyframe.buffer);
  return animateSceneKeyframes({
    keyframes,
    plan: params.plan,
    scenes: params.scenes,
    aspectRatio: params.aspectRatio,
    motionPreset: params.motionPreset ?? null,
    cinematography: params.cinematography ?? null,
    seed: params.seed ?? null,
    modelOptions: params.modelOptions,
    lipSync: params.lipSync ?? null,
  });
}
