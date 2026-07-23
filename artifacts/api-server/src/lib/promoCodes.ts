import { randomBytes } from "node:crypto";
import {
  db,
  promoCodesTable,
  promoRedemptionsTable,
  promoRedemptionFailuresTable,
  creditBalancesTable,
  creditLedgerTable,
  tenantsTable,
  notificationsTable,
  type PromoCode,
} from "@workspace/db";
import { eq, and, sql, desc } from "drizzle-orm";
import { logger } from "./logger";
import { getFeatureFlags } from "./featureFlags";
import { getPlanGamification } from "./gamification";

/**
 * Promo code redemption engine.
 *
 * All eligibility checks and the credit grant happen inside ONE transaction
 * that holds SELECT ... FOR UPDATE on the promo row, so concurrent submits
 * (double-click, scripted replays, two devices) serialize per code and can
 * never oversubscribe a capped code, exceed a per-workspace limit, or credit
 * the same success twice.
 */

export type RedeemFailureReason =
  | "invalid_code"
  | "inactive"
  | "not_started"
  | "expired"
  | "plan_not_allowed"
  | "audience_new_only"
  | "audience_existing_only"
  | "global_limit_reached"
  | "per_tenant_limit_reached"
  | "own_code"
  | "referrals_disabled";

export type RedeemResult =
  | {
      ok: true;
      captionCredits: number;
      imageCredits: number;
      videoCredits: number;
      /** Referral codes only: who earned the referrer reward, and how much. */
      referrerTenantId: number | null;
      referrerCaptionCredits: number;
      referrerImageCredits: number;
      message: string;
    }
  | { ok: false; reason: RedeemFailureReason; message: string };

