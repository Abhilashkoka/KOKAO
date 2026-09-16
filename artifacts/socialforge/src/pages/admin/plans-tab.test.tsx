import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const state = vi.hoisted(() => ({
  plans: [] as any[],
  creditPacks: [] as any[],
  gamificationPlans: [] as any[],
}));

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../../test/apiClientMock");
  return createApiClientMock({
    useListPlans: () => ({ data: state.plans, isLoading: false }),
    useAdminGetAiSpendSettings: () => ({
      data: {
        captionCostPaise: 100,
        imageCostPaise: 200,
        videoCostPaise: 500,
        feePercent: 0,
      },
      isFetched: true,
    }),
    useAdminGetCreditRates: () => ({ data: undefined, isLoading: false }),
    useAdminListCreditPacks: () => ({ data: state.creditPacks, isLoading: false }),
    useAdminListGamificationPlans: () => ({
      data: state.gamificationPlans,
      isLoading: false,
    }),
  });
});

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { PlansTab } from "./plans-tab";

const plan = (billingMode: "quota" | "wallet" | "credits") => ({
  id: "pro",
  name: "Pro",
  priceLabel: "₹999 / mo",
  priceInr: 99900,
  priceInrYearly: null,
  limits: {
    captions: 321,
    images: 222,
    videos: 111,
    brandKits: 7,
    scheduledPosts: 42,
  },
  features: ["Legacy limits"],
  teamSeats: 0,
  watermark: false,
  billingMode,
  monthlyCredits: 17,
});

function renderTab() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <PlansTab />
    </QueryClientProvider>,
  );
}

function chooseBillingMode(mode: "quota" | "wallet" | "credits") {
  fireEvent.click(screen.getByTestId("select-billing-mode-pro"));
  fireEvent.click(
    screen.getByRole("option", {
      name:
        mode === "credits"
          ? "Credits"
          : mode === "wallet"
            ? "Prepaid wallet"
            : "Monthly quota",
    }),
  );
}

beforeEach(() => {
  cleanup();
  state.plans = [];
  state.creditPacks = [];
  state.gamificationPlans = [];
});

describe("plan limit suggestions", () => {
  it.each(["quota", "wallet"] as const)(
    "renders the price suggestion for %s plans",
    (billingMode) => {
      state.plans = [plan(billingMode)];
      renderTab();

      expect(screen.getByText("Suggest limits from price")).toBeTruthy();
      expect(screen.getByTestId("text-suggestion-pro")).toBeTruthy();
    },
  );

  it("does not render the price suggestion for credit plans", () => {
    state.plans = [plan("credits")];
    renderTab();

    expect(screen.queryByText("Suggest limits from price")).toBeNull();
    expect(screen.queryByTestId("input-ratio-pro")).toBeNull();
  });

  it("hides and restores the calculator without overwriting legacy limits", () => {
    state.plans = [plan("quota")];
    renderTab();

    expect(screen.getByTestId("text-suggestion-pro")).toBeTruthy();
    chooseBillingMode("credits");
    expect(screen.queryByTestId("text-suggestion-pro")).toBeNull();
    expect(screen.queryByText("Suggest limits from price")).toBeNull();

    chooseBillingMode("wallet");
    expect(screen.getByTestId("text-suggestion-pro")).toBeTruthy();
    expect(screen.getByDisplayValue("321")).toBeTruthy();
    expect(screen.getByDisplayValue("222")).toBeTruthy();
    expect(screen.getByDisplayValue("111")).toBeTruthy();
  });
});