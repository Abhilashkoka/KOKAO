/**
 * The model price catalog form's edit-identity semantics.
 *
 * A production bug wiped saved prices: editing a row with only a case or
 * whitespace change made the UI delete the row the server had just updated
 * in place (the upsert matches trimmed + case-insensitively, so the "old"
 * row IS the new row). These tests pin the rule: the stale-row delete may
 * fire only when the identity genuinely changed under the server's own
 * folding rules.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AiCostConfigView, AiModelPriceView } from "@workspace/api-client-react";

// Radix needs a few APIs jsdom doesn't implement.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

function price(overrides: Partial<AiModelPriceView>): AiModelPriceView {
  return {
    id: 1,
    kind: "text",
    provider: "OpenRouter",
    model: "GPT-4o",
    inputUsdPerMtok: 2.5,
    outputUsdPerMtok: 10,
    usdPerImage: null,
    usdPerSecond: null,
    usdPerVideo: null,
    ...overrides,
  };
}

function baseConfig(prices: AiModelPriceView[]): AiCostConfigView {
  return {
    usdToInrPaise: 8400,
    rateMarkupPaise: 200,
    marketRatePaise: null,
    rateAutoUpdatedAt: null,
    duplicateGroups: 0,
    prices,
  };
}

const mockState: {
  config: AiCostConfigView;
  imageGenSettings: Record<string, unknown> | undefined;
  videoGenSettings: Record<string, unknown> | undefined;
} = {
  config: baseConfig([]),
  imageGenSettings: undefined,
  videoGenSettings: undefined,
};

// The upsert resolves via onSuccess so the stale-row delete path runs
// exactly the way it does against the real API.
const upsertMutate = vi.fn(
  (
    _vars: { data: Record<string, unknown> },
    opts?: { onSuccess?: () => void },
  ) => {
    opts?.onSuccess?.();
  },
);
const deleteMutate = vi.fn(
  (_vars: { priceId: number }, opts?: { onSuccess?: () => void }) => {
    opts?.onSuccess?.();
  },
);

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../../test/apiClientMock");
  return createApiClientMock({
    useAdminGetAiCostConfig: () => ({ data: mockState.config, isLoading: false }),
    useAdminUpsertAiModelPrice: () => ({ mutate: upsertMutate, isPending: false }),
    useAdminDeleteAiModelPrice: () => ({ mutate: deleteMutate, isPending: false }),
    useAdminGetImageGenSettings: () => ({
      data: mockState.imageGenSettings,
      isLoading: false,
    }),
    useAdminGetVideoGenSettings: () => ({
      data: mockState.videoGenSettings,
      isLoading: false,
    }),
  });
});

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { AiCostCard } from "./ai-tab";

function renderCard() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <AiCostCard />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  upsertMutate.mockClear();
  deleteMutate.mockClear();
  mockState.config = baseConfig([]);
  mockState.imageGenSettings = undefined;
  mockState.videoGenSettings = undefined;
});

describe("price edit identity", () => {
  it("never deletes the row when the edit only changes case/whitespace", async () => {
    mockState.config = baseConfig([price({ id: 7 })]);
    renderCard();
    const user = userEvent.setup();

    await user.click(screen.getByTestId("button-edit-price-7"));

    // Retype the same identity with different casing and stray whitespace —
    // the server folds this into the SAME row, so deleting the "old" id
    // would delete the row that was just saved.
    const providerInput = screen.getByTestId("input-price-provider");
    const modelInput = screen.getByTestId("input-price-model");
    await user.clear(providerInput);
    await user.type(providerInput, "openrouter");
    await user.clear(modelInput);
    await user.type(modelInput, "  gpt-4o ");

    await user.click(screen.getByTestId("button-save-model-price"));

    await waitFor(() => expect(upsertMutate).toHaveBeenCalledTimes(1));
    expect(upsertMutate.mock.calls[0][0].data).toMatchObject({
      kind: "text",
      provider: "openrouter",
      model: "gpt-4o",
    });
    expect(deleteMutate).not.toHaveBeenCalled();
  });

  it("deletes exactly the original row when renamed to a different model", async () => {
    mockState.config = baseConfig([
      price({ id: 3 }),
      price({ id: 9, provider: "builtin", model: "gpt-4o-mini" }),
    ]);
    renderCard();
    const user = userEvent.setup();

    await user.click(screen.getByTestId("button-edit-price-3"));

    const modelInput = screen.getByTestId("input-price-model");
    await user.clear(modelInput);
    await user.type(modelInput, "gpt-4.1");

    await user.click(screen.getByTestId("button-save-model-price"));

    await waitFor(() => expect(deleteMutate).toHaveBeenCalledTimes(1));
    expect(upsertMutate).toHaveBeenCalledTimes(1);
    expect(upsertMutate.mock.calls[0][0].data).toMatchObject({
      provider: "OpenRouter",
      model: "gpt-4.1",
    });
    // Only the edited row's id — never a neighbour's.
    expect(deleteMutate.mock.calls[0][0]).toEqual({ priceId: 3 });
  });
});

describe("model suggestion narrowing", () => {
  const imageSettings = {
    provider: "openai",
    model: null,
    customBaseUrl: null,
    providers: [
      {
        id: "openai",
        label: "OpenAI (built-in)",
        defaultModel: "gpt-image-1",
        configured: true,
        supportsModelOverride: false,
        requiresBaseUrl: false,
      },
      {
        id: "gemini",
        label: "Google Gemini",
        defaultModel: "gemini-2.5-flash-image",
        configured: true,
        supportsModelOverride: true,
        requiresBaseUrl: false,
        modelOptions: [{ value: "gemini-3-pro-image", label: "Gemini 3 Pro" }],
      },
    ],
    autoRanking: [],
  };

  function datalistValues(): string[] {
    const list = document.getElementById("price-model-options");
    return Array.from(list?.querySelectorAll("option") ?? []).map(
      (o) => (o as HTMLOptionElement).value,
    );
  }

  it("narrows image model suggestions to the typed provider", async () => {
    mockState.imageGenSettings = imageSettings;
    renderCard();
    const user = userEvent.setup();

    // Switch the form to the image kind.
    await user.click(screen.getByTestId("select-price-kind"));
    await user.click(screen.getByRole("option", { name: "Image" }));

    // No provider typed: all providers' models are suggested.
    expect(datalistValues()).toEqual(
      expect.arrayContaining(["gpt-image-1", "gemini-2.5-flash-image", "gemini-3-pro-image"]),
    );

    // Typing a provider (any casing) narrows to just its models.
    await user.type(screen.getByTestId("input-price-provider"), "Gemini");
    await waitFor(() =>
      expect(datalistValues()).toEqual(["gemini-2.5-flash-image", "gemini-3-pro-image"]),
    );
  });
});
