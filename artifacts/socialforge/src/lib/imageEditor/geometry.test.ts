import { describe, it, expect } from "vitest";
import {
  alignOffsets,
  computeSnap,
  distributeOffsets,
  fitZoom,
  groupBounds,
  intrinsicSize,
  layerBounds,
  nextZoom,
  unionBoxes,
  zoomAboutPoint,
  type Box,
} from "./geometry";
import { makeGroupLayer, makeImageLayer, makeTextLayer, type Layer } from "./doc";

const CANVAS = { width: 1000, height: 800 };

function image(x: number, y: number, w: number, h: number): Layer {
  const layer = makeImageLayer("/o/a", w, h);
  layer.x = x;
  layer.y = y;
  return layer;
}

describe("layerBounds", () => {
  it("is the layer's own box when it is untransformed", () => {
    expect(layerBounds(image(10, 20, 100, 50))).toEqual({ x: 10, y: 20, width: 100, height: 50 });
  });

  it("accounts for scale", () => {
    const layer = image(0, 0, 100, 50);
    layer.scaleX = 2;
    layer.scaleY = 3;
    expect(layerBounds(layer)).toEqual({ x: 0, y: 0, width: 200, height: 150 });
  });

  it("grows the axis-aligned box when rotated", () => {
    const layer = image(0, 0, 100, 100);
    layer.rotation = 45;
    const box = layerBounds(layer);
    expect(box.width).toBeCloseTo(Math.sqrt(2) * 100, 5);
    expect(box.height).toBeCloseTo(Math.sqrt(2) * 100, 5);
  });

  it("is unchanged by a 360-degree rotation", () => {
    const layer = image(5, 5, 40, 20);
    layer.rotation = 360;
    const box = layerBounds(layer);
    expect(box.x).toBeCloseTo(5, 5);
    expect(box.width).toBeCloseTo(40, 5);
  });

  it("widens for a skew", () => {
    const straight = layerBounds(image(0, 0, 100, 100));
    const skewed = image(0, 0, 100, 100);
    skewed.skewX = 0.5;
    expect(layerBounds(skewed).width).toBeGreaterThan(straight.width);
  });

  it("estimates a text layer from its font metrics", () => {
    const text = makeTextLayer("two\nlines", 20);
    const size = intrinsicSize(text);
    expect(size.height).toBeCloseTo(2 * 20 * 1.2, 5);
    expect(size.width).toBeGreaterThan(0);
  });

  it("takes a group's box from its children", () => {
    const group = makeGroupLayer([image(10, 10, 20, 20), image(50, 30, 20, 20)]);
    expect(groupBounds(group)).toEqual({ x: 10, y: 10, width: 60, height: 40 });
    expect(groupBounds(makeGroupLayer([]))).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it("unions boxes, and treats an empty set as empty", () => {
    expect(unionBoxes([{ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 5, width: 10, height: 20 }])).toEqual({
      x: 0,
      y: 0,
      width: 30,
      height: 25,
    });
    expect(unionBoxes([])).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe("computeSnap", () => {
  const moving: Box = { x: 98, y: 200, width: 50, height: 50 };

  it("pulls an edge onto another layer's edge", () => {
    const other: Box = { x: 100, y: 400, width: 50, height: 50 };
    const snap = computeSnap(moving, [other], CANVAS, 6);
    expect(snap.dx).toBe(2);
    expect(snap.guides.some((g) => g.axis === "x" && g.position === 100)).toBe(true);
  });

  it("snaps to the canvas centre", () => {
    const snap = computeSnap({ x: 473, y: 10, width: 50, height: 50 }, [], CANVAS, 6);
    // The moving box's centre (498) is within 6px of the canvas centre (500).
    expect(snap.dx).toBe(2);
  });

  it("does nothing when everything is far away", () => {
    const snap = computeSnap({ x: 300, y: 300, width: 33, height: 33 }, [], CANVAS, 2);
    expect(snap).toEqual({ dx: 0, dy: 0, guides: [] });
  });

  it("prefers the nearest candidate on each axis", () => {
    const near: Box = { x: 99, y: 0, width: 10, height: 10 };
    const far: Box = { x: 94, y: 0, width: 10, height: 10 };
    expect(computeSnap(moving, [near, far], CANVAS, 6).dx).toBe(1);
  });
});

describe("alignOffsets", () => {
  it("aligns a single layer to the canvas", () => {
    const [offset] = alignOffsets([{ x: 100, y: 100, width: 200, height: 100 }], "left", CANVAS);
    expect(offset).toEqual({ dx: -100, dy: 0 });

    const [centred] = alignOffsets([{ x: 0, y: 0, width: 200, height: 100 }], "center-h", CANVAS);
    expect(centred.dx).toBe(400);
  });

  it("aligns several layers to their shared bounding box, not the canvas", () => {
    const boxes: Box[] = [
      { x: 100, y: 0, width: 50, height: 10 },
      { x: 300, y: 0, width: 50, height: 10 },
    ];
    const offsets = alignOffsets(boxes, "left", CANVAS);
    expect(offsets[0].dx).toBe(0);
    expect(offsets[1].dx).toBe(-200);
  });

  it("aligns to the bottom and the vertical centre", () => {
    const boxes: Box[] = [
      { x: 0, y: 0, width: 10, height: 20 },
      { x: 0, y: 100, width: 10, height: 40 },
    ];
    expect(alignOffsets(boxes, "bottom", CANVAS)[0].dy).toBe(120);
    expect(alignOffsets(boxes, "center-v", CANVAS)[1].dy).toBe(-50);
  });

  it("returns nothing for an empty selection", () => {
    expect(alignOffsets([], "left", CANVAS)).toEqual([]);
  });
});

describe("distributeOffsets", () => {
  it("spaces the interior boxes evenly and leaves the ends alone", () => {
    const boxes: Box[] = [
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 15, y: 0, width: 10, height: 10 },
      { x: 90, y: 0, width: 10, height: 10 },
    ];
    const offsets = distributeOffsets(boxes, "x");
    expect(offsets[0]).toEqual({ dx: 0, dy: 0 });
    expect(offsets[2]).toEqual({ dx: 0, dy: 0 });
    // Span 0..100, 30px of box, so 35px gaps: the middle box lands at 45.
    expect(offsets[1].dx).toBe(30);
  });

  it("needs three boxes to have an interior at all", () => {
    const boxes: Box[] = [
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 50, y: 0, width: 10, height: 10 },
    ];
    expect(distributeOffsets(boxes, "x")).toEqual([
      { dx: 0, dy: 0 },
      { dx: 0, dy: 0 },
    ]);
  });

  it("returns offsets in the caller's original order, not sorted order", () => {
    const boxes: Box[] = [
      { x: 90, y: 0, width: 10, height: 10 },
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 15, y: 0, width: 10, height: 10 },
    ];
    const offsets = distributeOffsets(boxes, "x");
    // Index 0 is the rightmost box, so it must not move.
    expect(offsets[0]).toEqual({ dx: 0, dy: 0 });
    expect(offsets[1]).toEqual({ dx: 0, dy: 0 });
    expect(offsets[2].dx).toBe(30);
  });
});

describe("viewport", () => {
  it("steps zoom through fixed stops and stops at the ends", () => {
    expect(nextZoom(1, 1)).toBe(1.5);
    expect(nextZoom(1, -1)).toBe(0.66);
    expect(nextZoom(16, 1)).toBe(16);
    expect(nextZoom(0.05, -1)).toBe(0.05);
    expect(nextZoom(0.9, 1)).toBe(1);
  });

  it("fits the document inside the viewport with padding", () => {
    const zoom = fitZoom({ width: 1000, height: 1000 }, { width: 600, height: 600 }, 50);
    expect(zoom).toBeCloseTo(0.5, 5);
    expect(fitZoom({ width: 10, height: 10 }, { width: 4000, height: 4000 })).toBeLessThanOrEqual(8);
  });

  it("never returns a zoom of zero for a tiny viewport", () => {
    expect(fitZoom({ width: 4000, height: 4000 }, { width: 10, height: 10 })).toBeGreaterThan(0);
  });

  it("keeps the point under the cursor fixed while zooming", () => {
    const offset = { x: 0, y: 0 };
    const pointer = { x: 200, y: 100 };
    const next = zoomAboutPoint(offset, 1, 2, pointer);
    // The document point under the cursor was (200,100); after doubling the
    // zoom, offset + world * zoom must still put it under the cursor.
    expect(next.x + 200 * 2).toBe(pointer.x);
    expect(next.y + 100 * 2).toBe(pointer.y);
  });

  it("keeps the anchor fixed when panned and zoomed out", () => {
    const next = zoomAboutPoint({ x: -120, y: 40 }, 2, 0.5, { x: 300, y: 220 });
    const world = { x: (300 - -120) / 2, y: (220 - 40) / 2 };
    expect(next.x + world.x * 0.5).toBeCloseTo(300, 10);
    expect(next.y + world.y * 0.5).toBeCloseTo(220, 10);
  });
});
