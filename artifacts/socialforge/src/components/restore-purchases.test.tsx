import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RestorePurchasesCard } from "./restore-purchases";
import {
  forgetPendingPayment,
  listPendingPayments,
  rememberPendingPayment,
} from "@/lib/pending-payments";

const state = vi.hoisted(() => ({
  verifyPurchase: vi.fn(),
  verifySubscription: vi.fn(),
}));
vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useBillingVerifyPurchase: () => ({ mutate: state.verifyPurchase, isPending: false }),
    useBillingVerifySubscription: () => ({ mutate: state.verifySubscription, isPending: false }),
  });
});

beforeEach(() => {
  window.localStorage.clear();
  state.verifyPurchase.mockReset();
  state.verifySubscription.mockReset();
});

it("remembers, de-duplicates and forgets unfinished payments", () => {
  rememberPendingPayment("pack", "order_1", "Starter pack");
  rememberPendingPayment("pack", "order_1", "Starter pack");
  rememberPendingPayment("subscription", "sub_1", "Pro subscription");
  expect(listPendingPayments().map((p) => p.id)).toEqual(["order_1", "sub_1"]);
  forgetPendingPayment("pack", "order_1");
  expect(listPendingPayments().map((p) => p.id)).toEqual(["sub_1"]);
});

it("survives blocked browser storage", () => {
  const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  expect(listPendingPayments()).toEqual([]);
  spy.mockRestore();
});

it("re-runs the server verify for a remembered payment and clears it on success", () => {
  rememberPendingPayment("pack", "order_9", "Growth pack");
  const onRestored = vi.fn();
  state.verifyPurchase.mockImplementation((_vars, opts) => opts.onSuccess());
  render(<RestorePurchasesCard onRestored={onRestored} />);
  fireEvent.click(screen.getByTestId("button-restore-order_9"));
  expect(state.verifyPurchase).toHaveBeenCalledWith(
    { data: { cashfreeOrderId: "order_9" } },
    expect.anything(),
  );
  expect(onRestored).toHaveBeenCalled();
  expect(listPendingPayments()).toEqual([]);
});

it("checks a subscription through the subscription verify", () => {
  rememberPendingPayment("subscription", "sub_7", "Pro subscription");
  render(<RestorePurchasesCard onRestored={() => {}} />);
  fireEvent.click(screen.getByTestId("button-restore-sub_7"));
  expect(state.verifySubscription).toHaveBeenCalledWith(
    { data: { cashfreeSubscriptionId: "sub_7" } },
    expect.anything(),
  );
});

it("restores a pack from an order id typed in by hand", () => {
  render(<RestorePurchasesCard onRestored={() => {}} />);
  fireEvent.change(screen.getByTestId("input-restore-order-id"), {
    target: { value: "  order_manual  " },
  });
  fireEvent.click(screen.getByTestId("button-restore-order"));
  expect(state.verifyPurchase).toHaveBeenCalledWith(
    { data: { cashfreeOrderId: "order_manual" } },
    expect.anything(),
  );
});
