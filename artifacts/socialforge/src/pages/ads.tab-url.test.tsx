/**
 * Regression guard for the Ads page ?tab= deep-link handling.
 *
 * The verify-mismatch notification links to /ads?tab=history. The page uses
 * a controlled tab that (a) applies a valid ?tab= value from the URL, and
 * (b) STRIPS the consumed param (replace navigation) so clicking the exact
 * same link again later still produces a fresh search-string change and
 * switches tabs again. Losing either half silently sends users to the wrong
 * tab.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Radix components need a few APIs jsdom doesn't implement.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
if (typeof globalThis.ResizeObserver === "undefined") {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const mockRoute = { search: "" };
const navigateSpy = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("wouter", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("wouter");
  return {
    ...actual,
    useSearch: () => mockRoute.search,
  };
});

vi.mock("wouter/use-browser-location", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "wouter/use-browser-location",
  );
  return {
    ...actual,
    navigate: navigateSpy,
  };
});

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useGetMe: () => ({ data: { team: null }, isLoading: false }),
    useGetAdsStatus: () => ({
      data: {
        enabled: true,
        platforms: [{ platform: "meta", available: true }],
      },
      isLoading: false,
    }),
    useListAdConnections: () => ({
      data: [
        {
          id: 1,
          platform: "meta",
          status: "connected",
          adAccountId: "act_123",
          adAccountName: "Main Account",
          currency: "INR",
        },
      ],
      isLoading: false,
    }),
  });
});

// Imported after the mocks so the mocked modules are picked up.
import { AdsPage } from "./ads";

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // Build a FRESH element on every (re)render — React bails out of
  // re-rendering when handed a referentially identical element, which would
  // silently skip the useSearch() re-read this test depends on.
  const ui = () => (
    <QueryClientProvider client={client}>
      <AdsPage />
    </QueryClientProvider>
  );
  const result = render(ui());
  return { ...result, rerenderPage: () => result.rerender(ui()) };
}

function tabState(testId: string): string | null {
  return screen.getByTestId(testId).getAttribute("data-state");
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockRoute.search = "";
  window.history.replaceState({}, "", "/ads");
});

describe("AdsPage tab-from-URL handling", () => {
  it("defaults to the Campaigns tab without a tab param", () => {
    renderPage();
    expect(tabState("tab-campaigns")).toBe("active");
    expect(tabState("tab-history")).toBe("inactive");
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it("?tab=history selects the Change history tab and strips the consumed param", () => {
    mockRoute.search = "tab=history";
    renderPage();
    expect(tabState("tab-history")).toBe("active");
    expect(tabState("tab-campaigns")).toBe("inactive");
    // The param is consumed: replaced with the bare pathname.
    expect(navigateSpy).toHaveBeenCalledWith("/ads", { replace: true });
  });

  it("preserves other query params when stripping the consumed tab param", () => {
    mockRoute.search = "tab=history&meta=connected";
    renderPage();
    expect(tabState("tab-history")).toBe("active");
    expect(navigateSpy).toHaveBeenCalledWith("/ads?meta=connected", {
      replace: true,
    });
  });

  it("ignores unknown tab values and does not rewrite the URL", () => {
    mockRoute.search = "tab=bogus";
    renderPage();
    expect(tabState("tab-campaigns")).toBe("active");
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it("a repeated identical link click still switches back to Change history", () => {
    // First click on the alert link: ?tab=history arrives.
    mockRoute.search = "tab=history";
    const { rerenderPage } = renderPage();
    expect(tabState("tab-history")).toBe("active");
    expect(navigateSpy).toHaveBeenCalledWith("/ads", { replace: true });

    // The page consumed the param (URL is back to /ads).
    mockRoute.search = "";
    rerenderPage();

    // The user wanders off to another tab.
    // Radix tabs activate on mousedown rather than click.
    fireEvent.mouseDown(screen.getByTestId("tab-campaigns"), { button: 0 });
    expect(tabState("tab-campaigns")).toBe("active");
    expect(tabState("tab-history")).toBe("inactive");

    // Clicking the exact same /ads?tab=history link again produces a fresh
    // search change (only possible because the param was stripped earlier)
    // and must switch tabs again.
    navigateSpy.mockClear();
    mockRoute.search = "tab=history";
    rerenderPage();
    expect(tabState("tab-history")).toBe("active");
    expect(tabState("tab-campaigns")).toBe("inactive");
    expect(navigateSpy).toHaveBeenCalledWith("/ads", { replace: true });
  });
});
