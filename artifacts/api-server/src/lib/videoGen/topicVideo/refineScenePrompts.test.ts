import { beforeEach, describe, expect, it, vi } from "vitest";
import { refineScenePrompts } from "./refineScenePrompts";

const state = vi.hoisted(() => ({
  response: "",
  throws: false,
  governedThrows: false,
  logThrows: false,
  prompt: "",
  system: "",
  logCalls: 0,
}));

vi.mock("../../textGen", () => ({
  getTextGenClient: vi.fn(async () => ({
    provider: "builtin",
    model: "gpt-test",
    client: {
      chat: {
        completions: {
          create: vi.fn(async (args: { messages: { content: string }[] }) => {
            if (state.throws) throw new Error("model unavailable");
            state.system = args.messages[0]!.content;
            state.prompt = args.messages[1]!.content;
            return {
              choices: [{ message: { content: state.response } }],
              usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
            };
          }),
        },
      },
    },
  })),
}));

vi.mock("../../promptKit", () => ({
  getGovernedPrompt: vi.fn(async () => {
    if (state.governedThrows) throw new Error("prompt kit unavailable");
    return { text: "Governed cinematic direction", templateId: 1, versionId: 2 };
  }),
  logCompiledPrompt: vi.fn(async () => {
    state.logCalls += 1;
    if (state.logThrows) throw new Error("log unavailable");
  }),
}));

beforeEach(() => {
  state.response = "";
  state.throws = false;
  state.governedThrows = false;
  state.logThrows = false;
  state.prompt = "";
  state.system = "";
  state.logCalls = 0;
});

describe("refineScenePrompts", () => {
  it("rewrites every prompt with governed cinematic direction", async () => {
    state.response = JSON.stringify({
      prompts: ["polished opening", "polished payoff"],
    });
    const result = await refineScenePrompts({
      tenantAiModel: "gpt-test",
      tenantId: 7,
      prompts: ["plain opening", "plain payoff"],
    });
    expect(result).toEqual(["polished opening", "polished payoff"]);
    expect(state.system).toBe("Governed cinematic direction");
    expect(state.prompt).toContain("framing and lens feel");
    expect(state.prompt).toContain("quality and direction of light");
    expect(state.prompt).toContain("atmosphere, and tactile texture");
    expect(state.logCalls).toBe(1);
  });

  it("falls back per scene when a rewrite is blank or missing", async () => {
    state.response = JSON.stringify({ prompts: [" polished opening ", ""] });
    await expect(
      refineScenePrompts({
        tenantAiModel: "gpt-test",
        prompts: ["plain opening", "plain payoff", "plain coda"],
      }),
    ).resolves.toEqual(["polished opening", "plain payoff", "plain coda"]);
  });

  it("returns the original prompts when refinement or governance fails", async () => {
    const originals = ["plain opening", "plain payoff"];
    state.throws = true;
    await expect(
      refineScenePrompts({ tenantAiModel: "gpt-test", prompts: originals }),
    ).resolves.toEqual(originals);

    state.throws = false;
    state.governedThrows = true;
    await expect(
      refineScenePrompts({ tenantAiModel: "gpt-test", tenantId: 7, prompts: originals }),
    ).resolves.toEqual(originals);
  });

  it("keeps successful rewrites when governed trace logging fails", async () => {
    state.response = JSON.stringify({ prompts: ["polished opening"] });
    state.logThrows = true;
    await expect(
      refineScenePrompts({
        tenantAiModel: "gpt-test",
        tenantId: 7,
        prompts: ["plain opening"],
      }),
    ).resolves.toEqual(["polished opening"]);
  });
});