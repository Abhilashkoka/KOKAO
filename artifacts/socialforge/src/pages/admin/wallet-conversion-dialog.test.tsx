import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const state = vi.hoisted(() => ({
  preview: {
    data: { walletPaise: 10501, creditPricePaise: 1000, credits: 10.501, canConvert: true, reason: null as string | null },
    isLoading: false, isError: false, isFetching: false, error: null,
    refetch: vi.fn(),
  },
  mutateAsync: vi.fn(),
  pending: false,
  toast: vi.fn(),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: state.toast }) }));
vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../../test/apiClientMock");
  return createApiClientMock({
    useAdminPreviewWalletConversion: () => state.preview,
    useAdminConvertWalletToCredits: () => ({ mutateAsync: state.mutateAsync, isPending: state.pending }),
  });
});
import { WalletConversionDialog } from "./wallet-conversion-dialog";

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const close = vi.fn();
  render(<QueryClientProvider client={client}>
    <WalletConversionDialog tenant={{ id: 42, name: "Example workspace" }} onClose={close} />
  </QueryClientProvider>);
  return { close, invalidate };
}

describe("wallet conversion confirmation", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    state.pending = false;
    state.preview.isError = false;
    state.preview.isFetching = false;
    state.preview.data = { walletPaise: 10501, creditPricePaise: 1000, credits: 10.501, canConvert: true, reason: null };
    state.mutateAsync.mockResolvedValue({ walletPaiseConverted: 10501, creditsAdded: 10.501, remainingWalletPaise: 0 });
  });

  it("automatically previews the saved rate without moving money until confirmation", async () => {
    const { close, invalidate } = show();
    expect(screen.getByText("₹10.00 per credit")).toBeTruthy();
    expect(screen.getByTestId("text-wallet-conversion-credits").textContent).toBe("10.501");
    expect(state.mutateAsync).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm conversion" }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(state.mutateAsync).toHaveBeenCalledWith({
      id: 42, data: { expectedWalletPaise: 10501, expectedCreditPricePaise: 1000, idempotencyKey: expect.any(String) },
    });
    expect(invalidate).toHaveBeenCalled();
    expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Wallet converted" }));
  });

  it("cancels without changing either balance", () => {
    const { close } = show();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(close).toHaveBeenCalledOnce();
    expect(state.mutateAsync).not.toHaveBeenCalled();
  });

  it("blocks conversion while wallet work is unsettled", () => {
    state.preview.data.canConvert = false;
    state.preview.data.reason = "Wallet-funded work is still unsettled.";
    show();
    expect(screen.getByRole("alert").textContent).toContain("unsettled");
    expect((screen.getByRole("button", { name: "Confirm conversion" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps the dialog open and safely reuses the receipt key after a lost response", async () => {
    state.mutateAsync.mockRejectedValueOnce(new Error("Connection interrupted"));
    const { close } = show();
    fireEvent.click(screen.getByRole("button", { name: "Confirm conversion" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(close).not.toHaveBeenCalled();
    expect(state.preview.refetch).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm conversion" }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(state.mutateAsync.mock.calls[1][0].data.idempotencyKey).toBe(state.mutateAsync.mock.calls[0][0].data.idempotencyKey);
  });
});