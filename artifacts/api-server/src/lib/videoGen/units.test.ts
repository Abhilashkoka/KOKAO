import { describe, expect, it } from "vitest";
import { videoJobFullUnits, videoJobUnits } from "./units";

describe("persisted native-template storyboard funding", () => {
  const base = {
    aspectRatio: "9:16" as const,
    visualsSource: "ai" as const,
    storyboardFunding: {
      version: 1 as const,
      sceneCount: 3,
      requiredUnits: 3,
      fundedUnits: 1,
      planningUnits: 1,
    },
  };

  it("uses held funding until the exact AI scene total is funded", () => {
    expect(videoJobUnits("topic_to_video", base)).toBe(1);
    expect(videoJobFullUnits("topic_to_video", base)).toBe(1);
    expect(videoJobUnits("topic_to_video", {
      ...base,
      storyboardFunding: { ...base.storyboardFunding, fundedUnits: 3 },
    })).toBe(3);
  });

  it("preserves a frozen exact total for AI-video, multipliers, added scenes and music", () => {
    // 2 video operations per scene; (2 * 3 scenes + 2 added) * 4 premium
    // multiplier + one unscaled MusicGen operation = 33.
    const options = {
      ...base,
      visualsSource: "ai_video" as const,
      modelId: "veo-3-fast",
      addedScenes: 2,
      musicPrompt: "warm ambient bed",
      storyboardFunding: {
        ...base.storyboardFunding,
        sceneCount: 3,
        requiredUnits: 33,
        fundedUnits: 33,
      },
    };
    expect(videoJobUnits("topic_to_video", options)).toBe(33);
    expect(videoJobFullUnits("topic_to_video", options)).toBe(33);
  });
});