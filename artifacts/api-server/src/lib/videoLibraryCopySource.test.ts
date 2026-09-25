import { describe, expect, it } from "vitest";
import type { VideoGeneration } from "@workspace/db";
import { videoLibraryCopySource } from "./videoLibraryCopySource";

const source = (data: Partial<VideoGeneration>) => videoLibraryCopySource({
  options: null,
  storyboard: null,
  prompt: null,
  ...data,
});

describe("video Library copy source", () => {
  it("uses approved Guided Story lines before a creator prompt and excludes directions and cast data", () => {
    const result = source({
      prompt: "generic creator prompt",
      options: { guidedStory: { script: {
        title: "Our Story", logline: "A trip to the moon",
        scenes: [{ lines: [{ text: "We made it!" }] }],
      } } } as VideoGeneration["options"],
    });
    expect(result).toEqual({ sourceType: "guided_script", text: "Our Story\nA trip to the moon\nWe made it!" });
  });

  it("uses frozen walkthrough generated speech over the user's initial brief", () => {
    expect(source({
      prompt: "show the app",
      options: { hybridStory: { screenDemo: { generatedScript: "Tap Start to make a reel", script: "draft" } } } as VideoGeneration["options"],
    })).toEqual({ sourceType: "walkthrough_script", text: "Tap Start to make a reel" });
    expect(source({
      options: { hybridStory: { screenDemo: { script: "Speak these exact words" } } } as VideoGeneration["options"],
    })).toEqual({ sourceType: "walkthrough_script", text: "Speak these exact words" });
    expect(source({
      options: { hybridStory: { screenDemo: { generatedScript: "See the app" } } } as VideoGeneration["options"],
      storyboard: { scenes: [{ text: "Meet our presenter" }, { text: "See the app" }, { text: "Try it today" }] } as VideoGeneration["storyboard"],
    })).toEqual({ sourceType: "walkthrough_script", text: "Meet our presenter\nSee the app\nTry it today" });
  });

  it("uses character speech or approved topic narration and labels a prompt as only a brief", () => {
    expect(source({
      options: { characterDialogue: { script: "Here is my story." } } as VideoGeneration["options"],
    })?.sourceType).toBe("character_script");
    expect(source({
      options: { dialogue: "A single character speaks." } as VideoGeneration["options"],
    })).toEqual({ sourceType: "character_script", text: "A single character speaks." });
    expect(source({
      storyboard: { scenes: [{ text: "First the product launches." }, { text: "Then it grows." }] } as VideoGeneration["storyboard"],
    })).toEqual({ sourceType: "narration", text: "First the product launches.\nThen it grows." });
    expect(source({ prompt: "a short funny clip" })).toEqual({ sourceType: "brief", text: "a short funny clip" });
    expect(source({})).toBeNull();
  });
});