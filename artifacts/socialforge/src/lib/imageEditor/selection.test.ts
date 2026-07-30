import { describe, it, expect } from "vitest";
import {
  combineMasks,
  createMask,
  featherMask,
  invertMask,
  isEmptyMask,
  magicWand,
  maskBounds,
  maskFromRGBA,
  maskToRGBA,
  rasterizeEllipse,
  rasterizePolygon,
  rasterizeRect,
  resizeMask,
} from "./selection";

const count = (mask: Uint8Array) => mask.reduce((n, v) => (v > 0 ? n + 1 : n), 0);

describe("rasterizeRect", () => {
  it("fills exactly the requested pixels", () => {
    const mask = rasterizeRect({ x: 2, y: 2, width: 3, height: 4 }, 10, 10);
    expect(count(mask)).toBe(12);
    expect(mask[2 * 10 + 2]).toBe(255);
    expect(mask[1 * 10 + 2]).toBe(0);
  });

  it("handles a rectangle dragged up and to the left", () => {
    const forwards = rasterizeRect({ x: 2, y: 2, width: 3, height: 3 }, 10, 10);
    const backwards = rasterizeRect({ x: 5, y: 5, width: -3, height: -3 }, 10, 10);
    expect(Array.from(backwards)).toEqual(Array.from(forwards));
  });

  it("clips to the canvas instead of writing out of bounds", () => {
    const mask = rasterizeRect({ x: -5, y: -5, width: 100, height: 100 }, 8, 8);
    expect(count(mask)).toBe(64);
  });
});

describe("rasterizeEllipse", () => {
  it("is solid in the middle and empty in the corners", () => {
    const mask = rasterizeEllipse({ x: 0, y: 0, width: 20, height: 20 }, 20, 20);
    expect(mask[10 * 20 + 10]).toBe(255);
    expect(mask[0]).toBe(0);
    expect(mask[19 * 20 + 19]).toBe(0);
  });

  it("covers less than the rectangle that bounds it", () => {
    const box = rasterizeRect({ x: 0, y: 0, width: 20, height: 20 }, 20, 20);
    const ellipse = rasterizeEllipse({ x: 0, y: 0, width: 20, height: 20 }, 20, 20);
    expect(count(ellipse)).toBeLessThan(count(box));
    // A circle is about π/4 of its bounding square.
    expect(count(ellipse) / count(box)).toBeGreaterThan(0.7);
  });

  it("produces partial coverage at the edge, not a hard step", () => {
    const mask = rasterizeEllipse({ x: 0, y: 0, width: 40, height: 40 }, 40, 40);
    const partial = Array.from(mask).filter((v) => v > 0 && v < 255);
    expect(partial.length).toBeGreaterThan(0);
  });

  it("returns an empty mask for a zero-size drag", () => {
    expect(isEmptyMask(rasterizeEllipse({ x: 3, y: 3, width: 0, height: 5 }, 10, 10))).toBe(true);
  });
});

describe("rasterizePolygon", () => {
  it("fills a square described as four points", () => {
    const mask = rasterizePolygon([0, 0, 10, 0, 10, 10, 0, 10], 10, 10);
    expect(count(mask)).toBe(100);
  });

  it("fills a triangle to roughly half its bounding box", () => {
    const mask = rasterizePolygon([0, 0, 20, 0, 0, 20], 20, 20);
    expect(count(mask)).toBeGreaterThan(150);
    expect(count(mask)).toBeLessThan(230);
  });

  it("needs three points to describe an area", () => {
    expect(isEmptyMask(rasterizePolygon([0, 0, 5, 5], 10, 10))).toBe(true);
  });

  it("does not leave holes where a vertex lands on a scanline", () => {
    // A vertex exactly on a sample row is the classic even-odd bug: counted
    // twice, the parity flips and the row below it comes out empty.
    const mask = rasterizePolygon([0, 0.5, 10, 0.5, 10, 9.5, 0, 9.5], 10, 10);
    for (let y = 1; y < 9; y += 1) {
      expect(mask[y * 10 + 5]).toBe(255);
    }
  });
});

