import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Character, CharacterOutfit } from "@workspace/db";
import {
  groupCuesIntoScenes,
  clipDurationForScene,
  planSceneVisuals,
  generateCharacterSceneClips,
  CHARACTER_SCENES_PER_PARAGRAPH,
} from "./characterScenes";
import { videoJobUnits } from "../units";

// ---------------------------------------------------------------------------
// Scene grouping (pure)

function cue(text: string, startSec: number, endSec: number) {
  return { text, startSec, endSec };
}

describe("groupCuesIntoScenes", () => {
  it("partitions cues into contiguous scenes of roughly equal duration", () => {
    const cues = [
      cue("a", 0, 2),
      cue("b", 2.25, 4.25),
      cue("c", 4.5, 6.5),
      cue("d", 6.75, 8.75),
    ];
    const scenes = groupCuesIntoScenes(cues, 9, 2);
    expect(scenes).toHaveLength(2);
    expect(scenes[0]).toMatchObject({ firstCue: 0, lastCue: 1 });
    expect(scenes[1]).toMatchObject({ firstCue: 2, lastCue: 3 });
    // Scenes tile the full track with no gaps.
    expect(scenes[0]!.durationSec + scenes[1]!.durationSec).toBeCloseTo(9, 3);
    expect(scenes[0]!.text).toBe("a b");
  });

  it("never returns more scenes than cues", () => {
    const cues = [cue("only", 0, 3)];
    const scenes = groupCuesIntoScenes(cues, 3.5, 8);
    expect(scenes).toHaveLength(1);
    expect(scenes[0]!.durationSec).toBeCloseTo(3.5, 3);
  });

  it("gives every scene at least one cue even with lopsided timing", () => {
    const cues = [cue("a", 0, 8), cue("b", 8.25, 8.9), cue("c", 9.1, 9.8)];
    const scenes = groupCuesIntoScenes(cues, 10, 3);
    expect(scenes).toHaveLength(3);
    expect(scenes.map((s) => s.firstCue)).toEqual([0, 1, 2]);
  });
});

describe("clipDurationForScene", () => {
  it("picks the provider length that covers the scene with least excess", () => {
    expect(clipDurationForScene(3.2)).toBe(5);
    expect(clipDurationForScene(6.5)).toBe(8);
    expect(clipDurationForScene(9.1)).toBe(10);
    expect(clipDurationForScene(14)).toBe(10); // compositor loops the tail
  });
});

describe("videoJobUnits", () => {
  it("bills one unit per scene for character story videos only", () => {
    expect(videoJobUnits("text_to_video", { aspectRatio: "9:16", characterId: 3 })).toBe(1);
    expect(videoJobUnits("topic_to_video", { aspectRatio: "9:16", visualsSource: "stock" })).toBe(1);
    expect(
      videoJobUnits("topic_to_video", {
        aspectRatio: "9:16",
        visualsSource: "character",
        paragraphCount: 2,
      }),
    ).toBe(2 * CHARACTER_SCENES_PER_PARAGRAPH);
    expect(
      videoJobUnits("topic_to_video", {
        aspectRatio: "9:16",
        visualsSource: "character",
        paragraphCount: 99,
      }),
    ).toBe(3 * CHARACTER_SCENES_PER_PARAGRAPH);
  });
});

// ---------------------------------------------------------------------------
// Scene planning (LLM mocked)

const planState = vi.hoisted(() => ({
  response: "" as string,
  lastPrompt: "" as string,
}));
vi.mock("../../textGen", () => ({
  getTextGenClient: vi.fn(async () => ({
    provider: "builtin",
    model: "gpt-test",
    client: {
      chat: {
        completions: {
          create: vi.fn(async (args: { messages: { content: string }[] }) => {
            planState.lastPrompt = args.messages[1]!.content;
            return { choices: [{ message: { content: planState.response } }] };
          }),
        },
      },
    },
  })),
}));

const sceneGenState = vi.hoisted(() => ({
  keyframes: [] as { visual: string; outfitId: number }[],
  animated: [] as string[],
  loadedRefs: [] as string[],
}));
vi.mock("../../characters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../characters")>();
  return {
    ...actual,
    loadReferenceImage: vi.fn(async (path: string) => {
      sceneGenState.loadedRefs.push(path);
      return { buffer: Buffer.from("ref"), mimeType: "image/png" };
    }),
    generateSceneKeyframe: vi.fn(
      async (_c: Character, outfit: CharacterOutfit, visual: string) => {
        sceneGenState.keyframes.push({ visual, outfitId: outfit.id });
        return { buffer: Buffer.from(`kf-${visual}`), provider: "openai", model: "gpt-image-1" };
      },
    ),
  };
});
vi.mock("../index", () => ({
  generateVideo: vi.fn(async (input: { prompt: string }) => {
    sceneGenState.animated.push(input.prompt);
    return { buffer: Buffer.from("clip"), provider: "replicate", model: "wan-i2v" };
  }),
}));

