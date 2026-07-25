import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  recordProviderFailure,
  recordProviderSuccess,
  isProviderHealthy,
  getProviderHealth,
  getProviderStats,
  orderByHealth,
  resetProviderHealthForTests,
} from "./providerHealth";

describe("providerHealth circuit breaker", () => {
  beforeEach(() => {
    resetProviderHealthForTests();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays healthy below the failure threshold", () => {
    recordProviderFailure("imagegen:gemini", "boom");
    recordProviderFailure("imagegen:gemini", "boom");
    expect(isProviderHealthy("imagegen:gemini")).toBe(true);
  });

  it("opens after 3 consecutive failures and half-opens after the cooldown", () => {
    for (let i = 0; i < 3; i++) recordProviderFailure("imagegen:gemini", "503");
    expect(isProviderHealthy("imagegen:gemini")).toBe(false);

    // First open period is 60s.
    vi.advanceTimersByTime(59_000);
    expect(isProviderHealthy("imagegen:gemini")).toBe(false);
    vi.advanceTimersByTime(2_000);
    expect(isProviderHealthy("imagegen:gemini")).toBe(true);
  });

  it("backs off exponentially and caps at 10 minutes", () => {
    for (let i = 0; i < 7; i++) recordProviderFailure("imagegen:gemini");
    // 60s * 2^(7-3) = 960s, capped to 600s.
    vi.advanceTimersByTime(599_000);
    expect(isProviderHealthy("imagegen:gemini")).toBe(false);
    vi.advanceTimersByTime(2_000);
    expect(isProviderHealthy("imagegen:gemini")).toBe(true);
  });

  it("a success closes the breaker immediately", () => {
    for (let i = 0; i < 5; i++) recordProviderFailure("imagegen:gemini");
    expect(isProviderHealthy("imagegen:gemini")).toBe(false);
    recordProviderSuccess("imagegen:gemini");
    expect(isProviderHealthy("imagegen:gemini")).toBe(true);
    expect(getProviderHealth("imagegen:gemini")?.consecutiveFailures).toBe(0);
  });

  it("unknown providers are healthy", () => {
    expect(isProviderHealthy("imagegen:never-seen")).toBe(true);
    expect(getProviderHealth("imagegen:never-seen")).toBeNull();
  });

  it("orderByHealth keeps original order but moves open-breaker items last", () => {
    const items = ["a", "b", "c"];
    expect(orderByHealth(items, (x) => `p:${x}`)).toEqual(["a", "b", "c"]);

    for (let i = 0; i < 3; i++) recordProviderFailure("p:a");
    expect(orderByHealth(items, (x) => `p:${x}`)).toEqual(["b", "c", "a"]);
  });
});

describe("providerHealth observed stats", () => {
  beforeEach(() => {
    resetProviderHealthForTests();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports nothing known for a provider that was never called", () => {
    expect(getProviderStats("imagegen:unseen")).toEqual({
      samples: 0,
      successes: 0,
      typicalLatencyMs: null,
      healthy: true,
    });
  });

  it("counts successes and failures within the window", () => {
    recordProviderSuccess("imagegen:bfl");
    recordProviderFailure("imagegen:bfl");
    recordProviderSuccess("imagegen:bfl");
    const stats = getProviderStats("imagegen:bfl");
    expect(stats.samples).toBe(3);
    expect(stats.successes).toBe(2);
  });

  it("keeps only the 20 most recent outcomes", () => {
    // 5 failures then 20 successes: the failures must fall out of the window.
    // They are recorded first so the breaker is closed again by the end.
    for (let i = 0; i < 5; i++) recordProviderFailure("imagegen:bfl");
    for (let i = 0; i < 20; i++) recordProviderSuccess("imagegen:bfl");
    expect(getProviderStats("imagegen:bfl")).toMatchObject({
      samples: 20,
      successes: 20,
    });
  });

  it("smooths latency rather than taking the last measurement", () => {
    recordProviderSuccess("imagegen:bfl", 1_000);
    expect(getProviderStats("imagegen:bfl").typicalLatencyMs).toBe(1_000);
    // alpha 0.3: 1000 * 0.7 + 11000 * 0.3 = 4000.
    recordProviderSuccess("imagegen:bfl", 11_000);
    expect(getProviderStats("imagegen:bfl").typicalLatencyMs).toBe(4_000);
  });

  it("does not treat an untimed success as an instant one", () => {
    recordProviderSuccess("imagegen:bfl", 5_000);
    recordProviderSuccess("imagegen:bfl");
    expect(getProviderStats("imagegen:bfl").typicalLatencyMs).toBe(5_000);
  });

  it("reports unhealthy while the breaker is open and healthy after cooldown", () => {
    for (let i = 0; i < 3; i++) recordProviderFailure("imagegen:bfl");
    expect(getProviderStats("imagegen:bfl").healthy).toBe(false);
    vi.advanceTimersByTime(61_000);
    expect(getProviderStats("imagegen:bfl").healthy).toBe(true);
  });

  it("does not leak internal bookkeeping through getProviderHealth", () => {
    recordProviderSuccess("imagegen:bfl", 1_234);
    expect(Object.keys(getProviderHealth("imagegen:bfl") ?? {}).sort()).toEqual([
      "consecutiveFailures",
      "lastFailureMessage",
      "openUntil",
    ]);
  });
});
