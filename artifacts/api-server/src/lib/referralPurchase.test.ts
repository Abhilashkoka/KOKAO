import { beforeEach, afterEach, afterAll, describe, it, expect, vi } from "vitest";
import {
  db, pool, tenantsTable, promoCodesTable, promoRedemptionsTable,
  referralAttributionsTable, referralPurchaseGrantsTable,
  gamificationPlanSettingsTable, creditAccountsTable, creditAccountLedgerTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTenant, deleteTenant, getTenant } from "../test/dbHelpers";
import { getOrCreateReferralCode } from "./referrals";
import { redeemPromoCode } from "./promoCodes";
import { creditReferralForPurchase, referralCreditsMilli } from "./referralPurchase";
import * as accounts from "./creditAccounts";
import { getCreditPricePaise } from "./creditRates";
import * as flags from "./featureFlags";

let owner: number, buyer: number, plan: string, code: string;
let ids: number[] = [];
beforeEach(async () => {
  plan = `ref-purchase-test-${crypto.randomUUID()}`;
  owner = (await createTenant()).tenantId;
  buyer = (await createTenant()).tenantId;
  ids = [owner, buyer];
  await db.update(tenantsTable).set({ plan }).where(inArray(tenantsTable.id, ids));
  await db.insert(gamificationPlanSettingsTable).values({ planId: plan });
  code = (await getOrCreateReferralCode((await getTenant(owner))!)).code;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db.delete(referralPurchaseGrantsTable).where(inArray(referralPurchaseGrantsTable.tenantId, ids));
  await db.delete(referralAttributionsTable).where(inArray(referralAttributionsTable.tenantId, ids));
  await db.delete(promoRedemptionsTable).where(inArray(promoRedemptionsTable.tenantId, ids));
  await db.delete(promoCodesTable).where(inArray(promoCodesTable.ownerTenantId, ids));
  await db.delete(creditAccountLedgerTable).where(inArray(creditAccountLedgerTable.tenantId, ids));
  await db.delete(creditAccountsTable).where(inArray(creditAccountsTable.tenantId, ids));
  await db.delete(gamificationPlanSettingsTable).where(eq(gamificationPlanSettingsTable.planId, plan));
  for (const id of ids) await deleteTenant(id);
});
afterAll(async () => { await pool.end(); });
const purchase = (refId: string = crypto.randomUUID()) =>
  creditReferralForPurchase({ tenantId: buyer, kind: "credit_pack", refId, totalPaise: 45000 });
const receipts = () => db.select().from(referralPurchaseGrantsTable).where(eq(referralPurchaseGrantsTable.tenantId, buyer));
const attach = async () => {
  const result = await redeemPromoCode(buyer, code);
  expect(result.ok && result.attached).toBe(true);
  expect(result.ok && result.credits).toBe(0);
};

