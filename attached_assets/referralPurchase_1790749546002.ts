import {
  db,
  promoCodesTable,
  referralAttributionsTable,
  referralPurchaseGrantsTable,
  tenantsTable,
  notificationsTable,
  type PromoCode,
  type ReferralAttribution,
} from "@workspace/db";
import { and, eq, isNull, or, sql, gt } from "drizzle-orm";
import { logger } from "./logger";
import { getFeatureFlags } from "./featureFlags";
import { getPlanGamification, type PlanGamification } from "./gamification";
import { grantCredits } from "./creditAccounts";
import { getCreditPricePaise, MILLI } from "./creditRates";

/**
 * Program A: referral rewards on CREDIT PURCHASE.
 *
 * Entering a referral code attaches it to the workspace (see
 * `attachReferralAttribution`, called from the redemption engine). Nothing is
 * granted at that moment. When the workspace later completes a real payment,
 * `creditReferralForPurchase` pays both sides as a PERCENTAGE of what was paid.
 *
 * Idempotency: the unique (purchaseKind, purchaseRefId) index on
 * referral_purchase_grants means the verify route and the webhook backstop can
 * both call this for the same payment and only one grant happens.
 *
 * Slabs: the referrer's rate is resolved LIVE against their current referral
 * count, so crossing a slab improves the next payout. The buyer's bonus rate is
 * read from the attribution's owner plan at purchase time. Both are then frozen
 * onto the grant row.
 */

/** Trigger modes an admin can pick per plan. */
export type ReferralTriggerMode = "first_purchase" | "every_purchase";

/** Purchase kinds that earn a referral reward. Plan renewals do not. */
const EARNING_PURCHASE_KINDS = new Set(["credit_pack", "wallet_topup"]);

export interface ReferralSlab {
  /** Qualifying referrals needed to reach this rung. */
  minReferrals: number;
  /** Referrer's cut of the purchase, in basis points (1000 = 10%). */
  referrerBps: number;
  /** Buyer's bonus credits, in basis points of the purchase. */
  refereeBps: number;
}

export const DEFAULT_REFERRAL_SLABS: ReadonlyArray<ReferralSlab> = [
  { minReferrals: 0, referrerBps: 1000, refereeBps: 1000 },
  { minReferrals: 5, referrerBps: 1200, refereeBps: 1000 },
  { minReferrals: 15, referrerBps: 1500, refereeBps: 1000 },
];

export const DEFAULT_ATTRIBUTION_DAYS = 180;
export const DEFAULT_BONUS_EXPIRY_DAYS = 90;
export const DEFAULT_TRIGGER_MODE: ReferralTriggerMode = "every_purchase";

function normalizeSlabs(raw: unknown): ReferralSlab[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [...DEFAULT_REFERRAL_SLABS];
  }
  const cleaned = raw
    .filter(
      (s): s is ReferralSlab =>
        !!s &&
        typeof s === "object" &&
        Number.isFinite((s as ReferralSlab).minReferrals) &&
        Number.isFinite((s as ReferralSlab).referrerBps),
    )
    .map((s) => ({
      minReferrals: Math.max(0, Math.floor(s.minReferrals)),
      referrerBps: Math.max(0, Math.min(10_000, Math.floor(s.referrerBps))),
      refereeBps: Math.max(
        0,
        Math.min(10_000, Math.floor(s.refereeBps ?? 0)),
      ),
    }))
    .sort((a, b) => a.minReferrals - b.minReferrals);
  return cleaned.length > 0 ? cleaned : [...DEFAULT_REFERRAL_SLABS];
}

/** Settings helpers — tolerant of rows written before these columns existed. */
export function referralSlabsFor(settings: PlanGamification): ReferralSlab[] {
  return normalizeSlabs(
    (settings as PlanGamification & { referralSlabs?: unknown }).referralSlabs,
  );
}

export function attributionDaysFor(settings: PlanGamification): number {
  const v = (settings as PlanGamification & { referralAttributionDays?: number })
    .referralAttributionDays;
  return Number.isFinite(v) && (v as number) > 0
    ? Math.floor(v as number)
    : DEFAULT_ATTRIBUTION_DAYS;
}

