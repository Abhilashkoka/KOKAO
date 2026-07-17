import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Regression guard for the Audit trail "Download CSV" browser flow.
 *
 * The export is a browser-native download: clicking the button builds an
 * anchor pointing at /api/admin/audit-logs/export with the CURRENTLY APPLIED
 * filters as query params (cookie auth rides along automatically because it
 * is a same-origin navigation) and clicks it. A refactor could silently drop
 * filter propagation (exporting everything) or the disabled state when no
 * records match. These tests mock the list hook and assert:
 *  - the export anchor href carries the applied filters,
 *  - unapplied (typed but not submitted) filter input is NOT sent,
 *  - the button is disabled when total === 0 and enabled otherwise.
 *
 * The download is preceded by a HEAD preflight fetch that validates auth and
 * filters; a rejected preflight (401/403/400) or network failure must show an
 * "Export failed" toast and NOT trigger the anchor download.
 */

const mockState: {
  auditLogs: { items: unknown[]; total: number };
  lastParams: Record<string, unknown> | null;
} = {
  auditLogs: { items: [], total: 0 },
  lastParams: null,
};

const toastSpy = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

// Resilient mock: unknown hooks fall back to an idle stub, so adding a new
// hook to admin.tsx does not break these tests.
vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useAdminListAuditLogs: (params: Record<string, unknown>) => {
      mockState.lastParams = params;
      return {
        data: mockState.auditLogs,
        isLoading: false,
        isFetching: false,
      };
    },
    getAdminListAuditLogsQueryKey: (params: Record<string, unknown>) => [
      "admin-audit-logs",
      params,
    ],
  });
});

// Imported after the mock so the mocked module is picked up.
import { AuditLogCard } from "./admin";

function renderCard() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AuditLogCard />
    </QueryClientProvider>,
  );
}

function makeRow(id: number, actorEmail: string) {
  return {
    id,
    action: "plan_change",
    actorTenantId: 1,
    actorEmail,
    targetTenantId: 2,
    targetEmail: "target@example.com",
    oldValue: "free",
    newValue: "pro",
    createdAt: new Date("2026-07-01T12:00:00Z").toISOString(),
  };
}

describe("AuditLogCard CSV export", () => {
  let clickedAnchors: HTMLAnchorElement[];
  let clickSpy: ReturnType<typeof vi.spyOn>;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockState.auditLogs = { items: [], total: 0 };
    mockState.lastParams = null;
    clickedAnchors = [];
    toastSpy.mockClear();
    // jsdom would attempt (and fail) real navigation on anchor click;
    // capture the anchor instead so we can assert on href/download.
    clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        clickedAnchors.push(this);
      });
    // Default: the HEAD preflight succeeds.
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    clickSpy.mockRestore();
    vi.unstubAllGlobals();
    cleanup();
  });

  it("downloads the unfiltered export when no filters are applied", async () => {
    mockState.auditLogs = { items: [makeRow(1, "a@example.com")], total: 1 };
    renderCard();

    const button = screen.getByTestId("button-audit-export");
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);

    await waitFor(() => expect(clickedAnchors).toHaveLength(1));
    const anchor = clickedAnchors[0];
    expect(anchor.getAttribute("href")).toBe("/api/admin/audit-logs/export");
    expect(anchor.getAttribute("download")).toMatch(
      /^audit-log-\d{4}-\d{2}-\d{2}\.csv$/,
    );
    // The preflight hit the same URL with HEAD before downloading.
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/admin/audit-logs/export",
      expect.objectContaining({ method: "HEAD" }),
    );
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it("propagates the APPLIED filters into the export URL", async () => {
    mockState.auditLogs = {
      items: [makeRow(1, "match@example.com"), makeRow(2, "match@example.com")],
      total: 2,
    };
    renderCard();

    fireEvent.change(screen.getByTestId("input-audit-actor"), {
      target: { value: "match@example.com" },
    });
    fireEvent.change(screen.getByTestId("input-audit-target"), {
      target: { value: "target@example.com" },
    });
    fireEvent.click(screen.getByTestId("button-audit-apply"));

    // The list query and the export must see the same filters.
    expect(mockState.lastParams).toMatchObject({
      actor: "match@example.com",
      target: "target@example.com",
    });

    fireEvent.click(screen.getByTestId("button-audit-export"));
    await waitFor(() => expect(clickedAnchors).toHaveLength(1));
    const href = clickedAnchors[0].getAttribute("href")!;
    const url = new URL(href, "http://localhost");
    expect(url.pathname).toBe("/api/admin/audit-logs/export");
    expect(url.searchParams.get("actor")).toBe("match@example.com");
    expect(url.searchParams.get("target")).toBe("target@example.com");
    expect(url.searchParams.get("action")).toBeNull();
    // The preflight validated the SAME filtered URL.
    expect(fetchSpy).toHaveBeenCalledWith(
      href,
      expect.objectContaining({ method: "HEAD" }),
    );
  });

  it("does NOT send filter text that was typed but not applied", async () => {
    mockState.auditLogs = { items: [makeRow(1, "a@example.com")], total: 1 };
    renderCard();

    fireEvent.change(screen.getByTestId("input-audit-actor"), {
      target: { value: "typed-but-not-applied" },
    });
    fireEvent.click(screen.getByTestId("button-audit-export"));

    await waitFor(() => expect(clickedAnchors).toHaveLength(1));
    expect(clickedAnchors[0].getAttribute("href")).toBe(
      "/api/admin/audit-logs/export",
    );
  });

  it("disables the export button when no records match the filters", () => {
    mockState.auditLogs = { items: [], total: 0 };
    renderCard();

    const button = screen.getByTestId("button-audit-export");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(clickedAnchors).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    [401, "You no longer have access"],
    [403, "You no longer have access"],
    [400, "filters are invalid"],
    [500, "error 500"],
  ])(
    "shows an error toast and skips the download when the preflight returns %i",
    async (status, messagePart) => {
      mockState.auditLogs = { items: [makeRow(1, "a@example.com")], total: 1 };
      fetchSpy.mockResolvedValue({ ok: false, status });
      renderCard();

      fireEvent.click(screen.getByTestId("button-audit-export"));

      await waitFor(() =>
        expect(toastSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            title: "Export failed",
            variant: "destructive",
            description: expect.stringContaining(messagePart),
          }),
        ),
      );
      expect(clickedAnchors).toHaveLength(0);
    },
  );

  it("disables the export button while the preflight is in flight", async () => {
    mockState.auditLogs = { items: [makeRow(1, "a@example.com")], total: 1 };
    let resolvePreflight!: (value: { ok: boolean; status: number }) => void;
    fetchSpy.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePreflight = resolve;
        }),
    );
    renderCard();

    const button = screen.getByTestId("button-audit-export") as HTMLButtonElement;
    fireEvent.click(button);

    await waitFor(() => expect(button.disabled).toBe(true));
    expect(clickedAnchors).toHaveLength(0);

    resolvePreflight({ ok: true, status: 204 });
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(clickedAnchors).toHaveLength(1);
  });

  it("shows an error toast and skips the download when the preflight fetch throws", async () => {
    mockState.auditLogs = { items: [makeRow(1, "a@example.com")], total: 1 };
    fetchSpy.mockRejectedValue(new TypeError("Failed to fetch"));
    renderCard();

    fireEvent.click(screen.getByTestId("button-audit-export"));

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Export failed",
          variant: "destructive",
          description: expect.stringContaining("Could not reach the server"),
        }),
      ),
    );
    expect(clickedAnchors).toHaveLength(0);
  });
});
