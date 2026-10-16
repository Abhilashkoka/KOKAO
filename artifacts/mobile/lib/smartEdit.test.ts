import { describe, expect, it } from "vitest";
import { clampEditRange, editCanSubmit, regionFromPoints } from "./smartEdit";

describe("mobile Smart Edit selection", () => {
  it("enforces 1–12 seconds regardless of which edge is moved", () => {
    expect(clampEditRange(10, 10.2, 30, "start")).toEqual([10, 11]);
    expect(clampEditRange(0, 25, 30, "end")).toEqual([13, 25]);
    expect(clampEditRange(10, 30, 30, "start")).toEqual([10, 22]);
    expect(clampEditRange(-1, 1, 30, "start")).toEqual([0, 1]);
    expect(clampEditRange(29.9, 30, 30, "start")).toEqual([29, 30]);
    expect(clampEditRange(0, 0, 30, "end")).toEqual([0, 1]);
  });
  it("never rounds a selection beyond the actual media", () => {
    expect(clampEditRange(0, 8, 2.96, "end")).toEqual([0, 2.9]);
    expect(clampEditRange(0, 3, 0.9, "end")).toEqual([0, 0]);
  });
  it("normalizes touch regions in either direction and clamps off-frame motion", () => {
    expect(regionFromPoints([80, 160], [20, 40], 100, 200)).toEqual({
      x: 0.2, y: 0.2, width: expect.closeTo(0.6), height: expect.closeTo(0.6),
    });
    expect(regionFromPoints([-5, -2], [110, 210], 100, 200)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(regionFromPoints([20, 40], [20, 40], 100, 200)).toBeNull();
  });
  it("requires a region for removal and permission for dialogue", () => {
    const base = { type: "remove" as const, startSec: 0, endSec: 3 };
    expect(editCanSubmit(base, 30, false)).toBe(false);
    expect(editCanSubmit({ ...base, box: { x: 0, y: 0, width: 0.5, height: 0.5 } }, 30, false)).toBe(true);
    const dialogue = { ...base, type: "dialogue" as const, dialogueText: "New line" };
    expect(editCanSubmit(dialogue, 30, false)).toBe(false);
    expect(editCanSubmit(dialogue, 30, true)).toBe(true);
    expect(editCanSubmit({ ...dialogue, endSec: 13 }, 30, true)).toBe(false);
    expect(editCanSubmit({ ...dialogue, endSec: 31 }, 30, true)).toBe(false);
  });
});
