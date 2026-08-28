import type { VideoJobOptions } from "@workspace/db";
import { CHARACTER_SCENES_PER_PARAGRAPH } from "./topicVideo/characterScenes";
import { clipShotCount } from "./clipStoryboard";
import { videoModelMultiplier } from "./modelCatalog";

export function hybridNarrationIsAggregateOwned(
  mode: "aggregate" | "unmetered" | "independently_settled" | undefined,
): boolean {
  return mode === "aggregate";
}

/** Product/quota ownership is broader than paid provider-event ownership:
 * managed unmetered TTS still consumes the one narration unit, while cloned
 * voice settles outside the video reservation. */
export function hybridNarrationConsumesVideoUnit(
  mode: "aggregate" | "unmetered" | "independently_settled" | undefined,
): boolean {
  return mode !== "independently_settled";
}

export function remainingHybridUnits(args: {
  requiredUnits: number;
  completedVisualOperations: number;
  completedNarrationUnit: boolean;
  completedMusic: boolean;
  modelId?: string | null;
}): number {
  return Math.max(
    0,
    Math.trunc(args.requiredUnits) -
      Math.max(0, Math.trunc(args.completedVisualOperations)) *
        videoModelMultiplier(args.modelId) -
      (args.completedNarrationUnit ? 1 : 0) -
      (args.completedMusic ? 1 : 0),
  );
}

export function hybridRequiredUnits(args: {
  options: VideoJobOptions;
  beatKinds?: Array<"character_speaking" | "story_animation">;
  narrationAccountingMode?: "aggregate" | "unmetered" | "independently_settled";
  /** Recompute from the immutable board instead of a previously frozen total. */
  ignoreFrozen?: boolean;
}): number {
  const frozen = args.options.storyboardFunding?.requiredUnits;
  if (!args.ignoreFrozen && frozen != null) return Math.max(0, Math.trunc(frozen));
  const operations = args.beatKinds
    ? args.beatKinds.reduce((sum, kind) => sum + (kind === "story_animation" ? 2 : 3), 0)
    : (args.options.hybridStory?.pattern ?? []).reduce(
        (sum, beat) => sum + (beat.kind === "story_animation" ? 2 : 3),
        0,
      );
  const narrationUnits = hybridNarrationConsumesVideoUnit(args.narrationAccountingMode) ? 1 : 0;
  return narrationUnits + operations * videoModelMultiplier(args.options.modelId) +
    (!args.options.musicPath && args.options.musicPrompt?.trim() ? 1 : 0);
}

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
  if (options?.recovery?.fundedUnits != null) {
    return Math.max(0, Math.trunc(options.recovery.fundedUnits));
  }
  if (engine === "dialogue_lip_sync" && options?.characterDialogue?.retry?.fundedUnits != null) {
    return Math.max(0, Math.trunc(options.characterDialogue.retry.fundedUnits));
  }
  if (engine === "topic_to_video" && options?.hybridStory && options.storyboardFunding) {
    // Current-attempt settlement/refund follows the amount actually held.
    // Chain-level recovery uses videoJobFullUnits and its frozen required total.
    return Math.max(0, Math.trunc(options.storyboardFunding.fundedUnits));
  }
  return videoJobFullUnits(engine, options);
}

/**
 * Full chain-level provider operation budget derived from the immutable job
 * inputs. Unlike videoJobUnits, this deliberately ignores recovery funding:
 * fundedUnits is only the reservation for one recovery attempt, not the
 * original operation count from which durable checkpoints are deducted.
 */
