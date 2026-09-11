import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  db,
  pool,
  tenantsTable,
  promoCodesTable,
  promoRedemptionsTable,
  notificationsTable,
  gamificationPlanSettingsTable,
  creditAccountsTable,
  creditAccountLedgerTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { getOrCreateReferralCode, getReferralCode, getReferralStats } from "./referrals";
import { redeemPromoCode } from "./promoCodes";
import { getCreditBalance } from "./creditAccounts";
import { getCreditBalances as getLegacyCreditBalances } from "./credits";
import { creditsMilliFor, MILLI } from "./creditRates";
import { createTenant, deleteTenant, getTenant } from "../test/dbHelpers";

/** Unique per-run plan id so settings rows can never collide with real plans. */
const TEST_PLAN = `ref-test-${Date.now()}`;

let referrerId: number;
let refereeId: number;

beforeAll(async () => {
  referrerId = (await createTenant()).tenantId;
  refereeId = (await createTenant()).tenantId;
  await db
    .update(tenantsTable)
    .set({ plan: TEST_PLAN })
    .where(inArray(tenantsTable.id, [referrerId, refereeId]));
});

afterAll(async () => {
  const codes = await db
    .select({ id: promoCodesTable.id })
    .from(promoCodesTable)
    .where(eq(promoCodesTable.ownerTenantId, referrerId));
  if (codes.length) {
    await db.delete(promoRedemptionsTable).where(
      inArray(
        promoRedemptionsTable.promoCodeId,
        codes.map((c) => c.id),
      ),
    );
  }
  await db.delete(promoCodesTable).where(eq(promoCodesTable.ownerTenantId, referrerId));
  await db
    .delete(gamificationPlanSettingsTable)
    .where(eq(gamificationPlanSettingsTable.planId, TEST_PLAN));
  await db
    .delete(creditAccountLedgerTable)
    .where(inArray(creditAccountLedgerTable.tenantId, [referrerId, refereeId]));
  await db
    .delete(creditAccountsTable)
    .where(inArray(creditAccountsTable.tenantId, [referrerId, refereeId]));
  await deleteTenant(referrerId);
  await deleteTenant(refereeId);
  await pool.end();
});

describe("referral codes", () => {
  it("mints one personal code per workspace, idempotently", async () => {
    const referrer = (await getTenant(referrerId))!;
    const first = await getOrCreateReferralCode(referrer);
    expect(first.code.startsWith("REF-")).toBe(true);
    expect(first.ownerTenantId).toBe(referrerId);
    expect(first.campaign).toBe("referral");
    // Default referee amounts from the plan defaults.
    expect(first.captionCredits).toBe(5);
    expect(first.imageCredits).toBe(3);

    const second = await getOrCreateReferralCode(referrer);
    expect(second.id).toBe(first.id);
  });

  it("blocks self-redemption", async () => {
    const code = (await getReferralCode(referrerId))!;
    const result = await redeemPromoCode(referrerId, code.code);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("own_code");
  });

  it("pays the referee from the code and the referrer from their plan settings", async () => {
    const code = (await getReferralCode(referrerId))!;
    const refereeBefore = await getCreditBalance(refereeId);
    const referrerBefore = await getCreditBalance(referrerId);
    const refereeLegacyBefore = await getLegacyCreditBalances(refereeId);
    const referrerLegacyBefore = await getLegacyCreditBalances(referrerId);
    const expectedCredits =
      ((await creditsMilliFor("caption", 5))! +
        (await creditsMilliFor("image", 3))!) /
      MILLI;

    const result = await redeemPromoCode(refereeId, code.code);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.referrerTenantId).toBe(referrerId);
    expect(result.referrerCaptionCredits).toBe(5);
    expect(result.referrerImageCredits).toBe(3);
    expect(result.credits).toBe(expectedCredits);
    expect(result.referrerCredits).toBe(expectedCredits);

    const refereeAfter = await getCreditBalance(refereeId);
    expect(refereeAfter.total).toBe(refereeBefore.total + expectedCredits);
    expect(await getLegacyCreditBalances(refereeId)).toEqual(refereeLegacyBefore);

    const referrerAfter = await getCreditBalance(referrerId);
    expect(referrerAfter.total).toBe(referrerBefore.total + expectedCredits);
    expect(await getLegacyCreditBalances(referrerId)).toEqual(
      referrerLegacyBefore,
    );

    const stats = await getReferralStats(referrerId);
    expect(stats.redemptions).toBe(1);
    expect(stats.captionCreditsEarned).toBe(5);
    expect(stats.imageCreditsEarned).toBe(3);
    expect(stats.creditsEarned).toBe(expectedCredits);

    // The referrer got an in-app heads-up.
    const notes = await db
      .select()
      .from(notificationsTable)
      .where(eq(notificationsTable.tenantId, referrerId));
    expect(notes.some((n) => n.type === "referral_redeemed")).toBe(true);

    // One redemption per workspace: a second attempt is rejected.
    const again = await redeemPromoCode(refereeId, code.code);
    expect(again.ok).toBe(false);
  });

  it("rejects redemption entirely when referrals are disabled for the owner's plan", async () => {
    await db.insert(gamificationPlanSettingsTable).values({
      planId: TEST_PLAN,
      referralsEnabled: false,
    });
    const extraRedeemer = await createTenant();
    try {
      const code = (await getReferralCode(referrerId))!;
      const referrerBefore = await getCreditBalance(referrerId);
      const redeemerBefore = await getCreditBalance(extraRedeemer.tenantId);
      const result = await redeemPromoCode(extraRedeemer.tenantId, code.code);
      // The kill switch stops the WHOLE redemption — no referee credits, no
      // referrer reward — so disabling referrals ends all credit liability.
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("referrals_disabled");
      expect((await getCreditBalance(extraRedeemer.tenantId)).total).toBe(
        redeemerBefore.total,
      );
      expect((await getCreditBalance(referrerId)).total).toBe(
        referrerBefore.total,
      );
    } finally {
      await db
        .delete(creditAccountLedgerTable)
        .where(eq(creditAccountLedgerTable.tenantId, extraRedeemer.tenantId));
      await db
        .delete(creditAccountsTable)
        .where(eq(creditAccountsTable.tenantId, extraRedeemer.tenantId));
      await deleteTenant(extraRedeemer.tenantId);
    }
  });
});
