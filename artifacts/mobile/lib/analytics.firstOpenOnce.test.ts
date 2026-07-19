/**
 * Guard: the first_open event is sent immediately on the first launch and its
 * AsyncStorage marker is only committed after the server accepts the send.
 * An offline/failed first launch must leave the marker unset so a later
 * launch retries; once the marker exists, first_open never fires again.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const store = new Map<string, string>();

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => void store.set(k, v),
  },
}));
vi.mock("expo-application", () => ({ nativeApplicationVersion: "1.0" }));
vi.mock("expo-battery", () => ({ getBatteryLevelAsync: async () => -1 }));
vi.mock("expo-cellular", () => ({ getCarrierNameAsync: async () => null }));
vi.mock("expo-crypto", () => {
  let n = 0;
  return { randomUUID: () => `uuid-${++n}` };
});
vi.mock("expo-device", () => ({ osVersion: "17", modelName: "TestPhone" }));
vi.mock("expo-location", () => ({
  Accuracy: { Balanced: 3 },
  requestForegroundPermissionsAsync: async () => ({ status: "denied" }),
  getCurrentPositionAsync: async () => {
    throw new Error("unused");
  },
}));
vi.mock("expo-network", () => ({
  getNetworkStateAsync: async () => ({ type: "WIFI" }),
}));

const FIRST_OPEN_KEY = "kokao_first_open";

type Analytics = typeof import("./analytics");

let analytics: Analytics;
let fetchMock: ReturnType<typeof vi.fn>;

function firstOpenEventsSent(): number {
  return (fetchMock.mock.calls as unknown as [string, RequestInit][])
    .flatMap(([, init]) => JSON.parse(String(init.body)).events as { name: string }[])
    .filter((e) => e.name === "first_open").length;
}

/** Reload the analytics module, simulating a fresh app launch. */
async function launchApp(): Promise<void> {
  vi.resetModules();
  analytics = await import("./analytics");
}

/** Wait until the async first_open send settles (fetch called or skipped). */
async function settle(): Promise<void> {
  // Flush pending microtasks/promises from the fire-and-forget init path.
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(async () => {
  store.clear();
  process.env.EXPO_PUBLIC_DOMAIN = "example.test";
  fetchMock = vi.fn(async () => ({ ok: true }) as Response);
  vi.stubGlobal("fetch", fetchMock);
  await launchApp();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mobile first_open failure-then-retry", () => {
  it("sends first_open on the first launch and commits the marker after acceptance", async () => {
    analytics.initAnalytics(Date.now());
    await settle();
    expect(firstOpenEventsSent()).toBe(1);
    expect(store.get(FIRST_OPEN_KEY)).toBeDefined();
  });

  it("does NOT commit the marker when the send fails offline, and retries on the next launch", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    analytics.initAnalytics(Date.now());
    await settle();
    expect(store.get(FIRST_OPEN_KEY)).toBeUndefined();

    // Next launch with network back: the event is retried and committed.
    await launchApp();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true } as Response);
    analytics.initAnalytics(Date.now());
    await settle();
    expect(firstOpenEventsSent()).toBe(1);
    expect(store.get(FIRST_OPEN_KEY)).toBeDefined();
  });

  it("does NOT commit the marker on a non-ok server response", async () => {
    fetchMock.mockResolvedValue({ ok: false } as Response);
    analytics.initAnalytics(Date.now());
    await settle();
    expect(store.get(FIRST_OPEN_KEY)).toBeUndefined();
    expect(firstOpenEventsSent()).toBe(1);
  });

  it("never fires again once the marker exists, even after a relaunch", async () => {
    store.set(FIRST_OPEN_KEY, new Date().toISOString());
    analytics.initAnalytics(Date.now());
    await settle();
    expect(firstOpenEventsSent()).toBe(0);

    await launchApp();
    analytics.initAnalytics(Date.now());
    await settle();
    expect(firstOpenEventsSent()).toBe(0);
  });

  it("sends first_open at most once per session even after repeated failures within it", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    analytics.initAnalytics(Date.now());
    await settle();
    expect(firstOpenEventsSent()).toBe(1);
    // init is idempotent within a session (flushTimer guard), so no double send.
    analytics.initAnalytics(Date.now());
    await settle();
    expect(firstOpenEventsSent()).toBe(1);
  });

  it("skips sending entirely when AsyncStorage is unreadable (cannot dedupe safely)", async () => {
    const storage = (
      await import("@react-native-async-storage/async-storage")
    ).default;
    const getSpy = vi
      .spyOn(storage, "getItem")
      .mockRejectedValue(new Error("storage disabled"));
    try {
      analytics.initAnalytics(Date.now());
      await settle();
      expect(firstOpenEventsSent()).toBe(0);
    } finally {
      getSpy.mockRestore();
    }
  });
});
