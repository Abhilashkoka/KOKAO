import { beforeEach, describe, expect, it, vi } from "vitest";

const renderState = vi.hoisted(() => ({
  animate: [] as Array<Record<string, unknown>>,
  compose: [] as Array<Record<string, unknown>>,
}));

vi.mock("./aiBroll", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./aiBroll")>();
  return {
    ...actual,
    animateBrollStills: vi.fn(async (params: Record<string, unknown>) => {
      renderState.animate.push(params);
      return {
        clips: [Buffer.from("native-clip")],
        sceneMap: [{ clipIndex: 0, durationSec: 4, lipSynced: true }],
        provider: "openrouter",
        model: "bytedance/seedance-2.5",
        effectiveDurationSecs: [4],
      };
    }),
  };
});

vi.mock("./compose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./compose")>();
  return {
    ...actual,
    composeTopicVideo: vi.fn(async (params: Record<string, unknown>) => {
      renderState.compose.push(params);
      return Buffer.from("composed");
    }),
  };
});

vi.mock("../../featureFlags", () => ({
  isFeatureEnabled: vi.fn(async () => false),
}));

import { renderTopicStoryboard } from "./index";

function guidedSnapshot(promptFormat?: "guided-v1" | "seedance-2.5") {
  return {
    version: 1,
    promptFormat,
    videoModel: {
      provider: "openrouter",
      model: "bytedance/seedance-2.5",
    },
    locale: "en",
    platform: {
      id: "instagram-reel",
      aspectRatio: "9:16",
      width: 1080,
      height: 1920,
      safeArea: "Keep faces inside the middle 80%.",
      durationSeconds: 4,
    },
    script: {
      version: 1,
      title: "Station hello",
      logline: "A quick greeting",
      runtimeSeconds: 4,
      roles: [],
      warnings: [],
      scenes: [
        {
          id: "scene-1",
          startMs: 0,
          endMs: 4_000,
          visualDirection: "Mira looks to camera and waves.",
          roleIds: ["hero"],
          lines: [
            {
              id: "line-1",
              ownerRoleId: "hero",
              kind: "dialogue",
              text: "Hello from the station.",
              startMs: 0,
              endMs: 3_000,
            },
          ],
        },
      ],
    },
    cast: [
      {
        roleId: "hero",
        source: "saved",
        characterId: 1,
        outfitId: 2,
        brandKitId: null,
        voiceId: "stock:alloy",
        character: {
          name: "Mira",
          description: "A traveler",
          referenceImagePath: "/mira.png",
        },
        outfit: {
          name: "Travel",
          description: "a saffron jacket",
          referenceImagePath: "/mira-outfit.png",
        },
        voice: {
          id: "alloy",
          label: "Alloy",
          provider: "stock",
          providerVoiceId: "alloy",
        },
        isUserRole: false,
        consentGranted: true,
      },
    ],
    visuals: {
      location: { mode: "none", imagePath: null, description: null },
      logo: { path: null, showOnSceneIds: [] },
    },
    backdropReference: {
      imagePath: "/station.png",
      prompt: "A warm railway platform",
    },
  };
}

function storyboard() {
  return {
    version: 1,
    status: "approved",
    visualsSource: "ai_video",
    provider: "openrouter",
    model: "bytedance/seedance-2.5",
    narration: {
      audioPath: "narration.wav",
      totalDurationSec: 4,
      cues: [{ text: "Hello from the station.", startSec: 0, endSec: 3 }],
    },
    scenes: [
      {
        id: "scene-1",
        text: "Hello from the station.",
        visual: "legacy guided visual prompt",
        durationSec: 4,
        previewPath: "scene-1.png",
        providerCheckpoint: null,
        guidedStory: { scriptSceneId: "scene-1" },
      },
    ],
  };
}

const modelOptions = {
  modelId: "openrouter:bytedance/seedance-2.5",
  durationSec: 4,
  resolution: null,
  quality: null,
  generateAudio: true,
};

beforeEach(() => {
  renderState.animate.length = 0;
  renderState.compose.length = 0;
});

describe("renderTopicStoryboard Seedance contract", () => {
  it("uses the frozen Seedance prompt and provider-native audio for Guided Story ai_video", async () => {
    await renderTopicStoryboard({
      storyboard: storyboard() as never,
      aspectRatio: "9:16",
      subtitles: true,
      music: Buffer.from("external-music"),
      modelOptions,
      guidedStory: guidedSnapshot("seedance-2.5") as never,
      load: async (path) => Buffer.from(path),
    });

    const animate = renderState.animate[0]!;
    expect(animate.nativeAudio).toBe(true);
    expect((animate.visuals as string[])[0]).toContain("[DIALOGUE]");
    expect((animate.visuals as string[])[0]).toContain(
      "Dialogue 1 — 0s — Mira says in English: {Hello from the station.}",
    );
    expect((animate.visuals as string[])[0]).toContain(
      "@Image 1 defines the approved opening frame",
    );
    expect((animate.visuals as string[])[0]).not.toContain("@Image 2");

    expect(renderState.compose[0]).toMatchObject({
      nativeAudio: true,
      subtitles: false,
      music: null,
    });
  });

  it("keeps legacy Guided Story snapshots on the existing silent prompt path", async () => {
    await renderTopicStoryboard({
      storyboard: storyboard() as never,
      aspectRatio: "9:16",
      subtitles: true,
      music: Buffer.from("external-music"),
      modelOptions,
      guidedStory: guidedSnapshot() as never,
      load: async (path) => Buffer.from(path),
    });

    expect(renderState.animate[0]).toMatchObject({
      nativeAudio: false,
      visuals: ["legacy guided visual prompt"],
    });
    expect(renderState.compose[0]).toMatchObject({
      nativeAudio: false,
      subtitles: true,
      music: Buffer.from("external-music"),
    });
  });

  it("direct mode uses the approved outfit input and composes native clip audio without narration", async () => {
    const directBoard = storyboard();
    directBoard.narration = null as never;
    directBoard.scenes[0]!.previewPath = "/mira-outfit.png";
    const loaded: string[] = [];

    await renderTopicStoryboard({
      storyboard: directBoard as never,
      aspectRatio: "9:16",
      subtitles: true,
      music: Buffer.from("must-not-be-used"),
      motionPreset: "slow-dolly-in",
      modelOptions,
      guidedStory: guidedSnapshot("seedance-2.5") as never,
      directNativeAudio: true,
      load: async (path) => {
        loaded.push(path);
        return Buffer.from(path);
      },
    });

    expect(loaded).toEqual(["/mira-outfit.png"]);
    const animate = renderState.animate[0]!;
    expect((animate.images as Buffer[])[0]?.toString()).toBe("/mira-outfit.png");
    expect(animate.nativeAudio).toBe(true);
    const prompt = (animate.visuals as string[])[0]!;
    expect(prompt).toContain("@Image 1 is the approved active-speaker or primary-character portrait");
    expect(prompt).toContain("[ACTION AND CAMERA]");
    expect(prompt).toContain("[PERFORMANCE]");
    expect(prompt).toContain("[CONTINUITY]");
    expect(prompt).toContain(
      "Dialogue 1 — 0s — Mira says in English: {Hello from the station.}",
    );
    expect(renderState.compose[0]).toMatchObject({
      clips: [Buffer.from("native-clip")],
      nativeAudio: true,
      subtitles: false,
      music: null,
    });
  });
});