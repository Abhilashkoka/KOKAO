import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * buildProviderHealthReport: pure read over in-memory breaker state plus the
 * stored selections. Selections and the failover candidate are mocked so the
 * report shape is deterministic regardless of dev-DB contents.
 */

const mocks = vi.hoisted(() => ({
  textSelection: {
    provider: "openrouter",
    models: ["some/model"],
    defaultModel: "some/model",
  },
  candidate: null as null | { provider: string; model: string; client: unknown },
}));

vi.mock("./textGen", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./textGen")>();
  return {
    ...actual,
    getTextGenSelection: vi.fn(async () => mocks.textSelection),
  };
});
vi.mock("./imageGen", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./imageGen")>();
  return {
    ...actual,
    getImageGenSelection: vi.fn(async () => ({
      provider: "gemini",
      model: null,
      customBaseUrl: null,
    })),
  };
});
vi.mock("./videoGen", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./videoGen")>();
  return {
    ...actual,
    getVideoGenSelection: vi.fn(async () => ({
      provider: "replicate",
      textToVideoModel: null,
      imageToVideoModel: null,
    })),
  };
});
vi.mock("./customAiProviders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./customAiProviders")>();
  return {
    ...actual,
    listCustomAiProviders: vi.fn(async () => []),
  };
});
vi.mock("./textGenFailover", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./textGenFailover")>();
  return {
    ...actual,
    resolveTextGenFailoverCandidate: vi.fn(async () => mocks.candidate),
  };
});

import { buildProviderHealthReport } from "./providerHealthReport";
import {
  recordProviderFailure,
  recordProviderSuccess,
  resetProviderHealthForTests,
} from "./providerHealth";

beforeEach(() => {
  resetProviderHealthForTests();
  mocks.candidate = null;
});

describe("buildProviderHealthReport", () => {
  it("lists textgen, imagegen and videogen keys with stats and selection flags", async () => {
    recordProviderSuccess("textgen:openrouter", 120);
    recordProviderSuccess("textgen:openrouter", 80);
    recordProviderFailure("textgen:openrouter", "boom");

    const report = await buildProviderHealthReport();

    const families = new Set(report.providers.map((p) => p.family));
    expect(families).toEqual(new Set(["textgen", "imagegen", "videogen"]));

    const openrouter = report.providers.find((p) => p.key === "textgen:openrouter")!;
    expect(openrouter.selected).toBe(true);
    expect(openrouter.healthy).toBe(true); // one failure does not open the breaker
    expect(openrouter.samples).toBe(3);
    expect(openrouter.successes).toBe(2);
    expect(openrouter.typicalLatencyMs).not.toBeNull();
    expect(openrouter.lastFailureMessage).toBe("boom");

    // Unseen provider: zero samples, healthy, no flattering defaults.
    const builtin = report.providers.find((p) => p.key === "textgen:builtin")!;
    expect(builtin.samples).toBe(0);
    expect(builtin.healthy).toBe(true);
    expect(builtin.typicalLatencyMs).toBeNull();
    expect(builtin.selected).toBe(false);

    expect(report.providers.find((p) => p.key === "imagegen:gemini")?.selected).toBe(true);
    expect(report.providers.find((p) => p.key === "videogen:replicate")?.selected).toBe(true);

    expect(report.textFailover).toEqual({
      selectedProvider: "openrouter",
      active: false,
      divertedTo: null,
    });
  });

  it("reports an active text failover when the selected breaker is open and a candidate exists", async () => {
    for (let i = 0; i < 3; i++) recordProviderFailure("textgen:openrouter", "outage");
    mocks.candidate = { provider: "builtin", model: "gpt-5", client: {} };

    const report = await buildProviderHealthReport();

    const openrouter = report.providers.find((p) => p.key === "textgen:openrouter")!;
    expect(openrouter.healthy).toBe(false);
    expect(openrouter.breakerOpenUntil).not.toBeNull();
    expect(openrouter.consecutiveFailures).toBe(3);

    expect(report.textFailover).toEqual({
      selectedProvider: "openrouter",
      active: true,
      divertedTo: "builtin",
    });
  });

  it("stays inactive when the breaker is open but no candidate qualifies", async () => {
    for (let i = 0; i < 3; i++) recordProviderFailure("textgen:openrouter", "outage");
    mocks.candidate = null;

    const report = await buildProviderHealthReport();
    expect(report.textFailover.active).toBe(false);
    expect(report.textFailover.divertedTo).toBeNull();
  });

  it("reports NVIDIA text and multimodal breaker status independently", async () => {
    mocks.textSelection.provider = "nvidia";
    for (let i = 0; i < 3; i++) {
      recordProviderFailure("textgen:nvidia:multimodal", "vision outage");
    }

    const report = await buildProviderHealthReport();
    const text = report.providers.find((p) => p.key === "textgen:nvidia:text")!;
    const multimodal = report.providers.find((p) => p.key === "textgen:nvidia:multimodal")!;

    expect(text.selected).toBe(true);
    expect(text.healthy).toBe(true);
    expect(multimodal.healthy).toBe(false);
    // Failover is a plain-text runtime concern, so a vision-only outage does
    // not claim that the selected text route is being diverted.
    expect(report.textFailover).toMatchObject({ selectedProvider: "nvidia", active: false });
  });
});
