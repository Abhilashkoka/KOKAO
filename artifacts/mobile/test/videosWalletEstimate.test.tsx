/**
 * Mobile Videos screen — pre-generate wallet cost estimate (app/videos.tsx):
 * - wallet-billed workspaces with a non-zero video rate show the estimate
 *   (testID "text-wallet-estimate") before the Generate button
 * - when the estimate exceeds the balance a shortfall hint appears
 *   (testID "text-wallet-estimate-shortfall")
 * - non-wallet-billed workspaces (quota plans) never show the estimate
 * - a zero video rate hides the estimate even for wallet-billed workspaces
 * - a Recharge button (testID "button-wallet-recharge") is shown for owners
 *   inside the shortfall hint and triggers the wallet top-up flow
 */
import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const rechargeWalletMutateAsync = vi.fn();

const mockState: {
  wallet: { walletBilling: boolean; balancePaise: number; rates?: { videoPaise: number } } | undefined;
  meRole: "owner" | "member";
} = { wallet: undefined, meRole: "owner" };

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("./apiClientMock");
  return createApiClientMock({
    useListVideoJobs: () => ({
      data: [],
      isLoading: false,
      isError: false,
      isRefetching: false,
      refetch: vi.fn(),
    }),
    useListFeatureFlags: () => ({ data: undefined, isLoading: false }),
    useGetAiSpendRates: () => ({ data: undefined, isLoading: false }),
    useGenerateVideo: () => ({ mutate: vi.fn(), isPending: false }),
    useWalletGetOverview: () => ({ data: mockState.wallet, isLoading: false }),
    useGetMe: () => ({
      data:
        mockState.meRole === "member"
          ? { team: { role: "member" } }
          : undefined,
      isLoading: false,
    }),
    useWalletRecharge: () => ({
      mutateAsync: rechargeWalletMutateAsync,
      isPending: false,
    }),
  });
});

const checkoutRequests: Array<Record<string, unknown> | null> = [];
vi.mock("@/components/RazorpayCheckoutModal", () => ({
  RazorpayCheckoutModal: ({ request }: { request: Record<string, unknown> | null }) => {
    checkoutRequests.push(request);
    return null;
  },
}));

vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn().mockResolvedValue(true) }));
vi.mock("@clerk/expo", () => ({
  useAuth: () => ({ getToken: vi.fn().mockResolvedValue("test-token") }),
}));
vi.mock("expo-video", () => ({ useVideoPlayer: () => ({}), VideoView: () => null }));
vi.mock("@expo/vector-icons", () => ({
  Feather: Object.assign(() => null, { glyphMap: {} }),
}));
vi.mock("expo-haptics", () => ({
  impactAsync: vi.fn(),
  ImpactFeedbackStyle: { Light: "light" },
}));
vi.mock("@/components/ContentImage", () => ({ ContentImage: () => null }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

import VideosScreen from "../app/videos";

function renderScreen() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <VideosScreen />
    </QueryClientProvider>,
  );
}

