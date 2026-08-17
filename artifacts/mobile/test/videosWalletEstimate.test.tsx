/**
 * Mobile Videos screen — pre-generate wallet cost estimate (app/videos.tsx):
 * - wallet-billed workspaces with a non-zero video rate show the estimate
 *   (testID "text-wallet-estimate") before the Generate button
 * - when the estimate exceeds the balance a shortfall hint appears
 *   (testID "text-wallet-estimate-shortfall")
 * - non-wallet-billed workspaces (quota plans) never show the estimate
 * - a zero video rate hides the estimate even for wallet-billed workspaces
 */
import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockState: {
  wallet: { walletBilling: boolean; balancePaise: number; rates?: { videoPaise: number } } | undefined;
} = { wallet: undefined };

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
    useGetMe: () => ({ data: undefined, isLoading: false }),
  });
});

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
    mockState.wallet = undefined;
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
});
