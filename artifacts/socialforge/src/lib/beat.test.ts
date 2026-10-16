import { describe, expect, it } from "vitest";
import { detectBeat, lookTiming, onsetEnvelope } from "./beat";

/** A synthetic click track: short bursts every beat, starting at `startSec`. */
function clickTrack(bpm: number, startSec: number, seconds = 20, rate = 22050): Float32Array {
  const out = new Float32Array(rate * seconds);
  const period = (60 / bpm) * rate;
  for (let t = startSec * rate; t < out.length; t += period) {
    const s = Math.round(t);
    for (let i = 0; i < 400 && s + i < out.length; i++) out[s + i] = Math.sin(i / 3) * (1 - i / 400);
  }
  return out;
}

describe("beat detection", () => {
  it.each([96, 112, 123])("finds the tempo of a %d BPM click track", (bpm) => {
    const rate = 22050;
    const beat = detectBeat(onsetEnvelope(clickTrack(bpm, 0.3, 20, rate)), 512 / rate);
    expect(beat).not.toBeNull();
    expect(Math.abs(beat!.bpm - bpm)).toBeLessThan(2);
    expect(beat!.barSec).toBeCloseTo((60 / bpm) * 4, 1);
  });

  it("finds where the first beat falls", () => {
    const rate = 22050;
    const beat = detectBeat(onsetEnvelope(clickTrack(120, 0.3, 20, rate)), 512 / rate)!;
    // Phase is modulo one beat (0.5s at 120 BPM).
    expect(Math.abs(beat.firstBeatSec - 0.3)).toBeLessThan(0.06);
  });

  it("gives up on silence", () => {
    expect(detectBeat(onsetEnvelope(new Float32Array(22050 * 5)), 512 / 22050)).toBeNull();
  });

  it("times each look to whole bars, asking the model for a whole-second clip", () => {
    const beat = { bpm: 112, barSec: 2.143, firstBeatSec: 0 };
    expect(lookTiming(beat, 2, "video")).toEqual({ onScreenSec: 4.286, clipSec: 5 });
    expect(lookTiming(beat, 1, "photo")).toEqual({ onScreenSec: 2.143, clipSec: 3 });
    expect(lookTiming(null, 2, "video")).toEqual({ onScreenSec: 5, clipSec: 5 });
  });
});
