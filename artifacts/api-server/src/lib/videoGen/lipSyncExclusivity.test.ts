import { describe, it, expect } from "vitest";
import {
  characterPassOwnsLipSync,
  summariseStudioLipSyncScenes,
  STUDIO_PASS_REDUNDANT_MESSAGE,
} from "./lipSyncExclusivity";

describe("summariseStudioLipSyncScenes", () => {
  const event = { provider: "replicate", model: "latentsync" };

  it("counts what synced and what the provider refused", () => {
    expect(
      summariseStudioLipSyncScenes([
        { state: "complete", event },
        { state: "skipped" },
        { state: "complete", event },
      ]),
    ).toEqual({ synced: 2, skipped: 1, billable: 2 });
  });

  it("never counts a skipped scene as billable", () => {
    const summary = summariseStudioLipSyncScenes([
      { state: "skipped" },
      { state: "skipped" },
    ]);
    expect(summary.billable).toBe(0);
    expect(summary.skipped).toBe(2);
  });

  it("distinguishes a refused scene from one never dispatched", () => {
    const summary = summariseStudioLipSyncScenes([
      { state: "prepared" },
      { state: "skipped" },
    ]);
    expect(summary.skipped).toBe(1);
    expect(summary.synced).toBe(0);
  });

  it("reports nothing for a pass that never ran", () => {
    expect(summariseStudioLipSyncScenes(undefined)).toEqual({
      synced: 0,
      skipped: 0,
      billable: 0,
    });
    expect(summariseStudioLipSyncScenes([])).toEqual({
      synced: 0,
      skipped: 0,
      billable: 0,
    });
  });
});

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
