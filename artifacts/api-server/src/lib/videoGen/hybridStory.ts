import type { HybridStoryBeatKind, HybridStoryBeatPattern } from "@workspace/db";
import { VideoGenProviderError } from "./types";

export type HybridStoryboardBeatType = "character_speaking" | "story_animation";

export interface HybridStoryboardBeat {
  id: string;
  type: HybridStoryboardBeatType;
  role: HybridStoryBeatKind;
  patternIndex: number;
  text: string;
  visual: string;
  startSec: number;
  endSec: number;
}

/**
 * Deterministically assign every narration sentence to exactly one portable
 * hybrid role. This deliberately operates on text before providers are called,
 * so the approved plan can be snapshotted and replayed without a model deciding
 * different speaking boundaries on a retry.
 */
export function planHybridStoryBeats(args: {
  pattern: HybridStoryBeatPattern[];
  sentences: string[];
  secondsPerSentence?: number;
}): HybridStoryboardBeat[] {
  const sentences = args.sentences.map((sentence) => sentence.trim()).filter(Boolean);
  if (!sentences.length) throw new VideoGenProviderError("A hybrid story needs spoken script text.");
  if (args.pattern.length < 3) throw new VideoGenProviderError("Hybrid beat pattern is incomplete.");
  const animationIndexes = args.pattern
    .map((beat, index) => beat.kind === "story_animation" ? index : -1)
    .filter((index) => index >= 0);
  if (!animationIndexes.length) throw new VideoGenProviderError("Hybrid story needs an animation beat.");
  // Opening/closing retain one line each. Spread the rest, in source order,
  // across all interior roles, ensuring neither dropped nor duplicated text.
  const assignments = args.pattern.map(() => [] as string[]);
  assignments[0]!.push(sentences[0]!);
  if (sentences.length > 1) assignments[args.pattern.length - 1]!.push(sentences.at(-1)!);
  const interior = sentences.slice(1, -1);
  const interiorTargets = args.pattern
    .map((_, index) => index)
    .filter((index) => index > 0 && index < args.pattern.length - 1);
  const requiredTargets = interiorTargets.filter(
    (index) => args.pattern[index]?.kind === "story_animation",
  );
  // A short script can omit interludes, never an animation role. Seed every
  // mandatory animation before distributing surplus to optional interludes.
  interior.forEach((sentence, index) => {
    const target =
      index < requiredTargets.length
        ? requiredTargets[index]!
        : interiorTargets[(index - requiredTargets.length) % interiorTargets.length]!;
    assignments[target]!.push(sentence);
  });

  let cursor = 0;
  const secondsPerSentence = args.secondsPerSentence ?? 3;
  return args.pattern.map((role, index) => {
    const text = assignments[index]!.join(" ");
    // Empty optional interludes are omitted; opening/closing are never empty.
    if (!text && role.kind === "character_interlude") return null;
    if (!text) throw new VideoGenProviderError(`Hybrid ${role.kind} has no assigned narration.`);
    const estimated = Math.max(1, assignments[index]!.length * secondsPerSentence);
    const duration = Math.min(role.maxDurationSeconds, estimated);
    const beat: HybridStoryboardBeat = {
      id: `h${index + 1}`,
      type: role.kind === "story_animation" ? "story_animation" : "character_speaking",
      role: role.kind,
      patternIndex: index,
      text,
      visual: role.kind === "story_animation" ? text : "Locked character speaking directly to camera.",
      startSec: cursor,
      endSec: cursor + duration,
    };
    cursor = beat.endSec;
    return beat;
  }).filter((beat): beat is HybridStoryboardBeat => beat !== null);
}

/** Reject a persisted board before rendering rather than silently reordering it. */
export function assertHybridStoryBeatPlan(beats: HybridStoryboardBeat[]): void {
  if (beats.length < 3 || beats[0]?.role !== "character_opening" ||
    beats.at(-1)?.role !== "character_closing") {
    throw new VideoGenProviderError("Hybrid stories must begin and end with a character speaking beat.");
  }
  let end = 0;
  for (const beat of beats) {
    if (beat.startSec !== end || beat.endSec <= beat.startSec || !beat.text.trim()) {
      throw new VideoGenProviderError("Hybrid narration beats must be contiguous and non-empty.");
    }
    if (beat.type === "story_animation" && beat.role !== "story_animation") {
      throw new VideoGenProviderError("Hybrid beat role and render type disagree.");
    }
    end = beat.endSec;
  }
}