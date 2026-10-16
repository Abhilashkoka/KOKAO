import { describe, expect, it } from "vitest";
import { barAlignedSec, MAX_REEL_CLIPS } from "./clipStoryboard";
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
  });
});
