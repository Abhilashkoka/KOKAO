import { describe, expect, it } from "vitest";
import { assertHybridStoryBeatPlan, planHybridStoryBeats } from "./hybridStory";

describe("planHybridStoryBeats", () => {
  const pattern = [
    { kind: "character_opening", maxDurationSeconds: 12 },
    { kind: "story_animation", maxDurationSeconds: 20 },
    { kind: "character_interlude", maxDurationSeconds: 10 },
    { kind: "story_animation", maxDurationSeconds: 20 },
    { kind: "character_closing", maxDurationSeconds: 12 },
  ] as const;
  it("partitions every approved line once and preserves character bookends", () => {
    const lines = ["Open.", "First story.", "Second story.", "Close."];
    const beats = planHybridStoryBeats({ pattern: [...pattern], sentences: lines });
    expect(beats[0]?.role).toBe("character_opening");
    expect(beats.at(-1)?.role).toBe("character_closing");
    expect(beats.map((beat) => beat.patternIndex)).toEqual([0, 1, 3, 4]);
    expect(beats.flatMap((beat) => beat.text.match(/Open\.|First story\.|Second story\.|Close\./g) ?? []))
      .toEqual(lines);
    expect(() => assertHybridStoryBeatPlan(beats)).not.toThrow();
  });
});