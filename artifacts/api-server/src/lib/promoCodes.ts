import { randomBytes } from "node:crypto";
import {
  db,
  promoCodesTable,
  promoRedemptionsTable,
  promoRedemptionFailuresTable,
  tenantsTable,
  notificationsTable,
  type PromoCode,
} from "@workspace/db";
import { eq, and, sql, desc } from "drizzle-orm";
import { logger } from "./logger";
import { getFeatureFlags } from "./featureFlags";
import {
  getPlanGamification,
  legacyRewardToCreditsMilli,
  RewardMappingError,
} from "./gamification";
import { grantCredits } from "./creditAccounts";
import { MILLI } from "./creditRates";

/**
 * Promo code redemption engine.
 *
 * All eligibility checks and the canonical account grant happen inside ONE transaction
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
      /** Canonical prepaid amounts granted to each side. */
      credits: number;
      referrerCredits: number;
      message: string;
    }
  | {
      ok: false;
      reason: RedeemFailureReason | "reward_mapping_missing";
      message: string;
    };

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
  const cleanPrefix = prefix
    ? normalizePromoCode(prefix).replace(/[^A-Z0-9_-]/g, "")
    : "";
  return cleanPrefix ? `${cleanPrefix}-${out}` : out;
}

function failureMessage(
  reason: RedeemFailureReason,
  promo?: PromoCode,
): string {
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
async function recordFailure(
  tenantId: number,
  code: string,
  reason: string,
): Promise<void> {
  try {
    await db
      .insert(promoRedemptionFailuresTable)
      .values({ tenantId, code, reason });
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
    await recordFailure(
      tenantId,
      code.slice(0, 64) || "(empty)",
      "invalid_code",
    );
    return {
      ok: false,
      reason: "invalid_code",
      message: failureMessage("invalid_code"),
    };
  }

  let result: RedeemResult;
  try {
    result = await db.transaction(async (tx): Promise<RedeemResult> => {
      // Lock the promo row: all checks below stay true until commit.
      const promo = (
        await tx
          .select()
          .from(promoCodesTable)
          .where(eq(promoCodesTable.code, code))
          .for("update")
      )[0];
      if (!promo) {
        return {
          ok: false,
          reason: "invalid_code",
          message: failureMessage("invalid_code"),
        };
      }

      const now = new Date();
      if (!promo.active) {
        return {
          ok: false,
          reason: "inactive",
          message: failureMessage("inactive"),
        };
      }
      if (promo.startsAt && promo.startsAt > now) {
        return {
          ok: false,
          reason: "not_started",
          message: failureMessage("not_started"),
        };
      }
      if (promo.expiresAt && promo.expiresAt <= now) {
        return {
          ok: false,
          reason: "expired",
          message: failureMessage("expired"),
        };
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
        await tx
          .select()
          .from(tenantsTable)
          .where(eq(tenantsTable.id, tenantId))
          .limit(1)
      )[0];
      if (!tenant) {
        return {
          ok: false,
          reason: "invalid_code",
          message: failureMessage("invalid_code"),
        };
      }

      // Referral codes cannot be self-redeemed.
      if (promo.ownerTenantId !== null && promo.ownerTenantId === tenantId) {
        return {
          ok: false,
          reason: "own_code",
          message: failureMessage("own_code"),
        };
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
      let refereeCreditsMilli: number | null = null;
      let referrerCreditsMilli: number | null = null;
      let ownerTenant: typeof tenant | undefined;
      let ownerSettings: Awaited<
        ReturnType<typeof getPlanGamification>
      > | null = null;
      // All promotional redemptions now land in the canonical account. A
      // legacy video-generation amount has no safe duration mapping, so it must
      // be replaced by an explicit override rather than guessed.
      refereeCreditsMilli =
        promo.rewardCreditsMilli ??
        (await legacyRewardToCreditsMilli({
          captionCredits: promo.captionCredits,
          imageCredits: promo.imageCredits,
          videoCredits: promo.videoCredits,
        }));
      if (promo.ownerTenantId !== null) {
        ownerTenant = (
          await tx
            .select()
            .from(tenantsTable)
            .where(eq(tenantsTable.id, promo.ownerTenantId))
            .limit(1)
        )[0];
        const flags = await getFeatureFlags();
        ownerSettings = ownerTenant
          ? await getPlanGamification(ownerTenant.plan)
          : null;
        if (
          !flags.referrals ||
          !ownerSettings ||
          !ownerSettings.referralsEnabled
        ) {
          return {
            ok: false,
            reason: "referrals_disabled",
            message: failureMessage("referrals_disabled"),
          };
        }
        referrerCaptionCredits = ownerSettings.referrerCaptionCredits;
        referrerImageCredits = ownerSettings.referrerImageCredits;
        // A code-level override is a frozen value. Otherwise the old
        // caption/image buckets are converted against the current rate card.
        referrerCreditsMilli =
          ownerSettings.rewardCreditOverrides.referrer ??
          (await legacyRewardToCreditsMilli({
            captionCredits: referrerCaptionCredits,
            imageCredits: referrerImageCredits,
            videoCredits: 0,
          }));
        refereeCreditsMilli = promo.rewardCreditsMilli ?? refereeCreditsMilli;
      }

      // All checks passed — record the redemption and grant the credits, all
      // inside this same transaction.
      const redemption = (
        await tx
          .insert(promoRedemptionsTable)
          .values({
            promoCodeId: promo.id,
            tenantId,
            planAtRedemption: tenant.plan,
            captionCredits: promo.captionCredits,
            imageCredits: promo.imageCredits,
            videoCredits: promo.videoCredits,
            referrerCaptionCredits,
            referrerImageCredits,
            rewardCreditsMilli: refereeCreditsMilli,
            referrerRewardCreditsMilli: referrerCreditsMilli,
          })
          .returning({ id: promoRedemptionsTable.id })
      )[0]!;
      await tx
        .update(promoCodesTable)
        .set({ redemptionCount: promo.redemptionCount + 1, updatedAt: now })
        .where(eq(promoCodesTable.id, promo.id));

      // Both ordinary promos and referral rewards are canonical expiring
      // grants. The redemption receipt and each ledger grant share this
      // transaction and stable idempotency keys.
      await grantCredits(
        {
          tenantId,
          credits: (refereeCreditsMilli ?? 0) / MILLI,
          kind: "grant_promo",
          expiresInDays: Number(process.env.CREDIT_GRANT_EXPIRY_DAYS ?? 90),
          idempotencyKey: `promo:${redemption.id}:recipient`,
          note: `Promo code ${promo.code}`,
        },
        tx,
      );

      // Referrer reward: same transaction, so the redemption and the owner's
      // credits can never disagree.
      if (ownerTenant && (referrerCreditsMilli ?? 0) > 0) {
        await grantCredits(
          {
            tenantId: ownerTenant.id,
            credits: (referrerCreditsMilli ?? 0) / MILLI,
            kind: "grant_promo",
            expiresInDays: Number(process.env.CREDIT_GRANT_EXPIRY_DAYS ?? 90),
            idempotencyKey: `referral:${redemption.id}:referrer`,
            note: `Referral: ${promo.code} redeemed`,
          },
          tx,
        );
      }

      const parts: string[] = [];
      if ((refereeCreditsMilli ?? 0) > 0) {
        parts.push(`${(refereeCreditsMilli ?? 0) / MILLI} prepaid credits`);
      }
      return {
        ok: true,
        captionCredits: promo.captionCredits,
        imageCredits: promo.imageCredits,
        videoCredits: promo.videoCredits,
        referrerTenantId: ownerTenant?.id ?? null,
        referrerCaptionCredits,
        referrerImageCredits,
        credits: (refereeCreditsMilli ?? 0) / MILLI,
        referrerCredits: (referrerCreditsMilli ?? 0) / MILLI,
        message: `Success! ${formatCreditParts(parts)} added to your account.`,
      };
    });
  } catch (error) {
    if (error instanceof RewardMappingError) {
      await recordFailure(tenantId, code, "reward_mapping_missing");
      return {
        ok: false,
        reason: "reward_mapping_missing",
        message: error.message,
      };
    }
    throw error;
  }

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
      if (result.referrerCredits > 0)
        parts.push(`${result.referrerCredits} prepaid credits`);
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
      .innerJoin(
        promoCodesTable,
        eq(promoRedemptionsTable.promoCodeId, promoCodesTable.id),
      )
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
    .leftJoin(
      tenantsTable,
      eq(promoRedemptionFailuresTable.tenantId, tenantsTable.id),
    )
    .orderBy(
      desc(promoRedemptionFailuresTable.createdAt),
      desc(promoRedemptionFailuresTable.id),
    )
    .limit(limit);
}
