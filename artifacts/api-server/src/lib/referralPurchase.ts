import { db, creatorAttributionsTable, referralAttributionsTable, referralPurchaseGrantsTable, tenantsTable, notificationsTable, type PromoCode } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { getFeatureFlags } from "./featureFlags";
import { getPlanGamification, type PlanGamification } from "./gamification";
import { grantCredits } from "./creditAccounts";
import { getCreditPricePaise, MILLI } from "./creditRates";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type ReferralTriggerMode = "first_purchase" | "every_purchase";
export interface ReferralSlab { minReferrals: number; referrerBps: number; refereeBps: number }
export const DEFAULT_REFERRAL_SLABS: ReferralSlab[] = [
  { minReferrals: 0, referrerBps: 1000, refereeBps: 1000 },
  { minReferrals: 5, referrerBps: 1200, refereeBps: 1000 },
  { minReferrals: 15, referrerBps: 1500, refereeBps: 1000 },
];
export function referralSlabsFor(settings: PlanGamification): ReferralSlab[] {
  const slabs = settings.referralSlabs ?? DEFAULT_REFERRAL_SLABS;
  if (!slabs.length || slabs.some((s, i) =>
    !Number.isSafeInteger(s.minReferrals) || s.minReferrals < 0 ||
    (i === 0 ? s.minReferrals !== 0 : s.minReferrals <= slabs[i - 1]!.minReferrals) ||
    [s.referrerBps, s.refereeBps].some(b => !Number.isSafeInteger(b) || b < 0 || b > 10000))) {
    throw new Error("Invalid referral slab configuration");
  }
  return slabs;
}
export const attributionDaysFor = (s: PlanGamification) => s.referralAttributionDays ?? 180;
export const bonusExpiryDaysFor = (s: PlanGamification) => s.referralBonusExpiryDays ?? 90;
export const triggerModeFor = (s: PlanGamification): ReferralTriggerMode =>
  s.referralTriggerMode === "first_purchase" ? "first_purchase" : "every_purchase";
export function pickSlab(slabs: ReferralSlab[], count: number) {
  let index = 0;
  for (let i = 0; i < slabs.length; i++) if (count >= slabs[i]!.minReferrals) index = i;
  return { slab: slabs[index]!, index };
}

/** First attribution wins permanently, including after its earning window expires. */
export async function attachReferralAttribution(tx: Tx, params: {
  tenantId: number; promo: PromoCode; attributionDays: number;
}): Promise<boolean> {
  await tx.execute(sql`select pg_advisory_xact_lock(73142, 1)`);
  const [creator] = await tx.select().from(creatorAttributionsTable)
    .where(eq(creatorAttributionsTable.tenantId, params.tenantId)).limit(1);
  if (creator) return false;
  const rows = await tx.insert(referralAttributionsTable).values({
    tenantId: params.tenantId, promoCodeId: params.promo.id,
    code: params.promo.code, ownerTenantId: params.promo.ownerTenantId,
    expiresAt: new Date(Date.now() + params.attributionDays * 86400000),
  }).onConflictDoNothing().returning({ id: referralAttributionsTable.tenantId });
  return rows.length > 0;
}

/** Integer paise rounding, then integer milli-credit rounding, without float overflow. */
export function referralCreditsMilli(totalPaise: number, bps: number, price: number): number {
  if (![totalPaise, bps, price].every(Number.isSafeInteger) ||
    totalPaise < 0 || totalPaise > 2147483647 || price <= 0 || price > 2147483647 ||
    bps < 0 || bps > 10000) throw new Error("Invalid referral monetary input");
  const paise = BigInt(totalPaise) * BigInt(bps) / 10000n;
  const milli = paise * BigInt(MILLI) / BigInt(price);
  if (milli > 2147483647n) throw new Error("Referral credit amount exceeds ledger capacity");
  return Number(milli);
}
export interface ReferralPurchaseParams { tenantId: number; kind: string; refId: string; totalPaise: number }
export interface ReferralPurchaseResult {
  granted: boolean; reason?: string; buyerCredits?: number; referrerCredits?: number; referrerTenantId?: number;
}

/**
 * Called only after verified paid purchase, outside payment transactions.
 * Receipt and both credit movements commit or roll back together.
 */
