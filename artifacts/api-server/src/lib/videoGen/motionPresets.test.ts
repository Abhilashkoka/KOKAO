import { describe, it, expect } from "vitest";
import {
  MOTION_PRESETS,
  MOTION_PRESET_CATEGORIES,
  findMotionPreset,
  isMotionPresetId,
} from "./motionPresets";

describe("motion preset catalog", () => {
  it("has unique ids", () => {
    const ids = MOTION_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses url-safe stable ids", () => {
    // Ids are persisted on jobs and storyboard scenes and travel in JSON, so
    // they stay lowercase kebab-case forever. A rename orphans saved plans.
    for (const preset of MOTION_PRESETS) {
      expect(preset.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it("puts every preset in a declared category", () => {
    const known = new Set(MOTION_PRESET_CATEGORIES.map((category) => category.id));
    for (const preset of MOTION_PRESETS) {
      expect(known.has(preset.category)).toBe(true);
    }
  });

  it("leaves no category empty", () => {
    for (const category of MOTION_PRESET_CATEGORIES) {
      expect(MOTION_PRESETS.some((preset) => preset.category === category.id)).toBe(true);
    }
  });

  it("gives every preset a real prompt sentence", () => {
    // The prompt IS the feature: providers take text, not an effect id, so a
    // stub or a bare label would ship a preset that does nothing.
    for (const preset of MOTION_PRESETS) {
      expect(preset.prompt.trim().length, preset.id).toBeGreaterThan(40);
      expect(preset.prompt.trim(), preset.id).toMatch(/[.!]$/);
      // A prompt that is just the label restated ("Crash zoom in.") tells the
      // model nothing it could not infer; every preset describes the move.
      expect(preset.prompt.trim().split(/\s+/).length, preset.id).toBeGreaterThan(8);
    }
  });

  it("never smuggles in instructions the shot planners forbid", () => {
    // Cuts, dialogue, on-screen text and watermarks are excluded everywhere
    // else in the pipeline; a preset must not reintroduce them.
    for (const preset of MOTION_PRESETS) {
      expect(preset.prompt.toLowerCase()).not.toMatch(/\b(watermark|subtitle|caption)\b/);
    }
  });

  it("gives every preset a distinct human label", () => {
    const labels = MOTION_PRESETS.map((preset) => preset.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("findMotionPreset", () => {
  it("resolves a known id", () => {
    expect(findMotionPreset("dolly-in")?.label).toBe("Dolly in");
  });

  it("returns null for an unknown id", () => {
    expect(findMotionPreset("teleport-through-wall")).toBeNull();
  });

  it("treats null, undefined and empty string as no preset", () => {
    expect(findMotionPreset(null)).toBeNull();
    expect(findMotionPreset(undefined)).toBeNull();
    expect(findMotionPreset("")).toBeNull();
  });
});

describe("isMotionPresetId", () => {
  it("accepts catalog ids and rejects everything else", () => {
    expect(isMotionPresetId("crash-zoom-in")).toBe(true);
    expect(isMotionPresetId("Crash Zoom In")).toBe(false);
    expect(isMotionPresetId("__proto__")).toBe(false);
  });
});
