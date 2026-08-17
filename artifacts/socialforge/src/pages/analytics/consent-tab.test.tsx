import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockState: {
  consent: { data: any; isLoading: boolean; isError: boolean };
} = {
  consent: { data: undefined, isLoading: false, isError: false },
};

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../../test/apiClientMock");
  return createApiClientMock({
    useGetConsentAnalytics: () => mockState.consent,
  });
});

import { ConsentTab } from "./consent-tab";
import { ScopeProvider } from "./shared";

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ScopeProvider value={{}}>
        <ConsentTab />
      </ScopeProvider>
    </QueryClientProvider>,
  );
}

const baseData = () => ({
  totalUsers: 8000,
  respondedUsers: 6400,
  optIns: {
    analytics: 6000,
    deviceDetails: 5500,
    locationCoarse: 3200,
    locationPrecise: 800,
    carrier: 1100,
  },
  trends: [
    { date: "2026-08-01", optIns: 120, optOuts: 15 },
    { date: "2026-08-02", optIns: 95, optOuts: 8 },
  ],
});

beforeEach(() => {
  mockState.consent = { data: baseData(), isLoading: false, isError: false };
  cleanup();
});

describe("ConsentTab", () => {
  it("renders the top-level stat cards from hook data", () => {
    renderTab();

    expect(screen.getByTestId("stat-total-users").textContent).toBe("8,000");
    expect(screen.getByTestId("stat-responded-to-consent").textContent).toBe("6,400");
    // responseRate = 6400 / 8000 = 0.80 → "80.0%"
    expect(screen.getByTestId("stat-response-rate").textContent).toBe("80.0%");
  });

  it("renders opt-in category labels in the table", () => {
    renderTab();

    expect(screen.getByText("Opt-ins by category")).toBeTruthy();
    expect(screen.getByText("Usage analytics")).toBeTruthy();
    expect(screen.getByText("Device details")).toBeTruthy();
    expect(screen.getByText("Approximate location")).toBeTruthy();
    expect(screen.getByText("Precise location")).toBeTruthy();
    expect(screen.getByText("Mobile carrier")).toBeTruthy();
  });

  it("renders the consent trends table", () => {
    renderTab();

    expect(screen.getByText("Consent changes over time")).toBeTruthy();
    expect(screen.getByText("2026-08-01")).toBeTruthy();
    expect(screen.getByText("2026-08-02")).toBeTruthy();
  });

  it("shows empty state when trends list is empty", () => {
    mockState.consent = {
      data: { ...baseData(), trends: [] },
      isLoading: false,
      isError: false,
    };
    renderTab();
    expect(screen.getByText("No consent changes in this period.")).toBeTruthy();
  });

  it("shows zero response rate when totalUsers is 0", () => {
    mockState.consent = {
      data: { ...baseData(), totalUsers: 0, respondedUsers: 0 },
      isLoading: false,
      isError: false,
    };
    renderTab();
    expect(screen.getByTestId("stat-response-rate").textContent).toBe("0.0%");
  });

  it("shows the loading skeleton while fetching", () => {
    mockState.consent = { data: undefined, isLoading: true, isError: false };
    const { container } = renderTab();
    expect(screen.queryByTestId("stat-total-users")).toBeNull();
    expect(container.querySelector(".space-y-4")).toBeTruthy();
  });

  it("shows the error card when the hook errors", () => {
    mockState.consent = { data: undefined, isLoading: false, isError: true };
    renderTab();
    expect(
      screen.getByText("Could not load analytics data. Try again in a moment."),
    ).toBeTruthy();
  });
});
