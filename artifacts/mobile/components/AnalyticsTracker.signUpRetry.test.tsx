/**
 * Guard: when the server returns {accepted:0} for the initial sign_up send
 * (consent not yet stored server-side), AnalyticsTracker must retry
 * trackSignUpOnce as soon as the analytics consent flag flips to true — not
 * just on the next app launch. This exercises the analyticsConsented dep
 * added to the sign-up useEffect in AnalyticsTracker.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// vi.mock is hoisted to the top of the file, so any variables it closes over
// must be declared with vi.hoisted so they exist at hoist time.
const {
  mockTrackSignUpOnce,
  mockSetConsentState,
  mockUseUser,
  mockUseAuth,
} = vi.hoisted(() => ({
  mockTrackSignUpOnce: vi.fn(),
  mockSetConsentState: vi.fn(),
  mockUseUser: vi.fn(() => ({ user: null as { id: string; createdAt: Date } | null })),
  mockUseAuth: vi.fn(() => ({
    isSignedIn: false,
    getToken: async () => null as string | null,
  })),
}));

vi.mock("@/lib/analytics", () => ({
  initAnalytics: vi.fn(),
  setAnalyticsAuth: vi.fn(),
  setConsentState: mockSetConsentState,
  trackScreenView: vi.fn(),
  trackSignUpOnce: mockTrackSignUpOnce,
}));
vi.mock("@clerk/expo", () => ({
  useAuth: () => mockUseAuth(),
  useUser: () => mockUseUser(),
}));
vi.mock("expo-router", () => ({ usePathname: () => "/" }));

/** Simulated analytics consent value served by the fake consent endpoint. */
let serverAnalyticsConsent = false;

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input.toString();
  if (url.includes("/api/consent")) {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "PUT") {
      const body = JSON.parse(String(init?.body)) as { analytics?: boolean };
      if (typeof body.analytics === "boolean") serverAnalyticsConsent = body.analytics;
    }
    return new Response(
      JSON.stringify({
        analytics: serverAnalyticsConsent,
        deviceDetails: false,
        locationCoarse: false,
        locationPrecise: false,
        carrier: false,
        responded: true,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  throw new Error(`unexpected fetch: ${url}`);
});

vi.stubGlobal("fetch", fetchMock);

import { AnalyticsTracker } from "./AnalyticsTracker";
import { getGetConsentQueryKey } from "@workspace/api-client-react";

function mountTracker() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const utils = render(
    <QueryClientProvider client={qc}>
      <AnalyticsTracker />
    </QueryClientProvider>,
  );
  return { qc, ...utils };
}

const FRESH_USER = { id: "user_fresh", createdAt: new Date() };

beforeEach(() => {
  mockTrackSignUpOnce.mockClear();
  mockSetConsentState.mockClear();
  fetchMock.mockClear();
  serverAnalyticsConsent = false;
  mockUseAuth.mockReturnValue({ isSignedIn: true, getToken: async () => null });
  mockUseUser.mockReturnValue({ user: FRESH_USER });
});

describe("AnalyticsTracker sign-up retry on consent grant", () => {
  it("calls trackSignUpOnce again when analyticsConsented flips from false to true", async () => {
    // Consent query resolves with analytics: false — server returns accepted:0
    // in real flows; here we just verify the effect re-runs on the flag change.
    const { qc } = mountTracker();

    // First call fires immediately once user + isSignedIn are truthy.
    await waitFor(() => expect(mockTrackSignUpOnce).toHaveBeenCalledTimes(1));
    expect(mockTrackSignUpOnce).toHaveBeenCalledWith(FRESH_USER.id, FRESH_USER.createdAt);

    // User grants analytics consent — invalidate so the tracker re-fetches.
    serverAnalyticsConsent = true;
    await qc.invalidateQueries({ queryKey: getGetConsentQueryKey() });

    // The analyticsConsented dep change triggers a second call so the marker
    // can be committed now that the server will accept the event.
    await waitFor(() => expect(mockTrackSignUpOnce).toHaveBeenCalledTimes(2));
    expect(mockTrackSignUpOnce).toHaveBeenNthCalledWith(2, FRESH_USER.id, FRESH_USER.createdAt);
  });

  it("does NOT call trackSignUpOnce when there is no signed-in user", async () => {
    mockUseUser.mockReturnValue({ user: null });
    mountTracker();
    await new Promise((r) => setTimeout(r, 50));
    expect(mockTrackSignUpOnce).not.toHaveBeenCalled();
  });
});
