import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.hoisted(() => vi.fn());
const buildTextCostMeta = vi.hoisted(() => vi.fn());
const recordUsage = vi.hoisted(() => vi.fn());

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: { chat: { completions: { create } } },
}));
vi.mock("./aiCost", () => ({ buildTextCostMeta }));
vi.mock("./usage", () => ({ recordUsage }));
vi.mock("./logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

const {
  CharacterVisualQaError,
  parseCharacterVisualQaResponse,
  validateCharacterImageOutput,
} = await import("./characterVisualQa");

const candidate = { buffer: Buffer.from("candidate"), mimeType: "image/png" as const };
const primary = { buffer: Buffer.from("primary"), mimeType: "image/png" as const };

function completion(value: object | string) {
  return {
    choices: [
      {
        message: {
          content: typeof value === "string" ? value : JSON.stringify(value),
        },
      },
    ],
  };
}

describe("character visual QA", () => {
  beforeEach(() => {
    create.mockReset();
    buildTextCostMeta.mockReset();
    recordUsage.mockReset();
    buildTextCostMeta.mockResolvedValue({
      provider: "openai",
      inputTokens: 11,
      outputTokens: 7,
      costPaise: 3,
    });
  });
  afterEach(() => vi.useRealTimers());

  it("rejects a primary containing three people", async () => {
    create.mockResolvedValue(
      completion({
        decision: "reject",
        personCount: 3,
        fullBodyVisible: true,
        designConsistent: false,
      }),
    );

    await expect(
      validateCharacterImageOutput(candidate, { mode: "primary" }),
    ).rejects.toMatchObject({ kind: "invalid" });
  });

  it("accepts a primary containing exactly one full-body person", async () => {
    create.mockResolvedValue(
      completion({
        decision: "accept",
        personCount: 1,
        fullBodyVisible: true,
        designConsistent: true,
      }),
    );

    await expect(
      validateCharacterImageOutput(candidate, { mode: "primary" }),
    ).resolves.toBeUndefined();
  });

  it("rejects an unparseable visual QA response", async () => {
    create.mockResolvedValue(completion("not-json"));

    await expect(
      validateCharacterImageOutput(candidate, { mode: "primary" }),
    ).rejects.toMatchObject({ kind: "malformed" });
  });

  it("rejects a visual QA timeout instead of accepting an unverified image", async () => {
    const client = {
      chat: {
        completions: {
          create: (_request: unknown, requestOptions?: { signal?: AbortSignal }) =>
            new Promise<never>((_, reject) => {
              requestOptions?.signal?.addEventListener("abort", () =>
                reject(new Error("aborted")),
              );
            }),
        },
      },
    };

    await expect(
      validateCharacterImageOutput(candidate, { mode: "primary", timeoutMs: 1 }, client),
    ).rejects.toMatchObject({ kind: "timeout" });
  });

  it("aborts the vision request and disables SDK retries", async () => {
    const calls: Array<{ signal?: AbortSignal; maxRetries?: number }> = [];
    const client = {
      chat: {
        completions: {
          create: (
            _request: unknown,
            requestOptions?: { signal?: AbortSignal; maxRetries?: number },
          ) => {
            calls.push(requestOptions ?? {});
            return Promise.resolve(
              completion({
                decision: "accept",
                personCount: 1,
                fullBodyVisible: true,
                designConsistent: true,
              }),
            );
          },
        },
      },
    };

    await validateCharacterImageOutput(candidate, { mode: "primary" }, client);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.maxRetries).toBe(0);
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects a five-panel sheet when the panels show multiple identities", async () => {
    create.mockResolvedValue(
      completion({
        decision: "reject",
        panelCount: 5,
        allPanelsSingleSubject: true,
        sameIdentity: false,
        designConsistent: false,
      }),
    );

    await expect(
      validateCharacterImageOutput(candidate, { mode: "sheet", approvedPrimary: primary }),
    ).rejects.toMatchObject({ kind: "invalid" });
  });

  it("accepts five views of the same identity without naive person-count rejection", async () => {
    create.mockResolvedValue(
      completion({
        decision: "accept",
        panelCount: 5,
        allPanelsSingleSubject: true,
        sameIdentity: true,
        designConsistent: true,
      }),
    );

    await expect(
      validateCharacterImageOutput(candidate, { mode: "sheet", approvedPrimary: primary }),
    ).resolves.toBeUndefined();
  });

  it("records QA usage against the owning operation without customer metering", async () => {
    create.mockResolvedValue({
      ...completion({
        decision: "accept",
        personCount: 1,
        fullBodyVisible: true,
        designConsistent: true,
      }),
      usage: { prompt_tokens: 11, completion_tokens: 7 },
    });

    await validateCharacterImageOutput(candidate, {
      mode: "primary",
      meterContext: { tenantId: 44, operationKey: "character:44:primary" },
    });

    expect(buildTextCostMeta).toHaveBeenCalledWith(
      expect.objectContaining({ usage: { prompt_tokens: 11, completion_tokens: 7 } }),
      { provider: "openai", model: "gpt-5.6-luna" },
    );
    expect(recordUsage).toHaveBeenCalledWith(
      44,
      "image",
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.6-luna",
        inputTokens: 11,
        outputTokens: 7,
        funding: "unmetered",
        idempotencyKey: "character:44:primary:character-visual-qa",
      }),
    );
  });

  it("fails closed for malformed decisions and missing machine fields", async () => {
    expect(() =>
      parseCharacterVisualQaResponse(JSON.stringify({ decision: "maybe" })),
    ).toThrowError(CharacterVisualQaError);
    create.mockResolvedValue(
      completion({ decision: "accept", personCount: 1 }),
    );
    await expect(
      validateCharacterImageOutput(candidate, { mode: "primary" }),
    ).rejects.toMatchObject({ kind: "invalid" });
  });
});