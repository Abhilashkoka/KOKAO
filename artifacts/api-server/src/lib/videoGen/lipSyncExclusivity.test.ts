import { describe, it, expect } from "vitest";
import {
  characterPassOwnsLipSync,
  STUDIO_PASS_REDUNDANT_MESSAGE,
} from "./lipSyncExclusivity";

describe("characterPassOwnsLipSync", () => {
  it("claims the job when the character pass is active on a character video", () => {
    expect(
      characterPassOwnsLipSync({
        engine: "topic_to_video",
        visualsSource: "character",
        characterLipSyncActive: true,
      }),
    ).toBe(true);
  });

  it("leaves the optional pass alone when the character pass is off", () => {
    expect(
      characterPassOwnsLipSync({
        engine: "topic_to_video",
        visualsSource: "character",
        characterLipSyncActive: false,
      }),
    ).toBe(false);
  });

  it("never claims a non-character topic video", () => {
    for (const visualsSource of ["stock", "ai", "ai_video"]) {
      expect(
        characterPassOwnsLipSync({
          engine: "topic_to_video",
          visualsSource,
          characterLipSyncActive: true,
        }),
      ).toBe(false);
    }
  });

  it("never claims another engine", () => {
    // Guided Story, the dialogue engine and the direct engines all reach the
    // optional pass on their own terms; the character pass cannot run there,
    // so it must not block them.
    for (const engine of [
      "text_to_video",
      "image_to_video",
      "dialogue_lip_sync",
      "lip_sync",
      "slideshow",
      "localized_dub",
    ]) {
      expect(
        characterPassOwnsLipSync({
          engine,
          visualsSource: "character",
          characterLipSyncActive: true,
        }),
      ).toBe(false);
    }
  });

  it("explains itself in the refusal", () => {
    // The message has to name the reason, because the fix is a toggle the user
    // can see and un-tick.
    expect(STUDIO_PASS_REDUNDANT_MESSAGE).toMatch(/already lip-syncs/i);
    expect(STUDIO_PASS_REDUNDANT_MESSAGE).toMatch(/second time/i);
  });
});
