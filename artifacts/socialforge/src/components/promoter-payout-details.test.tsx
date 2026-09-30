import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@workspace/api-client-react";
import { PromoterPayoutDetails } from "./promoter-payout-details";

const mock = vi.hoisted(() => ({
  details: { isLoading: false, isError: false, data: { onFile: false } } as Record<string, unknown>,
  history: { isLoading: false, isError: false, data: { payouts: [], balance: { owedBack: 0 } } } as Record<string, unknown>,
  mutate: vi.fn(), invalidate: vi.fn(), toast: vi.fn(),
}));
vi.mock("@workspace/api-client-react", async original => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  const actual = await original<typeof import("@workspace/api-client-react")>();
  return createApiClientMock({
    ApiError: actual.ApiError,
    useGetPromoterPayoutDetails: () => mock.details,
    useGetPromoterPayouts: () => mock.history,
    useSavePromoterPayoutDetails: () => ({ mutate: mock.mutate, isPending: false }),
  });
});
vi.mock("@tanstack/react-query", async original => ({
  ...await original<typeof import("@tanstack/react-query")>(),
  useQueryClient: () => ({ invalidateQueries: mock.invalidate }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mock.toast }) }));
beforeEach(() => {
  mock.details = { isLoading: false, isError: false, data: { onFile: false } };
  mock.history = { isLoading: false, isError: false, data: { payouts: [], balance: { owedBack: 0 } } };
  mock.mutate.mockReset();
  mock.invalidate.mockReset();
  mock.toast.mockReset();
});
afterEach(cleanup);
describe("promoter payout details", () => {
  it("does not prefill raw identity and clears all sensitive inputs on success", () => {
    render(<PromoterPayoutDetails />);
    const name = screen.getByTestId("input-beneficiary-name") as HTMLInputElement;
    const pan = screen.getByTestId("input-pan") as HTMLInputElement;
    const bank = screen.getByTestId("input-account-number") as HTMLInputElement;
    expect([name.value, pan.value, bank.value]).toEqual(["", "", ""]);
    fireEvent.change(name, { target: { value: "A User" } });
    fireEvent.change(pan, { target: { value: "ABCDE1234F" } });
    fireEvent.change(bank, { target: { value: "123456789" } });
    fireEvent.change(screen.getByTestId("input-ifsc"), { target: { value: "ABCD0123456" } });
    fireEvent.click(screen.getByTestId("button-save-payout-details"));
    expect(mock.mutate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ pan: "ABCDE1234F", accountNumber: "123456789" }) }), expect.any(Object));
    act(() => mock.mutate.mock.calls[0][1].onSuccess());
    expect([name.value, pan.value, bank.value]).toEqual(["", "", ""]);
    expect(mock.invalidate).toHaveBeenCalledTimes(2);
  });
  it("shows recoverable pepper error, keeps input for retry, and never renders raw account on file", () => {
    const { rerender } = render(<PromoterPayoutDetails />);
    fireEvent.change(screen.getByTestId("input-beneficiary-name"), { target: { value: "A User" } });
    fireEvent.change(screen.getByTestId("input-pan"), { target: { value: "ABCDE1234F" } });
    fireEvent.change(screen.getByTestId("input-account-number"), { target: { value: "123456789" } });
    fireEvent.change(screen.getByTestId("input-ifsc"), { target: { value: "ABCD0123456" } });
    fireEvent.click(screen.getByTestId("button-save-payout-details"));
    act(() => mock.mutate.mock.calls[0][1].onError(new ApiError(
      new Response(null, { status: 503 }), { error: "Payout details aren't configured.", code: "pii_not_configured" },
      { method: "POST", url: "/api/promoter/payout-details" },
    )));
    expect((screen.getByTestId("input-pan") as HTMLInputElement).value).toBe("ABCDE1234F");
    expect(mock.toast).toHaveBeenCalledWith(expect.objectContaining({ description: "Payout details aren't configured." }));
    mock.details = { isLoading: false, isError: false, data: { onFile: true, bankLast4: "6789", panLast4: "234F", beneficiaryName: "A User", ifsc: "ABCD0123456", verified: false, panHash: "NEVER_RENDER", accountNumber: "123456789" } };
    rerender(<PromoterPayoutDetails />);
    expect(screen.getByTestId("payout-details-on-file").textContent).toBe("A User");
    expect(screen.queryByText(/NEVER_RENDER|123456789/)).toBeNull();
  });
  it("shows history but never allows edits on suspended accounts", () => {
    mock.history = { isLoading: false, isError: false, data: { payouts: [{ id: 1, gross: 100, tds: 2, reserveHeld: 10, net: 88, status: "paid" }], balance: { owedBack: 50 } } };
    render(<PromoterPayoutDetails suspended />);
    expect(screen.getByTestId("payout-1")).toBeTruthy();
    expect(screen.queryByTestId("input-pan")).toBeNull();
    expect(screen.getByText(/adjustment carried forward/)).toBeTruthy();
  });
});