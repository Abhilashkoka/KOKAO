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

/** Successful ingest response confirming the event was stored. */
function okResponse(accepted = 1): Response {
  return {
    ok: true,
    json: async () => ({ accepted }),
  } as unknown as Response;
}

beforeEach(async () => {
  store.clear();
  process.env.EXPO_PUBLIC_DOMAIN = "example.test";
  fetchMock = vi.fn(async () => okResponse());
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
    resolveSend(okResponse());
    await Promise.all([first, second]);
    expect(signUpEventsSent()).toBe(1);
    expect(store.get(SIGN_UP_KEY)).toBe("user_concurrent");
  });

  it("does NOT commit the marker when the server returns accepted:0 (consent not yet granted), and retries on the next call", async () => {
    // Server accepts the HTTP request but drops the batch because stored
    // consent hasn't been recorded yet — 200 {accepted:0}.
    fetchMock.mockResolvedValueOnce(okResponse(0));
    await analytics.trackSignUpOnce("user_no_consent", new Date());
    expect(store.get(SIGN_UP_KEY)).toBeUndefined();

    // In-memory guard was released, so a subsequent call (e.g. after the
    // user grants consent) retries and this time the server stores the event.
    fetchMock.mockClear();
    await analytics.trackSignUpOnce("user_no_consent", new Date());
    expect(store.get(SIGN_UP_KEY)).toBe("user_no_consent");
    expect(signUpEventsSent()).toBe(1);
  });

  it("does NOT commit the marker when the server returns a non-JSON body, and retries", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => { throw new Error("not json"); },
    } as unknown as Response);
    await analytics.trackSignUpOnce("user_bad_body", new Date());
    expect(store.get(SIGN_UP_KEY)).toBeUndefined();

    // Retry succeeds with a proper body.
    fetchMock.mockClear();
    await analytics.trackSignUpOnce("user_bad_body", new Date());
    expect(store.get(SIGN_UP_KEY)).toBe("user_bad_body");
    expect(signUpEventsSent()).toBe(1);
  });

  it("never fires for an account older than the freshness window", async () => {
    await analytics.trackSignUpOnce(
      "user_old",
      new Date(Date.now() - FRESH_WINDOW_MS - 1),
    );
    expect(store.get(SIGN_UP_KEY)).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dedupes a second sequential call for the same user id in the same session", async () => {
    await analytics.trackSignUpOnce("user_dupe", new Date());
    expect(signUpEventsSent()).toBe(1);
    await analytics.trackSignUpOnce("user_dupe", new Date());
    expect(signUpEventsSent()).toBe(1);
    expect(store.get(SIGN_UP_KEY)).toBe("user_dupe");
  });

  it("is a no-op when createdAt is missing or userId is empty", async () => {
    await analytics.trackSignUpOnce("user_no_created_at", null);
    await analytics.trackSignUpOnce("user_no_created_at", undefined);
    await analytics.trackSignUpOnce("", new Date());
    expect(store.get(SIGN_UP_KEY)).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("auto-retries when consent flips to analytics:true while the initial send is in-flight and returns accepted:0", async () => {
    // Consent is unresolved (null) but the user is signed in: the tracker fires
    // trackSignUpOnce eagerly before consent loads, which is the normal path.
    analytics.setConsentState(null, true);

    // First fetch is held in-flight so we can race consent.
    let resolveFirst!: (r: Response) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((r) => (resolveFirst = r)),
    );

    // Second fetch (auto-retry after accepted:0) succeeds immediately.
    fetchMock.mockImplementationOnce(async () => okResponse(1));

    const firstCall = analytics.trackSignUpOnce("user_race", new Date());

    // Wait until the first send is truly in-flight.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // Consent resolves to analytics:true while the request is pending.
    // In a real device the AnalyticsTracker's consent-dep effect fires here and
    // calls trackSignUpOnce again — but the in-memory guard turns it away.
    analytics.setConsentState(
      { analytics: true, deviceDetails: false, locationCoarse: false, locationPrecise: false, carrier: false, responded: true },
      true,
    );

    // Resolve the in-flight request with accepted:0 (consent wasn't stored yet
    // server-side at send time). The guard clears, sees consent is now
    // affirmative, and auto-retries without waiting for an external trigger.
    resolveFirst(okResponse(0));
    await firstCall;

    // Auto-retry must have fired and committed the marker.
    await vi.waitFor(() => expect(store.get(SIGN_UP_KEY)).toBe("user_race"));
    expect(signUpEventsSent()).toBe(2); // initial (rejected) + auto-retry (accepted)
  });

  it("still fires once and dedupes in memory when AsyncStorage is unavailable", async () => {
    const storage = (
      await import("@react-native-async-storage/async-storage")
    ).default;
    const getSpy = vi
      .spyOn(storage, "getItem")
      .mockRejectedValue(new Error("storage disabled"));
    const setSpy = vi
      .spyOn(storage, "setItem")
      .mockRejectedValue(new Error("storage disabled"));
    try {
      await expect(
        analytics.trackSignUpOnce("user_no_storage", new Date()),
      ).resolves.toBeUndefined();
      expect(signUpEventsSent()).toBe(1);
      expect(store.get(SIGN_UP_KEY)).toBeUndefined();

      // Second call in the same session: the in-memory marker still dedupes.
      await analytics.trackSignUpOnce("user_no_storage", new Date());
      expect(signUpEventsSent()).toBe(1);
    } finally {
      getSpy.mockRestore();
      setSpy.mockRestore();
    }
  });
});
