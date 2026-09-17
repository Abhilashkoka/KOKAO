import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const create = vi.hoisted(() => vi.fn());
const buildTextCostMeta = vi.hoisted(() => vi.fn());
const recordUsage = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: { chat: { completions: { create } } },
}));
vi.mock("./aiCost", () => ({ buildTextCostMeta }));
vi.mock("./usage", () => ({ recordUsage }));
vi.mock("./logger", () => ({ logger: { warn, error: vi.fn() } }));

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
        finish_reason: "stop",
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
    warn.mockReset();
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
    ).rejects.toMatchObject({ kind: "malformed" });
  });

  const sheet = {
    decision: "accept", panelCount: 5, allPanelsSingleSubject: true,
    sameIdentity: true, designConsistent: true,
  };
  const sheetOptions = {
    mode: "sheet" as const, approvedPrimary: primary,
    meterContext: { tenantId: 44, operationKey: "guided:44:7:sheet" },
  };

  it("uses a bounded reasoning-inclusive budget and the compatible JSON contract", async () => {
    create.mockResolvedValue(completion(sheet));
    await validateCharacterImageOutput(candidate, sheetOptions);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      max_completion_tokens: 4096,
      response_format: { type: "json_object" },
    }), expect.objectContaining({ maxRetries: 0 }));
  });

  it.each([
    ["parseable truncated accept", { choices: [{ ...completion(sheet).choices[0], finish_reason: "length" }] }, "truncated"],
    ["empty exhausted budget", { choices: [{ finish_reason: "length", message: { content: null } }] }, "truncated"],
    ["refusal with passing text", { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(sheet), refusal: "private refusal" } }] }, "refused"],
    ["filtered passing text", { choices: [{ ...completion(sheet).choices[0], finish_reason: "content_filter" }] }, "refused"],
    ["refusal part with passing text", { choices: [{ finish_reason: "stop", message: { content: [{ type: "text", text: JSON.stringify(sheet) }, { type: "refusal", refusal: "private" }] } }] }, "refused"],
    ["null content", { choices: [{ finish_reason: "stop", message: { content: null } }] }, "empty"],
    ["blank content", completion("  "), "empty"],
    ["missing content", { choices: [{ finish_reason: "stop", message: {} }] }, "empty"],
    ["no choices", { choices: [] }, "malformed"],
    ["multiple choices", { choices: [completion(sheet).choices[0], completion(sheet).choices[0]] }, "malformed"],
    ["missing finish reason", { choices: [{ message: { content: JSON.stringify(sheet) } }] }, "malformed"],
    ["tool call", { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(sheet), tool_calls: [] } }] }, "malformed"],
    ["unknown finish reason", { choices: [{ ...completion(sheet).choices[0], finish_reason: "private text" }] }, "malformed"],
    ["malformed JSON", completion('{"decision":"accept"'), "malformed"],
    ["prose plus valid JSON", completion(`Here: ${JSON.stringify(sheet)}`), "malformed"],
    ["two JSON objects", completion(`${JSON.stringify(sheet)}${JSON.stringify(sheet)}`), "malformed"],
    ["duplicate decision", completion(`{"decision":"reject",${JSON.stringify(sheet).slice(1)}`), "malformed"],
    ["conflicting alias", completion({ ...sheet, verdict: "reject" }), "malformed"],
    ["string boolean", completion({ ...sheet, sameIdentity: "true" }), "malformed"],
    ["fractional count", completion({ ...sheet, panelCount: 5.5 }), "malformed"],
    ["missing check", completion({ decision: "accept", panelCount: 5 }), "malformed"],
    ["invalid decision", completion({ ...sheet, decision: "maybe" }), "malformed"],
    ["uncertain decision", completion({ ...sheet, decision: "uncertain" }), "uncertain"],
    ["visual panel failure", completion({ ...sheet, panelCount: 4 }), "invalid"],
    ["visual identity failure", completion({ ...sheet, sameIdentity: false }), "invalid"],
    ["visual design failure", completion({ ...sheet, designConsistent: false }), "invalid"],
    ["visual subjects failure", completion({ ...sheet, allPanelsSingleSubject: false }), "invalid"],
  ])("rejects %s and captures received-response cost without retries", async (_name, response, kind) => {
    create.mockResolvedValue(response);
    await expect(validateCharacterImageOutput(candidate, sheetOptions)).rejects.toMatchObject({ kind });
    expect(create).toHaveBeenCalledTimes(1);
    expect(buildTextCostMeta).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledWith(44, "image", expect.objectContaining({ funding: "unmetered" }));
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "character_visual_qa_failed", kind, mode: "sheet", tenantId: 44,
    }), "character visual QA failed");
  });

  it("accepts one complete text part but never combines ambiguous parts", async () => {
    const content = [{ type: "text", text: JSON.stringify(sheet) }];
    create.mockResolvedValue({ choices: [{ finish_reason: "stop", message: { content } }] });
    await expect(validateCharacterImageOutput(candidate, sheetOptions)).resolves.toBeUndefined();
    content.push({ type: "text", text: "" });
    await expect(validateCharacterImageOutput(candidate, sheetOptions)).rejects.toMatchObject({ kind: "malformed" });
  });

  it("logs only bounded metadata and hashed identifiers, not private response content", async () => {
    const privateText = "private prompt image refusal credential";
    create.mockResolvedValue({
      id: privateText, _request_id: privateText,
      choices: [{ finish_reason: "stop", message: { content: privateText } }],
    });
    await expect(validateCharacterImageOutput(candidate, {
      ...sheetOptions, meterContext: { tenantId: 44, operationKey: privateText },
    })).rejects.toMatchObject({ kind: "malformed", cause: undefined });
    const hash = createHash("sha256").update(privateText).digest("hex");
    expect(warn).toHaveBeenCalledWith({
      event: "character_visual_qa_failed", kind: "malformed", mode: "sheet",
      model: "gpt-5.6-luna", tenantId: 44, operationKeyHash: hash,
      requestIdHash: hash, completionIdHash: hash, finishReason: "stop",
      choiceCount: 1, contentLength: privateText.length,
    }, "character visual QA failed");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(privateText);
  });

  it("sanitizes transport errors and records timeout metadata without inventing usage", async () => {
    create.mockRejectedValue(new Error("secret transport body"));
    await expect(validateCharacterImageOutput(candidate, sheetOptions))
      .rejects.toMatchObject({ kind: "unavailable", cause: undefined });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
    expect(recordUsage).not.toHaveBeenCalled();
    create.mockImplementation(() => new Promise(() => {}));
    await expect(validateCharacterImageOutput(candidate, { ...sheetOptions, timeoutMs: 1 }))
      .rejects.toMatchObject({ kind: "timeout" });
    expect(warn).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: "timeout", operationKeyHash: expect.any(String), finishReason: "missing",
    }), "character visual QA failed");
  });

  it("keeps telemetry and logging best effort without leaking their errors", async () => {
    buildTextCostMeta.mockRejectedValue(new Error("secret telemetry body"));
    create.mockResolvedValue(completion(sheet));
    await expect(validateCharacterImageOutput(candidate, sheetOptions)).resolves.toBeUndefined();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
    warn.mockImplementation(() => { throw new Error("logging failed"); });
    create.mockResolvedValue(completion(""));
    await expect(validateCharacterImageOutput(candidate, sheetOptions)).rejects.toMatchObject({ kind: "empty" });
  });
});