import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const state = vi.hoisted(() => ({
  plans: [] as any[],
  creditPacks: [] as any[],
  gamificationPlans: [] as any[],
  updatePack: vi.fn(),
  rateCard: undefined as any,
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
    useAdminGetCreditRates: () => ({ data: state.rateCard, isLoading: false }),
    useAdminListCreditPacks: () => ({ data: state.creditPacks, isLoading: false }),
    useAdminUpdateCreditPack: () => ({ mutate: state.updatePack, isPending: false }),
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
  state.updatePack.mockReset();
  state.rateCard = undefined;
});

describe("plan limit suggestions", () => {
  it("updates allowance estimates while editing credits", () => {
    state.rateCard = { mode: "shadow", creditPricePaise: 2000, rates: [
      { key: "video", unit: "second", credits: 1, active: true },
      { key: "image", unit: "item", credits: 0.5, active: true },
    ] };
    state.creditPacks = [{ id: 1, name: "Starter", pricePaise: 49900, credits: 120, captionCredits: 0, imageCredits: 0, active: true }];
    renderTab();
    expect(screen.getByText("≈ 2 min of standard AI video or 240 images")).toBeTruthy();
    fireEvent.change(screen.getByTestId("input-pack-credits"), { target: { value: "60" } });
    expect(screen.getByText("≈ 1 min of standard AI video or 120 images")).toBeTruthy();
  });
  it("saves the admin recommendation and clears it when hiding the pack", () => {
    state.creditPacks = [{
      id: 1, name: "Starter", pricePaise: 49900, credits: 100,
      captionCredits: 0, imageCredits: 0, active: true, recommended: false,
    }];
    renderTab();
    fireEvent.click(screen.getByRole("switch", { name: "Recommend Starter" }));
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(state.updatePack).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 1, data: expect.objectContaining({ recommended: true }) }),
      expect.any(Object),
    );
    fireEvent.click(screen.getByRole("switch", { name: "Toggle Starter on sale" }));
    expect(screen.getByRole("switch", { name: "Recommend Starter" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(state.updatePack).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ active: false, recommended: false }) }),
      expect.any(Object),
    );
  });
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