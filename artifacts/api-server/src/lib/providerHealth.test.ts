import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  recordProviderFailure,
  recordProviderSuccess,
  isProviderHealthy,
  getProviderHealth,
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