describe("purchase-based referrals (real database transactions)", () => {
  it("does nothing without attribution, when expired, and for plan purchases", async () => {
    expect((await purchase()).reason).toBe("no_attribution");
    await attach();
    expect((await creditReferralForPurchase({ tenantId: buyer, kind: "plan", refId: "excluded", totalPaise: 45000 })).reason).toBe("not_earning_kind");
    await db.update(referralAttributionsTable).set({ expiresAt: new Date(0) }).where(eq(referralAttributionsTable.tenantId, buyer));
    expect((await purchase()).reason).toBe("attribution_expired");
    expect(await receipts()).toHaveLength(0);
  });
  it("concurrent verify/webhook calls create exactly one receipt and one pair of grants", async () => {
    await attach();
    const ref = crypto.randomUUID();
    const results = await Promise.all([purchase(ref), purchase(ref), purchase(ref)]);
    expect(results.filter(r => r.granted)).toHaveLength(1);
    expect(await receipts()).toHaveLength(1);
    const ledger = await db.select().from(creditAccountLedgerTable).where(inArray(creditAccountLedgerTable.tenantId, ids));
    expect(ledger.filter(l => l.kind === "grant_promo")).toHaveLength(2);
    const expected = referralCreditsMilli(45000, 1000, await getCreditPricePaise()) / 1000;
    expect((await accounts.getCreditBalance(buyer)).total).toBe(expected);
    expect((await accounts.getCreditBalance(owner)).total).toBe(expected);
  });
  it("first_purchase serializes different simultaneous orders; every_purchase repeats", async () => {
    await attach();
    await db.update(gamificationPlanSettingsTable).set({ referralTriggerMode: "first_purchase" }).where(eq(gamificationPlanSettingsTable.planId, plan));
    expect((await Promise.all([purchase(), purchase()])).filter(r => r.granted)).toHaveLength(1);
    await db.update(gamificationPlanSettingsTable).set({ referralTriggerMode: "every_purchase" }).where(eq(gamificationPlanSettingsTable.planId, plan));
    expect((await Promise.all([purchase(), purchase()])).every(r => r.granted)).toBe(true);
    expect(await receipts()).toHaveLength(3);
  });
  it("fifth purchase uses first rung and sixth uses second, even for same buyer", async () => {
    await attach();
    for (let i = 0; i < 6; i++) expect((await purchase(`test-${buyer}-${i}`)).granted).toBe(true);
    const rows = (await receipts()).sort((a, b) => a.id - b.id);
    expect(rows[4]!.referrerBps).toBe(1000);
    expect(rows[5]!.referrerBps).toBe(1200);
    expect(rows[5]!.referralCountAtGrant).toBe(5);
  });
  it("disabled global or plan flags block attachment and payout", async () => {
    const realFlags = await flags.getFeatureFlags();
    const mock = vi.spyOn(flags, "getFeatureFlags").mockResolvedValue({ ...realFlags, referrals: false });
    expect((await redeemPromoCode(buyer, code)).ok).toBe(false);
    expect((await purchase()).reason).toBe("referrals_disabled");
    mock.mockRestore();
    await db.update(gamificationPlanSettingsTable).set({ referralsEnabled: false }).where(eq(gamificationPlanSettingsTable.planId, plan));
    expect((await redeemPromoCode(buyer, code)).ok).toBe(false);
    await db.update(gamificationPlanSettingsTable).set({ referralsEnabled: true }).where(eq(gamificationPlanSettingsTable.planId, plan));
    await attach();
    await db.update(gamificationPlanSettingsTable).set({ referralsEnabled: false }).where(eq(gamificationPlanSettingsTable.planId, plan));
    expect((await purchase()).reason).toBe("referrals_disabled");
  });
  it("both empty bonus buckets receive configured expiry", async () => {
    await attach();
    await db.update(gamificationPlanSettingsTable).set({ referralBonusExpiryDays: 12 }).where(eq(gamificationPlanSettingsTable.planId, plan));
    const start = Date.now();
    expect((await purchase()).granted).toBe(true);
    const rows = await db.select().from(creditAccountsTable).where(inArray(creditAccountsTable.tenantId, ids));
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(Math.abs(row.grantedExpiresAt!.getTime() - start - 12 * 86400000)).toBeLessThan(10000);
  });
  it("failed second grant rolls back first grant and receipt, allowing retry", async () => {
    await attach();
    const original = accounts.grantCredits;
    let calls = 0;
    const spy = vi.spyOn(accounts, "grantCredits").mockImplementation(async (...args) => {
      if (++calls === 2) throw new Error("test injected second grant failure");
      return original(...args);
    });
    const ref = crypto.randomUUID();
    expect((await purchase(ref)).reason).toBe("grant_failed");
    expect(await receipts()).toHaveLength(0);
    expect(await db.select().from(creditAccountLedgerTable).where(inArray(creditAccountLedgerTable.tenantId, ids))).toHaveLength(0);
    spy.mockRestore();
    expect((await purchase(ref)).granted).toBe(true);
  });
  it("first attribution cannot be stolen or renewed after expiry", async () => {
    await attach();
    const secondOwner = (await createTenant()).tenantId;
    ids.push(secondOwner);
    const other = await getOrCreateReferralCode((await getTenant(secondOwner))!);
    await db.update(referralAttributionsTable).set({ expiresAt: new Date(0) }).where(eq(referralAttributionsTable.tenantId, buyer));
    expect((await redeemPromoCode(buyer, other.code)).ok).toBe(false);
    const [row] = await db.select().from(referralAttributionsTable).where(eq(referralAttributionsTable.tenantId, buyer));
    expect(row!.ownerTenantId).toBe(owner);
  });
  it("validates integer money without overflow or fabricated credits", () => {
    expect(referralCreditsMilli(45000, 1000, 4500)).toBe(1000);
    expect(() => referralCreditsMilli(Number.MAX_SAFE_INTEGER, 1000, 4500)).toThrow();
    expect(() => referralCreditsMilli(45.5, 1000, 4500)).toThrow();
    expect(() => referralCreditsMilli(45000, 1000, 0)).toThrow();
  });
});