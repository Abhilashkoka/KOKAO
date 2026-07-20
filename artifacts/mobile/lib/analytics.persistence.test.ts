/**
 * Guard: unsent analytics events must survive the app being killed while
 * the network is down. Failed batches are mirrored into AsyncStorage and
 * restored on the next launch, with the existing caps (bounded attempts,
 * 120-event buffer) still applied after restore.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

const store = vi.hoisted(() => new Map<string, string>());

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => void store.set(k, v),
    removeItem: async (k: string) => void store.delete(k),
  },
}));
vi.mock("expo-application", () => ({ nativeApplicationVersion: "1.0" }));
vi.mock("expo-battery", () => ({
  getBatteryLevelAsync: async () => -1,
}));
vi.mock("expo-cellular", () => ({
  getCarrierNameAsync: async () => "TestCarrier",
}));
vi.mock("expo-crypto", () => {
  let n = 0;
  return { randomUUID: () => `uuid-${++n}` };
});
vi.mock("expo-device", () => ({ osVersion: "17", modelName: "TestPhone" }));
vi.mock("expo-location", () => ({
  Accuracy: { Balanced: 3 },
  requestForegroundPermissionsAsync: async () => ({ status: "granted" }),
  getCurrentPositionAsync: async () => ({
    coords: { latitude: 12.9, longitude: 77.6 },
  }),
}));
vi.mock("expo-network", () => ({
  getNetworkStateAsync: async () => ({ type: "WIFI" }),
}));

type Analytics = typeof import("./analytics");

const PENDING_KEY = "kokao_pending_events";

const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as Response);

let analytics: Analytics;
let hooks: Analytics["__analyticsTestHooks"];

function event(name: string, attempts?: number) {
  return {
    name,
    params: {},
    clientTimestamp: new Date().toISOString(),
    ...(attempts !== undefined ? { attempts } : {}),
  };
}

beforeAll(async () => {
  process.env.EXPO_PUBLIC_DOMAIN = "example.test";
  vi.stubGlobal("fetch", fetchMock);
  vi.resetModules();
  analytics = await import("./analytics");
  hooks = analytics.__analyticsTestHooks;
});

beforeEach(() => {
  fetchMock.mockClear();
  fetchMock.mockImplementation(async () => ({ ok: true, status: 200 }) as Response);
  hooks.resetQueue();
  store.delete(PENDING_KEY);
});

describe("mobile analytics queue persistence", () => {
  it("persists the re-queued batch to AsyncStorage after a failed flush", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    analytics.track("screen_view", { page: "home" });
    analytics.track("feature_use", { feature: "x" });
    await hooks.flush();

    const raw = store.get(PENDING_KEY);
    expect(raw).toBeDefined();
    const stored = JSON.parse(raw!) as { name: string; attempts?: number }[];
    expect(stored.map((e) => e.name)).toEqual(["screen_view", "feature_use"]);
    expect(stored.every((e) => e.attempts === 1)).toBe(true);
  });

  it("clears the persisted copy once a flush succeeds", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    analytics.track("feature_use", {});
    await hooks.flush();
    expect(store.get(PENDING_KEY)).toBeDefined();

    await hooks.flush(); // succeeds
    expect(hooks.getQueue()).toHaveLength(0);
    expect(store.get(PENDING_KEY)).toBeUndefined();
  });

  it("restores persisted events ahead of new ones and removes the stored copy", async () => {
    store.set(PENDING_KEY, JSON.stringify([event("old", 1)]));
    hooks.setQueue([event("fresh")]);
    await hooks.restoreQueue();

    expect(hooks.getQueue().map((e) => e.name)).toEqual(["old", "fresh"]);
    expect(hooks.getQueue()[0]!.attempts).toBe(1);
    // Removed immediately so a second init can't replay it.
    expect(store.get(PENDING_KEY)).toBeUndefined();
    await hooks.restoreQueue();
    expect(hooks.getQueue()).toHaveLength(2);
  });

  it("still applies the attempt limit and buffer cap after restore", async () => {
    const persisted = [
      event("over_attempted", 3),
      ...Array.from({ length: 130 }, (_, i) => ({ ...event("old"), params: { i } })),
    ];
    store.set(PENDING_KEY, JSON.stringify(persisted));
    hooks.setQueue([event("fresh")]);
    await hooks.restoreQueue();

    const queue = hooks.getQueue();
    expect(queue).toHaveLength(120);
    expect(queue.some((e) => e.name === "over_attempted")).toBe(false);
    // Newest survive the cap; the oldest restored events are trimmed.
    expect(queue[queue.length - 1]!.name).toBe("fresh");
  });

  it("flushes and persists the remaining queue when the app is backgrounded", async () => {
    // Simulate an outage so the flush can't send; the events must land in
    // AsyncStorage the moment the app goes to the background.
    fetchMock.mockRejectedValue(new Error("network down"));
    analytics.track("screen_view", { page: "home" });
    analytics.track("feature_use", { feature: "x" });

    hooks.handleAppStateChange("background");
    await vi.waitFor(() => {
      expect(store.get(PENDING_KEY)).toBeDefined();
    });
    const stored = JSON.parse(store.get(PENDING_KEY)!) as { name: string }[];
    expect(stored.map((e) => e.name)).toEqual(["screen_view", "feature_use"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends the queue on background when the network is up and clears storage", async () => {
    analytics.track("feature_use", { feature: "y" });
    hooks.handleAppStateChange("inactive");
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(hooks.getQueue()).toHaveLength(0);
    expect(store.get(PENDING_KEY)).toBeUndefined();
  });

  it("ignores foreground transitions", async () => {
    analytics.track("feature_use", { feature: "z" });
    hooks.handleAppStateChange("active");
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(hooks.getQueue()).toHaveLength(1);
  });

  it("ignores corrupt or malformed persisted data", async () => {
    store.set(PENDING_KEY, "not json");
    await hooks.restoreQueue();
    expect(hooks.getQueue()).toHaveLength(0);

    store.set(PENDING_KEY, JSON.stringify([{ bogus: true }, null, event("valid")]));
    await hooks.restoreQueue();
    expect(hooks.getQueue().map((e) => e.name)).toEqual(["valid"]);
  });
});
