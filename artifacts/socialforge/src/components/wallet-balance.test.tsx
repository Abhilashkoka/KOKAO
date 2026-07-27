import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WalletCard, WalletBalancePill } from "./wallet-balance";

const mockState = {
  flags: { wallet: true },
  wallet: {
    walletBilling: true,
    configured: true,
    keyId: "rzp_test",
    balancePaise: 250_00,
    gstPercent: 18,
    minTopupPaise: 100_00,
    lowBalanceThresholdPaise: 500_00,
    lowBalance: true,
    rates: { captionPaise: 240, imagePaise: 600, videoPaise: 1200 },
    history: [
      { id: 1, kind: "topup", amountPaise: 100_000, estimated: false, createdAt: "" },
      {
        id: 2,
        kind: "settle",
        amountPaise: -120,
        usageKind: "caption",
        estimated: false,
        createdAt: "",
      },
    ],
  } as Record<string, unknown> | undefined,
};

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useWalletGetOverview: () => ({ data: mockState.wallet, isLoading: false }),
    useWalletRecharge: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useWalletVerifyRecharge: () => ({ mutate: vi.fn(), isPending: false }),
    useGetMe: () => ({ data: { team: { role: "owner" } } }),
  });
});

vi.mock("@/lib/features", () => ({
  useFeatureFlags: () => ({ flags: mockState.flags, isLoading: false }),
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

function renderCard() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <WalletCard />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockState.flags = { wallet: true };
  mockState.wallet = {
    walletBilling: true,
    configured: true,
    keyId: "rzp_test",
    balancePaise: 250_00,
    gstPercent: 18,
    minTopupPaise: 100_00,
    lowBalanceThresholdPaise: 500_00,
    lowBalance: true,
    rates: { captionPaise: 240, imagePaise: 600, videoPaise: 1200 },
    history: [],
  };
});

describe("WalletCard", () => {
  it("shows the GST-exclusive balance", () => {
    renderCard();
    expect(screen.getByText("₹250")).toBeTruthy();
    expect(screen.getAllByText(/excl\. GST/).length).toBeGreaterThan(0);
  });

  it("warns when the balance is below the admin threshold", () => {
    renderCard();
    expect(screen.getByText(/Running low/)).toBeTruthy();
  });

  it("spells out base vs GST before the user pays", () => {
    renderCard();
    fireEvent.change(screen.getByTestId("input-wallet-topup"), {
      target: { value: "1000" },
    });
    // ₹1,000 into the wallet, ₹1,180 charged at checkout.
    expect(screen.getByText(/₹1,000 lands in your wallet/)).toBeTruthy();
    expect(screen.getByText("₹1,180")).toBeTruthy();
  });

  it("renders nothing for a workspace still on quota billing", () => {
    mockState.wallet = { ...(mockState.wallet as object), walletBilling: false };
    const { container } = renderCard();
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing at all when the platform switch is off", () => {
    mockState.flags = { wallet: false };
    const { container } = renderCard();
    expect(container.innerHTML).toBe("");
  });
});

describe("WalletBalancePill", () => {
  it("shows the balance in the app chrome for wallet workspaces", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <WalletBalancePill />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("pill-wallet-balance").textContent).toContain("₹250");
  });

  it("stays hidden for quota workspaces", () => {
    mockState.wallet = { ...(mockState.wallet as object), walletBilling: false };
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <WalletBalancePill />
      </QueryClientProvider>,
    );
    expect(container.innerHTML).toBe("");
  });
});
