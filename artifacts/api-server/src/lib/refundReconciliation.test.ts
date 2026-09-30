import { beforeEach, afterEach, afterAll, it, expect, vi } from "vitest";
import { db, pool, creatorAccountsTable as accounts, creatorCommissionsTable as commissions,
  creatorLedgerAdjustmentsTable as adjustments, creatorPayoutsTable as payouts, creatorPayoutIdentitiesTable as identities,
  refundReconciliationsTable as refunds, tenantPaymentInstrumentsTable as instruments,
  creatorAttributionsTable as attributions } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTenant, deleteTenant } from "../test/dbHelpers";
import { reconcileRefund, retryRefundReconciliations, refundCommissionTarget, type RefundEvent } from "./refundReconciliation";
import { capturePaymentInstrument, payoutMatchesOwnReferrals } from "./paymentInstruments";
import { hashPii, clawbackPaidCommission, buildPayoutRun, saveCreatorPayoutIdentity } from "./creatorPayouts";
import * as settingsApi from "./creatorProgram";
import * as flags from "./featureFlags";
import { reconcileRazorpayRefund, reconcileCashfreeRefund, captureRazorpayInstrument } from "./gatewayRefunds";
const gateway = vi.hoisted(() => ({ order: vi.fn(), request: vi.fn(), cfOrder: vi.fn(), cfRefund: vi.fn(), cfPayments: vi.fn() }));
vi.mock("./razorpay", async importOriginal => ({ ...await importOriginal<typeof import("./razorpay")>(),
  fetchRazorpayOrder: gateway.order, razorpayRequest: gateway.request }));
vi.mock("./cashfree", async importOriginal => ({ ...await importOriginal<typeof import("./cashfree")>(),
  getCashfreeOrder: gateway.cfOrder, getCashfreeRefund: gateway.cfRefund, getCashfreePayments: gateway.cfPayments }));