export function bonusExpiryDaysFor(settings: PlanGamification): number {
  const v = (settings as PlanGamification & { referralBonusExpiryDays?: number })
    .referralBonusExpiryDays;
  return Number.isFinite(v) && (v as number) > 0
    ? Math.floor(v as number)
    : DEFAULT_BONUS_EXPIRY_DAYS;
}

export function triggerModeFor(
  settings: PlanGamification,
): ReferralTriggerMode {
  const v = (settings as PlanGamification & {
    referralTriggerMode?: string;
  }).referralTriggerMode;
  return v === "first_purchase" ? "first_purchase" : DEFAULT_TRIGGER_MODE;
}

/** How many purchases this referrer has already been paid for. */
export async function countQualifyingReferrals(
  ownerTenantId: number,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(referralPurchaseGrantsTable)
    .where(eq(referralPurchaseGrantsTable.ownerTenantId, ownerTenantId));
  return row?.count ?? 0;
}

export interface ResolvedSlab {
  slab: ReferralSlab;
  index: number;
  referralCount: number;
}

/**
 * The rung a referrer currently sits on. Highest `minReferrals` that their
 * count reaches; falls back to the first rung.
 */
export function pickSlab(
  slabs: ReferralSlab[],
  referralCount: number,
): { slab: ReferralSlab; index: number } {
  let index = 0;
  for (let i = 0; i < slabs.length; i++) {
    if (referralCount >= slabs[i]!.minReferrals) index = i;
  }
  return { slab: slabs[index]!, index };
}

export async function resolveReferrerSlab(
  ownerTenantId: number,
  settings: PlanGamification,
): Promise<ResolvedSlab> {
  const slabs = referralSlabsFor(settings);
  const referralCount = await countQualifyingReferrals(ownerTenantId);
  const { slab, index } = pickSlab(slabs, referralCount);
  return { slab, index, referralCount };
}

// ---------------------------------------------------------------------------
// Attaching a code
// ---------------------------------------------------------------------------

/**
 * Attach a referral code to a workspace. Called from the redemption engine
 * INSIDE its transaction, in place of granting credits.
 *
 * First code wins: `onConflictDoNothing` on the tenant primary key means a
 * second code entered later does not steal an existing attribution. The
 * redemption row is still written either way, so the attempt is auditable.
 */
export async function attachReferralAttribution(
  tx: typeof db,
  params: {
    tenantId: number;
    promo: PromoCode;
    attributionDays: number;
  },
): Promise<void> {
  const expiresAt = new Date(
    Date.now() + params.attributionDays * 24 * 60 * 60 * 1000,
  );
  await tx
    .insert(referralAttributionsTable)
    .values({
      tenantId: params.tenantId,
      promoCodeId: params.promo.id,
      code: params.promo.code,
      ownerTenantId: params.promo.ownerTenantId,
      expiresAt,
    })
    .onConflictDoNothing({ target: referralAttributionsTable.tenantId });
}

