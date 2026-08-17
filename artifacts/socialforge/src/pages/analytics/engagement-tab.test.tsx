import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockState: {
  engagement: { data: any; isLoading: boolean; isError: boolean };
} = {
  engagement: { data: undefined, isLoading: false, isError: false },
};

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../../test/apiClientMock");
  return createApiClientMock({
    useGetEngagementAnalytics: () => mockState.engagement,
  });
});

import { EngagementTab } from "./engagement-tab";
import { ScopeProvider } from "./shared";

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ScopeProvider value={{}}>
        <EngagementTab />
      </ScopeProvider>
    </QueryClientProvider>,
  );
}

const baseData = () => ({
  pageViews: 32100,
  search: {
    total: 4500,
    zeroResultRate: 0.078,
    topTerms: [
      { name: "schedule post", count: 320 },
      { name: "connect instagram", count: 180 },
    ],
  },
  features: [
    { feature: "caption-generator", uses: 1200, uniqueUsers: 430 },
    { feature: "scheduler", uses: 890, uniqueUsers: 310 },
  ],
  keyActions: [
    { name: "Published post", count: 750 },
    { name: "Connected account", count: 210 },
  ],
  topPages: [
    { name: "/dashboard", count: 9800 },
    { name: "/studio", count: 5400 },
  ],
  navigationPaths: [
    { from: "/onboarding", to: "/schedule", count: 1100 },
    { from: "/settings", to: "/billing", count: 430 },
  ],
});

beforeEach(() => {
  mockState.engagement = { data: baseData(), isLoading: false, isError: false };
  cleanup();
});

describe("EngagementTab", () => {
  it("renders the top-level stat cards from hook data", () => {
    renderTab();

    expect(screen.getByTestId("stat-page-views").textContent).toBe("32,100");
    expect(screen.getByTestId("stat-searches").textContent).toBe("4,500");
    // 0.078 → "7.8%"
    expect(screen.getByTestId("stat-zero-result-searches").textContent).toBe("7.8%");
  });

  it("renders the feature adoption table", () => {
    renderTab();

    expect(screen.getByText("Feature adoption")).toBeTruthy();
    expect(screen.getByText("caption-generator")).toBeTruthy();
    expect(screen.getByText("scheduler")).toBeTruthy();
    expect(screen.getByText("1,200")).toBeTruthy();
  });

  it("renders key actions and top pages tables", () => {
    renderTab();

    expect(screen.getByText("Key actions")).toBeTruthy();
    expect(screen.getByText("Published post")).toBeTruthy();
    expect(screen.getByText("Top pages")).toBeTruthy();
    expect(screen.getByText("/dashboard")).toBeTruthy();
  });

  it("renders the top search terms table", () => {
    renderTab();

    expect(screen.getByText("Top search terms")).toBeTruthy();
    expect(screen.getByText("schedule post")).toBeTruthy();
    expect(screen.getByText("connect instagram")).toBeTruthy();
  });

  it("renders the navigation paths table", () => {
    renderTab();

    expect(screen.getByText("Navigation paths")).toBeTruthy();
    expect(screen.getByText("/onboarding")).toBeTruthy();
    expect(screen.getByText("/billing")).toBeTruthy();
  });

  it("shows empty state when features list is empty", () => {
    mockState.engagement = {
      data: { ...baseData(), features: [] },
      isLoading: false,
      isError: false,
    };
    renderTab();
    expect(screen.getByText("No feature usage in this period.")).toBeTruthy();
  });

  it("shows empty state when navigation paths list is empty", () => {
    mockState.engagement = {
      data: { ...baseData(), navigationPaths: [] },
      isLoading: false,
      isError: false,
    };
    renderTab();
    expect(screen.getByText("No navigation data in this period.")).toBeTruthy();
  });

  it("shows the loading skeleton while fetching", () => {
    mockState.engagement = { data: undefined, isLoading: true, isError: false };
    const { container } = renderTab();
    expect(screen.queryByTestId("stat-page-views")).toBeNull();
    expect(container.querySelector(".space-y-4")).toBeTruthy();
  });

  it("shows the error card when the hook errors", () => {
    mockState.engagement = { data: undefined, isLoading: false, isError: true };
    renderTab();
    expect(
      screen.getByText("Could not load analytics data. Try again in a moment."),
    ).toBeTruthy();
  });
});
