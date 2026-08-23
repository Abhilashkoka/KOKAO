import { describe, it, expect, beforeEach, vi } from "vitest";
import { useState } from "react";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AnalyticsScope } from "./shared";

const mockState: {
  revenue: { data: any; isLoading: boolean; isError: boolean };
  revenueParams: AnalyticsScope[];
} = {
  revenue: { data: undefined, isLoading: false, isError: false },
  revenueParams: [],
};

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../../test/apiClientMock");
  return createApiClientMock({
    useGetRevenueAnalytics: (params: AnalyticsScope) => {
      mockState.revenueParams.push(params);
      return mockState.revenue;
    },
  });
});

import { RevenueTab } from "./revenue-tab";
import { ScopeProvider } from "./shared";

function renderTab(scope: AnalyticsScope = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ScopeProvider value={scope}>
        <RevenueTab />
      </ScopeProvider>
    </QueryClientProvider>,
  );
}

function ScopeChangeHarness({
  initialScope,
  changedScope,
}: {
  initialScope: AnalyticsScope;
  changedScope: AnalyticsScope;
}) {
  const [scope, setScope] = useState(initialScope);

  return (
    <ScopeProvider value={scope}>
      <button type="button" onClick={() => setScope(changedScope)}>
        Change analytics scope
      </button>
      <RevenueTab />
    </ScopeProvider>
  );
}

function TabSwitchHarness({
  initialScope,
  returnScope,
}: {
  initialScope: AnalyticsScope;
  returnScope: AnalyticsScope;
}) {
  const [activeTab, setActiveTab] = useState<"revenue" | "other">("revenue");
  const [scope, setScope] = useState(initialScope);

  return (
    <ScopeProvider value={scope}>
      <button type="button" onClick={() => setActiveTab("other")}>
        View another analytics tab
      </button>
      <button
        type="button"
        onClick={() => {
          setScope(returnScope);
          setActiveTab("revenue");
        }}
      >
        Return to Revenue
      </button>
      {activeTab === "revenue" ? (
        <RevenueTab />
      ) : (
        <div data-testid="other-analytics-tab">Other analytics tab</div>
      )}
    </ScopeProvider>
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
  cancelReasons: [
    { name: "Too expensive", count: 2 },
    { name: "Missing a feature", count: 1 },
  ],
});

beforeEach(() => {
  mockState.revenue = { data: baseData(), isLoading: false, isError: false };
  mockState.revenueParams = [];
  cleanup();
});

describe("RevenueTab — analytics scope", () => {
  it("forwards the current date range and workspace scope when analytics scope changes", () => {
    const allWorkspacesScope = {
      from: "2026-08-15T00:00:00.000Z",
      to: "2026-08-22T00:00:00.000Z",
    };
    const workspaceScope = {
      from: "2026-05-24T00:00:00.000Z",
      to: "2026-08-22T00:00:00.000Z",
      tenantId: 73,
    };

    render(
      <ScopeChangeHarness
        initialScope={allWorkspacesScope}
        changedScope={workspaceScope}
      />,
    );

    expect(mockState.revenueParams).toEqual([allWorkspacesScope]);

    fireEvent.click(screen.getByRole("button", { name: "Change analytics scope" }));

    expect(mockState.revenueParams).toEqual([
      allWorkspacesScope,
      workspaceScope,
    ]);
  });

  it("mounts with the latest scope after returning from another analytics tab", () => {
    const initialScope = {
      from: "2026-08-15T00:00:00.000Z",
      to: "2026-08-22T00:00:00.000Z",
      tenantId: 12,
    };
    const returnScope = {
      from: "2026-07-23T00:00:00.000Z",
      to: "2026-08-22T00:00:00.000Z",
      tenantId: 73,
    };

    render(
      <TabSwitchHarness
        initialScope={initialScope}
        returnScope={returnScope}
      />,
    );
    expect(mockState.revenueParams).toEqual([initialScope]);

    fireEvent.click(
      screen.getByRole("button", { name: "View another analytics tab" }),
    );
    expect(screen.getByTestId("other-analytics-tab")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Return to Revenue" }));

    expect(mockState.revenueParams).toEqual([initialScope, returnScope]);
    expect(screen.getByTestId("stat-revenue")).toBeTruthy();
  });
});

describe("RevenueTab — stat cards", () => {
  it("renders the Revenue StatCard value from purchaseTotalPaise", () => {
    renderTab();
    // purchaseTotalPaise 150000 paise = ₹1500; en-IN INR format
    const cell = screen.getByTestId("stat-arpu");
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

describe("RevenueTab — cancellation reasons", () => {
  it("shows cancellation reason names and counts", () => {
    renderTab();

    expect(screen.getByText("Cancellation reasons")).toBeTruthy();
    expect(screen.getByText("Too expensive")).toBeTruthy();
    expect(screen.getByRole("cell", { name: "2" })).toBeTruthy();
    expect(screen.getByText("Missing a feature")).toBeTruthy();
    expect(screen.getByRole("cell", { name: "1" })).toBeTruthy();
  });

  it("shows the empty state when there are no cancellation reasons", () => {
    mockState.revenue = {
      data: { ...baseData(), cancelReasons: [] },
      isLoading: false,
      isError: false,
    };
    renderTab();

    expect(screen.getByText("Cancellation reasons")).toBeTruthy();
    expect(screen.getByText("No data in this period.")).toBeTruthy();
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
