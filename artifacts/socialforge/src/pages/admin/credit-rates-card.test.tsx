import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const updateMutate = vi.fn();
const toast = vi.fn();

const rateCard = {
  mode: "shadow",
  creditPricePaise: 4500,
  rates: [
    {
      key: "video",
      label: "Video generation",
      unit: "second",
      credits: 1,
      active: true,
      sortOrder: 10,
      notes: null,
    },
    {
      key: "video_hd",
      label: "Video generation (HD)",
      unit: "second",
      credits: 1.5,
      active: true,
      sortOrder: 20,
      notes: null,
    },
    {
      key: "image",
      label: "Image generation",
      unit: "item",
      credits: 3,
      active: true,
      sortOrder: 30,
      notes: null,
    },
    {
      key: "image_edit",
      label: "Image edit",
      unit: "item",
      credits: 3,
      active: true,
      sortOrder: 40,
      notes: null,
    },
    {
      key: "caption",
      label: "Caption / text generation",
      unit: "item",
      credits: 0.2,
      active: true,
      sortOrder: 50,
      notes: "One text generation request.",
    },
    {
      key: "voice",
      label: "Voice / narration",
      unit: "second",
      credits: 0.1,
      active: true,
      sortOrder: 60,
      notes: null,
    },
    {
      key: "lipsync",
      label: "Lip sync",
      unit: "second",
      credits: 2,
      active: true,
      sortOrder: 70,
      notes: null,
    },
    {
      key: "transcription",
      label: "Transcription (ASR)",
      unit: "second",
      credits: 0.05,
      active: true,
      sortOrder: 80,
      notes: null,
    },
  ],
};

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../../test/apiClientMock");
  return createApiClientMock({
    useAdminGetCreditRates: () => ({
      data: rateCard,
      isLoading: false,
    }),
    useAdminUpdateCreditRates: () => ({
      mutate: updateMutate,
      isPending: false,
    }),
  });
});

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast }),
}));

import { CreditRatesCard } from "./credit-rates-card";

function renderCard() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <CreditRatesCard showMeterMode={false} context="plans" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  updateMutate.mockClear();
  toast.mockClear();
});

describe("Plans credit usage pricing card", () => {
  it("shows the persisted conversion and human-readable units", () => {
    renderCard();

    expect((screen.getByTestId("input-credit-price-plans") as HTMLInputElement).value).toBe(
      "45",
    );
    expect(screen.getByTestId("text-credit-conversion-plans").textContent).toContain(
      "₹1 = 0.0222 credits",
    );
    expect(screen.getByTestId("select-rate-unit-0").textContent).toContain("video second");
    expect(screen.getByTestId("select-rate-unit-2").textContent).toContain("image");
    expect(screen.getByTestId("select-rate-unit-4").textContent).toContain("text request");
    expect(screen.getByTestId("select-rate-unit-5").textContent).toContain("audio second");
    expect(screen.queryByTestId("select-meter-mode")).toBeNull();
    expect(screen.getByText(/not per caption, character or token/)).toBeTruthy();
  });

  it("saves decimal rupee conversion and every supported rate through the shared API", () => {
    renderCard();
    fireEvent.change(screen.getByTestId("input-credit-price-plans"), {
      target: { value: "50.25" },
    });
    fireEvent.change(screen.getByTestId("input-rate-credits-4"), {
      target: { value: "0.35" },
    });
    fireEvent.click(screen.getByTestId("button-save-credit-rates"));

    expect(updateMutate).toHaveBeenCalledTimes(1);
    const [{ data }] = updateMutate.mock.calls[0] as [{ data: typeof rateCard }];
    expect(data.creditPricePaise).toBe(5025);
    expect(data.rates).toHaveLength(8);
    expect(data.rates.find((rate) => rate.key === "caption")?.credits).toBe(0.35);
  });
});