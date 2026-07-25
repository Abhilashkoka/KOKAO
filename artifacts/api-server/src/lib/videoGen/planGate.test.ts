import { describe, it, expect } from "vitest";
import {
  scoreSlideshowRisk,
  checkDeliveryPromise,
  verifyScenePacing,
  resplitLongHolds,
  gateRenderPlan,
  LONG_HOLD_SEC,
  MAX_SECONDS_PER_CUT_STILLS,
  MAX_SECONDS_PER_CUT_FOOTAGE,
  BLOCK_RISK,
  type PlanGateInput,
} from "./planGate";
import type { SceneSegment } from "./topicVideo/compose";

const scenes = (spec: [number, number][]): SceneSegment[] =>
  spec.map(([clipIndex, durationSec]) => ({ clipIndex, durationSec }));

const plan = (over: Partial<PlanGateInput> = {}): PlanGateInput => ({
  scenes: scenes([
    [0, 3],
    [1, 3],
    [2, 3],
    [3, 3],
  ]),
  clipCount: 4,
  stillImagery: false,
  cueStartsSec: [0, 3, 6, 9],
  totalDurationSec: 12,
  subtitles: true,
  ...over,
});

const totalSceneSec = (list: SceneSegment[]): number =>
  Math.round(list.reduce((total, scene) => total + scene.durationSec, 0) * 1000) / 1000;

describe("scoreSlideshowRisk", () => {
  it("scores a varied, well-cut video at zero", () => {
    const risk = scoreSlideshowRisk(plan());
    expect(risk.score).toBe(0);
    expect(risk.reasons).toEqual([]);
  });

  it("scores one still held over the whole narration at the maximum", () => {
    const risk = scoreSlideshowRisk(
      plan({
        scenes: scenes([
          [0, 12],
          [0, 12],
          [0, 12],
          [0, 12],
        ]),
        clipCount: 1,
        stillImagery: true,
        totalDurationSec: 48,
      }),
    );
    expect(risk.score).toBe(1);
    // Worst contribution first, so a log line leads with the real problem.
    expect(risk.reasons[0]).toContain("held shot");
    expect(risk.reasons).toHaveLength(5);
  });

  it("charges for repeated visuals even when every cut is short", () => {
    const risk = scoreSlideshowRisk(
      plan({
        scenes: scenes([
          [0, 3],
          [0, 3],
          [0, 3],
          [0, 3],
        ]),
        clipCount: 1,
      }),
    );
    // Repetition (0.25) + one-visual poverty (0.2) + caption reliance (0.1).
    expect(risk.score).toBe(0.55);
    expect(risk.reasons).toContain("only 1 distinct visual across the video");
  });

  it("stops charging for poverty once there are four distinct visuals", () => {
    const three = scoreSlideshowRisk(
      plan({ scenes: scenes([[0, 3], [1, 3], [2, 3]]), clipCount: 3, cueStartsSec: [0, 3, 6] }),
    );
    // 3 distinct -> a third of the poverty weight; 4 distinct -> none.
    expect(three.score).toBe(0.067);
    expect(scoreSlideshowRisk(plan()).score).toBe(0);
  });

  it("does not blame captions when the picture is doing its job", () => {
    const risk = scoreSlideshowRisk(plan({ subtitles: true }));
    expect(risk.reasons).not.toContain(
      "captions are carrying a video with almost no visual change",
    );
  });

  it("scores an empty plan as harmless rather than dividing by nothing", () => {
    expect(scoreSlideshowRisk(plan({ scenes: [] }))).toEqual({ score: 0, reasons: [] });
  });
});

