import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockState: {
  acquisition: { data: any; isLoading: boolean; isError: boolean };
} = {
  acquisition: { data: undefined, isLoading: false, isError: false },
};

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../../test/apiClientMock");
  return createApiClientMock({
    useGetAcquisitionAnalytics: () => mockState.acquisition,
  });
});

import { AcquisitionTab } from "./acquisition-tab";
import { ScopeProvider } from "./shared";

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ScopeProvider value={{}}>
        <AcquisitionTab />
      </ScopeProvider>
    </QueryClientProvider>,
  );
}

const baseData = () => ({
  firstOpens: 5432,
  signUps: 1234,
  logins: 8910,
  sources: [
    { source: "google", medium: "cpc", campaign: "summer", count: 300 },
    { source: "email", medium: "newsletter", campaign: null, count: 150 },
  ],
  signUpMethods: [
    { name: "Email", count: 800 },
    { name: "Google", count: 434 },
  ],
  landingPages: [
    { name: "/home", count: 2000 },
    { name: "/pricing", count: 500 },
  ],
});

beforeEach(() => {
  mockState.acquisition = { data: baseData(), isLoading: false, isError: false };
  cleanup();
});

describe("AcquisitionTab", () => {
  it("renders the top-level stat cards from hook data", () => {
    renderTab();

    expect(screen.getByTestId("stat-first-opens").textContent).toBe("5,432");
    expect(screen.getByTestId("stat-sign-ups").textContent).toBe("1,234");
    expect(screen.getByTestId("stat-logins").textContent).toBe("8,910");
  });

  it("renders the traffic sources UTM table", () => {
    renderTab();

    expect(screen.getByText("Traffic sources (UTM)")).toBeTruthy();
    expect(screen.getByText("google")).toBeTruthy();
    expect(screen.getByText("cpc")).toBeTruthy();
    expect(screen.getByText("summer")).toBeTruthy();
    // second row medium is null → rendered as "-"
    expect(screen.getByText("newsletter")).toBeTruthy();
  });

  it("renders the sign-up methods and landing pages tables", () => {
    renderTab();

    expect(screen.getByText("Sign-up methods")).toBeTruthy();
    expect(screen.getByText("Email")).toBeTruthy();
    expect(screen.getByText("Landing pages")).toBeTruthy();
    expect(screen.getByText("/pricing")).toBeTruthy();
  });

  it("shows empty state when sources list is empty", () => {
    mockState.acquisition = {
      data: { ...baseData(), sources: [] },
      isLoading: false,
      isError: false,
    };
    renderTab();
    expect(screen.getByText("No tagged traffic in this period.")).toBeTruthy();
  });

  it("shows the loading skeleton while fetching", () => {
    mockState.acquisition = { data: undefined, isLoading: true, isError: false };
    const { container } = renderTab();
    expect(screen.queryByTestId("stat-first-opens")).toBeNull();
    expect(container.querySelector(".space-y-4")).toBeTruthy();
  });

  it("shows the error card when the hook errors", () => {
    mockState.acquisition = { data: undefined, isLoading: false, isError: true };
    renderTab();
    expect(
      screen.getByText("Could not load analytics data. Try again in a moment."),
    ).toBeTruthy();
  });
});
