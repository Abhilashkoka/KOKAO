import { describe, expect, it } from "vitest";
import {
  hybridNarrationIsAggregateOwned,
  hybridNarrationConsumesVideoUnit,
  hybridRequiredUnits,
  remainingHybridUnits,
  videoJobFullUnits,
  videoJobUnits,
} from "./units";

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

describe("Guided Story dialogue replay units", () => {
  it("uses the frozen owned-line operation estimate and keeps TTS independent", () => {
    const options = {
      aspectRatio: "9:16" as const,
      guidedStoryDialogueReplay: {
        version: 1 as const,
        sourceJobId: 47182,
        sourceStoryboardFingerprint: "approved",
        locale: "te" as const,
        subtitles: false as const,
        confirmedAt: "2026-08-31T00:00:00.000Z",
        lines: [],
        estimates: { lineCount: 7, durationSeconds: 28, units: 12 },
      },
    };
    expect(videoJobFullUnits("dialogue_lip_sync", options)).toBe(12);
    expect(videoJobUnits("dialogue_lip_sync", options)).toBe(12);
    expect(videoJobUnits("dialogue_lip_sync", {
      ...options,
      recovery: {
        version: 1,
        chainId: 50,
        sourceJobId: 51,
        fundedUnits: 3,
        mode: "resume",
        state: "queued",
        reusable: [],
        regenerated: [],
        privacyRecovery: null,
        rendered: null,
      },
    })).toBe(3);
  });
});

describe("hybrid character story units", () => {
  it("reserves the shared narration once plus every immutable beat operation", () => {
    expect(videoJobFullUnits("topic_to_video", {
      aspectRatio: "9:16",
      hybridStory: {
        version: 1,
        characterId: 4,
        outfitId: 9,
        lipSyncConsent: true,
        pattern: [
          { kind: "character_opening", maxDurationSeconds: 8 },
          { kind: "story_animation", maxDurationSeconds: 8 },
          { kind: "character_closing", maxDurationSeconds: 8 },
        ],
      },
    })).toBe(9);
  });

  it("applies premium video pricing, adds music once, and omits an unused interlude post-plan", () => {
    const options = {
      aspectRatio: "9:16" as const,
      modelId: "veo-3-fast",
      musicPrompt: "score",
      hybridStory: {
        version: 1 as const,
        characterId: 4,
        outfitId: 9,
        lipSyncConsent: true as const,
        pattern: [
          { kind: "character_opening" as const, maxDurationSeconds: 8 },
          { kind: "story_animation" as const, maxDurationSeconds: 8 },
          { kind: "character_interlude" as const, maxDurationSeconds: 8 },
          { kind: "character_closing" as const, maxDurationSeconds: 8 },
        ],
      },
    };
    expect(hybridRequiredUnits({ options })).toBe(46); // 1 + (3+2+3+3)*4 + music
    expect(hybridRequiredUnits({
      options,
      beatKinds: ["character_speaking", "story_animation", "character_speaking"],
    })).toBe(34); // 1 + (3+2+3)*4 + music
    expect(hybridRequiredUnits({
      options,
      beatKinds: ["character_speaking", "story_animation", "character_speaking"],
      narrationAccountingMode: "independently_settled",
    })).toBe(33); // cloned narration is funded and settled outside the video hold
  });

  it("uses the frozen post-plan total for every later accounting path", () => {
    const options = {
      aspectRatio: "9:16" as const,
      hybridStory: {
        version: 1 as const, characterId: 1, outfitId: 2, lipSyncConsent: true as const,
        pattern: [
          { kind: "character_opening" as const, maxDurationSeconds: 8 },
          { kind: "story_animation" as const, maxDurationSeconds: 8 },
          { kind: "character_closing" as const, maxDurationSeconds: 8 },
        ],
      },
      storyboardFunding: {
        version: 1 as const, sceneCount: 3, requiredUnits: 9, fundedUnits: 9,
        planningUnits: 1,
      },
    };
    expect(hybridRequiredUnits({ options })).toBe(9);
    expect(videoJobFullUnits("topic_to_video", options)).toBe(9);
    expect(videoJobUnits("topic_to_video", {
      ...options,
      storyboardFunding: { ...options.storyboardFunding, fundedUnits: 1 },
    })).toBe(1);
  });

  it("only puts authoritatively-priced TTS in aggregate settlement", () => {
    expect(hybridNarrationIsAggregateOwned("aggregate")).toBe(true);
    expect(hybridNarrationIsAggregateOwned("unmetered")).toBe(false);
    expect(hybridNarrationIsAggregateOwned(undefined)).toBe(false);
    expect(hybridNarrationIsAggregateOwned("independently_settled")).toBe(false);
    expect(hybridNarrationConsumesVideoUnit("aggregate")).toBe(true);
    expect(hybridNarrationConsumesVideoUnit("unmetered")).toBe(true);
    expect(hybridNarrationConsumesVideoUnit("independently_settled")).toBe(false);
  });

  it("deducts premium visual work at model weight but narration at one", () => {
    expect(remainingHybridUnits({
      requiredUnits: 34,
      completedVisualOperations: 2,
      completedNarrationUnit: true,
      completedMusic: true,
      modelId: "veo-3-fast",
    })).toBe(24);
    expect(remainingHybridUnits({
      requiredUnits: 33,
      completedVisualOperations: 2,
      // Unmetered/cloned narration evidence never reduces aggregate funding.
      completedNarrationUnit: false,
      completedMusic: true,
      modelId: "veo-3-fast",
    })).toBe(24);
  });
});