describe("checkDeliveryPromise", () => {
  it("holds stills to a stricter cut rate than footage", () => {
    const layout = scenes([
      [0, 6],
      [1, 6],
      [2, 6],
      [3, 6],
    ]);
    const stills = checkDeliveryPromise(
      plan({ scenes: layout, stillImagery: true, totalDurationSec: 24 }),
    );
    const footage = checkDeliveryPromise(
      plan({ scenes: layout, stillImagery: false, totalDurationSec: 24 }),
    );
    // Identical cut rate, different verdict: a Ken Burns push is not motion.
    expect(stills.secondsPerCut).toBe(6);
    expect(footage.secondsPerCut).toBe(6);
    expect(stills.ok).toBe(false);
    expect(stills.allowedSecondsPerCut).toBe(MAX_SECONDS_PER_CUT_STILLS);
    expect(footage.ok).toBe(true);
    expect(footage.allowedSecondsPerCut).toBe(MAX_SECONDS_PER_CUT_FOOTAGE);
    expect(stills.reason).toContain("every 6s");
    expect(footage.reason).toBeNull();
  });

  it("measures the cut rate from planned scene time, not the narration field", () => {
    const promise = checkDeliveryPromise(
      plan({ scenes: scenes([[0, 20], [1, 20]]), totalDurationSec: 4 }),
    );
    expect(promise.secondsPerCut).toBe(20);
    expect(promise.ok).toBe(false);
  });

  it("treats an empty plan as one long hold instead of crashing", () => {
    const promise = checkDeliveryPromise(plan({ scenes: [], totalDurationSec: 30 }));
    expect(promise.secondsPerCut).toBe(30);
    expect(promise.ok).toBe(false);
  });
});

describe("verifyScenePacing", () => {
  it("flags a visual that has to carry too many spoken sentences", () => {
    const pacing = verifyScenePacing(
      plan({
        scenes: scenes([
          [0, 10],
          [1, 10],
        ]),
        cueStartsSec: [0, 2, 4, 6, 8, 12],
        totalDurationSec: 20,
      }),
    );
    expect(pacing.ok).toBe(false);
    expect(pacing.worstCuesPerScene).toBe(5);
    expect(pacing.reason).toContain("5 spoken sentences");
  });

  it("passes when sentences are spread across the cuts", () => {
    const pacing = verifyScenePacing(
      plan({
        scenes: scenes([
          [0, 10],
          [1, 10],
        ]),
        cueStartsSec: [0, 5, 12],
        totalDurationSec: 20,
      }),
    );
    expect(pacing).toEqual({ ok: true, worstCuesPerScene: 2, reason: null });
  });

  it("keeps trailing narration inside the last scene rather than losing it", () => {
    const pacing = verifyScenePacing(
      plan({
        scenes: scenes([
          [0, 5],
          [1, 5],
        ]),
        // 9.5s starts inside the last scene; 40s is past the planned end but
        // still belongs to it — a dropped cue would understate the problem.
        cueStartsSec: [0, 6, 9.5, 40],
        totalDurationSec: 10,
      }),
    );
    expect(pacing.worstCuesPerScene).toBe(3);
  });

  it("says nothing about pacing with no narration to pace against", () => {
    expect(verifyScenePacing(plan({ cueStartsSec: [] })).ok).toBe(true);
    expect(verifyScenePacing(plan({ scenes: [] })).worstCuesPerScene).toBe(0);
  });
});

describe("resplitLongHolds", () => {
  it("splits a held shot into cuts that rotate through the other clips", () => {
    const out = resplitLongHolds(scenes([[0, 20]]), 3);
    expect(out.map((s) => s.clipIndex)).toEqual([0, 1, 2]);
    // Scene time is preserved exactly, so the composition still lines up.
    expect(totalSceneSec(out)).toBe(20);
  });

  it("keeps the ranked pick on the first piece", () => {
    const out = resplitLongHolds(scenes([[2, 18]]), 4);
    expect(out[0]!.clipIndex).toBe(2);
    expect(out.map((s) => s.clipIndex)).toEqual([2, 3, 0]);
  });

  it("leaves short scenes untouched and returns the same array", () => {
    const layout = scenes([
      [0, 4],
      [1, LONG_HOLD_SEC],
    ]);
    expect(resplitLongHolds(layout, 3)).toBe(layout);
  });

  it("does not split when there is nothing to cut to", () => {
    const layout = scenes([[0, 40]]);
    // One clip means every "cut" would land on the same picture.
    expect(resplitLongHolds(layout, 1)).toBe(layout);
    expect(resplitLongHolds(layout, 3, 0)).toBe(layout);
  });

  it("preserves total scene time across a mixed layout", () => {
    const layout = scenes([
      [0, 3.4],
      [1, 21.7],
      [2, 9.1],
    ]);
    expect(totalSceneSec(resplitLongHolds(layout, 3))).toBe(totalSceneSec(layout));
  });
});

