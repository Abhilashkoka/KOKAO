import { Router, type IRouter, type Request, type Response } from "express";
import { db, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { ClaimGamificationRewardBody } from "@workspace/api-zod";
import {
  getGamificationState,
  claimReward,
  ClaimError,
  getPlanGamification,
  legacyRewardToCreditsMilli,
} from "../lib/gamification";
import { getFeatureFlags } from "../lib/featureFlags";
import { getOrCreateReferralCode, getReferralStats } from "../lib/referrals";
import { MILLI } from "../lib/creditRates";

const router: IRouter = Router();

async function loadTenant(tenantId: number) {
  return (
    await db
      .select()
      .from(tenantsTable)
      .where(eq(tenantsTable.id, tenantId))
      .limit(1)
  )[0];
}

/** Quests, streak, and per-feature enablement for the AI Studio card. */
router.get("/gamification", async (req: Request, res: Response) => {
  const tenant = await loadTenant(req.tenantId);
  if (!tenant) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  res.json(await getGamificationState(tenant));
});

/** Claim a completed quest or reached streak milestone. */
router.post("/gamification/claim", async (req: Request, res: Response) => {
  const parsed = ClaimGamificationRewardBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const tenant = await loadTenant(req.tenantId);
  if (!tenant) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const { granted, credits } = await claimReward(tenant, parsed.data.key);
    res.json({ ok: true, granted, credits });
  } catch (error) {
    if (error instanceof ClaimError) {
      const status =
        error.code === "already_claimed"
          ? 409
          : error.code === "disabled"
            ? 403
            : error.code === "mapping_missing"
              ? 422
              : 400;
      res.status(status).json({ error: error.message });
      return;
    }
    req.log.error({ err: error }, "Gamification claim failed");
    res
      .status(500)
      .json({ error: "Could not claim the reward. Please try again." });
  }
});

/** The tenant's personal invite code and how it has performed. */
router.get("/gamification/referral", async (req: Request, res: Response) => {
  const tenant = await loadTenant(req.tenantId);
  if (!tenant) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const flags = await getFeatureFlags();
  const settings = await getPlanGamification(tenant.plan);
  if (!flags.referrals || !settings.referralsEnabled) {
    res.status(403).json({
      error: "Referrals are currently disabled.",
      code: "feature_disabled",
    });
    return;
  }
  const code = await getOrCreateReferralCode(tenant);
  let refereeCreditsMilli: number;
  let referrerCreditsMilli: number;
  try {
    refereeCreditsMilli =
      code.rewardCreditsMilli ??
      (await legacyRewardToCreditsMilli({
        captionCredits: code.captionCredits,
        imageCredits: code.imageCredits,
        videoCredits: code.videoCredits,
      }));
    referrerCreditsMilli =
      settings.rewardCreditOverrides.referrer ??
      (await legacyRewardToCreditsMilli({
        captionCredits: settings.referrerCaptionCredits,
        imageCredits: settings.referrerImageCredits,
        videoCredits: 0,
      }));
  } catch (error) {
    res.status(422).json({
      error:
        error instanceof Error
          ? error.message
          : "Referral rewards need a credit override.",
      code: "reward_mapping_missing",
    });
    return;
  }
  let stats;
  try {
    stats = await getReferralStats(req.tenantId);
  } catch (error) {
    res.status(422).json({
      error:
        error instanceof Error
          ? error.message
          : "Referral history needs a credit override.",
      code: "reward_mapping_missing",
    });
    return;
  }
  res.json({
    code: code.code,
    refereeCaptionCredits: code.captionCredits,
    refereeImageCredits: code.imageCredits,
    refereeCredits: refereeCreditsMilli / MILLI,
    referrerCaptionCredits: settings.referrerCaptionCredits,
    referrerImageCredits: settings.referrerImageCredits,
    referrerCredits: referrerCreditsMilli / MILLI,
    maxRedemptions: code.maxRedemptions,
    redemptions: stats.redemptions,
    captionCreditsEarned: stats.captionCreditsEarned,
    imageCreditsEarned: stats.imageCreditsEarned,
    creditsEarned: stats.creditsEarned,
  });
});

export default router;
