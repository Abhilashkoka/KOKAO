/**
 * Regression guard: the mobile Plan & Billing screen lets workspace owners
 * start a plan upgrade or credit-pack purchase in-app (Razorpay checkout via
 * WebView), instead of only pointing them at the web app. Non-owner team
 * members must not see purchase actions.
 */
import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const subscribeMutateAsync = vi.fn();
const purchaseMutateAsync = vi.fn();

const mockState: {
  team: { role: string; workspaceName: string } | null;
  configured: boolean;
  plans: Array<Record<string, unknown>>;
  creditPacks: Array<Record<string, unknown>>;
} = { team: null, configured: true, plans: [], creditPacks: [] };

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock, idleMutation } = await import("./apiClientMock");
  return createApiClientMock({
    useGetMe: () => ({
      data: {
        tenant: { id: 1, name: "Test Workspace", plan: "free" },
        usage: { captions: 1, images: 1 },
        limits: { captions: 10, images: 10 },
        credits: { captionCredits: 0, imageCredits: 0 },
        team: mockState.team,
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
      isRefetching: false,
    }),
    useBillingGetOverview: () => ({
      data: {
        configured: mockState.configured,
        keyId: mockState.configured ? "rzp_test_key" : null,
        plan: "free",
        subscription: null,
        credits: { captionCredits: 0, imageCredits: 0 },
        creditPacks: mockState.creditPacks,
        history: [],
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
      isRefetching: false,
    }),
    useListPlans: () => ({
      data: mockState.plans,
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
      isRefetching: false,
    }),
    useBillingSubscribe: () => ({
      ...idleMutation(),
      mutateAsync: subscribeMutateAsync,
    }),
    useBillingPurchaseCredits: () => ({
      ...idleMutation(),
      mutateAsync: purchaseMutateAsync,
    }),
  });
});

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("@expo/vector-icons", () => ({
  Feather: Object.assign(() => null, { glyphMap: {} }),
}));

const checkoutRequests: Array<Record<string, unknown> | null> = [];
vi.mock("@/components/RazorpayCheckoutModal", () => ({
  RazorpayCheckoutModal: ({ request }: { request: Record<string, unknown> | null }) => {
    checkoutRequests.push(request);
    return null;
  },
}));

import SettingsScreen from "../app/settings";

function renderScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SettingsScreen />
    </QueryClientProvider>,
  );
}

const pack = { id: 7, name: "Starter pack", pricePaise: 49900, captionCredits: 50, imageCredits: 10 };
const paidPlan = { id: "pro", name: "Pro", priceInr: 99900, priceInrYearly: null };

beforeEach(() => {
  cleanup();
  checkoutRequests.length = 0;
  subscribeMutateAsync.mockReset();
  purchaseMutateAsync.mockReset();
  mockState.team = null;
  mockState.configured = true;
  mockState.plans = [paidPlan];
  mockState.creditPacks = [pack];
});

describe("Mobile Plan & Billing purchase actions", () => {
  it("owner sees upgrade and buy buttons and buying opens checkout", async () => {
    purchaseMutateAsync.mockResolvedValue({
      razorpayOrderId: "order_1",
      amountPaise: 49900,
      keyId: "rzp_test_key",
    });
    renderScreen();

    expect(screen.getByText("Upgrade plan")).toBeTruthy();
    expect(screen.getByText("Upgrade")).toBeTruthy();

    fireEvent.click(screen.getByText("Buy"));
    await waitFor(() =>
      expect(purchaseMutateAsync).toHaveBeenCalledWith({
        data: { creditPackId: 7 },
      }),
    );
    await waitFor(() =>
      expect(
        checkoutRequests.some(
          (r) => r && r.mode === "order" && r.orderId === "order_1",
        ),
      ).toBe(true),
    );
  });

  it("upgrading a plan starts a subscription checkout", async () => {
    subscribeMutateAsync.mockResolvedValue({
      razorpaySubscriptionId: "sub_1",
      keyId: "rzp_test_key",
    });
    renderScreen();

    fireEvent.click(screen.getByText("Upgrade"));
    await waitFor(() =>
      expect(subscribeMutateAsync).toHaveBeenCalledWith({
        data: { planId: "pro", billingCycle: "monthly" },
      }),
    );
    await waitFor(() =>
      expect(
        checkoutRequests.some(
          (r) => r && r.mode === "subscription" && r.subscriptionId === "sub_1",
        ),
      ).toBe(true),
    );
  });

  it("non-owner members get no purchase actions", () => {
    mockState.team = { role: "member", workspaceName: "Owner WS" };
    renderScreen();

    expect(screen.queryByText("Upgrade plan")).toBeNull();
    expect(
      screen.getByText("Only the workspace owner can buy credits or change the plan."),
    ).toBeTruthy();
  });

  it("explains when payments are not configured instead of offering checkout", () => {
    mockState.configured = false;
    renderScreen();

    expect(screen.queryByText("Upgrade plan")).toBeNull();
    expect(
      screen.getByText(
        "Online payments are not set up yet. Purchases will be available once the platform administrator adds payment keys.",
      ),
    ).toBeTruthy();
  });
});
