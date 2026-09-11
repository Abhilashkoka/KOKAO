import { beforeEach, describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";

const meterMock = vi.hoisted(() => vi.fn());

vi.mock("./meter", () => ({
  meter: meterMock,
}));

import { withTextMeter } from "./textMeter";

describe("withTextMeter", () => {
  beforeEach(() => {
    meterMock.mockReset();
    meterMock.mockImplementation(async (_ctx, _key, _quantity, fn, reportedFrom) => {
      const result = await fn();
      reportedFrom?.(result);
      return result;
    });
  });

  it("meters every provider create with attribution and a stable action-derived key", async () => {
    const create = vi.fn(async () => ({
      choices: [],
      usage: { completion_tokens: 17 },
    }));
    const client = {
      chat: { completions: { create } },
    } as unknown as OpenAI;

    const metered = withTextMeter(
      client,
      {
        tenantId: 42,
        refKind: "videoJob",
        refId: "9",
        operationKey: "script:9",
      },
      "openrouter",
      "vendor/model",
    );

    await metered.chat.completions.create({ model: "vendor/model", messages: [] });

    expect(create).toHaveBeenCalledTimes(1);
    expect(meterMock).toHaveBeenCalledWith(
      {
        tenantId: 42,
        refKind: "videoJob",
        refId: "9",
        provider: "openrouter",
        model: "vendor/model",
        operationKey: "script:9:text:1",
        operationFamilyKey: "script:9:text:1",
      },
      "caption",
      1,
      expect.any(Function),
      expect.any(Function),
    );
  });

  it("explicit null bypasses workspace attribution while retaining the boundary", async () => {
    const create = vi.fn(async () => ({ choices: [] }));
    const client = {
      chat: { completions: { create } },
    } as unknown as OpenAI;

    const metered = withTextMeter(client, null, "builtin", "gpt-5.4");
    await metered.chat.completions.create({ model: "gpt-5.4", messages: [] });

    expect(meterMock.mock.calls[0]?.slice(0, 3)).toEqual([null, "caption", 1]);
  });
});