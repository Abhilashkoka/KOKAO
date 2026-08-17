import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockState: {
  dataConsumption: { data: any; isLoading: boolean; isError: boolean };
} = {
  dataConsumption: { data: undefined, isLoading: false, isError: false },
};

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../../test/apiClientMock");
  return createApiClientMock({
    useGetDataConsumptionAnalytics: () => mockState.dataConsumption,
  });
});

import { DataConsumptionTab } from "./data-consumption-tab";
import { ScopeProvider } from "./shared";

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ScopeProvider value={{}}>
        <DataConsumptionTab />
      </ScopeProvider>
    </QueryClientProvider>,
  );
}

const baseData = () => ({
  totals: [
    { kind: "caption", count: 450, requestBytes: 204800, responseBytes: 102400, totalBytes: 307200 },
    { kind: "image", count: 120, requestBytes: 1048576, responseBytes: 2097152, totalBytes: 3145728 },
  ],
  monthly: [
    { month: "2026-08", kind: "transcription", count: 200, totalBytes: 153600 },
  ],
  byTenant: [
    { tenantId: 1, tenantName: "Acme Corp", count: 300, totalBytes: 204800 },
  ],
  recentCampaigns: [
    {
      campaignId: 99,
      createdAt: "2026-08-10T10:00:00Z",
      platforms: [{ platform: "facebook" }, { platform: "instagram" }],
      totalBytes: 1572864,
    },
  ],
});

beforeEach(() => {
  mockState.dataConsumption = { data: baseData(), isLoading: false, isError: false };
  cleanup();
});

describe("DataConsumptionTab", () => {
  it("renders the AI data usage by type table with kind labels", () => {
    renderTab();

    expect(screen.getByText("AI data usage by type")).toBeTruthy();
    // KIND_LABELS: caption → "Captions", image → "Images"
    expect(screen.getByText("Captions")).toBeTruthy();
    expect(screen.getByText("Images")).toBeTruthy();
    // Request counts formatted
    expect(screen.getByText("450")).toBeTruthy();
    expect(screen.getByText("120")).toBeTruthy();
    // Bytes: 307200 → 300.0 KB; 3145728 → 3.0 MB
    expect(screen.getByText("300.0 KB")).toBeTruthy();
    expect(screen.getByText("3.0 MB")).toBeTruthy();
  });

  it("renders the monthly usage table", () => {
    renderTab();

    expect(screen.getByText("Monthly usage")).toBeTruthy();
    expect(screen.getByText("2026-08")).toBeTruthy();
  });

  it("renders the usage by workspace table when byTenant is non-empty", () => {
    renderTab();

    expect(screen.getByText("Usage by workspace")).toBeTruthy();
    expect(screen.getByText("Acme Corp")).toBeTruthy();
  });

  it("renders the recent campaigns table", () => {
    renderTab();

    expect(screen.getByText("Recent campaigns")).toBeTruthy();
    expect(screen.getByText("facebook, instagram")).toBeTruthy();
    // 1572864 bytes = 1.5 MB
    expect(screen.getByText("1.5 MB")).toBeTruthy();
  });

  it("shows empty state when totals list is empty", () => {
    mockState.dataConsumption = {
      data: { ...baseData(), totals: [] },
      isLoading: false,
      isError: false,
    };
    renderTab();
    expect(screen.getByText("No AI usage in this period.")).toBeTruthy();
  });

  it("shows empty state when monthly list is empty", () => {
    mockState.dataConsumption = {
      data: { ...baseData(), monthly: [] },
      isLoading: false,
      isError: false,
    };
    renderTab();
    expect(screen.getByText("No monthly data yet.")).toBeTruthy();
  });

  it("hides the workspace table when byTenant is empty", () => {
    mockState.dataConsumption = {
      data: { ...baseData(), byTenant: [] },
      isLoading: false,
      isError: false,
    };
    renderTab();
    expect(screen.queryByText("Usage by workspace")).toBeNull();
  });

  it("shows the loading skeleton while fetching", () => {
    mockState.dataConsumption = { data: undefined, isLoading: true, isError: false };
    const { container } = renderTab();
    expect(screen.queryByText("AI data usage by type")).toBeNull();
    expect(container.querySelector(".space-y-4")).toBeTruthy();
  });

  it("shows the error card when the hook errors", () => {
    mockState.dataConsumption = { data: undefined, isLoading: false, isError: true };
    renderTab();
    expect(
      screen.getByText("Could not load analytics data. Try again in a moment."),
    ).toBeTruthy();
  });
});
