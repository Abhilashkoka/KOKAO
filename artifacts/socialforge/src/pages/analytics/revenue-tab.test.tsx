import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockState: {
  revenue: { data: any; isLoading: boolean; isError: boolean };
} = {
  revenue: { data: undefined, isLoading: false, isError: false },
};

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../../test/apiClientMock");
  return createApiClientMock({
    useGetRevenueAnalytics: () => mockState.revenue,
  });
});

import { RevenueTab } from "./revenue-tab";
import { ScopeProvider } from "./shared";

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ScopeProvider value={{}}>
        <RevenueTab />
      </ScopeProvider>
    </QueryClientProvider>,
  );
}

const baseData = () => ({
  purchaseTotalPaise: 150000,
  purchaseCount: 42,
  refundTotalPaise: 5000,
  refundCount: 3,
  arpuPaise: 25000,
  subscriptionsStarted: 18,
  subscriptionsRenewed: 11,
  subscriptionsCancelled: 4,
  byPlan: [
    { name: "Pro Monthly", count: 30, totalPaise: 120000 },
    { name: "Starter", count: 12, totalPaise: 30000 },
  ],
  byCreditPack: [{ name: "Pack 500", count: 7, totalPaise: 35000 }],
  cancelReasons: [{ name: "Too expensive", count: 2 }],
});

beforeEach(() => {
  mockState.revenue = { data: baseData(), isLoading: false, isError: false };
  cleanup();
});

describe("RevenueTab — stat cards", () => {
  it("renders the Revenue StatCard value from purchaseTotalPaise", () => {
    renderTab();
    // purchaseTotalPaise 150000 paise = ₹1500; en-IN INR format
    const cell = screen.getByTestId("stat-revenue");
    expect(cell.textContent).toContain("1,500");
  });

  it("shows purchase count in the Revenue hint", () => {
    renderTab();
    expect(screen.getByText("42 purchases")).toBeTruthy();
  });

  it("renders the Refunds StatCard value from refundTotalPaise", () => {
    renderTab();
    const cell = screen.getByTestId("stat-refunds");
    // 5000 paise = ₹50
    expect(cell.textContent).toContain("50");
  });

  it("shows refund count in the Refunds hint", () => {
    renderTab();
    expect(screen.getByText("3 refunds")).toBeTruthy();
  });

  it("renders the ARPU StatCard value from arpuPaise", () => {
    renderTab();
    const cell = screen.getByTestId("stat-arpu");
    // 25000 paise = ₹250
    expect(cell.textContent).toContain("250");
  });

  it("renders subscriptions-started count", () => {
    renderTab();
    expect(screen.getByTestId("stat-subscriptions-started").textContent).toBe("18");
  });

  it("renders subscriptions-renewed count", () => {
    renderTab();
    expect(screen.getByTestId("stat-subscriptions-renewed").textContent).toBe("11");
  });

  it("renders subscriptions-cancelled count", () => {
    renderTab();
    expect(screen.getByTestId("stat-subscriptions-cancelled").textContent).toBe("4");
  });
});

describe("RevenueTab — MoneyTable rows", () => {
  it("shows Revenue by plan table with plan name rows", () => {
    renderTab();
    expect(screen.getByText("Revenue by plan")).toBeTruthy();
    expect(screen.getByText("Pro Monthly")).toBeTruthy();
    expect(screen.getByText("Starter")).toBeTruthy();
  });

  it("shows Revenue by credit pack table with pack name rows", () => {
    renderTab();
    expect(screen.getByText("Revenue by credit pack")).toBeTruthy();
    expect(screen.getByText("Pack 500")).toBeTruthy();
  });

  it("shows 'No purchases in this period' when byPlan is empty", () => {
    mockState.revenue = {
      data: { ...baseData(), byPlan: [] },
      isLoading: false,
      isError: false,
    };
    renderTab();
    const empties = screen.getAllByText("No purchases in this period.");
    // At least the byPlan card shows the empty message
    expect(empties.length).toBeGreaterThanOrEqual(1);
  });
});

describe("RevenueTab — loading and error states", () => {
  it("shows the loading skeleton while fetching", () => {
    mockState.revenue = { data: undefined, isLoading: true, isError: false };
    const { container } = renderTab();
    // Stat cards should not be present during loading
    expect(screen.queryByTestId("stat-revenue")).toBeNull();
    // TabLoading renders a skeleton container
    expect(container.querySelector(".space-y-4")).toBeTruthy();
  });

  it("shows the error card when the hook errors", () => {
    mockState.revenue = { data: undefined, isLoading: false, isError: true };
    renderTab();
    expect(
      screen.getByText("Could not load analytics data. Try again in a moment."),
    ).toBeTruthy();
  });

  it("shows the error card when data is undefined (no error flag)", () => {
    mockState.revenue = { data: undefined, isLoading: false, isError: false };
    renderTab();
    expect(
      screen.getByText("Could not load analytics data. Try again in a moment."),
    ).toBeTruthy();
  });
});
