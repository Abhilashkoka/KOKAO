import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const previewMutate = vi.fn();
const confirmMutate = vi.fn();
const toast = vi.fn();
const pendingPriceRows: Array<Record<string, unknown>> = [];

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../../test/apiClientMock");
  return createApiClientMock({
    useAdminPreviewAiModelPriceImport: () => ({
      mutate: previewMutate,
      isPending: false,
    }),
    useAdminConfirmAiModelPriceImport: () => ({
      mutate: confirmMutate,
      isPending: false,
    }),
    useAdminListWalletPendingPrices: () => ({ data: pendingPriceRows }),
  });
});

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast }),
}));

import { ModelPriceImportDialog } from "./model-price-import-dialog";

function renderDialog(
  overrides: Partial<React.ComponentProps<typeof ModelPriceImportDialog>> = {},
) {
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ModelPriceImportDialog
        open
        onOpenChange={onOpenChange}
        initialKind="video"
        initialProvider="replicate"
        initialModel="owner/model"
        enforceTarget
        {...overrides}
      />
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

beforeEach(() => {
  Object.defineProperties(HTMLElement.prototype, {
    hasPointerCapture: { configurable: true, value: () => false },
    setPointerCapture: { configurable: true, value: () => undefined },
    releasePointerCapture: { configurable: true, value: () => undefined },
    scrollIntoView: { configurable: true, value: () => undefined },
  });
  previewMutate.mockReset();
  confirmMutate.mockReset();
  toast.mockReset();
  pendingPriceRows.length = 0;
});

describe("ModelPriceImportDialog", () => {
  it("explains the additional official provider model docs", () => {
    renderDialog({ initialModel: null, initialProvider: null, enforceTarget: false });
    expect(screen.getByText(/OpenAI, or Google Gemini model page/i)).toBeTruthy();
    expect(
      (screen.getByTestId("input-import-price-url") as HTMLInputElement).placeholder,
    ).toBe("https://developers.openai.com/api/docs/models/gpt-image-1");
  });

  it("only offers used models that are missing a catalog price in the catalog picker", async () => {
    pendingPriceRows.push(
      {
        usageKind: "caption",
        provider: "openrouter",
        model: "used-model",
        chargeCount: 1,
        chargedPaise: 0,
        reason: "no_price",
        detail: "No price",
      },
      {
        usageKind: "video",
        provider: "replicate",
        model: "priced-model",
        chargeCount: 1,
        chargedPaise: 0,
        reason: "price_incomplete",
        detail: "Incomplete price",
      },
    );
    renderDialog({
      initialModel: null,
      initialProvider: null,
      enforceTarget: false,
      selectPendingTarget: true,
    });
    const user = userEvent.setup();

    expect((screen.getByTestId("input-import-price-url") as HTMLInputElement).disabled).toBe(true);
    await user.click(screen.getByTestId("select-import-price-target"));
    expect(await screen.findByText("openrouter · used-model (text)")).toBeTruthy();
    expect(screen.queryByText("replicate · priced-model (video)")).toBeNull();

    await user.click(screen.getByText("openrouter · used-model (text)"));
    expect((screen.getByTestId("input-import-price-url") as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByTestId("select-import-price-kind") as HTMLButtonElement).disabled).toBe(true);
  });

  it("previews a provider URL and saves the admin-reviewed amount", async () => {
    previewMutate.mockImplementation(
      (
        _variables: unknown,
        options?: { onSuccess?: (result: Record<string, unknown>) => void },
      ) =>
        options?.onSuccess?.({
          sourceUrl: "https://replicate.com/owner/model",
          provider: "replicate",
          model: "owner/model",
          kind: "video",
          inputUsdPerMtok: null,
          outputUsdPerMtok: null,
          usdPerImage: null,
          usdPerSecond: 0.4,
          usdPerVideo: null,
          warnings: [],
        }),
    );
    confirmMutate.mockImplementation(
      (_variables: unknown, options?: { onSuccess?: () => void }) =>
        options?.onSuccess?.(),
    );
    const { onOpenChange } = renderDialog();
    const user = userEvent.setup();

    await user.type(
      screen.getByTestId("input-import-price-url"),
      "https://replicate.com/owner/model",
    );
    await user.click(screen.getByTestId("button-preview-import-price"));

    await waitFor(() =>
      expect(screen.getByTestId("panel-import-price-preview")).toBeTruthy(),
    );
    expect(previewMutate.mock.calls[0][0]).toEqual({
      data: {
        sourceUrl: "https://replicate.com/owner/model",
        kind: "video",
      },
    });

    const secondPrice = screen.getByTestId("input-import-price-second");
    await user.clear(secondPrice);
    await user.type(secondPrice, "0.55");
    await user.click(screen.getByTestId("button-confirm-import-price"));

    await waitFor(() => expect(confirmMutate).toHaveBeenCalledTimes(1));
    expect(confirmMutate.mock.calls[0][0].data).toEqual({
      sourceUrl: "https://replicate.com/owner/model",
      provider: "replicate",
      model: "owner/model",
      kind: "video",
      inputUsdPerMtok: null,
      outputUsdPerMtok: null,
      usdPerImage: null,
      usdPerSecond: 0.55,
      usdPerVideo: null,
      variants: [],
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Model price imported" }),
    );
  });

  it("blocks confirmation when the URL belongs to a different pending model", async () => {
    previewMutate.mockImplementation(
      (
        _variables: unknown,
        options?: { onSuccess?: (result: Record<string, unknown>) => void },
      ) =>
        options?.onSuccess?.({
          sourceUrl: "https://replicate.com/owner/other-model",
          provider: "replicate",
          model: "owner/other-model",
          kind: "video",
          inputUsdPerMtok: null,
          outputUsdPerMtok: null,
          usdPerImage: null,
          usdPerSecond: 0.4,
          usdPerVideo: null,
          warnings: [],
        }),
    );
    renderDialog();
    const user = userEvent.setup();

    await user.type(
      screen.getByTestId("input-import-price-url"),
      "https://replicate.com/owner/other-model",
    );
    await user.click(screen.getByTestId("button-preview-import-price"));

    expect(await screen.findByTestId("text-import-price-mismatch")).toBeTruthy();
    expect(
      (screen.getByTestId("button-confirm-import-price") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(confirmMutate).not.toHaveBeenCalled();
  });

  it("blocks a same-slug URL from the wrong provider for a wallet target", async () => {
    previewMutate.mockImplementation(
      (
        _variables: unknown,
        options?: { onSuccess?: (result: Record<string, unknown>) => void },
      ) =>
        options?.onSuccess?.({
          sourceUrl: "https://openrouter.ai/owner/model",
          provider: "openrouter",
          model: "owner/model",
          kind: "video",
          inputUsdPerMtok: null,
          outputUsdPerMtok: null,
          usdPerImage: null,
          usdPerSecond: 0.4,
          usdPerVideo: null,
          warnings: [],
        }),
    );
    renderDialog();
    const user = userEvent.setup();

    await user.type(
      screen.getByTestId("input-import-price-url"),
      "https://openrouter.ai/owner/model",
    );
    await user.click(screen.getByTestId("button-preview-import-price"));

    expect(await screen.findByTestId("text-import-price-mismatch")).toBeTruthy();
    expect(
      (screen.getByTestId("button-confirm-import-price") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(confirmMutate).not.toHaveBeenCalled();
  });

  it("shows the API reason when an official page cannot be imported", async () => {
    const apiError = Object.assign(new Error("Request failed"), {
      data: { error: "Only official Replicate URLs are supported." },
    });
    previewMutate.mockImplementation(
      (_variables: unknown, options?: { onError?: (error: Error) => void }) =>
        options?.onError?.(apiError),
    );
    renderDialog({ initialModel: null, initialProvider: null, enforceTarget: false });
    const user = userEvent.setup();

    await user.type(
      screen.getByTestId("input-import-price-url"),
      "https://example.com/owner/model",
    );
    await user.click(screen.getByTestId("button-preview-import-price"));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Only official Replicate URLs are supported.",
    );
  });
});