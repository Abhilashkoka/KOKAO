import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// The unit under test only needs these modules' seams, not their real
// backends: the builtin client is a fake, price lookups are stubbed (the
// pricing-gate test flips them), and the admin alert is captured.
vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: { chat: { completions: { create: vi.fn() } } },
}));
vi.mock("./aiCost", () => ({
  findModelPrice: vi.fn(async () => ({ id: 1 })),
}));
vi.mock("./notifications", () => ({
  notifyTextGenFailover: vi.fn(async () => {}),
  resolveTextGenFailoverNotifications: vi.fn(async () => {}),
}));

import type OpenAI from "openai";
import { findModelPrice } from "./aiCost";
import {
  notifyTextGenFailover,
  resolveTextGenFailoverNotifications,
} from "./notifications";
import {
  isProviderHealthy,
  recordProviderFailure,
  resetProviderHealthForTests,
} from "./providerHealth";
import { TextGenNotConfiguredError, type TextGenClient } from "./textGen";
import {
  isTransientTextGenError,
  resolveTextGenFailoverCandidate,
  resetTextGenFailoverNotifyThrottleForTests,
  textGenHealthKey,
  withTextGenFailover,
  type FailoverCandidate,
} from "./textGenFailover";

const mockFindModelPrice = vi.mocked(findModelPrice);
const mockNotify = vi.mocked(notifyTextGenFailover);

function statusError(status: number, message = `upstream ${status}`): Error {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

function fakeClient(create: (...args: unknown[]) => Promise<unknown>): OpenAI {
  return { chat: { completions: { create } } } as unknown as OpenAI;
}

function primaryOf(create: (...args: unknown[]) => Promise<unknown>): TextGenClient {
  return { client: fakeClient(create), provider: "openrouter", model: "openai/gpt-4o-mini" };
}

function nvidiaPrimaryOf(
  create: (...args: unknown[]) => Promise<unknown>,
  capability: "text" | "multimodal",
): TextGenClient {
  return { client: fakeClient(create), provider: "nvidia", model: "nvidia-model", capability };
}

function candidateOf(
  create: (...args: unknown[]) => Promise<unknown>,
): FailoverCandidate {
  return { client: fakeClient(create), provider: "builtin", model: "gpt-5.4" };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetProviderHealthForTests();
  resetTextGenFailoverNotifyThrottleForTests();
  mockFindModelPrice.mockResolvedValue({ id: 1 } as never);
});

afterAll(() => {
  resetProviderHealthForTests();
  resetTextGenFailoverNotifyThrottleForTests();
});

describe("isTransientTextGenError", () => {
  it("treats 429/5xx and network-level failures as transient", () => {
    expect(isTransientTextGenError(statusError(429))).toBe(true);
    expect(isTransientTextGenError(statusError(500))).toBe(true);
    expect(isTransientTextGenError(statusError(503))).toBe(true);
    const conn = new Error("Connection error.");
    conn.name = "APIConnectionError";
    expect(isTransientTextGenError(conn)).toBe(true);
    expect(isTransientTextGenError(new TypeError("fetch failed"))).toBe(true);
    expect(isTransientTextGenError(new Error("socket hang up ECONNRESET"))).toBe(true);
  });

  it("treats 4xx, misconfiguration, and plain errors as permanent", () => {
    expect(isTransientTextGenError(statusError(400))).toBe(false);
    expect(isTransientTextGenError(statusError(401))).toBe(false);
    expect(isTransientTextGenError(statusError(404))).toBe(false);
    expect(isTransientTextGenError(statusError(410, "NVIDIA model retired"))).toBe(false);
    expect(isTransientTextGenError(new TextGenNotConfiguredError("no key"))).toBe(false);
    expect(isTransientTextGenError(new Error("prediction failed: bad prompt"))).toBe(false);
  });
});

