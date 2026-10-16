import { describe, expect, it } from "vitest";
import {
  QUICK_CREATE_PRESETS,
  QUICK_CREATE_VERTICALS,
  buildQuickCreatePrompt,
  quickCreateEngine,
} from "./quick-create-presets";

describe("quick create presets", () => {
  it("adds a language line only when a language is chosen", () => {
    expect(buildQuickCreatePrompt("  A saree sway  ", "None")).toBe("A saree sway");
    expect(buildQuickCreatePrompt("A saree sway", "Hinglish")).toBe(
      "A saree sway. Any on-screen speech or text is in Hinglish.",
    );
    expect(buildQuickCreatePrompt("   ", "Hindi")).toBe("");
  });

  it("animates a photo when one is given, otherwise uses text", () => {
    expect(quickCreateEngine(true)).toBe("image_to_video");
    expect(quickCreateEngine(false)).toBe("text_to_video");
  });

  it("gives every vertical at least one starter with unique ids", () => {
    const ids = QUICK_CREATE_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const v of QUICK_CREATE_VERTICALS) {
      expect(QUICK_CREATE_PRESETS.some((p) => p.vertical === v.id)).toBe(true);
    }
  });
});
