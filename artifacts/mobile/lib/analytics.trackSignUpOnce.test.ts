/**
 * Guard: the sign_up event is flushed immediately and its AsyncStorage dedupe
 * marker is only committed after the server accepts the batch. A failed send
 * must leave the marker unset so the next app launch retries; once the marker
 * exists, no duplicate sign_up may ever fire.
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

const SIGN_UP_KEY = "kokao_sign_up_tracked";
const FRESH_WINDOW_MS = 60 * 60_000;

type Analytics = typeof import("./analytics");

let analytics: Analytics;
let fetchMock: ReturnType<typeof vi.fn>;

function signUpEventsSent(): number {
  return (fetchMock.mock.calls as unknown as [string, RequestInit][])
    .flatMap(([, init]) => JSON.parse(String(init.body)).events as { name: string }[])
    .filter((e) => e.name === "sign_up").length;
}

/** Reload the analytics module, simulating a fresh app launch. */
async function launchApp(): Promise<void> {
  vi.resetModules();
  analytics = await import("./analytics");
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

describe("mobile trackSignUpOnce retry-vs-exactly-once", () => {
  it("commits the AsyncStorage marker only after the server accepts the send", async () => {
    await analytics.trackSignUpOnce("user_ok", new Date());
    expect(store.get(SIGN_UP_KEY)).toBe("user_ok");
    expect(signUpEventsSent()).toBe(1);
  });

  it("does NOT commit the marker when the send fails, and retries on the next launch", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await analytics.trackSignUpOnce("user_retry", new Date());
    expect(store.get(SIGN_UP_KEY)).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Next launch: fresh module state, same AsyncStorage without a marker.
    await launchApp();
    fetchMock.mockClear();
    await analytics.trackSignUpOnce("user_retry", new Date());
    expect(store.get(SIGN_UP_KEY)).toBe("user_retry");
    expect(signUpEventsSent()).toBe(1);
  });

  it("does NOT commit the marker on a non-ok server response, allowing a retry in the same session", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false } as Response);
    await analytics.trackSignUpOnce("user_500", new Date());
    expect(store.get(SIGN_UP_KEY)).toBeUndefined();

    // The in-memory guard was released, so a later call retries without a relaunch.
    fetchMock.mockClear();
    await analytics.trackSignUpOnce("user_500", new Date());
    expect(store.get(SIGN_UP_KEY)).toBe("user_500");
    expect(signUpEventsSent()).toBe(1);
  });

  it("never fires again once the marker exists, even after a relaunch", async () => {
    store.set(SIGN_UP_KEY, "user_done");
    await analytics.trackSignUpOnce("user_done", new Date());
    expect(signUpEventsSent()).toBe(0);

    await launchApp();
    await analytics.trackSignUpOnce("user_done", new Date());
    expect(signUpEventsSent()).toBe(0);
  });

  it("dedupes concurrent calls while the first send is still in flight", async () => {
    let resolveSend!: (r: Response) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((r) => (resolveSend = r)),
    );
    const first = analytics.trackSignUpOnce("user_concurrent", new Date());
    // Let the first call reach the in-flight fetch and set the memory guard.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const second = analytics.trackSignUpOnce("user_concurrent", new Date());
    resolveSend({ ok: true } as Response);
    await Promise.all([first, second]);
    expect(signUpEventsSent()).toBe(1);
    expect(store.get(SIGN_UP_KEY)).toBe("user_concurrent");
  });

  it("never fires for an account older than the freshness window", async () => {
    await analytics.trackSignUpOnce(
      "user_old",
      new Date(Date.now() - FRESH_WINDOW_MS - 1),
    );
    expect(store.get(SIGN_UP_KEY)).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