/** Uppercase, trimmed; the only form codes are stored and matched in. */
export function normalizePromoCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/** Unambiguous alphabet (no 0/O/1/I/L) for auto-generated codes. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generatePromoCode(prefix?: string, length = 10): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  const cleanPrefix = prefix ? normalizePromoCode(prefix).replace(/[^A-Z0-9_-]/g, "") : "";
  return cleanPrefix ? `${cleanPrefix}-${out}` : out;
}

function failureMessage(reason: RedeemFailureReason, promo?: PromoCode): string {
  switch (reason) {
    case "invalid_code":
      return "That code is not valid. Check the spelling and try again.";
    case "inactive":
      return "This code is no longer active.";
    case "not_started":
      return "This code is not active yet.";
    case "expired":
      return "This code has expired.";
    case "plan_not_allowed": {
      const plans = promo?.allowedPlans?.filter(Boolean) ?? [];
      return plans.length > 0
        ? `This code is only valid for the ${plans.join(", ")} plan${plans.length > 1 ? "s" : ""}.`
        : "This code is not valid for your current plan.";
    }
    case "audience_new_only":
      return "This code is only valid for new accounts.";
    case "audience_existing_only":
      return "This code is only valid for existing accounts.";
    case "global_limit_reached":
      return "This code has reached its maximum number of redemptions.";
    case "per_tenant_limit_reached":
      return "You have already redeemed this code.";
    case "own_code":
      return "You can't redeem your own referral code — share it with a friend instead.";
    case "referrals_disabled":
      return "Referral codes are currently disabled.";
  }
}

/** "a", "a and b", or "a, b, and c" — for the redeem success message. */
function formatCreditParts(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "credits";
  if (parts.length === 2) return parts.join(" and ");
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

/** Best-effort rejected-attempt log; never blocks or fails the request. */
async function recordFailure(tenantId: number, code: string, reason: string): Promise<void> {
  try {
    await db.insert(promoRedemptionFailuresTable).values({ tenantId, code, reason });
  } catch (error) {
    logger.error({ err: error }, "Failed to record promo redemption failure");
  }
}

export async function redeemPromoCode(
  tenantId: number,
  rawCode: string,
): Promise<RedeemResult> {
  const code = normalizePromoCode(rawCode);
  if (!code || code.length > 64) {
    await recordFailure(tenantId, code.slice(0, 64) || "(empty)", "invalid_code");
    return { ok: false, reason: "invalid_code", message: failureMessage("invalid_code") };
  }

  const result = await db.transaction(async (tx): Promise<RedeemResult> => {
    // Lock the promo row: all checks below stay true until commit.
    const promo = (
      await tx
        .select()
        .from(promoCodesTable)
        .where(eq(promoCodesTable.code, code))
        .for("update")
    )[0];
    if (!promo) {
      return { ok: false, reason: "invalid_code", message: failureMessage("invalid_code") };
    }

    const now = new Date();
    if (!promo.active) {
      return { ok: false, reason: "inactive", message: failureMessage("inactive") };
    }
    if (promo.startsAt && promo.startsAt > now) {
      return { ok: false, reason: "not_started", message: failureMessage("not_started") };
    }
    if (promo.expiresAt && promo.expiresAt <= now) {
      return { ok: false, reason: "expired", message: failureMessage("expired") };
    }
    if (
      promo.maxRedemptions !== null &&
      promo.redemptionCount >= promo.maxRedemptions
    ) {
      return {
        ok: false,
        reason: "global_limit_reached",
        message: failureMessage("global_limit_reached"),
      };
    }

    const tenant = (
      await tx.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId)).limit(1)
    )[0];
    if (!tenant) {
      return { ok: false, reason: "invalid_code", message: failureMessage("invalid_code") };
    }

    // Referral codes cannot be self-redeemed.
    if (promo.ownerTenantId !== null && promo.ownerTenantId === tenantId) {
      return { ok: false, reason: "own_code", message: failureMessage("own_code") };
    }

    const allowed = promo.allowedPlans?.filter(Boolean) ?? [];
    if (allowed.length > 0 && !allowed.includes(tenant.plan)) {
      return {
        ok: false,
        reason: "plan_not_allowed",
        message: failureMessage("plan_not_allowed", promo),
      };
    }

    if (promo.audience === "new" || promo.audience === "existing") {
      const ageMs = now.getTime() - tenant.createdAt.getTime();
      const isNew = ageMs <= promo.newTenantDays * 24 * 60 * 60 * 1000;
      if (promo.audience === "new" && !isNew) {
        return {
          ok: false,
          reason: "audience_new_only",
          message: failureMessage("audience_new_only"),
        };
      }
      if (promo.audience === "existing" && isNew) {
        return {
          ok: false,
          reason: "audience_existing_only",
          message: failureMessage("audience_existing_only"),
        };
      }
    }

    const priorCount = (
      await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(promoRedemptionsTable)
        .where(
          and(
            eq(promoRedemptionsTable.promoCodeId, promo.id),
            eq(promoRedemptionsTable.tenantId, tenantId),
          ),
        )
    )[0];
    if ((priorCount?.count ?? 0) >= promo.perTenantLimit) {
      return {
        ok: false,
        reason: "per_tenant_limit_reached",
        message: failureMessage("per_tenant_limit_reached"),
      };
    }

    // Referral codes: the code owner earns a referrer reward, sized by the
    // OWNER's current plan settings (so upgrades improve future referrals).
    // When the referrals switch is off — globally or for the owner's plan —
    // the whole redemption is REJECTED (not just the referrer's cut), so the
    // platform kill switch actually stops referral codes from minting credits.
    let referrerCaptionCredits = 0;
    let referrerImageCredits = 0;
    let ownerTenant: typeof tenant | undefined;
    if (promo.ownerTenantId !== null) {
      ownerTenant = (
        await tx
          .select()
          .from(tenantsTable)
          .where(eq(tenantsTable.id, promo.ownerTenantId))
          .limit(1)
      )[0];
      const flags = await getFeatureFlags();
      const ownerSettings = ownerTenant
        ? await getPlanGamification(ownerTenant.plan)
        : null;
      if (!flags.referrals || !ownerSettings || !ownerSettings.referralsEnabled) {
        return {
          ok: false,
          reason: "referrals_disabled",
          message: failureMessage("referrals_disabled"),
        };
      }
      referrerCaptionCredits = ownerSettings.referrerCaptionCredits;
      referrerImageCredits = ownerSettings.referrerImageCredits;
    }

    // All checks passed — record the redemption and grant the credits, all
    // inside this same transaction.
    await tx.insert(promoRedemptionsTable).values({
      promoCodeId: promo.id,
      tenantId,
      planAtRedemption: tenant.plan,
      captionCredits: promo.captionCredits,
      imageCredits: promo.imageCredits,
      videoCredits: promo.videoCredits,
      referrerCaptionCredits,
      referrerImageCredits,
    });
    await tx
      .update(promoCodesTable)
      .set({ redemptionCount: promo.redemptionCount + 1, updatedAt: now })
      .where(eq(promoCodesTable.id, promo.id));

    const balance = (
      await tx
        .select()
        .from(creditBalancesTable)
        .where(eq(creditBalancesTable.tenantId, tenantId))
        .for("update")
    )[0];
    const newCaptions = (balance?.captionCredits ?? 0) + promo.captionCredits;
    const newImages = (balance?.imageCredits ?? 0) + promo.imageCredits;
    const newVideos = (balance?.videoCredits ?? 0) + promo.videoCredits;
    await tx.insert(creditLedgerTable).values({
      tenantId,
      kind: "promo",
      captionDelta: promo.captionCredits,
      imageDelta: promo.imageCredits,
      videoDelta: promo.videoCredits,
      note: `Promo code ${promo.code}`,
    });
    if (balance) {
      await tx
        .update(creditBalancesTable)
        .set({
          captionCredits: newCaptions,
          imageCredits: newImages,
          videoCredits: newVideos,
        })
        .where(eq(creditBalancesTable.tenantId, tenantId));
    } else {
      await tx.insert(creditBalancesTable).values({
        tenantId,
        captionCredits: newCaptions,
        imageCredits: newImages,
        videoCredits: newVideos,
      });
    }

    // Referrer reward: same transaction, so the redemption and the owner's
    // credits can never disagree.
    if (ownerTenant && (referrerCaptionCredits > 0 || referrerImageCredits > 0)) {
      const ownerBalance = (
        await tx
          .select()
          .from(creditBalancesTable)
          .where(eq(creditBalancesTable.tenantId, ownerTenant.id))
          .for("update")
      )[0];
      const ownerCaptions = (ownerBalance?.captionCredits ?? 0) + referrerCaptionCredits;
      const ownerImages = (ownerBalance?.imageCredits ?? 0) + referrerImageCredits;
      await tx.insert(creditLedgerTable).values({
        tenantId: ownerTenant.id,
        kind: "referral_reward",
        captionDelta: referrerCaptionCredits,
        imageDelta: referrerImageCredits,
        note: `Referral: ${promo.code} redeemed`,
      });
      if (ownerBalance) {
        await tx
          .update(creditBalancesTable)
          .set({ captionCredits: ownerCaptions, imageCredits: ownerImages })
          .where(eq(creditBalancesTable.tenantId, ownerTenant.id));
      } else {
        await tx.insert(creditBalancesTable).values({
          tenantId: ownerTenant.id,
          captionCredits: ownerCaptions,
          imageCredits: ownerImages,
        });
      }
    }

    const parts: string[] = [];
    if (promo.captionCredits > 0) parts.push(`${promo.captionCredits} caption credits`);
    if (promo.imageCredits > 0) parts.push(`${promo.imageCredits} image credits`);
    if (promo.videoCredits > 0) parts.push(`${promo.videoCredits} video credits`);
    return {
      ok: true,
      captionCredits: promo.captionCredits,
      imageCredits: promo.imageCredits,
      videoCredits: promo.videoCredits,
      referrerTenantId: ownerTenant?.id ?? null,
      referrerCaptionCredits,
      referrerImageCredits,
      message: `Success! ${formatCreditParts(parts)} added to your account.`,
    };
  });

  if (!result.ok) {
    await recordFailure(tenantId, code, result.reason);
    return result;
  }

  // Tell the referrer their invite landed. Best-effort — a notification
  // failure never affects the redemption itself.
  if (
    result.referrerTenantId !== null &&
    (result.referrerCaptionCredits > 0 || result.referrerImageCredits > 0)
  ) {
    try {
      const parts: string[] = [];
      if (result.referrerCaptionCredits > 0)
        parts.push(`${result.referrerCaptionCredits} caption credits`);
      if (result.referrerImageCredits > 0)
        parts.push(`${result.referrerImageCredits} image credits`);
      await db.insert(notificationsTable).values({
        tenantId: result.referrerTenantId,
        type: "referral_redeemed",
        title: "Your invite was redeemed!",
        message: `Someone joined with your referral code — ${parts.join(" and ")} added to your balance.`,
        linkUrl: "/studio",
        inApp: true,
      });
    } catch (error) {
      logger.error({ err: error }, "Failed to record referral notification");
    }
  }
  return result;
}

