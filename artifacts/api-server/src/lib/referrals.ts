import {
  db,
  promoCodesTable,
  promoRedemptionsTable,
  type PromoCode,
  type Tenant,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { generatePromoCode } from "./promoCodes";
import {
  getPlanGamification,
  legacyRewardToCreditsMilli,
} from "./gamification";
import { MILLI } from "./creditRates";
import { getReferralPurchaseStats } from "./referralPurchase";

/**
 * Referral credits, built ON TOP of the promo-code engine rather than beside
 * it: a tenant's personal invite code IS a promo code (campaign "referral",
 * ownerTenantId set), so every existing guarantee — atomic redemption,
 * per-tenant limits, global caps, audience targeting, failure logging, admin
 * metrics — applies to referrals for free. Redemption attaches the code;
 * eligible paid purchases award both sides (see lib/referralPurchase.ts).
 */

export const REFERRAL_CAMPAIGN = "referral";


export async function getReferralCode(
  tenantId: number,
): Promise<PromoCode | undefined> {
  return (
    await db
      .select()
      .from(promoCodesTable)
      .where(
        and(
          eq(promoCodesTable.ownerTenantId, tenantId),
          eq(promoCodesTable.campaign, REFERRAL_CAMPAIGN),
          eq(promoCodesTable.active, true),
        ),
      )
      .limit(1)
  )[0];
}

/**
 * The tenant's personal invite code, minted on first ask. Legacy amount fields
 * remain compatible with the promo schema but are not granted on redemption.
 * Purchase reward rates are resolved live from the owner's plan.
 */
export async function getOrCreateReferralCode(
  tenant: Tenant,
): Promise<PromoCode> {
  const existing = await getReferralCode(tenant.id);
  if (existing) return existing;

  const settings = await getPlanGamification(tenant.plan);
  // Concurrency-safe mint: the partial unique index (one active referral code
  // per owner) turns a racing duplicate insert into a no-op, and we re-select
  // the winner. Retries also cover the astronomically rare code collision.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const created = (
        await db
          .insert(promoCodesTable)
          .values({
            code: generatePromoCode("REF", 8),
            campaign: REFERRAL_CAMPAIGN,
            captionCredits: settings.refereeCaptionCredits,
            imageCredits: settings.refereeImageCredits,
            rewardCreditsMilli: settings.rewardCreditOverrides.referee ?? null,
            audience: "all",
            maxRedemptions: settings.referralMaxRedemptions,
            perTenantLimit: 1,
            active: true,
            ownerTenantId: tenant.id,
            note: `Personal referral code (workspace ${tenant.id})`,
          })
          .onConflictDoNothing()
          .returning()
      )[0];
      if (created) return created;
      // A concurrent request won the mint — return its code.
      const winner = await getReferralCode(tenant.id);
      if (winner) return winner;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
  throw new Error("Could not mint a referral code");
}

export interface ReferralStats {
  qualifyingPurchases: number;
  grossPaise: number;
  currentSlabIndex: number;
  currentReferrerBps: number;
  nextSlabAt: number | null;
  nextSlabBps: number | null;
  redemptions: number;
  captionCreditsEarned: number;
  imageCreditsEarned: number;
  /** Canonical credits earned by the referrer, including historical rows. */
  creditsEarned: number;
}

/** How the tenant's invite code has performed (what THEY earned as referrer). */
export async function getReferralStats(
  tenantId: number,
  plan: string,
): Promise<ReferralStats> {
  const purchases = await getReferralPurchaseStats(tenantId, plan);
  const rows = await db
    .select({
      redemptions: promoRedemptionsTable.id,
      captionCreditsEarned: promoRedemptionsTable.referrerCaptionCredits,
      imageCreditsEarned: promoRedemptionsTable.referrerImageCredits,
      creditsEarned: promoRedemptionsTable.referrerRewardCreditsMilli,
    })
    .from(promoRedemptionsTable)
    .innerJoin(
      promoCodesTable,
      eq(promoRedemptionsTable.promoCodeId, promoCodesTable.id),
    )
    .where(eq(promoCodesTable.ownerTenantId, tenantId));
  let creditsEarned = 0;
  for (const row of rows) {
    if (row.creditsEarned !== null && row.creditsEarned !== undefined) {
      creditsEarned += row.creditsEarned;
    } else {
      creditsEarned += await legacyRewardToCreditsMilli({
        captionCredits: row.captionCreditsEarned,
        imageCredits: row.imageCreditsEarned,
        videoCredits: 0,
      });
    }
  }
  return {
    ...purchases,
    redemptions: purchases.attributedWorkspaces,
    captionCreditsEarned: rows.reduce(
      (sum, row) => sum + row.captionCreditsEarned,
      0,
    ),
    imageCreditsEarned: rows.reduce(
      (sum, row) => sum + row.imageCreditsEarned,
      0,
    ),
    creditsEarned: creditsEarned / MILLI + purchases.creditsEarned,
  };
}
