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

  it("appends native-writing-system rules to governed full-generation prompts", async () => {
    create.mockResolvedValue(completion({
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
          { id: "line-1", ownerRoleId: "role-1", kind: "dialogue", text: teluguWords, romanizedPronunciation: "manam manam", englishTranslation: "We will go together.", startMs: 0, endMs: 15_000 },
          { id: "line-2", ownerRoleId: "role-2", kind: "dialogue", text: teluguWords, romanizedPronunciation: "manam manam", englishTranslation: "We will return safely.", startMs: 15_000, endMs: 30_000 },
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
    expect(result.script.scenes[0]!.lines[0]!.romanizedPronunciation).toBe("manam manam");
    expect(result.script.scenes[0]!.lines[0]!.englishTranslation).toBe("We will go together.");
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
        id: "scene-1",
        startMs: 0,
        endMs: 30_000,
        visualDirection: "A two shot",
        roleIds: ["role-1", "role-2"],
        lines: [
          { id: "line-1", ownerRoleId: "role-1", kind: "dialogue", text: teluguWords, englishTranslation: "We will go together.", startMs: 0, endMs: 15_000 },
          { id: "line-2", ownerRoleId: "role-2", kind: "dialogue", text: teluguWords, romanizedPronunciation: "manam manam", englishTranslation: "We will return safely.", startMs: 15_000, endMs: 30_000 },
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
    })).rejects.toThrow(/scene 1 line 1.*pronunciation/i);
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