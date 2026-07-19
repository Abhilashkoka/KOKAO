/**
 * Guard: updating consent in the web app must change what the tracker sends
 * in the VERY NEXT analytics batch — no page reload required.
 * `setConsentState` is the single switch the tracker flips after the consent
 * query updates, so these tests exercise the lib directly (the wiring from
 * the Settings UI to `setConsentState` is covered by
 * components/analytics-tracker.consent.test.tsx).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

type Analytics = typeof import("./analytics");

const MAX_QUEUE = 40;

const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));

let analytics: Analytics;

const FULL_CONSENT = {
  analytics: true,
  deviceDetails: true,
  locationCoarse: true,
  locationPrecise: true,
  carrier: true,
  responded: true,
};

function sentBodies(): { context: Record<string, unknown> }[] {
  return fetchMock.mock.calls.map(
    (call) =>
      JSON.parse(((call as unknown as [string, RequestInit])[1]).body as string) as {
        context: Record<string, unknown>;
      },
  );
}

function lastBatchContext(): Record<string, unknown> {
  const bodies = sentBodies();
  expect(bodies.length).toBeGreaterThan(0);
  return bodies[bodies.length - 1]!.context;
}

async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

/** Push enough events to cross MAX_QUEUE and force an immediate flush. */
async function forceFlush() {
  for (let i = 0; i < MAX_QUEUE; i++) analytics.track("feature_use", { n: i });
  await settle();
}

beforeAll(async () => {
  vi.stubGlobal("fetch", fetchMock);
  // jsdom has no geolocation; provide one that answers synchronously so the
  // tracker caches a precise position as soon as the user opts in.
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: {
      getCurrentPosition: (
        success: (pos: {
          coords: { latitude: number; longitude: number };
        }) => void,
      ) => success({ coords: { latitude: 12.9, longitude: 77.6 } }),
    },
  });
  vi.resetModules();
  analytics = await import("./analytics");
});

beforeEach(() => {
  fetchMock.mockClear();
});

describe("web analytics consent gating (immediate effect, no reload)", () => {
  it("with full consent, the batch context carries device details and precise location", async () => {
    analytics.setConsentState(FULL_CONSENT, true);
    await settle(); // geolocation resolves
    await forceFlush();

    const ctx = lastBatchContext();
    expect(ctx.browser).toBeDefined();
    expect(ctx.osVersion).toBeDefined();
    expect(ctx.latitude).toBe(12.9);
    expect(ctx.longitude).toBe(77.6);
    expect(ctx.platform).toBe("web");
  });

  it("opting out of device details and precise location strips them from the VERY NEXT batch, even though values are still cached in memory", async () => {
    analytics.setConsentState(
      { ...FULL_CONSENT, deviceDetails: false, locationPrecise: false },
      true,
    );
    // No settle between the consent change and the next batch: this is the
    // "right away" guarantee — no reload, no async warm-up needed.
    await forceFlush();

    const ctx = lastBatchContext();
    expect(ctx.browser).toBeUndefined();
    expect(ctx.osVersion).toBeUndefined();
    expect(ctx.networkType).toBeUndefined();
    expect(ctx.latitude).toBeUndefined();
    expect(ctx.longitude).toBeUndefined();
    // Ungated basics remain.
    expect(ctx.platform).toBe("web");
    expect(ctx.language).toBeDefined();
  });

  it("re-enabling a category restores it on the next batch", async () => {
    analytics.setConsentState({ ...FULL_CONSENT, deviceDetails: false }, true);
    await forceFlush();
    expect(lastBatchContext().browser).toBeUndefined();

    fetchMock.mockClear();
    analytics.setConsentState(FULL_CONSENT, true);
    await forceFlush();
    expect(lastBatchContext().browser).toBeDefined();
    expect(lastBatchContext().latitude).toBe(12.9);
  });

  it("turning analytics off drops the pending queue and blocks all future sends", async () => {
    // Leave some events pending, then revoke the master toggle.
    analytics.track("feature_use", { pending: true });
    analytics.setConsentState({ ...FULL_CONSENT, analytics: false }, true);

    // Even hammering the tracker cannot trigger a network call.
    for (let i = 0; i < 100; i++) analytics.track("feature_use", { n: i });
    analytics.trackPageView("/somewhere");
    analytics.trackFeatureUse("caption");
    analytics.trackError("boom");
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("turning analytics back on resumes sending", async () => {
    analytics.setConsentState(FULL_CONSENT, true);
    await forceFlush();
    expect(fetchMock).toHaveBeenCalled();
  });
});
