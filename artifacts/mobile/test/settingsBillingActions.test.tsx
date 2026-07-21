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
const cancelMutate = vi.fn();
const switchPaygMutate = vi.fn();

const mockState: {
  team: { role: string; workspaceName: string } | null;
  configured: boolean;
  plans: Array<Record<string, unknown>>;
  creditPacks: Array<Record<string, unknown>>;
  plan: string;
  subscription: Record<string, unknown> | null;
} = {
  team: null,
  configured: true,
  plans: [],
  creditPacks: [],
  plan: "free",
  subscription: null,
};

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock, idleMutation } = await import("./apiClientMock");
  return createApiClientMock({
    useGetMe: () => ({
      data: {
        tenant: { id: 1, name: "Test Workspace", plan: mockState.plan },
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
        plan: mockState.plan,
        subscription: mockState.subscription,
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
    useBillingCancelSubscription: () => ({
      ...idleMutation(),
      mutate: cancelMutate,
    }),
    useBillingSwitchPayg: () => ({
      ...idleMutation(),
      mutate: switchPaygMutate,
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
  cancelMutate.mockReset();
  switchPaygMutate.mockReset();
  mockState.team = null;
  mockState.configured = true;
  mockState.plans = [paidPlan];
  mockState.creditPacks = [pack];
  mockState.plan = "free";
  mockState.subscription = null;
});

const activeSub = {
  planId: "pro",
  status: "active",
  billingCycle: "monthly",
  cancelAtPeriodEnd: false,
  currentPeriodEnd: "2026-08-21T00:00:00.000Z",
};

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
    expect(screen.queryByText("Buy")).toBeNull();
    expect(
      screen.getByText("Only the workspace owner can buy credits or change the plan."),
    ).toBeTruthy();
  });

  it("owner with an active subscription can cancel via the in-app confirm dialog", async () => {
    mockState.plan = "pro";
    mockState.subscription = { ...activeSub };
    renderScreen();

    expect(cancelMutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Cancel subscription"));
    // Confirmation dialog appears; nothing sent yet.
    expect(screen.getByText("Cancel subscription?")).toBeTruthy();
    expect(cancelMutate).not.toHaveBeenCalled();

    const confirmButtons = screen.getAllByText("Cancel subscription");
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);
    await waitFor(() => expect(cancelMutate).toHaveBeenCalledTimes(1));
  });

  it("dismissing the cancel dialog sends nothing", () => {
    mockState.plan = "pro";
    mockState.subscription = { ...activeSub };
    renderScreen();

    fireEvent.click(screen.getByText("Cancel subscription"));
    fireEvent.click(screen.getByText("Keep as is"));
    expect(cancelMutate).not.toHaveBeenCalled();
  });

  it("hides the cancel button once cancellation is already scheduled", () => {
    mockState.plan = "pro";
    mockState.subscription = { ...activeSub, cancelAtPeriodEnd: true };
    renderScreen();

    expect(screen.queryByText("Cancel subscription")).toBeNull();
  });

  it("free-plan owner can switch to Pay As You Go after confirming", async () => {
    renderScreen();

    fireEvent.click(screen.getByText("Switch to Pay As You Go"));
    expect(screen.getByText("Switch to Pay As You Go?")).toBeTruthy();
    expect(switchPaygMutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Switch plan"));
    await waitFor(() => expect(switchPaygMutate).toHaveBeenCalledTimes(1));
  });

  it("hides the Pay As You Go switch while a subscription is live", () => {
    mockState.plan = "pro";
    mockState.subscription = { ...activeSub };
    renderScreen();

    expect(screen.queryByText("Switch to Pay As You Go")).toBeNull();
  });

  it("non-owner members see neither cancel nor Pay As You Go actions", () => {
    mockState.team = { role: "member", workspaceName: "Owner WS" };
    mockState.plan = "pro";
    mockState.subscription = { ...activeSub };
    renderScreen();

    expect(screen.queryByText("Cancel subscription")).toBeNull();
    expect(screen.queryByText("Switch to Pay As You Go")).toBeNull();
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
