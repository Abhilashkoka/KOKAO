import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockState: {
  audience: { data: any; isLoading: boolean; isError: boolean };
} = {
  audience: { data: undefined, isLoading: false, isError: false },
};

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../../test/apiClientMock");
  return createApiClientMock({
    useGetAudienceAnalytics: () => mockState.audience,
  });
});

import { AudienceTab } from "./audience-tab";
import { ScopeProvider } from "./shared";

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ScopeProvider value={{}}>
        <AudienceTab />
      </ScopeProvider>
    </QueryClientProvider>,
  );
}

const baseData = () => ({
  mau: 4200,
  stickiness: 0.35,
  sessions: 18500,
  avgSessionLengthSec: 125,
  retention: { d1: 0.62, d7: 0.41, d30: 0.18 },
  dau: [{ date: "2026-08-10", count: 1200 }],
  countries: [{ name: "India", count: 3000 }],
  platforms: [{ name: "android", count: 2800 }],
  browsers: [{ name: "Chrome", count: 1500 }],
  deviceModels: [{ name: "Pixel 7", count: 400 }],
});

beforeEach(() => {
  mockState.audience = { data: baseData(), isLoading: false, isError: false };
  cleanup();
});

describe("AudienceTab", () => {
  it("renders the top-level stat cards from hook data", () => {
    renderTab();

    expect(screen.getByTestId("stat-monthly-active-users").textContent).toBe("4,200");
    expect(screen.getByTestId("stat-stickiness").textContent).toBe("35.0%");
    expect(screen.getByTestId("stat-sessions").textContent).toBe("18,500");
    // 125s = 2m 5s
    expect(screen.getByTestId("stat-avg-session-length").textContent).toBe("2m 5s");
  });

  it("renders the retention stat cards", () => {
    renderTab();

    expect(screen.getByTestId("stat-day-1-retention").textContent).toBe("62.0%");
    expect(screen.getByTestId("stat-day-7-retention").textContent).toBe("41.0%");
    expect(screen.getByTestId("stat-day-30-retention").textContent).toBe("18.0%");
  });

  it("renders the dimension breakdown tables", () => {
    renderTab();

    expect(screen.getByText("Countries")).toBeTruthy();
    expect(screen.getByText("India")).toBeTruthy();
    expect(screen.getByText("Platforms")).toBeTruthy();
    expect(screen.getByText("android")).toBeTruthy();
    expect(screen.getByText("Browsers")).toBeTruthy();
    expect(screen.getByText("Chrome")).toBeTruthy();
    expect(screen.getByText("Device models")).toBeTruthy();
    expect(screen.getByText("Pixel 7")).toBeTruthy();
  });

  it("shows the loading skeleton while fetching", () => {
    mockState.audience = { data: undefined, isLoading: true, isError: false };
    const { container } = renderTab();
    expect(screen.queryByTestId("stat-monthly-active-users")).toBeNull();
    expect(container.querySelector(".space-y-4")).toBeTruthy();
  });

  it("shows the error card when the hook errors", () => {
    mockState.audience = { data: undefined, isLoading: false, isError: true };
    renderTab();
    expect(
      screen.getByText("Could not load analytics data. Try again in a moment."),
    ).toBeTruthy();
  });
});
