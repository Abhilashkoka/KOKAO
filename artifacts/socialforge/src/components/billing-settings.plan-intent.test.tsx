import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * A visitor who picked "Pro, annual" on the public pricing page before
 * signing up must not have to pick twice: the billing card reads the stored
 * plan intent once, preselects the yearly cycle and highlights that plan,
 * then clears the intent so it never resurfaces on later visits.
 */

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/lib/features", () => ({
  useFeatureFlags: () => ({
    flags: { upgradeRequests: false, promoCodes: false },
    isLoading: false,
  }),
}));

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useGetMe: () => ({ data: { team: null }, isLoading: false }),
    useListPlans: () => ({
      data: [
        {
          id: "pro",
          name: "Pro",
          priceLabel: "₹2,499 / mo",
          limits: {},
          features: [],
          priceInr: 249900,
          priceInrYearly: 2499000,
        },
        {
          id: "business",
          name: "Business",
          priceLabel: "₹4,999 / mo",
          limits: {},
          features: [],
          priceInr: 499900,
          priceInrYearly: null,
        },
      ],
      isLoading: false,
    }),
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
  });
});

import { BillingSettings } from "./billing-settings";
import { savePlanIntent, readPlanIntent } from "@/lib/planIntent";

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BillingSettings />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("billing settings plan intent", () => {
  it("preselects the yearly cycle and highlights the intended plan, then clears the intent", () => {
    savePlanIntent("pro", "yearly");
    renderCard();

    // Yearly cycle preselected: the pro card shows the annual billing note.
    expect(screen.getByTestId("billing-plan-pro").textContent).toContain(
      "billed once a year",
    );
    // The intended plan is visibly marked.
    expect(screen.getByTestId("billing-plan-pro-selected")).toBeTruthy();
    expect(screen.queryByTestId("billing-plan-business-selected")).toBeNull();
    // Consumed — a later visit won't resurface it.
    expect(readPlanIntent()).toBeNull();
  });

  it("defaults to monthly with no highlight when no intent is stored", () => {
    renderCard();
    expect(screen.getByTestId("billing-plan-pro").textContent).toContain("/ month");
    expect(screen.getByTestId("billing-plan-pro").textContent).not.toContain(
      "billed once a year",
    );
    expect(screen.queryByTestId("billing-plan-pro-selected")).toBeNull();
  });

  it("ignores an expired intent", () => {
    localStorage.setItem(
      "kokao.signup-plan-intent",
      JSON.stringify({
        planId: "pro",
        cycle: "yearly",
        savedAt: Date.now() - 25 * 60 * 60 * 1000,
      }),
    );
    renderCard();
    expect(screen.queryByTestId("billing-plan-pro-selected")).toBeNull();
    expect(screen.getByTestId("billing-plan-pro").textContent).not.toContain(
      "billed once a year",
    );
  });
});
