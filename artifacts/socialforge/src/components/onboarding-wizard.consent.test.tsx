/**
 * Guard: the privacy choices a new user makes in the ONBOARDING wizard must
 * reach the analytics tracker's consent state IMMEDIATELY after the PUT
 * /consent succeeds — via invalidation of the shared consent query key, not a
 * page reload. OnboardingWizard and AnalyticsTracker are mounted together with
 * a REAL QueryClient and the real generated hooks; only the network is faked.
 * (Same pattern as analytics-tracker.consent.test.tsx, which covers Settings.)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/analytics", () => ({
  initAnalytics: vi.fn(),
  setConsentState: vi.fn(),
  trackPageView: vi.fn(),
  trackSignUpOnce: vi.fn(),
  track: vi.fn(),
}));
vi.mock("@clerk/react", () => ({
  useUser: () => ({ isSignedIn: true, user: null }),
}));

import { setConsentState } from "@/lib/analytics";
import { AnalyticsTracker } from "./analytics-tracker";
import { OnboardingWizard } from "./onboarding-wizard";

type Consent = Record<string, unknown>;

let serverConsent: Consent;
let putCount: number;

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input.toString();
  const method = (init?.method ?? "GET").toUpperCase();
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  if (url.includes("/consent")) {
    if (method === "PUT") {
      putCount++;
      serverConsent = {
        ...serverConsent,
        ...JSON.parse(String(init?.body)),
        responded: true,
      };
    }
    return json(serverConsent);
  }
  if (url.includes("/me")) {
    return json({
      tenantId: "t1",
      email: "user@example.com",
      isSuperadmin: false,
      brandOnboardingComplete: false,
    });
  }
  throw new Error(`unexpected fetch: ${url}`);
});

vi.stubGlobal("fetch", fetchMock);

function mount() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AnalyticsTracker />
      <OnboardingWizard />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(setConsentState).mockClear();
  fetchMock.mockClear();
  putCount = 0;
  // New user: has not answered the privacy question yet, nothing granted.
  serverConsent = {
    analytics: false,
    deviceDetails: false,
    locationCoarse: false,
    locationPrecise: false,
    carrier: false,
    responded: false,
  };
});

function lastConsentPushedToTracker(): Record<string, unknown> | null {
  const calls = vi.mocked(setConsentState).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1]![0] as Record<string, unknown> | null;
}

describe("onboarding consent step -> analytics tracker (no reload)", () => {
  it("declining everything during onboarding marks consent as responded in the tracker without a reload", async () => {
    mount();

    // The consent step of the wizard is showing.
    const continueBtn = await screen.findByRole("button", {
      name: /continue/i,
    });

    // User leaves every toggle off (decline) and continues.
    fireEvent.click(continueBtn);

    await waitFor(() => expect(putCount).toBe(1));
    await waitFor(() => {
      expect(lastConsentPushedToTracker()).toMatchObject({
        analytics: false,
        deviceDetails: false,
        locationCoarse: false,
        locationPrecise: false,
        responded: true,
      });
    });
  });

  it("opting in to a single category during onboarding reaches the tracker the same way", async () => {
    mount();

    const analyticsSwitch = await screen.findByRole("switch", {
      name: "Usage analytics",
    });
    expect(analyticsSwitch.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(analyticsSwitch);

    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => expect(putCount).toBe(1));
    await waitFor(() => {
      expect(lastConsentPushedToTracker()).toMatchObject({
        analytics: true,
        deviceDetails: false,
        responded: true,
      });
    });
  });
});
