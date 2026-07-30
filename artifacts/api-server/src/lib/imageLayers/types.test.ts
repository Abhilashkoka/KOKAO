import { describe, it, expect } from "vitest";
import {
  MAX_PLANNED_LAYERS,
  canvasFor,
  normalizeLayerPlan,
  planUnits,
} from "./types";

/**
 * normalizeLayerPlan is a billing guard, not a formatter: the plan it returns
 * decides how many image generations the tenant is charged for, and it is
 * applied to a plan the CLIENT posts back. These cases are the ways a bad or
 * hostile plan could cost someone money.
 */

const size = "1024x1024" as const;

function plan(layers: unknown[], styleDna = "soft window light, 85mm, muted palette") {
  return { styleDna, layers };
}

const bg = { id: "bg", role: "background", z: 0, bbox: [0, 0, 1024, 1024], prompt: "pastel backdrop" };
const cup = { id: "cup", role: "object", z: 10, bbox: [100, 100, 500, 600], prompt: "ceramic cup" };

describe("normalizeLayerPlan", () => {
  it("accepts a well-formed plan and preserves layer order", () => {
    const out = normalizeLayerPlan(plan([cup, bg]), size);
    expect(out).not.toBeNull();
    expect(out!.layers.map((l) => l.id)).toEqual(["bg", "cup"]);
    expect(out!.layers[0].z).toBe(0);
    expect(out!.layers[1].z).toBe(10);
    expect(planUnits(out!)).toBe(2);
  });

  it("caps the layer count so a hand-edited plan cannot bill unbounded generations", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      ...cup,
      id: `obj_${i}`,
      z: i + 1,
    }));
    const out = normalizeLayerPlan(plan([bg, ...many]), size);
    expect(out!.layers).toHaveLength(MAX_PLANNED_LAYERS);
    expect(planUnits(out!)).toBe(MAX_PLANNED_LAYERS);
  });

  it("rejects a plan with no background rather than rendering a hole", () => {
    expect(normalizeLayerPlan(plan([cup, { ...cup, id: "two" }]), size)).toBeNull();
  });

  it("demotes extra backgrounds instead of paying for a covered-up render", () => {
    const out = normalizeLayerPlan(plan([bg, { ...bg, id: "bg2" }, cup]), size);
    expect(out!.layers.filter((l) => l.role === "background")).toHaveLength(1);
    expect(out!.layers.find((l) => l.id === "bg2")!.role).toBe("object");
  });

  it("puts the background at the bottom however the model ordered it", () => {
    const out = normalizeLayerPlan(plan([{ ...cup, z: 1 }, { ...bg, z: 99 }]), size);
    expect(out!.layers[0].role).toBe("background");
  });

  it("rejects a single-layer plan — there is nothing to separate", () => {
    expect(normalizeLayerPlan(plan([bg]), size)).toBeNull();
  });

  it("drops layers with no prompt", () => {
    const out = normalizeLayerPlan(plan([bg, cup, { ...cup, id: "empty", prompt: "  " }]), size);
    expect(out!.layers.map((l) => l.id)).toEqual(["bg", "cup"]);
  });

  it("clamps a bbox to the canvas and falls back to full canvas when degenerate", () => {
    const out = normalizeLayerPlan(
      plan([
        bg,
        { ...cup, id: "spill", bbox: [-500, -500, 99999, 99999] },
        { ...cup, id: "sliver", bbox: [10, 10, 12, 12] },
      ]),
      size,
    );
    expect(out!.layers.find((l) => l.id === "spill")!.bbox).toEqual([0, 0, 1024, 1024]);
    expect(out!.layers.find((l) => l.id === "sliver")!.bbox).toEqual([0, 0, 1024, 1024]);
  });

  it("de-duplicates ids so two layers cannot collide in the editor document", () => {
    const out = normalizeLayerPlan(plan([bg, cup, { ...cup }]), size);
    const ids = out!.layers.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("treats an unknown role as an object rather than trusting it", () => {
    const out = normalizeLayerPlan(plan([bg, { ...cup, role: "wormhole" }]), size);
    expect(out!.layers[1].role).toBe("object");
  });

  it("returns null for junk", () => {
    expect(normalizeLayerPlan(null, size)).toBeNull();
    expect(normalizeLayerPlan("nope", size)).toBeNull();
    expect(normalizeLayerPlan({ styleDna: "x" }, size)).toBeNull();
    expect(normalizeLayerPlan({ layers: "not-an-array" }, size)).toBeNull();
  });

  it("normalises the background bbox to the real canvas for non-square sizes", () => {
    const out = normalizeLayerPlan(plan([bg, cup]), "1536x1024");
    expect(canvasFor("1536x1024")).toEqual({ width: 1536, height: 1024 });
    expect(out!.layers[0].bbox).toEqual([0, 0, 1536, 1024]);
  });
});