export function videoJobFullUnits(engine: string, options: VideoJobOptions | null): number {
  if (engine === "topic_to_video" && options?.hybridStory) {
    // One shared TTS track plus animation (keyframe + I2V) or speaking
    // (identity keyframe + plate + lip-sync) for each retained pattern beat.
    return hybridRequiredUnits({ options });
  }
  // Native template topic jobs deliberately begin with one planning unit. Once
  // their board is persisted this frozen total is the source of truth for all
  // settlement/refund/serialization paths.
  if (engine === "topic_to_video" && options?.storyboardFunding) {
    return Math.max(0, Math.trunc(options.storyboardFunding.fundedUnits));
  }
  let units = 1;
  if (engine === "dialogue_lip_sync") {
    // This is two paid provider operations: generate the AI presenter plate,
    // then run that plate and the narration through LatentSync.
    units = options?.characterDialogue ? options.characterDialogue.scenes.length * 2 : 2;
    if (
      options?.presenterBroll &&
      (options.visualsSource === "ai" || options.visualsSource === "ai_video")
    ) {
      units += options.presenterBroll.beats.length;
    }
  } else if (engine === "text_to_video") {
    // Shot count is fixed at enqueue precisely because it prices the job; the
    // storyboard editor can reword a shot but never add or remove one.
    units = clipShotCount(options?.shotCount);
  } else if (engine === "topic_to_video" && options?.visualsSource === "character") {
    const paragraphs = Math.min(Math.max(Math.trunc(options.paragraphCount ?? 1) || 1, 1), 3);
    units = options.templateRuntime?.maxSceneCount ??
      CHARACTER_SCENES_PER_PARAGRAPH * paragraphs;
  } else if (
    engine === "topic_to_video" &&
    options?.presenterVideoPath &&
    (options.visualsSource === "ai" || options.visualsSource === "ai_video")
  ) {
    // Presenter timelines are planned BEFORE funding. One persisted beat is
    // one generated B-roll image; ai_video adds local Ken Burns motion, not a
    // second provider call. The same count is therefore used by reservation,
    // success metering and every refund path.
    units = Math.max(1, options.presenterBroll?.beats.length ?? 1);
  } else if (engine === "topic_to_video" && options?.visualsSource === "ai") {
    // AI b-roll: every scene is a generated image (no image-to-video calls),
    // so it prices at half the character rate: Short = 2, Medium = 4, Long = 6.
    const paragraphs = Math.min(Math.max(Math.trunc(options.paragraphCount ?? 1) || 1, 1), 3);
    units = options.templateRuntime?.maxSceneCount ?? 2 * paragraphs;
  } else if (engine === "topic_to_video" && options?.visualsSource === "ai_video") {
    // Animated AI b-roll: generated images PLUS an image-to-video call per
    // scene, but no character keyframe editing — so it sits between b-roll
    // and character: Short = 3, Medium = 6, Long = 9.
    const paragraphs = Math.min(Math.max(Math.trunc(options.paragraphCount ?? 1) || 1, 1), 3);
    units = options.templateRuntime
      ? options.templateRuntime.maxSceneCount * 2
      : 3 * paragraphs;
  }
  // Scenes added during storyboard review are extra generations on the job's
  // own model, funded at insert time; counting them inside the multiplier
  // below keeps every price recomputation (usage on success, refunds on
  // failure/discard) in sync with what the insert route actually reserved.
  units += Math.max(0, Math.trunc(options?.addedScenes ?? 0));
  // A picked model prices itself: a premium model is four generations' worth
  // of provider spend for one clip, so it costs four units. This multiplies
  // the GENERATION count, not the job — a 4-shot premium clip is 16 units,
  // because it really is sixteen premium generations' worth of spend.
  //
  // A job with no picked model multiplies by 1, so every existing job and
  // every job that leaves the model alone costs exactly what it always did.
  // Wallet workspaces are unaffected either way: they reserve an estimate and
  // settle at the real provider cost from the admin price catalog.
  units *= videoModelMultiplier(options?.modelId);
  // An AI-composed music bed is its own real generation: +1 unit, on any
  // engine, and it runs on MusicGen regardless of the video model — so it is
  // added AFTER the multiplier rather than being scaled by it.
  if (!options?.musicPath && options?.musicPrompt?.trim()) {
    units += 1;
  }
  return units;
}
