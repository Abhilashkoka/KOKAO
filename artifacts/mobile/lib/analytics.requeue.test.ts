/**
 * Guard: a failed analytics batch send must NOT silently drop the events.
 * On failure the batch is re-queued (bounded attempts + a hard buffer cap)
 * so a brief network blip doesn't permanently lose screen views / feature
 * usage. A 4xx rejection is terminal (retrying can never succeed).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => {
  const store = new Map<string, string>();
  return {
    default: {
      getItem: async (k: string) => store.get(k) ?? null,
      setItem: async (k: string, v: string) => void store.set(k, v),
    },
  };
});
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

const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as Response);

let analytics: Analytics;
let hooks: Analytics["__analyticsTestHooks"];

function sentEvents(callIndex: number): { name: string; attempts?: number }[] {
  const [, init] = fetchMock.mock.calls[callIndex] as unknown as [string, RequestInit];
  return JSON.parse(String(init.body)).events;
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
});

describe("mobile analytics requeue on failed send", () => {
  it("re-queues the batch when fetch throws (network blip)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    analytics.track("screen_view", { page: "home" });
    analytics.track("feature_use", { feature: "x" });
    await hooks.flush();

    const queue = hooks.getQueue();
    expect(queue).toHaveLength(2);
    expect(queue.map((e) => e.name)).toEqual(["screen_view", "feature_use"]);
    expect(queue.every((e) => e.attempts === 1)).toBe(true);

    // Next flush succeeds and re-sends the same events, without the
    // internal attempts counter on the wire.
    await hooks.flush();
    expect(hooks.getQueue()).toHaveLength(0);
    const events = sentEvents(1);
    expect(events.map((e) => e.name)).toEqual(["screen_view", "feature_use"]);
    expect(events.every((e) => !("attempts" in e))).toBe(true);
  });

  it("re-queues on 5xx and 429 but drops on other 4xx", async () => {
    analytics.track("feature_use", {});
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 } as Response);
    await hooks.flush();
    expect(hooks.getQueue()).toHaveLength(1);

    fetchMock.mockResolvedValueOnce({ ok: false, status: 429 } as Response);
    await hooks.flush();
    expect(hooks.getQueue()).toHaveLength(1);
    expect(hooks.getQueue()[0]!.attempts).toBe(2);

    fetchMock.mockResolvedValueOnce({ ok: false, status: 400 } as Response);
    await hooks.flush();
    expect(hooks.getQueue()).toHaveLength(0);
  });

  it("drops events after the bounded number of failed attempts", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    analytics.track("feature_use", { n: 1 });

    await hooks.flush(); // attempt 1
    expect(hooks.getQueue()).toHaveLength(1);
    await hooks.flush(); // attempt 2
    expect(hooks.getQueue()).toHaveLength(1);
    await hooks.flush(); // attempt 3 -> dropped
    expect(hooks.getQueue()).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("caps the total buffered queue, keeping the newest events", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const event = (name: string, i: number) => ({
      name,
      params: { i },
      clientTimestamp: new Date().toISOString(),
    });
    // Fail a batch while many newer events are already waiting behind it.
    hooks.setQueue(Array.from({ length: 40 }, (_, i) => event("old_event", i)));
    const flushPromise = hooks.flush(); // takes the 40 old events
    hooks.setQueue(Array.from({ length: 110 }, (_, i) => event("new_event", i)));
    await flushPromise; // requeue would make 150; capped at 120

    const queue = hooks.getQueue();
    expect(queue).toHaveLength(120);
    // Newest survive; the overflow was trimmed from the oldest end.
    expect(queue[queue.length - 1]!.name).toBe("new_event");
    expect(queue.filter((e) => e.name === "old_event")).toHaveLength(10);
  });
});
