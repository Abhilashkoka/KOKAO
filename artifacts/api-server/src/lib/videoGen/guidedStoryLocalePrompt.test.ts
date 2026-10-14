import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.hoisted(() => vi.fn());
const governedPrompt = vi.hoisted(() => vi.fn());

vi.mock("../textGen", () => ({
  getTextGenClient: vi.fn(async () => ({
    provider: "test",
    model: "test-model",
    client: { chat: { completions: { create } } },
  })),
}));
vi.mock("../promptKit", () => ({
  getGovernedPrompt: governedPrompt,
  logCompiledPrompt: vi.fn(async () => undefined),
}));

import {
  generateGuidedStorySceneInsertion,
  generateGuidedStoryScript,
  guidedStoryPlatform,
  validateAndRepairGuidedScript,
} from "./guidedStory";

const teluguWords = Array.from({ length: 18 }, () => "మనం").join(" ");

function completion(content: unknown) {
  return {
    choices: [{ message: { content: JSON.stringify(content) } }],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  };
}

describe("Guided Story locale prompt contract", () => {
  beforeEach(() => {
    create.mockReset();
    governedPrompt.mockReset();
    governedPrompt.mockResolvedValue({ text: "Governed story policy." });
  });

  it.each(["visual-only", "dialogue", "cast", "timing"])(
    "accepts only source-preserving product hero reworks (%s)",
    async (change) => {
      const original = {
        title: "Serum",
        logline: "A calm evening routine.",
        roles: [{ id: "role-1", name: "A", description: "A fictional person" }],
        scenes: [{
          id: "scene-1", startMs: 0, endMs: 30_000,
          visualDirection: "A quiet evening routine beside a window.",
          roleIds: ["role-1"], productIds: [],
          shot: { type: "story_wide", camera: "static", lighting: "window_light", angle: null },
          lines: [{
            id: "line-1", kind: "narration", ownerRoleId: null,
            text: "A calm evening routine.", startMs: 0, endMs: 30_000,
          }],
        }],
        warnings: [],
      };
      const reworked = structuredClone(original);
      reworked.scenes[0]!.productIds = ["p1"] as never[];
      reworked.scenes[0]!.roleIds = [];
      reworked.scenes[0]!.shot.type = "product_only";
      reworked.scenes[0]!.visualDirection = "The serum bottle fills the frame, its label sharp.";
      if (change === "dialogue") reworked.scenes[0]!.lines[0]!.text = "Different words for this advertisement.";
      if (change === "cast") reworked.roles[0]!.description = "A different fictional person";
      if (change === "timing") reworked.scenes[0]!.endMs = 29_000;
      create.mockResolvedValueOnce(completion(original)).mockResolvedValueOnce(completion(reworked));
      const result = await generateGuidedStoryScript({
        tenantId: 1, tenantAiModel: "test", genre: "drama",
        platform: guidedStoryPlatform("tiktok")!, durationSeconds: 30,
        maxSceneSeconds: 30, locale: "en", topic: "An evening serum routine",
        brandConstraints: null,
        products: {
          version: 1, promotion: "hero", heroShare: 0.7,
          items: [{
            id: "p1", assetId: 1, name: "Serum", kind: "product",
            description: "Evening serum", aiDescription: "A labeled serum bottle",
            displayMode: "in_scene", imagePath: "/objects/1/uploads/serum",
            imageSha256: "f".repeat(64), mimeType: "image/png",
          }],
        },
      });
      expect(create).toHaveBeenCalledTimes(2);
      expect(result.script.scenes[0]!.shot?.type).toBe(change === "visual-only" ? "product_only" : "story_wide");
      expect(result.script.roles[0]!.description).toBe(original.roles[0]!.description);
      expect(result.script.scenes[0]!.lines[0]!.text).toBe(original.scenes[0]!.lines[0]!.text);
      expect(result.script.scenes[0]!.endMs).toBe(30_000);
      expect(result.inputTokens).toBe(20);
    },
  );

  it("repairs excessive dialogue without rejecting the replacement for sparse speech", async () => {
    const screenplay = (text: string) => ({
      title: "The storm",
      logline: "A character waits for the storm to pass.",
      roles: [{ id: "role-1", name: "A", description: "A fictional person" }],
      scenes: [{
        id: "scene-1",
        startMs: 0,
        endMs: 30_000,
        visualDirection: "A character waits by the window, watching the storm gradually clear.",
        roleIds: ["role-1"],
        lines: [{
          id: "line-1",
          kind: "narration",
          ownerRoleId: null,
          text,
          startMs: 0,
          endMs: 30_000,
        }],
      }],
      warnings: [],
    });
    create
      .mockResolvedValueOnce(completion(screenplay(Array(100).fill("word").join(" "))))
      .mockResolvedValueOnce(completion(screenplay("The storm finally passes.")));

    const result = await generateGuidedStoryScript({
      tenantId: 1,
      tenantAiModel: "test",
      genre: "drama",
      platform: guidedStoryPlatform("tiktok")!,
      durationSeconds: 30,
      maxSceneSeconds: 30,
      locale: "en",
      topic: "A storm clearing",
      brandConstraints: null,
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(result.script.scenes[0]!.lines[0]!.text).toBe("The storm finally passes.");
    expect(result.inputTokens).toBe(20);
    expect(result.outputTokens).toBe(40);
    expect(create.mock.calls[0]![0].messages[1].content).toContain(
      "There is no minimum spoken-word count.",
    );
    const repairPrompt = create.mock.calls[1]![0].messages[1].content;
    expect(repairPrompt).toContain("between 20 and 30 seconds");
    expect(repairPrompt).toContain("100 words");
    expect(repairPrompt).toContain("at most 72 words");
    expect(repairPrompt).toContain("There is no minimum amount of speech");
  });

  it("appends native-writing-system rules to governed full-generation prompts", async () => {
    create.mockResolvedValue(completion({
      title: "కథ",
      logline: "కథ",
      roles: [
        { id: "role-1", name: "A", description: "A fictional person" },
        { id: "role-2", name: "B", description: "A fictional person" },
      ],
      scenes: [{
        id: "scene-opening",
        startMs: 0,
        endMs: 4_000,
        visualDirection: "The ensemble pauses together at the rescue site.",
        roleIds: ["role-1", "role-2"],
        lines: [
          {
            id: "opening-line",
            ownerRoleId: null,
            kind: "narration",
            text: "రక్షణ ఉదయాన్నే మొదలవుతుంది",
            romanizedPronunciation: "Rakshana udayanne modalavutundi",
            englishTranslation: "A rescue begins at dawn.",
            startMs: 0,
            endMs: 4_000,
          },
        ],
      }, {
        id: "scene-1",
        startMs: 4_000,
        endMs: 30_000,
        visualDirection: "A two shot",
        roleIds: ["role-1", "role-2"],
        lines: [
          { id: "line-1", ownerRoleId: "role-1", kind: "dialogue", text: teluguWords, romanizedPronunciation: "manam manam", englishTranslation: "We will go together.", startMs: 4_000, endMs: 17_000 },
          { id: "line-2", ownerRoleId: "role-2", kind: "dialogue", text: teluguWords, romanizedPronunciation: "manam manam", englishTranslation: "We will return safely.", startMs: 17_000, endMs: 30_000 },
        ],
      }],
      warnings: [],
    }));

    const result = await generateGuidedStoryScript({
      tenantId: 1,
      tenantAiModel: "test",
      genre: "drama",
      platform: guidedStoryPlatform("tiktok")!,
      durationSeconds: 30,
      locale: "te",
      topic: "A rescue",
      roleCount: 2,
      brandConstraints: null,
    });

    const request = create.mock.calls[0]![0];
    expect(request.messages[1].content).toContain("Governed story policy.");
    expect(request.messages[1].content).toMatch(/Telugu.*native Telugu script/i);
    expect(request.messages[1].content).toMatch(/Do not Romanize/i);
    expect(request.messages[1].content).toContain("englishTranslation");
    expect(request.messages[1].content).toContain("romanizedPronunciation");
    expect(result.script.scenes[1]!.lines[0]!.romanizedPronunciation).toBe("manam manam");
    expect(result.script.scenes[1]!.lines[0]!.englishTranslation).toBe("We will go together.");
  });

  it("rejects newly generated localized lines without complete display metadata", async () => {
    create.mockResolvedValue(completion({
      title: "కథ",
      logline: "కథ",
      roles: [
        { id: "role-1", name: "A", description: "A fictional person" },
        { id: "role-2", name: "B", description: "A fictional person" },
      ],
      scenes: [{
        id: "scene-opening",
        startMs: 0,
        endMs: 4_000,
        visualDirection: "The ensemble pauses together at the rescue site.",
        roleIds: ["role-1", "role-2"],
        lines: [
          {
            id: "opening-line",
            ownerRoleId: null,
            kind: "narration",
            text: "రక్షణ ఉదయాన్నే మొదలవుతుంది",
            romanizedPronunciation: "Rakshana udayanne modalavutundi",
            englishTranslation: "A rescue begins at dawn.",
            startMs: 0,
            endMs: 4_000,
          },
        ],
      }, {
        id: "scene-1",
        startMs: 4_000,
        endMs: 30_000,
        visualDirection: "A two shot",
        roleIds: ["role-1", "role-2"],
        lines: [
          { id: "line-1", ownerRoleId: "role-1", kind: "dialogue", text: teluguWords, englishTranslation: "We will go together.", startMs: 4_000, endMs: 17_000 },
          { id: "line-2", ownerRoleId: "role-2", kind: "dialogue", text: teluguWords, romanizedPronunciation: "manam manam", englishTranslation: "We will return safely.", startMs: 17_000, endMs: 30_000 },
        ],
      }],
      warnings: [],
    }));

    await expect(generateGuidedStoryScript({
      tenantId: 1,
      tenantAiModel: "test",
      genre: "drama",
      platform: guidedStoryPlatform("tiktok")!,
      durationSeconds: 30,
      locale: "te",
      topic: "A rescue",
      roleCount: 2,
      brandConstraints: null,
    })).rejects.toThrow(/scene 2 line 1.*pronunciation/i);
  });

  it("applies native-script and complete display-metadata rules to scene insertion", async () => {
    const current = validateAndRepairGuidedScript({
      title: "కథ",
      logline: "కథ",
      roles: [
        { id: "role-1", name: "A", description: "A fictional person" },
        { id: "role-2", name: "B", description: "A fictional person" },
      ],
      scenes: [{
        id: "scene-1",
        startMs: 0,
        endMs: 30_000,
        visualDirection: "A two shot",
        roleIds: ["role-1", "role-2"],
        lines: [
          { id: "line-1", ownerRoleId: "role-1", kind: "dialogue", text: teluguWords, startMs: 0, endMs: 15_000 },
          { id: "line-2", ownerRoleId: "role-2", kind: "dialogue", text: teluguWords, startMs: 15_000, endMs: 30_000 },
        ],
      }],
      warnings: [],
    }, { roleCount: 2, durationSeconds: 30 });
    create.mockResolvedValueOnce(completion({
      visualDirection: "A close two shot",
      roleIds: ["role-1"],
      lines: [{ ownerRoleId: "role-1", kind: "dialogue", text: "మనం ఇప్పుడు వెళ్దాం", romanizedPronunciation: "మనం ఇప్పుడు వెళ్దాం", englishTranslation: "Let us go now." }],
    }));
    await expect(generateGuidedStorySceneInsertion({
      tenantId: 1,
      tenantAiModel: "test",
      script: current,
      insertionIndex: 1,
      description: "They decide to leave",
      durationSeconds: 30,
      locale: "te",
    })).rejects.toThrow(/Latin-letter pronunciation/i);

    create.mockResolvedValueOnce(completion({
      visualDirection: "A close two shot",
      roleIds: ["role-1"],
      lines: [{ ownerRoleId: "role-1", kind: "dialogue", text: "మనం ఇప్పుడు వెళ్దాం", romanizedPronunciation: "manam ippudu veldam", englishTranslation: "Let us go now." }],
    }));

    await generateGuidedStorySceneInsertion({
      tenantId: 1,
      tenantAiModel: "test",
      script: current,
      insertionIndex: 1,
      description: "They decide to leave",
      durationSeconds: 30,
      locale: "te",
    });

    expect(create.mock.calls[1]![0].messages[1].content).toMatch(
      /Telugu.*native Telugu script.*Do not Romanize/is,
    );
  });
});