import type { SceneSegment } from "./topicVideo/compose";
import { diversifySceneClips } from "./topicVideo/compose";

/**
 * Pre-render plan gate: the scene layout is scored BEFORE the expensive encode,
 * so a video that would land as an "animated PowerPoint" is either repaired or
 * refused rather than delivered.
 *
 * The post-render QA gate (qaGate.ts) catches broken output — black picture,
 * silent audio, truncated encode. It cannot catch boring, because boring
 * encodes perfectly. That judgement has to happen on the plan, which is the
 * only place the cut rhythm is still cheap to change.
 *
 * Ideas here come from OpenMontage's slideshow-risk and delivery-promise gates
 * (AGPLv3 — read for the concepts, no code, prompts, or thresholds copied).
 * Every dimension below is scored off data this pipeline actually has: scene
 * durations, distinct source clips, narration cue starts, and whether the
 * visuals are moving footage or stills under a Ken Burns move.
 *
 * The order of preference is repair, then warn, then refuse. Refusing costs the
 * tenant their script and narration spend (refunded through the normal failure
 * path), so it is reserved for plans no amount of recutting can save.
 */

/** A scene holding longer than this reads as a frozen frame, not a shot. */
export const LONG_HOLD_SEC = 8;
/**
 * Average seconds per cut the plan must beat. Stills are held to the stricter
 * number on purpose: a Ken Burns push is not motion, so a still has to be
 * replaced more often than footage to carry the same energy.
 */
export const MAX_SECONDS_PER_CUT_STILLS = 5;
export const MAX_SECONDS_PER_CUT_FOOTAGE = 9;
/** One visual spanning more than this many narrated sentences is a dead frame. */
export const MAX_CUES_PER_SCENE = 4;
/** Risk at or above this cannot be recut into a watchable video. */
export const BLOCK_RISK = 0.85;

export interface PlanGateInput {
  /** Planned scenes, in order. */
  scenes: SceneSegment[];
  /** Number of distinct source clips available to the plan. */
  clipCount: number;
  /** True when the sources are generated stills animated with Ken Burns. */
  stillImagery: boolean;
  /** Narration sentence start times, for the pacing check. */
  cueStartsSec: number[];
  totalDurationSec: number;
  subtitles: boolean;
}

