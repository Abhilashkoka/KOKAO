/**
 * Guard: flipping a toggle on the mobile Privacy screen must update the
 * analytics tracker's consent state IMMEDIATELY after the PUT /consent
 * succeeds — via query invalidation of the shared consent query key, not an
 * app restart. PrivacyScreen and AnalyticsTracker are mounted together with
 * a REAL QueryClient and real generated hooks; only the network is faked.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/analytics", () => ({
  initAnalytics: vi.fn(),
  setAnalyticsAuth: vi.fn(),
  setConsentState: vi.fn(),
  trackScreenView: vi.fn(),
  trackSignUpOnce: vi.fn(),
}));
vi.mock("@clerk/expo", () => ({
  useAuth: () => ({ isSignedIn: true, getToken: async () => null }),
  useUser: () => ({ user: null }),
}));
vi.mock("expo-router", () => ({ usePathname: () => "/privacy" }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("@/components/ui", () => ({
  Card: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  ErrorState: () => <div>error</div>,
  Skeleton: () => <div>loading</div>,
}));

import { setConsentState } from "@/lib/analytics";
import { AnalyticsTracker } from "./AnalyticsTracker";
import PrivacyScreen from "@/app/privacy";

type Consent = Record<string, unknown>;

let serverConsent: Consent;
let getCount: number;
let putCount: number;

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input.toString();
  if (!url.includes("/api/consent")) throw new Error(`unexpected fetch: ${url}`);
  const method = (init?.method ?? "GET").toUpperCase();
  if (method === "PUT") {
    putCount++;
    serverConsent = { ...serverConsent, ...JSON.parse(String(init?.body)) };
  } else {
    getCount++;
  }
  return new Response(JSON.stringify(serverConsent), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});

vi.stubGlobal("fetch", fetchMock);

function mount() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AnalyticsTracker />
      <PrivacyScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(setConsentState).mockClear();
  fetchMock.mockClear();
  getCount = 0;
  putCount = 0;
  serverConsent = {
    analytics: true,
    deviceDetails: true,
    locationCoarse: true,
    locationPrecise: false,
    carrier: true,
    responded: true,
  };
});

describe("Privacy toggle -> AnalyticsTracker consent propagation", () => {
  it("pushes the loaded consent into the tracker on mount", async () => {
    mount();
    await waitFor(() => {
      expect(setConsentState).toHaveBeenCalledWith(
        expect.objectContaining({ carrier: true, analytics: true }),
        true,
      );
    });
  });

  it("toggling a category off re-fetches consent and updates the tracker without a remount", async () => {
    mount();
    await waitFor(() => {
      expect(setConsentState).toHaveBeenCalledWith(
        expect.objectContaining({ carrier: true }),
        true,
      );
    });
    const getsBefore = getCount;

    const carrierSwitch = await screen.findByLabelText("Mobile carrier");
    fireEvent.click(carrierSwitch);

    // PUT persisted, invalidation re-fetched despite the tracker's staleTime,
    // and the tracker received the updated consent — all in the same mount.
    await waitFor(() => {
      expect(putCount).toBe(1);
      expect(getCount).toBeGreaterThan(getsBefore);
      expect(setConsentState).toHaveBeenCalledWith(
        expect.objectContaining({ carrier: false, analytics: true }),
        true,
      );
    });
    const lastCall = vi.mocked(setConsentState).mock.calls.at(-1)!;
    expect((lastCall[0] as unknown as Consent).carrier).toBe(false);
  });

  it("turning off the master analytics switch reaches the tracker the same way", async () => {
    mount();
    await waitFor(() => {
      expect(setConsentState).toHaveBeenCalledWith(
        expect.objectContaining({ analytics: true }),
        true,
      );
    });

    const analyticsSwitch = await screen.findByLabelText("Usage analytics");
    fireEvent.click(analyticsSwitch);

    await waitFor(() => {
      const lastCall = vi.mocked(setConsentState).mock.calls.at(-1)!;
      expect((lastCall[0] as unknown as Consent).analytics).toBe(false);
    });
  });
});
