import { describe, it, expect } from "vitest";
import { OP_UNITS, planExpansion, type ImageOp } from "./ops";

/**
 * Pure arithmetic only. The operations themselves call the image provider and
 * object storage, which the route tests cover; what is worth pinning here is
 * the outpaint geometry, because every mistake in it is invisible until a user
 * has paid a credit to see the seam.
 */
describe("planExpansion", () => {
  const square = { width: 1024, height: 1024 };

  it("keeps a symmetric expansion square and centred", () => {
    const plan = planExpansion(square, { left: 200, right: 200, top: 200, bottom: 200 });
    expect(plan.canvas).toEqual({ width: 1024, height: 1024 });
    expect(plan.placement.left).toBe(plan.canvas.width - plan.placement.left - plan.placement.width);
    expect(plan.placement.top).toBe(plan.canvas.height - plan.placement.top - plan.placement.height);
  });

  it("chooses a landscape canvas when asked to widen", () => {
    const plan = planExpansion(square, { left: 400, right: 400, top: 0, bottom: 0 });
    expect(plan.canvas).toEqual({ width: 1536, height: 1024 });
  });

  it("chooses a portrait canvas when asked to grow vertically", () => {
    const plan = planExpansion(square, { left: 0, right: 0, top: 400, bottom: 400 });
    expect(plan.canvas).toEqual({ width: 1024, height: 1536 });
  });

  it("pushes the original to the far side when padding only one edge", () => {
    // Pad on the left only, and the picture must end up on the RIGHT — this is
    // the sign error that makes an outpaint extend the wrong way.
    const left = planExpansion(square, { left: 800, right: 0, top: 0, bottom: 0 });
    const right = planExpansion(square, { left: 0, right: 800, top: 0, bottom: 0 });

    expect(left.placement.left).toBeGreaterThan(right.placement.left);
    expect(right.placement.left).toBe(0);
    expect(left.placement.left + left.placement.width).toBe(left.canvas.width);
  });

  it("does the same vertically", () => {
    const top = planExpansion(square, { left: 0, right: 0, top: 600, bottom: 0 });
    const bottom = planExpansion(square, { left: 0, right: 0, top: 0, bottom: 600 });
    expect(bottom.placement.top).toBe(0);
    expect(top.placement.top + top.placement.height).toBe(top.canvas.height);
  });

  it("always keeps the original fully inside the canvas", () => {
    const cases = [
      { left: 2000, right: 0, top: 0, bottom: 0 },
      { left: 0, right: 0, top: 3000, bottom: 10 },
      { left: 50, right: 900, top: 900, bottom: 50 },
      { left: 1, right: 1, top: 1, bottom: 1 },
    ];
    for (const pad of cases) {
      const plan = planExpansion(square, pad);
      expect(plan.placement.left).toBeGreaterThanOrEqual(0);
      expect(plan.placement.top).toBeGreaterThanOrEqual(0);
      expect(plan.placement.left + plan.placement.width).toBeLessThanOrEqual(plan.canvas.width);
      expect(plan.placement.top + plan.placement.height).toBeLessThanOrEqual(plan.canvas.height);
      expect(plan.placement.width).toBeGreaterThan(0);
      expect(plan.placement.height).toBeGreaterThan(0);
    }
  });

  it("preserves the original's aspect ratio when it has to shrink to fit", () => {
    const plan = planExpansion(square, { left: 1000, right: 1000, top: 1000, bottom: 1000 });
    expect(plan.placement.width / plan.placement.height).toBeCloseTo(1, 2);
    expect(plan.placement.width).toBeLessThan(square.width);
  });

  it("never enlarges the original past its own size", () => {
    const plan = planExpansion({ width: 400, height: 400 }, { left: 10, right: 10, top: 10, bottom: 10 });
    expect(plan.placement.width).toBeLessThanOrEqual(400);
  });

  it("handles a non-square source", () => {
    const plan = planExpansion({ width: 1536, height: 1024 }, { left: 0, right: 0, top: 500, bottom: 500 });
    expect(plan.placement.left + plan.placement.width).toBeLessThanOrEqual(plan.canvas.width);
    expect(plan.placement.height).toBeGreaterThan(0);
  });

  it("ignores negative padding rather than inverting the placement", () => {
    const plan = planExpansion(square, { left: -500, right: 400, top: 0, bottom: 0 });
    expect(plan.placement.left).toBe(0);
  });
});

describe("OP_UNITS", () => {
  it("prices every operation, and only enlarge for free", () => {
    const ops: ImageOp[] = ["fill", "remove", "replace-background", "expand", "cutout", "enlarge"];
    for (const op of ops) {
      expect(OP_UNITS[op], `${op} must have a price`).toBeTypeOf("number");
      expect(OP_UNITS[op]).toBeGreaterThanOrEqual(0);
    }
    expect(OP_UNITS.enlarge).toBe(0);
    for (const op of ops.filter((o) => o !== "enlarge")) {
      // Everything that reaches the provider must reserve funding, or it is a
      // free call to a paid API.
      expect(OP_UNITS[op]).toBeGreaterThan(0);
    }
  });
});