describe("resolveTextGenFailoverCandidate", () => {
  it("never offers a candidate when builtin itself is the primary", async () => {
    expect(await resolveTextGenFailoverCandidate("builtin", "gpt-5.4")).toBeNull();
  });

  it("offers builtin with the tenant model mapped through the approved list", async () => {
    const candidate = await resolveTextGenFailoverCandidate(
      "openrouter",
      "openai/gpt-4o-mini",
    );
    expect(candidate).not.toBeNull();
    expect(candidate!.provider).toBe("builtin");
    // Unknown-to-builtin model falls back to the approved default.
    expect(candidate!.model).toBe("gpt-5.4");
    expect(mockFindModelPrice).toHaveBeenCalledWith("text", "builtin", "gpt-5.4");
  });

  it("pricing gate: no price row for the substitute means no failover", async () => {
    mockFindModelPrice.mockResolvedValue(null as never);
    expect(
      await resolveTextGenFailoverCandidate("openrouter", "openai/gpt-4o-mini"),
    ).toBeNull();
  });

  it("no candidate while the builtin breaker itself is open", async () => {
    for (let i = 0; i < 3; i += 1) {
      recordProviderFailure(textGenHealthKey("builtin"), "down");
    }
    expect(
      await resolveTextGenFailoverCandidate("openrouter", "openai/gpt-4o-mini"),
    ).toBeNull();
  });
});

