import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WalletCard } from "./wallet-balance";

const mockState = {
  flags: { wallet: true },
  wallet: {
    walletBilling: true,
    configured: true,
    balancePaise: 250_00,
    gstPercent: 18,
    minTopupPaise: 100_00,
    lowBalanceThresholdPaise: 500_00,
    lowBalance: false,
    rates: { captionPaise: 240, imagePaise: 600, videoPaise: 1200 },
    history: [],
  } as Record<string, unknown>,
};

// The recharge order comes back with gateway: 'cashfree' so the component
// must open the Cashfree modal (not Razorpay) and then verify with the server.
const rechargeAsync = vi.fn().mockResolvedValue({
  gateway: "cashfree",
  cashfreeOrderId: "cf_order_1",
  paymentSessionId: "session_1",
  cashfreeMode: "sandbox",
  basePaise: 100_00,
  gstPaise: 18_00,
  gstPercent: 18,
  totalPaise: 118_00,
});
const verifyMutate = vi.fn();

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useWalletGetOverview: () => ({ data: mockState.wallet, isLoading: false }),
    useWalletRecharge: () => ({ mutateAsync: rechargeAsync, isPending: false }),
    useWalletVerifyRecharge: () => ({ mutate: verifyMutate, isPending: false }),
    useGetMe: () => ({ data: { team: { role: "owner" } } }),
  });
});

vi.mock("@/lib/features", () => ({
  useFeatureFlags: () => ({ flags: mockState.flags, isLoading: false }),
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const openCashfreeCheckout = vi
  .fn()
  .mockResolvedValue({ completed: true });
const openRazorpay = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/cashfree-checkout", () => ({
  openCashfreeCheckout: (args: unknown) => openCashfreeCheckout(args),
}));

vi.mock("@/lib/razorpay-checkout", async () => {
  const actual = await vi.importActual<typeof import("@/lib/razorpay-checkout")>(
    "@/lib/razorpay-checkout",
  );
  return { ...actual, openCheckout: (args: unknown) => openRazorpay(args) };
});

function renderCard() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <WalletCard />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  rechargeAsync.mockClear();
  verifyMutate.mockClear();
  openCashfreeCheckout.mockClear();
  openRazorpay.mockClear();
});

describe("WalletCard cashfree branch", () => {
  it("opens the Cashfree checkout and verifies by cashfreeOrderId", async () => {
    renderCard();
    fireEvent.change(screen.getByTestId("input-wallet-topup"), {
      target: { value: "1000" },
    });
    fireEvent.click(screen.getByTestId("button-wallet-recharge"));

    await waitFor(() => expect(openCashfreeCheckout).toHaveBeenCalledTimes(1));
    expect(openRazorpay).not.toHaveBeenCalled();
    expect(openCashfreeCheckout.mock.calls[0][0]).toEqual({
      paymentSessionId: "session_1",
      mode: "sandbox",
    });

    await waitFor(() => expect(verifyMutate).toHaveBeenCalledTimes(1));
    const [payload] = verifyMutate.mock.calls[0];
    expect(payload).toEqual({ data: { cashfreeOrderId: "cf_order_1" } });
  });
});