/** The live attribution for a workspace, or null when there is none/expired. */
export async function getActiveAttribution(
  tenantId: number,
): Promise<ReferralAttribution | null> {
  const now = new Date();
  const [row] = await db
    .select()
    .from(referralAttributionsTable)
    .where(
      and(
        eq(referralAttributionsTable.tenantId, tenantId),
        or(
          isNull(referralAttributionsTable.expiresAt),
          gt(referralAttributionsTable.expiresAt, now),
        ),
      ),
    )
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Paying on purchase
// ---------------------------------------------------------------------------

export interface ReferralPurchaseParams {
  tenantId: number;
  /** invoices.kind — only credit_pack / wallet_topup earn. */
  kind: string;
  /** Gateway order/subscription reference. Idempotency key with kind. */
  refId: string;
  /** What was actually paid, in paise. */
  totalPaise: number;
}

export interface ReferralPurchaseResult {
  granted: boolean;
  reason?:
    | "not_earning_kind"
    | "no_attribution"
    | "attribution_expired"
    | "referrals_disabled"
    | "first_purchase_only"
    | "self_referral"
    | "zero_amount"
    | "already_granted";
  buyerCredits?: number;
  referrerCredits?: number;
  referrerTenantId?: number | null;
}

function creditsMilliFromPaise(paise: number, pricePaise: number): number {
  if (pricePaise <= 0) return 0;
  return Math.max(0, Math.floor((paise * MILLI) / pricePaise));
}

/**
 * Pay the referral reward for a completed purchase. Safe to call more than
 * once for the same (kind, refId) — the second call is a no-op.
 *
 * Best-effort by contract: the money has already moved, so a failure here is
 * logged and swallowed. Never let this throw into a payment path.
 */
export async function creditReferralForPurchase(
  params: ReferralPurchaseParams,
): Promise<ReferralPurchaseResult> {
  try {
    if (!EARNING_PURCHASE_KINDS.has(params.kind)) {
      return { granted: false, reason: "not_earning_kind" };
    }
    if (!Number.isFinite(params.totalPaise) || params.totalPaise <= 0) {
      return { granted: false, reason: "zero_amount" };
    }

    const attribution = await getActiveAttribution(params.tenantId);
    if (!attribution) return { granted: false, reason: "no_attribution" };
    if (attribution.ownerTenantId === null) {
      return { granted: false, reason: "no_attribution" };
    }
    // Belt and braces — the redemption engine already refuses own-code entry.
    if (attribution.ownerTenantId === params.tenantId) {
      return { granted: false, reason: "self_referral" };
    }

    const [owner] = await db
      .select()
      .from(tenantsTable)
      .where(eq(tenantsTable.id, attribution.ownerTenantId))
      .limit(1);
    if (!owner) return { granted: false, reason: "no_attribution" };

    const [flags, settings] = await Promise.all([
      getFeatureFlags(),
      getPlanGamification(owner.plan),
    ]);
    if (!flags.referrals || !settings.referralsEnabled) {
      return { granted: false, reason: "referrals_disabled" };
    }

    if (
      triggerModeFor(settings) === "first_purchase" &&
      attribution.grantCount > 0
    ) {
      return { granted: false, reason: "first_purchase_only" };
    }

    const { slab, index, referralCount } = await resolveReferrerSlab(
      attribution.ownerTenantId,
      settings,
    );
    const creditPricePaise = await getCreditPricePaise();
    const expiresInDays = bonusExpiryDaysFor(settings);

    const buyerBonusMilli = creditsMilliFromPaise(
      Math.floor((params.totalPaise * slab.refereeBps) / 10_000),
      creditPricePaise,
    );
    const referrerMilli = creditsMilliFromPaise(
      Math.floor((params.totalPaise * slab.referrerBps) / 10_000),
      creditPricePaise,
    );

    if (buyerBonusMilli <= 0 && referrerMilli <= 0) {
      return { granted: false, reason: "zero_amount" };
    }

    const outcome = await db.transaction(async (tx) => {
      // The unique (kind, refId) index decides the race. A loser gets nothing.
      const inserted = (
        await tx
          .insert(referralPurchaseGrantsTable)
          .values({
            tenantId: params.tenantId,
            promoCodeId: attribution.promoCodeId,
            ownerTenantId: attribution.ownerTenantId,
            purchaseKind: params.kind,
            purchaseRefId: params.refId,
            grossPaise: params.totalPaise,
            creditPricePaise,
            buyerBonusBps: slab.refereeBps,
            referrerBps: slab.referrerBps,
            buyerBonusCreditsMilli: buyerBonusMilli,
            referrerRewardCreditsMilli: referrerMilli,
            slabIndex: index,
            referralCountAtGrant: referralCount,
          })
          .onConflictDoNothing({
            target: [
              referralPurchaseGrantsTable.purchaseKind,
              referralPurchaseGrantsTable.purchaseRefId,
            ],
          })
          .returning({ id: referralPurchaseGrantsTable.id })
      )[0];
      if (!inserted) return null; // already granted by a concurrent path

      if (buyerBonusMilli > 0) {
        await grantCredits(
          {
            tenantId: params.tenantId,
            credits: buyerBonusMilli / MILLI,
            kind: "grant_promo",
            expiresInDays,
            idempotencyKey: `referral-purchase:${inserted.id}:buyer`,
            note: `Referral bonus on purchase (code ${attribution.code})`,
          },
          tx,
        );
      }
      if (referrerMilli > 0) {
        await grantCredits(
          {
            tenantId: attribution.ownerTenantId!,
            credits: referrerMilli / MILLI,
            kind: "grant_promo",
            expiresInDays,
            idempotencyKey: `referral-purchase:${inserted.id}:referrer`,
            note: `Referral reward — ${attribution.code} purchase`,
          },
          tx,
        );
      }

      await tx
        .update(referralAttributionsTable)
        .set({
          grantCount: attribution.grantCount + 1,
          lastGrantAt: new Date(),
        })
        .where(eq(referralAttributionsTable.tenantId, params.tenantId));

      return inserted.id;
    });

    if (outcome === null) {
      return { granted: false, reason: "already_granted" };
    }

    // Best-effort nudge. A notification failure never affects the grant.
    if (referrerMilli > 0) {
      try {
        await db.insert(notificationsTable).values({
          tenantId: attribution.ownerTenantId,
          type: "referral_purchase_reward",
          title: "You earned referral credits",
          message: `Someone you referred bought credits — ${referrerMilli / MILLI} credits added to your balance.`,
          linkUrl: "/studio",
          inApp: true,
        });
      } catch (err) {
        logger.error({ err }, "referral purchase notification failed");
      }
    }

    return {
      granted: true,
      buyerCredits: buyerBonusMilli / MILLI,
      referrerCredits: referrerMilli / MILLI,
      referrerTenantId: attribution.ownerTenantId,
    };
  } catch (err) {
    logger.error(
      { err, kind: params.kind, refId: params.refId, tenantId: params.tenantId },
      "referral purchase reward failed (payment unaffected)",
    );
    return { granted: false };
  }
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export interface ReferralPurchaseStats {
  /** Workspaces currently attributed to this referrer. */
  attributedWorkspaces: number;
  /** Purchases that paid out. */
  qualifyingPurchases: number;
  /** Credits earned from purchase rewards. */
  creditsEarned: number;
  /** Gross rupees (in paise) driven through this referrer's code. */
  grossPaise: number;
  currentSlabIndex: number;
  currentReferrerBps: number;
  nextSlabAt: number | null;
  nextSlabBps: number | null;
}

export async function getReferralPurchaseStats(
  ownerTenantId: number,
  ownerPlan: string,
): Promise<ReferralPurchaseStats> {
  const settings = await getPlanGamification(ownerPlan);
  const slabs = referralSlabsFor(settings);

  const [[attributed], [totals]] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(referralAttributionsTable)
      .where(eq(referralAttributionsTable.ownerTenantId, ownerTenantId)),
    db
      .select({
        purchases: sql<number>`count(*)::int`,
        creditsMilli: sql<number>`coalesce(sum(${referralPurchaseGrantsTable.referrerRewardCreditsMilli}), 0)::int`,
        grossPaise: sql<number>`coalesce(sum(${referralPurchaseGrantsTable.grossPaise}), 0)::bigint`,
      })
      .from(referralPurchaseGrantsTable)
      .where(eq(referralPurchaseGrantsTable.ownerTenantId, ownerTenantId)),
  ]);

  const count = totals?.purchases ?? 0;
  const { slab, index } = pickSlab(slabs, count);
  const next = slabs[index + 1] ?? null;

  return {
    attributedWorkspaces: attributed?.count ?? 0,
    qualifyingPurchases: count,
    creditsEarned: (totals?.creditsMilli ?? 0) / MILLI,
    grossPaise: Number(totals?.grossPaise ?? 0),
    currentSlabIndex: index,
    currentReferrerBps: slab.referrerBps,
    nextSlabAt: next ? next.minReferrals : null,
    nextSlabBps: next ? next.referrerBps : null,
  };
}