describe("withTextGenFailover", () => {
  it("keeps NVIDIA text and multimodal breaker failures isolated", async () => {
    const text = withTextGenFailover(
      nvidiaPrimaryOf(async () => {
        throw statusError(503, "text outage");
      }, "text"),
      "m",
      { resolveCandidate: async () => null },
    );
    const multimodalCreate = vi.fn(async () => ({ from: "vision" }));
    const multimodal = withTextGenFailover(
      nvidiaPrimaryOf(multimodalCreate, "multimodal"),
      "m",
      { resolveCandidate: async () => null },
    );

    for (let i = 0; i < 3; i += 1) {
      await expect(
        text.client.chat.completions.create({ model: text.model, messages: [] } as never),
      ).rejects.toThrow("text outage");
    }
    expect(isProviderHealthy(textGenHealthKey("nvidia", "text"))).toBe(false);
    expect(isProviderHealthy(textGenHealthKey("nvidia", "multimodal"))).toBe(true);

    await expect(
      multimodal.client.chat.completions.create({ model: multimodal.model, messages: [] } as never),
    ).resolves.toEqual({ from: "vision" });
    expect(multimodalCreate).toHaveBeenCalledTimes(1);
  });

  it("does not open NVIDIA text breaker after multimodal failures", async () => {
    const vision = withTextGenFailover(
      nvidiaPrimaryOf(async () => {
        throw statusError(503, "vision outage");
      }, "multimodal"),
      "m",
      { resolveCandidate: async () => null },
    );
    for (let i = 0; i < 3; i += 1) {
      await expect(
        vision.client.chat.completions.create({ model: vision.model, messages: [] } as never),
      ).rejects.toThrow("vision outage");
    }
    expect(isProviderHealthy(textGenHealthKey("nvidia", "multimodal"))).toBe(false);
    expect(isProviderHealthy(textGenHealthKey("nvidia", "text"))).toBe(true);
  });

  it("serves via the candidate on a transient primary failure and rebinds cost attribution", async () => {
    const primaryCreate = vi.fn(async () => {
      throw statusError(503);
    });
    const candidateCreate = vi.fn(async () => ({ ok: true }));
    const candidate = candidateOf(candidateCreate);
    const wrapped = withTextGenFailover(primaryOf(primaryCreate), "openai/gpt-4o-mini", {
      resolveCandidate: async () => candidate,
    });

    const result = await wrapped.client.chat.completions.create({
      model: wrapped.model,
      messages: [],
      // What an OpenRouter-primary call site actually sends:
      usage: { include: true },
      stream_options: { include_usage: true },
    } as never);

    expect(result).toEqual({ ok: true });
    expect(primaryCreate).toHaveBeenCalledTimes(1);
    // The substitute call carries the substitute's model.
    expect((candidateCreate.mock.calls[0] as unknown[])[0]).toMatchObject({
      model: "gpt-5.4",
    });
    // OpenRouter-only usage-accounting param must be stripped for builtin,
    // while portable params (stream_options) survive.
    expect((candidateCreate.mock.calls[0] as unknown[])[0]).not.toHaveProperty("usage");
    expect((candidateCreate.mock.calls[0] as unknown[])[0]).toMatchObject({
      stream_options: { include_usage: true },
    });
    // Cost tracking must record who actually served the request.
    expect(wrapped.provider).toBe("builtin");
    expect(wrapped.model).toBe("gpt-5.4");
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify.mock.calls[0]![0]).toMatchObject({
      fromProvider: "openrouter",
      toProvider: "builtin",
      model: "gpt-5.4",
    });
  });

  it("does NOT fail over on a permanent error", async () => {
    const primaryCreate = vi.fn(async () => {
      throw statusError(400, "bad request");
    });
    const resolveCandidate = vi.fn(async () => candidateOf(vi.fn()));
    const wrapped = withTextGenFailover(primaryOf(primaryCreate), "m", {
      resolveCandidate,
    });

    await expect(
      wrapped.client.chat.completions.create({ model: wrapped.model, messages: [] } as never),
    ).rejects.toThrow("bad request");
    expect(resolveCandidate).not.toHaveBeenCalled();
    expect(wrapped.provider).toBe("openrouter");
    expect(mockNotify).not.toHaveBeenCalled();
    // Permanent errors never trip the breaker either.
    expect(isProviderHealthy(textGenHealthKey("openrouter"))).toBe(true);
  });

  it("surfaces the original outage when no healthy configured alternative exists", async () => {
    const primaryCreate = vi.fn(async () => {
      throw statusError(503, "primary down");
    });
    const wrapped = withTextGenFailover(primaryOf(primaryCreate), "m", {
      resolveCandidate: async () => null,
    });

    await expect(
      wrapped.client.chat.completions.create({ model: wrapped.model, messages: [] } as never),
    ).rejects.toThrow("primary down");
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("surfaces the primary outage when the candidate also fails, recording its health", async () => {
    const primaryCreate = vi.fn(async () => {
      throw statusError(503, "primary down");
    });
    const candidateCreate = vi.fn(async () => {
      throw statusError(500, "candidate down");
    });
    const wrapped = withTextGenFailover(primaryOf(primaryCreate), "m", {
      resolveCandidate: async () => candidateOf(candidateCreate),
    });

    await expect(
      wrapped.client.chat.completions.create({ model: wrapped.model, messages: [] } as never),
    ).rejects.toThrow("primary down");
    expect(wrapped.provider).toBe("openrouter");
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("diverts immediately (no primary attempt) while the primary breaker is open", async () => {
    for (let i = 0; i < 3; i += 1) {
      recordProviderFailure(textGenHealthKey("openrouter"), "down");
    }
    const primaryCreate = vi.fn(async () => ({ from: "primary" }));
    const candidateCreate = vi.fn(async () => ({ from: "candidate" }));
    const wrapped = withTextGenFailover(primaryOf(primaryCreate), "m", {
      resolveCandidate: async () => candidateOf(candidateCreate),
    });

    const result = await wrapped.client.chat.completions.create({
      model: wrapped.model,
      messages: [],
    } as never);
    expect(result).toEqual({ from: "candidate" });
    expect(primaryCreate).not.toHaveBeenCalled();
  });

  it("notifies the admin only once per outage window across repeated failovers", async () => {
    const primaryCreate = vi.fn(async () => {
      throw statusError(503);
    });
    const candidateCreate = vi.fn(async () => ({ ok: true }));
    const wrapped = withTextGenFailover(primaryOf(primaryCreate), "m", {
      resolveCandidate: async () => candidateOf(candidateCreate),
    });

    for (let i = 0; i < 4; i += 1) {
      await wrapped.client.chat.completions.create({
        model: wrapped.model,
        messages: [],
      } as never);
    }
    expect(candidateCreate).toHaveBeenCalledTimes(4);
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  it("clears the failover alert and re-arms the throttle when the primary recovers", async () => {
    const mockResolve = vi.mocked(resolveTextGenFailoverNotifications);
    let fail = true;
    const primaryCreate = vi.fn(async () => {
      if (fail) throw statusError(503);
      return { from: "primary" };
    });
    const candidateCreate = vi.fn(async () => ({ ok: true }));
    const wrapped = withTextGenFailover(primaryOf(primaryCreate), "m", {
      resolveCandidate: async () => candidateOf(candidateCreate),
    });
    const call = () =>
      wrapped.client.chat.completions.create({ model: "x", messages: [] } as never);

    await call(); // outage → failover + alert
    expect(mockNotify).toHaveBeenCalledTimes(1);

    fail = false;
    await call(); // recovery → banner cleared, throttle re-armed
    await vi.waitFor(() => expect(mockResolve).toHaveBeenCalledTimes(1));
    // Scoped to the recovered provider only.
    expect(mockResolve).toHaveBeenCalledWith("openrouter");

    fail = true;
    await call(); // fresh outage → fresh alert despite the earlier one
    expect(mockNotify).toHaveBeenCalledTimes(2);
  });
});
