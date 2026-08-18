/**
 * PromptKitTab drift indicators — badge on "Export / import" tab and the
 * inline header alert — must appear when drift exists and disappear
 * immediately when the query returns resolved data (simulating a post-export
 * refetch), without requiring a page reload.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PromptKitDriftStatus } from "@workspace/api-client-react";

// Radix needs a few APIs jsdom doesn't ship with.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// ---------------------------------------------------------------------------
// Shared mutable state (name must start with `mock` for vitest hoisting).
// ---------------------------------------------------------------------------

const mockState: { drift: PromptKitDriftStatus | undefined } = {
  drift: undefined,
};

// ---------------------------------------------------------------------------
// Mock child sections so we only test PromptKitTab's own logic.
// ---------------------------------------------------------------------------

vi.mock("@/pages/admin/prompt-kit/cases-section", () => ({
  CasesSection: () => <div data-testid="cases-section-mock" />,
}));
vi.mock("@/pages/admin/prompt-kit/templates-section", () => ({
  TemplatesSection: () => <div data-testid="templates-section-mock" />,
}));
vi.mock("@/pages/admin/prompt-kit/playground-section", () => ({
  PlaygroundSection: () => <div data-testid="playground-section-mock" />,
}));
vi.mock("@/pages/admin/prompt-kit/test-cases-section", () => ({
  TestCasesSection: () => <div data-testid="test-cases-section-mock" />,
}));
vi.mock("@/pages/admin/prompt-kit/metrics-section", () => ({
  MetricsSection: () => <div data-testid="metrics-section-mock" />,
}));
vi.mock("@/pages/admin/prompt-kit/transfer-section", () => ({
  TransferSection: () => <div data-testid="transfer-section-mock" />,
}));

// ---------------------------------------------------------------------------
// API client mock.
// ---------------------------------------------------------------------------

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../../test/apiClientMock");
  return createApiClientMock({
    useGetPromptKitDrift: () => ({
      data: mockState.drift,
      refetch: vi.fn(),
      isLoading: false,
    }),
    getGetPromptKitDriftQueryKey: () => ["getPromptKitDrift"],
  });
});

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

import { PromptKitTab } from "./prompt-kit-tab";

function driftStatus(
  overrides: Partial<PromptKitDriftStatus> = {},
): PromptKitDriftStatus {
  return {
    hasDrift: true,
    neverExported: false,
    isSnoozed: false,
    dismissedAt: null,
    lastExportedAt: "2026-08-01T10:00:00Z",
    driftItems: [
      {
        templateId: "tpl-1",
        caseName: "Caption",
        templateTitle: "Default caption",
        reason: "version_bump",
        currentVersionNo: 3,
        lastExportedVersionNo: 2,
      },
    ],
    ...overrides,
  };
}

function resolvedDrift(): PromptKitDriftStatus {
  return {
    hasDrift: false,
    neverExported: false,
    isSnoozed: false,
    dismissedAt: null,
    lastExportedAt: new Date().toISOString(),
    driftItems: [],
  };
}

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PromptKitTab />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  mockState.drift = undefined;
});

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("PromptKitTab drift indicators", () => {
  it("shows no drift alert or badge when drift data is absent", () => {
    mockState.drift = undefined;
    renderTab();

    expect(screen.queryByTestId("prompt-kit-drift-header-alert")).toBeNull();
    expect(screen.queryByTestId("drift-tab-badge")).toBeNull();
  });

  it("shows no drift alert or badge when neverExported is true", () => {
    mockState.drift = driftStatus({ neverExported: true });
    renderTab();

    expect(screen.queryByTestId("prompt-kit-drift-header-alert")).toBeNull();
    expect(screen.queryByTestId("drift-tab-badge")).toBeNull();
  });

  it("shows no drift alert or badge when hasDrift is false", () => {
    mockState.drift = resolvedDrift();
    renderTab();

    expect(screen.queryByTestId("prompt-kit-drift-header-alert")).toBeNull();
    expect(screen.queryByTestId("drift-tab-badge")).toBeNull();
  });

  it("shows no drift alert or badge when drift is snoozed", () => {
    mockState.drift = driftStatus({ isSnoozed: true });
    renderTab();

    expect(screen.queryByTestId("prompt-kit-drift-header-alert")).toBeNull();
    expect(screen.queryByTestId("drift-tab-badge")).toBeNull();
  });

  it("shows no drift alert or badge when drift is dismissed", () => {
    mockState.drift = driftStatus({ dismissedAt: "2026-08-17T09:00:00Z" });
    renderTab();

    expect(screen.queryByTestId("prompt-kit-drift-header-alert")).toBeNull();
    expect(screen.queryByTestId("drift-tab-badge")).toBeNull();
  });

  it("shows the header alert and tab badge when real drift exists", () => {
    mockState.drift = driftStatus();
    renderTab();

    expect(screen.getByTestId("prompt-kit-drift-header-alert")).toBeTruthy();
    expect(screen.getByTestId("drift-tab-badge")).toBeTruthy();
  });

  it("alert mentions the number of drifted templates (singular)", () => {
    mockState.drift = driftStatus();
    renderTab();

    const alert = screen.getByTestId("prompt-kit-drift-header-alert");
    expect(alert.textContent).toContain("1 template");
    // Must NOT say "1 templates"
    expect(alert.textContent).not.toContain("1 templates");
  });

  it("alert mentions plural templates when there are multiple", () => {
    mockState.drift = driftStatus({
      driftItems: [
        {
          templateId: "tpl-1",
          caseName: "Caption",
          templateTitle: "Default caption",
          reason: "version_bump",
          currentVersionNo: 3,
          lastExportedVersionNo: 2,
        },
        {
          templateId: "tpl-2",
          caseName: "Hashtag",
          templateTitle: "Default hashtag",
          reason: "new_template",
          currentVersionNo: null,
          lastExportedVersionNo: null,
        },
      ],
    });
    renderTab();

    const alert = screen.getByTestId("prompt-kit-drift-header-alert");
    expect(alert.textContent).toContain("2 templates");
  });

  it("clicking 'Go to Export / import' switches the active tab to transfer", async () => {
    mockState.drift = driftStatus();
    renderTab();

    // Initially on the cases tab.
    expect(
      screen.getByTestId("tab-prompt-kit-cases").getAttribute("data-state"),
    ).toBe("active");

    await userEvent.setup().click(screen.getByTestId("button-drift-go-to-transfer"));

    // Transfer tab becomes active.
    await waitFor(() => {
      expect(
        screen.getByTestId("tab-prompt-kit-transfer").getAttribute("data-state"),
      ).toBe("active");
    });
    expect(
      screen.getByTestId("tab-prompt-kit-cases").getAttribute("data-state"),
    ).not.toBe("active");
  });

  it("header alert and badge disappear instantly when drift resolves (simulating post-export refetch)", () => {
    mockState.drift = driftStatus();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <PromptKitTab />
      </QueryClientProvider>,
    );

    // Drift indicators present initially.
    expect(screen.getByTestId("prompt-kit-drift-header-alert")).toBeTruthy();
    expect(screen.getByTestId("drift-tab-badge")).toBeTruthy();

    // Simulate refetchDrift() completing and returning resolved data — this is
    // what happens after export/dismiss in the real app without a page reload.
    mockState.drift = resolvedDrift();
    rerender(
      <QueryClientProvider client={qc}>
        <PromptKitTab />
      </QueryClientProvider>,
    );

    // Both indicators must be gone in the same render cycle.
    expect(screen.queryByTestId("prompt-kit-drift-header-alert")).toBeNull();
    expect(screen.queryByTestId("drift-tab-badge")).toBeNull();
  });

  it("header alert and badge disappear when drift is snoozed (simulating post-snooze refetch)", () => {
    mockState.drift = driftStatus();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <PromptKitTab />
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("prompt-kit-drift-header-alert")).toBeTruthy();

    mockState.drift = driftStatus({ isSnoozed: true });
    rerender(
      <QueryClientProvider client={qc}>
        <PromptKitTab />
      </QueryClientProvider>,
    );

    expect(screen.queryByTestId("prompt-kit-drift-header-alert")).toBeNull();
    expect(screen.queryByTestId("drift-tab-badge")).toBeNull();
  });

  it("header alert and badge disappear when drift is dismissed (simulating post-dismiss refetch)", () => {
    mockState.drift = driftStatus();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <PromptKitTab />
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("prompt-kit-drift-header-alert")).toBeTruthy();

    mockState.drift = driftStatus({ dismissedAt: new Date().toISOString() });
    rerender(
      <QueryClientProvider client={qc}>
        <PromptKitTab />
      </QueryClientProvider>,
    );

    expect(screen.queryByTestId("prompt-kit-drift-header-alert")).toBeNull();
    expect(screen.queryByTestId("drift-tab-badge")).toBeNull();
  });
});
