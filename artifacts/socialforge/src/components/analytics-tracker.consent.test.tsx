/**
 * Guard: flipping a toggle in the web Privacy & Data settings must update the
 * analytics tracker's consent state IMMEDIATELY after the PUT /consent
 * succeeds — via invalidation of the shared consent query key, not a page
 * reload. ConsentSettings and AnalyticsTracker are mounted together with a
 * REAL QueryClient and the real generated hooks; only the network is faked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/analytics", () => ({
  initAnalytics: vi.fn(),
  setConsentState: vi.fn(),
  trackPageView: vi.fn(),
  trackSignUpOnce: vi.fn(),
}));
vi.mock("@clerk/react", () => ({
  useUser: () => ({ isSignedIn: true, user: null }),
}));

import { setConsentState } from "@/lib/analytics";
import { AnalyticsTracker } from "./analytics-tracker";
import { ConsentSettings } from "./consent-settings";

type Consent = Record<string, unknown>;

let serverConsent: Consent;
let putCount: number;

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input.toString();
  if (!url.includes("/consent")) throw new Error(`unexpected fetch: ${url}`);
  const method = (init?.method ?? "GET").toUpperCase();
  if (method === "PUT") {
    putCount++;
    serverConsent = { ...serverConsent, ...JSON.parse(String(init?.body)) };
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
      <ConsentSettings />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(setConsentState).mockClear();
  fetchMock.mockClear();
  putCount = 0;
  serverConsent = {
    analytics: true,
    deviceDetails: true,
    locationCoarse: true,
    locationPrecise: false,
    carrier: false,
    responded: true,
  };
});

function lastConsentPushedToTracker(): Record<string, unknown> | null {
  const calls = vi.mocked(setConsentState).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1]![0] as Record<string, unknown> | null;
}

describe("web consent settings -> analytics tracker (no reload)", () => {
  it("pushes the loaded consent into the tracker on mount", async () => {
    mount();
    await waitFor(() => {
      expect(lastConsentPushedToTracker()).toMatchObject({
        analytics: true,
        deviceDetails: true,
      });
    });
    expect(vi.mocked(setConsentState).mock.calls.at(-1)![1]).toBe(true);
  });

  it("turning a category off updates the tracker right after the save, without a reload", async () => {
    mount();
    const deviceSwitch = await screen.findByRole("switch", {
      name: "Device details",
    });
    expect(deviceSwitch.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(deviceSwitch);

    await waitFor(() => expect(putCount).toBe(1));
    await waitFor(() => {
      expect(lastConsentPushedToTracker()).toMatchObject({
        deviceDetails: false,
        analytics: true,
      });
    });
  });

  it("turning the master analytics toggle off reaches the tracker the same way", async () => {
    mount();
    const masterSwitch = await screen.findByRole("switch", {
      name: "Usage analytics",
    });
    fireEvent.click(masterSwitch);

    await waitFor(() => expect(putCount).toBe(1));
    await waitFor(() => {
      expect(lastConsentPushedToTracker()).toMatchObject({ analytics: false });
    });
  });
});
