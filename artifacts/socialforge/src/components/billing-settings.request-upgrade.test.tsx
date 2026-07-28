import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * A member (non-owner) asking for an upgrade twice in a row gets a 429
 * cooldown from POST /billing/request-upgrade. The web billing card must
 * show a friendly, NON-destructive "Already requested recently" toast in
 * that case — not the scary red generic error toast. Any other failure
 * still gets the destructive fallback.
 */

const mockState = {
  toast: vi.fn(),
  requestUpgradeMutate: vi.fn(),
};

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockState.toast }),
}));

vi.mock("@/lib/features", () => ({
  useFeatureFlags: () => ({
    flags: { upgradeRequests: true, promoCodes: false },
    isLoading: false,
  }),
}));

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock, idleMutation } = await import(
    "../test/apiClientMock"
  );
  return createApiClientMock({
    useGetMe: () => ({
      data: { team: { role: "member", workspaceName: "Acme" } },
      isLoading: false,
    }),
    useListPlans: () => ({ data: [], isLoading: false }),
    useBillingGetOverview: () => ({
      data: {
        configured: true,
        plan: "free",
        subscription: null,
        credits: { captionCredits: 0, imageCredits: 0 },
        creditPacks: [],
        history: [],
      },
      isLoading: false,
    }),
    useBillingRequestUpgrade: () => ({
      ...idleMutation(),
      mutate: mockState.requestUpgradeMutate,
    }),
  });
});

import { BillingSettings } from "./billing-settings";

function renderCard() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <BillingSettings />
    </QueryClientProvider>,
  );
}

function fireRequestUpgradeError(err: unknown) {
  fireEvent.click(screen.getByRole("button", { name: /request upgrade/i }));
  expect(mockState.requestUpgradeMutate).toHaveBeenCalledTimes(1);
  const opts = mockState.requestUpgradeMutate.mock.calls[0][1] as {
    onError: (e: unknown) => void;
  };
  opts.onError(err);
}

describe("BillingSettings member request-upgrade error toasts", () => {
  beforeEach(() => {
    mockState.toast = vi.fn();
    mockState.requestUpgradeMutate = vi.fn();
  });

  afterEach(() => cleanup());

  it("shows the friendly non-destructive 'Already requested recently' toast on 429", () => {
    renderCard();
    fireRequestUpgradeError({
      status: 429,
      data: { error: "You already asked for an upgrade in the last day." },
    });

    expect(mockState.toast).toHaveBeenCalledTimes(1);
    const call = mockState.toast.mock.calls[0][0] as {
      title: string;
      description: string;
      variant?: string;
    };
    expect(call.title).toBe("Already requested recently");
    // Server-provided cooldown copy is surfaced via apiErrorMessage.
    expect(call.description).toBe(
      "You already asked for an upgrade in the last day.",
    );
    // Crucially NOT the destructive (red) variant.
    expect(call.variant).toBe(undefined);
  });

  it("falls back to the friendly cooldown copy when the 429 has no body message", () => {
    renderCard();
    fireRequestUpgradeError({ status: 429 });

    const call = mockState.toast.mock.calls[0][0] as {
      title: string;
      description: string;
      variant?: string;
    };
    expect(call.title).toBe("Already requested recently");
    expect(call.description).toBe(
      "You already asked for an upgrade recently. Give the owner a little time to respond.",
    );
    expect(call.variant).toBe(undefined);
  });

  it("shows the destructive generic error toast for non-429 failures", () => {
    renderCard();
    fireRequestUpgradeError({
      status: 500,
      data: { error: "Something broke server-side." },
    });

    const call = mockState.toast.mock.calls[0][0] as {
      title: string;
      description: string;
      variant?: string;
    };
    expect(call.title).toBe("Could not send the request");
    expect(call.description).toBe("Something broke server-side.");
    expect(call.variant).toBe("destructive");
  });

  it("shows the destructive fallback copy for errors with no status at all", () => {
    renderCard();
    fireRequestUpgradeError(new Error("network down"));

    const call = mockState.toast.mock.calls[0][0] as {
      title: string;
      description: string;
      variant?: string;
    };
    expect(call.title).toBe("Could not send the request");
    expect(call.description).toBe("Please try again in a moment.");
    expect(call.variant).toBe("destructive");
  });
});