export async function creditReferralForPurchase(params: ReferralPurchaseParams): Promise<ReferralPurchaseResult> {
  try {
    if (!["credit_pack", "wallet_topup"].includes(params.kind)) return { granted: false, reason: "not_earning_kind" };
    if (!Number.isSafeInteger(params.totalPaise) || params.totalPaise <= 0 || params.totalPaise > 2147483647 || !params.refId)
      return { granted: false, reason: "invalid_amount" };
    const flags = await getFeatureFlags();
    if (!flags.referrals) return { granted: false, reason: "referrals_disabled" };
    const price = await getCreditPricePaise();
    const outcome = await db.transaction(async tx => {
      // Serialize referral rewards before any account locks. This makes reciprocal
      // referrals safe, serializes live slab selection and first_purchase checks.
      // Ordinary grants take only one account lock and cannot invert this order.
      await tx.execute(sql`select pg_advisory_xact_lock(73142, 1)`);
      const [a] = await tx.select().from(referralAttributionsTable)
        .where(eq(referralAttributionsTable.tenantId, params.tenantId)).for("update");
      if (!a || a.ownerTenantId === null) return { granted: false, reason: "no_attribution" };
      if (a.expiresAt && a.expiresAt <= new Date()) return { granted: false, reason: "attribution_expired" };
      if (a.ownerTenantId === params.tenantId) return { granted: false, reason: "self_referral" };
      const [owner] = await tx.select().from(tenantsTable).where(eq(tenantsTable.id, a.ownerTenantId));
      if (!owner) return { granted: false, reason: "no_attribution" };
      const settings = await getPlanGamification(owner.plan);
      if (!settings.referralsEnabled) return { granted: false, reason: "referrals_disabled" };
      if (triggerModeFor(settings) === "first_purchase" && a.grantCount > 0)
        return { granted: false, reason: "first_purchase_only" };
      const [count] = await tx.select({ n: sql<number>`count(*)::int` })
        .from(referralPurchaseGrantsTable).where(eq(referralPurchaseGrantsTable.ownerTenantId, a.ownerTenantId));
      const { slab, index } = pickSlab(referralSlabsFor(settings), count!.n);
      const buyer = referralCreditsMilli(params.totalPaise, slab.refereeBps, price);
      const referrer = referralCreditsMilli(params.totalPaise, slab.referrerBps, price);
      if (!buyer && !referrer) return { granted: false, reason: "zero_amount" };
      const [receipt] = await tx.insert(referralPurchaseGrantsTable).values({
        tenantId: params.tenantId, promoCodeId: a.promoCodeId, ownerTenantId: a.ownerTenantId,
        purchaseKind: params.kind, purchaseRefId: params.refId, grossPaise: params.totalPaise,
        creditPricePaise: price, buyerBonusBps: slab.refereeBps, referrerBps: slab.referrerBps,
        buyerBonusCreditsMilli: buyer, referrerRewardCreditsMilli: referrer,
        slabIndex: index, referralCountAtGrant: count!.n,
      }).onConflictDoNothing().returning({ id: referralPurchaseGrantsTable.id });
      if (!receipt) return { granted: false, reason: "already_granted" };
      for (const grant of [
        { tenantId: params.tenantId, milli: buyer, side: "buyer" },
        { tenantId: a.ownerTenantId, milli: referrer, side: "referrer" },
      ].sort((x, y) => x.tenantId - y.tenantId)) {
        if (grant.milli) await grantCredits({
          tenantId: grant.tenantId, credits: grant.milli / MILLI, kind: "grant_promo",
          expiresInDays: bonusExpiryDaysFor(settings),
          idempotencyKey: `referral-purchase:${receipt.id}:${grant.side}`,
          note: `Referral purchase reward (${a.code})`,
        }, tx);
      }
      await tx.update(referralAttributionsTable).set({
        grantCount: a.grantCount + 1, lastGrantAt: new Date(),
      }).where(eq(referralAttributionsTable.tenantId, params.tenantId));
      return { granted: true, buyerCredits: buyer / MILLI, referrerCredits: referrer / MILLI, referrerTenantId: a.ownerTenantId };
    });
    if (outcome.granted && outcome.referrerTenantId && outcome.referrerCredits) {
      try {
        await db.insert(notificationsTable).values({
          tenantId: outcome.referrerTenantId, type: "referral_purchase_reward",
          title: "You earned referral credits",
          message: `Someone you referred bought credits — ${outcome.referrerCredits} credits added to your balance.`,
          linkUrl: "/studio", inApp: true,
        });
      } catch (err) {
        logger.error({ err }, "Referral purchase notification failed");
      }
    }
    return outcome;
  } catch (err) {
    logger.error({ err, ...params }, "Referral purchase reward failed; payment unaffected");
    return { granted: false, reason: "grant_failed" };
  }
}

export async function getReferralPurchaseStats(ownerTenantId: number, plan: string) {
  const settings = await getPlanGamification(plan);
  const [[attributed], [totals]] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(referralAttributionsTable)
      .where(eq(referralAttributionsTable.ownerTenantId, ownerTenantId)),
    db.select({
      n: sql<number>`count(*)::int`,
      milli: sql<string>`coalesce(sum(${referralPurchaseGrantsTable.referrerRewardCreditsMilli}),0)::text`,
      gross: sql<string>`coalesce(sum(${referralPurchaseGrantsTable.grossPaise}),0)::text`,
    }).from(referralPurchaseGrantsTable).where(eq(referralPurchaseGrantsTable.ownerTenantId, ownerTenantId)),
  ]);
  const slabs = referralSlabsFor(settings);
  const { slab, index } = pickSlab(slabs, totals!.n);
  const next = slabs[index + 1];
  return {
    attributedWorkspaces: attributed!.n, qualifyingPurchases: totals!.n,
    creditsEarned: Number(totals!.milli) / MILLI, grossPaise: Number(totals!.gross),
    currentSlabIndex: index, currentReferrerBps: slab.referrerBps,
    nextSlabAt: next?.minReferrals ?? null, nextSlabBps: next?.referrerBps ?? null,
  };
}