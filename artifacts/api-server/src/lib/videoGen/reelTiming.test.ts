import { describe, expect, it } from "vitest";
import { barAlignedSec, MAX_REEL_CLIPS, REEL_MOVE_SETS, reelLookPrompt } from "./clipStoryboard";
import { videoJobUnits } from "./units";

describe("showcase reel timing and pricing", () => {
  it("cuts clips to whole bars of the track", () => {
    // 112 BPM: one 4-beat bar is about 2.14s.
    expect(barAlignedSec(5, 2.1428)).toBeCloseTo(4.2856, 3);
    expect(barAlignedSec(3, 2.1428)).toBeCloseTo(2.1428, 3);
    // Never longer than the clip, never less than one bar.
    expect(barAlignedSec(1.5, 2)).toBe(1.5);
    expect(barAlignedSec(5, null)).toBeNull();
    expect(barAlignedSec(5, 0)).toBeNull();
  });

  it("prices one unit per photo in a reel and one for a single animation", () => {
    expect(videoJobUnits("image_to_video", { aspectRatio: "9:16", photoClips: true, shotCount: 4 } as never)).toBe(4);
    expect(videoJobUnits("image_to_video", { aspectRatio: "9:16", shotCount: 4 } as never)).toBe(1);
    expect(MAX_REEL_CLIPS).toBe(6);
    // Hero reel: one AI clip, whatever the number of looks.
    expect(videoJobUnits("image_to_video", { aspectRatio: "9:16", photoClips: true, shotCount: 5, heroIndex: 0 } as never)).toBe(1);
  });

  it("gives men's wear its own moves, never a twirl or a hem lift", () => {
    const men = Array.from({ length: 6 }, (_, i) => reelLookPrompt("Walks", i, "man"));
    expect(men.every((p) => p.startsWith("Walks") && p.includes("He ") && p.includes("his full body"))).toBe(true);
    expect(men.some((p) => /twirl|hem|She /.test(p))).toBe(false);
    expect(new Set(men).size).toBe(6);
    expect(reelLookPrompt("", 0, "woman")).toContain("twirl");
    expect(reelLookPrompt("", 0)).toContain("her full body");
  });

  it("has six distinct moves for every model and kind of outfit", () => {
    for (const gender of ["woman", "man"] as const) {
      for (const wear of ["ethnic", "formal", "casual"] as const) {
        const moves = REEL_MOVE_SETS[gender][wear];
        expect(new Set(moves).size).toBe(6);
        expect(moves.every((m) => m.startsWith(gender === "man" ? "He " : "She "))).toBe(true);
      }
    }
    expect(reelLookPrompt("", 1, "man", "formal")).toContain("buttons his jacket");
    expect(reelLookPrompt("", 0, "man", "casual")).toContain("relaxed, easy stride");
    expect(REEL_MOVE_SETS.man.casual.some((m) => /namaste|cuff/.test(m))).toBe(false);
  });
});