describe("Videos screen — pre-generate wallet estimate", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    checkoutRequests.length = 0;
    mockState.wallet = undefined;
    mockState.meRole = "owner";
  });

  it("shows the estimate for a wallet-billed workspace with a non-zero video rate", () => {
    mockState.wallet = { walletBilling: true, balancePaise: 5000, rates: { videoPaise: 200 } };
    renderScreen();
    const el = screen.getByTestId("text-wallet-estimate");
    expect(el).toBeTruthy();
    // 200 paise = ₹2.00
    expect(el.textContent).toContain("₹2.00");
  });

  it("hides the estimate for non-wallet-billed (quota-plan) workspaces", () => {
    mockState.wallet = { walletBilling: false, balancePaise: 0, rates: { videoPaise: 200 } };
    renderScreen();
    expect(screen.queryByTestId("text-wallet-estimate")).toBeNull();
  });

  it("hides the estimate when the video rate is zero even for a wallet workspace", () => {
    mockState.wallet = { walletBilling: true, balancePaise: 5000, rates: { videoPaise: 0 } };
    renderScreen();
    expect(screen.queryByTestId("text-wallet-estimate")).toBeNull();
  });

  it("hides the estimate when the wallet overview has not loaded yet", () => {
    mockState.wallet = undefined;
    renderScreen();
    expect(screen.queryByTestId("text-wallet-estimate")).toBeNull();
  });

  it("shows the shortfall hint when the estimate exceeds the balance", () => {
    // rate 500 paise, balance 200 paise → shortfall
    mockState.wallet = { walletBilling: true, balancePaise: 200, rates: { videoPaise: 500 } };
    renderScreen();
    expect(screen.getByTestId("text-wallet-estimate")).toBeTruthy();
    const shortfall = screen.getByTestId("text-wallet-estimate-shortfall");
    expect(shortfall).toBeTruthy();
    expect(shortfall.textContent).toContain("recharge your wallet");
  });

  it("does not show the shortfall hint when the balance covers the estimate", () => {
    mockState.wallet = { walletBilling: true, balancePaise: 10000, rates: { videoPaise: 300 } };
    renderScreen();
    expect(screen.getByTestId("text-wallet-estimate")).toBeTruthy();
    expect(screen.queryByTestId("text-wallet-estimate-shortfall")).toBeNull();
  });

  it("shows the balance in the shortfall message in INR", () => {
    // balance 150 paise = ₹1.50
    mockState.wallet = { walletBilling: true, balancePaise: 150, rates: { videoPaise: 500 } };
    renderScreen();
    const shortfall = screen.getByTestId("text-wallet-estimate-shortfall");
    expect(shortfall.textContent).toContain("₹1.50");
  });

  it("shows the Recharge button for an owner when a shortfall exists", () => {
    mockState.wallet = { walletBilling: true, balancePaise: 200, rates: { videoPaise: 500 } };
    mockState.meRole = "owner";
    renderScreen();
    expect(screen.getByTestId("button-wallet-recharge")).toBeTruthy();
  });

  it("hides the Recharge button for a team member when a shortfall exists", () => {
    mockState.wallet = { walletBilling: true, balancePaise: 200, rates: { videoPaise: 500 } };
    mockState.meRole = "member";
    renderScreen();
    expect(screen.queryByTestId("button-wallet-recharge")).toBeNull();
  });

  it("does not show the Recharge button when there is no shortfall", () => {
    mockState.wallet = { walletBilling: true, balancePaise: 10000, rates: { videoPaise: 300 } };
    renderScreen();
    expect(screen.queryByTestId("button-wallet-recharge")).toBeNull();
  });

  it("tapping Recharge calls walletRecharge with the shortfall rounded up to the nearest ₹10", async () => {
    // rate 500, balance 200 → shortfall 300 paise → rounds up to 1000 paise (₹10 minimum)
    mockState.wallet = { walletBilling: true, balancePaise: 200, rates: { videoPaise: 500 } };
    rechargeWalletMutateAsync.mockResolvedValue({
      gateway: "razorpay",
      razorpayOrderId: "order_test_1",
      keyId: "rzp_test_key",
      basePaise: 1000,
      totalPaise: 1180,
      gstPaise: 180,
      gstPercent: 18,
    });
    renderScreen();

    fireEvent.click(screen.getByTestId("button-wallet-recharge"));

    await waitFor(() =>
      expect(rechargeWalletMutateAsync).toHaveBeenCalledWith({
        data: { amountPaise: 1000 },
      }),
    );
  });

  it("tapping Recharge opens checkout when the order is created successfully", async () => {
    // rate 2000 paise, balance 500 paise → shortfall 1500 paise → rounds to 2000 paise
    mockState.wallet = { walletBilling: true, balancePaise: 500, rates: { videoPaise: 2000 } };
    rechargeWalletMutateAsync.mockResolvedValue({
      gateway: "razorpay",
      razorpayOrderId: "order_test_2",
      keyId: "rzp_test_key",
      basePaise: 2000,
      totalPaise: 2360,
      gstPaise: 360,
      gstPercent: 18,
    });
    renderScreen();

    fireEvent.click(screen.getByTestId("button-wallet-recharge"));

    await waitFor(() =>
      expect(rechargeWalletMutateAsync).toHaveBeenCalledWith({
        data: { amountPaise: 2000 },
      }),
    );
    await waitFor(() =>
      expect(
        checkoutRequests.some(
          (r) => r && r.mode === "order" && r.orderId === "order_test_2",
        ),
      ).toBe(true),
    );
  });
});
