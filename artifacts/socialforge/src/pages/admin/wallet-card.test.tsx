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

const mixedPendingRows = [
  {
    usageKind: "caption",
    provider: "builtin",
    model: "gpt-5.4",
    chargeCount: 1,
    reason: "no_price",
    detail: "No catalog price for gpt-5.4.",
  },
  {
    usageKind: "video",
    provider: "replicate",
    model: "bytedance/latentsync",
    chargeCount: 1,
    reason: "no_price",
    detail: "No catalog price for bytedance/latentsync.",
  },
  {
    usageKind: "caption",
    provider: "elevenlabs",
    model: "voice-clone",
    chargeCount: 1,
    reason: "no_price",
    detail: "Use the ElevenLabs credit rate.",
  },
  {
    usageKind: "caption",
    provider: "stock-tts",
    model: "alloy",
    chargeCount: 1,
    reason: "no_price",
    detail: "Stock voice.",
  },
  {
    usageKind: "video",
    provider: "openrouter",
    model: "gpt-5.4",
    chargeCount: 1,
    reason: "no_price",
    detail: "Text model recorded as video.",
  },
  {
    usageKind: "image",
    provider: "openrouter",
    model: "google/gemini-3-pro-image-preview",
    chargeCount: 1,
    reason: "missing_usage",
    detail: "No token usage recorded.",
  },
];

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

describe("WalletCard pending pricing display", () => {
  it("shows only actionable model-price gaps", () => {
    pendingState.rows = mixedPendingRows;
    renderCard();

    expect(screen.getByText("2 models charged at the display rate")).toBeTruthy();
    expect(screen.getByTestId("pending-price-gpt-5.4")).toBeTruthy();
    expect(screen.getByTestId("pending-price-bytedance/latentsync")).toBeTruthy();
    expect(screen.queryByTestId("pending-price-voice-clone")).toBeNull();
    expect(screen.queryByTestId("pending-price-alloy")).toBeNull();
    expect(screen.queryByTestId("pending-price-google/gemini-3-pro-image-preview")).toBeNull();
  });

  it("hides the pricing card when every pending row is non-actionable", () => {
    pendingState.rows = mixedPendingRows.slice(2);
    renderCard();

    expect(screen.queryByText("Needs pricing")).toBeNull();
  });
});