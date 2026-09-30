import { beforeEach, afterEach, afterAll, describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import {
  db, pool, tenantsTable, promoCodesTable, promoRedemptionsTable,
  referralAttributionsTable, referralPurchaseGrantsTable, creditAccountsTable,
  creditAccountLedgerTable, razorpayEventsTable, cashfreeEventsTable,
  walletLedgerTable, walletBalancesTable, creditPacksTable, creditLedgerTable, creditBalancesTable,
} from "@workspace/db";
import { eq, inArray, like } from "drizzle-orm";
import { createTenant, deleteTenant, getTenant } from "../test/dbHelpers";
import { getOrCreateReferralCode } from "../lib/referrals";
import { redeemPromoCode } from "../lib/promoCodes";
import * as accounts from "../lib/creditAccounts";

const mocks = vi.hoisted(() => ({ razorOrder: vi.fn(), cashOrder: vi.fn(), invoice: vi.fn() }));
vi.mock("../lib/razorpay", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/razorpay")>(),
  fetchRazorpayOrder: mocks.razorOrder, verifyWebhookSignature: vi.fn(async () => true),
}));
vi.mock("../lib/cashfree", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/cashfree")>(),
  getCashfreeOrder: mocks.cashOrder, verifyCashfreeWebhookSignature: vi.fn(async () => true),
}));
// Exercise the real referral transaction, without mutating the shared invoice
// numbering singleton or issuing email. The dedicated invoice suite tests it.
vi.mock("../lib/invoices", async () => {
  const { creditReferralForPurchase } = await import("../lib/referralPurchase");
  return { recordInvoice: mocks.invoice.mockImplementation(creditReferralForPurchase) };
});
vi.mock("../lib/analytics", () => ({ recordServerEvent: vi.fn(async () => {}) }));
import razorRouter from "./razorpayWebhook";
import cashRouter from "./cashfreeWebhook";

const app = express();
app.use(express.json({ verify(req, _res, buf) { (req as any).rawBody = buf.toString(); } }));
app.use((req, _res, next) => {
  (req as any).log = { info() {}, warn() {}, error() {}, debug() {} };
  next();
});
app.use(razorRouter, cashRouter);
let owner: number, buyer: number, prefix: string, packId: number;
beforeEach(async () => {
  prefix = `test-refhook-${crypto.randomUUID()}`;
  owner = (await createTenant()).tenantId;
  buyer = (await createTenant()).tenantId;
  await db.update(tenantsTable).set({ plan: prefix }).where(inArray(tenantsTable.id, [owner, buyer]));
  const code = await getOrCreateReferralCode((await getTenant(owner))!);
  expect((await redeemPromoCode(buyer, code.code)).ok).toBe(true);
  const [pack] = await db.insert(creditPacksTable).values({
    name: prefix, pricePaise: 45000, captionCredits: 10, imageCredits: 5,
  }).returning();
  packId = pack!.id;
  mocks.invoice.mockClear();
});
afterEach(async () => {
  vi.restoreAllMocks();
  const ids = [owner, buyer];
  await db.delete(referralPurchaseGrantsTable).where(inArray(referralPurchaseGrantsTable.tenantId, ids));
  await db.delete(referralAttributionsTable).where(inArray(referralAttributionsTable.tenantId, ids));
  await db.delete(promoRedemptionsTable).where(inArray(promoRedemptionsTable.tenantId, ids));
  await db.delete(promoCodesTable).where(inArray(promoCodesTable.ownerTenantId, ids));
  await db.delete(creditAccountLedgerTable).where(inArray(creditAccountLedgerTable.tenantId, ids));
  await db.delete(creditAccountsTable).where(inArray(creditAccountsTable.tenantId, ids));
  await db.delete(creditLedgerTable).where(inArray(creditLedgerTable.tenantId, ids));
  await db.delete(creditBalancesTable).where(inArray(creditBalancesTable.tenantId, ids));
  await db.delete(walletLedgerTable).where(inArray(walletLedgerTable.tenantId, ids));
  await db.delete(walletBalancesTable).where(inArray(walletBalancesTable.tenantId, ids));
  await db.delete(creditPacksTable).where(eq(creditPacksTable.id, packId));
  await db.delete(razorpayEventsTable).where(like(razorpayEventsTable.id, `${prefix}%`));
  await db.delete(cashfreeEventsTable).where(like(cashfreeEventsTable.id, `%${prefix}%`));
  await deleteTenant(owner);
  await deleteTenant(buyer);
});
afterAll(async () => { await pool.end(); });

