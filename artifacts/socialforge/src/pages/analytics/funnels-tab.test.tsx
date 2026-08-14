import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockState: {
  funnels: { data: any; isLoading: boolean; isError: boolean };
} = {
  funnels: { data: undefined, isLoading: false, isError: false },
};

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../../test/apiClientMock");
  return createApiClientMock({
    useGetFunnelAnalytics: () => mockState.funnels,
  });
});

import { FunnelsTab } from "./funnels-tab";
import { ScopeProvider } from "./shared";

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ScopeProvider value={{}}>
        <FunnelsTab />
      </ScopeProvider>
    </QueryClientProvider>,
  );
}

const baseData = () => ({
  onboarding: {
    started: 120,
    completed: 90,
    completionRate: 0.75,
    avgCompletionTimeSec: 45,
  },
  activationRate: 0.42,
  accountsConnected: 60,
  avgTimeToFirstPublishSec: 90,
  firstPostNudge: {
    shown: 1234,
    clicked: 321,
    clickRate: 0.2601,
    publishedAfterShown: 111,
    conversionRate: 0.0899,
    dismissed: 45,
    dismissRate: 0.0365,
  },
  funnel: [
    { step: "Signed up", count: 200, dropOffPct: 0 },
    { step: "Published first post", count: 80, dropOffPct: 60 },
  ],
});

beforeEach(() => {
  mockState.funnels = { data: baseData(), isLoading: false, isError: false };
  cleanup();
});

describe("FunnelsTab first-post nudge effectiveness panel", () => {
  it("renders the nudge counts and rates from the hook data", () => {
    renderTab();

    expect(screen.getByText("First-post nudge effectiveness")).toBeTruthy();

    // Counts (en-IN formatted) via StatCard testids derived from labels.
    expect(screen.getByTestId("stat-saw-the-checklist").textContent).toBe("1,234");
    expect(screen.getByTestId("stat-clicked-a-step").textContent).toBe("321");
    expect(screen.getByTestId("stat-published-after-seeing-it").textContent).toBe("111");
    expect(screen.getByTestId("stat-dismissed").textContent).toBe("45");

    // Rates rendered in the hints.
    expect(screen.getByText("Click rate: 26.0%")).toBeTruthy();
    expect(screen.getByText("Conversion rate: 9.0%")).toBeTruthy();
    expect(screen.getByText("Dismiss rate: 3.6%")).toBeTruthy();
  });

  it("renders the surrounding funnel stats and table too", () => {
    renderTab();
    expect(screen.getByTestId("stat-onboarding-started").textContent).toBe("120");
    expect(screen.getByTestId("stat-activation-rate").textContent).toBe("42.0%");
    expect(screen.getByText("Published first post")).toBeTruthy();
    expect(screen.getByText("60.0%")).toBeTruthy();
  });

  it("shows the loading skeleton while fetching", () => {
    mockState.funnels = { data: undefined, isLoading: true, isError: false };
    const { container } = renderTab();
    expect(screen.queryByText("First-post nudge effectiveness")).toBeNull();
    expect(container.querySelector(".space-y-4")).toBeTruthy();
  });

  it("shows the error card when the hook errors", () => {
    mockState.funnels = { data: undefined, isLoading: false, isError: true };
    renderTab();
    expect(
      screen.getByText("Could not load analytics data. Try again in a moment."),
    ).toBeTruthy();
  });
});
