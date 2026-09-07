import { describe, expect, it } from "vitest";
import {
  clipSeconds,
  dialogueNumbering,
  isSeedance25Model,
  seedanceScenePrompt,
} from "./seedancePrompt";

function cast() {
  return [
    {
      roleId: "hero",
      source: "generated",
      characterId: null,
      character: { name: "Mira", referenceImagePath: "/objects/mira.png" },
      outfit: {
        description: "a saffron jacket",
        referenceImagePath: "/objects/mira-outfit.png",
      },
      voice: { provider: "stock", providerVoiceId: "voice-1" },
    },
    {
      roleId: "friend",
      source: "saved",
      characterId: 12,
      character: { name: "Dev", referenceImagePath: "/objects/dev.png" },
      outfit: {
        description: "a blue shirt",
        referenceImagePath: "/objects/dev-outfit.png",
      },
      voice: { provider: "stock", providerVoiceId: "voice-2" },
    },
  ] as any;
}

function scene() {
  return {
    id: "scene-1",
    startMs: 5_000,
    endMs: 15_000,
    visualDirection: "Mira and Dev stand beside the ferry railing.",
    roleIds: ["hero", "friend"],
    lines: [
      {
        id: "line-1",
        ownerRoleId: "hero",
        kind: "dialogue",
        text: "The tide is turning.",
        startMs: 5_000,
        endMs: 7_000,
      },
      {
        id: "line-2",
        ownerRoleId: "friend",
        kind: "dialogue",
        text: "Then we leave now.",
        startMs: 10_000,
        endMs: 12_000,
      },
    ],
  } as any;
}

describe("Seedance 2.5 prompt assembly", () => {
  it("identifies the frozen model without changing other model behavior", () => {
    expect(
      isSeedance25Model({
        resolvedVideoModel: { model: "bytedance/seedance-2.5" },
      }),
    ).toBe(true);
    expect(
      isSeedance25Model({
        resolvedVideoModel: { model: "dreamina-seedance-2-5-260628" },
      }),
    ).toBe(true);
    expect(
      isSeedance25Model({
        resolvedVideoModel: { model: "bytedance/seedance-2.0" },
      }),
    ).toBe(false);
    expect(isSeedance25Model({ modelId: "wan-2.2-fast" })).toBe(false);
  });

  it("keeps dialogue numbering global and clip timing local", () => {
    const numbers = dialogueNumbering({
      scenes: [
        scene(),
        {
          ...scene(),
          id: "scene-2",
          startMs: 15_000,
          endMs: 25_000,
          lines: [{ ...scene().lines[0], id: "line-3", startMs: 15_000, endMs: 17_000 }],
        },
      ],
    } as any);
    expect(numbers.get("line-1")).toBe(1);
    expect(numbers.get("line-2")).toBe(2);
    expect(numbers.get("line-3")).toBe(3);
    expect(clipSeconds(10_000, 5_000)).toBe(5);
  });

  it("uses the Seedance format for generated and uploaded cast snapshots", () => {
    const prompt = seedanceScenePrompt({
      scriptScene: scene(),
      sceneCast: cast(),
      backdrop: { imagePath: "/objects/ferry.png", prompt: "A coastal ferry at dawn." },
      location: { mode: "text", imagePath: null, description: "A quiet harbor." },
      platform: { aspectRatio: "9:16", safeArea: "Keep faces inside the center safe area." },
      locale: "en",
      dialogueNumbers: new Map([
        ["line-1", 1],
        ["line-2", 2],
      ]),
      segmentIndex: 0,
      segmentCount: 1,
      nativeAudio: true,
    });

    expect(prompt).toContain("@Image 1 defines Mira's face and hair.");
    expect(prompt).toContain("@Image 2 defines Mira's clothing — a saffron jacket.");
    expect(prompt).toContain("@Image 3 defines Dev's face and hair.");
    expect(prompt).toContain("exactly one Mira");
    expect(prompt).toContain("Dialogue 1 — 0s — Mira says in English: {The tide is turning.}");
    expect(prompt).toContain("Dialogue 2 — 5s — Dev says in English: {Then we leave now.}");
    expect(prompt).toContain("One continuous 10-second shot.");
  });

  it("describes only the uploaded opening frame in reviewed-storyboard mode", () => {
    const prompt = seedanceScenePrompt({
      scriptScene: scene(),
      sceneCast: cast(),
      backdrop: { imagePath: "/objects/ferry.png", prompt: "A coastal ferry at dawn." },
      location: { mode: "none", imagePath: null, description: null },
      platform: { aspectRatio: "9:16", safeArea: "Keep faces inside the center safe area." },
      locale: "en",
      dialogueNumbers: new Map([
        ["line-1", 1],
        ["line-2", 2],
      ]),
      segmentIndex: 0,
      segmentCount: 1,
      nativeAudio: true,
      referenceMode: "opening-frame",
    });

    expect(prompt).toContain("@Image 1 defines the approved opening frame");
    expect(prompt).not.toContain("@Image 2");
    expect(prompt).not.toContain("/objects/mira.png");
    expect(prompt).not.toContain("/objects/dev.png");
  });

  it("governs a direct scene around one approved primary-character image", () => {
    const prompt = seedanceScenePrompt({
      scriptScene: scene(),
      sceneCast: cast(),
      backdrop: { imagePath: "/objects/ferry.png", prompt: "A coastal ferry at dawn." },
      location: { mode: "none", imagePath: null, description: null },
      platform: { aspectRatio: "9:16", safeArea: "Keep faces inside the center safe area." },
      locale: "en",
      dialogueNumbers: new Map([
        ["line-1", 1],
        ["line-2", 2],
      ]),
      segmentIndex: 0,
      segmentCount: 1,
      nativeAudio: true,
      referenceMode: "primary-character-opening-frame",
      motionInstruction: "Slow dolly in while holding a steady eye-level axis.",
    });

    expect(prompt).toContain("@Image 1 is the approved active-speaker or primary-character portrait");
    expect(prompt).toContain("does not define the environment or the complete shot composition");
    expect(prompt).not.toContain("including every character, wardrobe, prop, and backdrop");
    expect(prompt).toContain("Approved environment: A coastal ferry at dawn.");
    expect(prompt).toContain("Slow dolly in while holding a steady eye-level axis.");
    expect(prompt).toContain("[PERFORMANCE]");
    expect(prompt).toContain("non-speakers listen and react without mouthing that dialogue");
    expect(prompt).toContain("[CONTINUITY]");
    expect(prompt).toContain("Dialogue 1 — 0s — Mira says in English: {The tide is turning.}");
    expect(prompt).toContain("Dialogue 2 — 5s — Dev says in English: {Then we leave now.}");
  });

  it("preserves the existing narration contract when native audio is disabled", () => {
    const prompt = seedanceScenePrompt({
      scriptScene: scene(),
      sceneCast: [cast()[0]],
      backdrop: null,
      location: { mode: "none", imagePath: null, description: null },
      platform: { aspectRatio: "16:9", safeArea: "Keep text safe." },
      locale: "en",
      dialogueNumbers: new Map([["line-1", 1]]),
      segmentIndex: 0,
      segmentCount: 1,
      nativeAudio: false,
    });
    expect(prompt).not.toContain("[DIALOGUE]");
    expect(prompt).toContain("No captions, subtitles or on-screen text.");
  });
});