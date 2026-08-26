import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const settingsState: {
  data?: { replicatePricingModels: Array<{ model: string; uses: string[] }> };
  isLoading: boolean;
  error: unknown;
} = {
  data: undefined,
  isLoading: false,
  error: undefined,
};

const pricingState: {
  data?: Array<{
    model: string;
    price: string;
    variants: Array<{
      title: string;
      criteria: Record<string, string>;
      price: string;
    }>;
  }>;
  isLoading: boolean;
  error: unknown;
} = {
  data: undefined,
  isLoading: false,
  error: undefined,
};

let adminAccessRevoked = false;

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/lib/admin-guard", () => ({
  useAdminAccessRevoked: () => adminAccessRevoked,
}));

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useAdminGetVideoGenSettings: () => settingsState,
    useAdminListVideoModelPricing: () => pricingState,
    useAdminSyncVideoModelPricing: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
    getAdminListVideoModelPricingQueryKey: () => ["admin-video-model-pricing"],
    getAdminGetAiCostConfigQueryKey: () => ["admin-ai-cost-config"],
  });
});

import { VideoPricingPage } from "./video-pricing";

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <VideoPricingPage />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  settingsState.data = undefined;
  settingsState.isLoading = false;
  settingsState.error = undefined;
  pricingState.data = undefined;
  pricingState.isLoading = false;
  pricingState.error = undefined;
  adminAccessRevoked = false;
});

describe("VideoPricingPage", () => {
  it("shows an access message instead of loading skeletons after a 403", () => {
    settingsState.error = { status: 403 };

    renderPage();

    expect(screen.getByTestId("video-pricing-access-denied")).toBeTruthy();
    expect(screen.getByText("Access denied")).toBeTruthy();
    expect(
      screen.getByText("Video model pricing is available to platform administrators only."),
    ).toBeTruthy();
    expect(screen.queryByTestId("button-sync-video-pricing")).toBeNull();
    expect(document.querySelector(".animate-pulse")).toBeNull();
  });

  it("keeps the access message visible after the global guard evicts the failed query", () => {
    settingsState.isLoading = true;
    adminAccessRevoked = true;

    renderPage();

    expect(screen.getByTestId("video-pricing-access-denied")).toBeTruthy();
    expect(screen.queryByTestId("button-sync-video-pricing")).toBeNull();
    expect(document.querySelector(".animate-pulse")).toBeNull();
  });

  it("renders live model and variant pricing for a superadmin", () => {
    settingsState.data = {
      replicatePricingModels: [
        { model: "vendor/video-model", uses: ["generation"] },
      ],
    };
    pricingState.data = [
      {
        model: "vendor/video-model",
        price: "$0.10 per second",
        variants: [
          {
            title: "High Quality",
            criteria: { mode: "high" },
            price: "$0.20 per second",
          },
        ],
      },
    ];

    renderPage();

    expect(screen.getByTestId("list-video-model-pricing")).toBeTruthy();
    expect(screen.getByText("vendor/video-model")).toBeTruthy();
    expect(screen.getByText("High Quality")).toBeTruthy();
    expect(screen.getByText("$0.20 per second")).toBeTruthy();
  });
});