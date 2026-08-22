/**
 * TransferSection — verifies that export, dismiss, and snooze each call
 * refetchDrift() so the header drift indicators in PromptKitTab disappear
 * immediately without a page reload.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  PromptKitDriftStatus,
  PromptKitImportResult,
} from "@workspace/api-client-react";

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
// Mutable state (names must start with `mock` for vitest hoisting).
// ---------------------------------------------------------------------------

const mockState: {
  drift: PromptKitDriftStatus | undefined;
  exportResult: Record<string, unknown>;
  refetch: ReturnType<typeof vi.fn>;
  dismissMutate: ReturnType<typeof vi.fn>;
  importMutate: ReturnType<typeof vi.fn>;
} = {
  drift: undefined,
  exportResult: { cases: [] },
  refetch: vi.fn(),
  dismissMutate: vi.fn(),
  importMutate: vi.fn(),
};

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../../../test/apiClientMock");
  return createApiClientMock({
    useGetPromptKitDrift: () => ({
      data: mockState.drift,
      refetch: mockState.refetch,
      isLoading: false,
    }),
    getGetPromptKitDriftQueryKey: () => ["getPromptKitDrift"],
    exportPromptKit: vi.fn(async () => mockState.exportResult),
    useDismissPromptKitDrift: () => ({
      mutate: mockState.dismissMutate,
      isPending: false,
    }),
    useImportPromptKit: () => ({
      mutate: mockState.importMutate,
      isPending: false,
    }),
  });
});

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

import { TransferSection } from "./transfer-section";

function driftStatus(
  overrides: Partial<PromptKitDriftStatus> = {},
): PromptKitDriftStatus {
  return {
    hasDrift: true,
    neverExported: false,
    isSnoozed: false,
    dismissedAt: null,
    lastExportedAt: "2026-08-01T10:00:00Z",
    lastExportedBy: null,
    snoozedUntil: null,
    driftItems: [
      {
        templateId: 1,
        caseSlug: "caption",
        caseName: "Caption",
        templateTitle: "Default caption",
        reason: "promoted",
        currentVersionNo: 3,
        lastExportedVersionNo: 2,
      },
    ],
    ...overrides,
  };
}

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    queryClient: qc,
    ...render(
      <QueryClientProvider client={qc}>
        <TransferSection />
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  cleanup();
  mockState.drift = undefined;
  mockState.exportResult = { cases: [{ id: "c1" }, { id: "c2" }] };
  mockState.refetch = vi.fn();
  mockState.dismissMutate = vi.fn();
  mockState.importMutate = vi.fn();
});

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("TransferSection: export triggers drift refetch", () => {
  it("calls refetchDrift after a successful export", async () => {
    mockState.drift = undefined;
    renderSection();

    await userEvent.setup().click(screen.getByTestId("button-export-prompt-kit"));

    await waitFor(() => {
      expect(mockState.refetch).toHaveBeenCalledTimes(1);
    });
  });

  it("shows the drift banner when drift data is present and active", () => {
    mockState.drift = driftStatus();
    renderSection();

    expect(screen.getByTestId("prompt-kit-drift-banner")).toBeTruthy();
  });

  it("hides the drift banner when there is no drift", () => {
    mockState.drift = {
      hasDrift: false,
      neverExported: false,
      isSnoozed: false,
      dismissedAt: null,
      lastExportedAt: new Date().toISOString(),
      lastExportedBy: null,
      snoozedUntil: null,
      driftItems: [],
    };
    renderSection();

    expect(screen.queryByTestId("prompt-kit-drift-banner")).toBeNull();
  });

  it("hides the drift banner when neverExported is true", () => {
    mockState.drift = driftStatus({ neverExported: true });
    renderSection();

    expect(screen.queryByTestId("prompt-kit-drift-banner")).toBeNull();
  });

  it("hides the drift banner when drift is snoozed", () => {
    mockState.drift = driftStatus({ isSnoozed: true });
    renderSection();

    expect(screen.queryByTestId("prompt-kit-drift-banner")).toBeNull();
  });

  it("hides the drift banner when drift is dismissed", () => {
    mockState.drift = driftStatus({ dismissedAt: "2026-08-17T00:00:00Z" });
    renderSection();

    expect(screen.queryByTestId("prompt-kit-drift-banner")).toBeNull();
  });
});

describe("TransferSection: dismiss triggers drift refetch", () => {
  it("calls refetchDrift after the dismiss X button succeeds", async () => {
    mockState.drift = driftStatus();
    // Make mutate invoke onSuccess immediately.
    mockState.dismissMutate = vi.fn(
      (_vars: unknown, opts: { onSuccess?: () => void } = {}) => {
        opts.onSuccess?.();
      },
    );
    renderSection();

    await userEvent.setup().click(screen.getByTestId("button-dismiss-drift-x"));

    await waitFor(() => {
      expect(mockState.refetch).toHaveBeenCalled();
    });
  });

  it("calls refetchDrift after the text Dismiss button succeeds", async () => {
    mockState.drift = driftStatus();
    mockState.dismissMutate = vi.fn(
      (_vars: unknown, opts: { onSuccess?: () => void } = {}) => {
        opts.onSuccess?.();
      },
    );
    renderSection();

    await userEvent.setup().click(screen.getByTestId("button-dismiss-drift"));

    await waitFor(() => {
      expect(mockState.refetch).toHaveBeenCalled();
    });
  });
});

describe("TransferSection: snooze triggers drift refetch", () => {
  it("calls refetchDrift after a snooze option is chosen", async () => {
    mockState.drift = driftStatus();
    mockState.dismissMutate = vi.fn(
      (_vars: unknown, opts: { onSuccess?: () => void } = {}) => {
        opts.onSuccess?.();
      },
    );
    renderSection();

    const user = userEvent.setup();

    // Open the snooze dialog.
    await user.click(screen.getByTestId("button-snooze-drift"));
    // Pick the 1-day option.
    await user.click(screen.getByTestId("button-snooze-drift-1d"));

    await waitFor(() => {
      expect(mockState.refetch).toHaveBeenCalled();
    });
  });
});

describe("TransferSection: import clears drift cache", () => {
  it("invalidates the drift query after a successful bundle import", async () => {
    mockState.drift = driftStatus();
    const importResult: PromptKitImportResult = {
      casesCreated: 0,
      casesUpdated: 1,
      templatesCreated: 0,
      templatesUpdated: 1,
      versionsCreated: 0,
      versionsUpdated: 1,
      promotionsApplied: 1,
      warnings: [],
    };
    mockState.importMutate = vi.fn(
      (
        _vars: unknown,
        opts: { onSuccess?: (result: PromptKitImportResult) => void } = {},
      ) => {
        opts.onSuccess?.(importResult);
      },
    );
    const { queryClient } = renderSection();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const user = userEvent.setup();
    const bundle = new File(
      [
        JSON.stringify({
          format: "kokao-prompt-kit",
          cases: [],
          exportedAt: "2026-08-22T10:00:00Z",
        }),
      ],
      "prompt-kit.json",
      { type: "application/json" },
    );

    await user.upload(
      screen.getByTestId("input-import-prompt-kit-file"),
      bundle,
    );
    await user.click(screen.getByTestId("button-confirm-import-prompt-kit"));

    await waitFor(() => {
      expect(mockState.importMutate).toHaveBeenCalledWith(
        { data: expect.objectContaining({ format: "kokao-prompt-kit" }) },
        expect.any(Object),
      );
      expect(invalidateQueries).toHaveBeenCalledTimes(1);
    });
  });
});

describe("TransferSection: drift banner lists changed templates", () => {
  it("lists drift items up to the first 5", () => {
    mockState.drift = driftStatus({
      driftItems: Array.from({ length: 3 }, (_, i) => ({
        templateId: i,
        caseSlug: `case-${i}`,
        caseName: `Case ${i}`,
        templateTitle: `Template ${i}`,
        reason: "promoted" as const,
        currentVersionNo: i + 2,
        lastExportedVersionNo: i + 1,
      })),
    });
    renderSection();

    const items = screen.getAllByTestId("drift-item");
    expect(items).toHaveLength(3);
  });

  it("shows the overflow count when more than 5 items exist", () => {
    mockState.drift = driftStatus({
      driftItems: Array.from({ length: 7 }, (_, i) => ({
        templateId: i,
        caseSlug: `case-${i}`,
        caseName: `Case ${i}`,
        templateTitle: `Template ${i}`,
        reason: "promoted" as const,
        currentVersionNo: i + 2,
        lastExportedVersionNo: i + 1,
      })),
    });
    renderSection();

    // Only the first 5 are rendered as list items.
    const items = screen.getAllByTestId("drift-item");
    expect(items).toHaveLength(5);
    // The banner body must also mention the remaining 2.
    const banner = screen.getByTestId("prompt-kit-drift-banner");
    expect(banner.textContent).toContain("2 more");
  });
});