let tenantId: number, creatorId: number, refId: string;
beforeEach(async () => {
  ({ tenantId } = await createTenant());
  const [c] = await db.insert(accounts).values({ tenantId, displayName: "Refund fixture", contactEmail: `refund-${tenantId}@example.test`, status: "approved" }).returning();
  creatorId = c!.id; refId = `refund-fixture-${tenantId}`;
  vi.stubEnv("CREATOR_PII_PEPPER", "synthetic-test-pepper-only-012345678901234567890");
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await db.delete(refunds).where(eq(refunds.tenantId, tenantId));
  await db.delete(instruments).where(eq(instruments.tenantId, tenantId));
  await db.delete(attributions).where(eq(attributions.tenantId, tenantId));
  await db.delete(adjustments).where(eq(adjustments.creatorId, creatorId));
  await db.delete(commissions).where(eq(commissions.creatorId, creatorId));
  await db.delete(payouts).where(eq(payouts.creatorId, creatorId));
  await db.delete(identities).where(eq(identities.creatorId, creatorId));
  await db.delete(accounts).where(eq(accounts.id, creatorId));
  await deleteTenant(tenantId);
});
afterAll(async () => { await pool.end(); });
const event = (refundId = "one", refundedPaise = 3000): RefundEvent => ({
  gateway: "razorpay", refundId: `${refId}-${refundId}`, tenantId, kind: "credit_pack", refId, refundedPaise, purchasePaise: 10000,
});
async function commission(state = "payable") {
  return (await db.insert(commissions).values({ creatorId, creatorCodeId: 0, tenantId,
    purchaseKind: "credit_pack", purchaseRefId: refId, grossPaise: 10000, netPaise: 10000,
    commissionPaise: 1000, commissionBps: 1000, state }).returning())[0]!;
}
async function row() { return (await db.select().from(commissions).where(eq(commissions.purchaseRefId, refId)))[0]!; }
it("deduplicates simultaneous partial refunds and clamps cumulative over-refunds", async () => {
  await commission();
  await Promise.all([reconcileRefund(event()), reconcileRefund(event())]);
  expect(await row()).toMatchObject({ state: "payable", commissionPaise: 700, refundedPaise: 3000 });
  await reconcileRefund(event("two", 3000));
  expect(await row()).toMatchObject({ commissionPaise: 400, netPaise: 4000 });
  await reconcileRefund(event("three", 9000));
  expect(await row()).toMatchObject({ state: "reversed", commissionPaise: 0, netPaise: 0, refundedCommissionPaise: 1000 });
  expect(await db.select().from(refunds).where(eq(refunds.tenantId, tenantId))).toHaveLength(3);
});
it("uses cumulative integer rounding, not separately rounded deltas", async () => {
  expect(refundCommissionTarget(333, 5000, 10000)).toBe(166);
  expect(refundCommissionTarget(333, 10000, 10000)).toBe(333);
});
it("retains refund tombstone before delayed accrual and retries it", async () => {
  expect((await reconcileRefund(event("full", 10000))).commissionFound).toBe(false);
  await commission("held");
  await retryRefundReconciliations(refId);
  expect(await row()).toMatchObject({ state: "reversed", commissionPaise: 0 });
});
it("retains durable manual review while batch is in flight; retry after failure reduces residual", async () => {
  const c = await commission("in_payout");
  expect((await reconcileRefund(event())).commissionAction).toBe("needs_manual_review");
  expect((await row()).commissionPaise).toBe(1000);
  expect((await db.select().from(refunds).where(eq(refunds.refId, refId)))[0]!.status).toBe("needs_manual_review");
  await db.update(commissions).set({ state: "payable" }).where(eq(commissions.id, c.id));
  await retryRefundReconciliations(refId);
  expect(await row()).toMatchObject({ state: "payable", commissionPaise: 700 });
});
it("paid partial refunds absorb reserves then debt exactly once; full admin clawback takes only remainder", async () => {
  const c = await commission("paid");
  const [p] = await db.insert(payouts).values({ creatorId, grossPaise: 1000, reserveHeldPaise: 200, netPaise: 800,
    tdsPaise: 0, tdsRateBps: 0, status: "paid", paidAt: new Date() }).returning();
  await db.update(commissions).set({ payoutId: p!.id }).where(eq(commissions.id, c.id));
  await Promise.all([reconcileRefund(event()), reconcileRefund(event())]);
  expect((await db.select().from(payouts).where(eq(payouts.id, p!.id)))[0]!.reserveConsumedPaise).toBe(200);
  let entries = await db.select().from(adjustments).where(eq(adjustments.creatorId, creatorId));
  expect(entries.reduce((s, r) => s + r.amountPaise, 0)).toBe(-100);
  expect(await clawbackPaidCommission(c.id, "Remaining purchase charged back")).toMatchObject({ amountPaise: 700 });
  entries = await db.select().from(adjustments).where(eq(adjustments.creatorId, creatorId));
  expect(entries.reduce((s, r) => s + r.amountPaise, 0)).toBe(-800);
});
it("rejects a conflicting duplicate refund ID without corrupting accepted accounting", async () => {
  await commission(); await reconcileRefund(event());
  expect((await reconcileRefund({ ...event(), refundedPaise: 9000 })).retryable).toBe(true);
  expect((await row()).commissionPaise).toBe(700);
});
it("flags binding mismatch and leaves commission untouched", async () => {
  await commission();
  expect((await reconcileRefund({ ...event(), purchasePaise: 10001 })).commissionAction).toBe("needs_manual_review");
  expect((await row()).commissionPaise).toBe(1000);
});
it("captures only stable identities; last4 alone cannot match a payout destination", async () => {
  expect(await capturePaymentInstrument({ tenantId, gateway: "razorpay", cardLast4: "1234" })).toEqual({ status: "no_identifier" });
  await capturePaymentInstrument({ tenantId, gateway: "razorpay", vpa: "  Fixture@Bank " });
  await capturePaymentInstrument({ tenantId, gateway: "razorpay", vpa: "fixture@bank" });
  const rows = await db.select().from(instruments).where(eq(instruments.tenantId, tenantId));
  expect(rows).toHaveLength(1); expect(rows[0]!.bankAccountHash).toBeNull();
  expect(JSON.stringify(rows)).not.toContain("fixture@bank");
  expect(await payoutMatchesOwnReferrals(creatorId, hashPii("123456781234|TEST0123456"))).toMatchObject({ matched: false, comparable: false });
});
it("compares actual normalized bank identities only, flags not blocks", async () => {
  await db.insert(attributions).values({ tenantId, creatorId, creatorCodeId: 0, code: "TEST" });
  await capturePaymentInstrument({ tenantId, gateway: "razorpay", bankAccountNumber: "1234 5678 1234", bankIfsc: "test0123456" });
  expect(await payoutMatchesOwnReferrals(creatorId, hashPii("123456781234|TEST0123456"))).toMatchObject({ matched: true, comparable: true, tenantIds: [tenantId] });
  expect(await payoutMatchesOwnReferrals(creatorId, hashPii("999956781234|TEST0123456"))).toMatchObject({ matched: false, comparable: true });
});
it("missing pepper is explicit unavailable and stores nothing", async () => {
  vi.stubEnv("CREATOR_PII_PEPPER", "");
  expect(await capturePaymentInstrument({ tenantId, gateway: "cashfree", vpa: "fixture@bank" })).toEqual({ status: "unavailable" });
  expect(await db.select().from(instruments).where(eq(instruments.tenantId, tenantId))).toHaveLength(0);
});
it("canonical Razorpay processed refund alone reconciles; tampered payment binding is refused", async () => {
  await commission();
  const refund = { id: `${refId}-r`, payment_id: "pay-fixture", status: "pending", amount: 3000, currency: "INR" };
  gateway.request.mockImplementation(async (path: string) => path.startsWith("/refunds/") ? refund :
    { id: "pay-fixture", order_id: refId, status: "refunded", amount: 10000, currency: "INR" });
  gateway.order.mockResolvedValue({ id: refId, status: "paid", amount: 10000, currency: "INR", notes: { tenantId: String(tenantId), purpose: "credit_pack" } });
  await reconcileRazorpayRefund(refund.id);
  expect((await row()).commissionPaise).toBe(1000);
  refund.status = "processed";
  await reconcileRazorpayRefund(refund.id); await reconcileRazorpayRefund(refund.id);
  expect((await row()).commissionPaise).toBe(700);
  gateway.order.mockResolvedValue({ id: "wrong-order", status: "paid", amount: 10000, currency: "INR" });
  await expect(reconcileRazorpayRefund(refund.id)).rejects.toThrow("binding");
});
it("canonical Cashfree SUCCESS with matching original order/payment reconciles only once", async () => {
  await commission();
  const refund = { refund_id: `${refId}-cf`, order_id: refId, refund_status: "PENDING", refund_amount: 30, cf_payment_id: 123 };
  gateway.cfRefund.mockResolvedValue(refund);
  gateway.cfOrder.mockResolvedValue({ order_id: refId, order_status: "PAID", order_currency: "INR", order_amount: 100,
    order_tags: { tenantId: String(tenantId), purpose: "credit_pack" } });
  gateway.cfPayments.mockResolvedValue([{ order_id: refId, cf_payment_id: 123, payment_status: "SUCCESS", payment_currency: "INR", payment_amount: 100 }]);
  await reconcileCashfreeRefund(refId, refund.refund_id);
  expect((await row()).commissionPaise).toBe(1000);
  refund.refund_status = "SUCCESS";
  await reconcileCashfreeRefund(refId, refund.refund_id); await reconcileCashfreeRefund(refId, refund.refund_id);
  expect((await row()).commissionPaise).toBe(700);
  gateway.cfPayments.mockResolvedValue([{ order_id: refId, cf_payment_id: 999, payment_status: "SUCCESS", payment_currency: "INR", payment_amount: 100 }]);
  await expect(reconcileCashfreeRefund(refId, refund.refund_id)).rejects.toThrow("binding");
});
it("only canonically captured matching payments contribute instruments", async () => {
  gateway.request.mockResolvedValue({ id: "pay", order_id: "wrong", status: "captured", amount: 10000, currency: "INR", vpa: "fixture@bank" });
  await captureRazorpayInstrument(tenantId, refId, "pay", 10000);
  expect(await db.select().from(instruments).where(eq(instruments.tenantId, tenantId))).toHaveLength(0);
  gateway.request.mockResolvedValue({ id: "pay", order_id: refId, status: "captured", amount: 10000, currency: "INR", vpa: "fixture@bank" });
  await captureRazorpayInstrument(tenantId, refId, "pay", 10000);
  expect(await db.select().from(instruments).where(eq(instruments.tenantId, tenantId))).toHaveLength(1);
});
it("a refund racing the first payout either reduces the batch or leaves durable in-flight review", async () => {
  vi.spyOn(settingsApi.creatorSettingsAccess, "get").mockResolvedValue({ ...await settingsApi.getCreatorProgramSettings(), programEnabled: true, minPayoutPaise: 1 });
  vi.spyOn(flags, "getFeatureFlags").mockResolvedValue({ ...await flags.getFeatureFlags(), creatorProgram: true });
  await commission();
  await saveCreatorPayoutIdentity({ creatorId, pan: "ABCDE1234F", accountNumber: "123456781234", ifsc: "TEST0123456", beneficiaryName: "Synthetic fixture" });
  await Promise.all([buildPayoutRun(undefined, undefined, [creatorId]), reconcileRefund(event())]);
  const c = await row();
  const [receipt] = await db.select().from(refunds).where(eq(refunds.refId, refId));
  if (c.state === "in_payout" && c.commissionPaise === 1000) expect(receipt!.status).toBe("needs_manual_review");
  else expect(c.commissionPaise).toBe(700);
});
it("accounting failure retains a payout-blocking receipt and retry settles it", async () => {
  vi.spyOn(settingsApi.creatorSettingsAccess, "get").mockResolvedValue({ ...await settingsApi.getCreatorProgramSettings(), programEnabled: true, minPayoutPaise: 1 });
  vi.spyOn(flags, "getFeatureFlags").mockResolvedValue({ ...await flags.getFeatureFlags(), creatorProgram: true });
  await commission();
  const originalTransaction = db.transaction.bind(db);
  let calls = 0;
  const spy = vi.spyOn(db, "transaction").mockImplementation((...args) => {
    if (++calls === 2) return Promise.reject(new Error("synthetic accounting outage"));
    return originalTransaction(...args);
  });
  expect((await reconcileRefund(event())).commissionAction).toBe("needs_manual_review");
  spy.mockRestore();
  expect((await buildPayoutRun(undefined, undefined, [creatorId])).skipped).toEqual([{ creatorId, reason: "refund reconciliation pending" }]);
  expect((await row()).commissionPaise).toBe(1000);
  await retryRefundReconciliations(refId);
  expect((await row()).commissionPaise).toBe(700);
});
it("a second refund after partial reversal and payout claws back only the new proportional delta", async () => {
  const c = await commission();
  await reconcileRefund(event("before", 3000));
  await db.update(commissions).set({ state: "paid" }).where(eq(commissions.id, c.id));
  await reconcileRefund(event("after", 2000));
  const entries = await db.select().from(adjustments).where(eq(adjustments.creatorId, creatorId));
  expect(entries.reduce((s, r) => s + r.amountPaise, 0)).toBe(-200);
  expect(await row()).toMatchObject({ commissionPaise: 700, refundedCommissionPaise: 500, refundedPaise: 5000 });
  expect(await clawbackPaidCommission(c.id, "Rest refunded")).toMatchObject({ amountPaise: 500 });
});