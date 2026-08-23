import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const pendingState = {
  rows: [
    {
      usageKind: "video",
      provider: "replicate",
      model: "owner/model",
      chargeCount: 2,
      reason: "no_price",
      detail: "No matching model price is available.",
    },
  ],
};

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../../test/apiClientMock");
  return createApiClientMock({
    useAdminGetWalletSettings: () => ({
      data: {
        gstPercent: 18,
        minTopupPaise: 10_000,
        lowBalanceThresholdPaise: 1_000,
        videoCostPaise: 500,
      },
      isLoading: false,
    }),
    useAdminListWalletPendingPrices: () => ({ data: pendingState.rows }),
    useAdminUpdateWalletSettings: () => ({ mutate: vi.fn(), isPending: false }),
    useAdminReconcileWalletPendingPrices: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
    useAdminPreviewAiModelPriceImport: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
    useAdminConfirmAiModelPriceImport: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
  });
});

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import { WalletCard } from "./wallet-card";

function renderCard() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <WalletCard />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  pendingState.rows = [
    {
      usageKind: "video",
      provider: "replicate",
      model: "owner/model",
      chargeCount: 2,
      reason: "no_price",
      detail: "No matching model price is available.",
    },
  ];
});

describe("WalletCard model price import", () => {
  it("opens a targeted URL import from the no-price row", async () => {
    renderCard();
    const user = userEvent.setup();

    await user.click(screen.getByTestId("button-import-price-owner/model"));

    expect(
      screen.getByRole("heading", { name: "Import model price from URL" }),
    ).toBeTruthy();
    expect(screen.getByText("replicate · owner/model")).toBeTruthy();
    expect(screen.queryByTestId("button-reconcile-owner/model")).toBeNull();
  });
});