export interface SlideshowRisk {
  /** 0 (varied, well-cut) to 1 (one still held over the whole narration). */
  score: number;
  /** Human-readable contributions, worst first. Empty when nothing scored. */
  reasons: string[];
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Total planned scene time, falling back to the narration length. */
function plannedDurationSec(input: PlanGateInput): number {
  const summed = input.scenes.reduce((total, scene) => total + Math.max(scene.durationSec, 0), 0);
  if (summed > 0) return summed;
  return Math.max(input.totalDurationSec, 0);
}

function distinctClips(scenes: SceneSegment[]): number {
  return new Set(scenes.map((scene) => scene.clipIndex)).size;
}

/**
 * Score how much the plan resembles a slideshow rather than an edited video.
 * Five weighted dimensions, each 0..1, summing to at most 1.
 */
export function scoreSlideshowRisk(input: PlanGateInput): SlideshowRisk {
  const scenes = input.scenes;
  if (scenes.length === 0) return { score: 0, reasons: [] };
  const totalSec = plannedDurationSec(input);
  const distinct = distinctClips(scenes);

  // 1) Back-to-back repeats of the same source.
  let repeats = 0;
  for (let i = 1; i < scenes.length; i++) {
    if (scenes[i]!.clipIndex === scenes[i - 1]!.clipIndex) repeats++;
  }
  const repetition = scenes.length > 1 ? repeats / (scenes.length - 1) : 0;

  // 2) Too few distinct visuals to build an edit from. Four is the point at
  // which cuts stop feeling like the same picture coming back.
  const poverty = clamp01(1 - (distinct - 1) / 3);

  // 3) Share of the runtime spent inside a single held shot.
  const heldSec = scenes
    .filter((scene) => scene.durationSec > LONG_HOLD_SEC)
    .reduce((total, scene) => total + scene.durationSec, 0);
  const longHold = totalSec > 0 ? clamp01(heldSec / totalSec) : 0;

  // 4) Stills carry less on their own than footage does.
  const stillness = input.stillImagery ? 1 : 0;

  // 5) Captions doing the work the picture should be doing.
  const captionReliance = input.subtitles && distinct <= 2 ? 1 : 0;

  const weighted: [number, number, string][] = [
    [repetition, 0.25, `${repeats} of ${scenes.length - 1} cuts repeat the previous visual`],
    [poverty, 0.2, `only ${distinct} distinct visual${distinct === 1 ? "" : "s"} across the video`],
    [longHold, 0.3, `${Math.round(longHold * 100)}% of the runtime sits in one held shot`],
    [stillness, 0.15, "visuals are stills under a Ken Burns move, not moving footage"],
    [captionReliance, 0.1, "captions are carrying a video with almost no visual change"],
  ];
  const score = clamp01(
    weighted.reduce((total, [value, weight]) => total + clamp01(value) * weight, 0),
  );
  const reasons = weighted
    .filter(([value]) => value > 0)
    .sort((a, b) => b[0] * b[1] - a[0] * a[1])
    .map(([, , reason]) => reason);
  return { score: Math.round(score * 1000) / 1000, reasons };
}

export interface DeliveryPromise {
  ok: boolean;
  /** Average seconds the picture holds between cuts. */
  secondsPerCut: number;
  /** The ceiling this plan had to beat. */
  allowedSecondsPerCut: number;
  reason: string | null;
}

/**
 * The motion contract: whatever the engine, the picture has to change often
 * enough for the format. Stills get the stricter ceiling because their movement
 * is synthetic.
 */
export function checkDeliveryPromise(input: PlanGateInput): DeliveryPromise {
  const allowed = input.stillImagery ? MAX_SECONDS_PER_CUT_STILLS : MAX_SECONDS_PER_CUT_FOOTAGE;
  const cuts = Math.max(1, input.scenes.length);
  const totalSec = plannedDurationSec(input);
  const secondsPerCut = Math.round((totalSec / cuts) * 100) / 100;
  const ok = secondsPerCut <= allowed;
  return {
    ok,
    secondsPerCut,
    allowedSecondsPerCut: allowed,
    reason: ok
      ? null
      : `the picture changes every ${secondsPerCut}s; this format needs a cut at least every ${allowed}s`,
  };
}

export interface ScenePacing {
  ok: boolean;
  /** The most narrated sentences any single visual has to cover. */
  worstCuesPerScene: number;
  reason: string | null;
}

/**
 * Narration-pacing verifier: no single visual should have to carry more than a
 * handful of spoken sentences. Counts how many narration cue starts land inside
 * each scene window.
 */
export function verifyScenePacing(input: PlanGateInput): ScenePacing {
  const starts = input.cueStartsSec.filter((start) => Number.isFinite(start));
  if (input.scenes.length === 0 || starts.length === 0) {
    return { ok: true, worstCuesPerScene: 0, reason: null };
  }
  let worst = 0;
  let elapsed = 0;
  for (let i = 0; i < input.scenes.length; i++) {
    const scene = input.scenes[i]!;
    const start = elapsed;
    elapsed += Math.max(scene.durationSec, 0);
    const isLast = i === input.scenes.length - 1;
    // Cue starts inside [start, end); the final scene keeps the tail.
    const inScene = starts.filter((cue) => cue >= start && (isLast || cue < elapsed)).length;
    if (inScene > worst) worst = inScene;
  }
  const ok = worst <= MAX_CUES_PER_SCENE;
  return {
    ok,
    worstCuesPerScene: worst,
    reason: ok ? null : `one visual has to cover ${worst} spoken sentences without changing`,
  };
}

/**
 * Repair pass: split any scene held longer than `maxHoldSec` into equal cuts,
 * rotating through the other available clips so the split actually shows
 * something new. Scene time is preserved exactly, so the composition still
 * lines up with the narration track.
 *
 * A no-op — returning the same array — when there is nothing to split or only
 * one clip to split between (cutting to the same picture is not a cut).
 */
export function resplitLongHolds(
  scenes: SceneSegment[],
  clipCount: number,
  maxHoldSec: number = LONG_HOLD_SEC,
): SceneSegment[] {
  if (clipCount <= 1 || maxHoldSec <= 0) return scenes;
  if (!scenes.some((scene) => scene.durationSec > maxHoldSec)) return scenes;
  const out: SceneSegment[] = [];
  for (const scene of scenes) {
    if (scene.durationSec <= maxHoldSec) {
      out.push({ ...scene });
      continue;
    }
    const parts = Math.ceil(scene.durationSec / maxHoldSec);
    const piece = Math.round((scene.durationSec / parts) * 1000) / 1000;
    for (let p = 0; p < parts; p++) {
      out.push({
        // Rotate forward from this scene's own clip so the first piece keeps
        // the ranked pick and later pieces bring in something else.
        clipIndex: (scene.clipIndex + p) % clipCount,
        // The last piece absorbs the rounding remainder, so the summed scene
        // time still equals what the narration expects.
        durationSec:
          p === parts - 1
            ? Math.round((scene.durationSec - piece * (parts - 1)) * 1000) / 1000
            : piece,
      });
    }
  }
  return out;
}

export interface PlanGateResult {
  /** The scene layout to render — repaired when a repair was possible. */
  scenes: SceneSegment[];
  /** True when the gate changed the layout. */
  revised: boolean;
  risk: number;
  /** Everything the gate noticed, for the job log. */
  warnings: string[];
  /** User-facing failure message when the plan cannot be saved; else null. */
  blocked: string | null;
}

/**
 * Run the gate over a planned scene layout. Repairs first, scores what is left,
 * and only refuses a plan that recutting cannot rescue.
 */
export function gateRenderPlan(input: PlanGateInput): PlanGateResult {
  const original = input.scenes;
  // Score the plan the composer will actually render: it diversifies adjacent
  // repeats itself, so scoring the raw layout would flag a fixed problem.
  let scenes = diversifySceneClips(original, input.clipCount);
  const repaired = resplitLongHolds(scenes, input.clipCount);
  if (repaired !== scenes) {
    scenes = diversifySceneClips(repaired, input.clipCount);
  }

  const gated: PlanGateInput = { ...input, scenes };
  const risk = scoreSlideshowRisk(gated);
  const promise = checkDeliveryPromise(gated);
  const pacing = verifyScenePacing(gated);

  const warnings: string[] = [];
  if (!promise.ok && promise.reason) warnings.push(promise.reason);
  if (!pacing.ok && pacing.reason) warnings.push(pacing.reason);
  if (risk.score >= 0.5) {
    warnings.push(`slideshow risk ${risk.score}: ${risk.reasons.slice(0, 3).join("; ")}`);
  }

  const blocked =
    risk.score >= BLOCK_RISK
      ? "This video came out as one repeated still held over the whole narration, which is not worth publishing. You were not charged — try a longer topic, more paragraphs, or stock footage."
      : null;

  return {
    scenes,
    revised: scenes.length !== original.length || scenes.some((s, i) => s.clipIndex !== original[i]?.clipIndex),
    risk: risk.score,
    warnings,
    blocked,
  };
}
