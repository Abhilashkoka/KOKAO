import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * The Connection Sweep card must visually distinguish a check that has
 * failed sweep after sweep (chronic breakage) from a one-off blip: any
 * recent failure with consecutiveFailures > 1 gets a destructive
 * "Failed N sweeps in a row" badge, while a streak of 1 shows no badge.
 */

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
        tenantsByPlan: { free: 1 },
        totalContent: 0,
        totalScheduledPosts: 0,
        totalConnectedAccounts: 2,
        sweepRunning: false,
        connectionSweep: {
          lastRunAt: new Date().toISOString(),
          durationMs: 1200,
          accountsChecked: 2,
          errorCount: 2,
          lastError: "provider timeout",
          recentFailures: [
            {
              tenantId: 7,
              tenantName: "Chronic Co",
              platform: "facebook",
              error: "provider timeout",
              at: "2026-07-17T10:00:00.000Z",
              consecutiveFailures: 6,
              firstFailedAt: new Date(
                Date.now() - 2 * 60 * 60 * 1000,
              ).toISOString(),
            },
            {
              tenantId: 8,
              tenantName: "Blip Inc",
              platform: "linkedin",
              error: "boom",
              at: "2026-07-17T10:00:01.000Z",
              consecutiveFailures: 1,
            },
          ],
        },
      },
      isLoading: false,
      isFetching: false,
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

describe("Connection Sweep card repeat-offender streaks", () => {
  afterEach(() => {
    cleanup();
  });

  it("badges a multi-sweep streak and leaves a one-off failure unbadged", () => {
    renderPage();
    const section = screen.getByTestId("section-sweep-failures");

    const chronic = within(section).getByTestId("row-sweep-failure-0");
    expect(chronic.textContent).toContain("Chronic Co");
    expect(
      within(chronic).getByTestId("badge-sweep-streak-0").textContent,
    ).toBe("Failed 6 sweeps in a row — failing for 2 hours");

    const blip = within(section).getByTestId("row-sweep-failure-1");
    expect(blip.textContent).toContain("Blip Inc");
    expect(within(blip).queryByTestId("badge-sweep-streak-1")).toBeNull();
  });
});
