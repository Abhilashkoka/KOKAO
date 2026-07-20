import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Regression guard for the Connection Sweep card's failure-ratio line.
 *
 * The sweep alerts superadmins when a run's failure ratio crosses
 * SWEEP_FAIL_RATIO_ALERT_THRESHOLD. The dashboard must show
 * "X of Y checks failed (Z%)" for the last run and flag the figure when it
 * is at or above the server-provided threshold, so an admin can gauge
 * outage severity at a glance.
 */

const mockState: {
  connectionSweep: Record<string, unknown> | null;
} = {
  connectionSweep: null,
};

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useGetMe: () => ({
      data: { isSuperadmin: true, isOwner: true },
      isLoading: false,
    }),
    useAdminGetStats: () => ({
      data: {
        totalTenants: 1,
        tenantsByPlan: {},
        totalContent: 0,
        totalScheduledPosts: 0,
        totalConnectedAccounts: 0,
        sweepRunning: false,
        connectionSweep: mockState.connectionSweep,
      },
      isLoading: false,
    }),
  });
});

// Imported after the mock so the mocked module is picked up.
import { AdminPage } from "./admin";

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AdminPage />
    </QueryClientProvider>,
  );
}

function makeSweep(overrides: Record<string, unknown> = {}) {
  return {
    lastRunAt: new Date("2026-07-19T09:00:00Z").toISOString(),
    durationMs: 1200,
    accountsChecked: 20,
    errorCount: 0,
    failRatioAlertThreshold: 0.5,
    lastError: null,
    droppedStreaks: 0,
    recentFailures: [],
    ...overrides,
  };
}

describe("Connection Sweep card failure ratio", () => {
  beforeEach(() => {
    mockState.connectionSweep = null;
  });

  afterEach(() => {
    cleanup();
  });

  it("shows nothing when the sweep never ran", () => {
    renderPage();
    expect(screen.queryByTestId("text-sweep-fail-ratio")).toBeNull();
  });

  it("shows nothing when zero accounts were checked (avoids divide-by-zero)", () => {
    mockState.connectionSweep = makeSweep({
      accountsChecked: 0,
      errorCount: 0,
    });
    renderPage();
    expect(screen.queryByTestId("text-sweep-fail-ratio")).toBeNull();
  });

  it("shows the ratio without a flag when below the threshold", () => {
    mockState.connectionSweep = makeSweep({
      accountsChecked: 20,
      errorCount: 3,
      failRatioAlertThreshold: 0.5,
    });
    renderPage();
    const section = screen.getByTestId("text-sweep-fail-ratio");
    expect(section.textContent).toContain("3 of 20 checks failed (15%)");
    expect(
      within(section).queryByTestId("badge-sweep-fail-ratio-alert"),
    ).toBeNull();
  });

  it("flags the ratio when at or above the alert threshold", () => {
    mockState.connectionSweep = makeSweep({
      accountsChecked: 20,
      errorCount: 10,
      failRatioAlertThreshold: 0.5,
    });
    renderPage();
    const section = screen.getByTestId("text-sweep-fail-ratio");
    expect(section.textContent).toContain("10 of 20 checks failed (50%)");
    expect(
      within(section).getByTestId("badge-sweep-fail-ratio-alert").textContent,
    ).toContain("Above alert threshold");
  });

  it("does not flag a clean run even when rows lack the threshold field", () => {
    mockState.connectionSweep = makeSweep({
      accountsChecked: 20,
      errorCount: 0,
      failRatioAlertThreshold: undefined,
    });
    renderPage();
    const section = screen.getByTestId("text-sweep-fail-ratio");
    expect(section.textContent).toContain("0 of 20 checks failed (0%)");
    expect(
      within(section).queryByTestId("badge-sweep-fail-ratio-alert"),
    ).toBeNull();
  });
});
