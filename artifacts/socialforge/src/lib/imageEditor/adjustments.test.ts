import { describe, it, expect } from "vitest";
import {
  ADJUSTMENT_CONTROLS,
  ADJUSTMENT_PRESETS,
  applyChannels,
  applySharpen,
  buildFilterPlan,
} from "./adjustments";
import { BLEND_GROUPS, allBlendModesGrouped, blendLabel, compositeOperationFor } from "./blend";
import { BLEND_MODES } from "./doc";

describe("buildFilterPlan", () => {
  it("is empty when nothing is set", () => {
    expect(buildFilterPlan(undefined)).toEqual([]);
    expect(buildFilterPlan({})).toEqual([]);
  });

  it("skips identity values so an untouched layer costs no filter pass", () => {
    expect(buildFilterPlan({ brightness: 0, contrast: 0, blur: 0 })).toEqual([]);
  });

  it("puts tone before colour before structure", () => {
    // Saturating an underexposed layer and then brightening it gives a muddier
    // result than the other way round, so the order is load-bearing.
    const plan = buildFilterPlan({ blur: 4, saturation: 1, brightness: 0.2, contrast: 10 });
    expect(plan.map((s) => s.filter)).toEqual(["Brighten", "Contrast", "HSL", "Blur"]);
  });

  it("collapses hue, saturation and luminance into one HSL pass", () => {
    const plan = buildFilterPlan({ hue: 20, saturation: 1, luminance: -0.5 });
    expect(plan).toHaveLength(1);
    expect(plan[0]).toEqual({ filter: "HSL", attrs: { hue: 20, saturation: 1, luminance: -0.5 } });
  });

  it("converts posterize levels into the 0..1 range Konva expects", () => {
    const [step] = buildFilterPlan({ posterize: 51 });
    expect(step.filter).toBe("Posterize");
    expect(step.attrs.levels).toBeCloseTo(0.2, 5);
  });

  it("emits the custom filters with their node attributes", () => {
    const plan = buildFilterPlan({ sharpen: 0.5, channels: { r: 1.1, g: 1, b: 0.9 } });
    const sharpen = plan.find((s) => s.filter === "Sharpen");
    const channels = plan.find((s) => s.filter === "Channels");
    expect(sharpen?.attrs).toEqual({ sharpenAmount: 0.5 });
    expect(channels?.attrs).toEqual({ channelR: 1.1, channelG: 1, channelB: 0.9 });
  });

  it("ignores a pixelate size of one, which would be a no-op pass", () => {
    expect(buildFilterPlan({ pixelate: 1 })).toEqual([]);
    expect(buildFilterPlan({ pixelate: 8 })[0].attrs).toEqual({ pixelSize: 8 });
  });

  it("emits the boolean filters", () => {
    const plan = buildFilterPlan({ grayscale: true, invert: true });
    expect(plan.map((s) => s.filter)).toEqual(["Grayscale", "Invert"]);
  });
});

describe("applySharpen", () => {
  const flat = (size: number, value: number) => {
    const data = new Uint8ClampedArray(size * size * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = value;
      data[i + 1] = value;
      data[i + 2] = value;
      data[i + 3] = 255;
    }
    return data;
  };

  it("leaves a flat region alone", () => {
    const data = flat(5, 128);
    applySharpen(data, 5, 5, 0.5);
    expect(data[(2 * 5 + 2) * 4]).toBe(128);
  });

  it("does nothing at zero amount, or on an image too small to have a centre", () => {
    const data = flat(5, 100);
    const before = Array.from(data);
    applySharpen(data, 5, 5, 0);
    expect(Array.from(data)).toEqual(before);

    const tiny = flat(2, 100);
    const tinyBefore = Array.from(tiny);
    applySharpen(tiny, 2, 2, 1);
    expect(Array.from(tiny)).toEqual(tinyBefore);
  });

  it("increases local contrast at an edge", () => {
    const data = flat(5, 100);
    // Brighten one pixel so there is an edge to sharpen.
    const centre = (2 * 5 + 2) * 4;
    data[centre] = 160;
    data[centre + 1] = 160;
    data[centre + 2] = 160;
    applySharpen(data, 5, 5, 0.5);
    expect(data[centre]).toBeGreaterThan(160);
  });

  it("skips fully transparent pixels so a cut-out edge gets no halo", () => {
    const data = flat(5, 100);
    const target = (2 * 5 + 2) * 4;
    data[target + 3] = 0;
    data[target] = 7;
    applySharpen(data, 5, 5, 1);
    expect(data[target]).toBe(7);
  });
});

describe("applyChannels", () => {
  it("scales each channel and leaves alpha alone", () => {
    const data = new Uint8ClampedArray([100, 100, 100, 200]);
    applyChannels(data, 1.5, 1, 0.5);
    expect(Array.from(data)).toEqual([150, 100, 50, 200]);
  });

  it("is a no-op at unity", () => {
    const data = new Uint8ClampedArray([10, 20, 30, 40]);
    applyChannels(data, 1, 1, 1);
    expect(Array.from(data)).toEqual([10, 20, 30, 40]);
  });

  it("clamps rather than wrapping", () => {
    const data = new Uint8ClampedArray([200, 200, 200, 255]);
    applyChannels(data, 2, 2, 2);
    expect(Array.from(data)).toEqual([255, 255, 255, 255]);
  });
});

describe("presets and controls", () => {
  it("every preset builds a valid plan", () => {
    for (const preset of ADJUSTMENT_PRESETS) {
      expect(() => buildFilterPlan(preset.adjustments)).not.toThrow();
    }
    expect(buildFilterPlan(ADJUSTMENT_PRESETS[0].adjustments)).toEqual([]);
  });

  it("every slider's identity value produces no filter", () => {
    for (const control of ADJUSTMENT_CONTROLS) {
      const plan = buildFilterPlan({ [control.key]: control.identity });
      expect(plan, `${control.key} at identity should be a no-op`).toEqual([]);
    }
  });

  it("every slider's range contains its identity", () => {
    for (const control of ADJUSTMENT_CONTROLS) {
      expect(control.identity).toBeGreaterThanOrEqual(control.min);
      expect(control.identity).toBeLessThanOrEqual(control.max);
    }
  });
});

describe("blend modes", () => {
  it("maps every supported mode to a real canvas operation", () => {
    for (const mode of BLEND_MODES) {
      expect(typeof compositeOperationFor(mode)).toBe("string");
    }
    expect(compositeOperationFor("normal")).toBe("source-over");
    expect(compositeOperationFor("linear-dodge")).toBe("lighter");
  });

  it("puts every mode in exactly one menu group", () => {
    // The menu is hand-written and the type is not; this is what stops a new
    // mode from being unreachable in the UI.
    expect(allBlendModesGrouped()).toBe(true);
    expect(BLEND_GROUPS.flatMap((g) => g.modes)).toHaveLength(BLEND_MODES.length);
  });

  it("labels hyphenated modes readably", () => {
    expect(blendLabel("soft-light")).toBe("Soft Light");
    expect(blendLabel("linear-dodge")).toBe("Linear Dodge (Add)");
    expect(blendLabel("multiply")).toBe("Multiply");
  });
});
