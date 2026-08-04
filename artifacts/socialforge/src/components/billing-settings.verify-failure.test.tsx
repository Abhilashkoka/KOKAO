import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * When a purchase/subscription verify call fails:
 * - 409 (gateway hasn't confirmed yet) keeps the reassuring "still processing" toast.
 * - Terminal 4xx (e.g. the lost-order 400 "Razorpay no longer recognizes this
 *   order…") must show a destructive "Payment failed" toast with the exact
 *   server reason — NOT "Verification pending", which implies credits will
 *   appear later.
 * - Unknown/5xx failures keep the pending wording (outcome indeterminate).
 */

const mockState = {
  toast: vi.fn(),
  purchaseCreditsMutateAsync: vi.fn(),
  verifyPurchaseMutate: vi.fn(),
};

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockState.toast }),
}));

vi.mock("@/lib/features", () => ({
  useFeatureFlags: () => ({
    flags: { upgradeRequests: false, promoCodes: false },
    isLoading: false,
  }),
}));

vi.mock("@/lib/cashfree-checkout", () => ({
  openCashfreeCheckout: vi.fn().mockResolvedValue(undefined),
  openCashfreeSubscriptionCheckout: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/razorpay-checkout", () => ({
  openCheckout: vi.fn().mockResolvedValue(undefined),
  formatInr: (n: number) => `₹${n}`,
}));

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock, idleMutation } = await import(
    "../test/apiClientMock"
  );
  return createApiClientMock({
    useGetMe: () => ({ data: { team: null }, isLoading: false }),
    useListPlans: () => ({ data: [], isLoading: false }),
    useBillingGetOverview: () => ({
      data: {
        configured: true,
        plan: "free",
        subscription: null,
        credits: { captionCredits: 0, imageCredits: 0 },
        creditPacks: [
          { id: 1, name: "Starter Pack", priceInr: 499, captionCredits: 100 },
        ],
        history: [],
      },
      isLoading: false,
    }),
    useBillingPurchaseCredits: () => ({
      ...idleMutation(),
      mutateAsync: mockState.purchaseCreditsMutateAsync,
    }),
    useBillingVerifyPurchase: () => ({
      ...idleMutation(),
      mutate: mockState.verifyPurchaseMutate,
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

async function fireVerifyPurchaseError(err: unknown) {
  fireEvent.click(screen.getByRole("button", { name: /buy/i }));
  await waitFor(() =>
    expect(mockState.verifyPurchaseMutate).toHaveBeenCalledTimes(1),
  );
  const opts = mockState.verifyPurchaseMutate.mock.calls[0][1] as {
    onError: (e: unknown) => void;
  };
  opts.onError(err);
}

function lastToast() {
  return mockState.toast.mock.calls.at(-1)![0] as {
    title: string;
    description: string;
    variant?: string;
  };
}

describe("BillingSettings verify-purchase failure toasts", () => {
  beforeEach(() => {
    mockState.toast = vi.fn();
    mockState.verifyPurchaseMutate = vi.fn();
    mockState.purchaseCreditsMutateAsync = vi.fn().mockResolvedValue({
      gateway: "cashfree",
      cashfreeOrderId: "cf_order_1",
      paymentSessionId: "sess_1",
      cashfreeMode: "sandbox",
    });
  });

  afterEach(() => cleanup());

  it("shows a destructive 'Payment failed' toast for a terminal lost-order 400", async () => {
    renderCard();
    await fireVerifyPurchaseError({
      status: 400,
      data: {
        error:
          "Razorpay no longer recognizes this order. If you were charged, contact support.",
      },
    });

    const call = lastToast();
    expect(call.title).toBe("Payment failed");
    expect(call.description).toBe(
      "Razorpay no longer recognizes this order. If you were charged, contact support.",
    );
    expect(call.variant).toBe("destructive");
  });

  it("keeps the non-destructive 'Payment still processing' toast on 409", async () => {
    renderCard();
    await fireVerifyPurchaseError({
      status: 409,
      data: { error: "Payment not confirmed yet." },
    });

    const call = lastToast();
    expect(call.title).toBe("Payment still processing");
    expect(call.variant).toBe(undefined);
  });

  it("keeps 'Verification pending' for indeterminate failures (5xx / no status)", async () => {
    renderCard();
    await fireVerifyPurchaseError({
      status: 500,
      data: { error: "Internal error" },
    });

    const call = lastToast();
    expect(call.title).toBe("Verification pending");
    expect(call.variant).toBe(undefined);
  });
});
