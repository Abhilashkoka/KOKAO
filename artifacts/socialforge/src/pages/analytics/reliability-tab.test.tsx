import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockState: {
  reliability: { data: any; isLoading: boolean; isError: boolean };
} = {
  reliability: { data: undefined, isLoading: false, isError: false },
};

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../../test/apiClientMock");
  return createApiClientMock({
    useGetReliabilityAnalytics: () => mockState.reliability,
  });
});

import { ReliabilityTab } from "./reliability-tab";
import { ScopeProvider } from "./shared";

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ScopeProvider value={{}}>
        <ReliabilityTab />
      </ScopeProvider>
    </QueryClientProvider>,
  );
}

const baseData = () => ({
  errorCount: 312,
  crashCount: 45,
  crashFreeSessionRate: 0.991,
  anrCount: 7,
  apiLatency: [
    { group: "/api/posts", count: 8200, errorRate: 0.012, p50Ms: 120, p95Ms: 480, p99Ms: 950 },
    { group: "/api/media", count: 3100, errorRate: 0.034, p50Ms: 250, p95Ms: 890, p99Ms: 1800 },
  ],
  errorsByType: [
    { name: "NetworkError", count: 200 },
    { name: "TimeoutError", count: 112 },
  ],
  errorsByScreen: [
    { name: "/studio", count: 180 },
    { name: "/accounts", count: 90 },
  ],
  startup: [
    { platform: "android", count: 5000, avgMs: 1200, p95Ms: 2800 },
    { platform: "ios", count: 3200, avgMs: 900, p95Ms: 2100 },
  ],
});

beforeEach(() => {
  mockState.reliability = { data: baseData(), isLoading: false, isError: false };
  cleanup();
});

describe("ReliabilityTab", () => {
  it("renders the top-level stat cards from hook data", () => {
    renderTab();

    expect(screen.getByTestId("stat-errors").textContent).toBe("312");
    expect(screen.getByTestId("stat-crashes").textContent).toBe("45");
    // 0.991 → "99.1%"
    expect(screen.getByTestId("stat-crash-free-sessions").textContent).toBe("99.1%");
    // "App freezes (ANR)" → testid "stat-app-freezes-anr-" (trailing - from trailing non-alphanum)
    expect(screen.getByTestId("stat-app-freezes-anr-").textContent).toBe("7");
  });

  it("renders the API performance table", () => {
    renderTab();

    expect(screen.getByText("API performance")).toBeTruthy();
    expect(screen.getByText("/api/posts")).toBeTruthy();
    expect(screen.getByText("/api/media")).toBeTruthy();
    // p50Ms 120 → "120 ms"
    expect(screen.getByText("120 ms")).toBeTruthy();
    // errorRate 0.012 → "1.2%"
    expect(screen.getByText("1.2%")).toBeTruthy();
    // p99Ms 1800 → "1.80 s"
    expect(screen.getByText("1.80 s")).toBeTruthy();
  });

  it("renders errors by type and by page tables", () => {
    renderTab();

    expect(screen.getByText("Errors by type")).toBeTruthy();
    expect(screen.getByText("NetworkError")).toBeTruthy();
    expect(screen.getByText("TimeoutError")).toBeTruthy();
    expect(screen.getByText("Errors by page")).toBeTruthy();
    expect(screen.getByText("/studio")).toBeTruthy();
  });

  it("renders the app start-up time table", () => {
    renderTab();

    expect(screen.getByText("App start-up time")).toBeTruthy();
    expect(screen.getByText("android")).toBeTruthy();
    expect(screen.getByText("ios")).toBeTruthy();
    // avgMs 1200 → "1.20 s"
    expect(screen.getByText("1.20 s")).toBeTruthy();
  });

  it("shows empty state when apiLatency list is empty", () => {
    mockState.reliability = {
      data: { ...baseData(), apiLatency: [] },
      isLoading: false,
      isError: false,
    };
    renderTab();
    expect(screen.getByText("No API traffic in this period.")).toBeTruthy();
  });

  it("shows empty state when startup list is empty", () => {
    mockState.reliability = {
      data: { ...baseData(), startup: [] },
      isLoading: false,
      isError: false,
    };
    renderTab();
    expect(screen.getByText("No start-up data in this period.")).toBeTruthy();
  });

  it("shows the loading skeleton while fetching", () => {
    mockState.reliability = { data: undefined, isLoading: true, isError: false };
    const { container } = renderTab();
    expect(screen.queryByTestId("stat-errors")).toBeNull();
    expect(container.querySelector(".space-y-4")).toBeTruthy();
  });

  it("shows the error card when the hook errors", () => {
    mockState.reliability = { data: undefined, isLoading: false, isError: true };
    renderTab();
    expect(
      screen.getByText("Could not load analytics data. Try again in a moment."),
    ).toBeTruthy();
  });
});
