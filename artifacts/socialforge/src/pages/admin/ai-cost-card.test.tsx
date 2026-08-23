/**
 * The model price catalog form's edit-identity semantics and deep-link
 * highlight behaviour.
 *
 * A production bug wiped saved prices: editing a row with only a case or
 * whitespace change made the UI delete the row the server had just updated
 * in place (the upsert matches trimmed + case-insensitively, so the "old"
 * row IS the new row). These tests pin the rule: the stale-row delete may
 * fire only when the identity genuinely changed under the server's own
 * folding rules.
 *
 * The deep-link section confirms that ?model=&kind= from a wallet true-up
 * alert highlights the correct row, and that a stale/renamed model param
 * never crashes the card or breaks other rows.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AiCostConfigView, AiModelPriceView } from "@workspace/api-client-react";

// ── wouter stub: tests set mockRoute.search before rendering ──────────────
const mockRoute = { search: "" };
vi.mock("wouter", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("wouter");
  return { ...actual, useSearch: () => mockRoute.search };
});

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
    isDuplicate: false,
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
  const result = render(
    <QueryClientProvider client={new QueryClient()}>
      <AiCostCard />
    </QueryClientProvider>,
  );
  // The card renders collapsed by default; expand it so tests can reach the
  // pricing controls inside.
  fireEvent.click(screen.getByTestId("toggle-ai-cost-card"));
  return result;
}

beforeEach(() => {
  cleanup();
  upsertMutate.mockClear();
  deleteMutate.mockClear();
  mockState.config = baseConfig([]);
  mockState.imageGenSettings = undefined;
  mockState.videoGenSettings = undefined;
  mockRoute.search = "";
});

/**
 * Render the card when a deep-link search string is already set. Because
 * AiCostCard initialises its `open` state to `true` when both ?model= and
 * ?kind= are present, we must NOT click the toggle — doing so would close it.
 */
function renderCardWithSearch(search: string) {
  mockRoute.search = search;
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <AiCostCard />
    </QueryClientProvider>,
  );
}

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

describe("deep-link model highlight", () => {
  it("auto-expands so the targeted pricing row is visible without toggling the card", () => {
    mockState.config = baseConfig([
      price({ id: 8, model: "gpt-4o-mini", kind: "text", provider: "openrouter" }),
    ]);

    // Do not click the collapsible header: the deep-link itself must open the card.
    renderCardWithSearch("?model=gpt-4o-mini&kind=text");

    expect(screen.getByTestId("row-model-price-8")).toBeTruthy();
  });

  it("keeps pricing rows hidden while the card is collapsed without a deep-link", () => {
    mockState.config = baseConfig([
      price({ id: 9, model: "gpt-4o-mini", kind: "text", provider: "openrouter" }),
    ]);

    renderCardWithSearch("");

    expect(screen.queryByTestId("row-model-price-9")).toBeNull();
  });

  it("applies ring highlight only to the matching row when ?model= and ?kind= match", () => {
    mockState.config = baseConfig([
      price({ id: 10, model: "dall-e-3", kind: "image", provider: "openai",
               usdPerImage: 0.04, inputUsdPerMtok: null, outputUsdPerMtok: null }),
      price({ id: 11, model: "gpt-4o", kind: "text", provider: "openrouter" }),
    ]);

    renderCardWithSearch("?model=dall-e-3&kind=image");

    const targetRow = screen.getByTestId("row-model-price-10");
    const otherRow  = screen.getByTestId("row-model-price-11");

    // The matched row carries the ring highlight applied by AiCostCard.
    expect(targetRow.className).toContain("ring-1");
    expect(targetRow.className).toContain("ring-primary/30");

    // The unmatched sibling row must NOT carry the highlight.
    expect(otherRow.className).not.toContain("ring-1");
  });

  it("highlights case-insensitively so a URL-encoded model name still lands correctly", () => {
    mockState.config = baseConfig([
      price({ id: 20, model: "DALL-E-3", kind: "image", provider: "openai",
               usdPerImage: 0.04, inputUsdPerMtok: null, outputUsdPerMtok: null }),
    ]);

    // Deep-link uses lowercase; the catalog stores mixed-case — must still match.
    renderCardWithSearch("?model=dall-e-3&kind=image");

    const row = screen.getByTestId("row-model-price-20");
    expect(row.className).toContain("ring-1");
    expect(row.className).toContain("ring-primary/30");
  });

  it("uses the provider deep-link param to distinguish matching model rows", () => {
    mockState.config = baseConfig([
      price({ id: 21, model: "gemini-2.5-pro", kind: "text", provider: "Google" }),
      price({ id: 22, model: "gemini-2.5-pro", kind: "text", provider: "OpenRouter" }),
    ]);

    renderCardWithSearch("?model=gemini-2.5-pro&kind=text&provider=openrouter");

    const googleRow = screen.getByTestId("row-model-price-21");
    const openRouterRow = screen.getByTestId("row-model-price-22");

    expect(openRouterRow.className).toContain("ring-1");
    expect(openRouterRow.className).toContain("ring-primary/30");
    expect(googleRow.className).not.toContain("ring-1");
    expect(googleRow.className).not.toContain("ring-primary/30");
  });

  it("renders all rows normally without crashing when ?model= matches nothing", () => {
    mockState.config = baseConfig([
      price({ id: 30, model: "gpt-4o", kind: "text", provider: "openrouter" }),
      price({ id: 31, model: "gemini-2.5-flash", kind: "text", provider: "google" }),
    ]);

    // A stale deep-link (model was renamed after the alert fired).
    renderCardWithSearch("?model=old-model-name&kind=text");

    // Both rows must render — getByTestId throws if missing, so this
    // doubles as a crash-guard: a broken render would throw here.
    expect(screen.getByTestId("row-model-price-30")).toBeTruthy();
    expect(screen.getByTestId("row-model-price-31")).toBeTruthy();

    // Neither row should carry the highlight.
    expect(screen.getByTestId("row-model-price-30").className).not.toContain("ring-1");
    expect(screen.getByTestId("row-model-price-31").className).not.toContain("ring-1");
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