describe("magicWand", () => {
  /** 4×4: left half red, right half blue. */
  const twoTone = () => {
    const rgba = new Uint8ClampedArray(4 * 4 * 4);
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        const i = (y * 4 + x) * 4;
        const left = x < 2;
        rgba[i] = left ? 255 : 0;
        rgba[i + 1] = 0;
        rgba[i + 2] = left ? 0 : 255;
        rgba[i + 3] = 255;
      }
    }
    return rgba;
  };

  it("selects the region it was clicked in and nothing else", () => {
    const mask = magicWand(twoTone(), 4, 4, 0, 0, 10);
    expect(count(mask)).toBe(8);
    expect(mask[0]).toBe(255);
    expect(mask[3]).toBe(0);
  });

  it("selects everything once the tolerance covers both colours", () => {
    expect(count(magicWand(twoTone(), 4, 4, 0, 0, 255))).toBe(16);
  });

  it("reaches disconnected pixels only when non-contiguous", () => {
    // Two separated red squares on a blue field.
    const rgba = new Uint8ClampedArray(5 * 1 * 4);
    const set = (x: number, red: boolean) => {
      const i = x * 4;
      rgba[i] = red ? 255 : 0;
      rgba[i + 2] = red ? 0 : 255;
      rgba[i + 3] = 255;
    };
    [true, false, false, false, true].forEach((red, x) => set(x, red));

    expect(count(magicWand(rgba, 5, 1, 0, 0, 10, true))).toBe(1);
    expect(count(magicWand(rgba, 5, 1, 0, 0, 10, false))).toBe(2);
  });

  it("treats a transparent pixel as different from an opaque one of the same colour", () => {
    const rgba = new Uint8ClampedArray(2 * 1 * 4);
    rgba.set([255, 0, 0, 255], 0);
    rgba.set([255, 0, 0, 0], 4);
    expect(count(magicWand(rgba, 2, 1, 0, 0, 4))).toBe(1);
  });

  it("returns empty for a click outside the canvas", () => {
    expect(isEmptyMask(magicWand(twoTone(), 4, 4, 99, 99, 255))).toBe(true);
  });
});

describe("mask arithmetic", () => {
  it("inverts", () => {
    const mask = rasterizeRect({ x: 0, y: 0, width: 5, height: 10 }, 10, 10);
    const inverted = invertMask(mask);
    expect(inverted[0]).toBe(0);
    expect(inverted[9]).toBe(255);
  });

  it("adds, subtracts and intersects", () => {
    const left = rasterizeRect({ x: 0, y: 0, width: 6, height: 10 }, 10, 10);
    const right = rasterizeRect({ x: 4, y: 0, width: 6, height: 10 }, 10, 10);

    expect(count(combineMasks(left, right, "add"))).toBe(100);
    expect(count(combineMasks(left, right, "subtract"))).toBe(40);
    expect(count(combineMasks(left, right, "intersect"))).toBe(20);
    expect(combineMasks(left, right, "replace")).toBe(right);
  });

  it("feathers a hard edge into a ramp without shrinking a full selection", () => {
    const full = createMask(16, 16, 255);
    const featheredFull = featherMask(full, 16, 16, 3);
    expect(featheredFull[8 * 16 + 8]).toBe(255);

    const half = rasterizeRect({ x: 0, y: 0, width: 8, height: 16 }, 16, 16);
    const feathered = featherMask(half, 16, 16, 3);
    const ramp = Array.from(feathered).filter((v) => v > 0 && v < 255);
    expect(ramp.length).toBeGreaterThan(0);
  });

  it("leaves the mask alone for a zero feather radius", () => {
    const mask = rasterizeRect({ x: 1, y: 1, width: 3, height: 3 }, 8, 8);
    expect(featherMask(mask, 8, 8, 0)).toBe(mask);
  });

  it("grows and shrinks by whole pixels", () => {
    const dot = createMask(9, 9);
    dot[4 * 9 + 4] = 255;
    expect(count(resizeMask(dot, 9, 9, 1))).toBe(9);
    expect(count(resizeMask(dot, 9, 9, 2))).toBe(25);
    expect(count(resizeMask(resizeMask(dot, 9, 9, 2), 9, 9, -2))).toBe(1);
    expect(resizeMask(dot, 9, 9, 0)).toBe(dot);
  });

  it("reports the tight bounds of a selection, or null when empty", () => {
    const mask = rasterizeRect({ x: 3, y: 4, width: 2, height: 5 }, 20, 20);
    expect(maskBounds(mask, 20, 20)).toEqual({ x: 3, y: 4, width: 2, height: 5 });
    expect(maskBounds(createMask(20, 20), 20, 20)).toBeNull();
  });
});

describe("maskToRGBA", () => {
  it("writes coverage into alpha for a layer mask", () => {
    const mask = new Uint8Array([0, 128, 255]);
    const rgba = maskToRGBA(mask, "alpha");
    expect([rgba[3], rgba[7], rgba[11]]).toEqual([0, 128, 255]);
    expect([rgba[0], rgba[4], rgba[8]]).toEqual([255, 255, 255]);
  });

  it("INVERTS coverage into alpha for an inpaint mask", () => {
    // The provider regenerates transparent pixels. Getting this backwards
    // repaints everything the user did NOT select, which is the single most
    // expensive mistake available here — it costs a credit to discover.
    const mask = new Uint8Array([0, 128, 255]);
    const rgba = maskToRGBA(mask, "inpaint");
    expect([rgba[3], rgba[7], rgba[11]]).toEqual([255, 127, 0]);
  });

  it("round-trips through maskFromRGBA", () => {
    const mask = new Uint8Array([0, 40, 200, 255]);
    expect(Array.from(maskFromRGBA(maskToRGBA(mask, "alpha")))).toEqual(Array.from(mask));
  });
});