describe("gateRenderPlan", () => {
  it("passes a healthy plan through untouched and silently", () => {
    const result = gateRenderPlan(plan());
    expect(result.blocked).toBeNull();
    expect(result.warnings).toEqual([]);
    expect(result.revised).toBe(false);
    expect(result.risk).toBe(0);
  });

  it("repairs a held shot instead of complaining about it", () => {
    const result = gateRenderPlan(
      plan({
        scenes: scenes([
          [0, 20],
          [1, 4],
        ]),
        clipCount: 3,
        cueStartsSec: [0, 20],
        totalDurationSec: 24,
      }),
    );
    expect(result.scenes).toHaveLength(4);
    expect(result.revised).toBe(true);
    expect(totalSceneSec(result.scenes)).toBe(24);
    // Repaired below every threshold, so the job log stays quiet.
    expect(result.warnings).toEqual([]);
    expect(result.blocked).toBeNull();
  });

  it("scores the layout the composer will render, not the raw one", () => {
    // Adjacent repeats are fixed by the composer's diversifier, so the gate
    // must not charge repetition for a problem that is already handled.
    const result = gateRenderPlan(
      plan({
        scenes: scenes([
          [0, 3],
          [0, 3],
          [1, 3],
          [1, 3],
        ]),
        clipCount: 4,
      }),
    );
    expect(result.risk).toBe(0);
    expect(result.revised).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("reports the cut rate it could not repair all the way down", () => {
    const result = gateRenderPlan(
      plan({
        scenes: scenes([
          [0, 12],
          [1, 12],
        ]),
        clipCount: 2,
        stillImagery: true,
        cueStartsSec: [0, 4, 8, 12, 16, 20],
        totalDurationSec: 24,
      }),
    );
    expect(result.blocked).toBeNull();
    // Repaired from 12s holds to 6s ones — better, but stills owe a cut every
    // 5s, so the shortfall is logged instead of silently accepted.
    expect(result.scenes.length).toBeGreaterThan(2);
    expect(result.warnings.join(" ")).toContain("the picture changes every 6s");
    expect(result.risk).toBeGreaterThan(0);
    expect(result.risk).toBeLessThan(BLOCK_RISK);
  });

  it("warns about slideshow risk when there is nothing left to repair", () => {
    const result = gateRenderPlan(
      plan({
        scenes: scenes([
          [0, 3],
          [0, 3],
          [0, 3],
          [0, 3],
        ]),
        clipCount: 1,
        stillImagery: true,
      }),
    );
    // Cuts are fast enough and no hold is long, so only the repetition,
    // one-visual poverty, stillness and caption reliance score.
    expect(result.blocked).toBeNull();
    expect(result.risk).toBe(0.7);
    expect(result.warnings.join(" ")).toContain("slideshow risk 0.7");
    expect(result.revised).toBe(false);
  });

  it("refuses one still held over the whole narration", () => {
    const result = gateRenderPlan(
      plan({
        scenes: scenes([
          [0, 12],
          [0, 12],
          [0, 12],
          [0, 12],
        ]),
        clipCount: 1,
        stillImagery: true,
        cueStartsSec: [0, 4, 8, 12, 16, 20, 24, 28],
        totalDurationSec: 48,
      }),
    );
    expect(result.risk).toBeGreaterThanOrEqual(BLOCK_RISK);
    expect(result.blocked).toContain("not worth publishing");
    expect(result.blocked).toContain("You were not charged");
    // Nothing could be repaired with a single clip, so the layout is unchanged.
    expect(result.revised).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("never invents or loses scene time, whatever it decides", () => {
    for (const clipCount of [1, 2, 5]) {
      for (const stillImagery of [true, false]) {
        const layout = scenes([
          [0, 17.3],
          [1 % clipCount, 2.4],
          [0, 30],
        ]);
        const result = gateRenderPlan(
          plan({ scenes: layout, clipCount, stillImagery, totalDurationSec: 49.7 }),
        );
        expect(totalSceneSec(result.scenes)).toBe(49.7);
      }
    }
  });
});
