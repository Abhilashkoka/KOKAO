import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Regression guard for the Connection Sweep card's "Last manual run" strip.
 *
 * Manual sweep triggers are audited with newValue {"started":true|false}
 * (started=false means another sweep was already in flight, so the click was
 * skipped). When two superadmins click "Run now" near-simultaneously, only
 * one run does the work — the card must show who triggered the most recent
 * manual run, when, and whether it actually started or was skipped, so
 * admins are not left guessing from a transient toast.
 */

const mockState: {
  sweepAudit: { items: unknown[]; total: number };
} = {
  sweepAudit: { items: [], total: 0 },
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
    useAdminListAuditLogs: (params: Record<string, unknown>) => {
      if (params?.action === "sweep_run") {
        return {
          data: mockState.sweepAudit,
          isLoading: false,
          isFetching: false,
        };
      }
      return {
        data: { items: [], total: 0 },
        isLoading: false,
        isFetching: false,
      };
    },
    getAdminListAuditLogsQueryKey: (params?: Record<string, unknown>) => [
      "admin-audit-logs",
      params ?? {},
    ],
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

function makeSweepRow(started: boolean, actorEmail: string | null) {
  return {
    id: 1,
    action: "sweep_run",
    actorTenantId: 7,
    actorEmail,
    targetTenantId: null,
    targetEmail: null,
    oldValue: null,
    newValue: JSON.stringify({ started }),
    createdAt: new Date("2026-07-10T09:30:00Z").toISOString(),
  };
}

describe("Connection Sweep card last manual run", () => {
  beforeEach(() => {
    mockState.sweepAudit = { items: [], total: 0 };
  });

  afterEach(() => {
    cleanup();
  });

  it("shows nothing when no manual run has been recorded", () => {
    renderPage();
    expect(
      screen.queryByTestId("section-sweep-last-manual-run"),
    ).toBeNull();
  });

  it("shows actor, time, and Started badge when the run started", () => {
    mockState.sweepAudit = {
      items: [makeSweepRow(true, "admin@example.com")],
      total: 1,
    };
    renderPage();
    const section = screen.getByTestId("section-sweep-last-manual-run");
    expect(
      within(section).getByTestId("text-sweep-manual-actor").textContent,
    ).toContain("admin@example.com");
    expect(
      within(section).getByTestId("text-sweep-manual-time").textContent,
    ).not.toContain("Invalid Date");
    expect(
      within(section).getByTestId("badge-sweep-manual-started").textContent,
    ).toContain("Started");
    expect(
      within(section).queryByTestId("badge-sweep-manual-skipped"),
    ).toBeNull();
  });

  it("shows the Skipped badge when the click found a sweep already running", () => {
    mockState.sweepAudit = {
      items: [makeSweepRow(false, "second@example.com")],
      total: 1,
    };
    renderPage();
    const section = screen.getByTestId("section-sweep-last-manual-run");
    expect(
      within(section).getByTestId("text-sweep-manual-actor").textContent,
    ).toContain("second@example.com");
    expect(
      within(section).getByTestId("badge-sweep-manual-skipped").textContent,
    ).toContain("Skipped (already running)");
    expect(
      within(section).queryByTestId("badge-sweep-manual-started"),
    ).toBeNull();
  });

  it("falls back to the actor tenant id and hides the outcome badge for unparseable rows", () => {
    mockState.sweepAudit = {
      items: [
        {
          ...makeSweepRow(true, null),
          newValue: "not-json",
        },
      ],
      total: 1,
    };
    renderPage();
    const section = screen.getByTestId("section-sweep-last-manual-run");
    expect(
      within(section).getByTestId("text-sweep-manual-actor").textContent,
    ).toContain("Tenant #7");
    expect(
      within(section).queryByTestId("badge-sweep-manual-started"),
    ).toBeNull();
    expect(
      within(section).queryByTestId("badge-sweep-manual-skipped"),
    ).toBeNull();
  });
});
