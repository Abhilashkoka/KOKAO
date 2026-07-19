import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const SIGN_UP_KEY = "kokao_sign_up_tracked";
const FRESH_WINDOW_MS = 60 * 60_000;
const MAX_QUEUE = 40;

type AnalyticsModule = typeof import("./analytics");

let analytics: AnalyticsModule;
let fetchMock: ReturnType<typeof vi.fn>;

function sentBatches(): { events: { name: string }[] }[] {
  return fetchMock.mock.calls.map(
    (call) => JSON.parse((call[1] as RequestInit).body as string) as { events: { name: string }[] },
  );
}

function signUpEventsSent(): number {
  return sentBatches()
    .flatMap((b) => b.events)
    .filter((e) => e.name === "sign_up").length;
}

/** Fill the internal queue so the next tracked event forces a flush to fetch. */
function primeQueue(count: number): void {
  for (let i = 0; i < count; i++) {
    analytics.track("filler_event");
  }
}

beforeEach(async () => {
  vi.resetModules();
  window.localStorage.clear();
  window.sessionStorage.clear();
  fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
  vi.stubGlobal("fetch", fetchMock);
  analytics = await import("./analytics");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("trackSignUpOnce", () => {
  it("fires sign_up once for a freshly created user and stores the device marker", () => {
    primeQueue(MAX_QUEUE - 1);
    analytics.trackSignUpOnce("user_fresh", new Date());
    expect(window.localStorage.getItem(SIGN_UP_KEY)).toBe("user_fresh");
    expect(signUpEventsSent()).toBe(1);
  });

  it("dedupes a second call for the same user id", () => {
    analytics.trackSignUpOnce("user_dupe", new Date());
    expect(window.localStorage.getItem(SIGN_UP_KEY)).toBe("user_dupe");
    // Drain the queue (which contains the first sign_up), then reset the spy.
    primeQueue(MAX_QUEUE - 1);
    fetchMock.mockClear();
    primeQueue(MAX_QUEUE - 1);
    analytics.trackSignUpOnce("user_dupe", new Date());
    // The second call added nothing, so the queue never hit the flush threshold.
    expect(signUpEventsSent()).toBe(0);
  });

  it("dedupes across module reloads via the localStorage marker (same device)", async () => {
    analytics.trackSignUpOnce("user_reload", new Date());
    expect(window.localStorage.getItem(SIGN_UP_KEY)).toBe("user_reload");

    // Simulate a page reload: fresh module state, same localStorage.
    vi.resetModules();
    analytics = await import("./analytics");
    primeQueue(MAX_QUEUE - 1);
    analytics.trackSignUpOnce("user_reload", new Date());
    expect(signUpEventsSent()).toBe(0);
  });

  it("never fires for an account created beyond the freshness window, even with empty storage", () => {
    expect(window.localStorage.getItem(SIGN_UP_KEY)).toBeNull();
    primeQueue(MAX_QUEUE - 1);
    analytics.trackSignUpOnce(
      "user_returning",
      new Date(Date.now() - FRESH_WINDOW_MS - 1),
    );
    expect(window.localStorage.getItem(SIGN_UP_KEY)).toBeNull();
    expect(signUpEventsSent()).toBe(0);
  });

  it("fires for an account created exactly at the freshness boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T12:00:00Z"));
    analytics.trackSignUpOnce(
      "user_boundary",
      new Date(Date.now() - FRESH_WINDOW_MS),
    );
    expect(window.localStorage.getItem(SIGN_UP_KEY)).toBe("user_boundary");
  });

  it("is a no-op when createdAt is missing", () => {
    primeQueue(MAX_QUEUE - 1);
    analytics.trackSignUpOnce("user_no_created_at", null);
    analytics.trackSignUpOnce("user_no_created_at", undefined);
    expect(window.localStorage.getItem(SIGN_UP_KEY)).toBeNull();
    expect(signUpEventsSent()).toBe(0);
  });

  it("is a no-op when userId is empty", () => {
    analytics.trackSignUpOnce("", new Date());
    expect(window.localStorage.getItem(SIGN_UP_KEY)).toBeNull();
  });

  it("still fires once and dedupes in memory when localStorage is unavailable", () => {
    const original = window.localStorage;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("storage disabled");
      },
    });
    try {
      primeQueue(MAX_QUEUE - 1);
      expect(() => analytics.trackSignUpOnce("user_no_storage", new Date())).not.toThrow();
      expect(signUpEventsSent()).toBe(1);

      fetchMock.mockClear();
      primeQueue(MAX_QUEUE - 1);
      analytics.trackSignUpOnce("user_no_storage", new Date());
      expect(signUpEventsSent()).toBe(0);
    } finally {
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        value: original,
      });
    }
  });
});
