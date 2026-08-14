/**
 * Guard: flipping a consent category off must stop the corresponding gated
 * data (device details, carrier, precise location) from being included in
 * the VERY NEXT analytics batch — no app restart required. `setConsentState`
 * is the single switch the tracker flips after the consent query updates,
 * so these tests exercise the lib directly.
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

const fetchMock = vi.fn(async () => ({ ok: true }) as Response);

let analytics: Analytics;

const FULL_CONSENT = {
  analytics: true,
  deviceDetails: true,
  locationCoarse: true,
  locationPrecise: true,
  carrier: true,
  responded: true,
};

function lastBatchContext(): Record<string, unknown> {
  const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
  expect(calls.length).toBeGreaterThan(0);
  const [, init] = calls[calls.length - 1];
  return JSON.parse(String(init.body)).context;
}

async function settle() {
  // Let queued promises (carrier/location probes, flush) resolve.
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

/** Push enough events to cross MAX_QUEUE and force an immediate flush. */
async function forceFlush() {
  for (let i = 0; i < 40; i++) analytics.track("feature_use", { n: i });
  await settle();
}

beforeAll(async () => {
  process.env.EXPO_PUBLIC_DOMAIN = "example.test";
  vi.stubGlobal("fetch", fetchMock);
  vi.resetModules();
  analytics = await import("./analytics");
});

beforeEach(() => {
  fetchMock.mockClear();
});

describe("mobile analytics consent gating (immediate effect)", () => {
  it("with full consent, the batch context carries device, carrier, and precise location", async () => {
    analytics.setConsentState(FULL_CONSENT, true);
    await settle(); // carrier + GPS probes resolve
    await forceFlush();

    const ctx = lastBatchContext();
    expect(ctx.deviceModel).toBe("TestPhone");
    expect(ctx.osVersion).toContain("17");
    expect(ctx.carrier).toBe("TestCarrier");
    expect(ctx.latitude).toBe(12.9);
    expect(ctx.longitude).toBe(77.6);
  });

  it("toggling device/carrier/location off strips them from the VERY NEXT batch, even though values are still cached in memory", async () => {
    analytics.setConsentState(
      {
        ...FULL_CONSENT,
        deviceDetails: false,
        carrier: false,
        locationPrecise: false,
      },
      true,
    );
    // No settle between consent change and the next batch: this is the
    // "right away" guarantee — no restart, no async warm-up needed.
    await forceFlush();

    const ctx = lastBatchContext();
    expect(ctx.deviceModel).toBeUndefined();
    expect(ctx.osVersion).toBeUndefined();
    expect(ctx.networkType).toBeUndefined();
    expect(ctx.carrier).toBeUndefined();
    expect(ctx.latitude).toBeUndefined();
    expect(ctx.longitude).toBeUndefined();
    // Ungated basics remain.
    expect(ctx.appVersion).toBe("1.0");
  });

  it("re-enabling a category restores it on the next batch", async () => {
    analytics.setConsentState({ ...FULL_CONSENT, carrier: false }, true);
    await forceFlush();
    expect(lastBatchContext().carrier).toBeUndefined();

    fetchMock.mockClear();
    analytics.setConsentState(FULL_CONSENT, true);
    await settle();
    await forceFlush();
    expect(lastBatchContext().carrier).toBe("TestCarrier");
    expect(lastBatchContext().deviceModel).toBe("TestPhone");
  });

  it("holds queued events while consent is unresolved, then delivers them after opt-in (consent held past a flush tick)", async () => {
    // Consent not yet loaded: events queue, flush holds.
    analytics.setConsentState(null, true);
    analytics.__analyticsTestHooks.resetQueue();
    analytics.track("onboarding_started", { entry_point: "first_login" });
    await analytics.__analyticsTestHooks.flush(); // a flush tick passes
    expect(fetchMock).not.toHaveBeenCalled();
    expect(analytics.__analyticsTestHooks.getQueue().length).toBe(1);

    // Consent loaded but not answered yet: still held.
    analytics.setConsentState({ ...FULL_CONSENT, analytics: false, responded: false }, true);
    await analytics.__analyticsTestHooks.flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(analytics.__analyticsTestHooks.getQueue().length).toBe(1);

    // Immediate action right after opting in (e.g. instant skip) plus the
    // held event both reach the server once consent flips to opt-in.
    analytics.setConsentState(FULL_CONSENT, true);
    analytics.track("onboarding_skipped", { stage: "welcome" });
    await settle();
    await analytics.__analyticsTestHooks.flush();
    const sent = (fetchMock.mock.calls as unknown as [string, RequestInit][])
      .flatMap(([, init]) => JSON.parse(String(init.body)).events as { name: string }[])
      .map((e) => e.name);
    expect(sent).toContain("onboarding_started");
    expect(sent).toContain("onboarding_skipped");
  });

  it("drops held events only on an explicit opt-out", async () => {
    analytics.setConsentState(null, true);
    analytics.__analyticsTestHooks.resetQueue();
    analytics.track("onboarding_started");
    analytics.setConsentState({ ...FULL_CONSENT, analytics: false, responded: true }, true);
    expect(analytics.__analyticsTestHooks.getQueue().length).toBe(0);
    await analytics.__analyticsTestHooks.flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("turning analytics off drops the pending queue and blocks all future sends", async () => {
    // Leave some events pending, then revoke.
    analytics.track("feature_use", { pending: true });
    analytics.setConsentState({ ...FULL_CONSENT, analytics: false }, true);

    // Even hammering the tracker cannot trigger a network call.
    for (let i = 0; i < 100; i++) analytics.track("feature_use", { n: i });
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