function post(gateway: string, purpose: string, refund = false) {
  const orderId = `${prefix}-${purpose}`;
  if (gateway === "razorpay") return request(app).post("/billing/razorpay-webhook")
    .set("x-razorpay-event-id", `${prefix}-${purpose}-${refund ? "refund" : "paid"}`)
    .send({ event: refund ? "refund.processed" : "payment.captured",
      payload: { payment: { entity: { order_id: orderId } } } });
  return request(app).post("/billing/cashfree-webhook").send({
    type: refund ? "REFUND_STATUS_WEBHOOK" : "PAYMENT_SUCCESS_WEBHOOK",
    event_time: prefix, data: { order: { order_id: orderId }, payment: { cf_payment_id: prefix } },
  });
}
function canonical(gateway: string, purpose: string, amount = 45000, paid = true) {
  const notes = { purpose, tenantId: String(buyer), creditPackId: String(packId),
    basePaise: "37500", gstPaise: "7500", gstPercent: "20" };
  if (gateway === "razorpay") mocks.razorOrder.mockResolvedValue({
    id: `${prefix}-${purpose}`, amount, currency: "INR", status: paid ? "paid" : "attempted", notes,
  });
  else mocks.cashOrder.mockResolvedValue({
    order_id: `${prefix}-${purpose}`, order_amount: amount / 100,
    order_status: paid ? "PAID" : "ACTIVE", order_tags: notes,
  });
}
describe("paid referral webhook recovery", () => {
  for (const gateway of ["razorpay", "cashfree"]) for (const purpose of ["credit_pack", "wallet_topup"]) {
    it(`${gateway} ${purpose}: same-event replay recovers failed reward and remains exactly once; refunds do not award`, async () => {
      canonical(gateway, purpose);
      const originalGrant = accounts.grantCredits;
      const spy = vi.spyOn(accounts, "grantCredits").mockImplementation(async (...args) => {
        if (args[0].kind === "grant_promo") throw new Error("test referral outage");
        return originalGrant(...args);
      });
      expect((await post(gateway, purpose)).status).toBe(200);
      spy.mockRestore();
      const rows = () => db.select().from(referralPurchaseGrantsTable).where(eq(referralPurchaseGrantsTable.tenantId, buyer));
      expect(await rows()).toHaveLength(0);
      expect((await post(gateway, purpose)).status).toBe(200);
      expect(await rows()).toHaveLength(1);
      expect((await post(gateway, purpose)).body.duplicate).toBe(true);
      expect(await rows()).toHaveLength(1);
      const calls = mocks.invoice.mock.calls.length;
      expect((await post(gateway, purpose, true)).status).toBe(200);
      expect(mocks.invoice).toHaveBeenCalledTimes(calls);
      expect(await rows()).toHaveLength(1);
    });
  }
  it("Razorpay wallet rejects unpaid and mismatched canonical order despite captured payload", async () => {
    canonical("razorpay", "wallet_topup", 45000, false);
    await post("razorpay", "wallet_topup");
    canonical("razorpay", "wallet_topup", 100);
    await post("razorpay", "wallet_topup");
    expect(mocks.invoice).not.toHaveBeenCalled();
    expect(await db.select().from(walletLedgerTable).where(eq(walletLedgerTable.tenantId, buyer))).toHaveLength(0);
  });
});