/** Aggregate promo performance for the admin dashboard. */
export async function getPromoMetrics() {
  const [totals, byCampaign, byPlan] = await Promise.all([
    db
      .select({
        redemptions: sql<number>`count(*)::int`,
        captionCredits: sql<number>`coalesce(sum(${promoRedemptionsTable.captionCredits}), 0)::int`,
        imageCredits: sql<number>`coalesce(sum(${promoRedemptionsTable.imageCredits}), 0)::int`,
        videoCredits: sql<number>`coalesce(sum(${promoRedemptionsTable.videoCredits}), 0)::int`,
      })
      .from(promoRedemptionsTable),
    db
      .select({
        campaign: sql<string>`coalesce(${promoCodesTable.campaign}, '(no campaign)')`,
        redemptions: sql<number>`count(${promoRedemptionsTable.id})::int`,
        captionCredits: sql<number>`coalesce(sum(${promoRedemptionsTable.captionCredits}), 0)::int`,
        imageCredits: sql<number>`coalesce(sum(${promoRedemptionsTable.imageCredits}), 0)::int`,
        videoCredits: sql<number>`coalesce(sum(${promoRedemptionsTable.videoCredits}), 0)::int`,
      })
      .from(promoRedemptionsTable)
      .innerJoin(promoCodesTable, eq(promoRedemptionsTable.promoCodeId, promoCodesTable.id))
      .groupBy(sql`coalesce(${promoCodesTable.campaign}, '(no campaign)')`)
      .orderBy(desc(sql`count(${promoRedemptionsTable.id})`)),
    db
      .select({
        plan: promoRedemptionsTable.planAtRedemption,
        redemptions: sql<number>`count(*)::int`,
      })
      .from(promoRedemptionsTable)
      .groupBy(promoRedemptionsTable.planAtRedemption)
      .orderBy(desc(sql`count(*)`)),
  ]);
  return {
    totalRedemptions: totals[0]?.redemptions ?? 0,
    totalCaptionCredits: totals[0]?.captionCredits ?? 0,
    totalImageCredits: totals[0]?.imageCredits ?? 0,
    totalVideoCredits: totals[0]?.videoCredits ?? 0,
    byCampaign,
    byPlan,
  };
}

/** Recent rejected attempts (newest first) for the admin failure log. */
export async function listPromoFailures(limit = 100) {
  return db
    .select({
      id: promoRedemptionFailuresTable.id,
      tenantId: promoRedemptionFailuresTable.tenantId,
      code: promoRedemptionFailuresTable.code,
      reason: promoRedemptionFailuresTable.reason,
      createdAt: promoRedemptionFailuresTable.createdAt,
      tenantEmail: tenantsTable.email,
    })
    .from(promoRedemptionFailuresTable)
    .leftJoin(tenantsTable, eq(promoRedemptionFailuresTable.tenantId, tenantsTable.id))
    .orderBy(desc(promoRedemptionFailuresTable.createdAt), desc(promoRedemptionFailuresTable.id))
    .limit(limit);
}