const character = {
  id: 1,
  tenantId: 1,
  name: "Maya",
  description: "cheerful founder",
  referenceImagePath: "/objects/1/uploads/maya.png",
} as Character;
const outfits = [
  {
    id: 10,
    tenantId: 1,
    characterId: 1,
    name: "Default",
    description: "casual",
    referenceImagePath: "/objects/1/uploads/maya.png",
    isDefault: true,
  },
  {
    id: 11,
    tenantId: 1,
    characterId: 1,
    name: "Gym wear",
    description: "leggings",
    referenceImagePath: "/objects/1/uploads/maya-gym.png",
    isDefault: false,
  },
] as CharacterOutfit[];

beforeEach(() => {
  planState.response = "";
  planState.lastPrompt = "";
  sceneGenState.keyframes.length = 0;
  sceneGenState.animated.length = 0;
  sceneGenState.loadedRefs.length = 0;
});

describe("planSceneVisuals", () => {
  const scenes = [
    { firstCue: 0, lastCue: 0, durationSec: 4, text: "Morning starts early." },
    { firstCue: 1, lastCue: 1, durationSec: 4, text: "Then a hard workout." },
  ];

  it("keeps valid outfit assignments and passes wardrobe notes to the model", async () => {
    planState.response = JSON.stringify({
      scenes: [
        { visual: "waking up by a window", outfitId: 10 },
        { visual: "lifting weights", outfitId: 11 },
      ],
    });
    const { plan, rawPlan } = await planSceneVisuals({
      tenantAiModel: "gpt-test",
      topic: "founder life",
      character,
      outfits,
      lockedOutfitId: 10,
      wardrobeNotes: "gym wear for the workout",
      scenes,
    });
    expect(plan).toEqual([
      { visual: "waking up by a window", outfitId: 10 },
      { visual: "lifting weights", outfitId: 11 },
    ]);
    // The untouched AI reply is surfaced so it can be stored for audit.
    expect(rawPlan).toEqual({
      scenes: [
        { visual: "waking up by a window", outfitId: 10 },
        { visual: "lifting weights", outfitId: 11 },
      ],
    });
    expect(planState.lastPrompt).toContain("gym wear for the workout");
    expect(planState.lastPrompt).toContain("Maya");
  });

  it("forces the locked outfit on every scene when the user gave no wardrobe notes", async () => {
    // The director returned a *valid* costume change for scene two. With no
    // wardrobe instructions from the user, uniformity wins regardless.
    planState.response = JSON.stringify({
      scenes: [
        { visual: "waking up by a window", outfitId: 10 },
        { visual: "lifting weights", outfitId: 11 },
      ],
    });
    const { plan, rawPlan } = await planSceneVisuals({
      tenantAiModel: "gpt-test",
      topic: "founder life",
      character,
      outfits,
      lockedOutfitId: 10,
      wardrobeNotes: "   ", // whitespace is no instruction at all
      scenes,
    });
    expect(plan.map((p) => p.outfitId)).toEqual([10, 10]);
    // Only the costume is pinned; the planned visuals still come through.
    expect(plan.map((p) => p.visual)).toEqual(["waking up by a window", "lifting weights"]);
    // The raw plan keeps the model's original (overridden) outfit choice.
    expect(rawPlan).not.toBeNull();
  });

  it("tells the director the costume is fixed unless the user asked otherwise", async () => {
    planState.response = JSON.stringify({ scenes: [] });
    await planSceneVisuals({
      tenantAiModel: "gpt-test",
      topic: "founder life",
      character,
      outfits,
      lockedOutfitId: 10,
      wardrobeNotes: "",
      scenes,
    });
    expect(planState.lastPrompt).toContain('"outfitId" must be exactly 10 for every scene');
    expect(planState.lastPrompt).not.toContain("Wardrobe instructions from the user");

    await planSceneVisuals({
      tenantAiModel: "gpt-test",
      topic: "founder life",
      character,
      outfits,
      lockedOutfitId: 10,
      wardrobeNotes: "gym wear for the workout",
      scenes,
    });
    expect(planState.lastPrompt).toContain(
      "change it only where the wardrobe instructions below explicitly call for a change",
    );
    expect(planState.lastPrompt).toContain("Wardrobe instructions from the user");
  });

  it("falls back to the locked outfit and scene text on a bad response", async () => {
    planState.response = JSON.stringify({
      scenes: [{ visual: "", outfitId: 999 }],
    });
    const { plan, rawPlan } = await planSceneVisuals({
      tenantAiModel: "gpt-test",
      topic: "founder life",
      character,
      outfits,
      lockedOutfitId: 10,
      wardrobeNotes: "",
      scenes,
    });
    expect(plan).toHaveLength(2);
    expect(plan[0]).toEqual({ visual: "Morning starts early.", outfitId: 10 });
    expect(plan[1]).toEqual({ visual: "Then a hard workout.", outfitId: 10 });
    expect(rawPlan).toEqual({ scenes: [{ visual: "", outfitId: 999 }] });
  });

  it("follows a supplied plan without calling the model, still enforcing the costume lock", async () => {
    // No model response is seeded: if reuse consulted the LLM, parsing "" would
    // wipe the plan — the assertions below prove it never did.
    const supplied = {
      scenes: [
        { visual: "waking up by a window", outfitId: 10 },
        { visual: "lifting weights", outfitId: 11 },
      ],
    };
    const { plan, rawPlan } = await planSceneVisuals({
      tenantAiModel: "gpt-test",
      topic: "founder life",
      character,
      outfits,
      lockedOutfitId: 10,
      wardrobeNotes: "", // no instructions → costume locked, whatever the plan says
      scenes,
      suppliedPlan: supplied,
    });
    expect(plan.map((p) => p.visual)).toEqual(["waking up by a window", "lifting weights"]);
    // A hand-edited plan cannot change the character's clothes: uniformity wins.
    expect(plan.map((p) => p.outfitId)).toEqual([10, 10]);
    expect(rawPlan).toEqual(supplied);
  });

  it("honors a supplied plan's costume changes only with wardrobe notes, clamping unknown outfits", async () => {
    const { plan } = await planSceneVisuals({
      tenantAiModel: "gpt-test",
      topic: "founder life",
      character,
      outfits,
      lockedOutfitId: 10,
      wardrobeNotes: "gym wear for the workout",
      scenes,
      suppliedPlan: {
        scenes: [
          { visual: "waking up", outfitId: 999 }, // not in the wardrobe → locked outfit
          { visual: "lifting weights", outfitId: 11 },
        ],
      },
    });
    expect(plan.map((p) => p.outfitId)).toEqual([10, 11]);
  });

  it("rejects a supplied plan with no scenes instead of silently falling back", async () => {
    await expect(
      planSceneVisuals({
        tenantAiModel: "gpt-test",
        topic: "founder life",
        character,
        outfits,
        lockedOutfitId: 10,
        wardrobeNotes: "",
        scenes,
        suppliedPlan: { notes: "no scenes here" },
      }),
    ).rejects.toThrow(/saved plan/i);
  });
});

describe("generateCharacterSceneClips", () => {
  it("anchors every scene to its outfit reference and animates the keyframe", async () => {
    const scenes = [
      { firstCue: 0, lastCue: 1, durationSec: 6.2, text: "one" },
      { firstCue: 2, lastCue: 3, durationSec: 7.1, text: "two" },
    ];
    const result = await generateCharacterSceneClips({
      tenantId: 1,
      character,
      outfits,
      plan: [
        { visual: "waking up", outfitId: 10 },
        { visual: "lifting weights", outfitId: 11 },
      ],
      scenes,
      aspectRatio: "9:16",
    });
    expect(result.clips).toHaveLength(2);
    expect(result.sceneMap).toEqual([
      { clipIndex: 0, durationSec: 6.2 },
      { clipIndex: 1, durationSec: 7.1 },
    ]);
    expect(result.provider).toBe("replicate");
    // Each worn outfit's reference is loaded exactly once.
    expect(sceneGenState.loadedRefs.sort()).toEqual([
      "/objects/1/uploads/maya-gym.png",
      "/objects/1/uploads/maya.png",
    ]);
    // The keyframes carry the planned outfits.
    expect(sceneGenState.keyframes.map((k) => k.outfitId).sort()).toEqual([10, 11]);
  });
});
