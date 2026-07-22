import {
  db,
  promoCodesTable,
  promoRedemptionsTable,
  type PromoCode,
  type Tenant,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { generatePromoCode } from "./promoCodes";
import { getPlanGamification } from "./gamification";

/**
 * Referral credits, built ON TOP of the promo-code engine rather than beside
 * it: a tenant's personal invite code IS a promo code (campaign "referral",
 * ownerTenantId set), so every existing guarantee — atomic redemption,
 * per-tenant limits, global caps, audience targeting, failure logging, admin
 * metrics — applies to referrals for free. The referrer's reward is granted
 * inside the same redemption transaction (see lib/promoCodes.ts).
 */

export const REFERRAL_CAMPAIGN = "referral";

/** New-account window for redeeming an invite (days since signup). */
const REFERRAL_NEW_TENANT_DAYS = 30;

export async function getReferralCode(tenantId: number): Promise<PromoCode | undefined> {
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
 * The tenant's personal invite code, minted on first ask. Referee amounts are
 * snapshotted onto the code from the owner's CURRENT plan settings (that is
 * how the promo engine grants), so later admin changes affect new codes, not
 * codes already in circulation.
 */
export async function getOrCreateReferralCode(tenant: Tenant): Promise<PromoCode> {
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
            audience: "new",
            newTenantDays: REFERRAL_NEW_TENANT_DAYS,
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
  redemptions: number;
  captionCreditsEarned: number;
  imageCreditsEarned: number;
}

/** How the tenant's invite code has performed (what THEY earned as referrer). */
export async function getReferralStats(tenantId: number): Promise<ReferralStats> {
  const row = (
    await db
      .select({
        redemptions: sql<number>`count(*)::int`,
        captionCreditsEarned: sql<number>`coalesce(sum(${promoRedemptionsTable.referrerCaptionCredits}), 0)::int`,
        imageCreditsEarned: sql<number>`coalesce(sum(${promoRedemptionsTable.referrerImageCredits}), 0)::int`,
      })
      .from(promoRedemptionsTable)
      .innerJoin(promoCodesTable, eq(promoRedemptionsTable.promoCodeId, promoCodesTable.id))
      .where(eq(promoCodesTable.ownerTenantId, tenantId))
  )[0];
  return {
    redemptions: row?.redemptions ?? 0,
    captionCreditsEarned: row?.captionCreditsEarned ?? 0,
    imageCreditsEarned: row?.imageCreditsEarned ?? 0,
  };
}
