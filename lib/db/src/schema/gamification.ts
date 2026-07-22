import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Gamification: quest and streak reward claims.
 *
 * One row per claimed reward per workspace. `key` is the stable claim id —
 * "quest:<questId>" for quests, "streak:<days>:<streakStartDate>" for streak
 * milestones (bound to the start date of the streak run, so a broken streak
 * naturally re-arms the milestone). The unique (tenantId, key) index is the
 * idempotency guarantee: double-clicks and replays can never double-grant.
 */
export const gamificationClaimsTable = pgTable(
  "gamification_claims",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull(),
    key: text("key").notNull(),
    /** "quest" | "streak" */
    kind: text("kind").notNull(),
    /** Credits granted at claim time (after the plan's reward multiplier). */
    captionCredits: integer("caption_credits").notNull().default(0),
    imageCredits: integer("image_credits").notNull().default(0),
    videoCredits: integer("video_credits").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("gamification_claims_tenant_key_unique").on(t.tenantId, t.key),
  ],
);

export type GamificationClaim = typeof gamificationClaimsTable.$inferSelect;

/**
 * Per-plan gamification configuration, superadmin managed. Keyed by plan id
 * so it covers every plan in the catalog — including custom plans created
 * later (the admin UI lists plans dynamically; a missing row means the
 * built-in defaults apply, same pattern as plan_settings/feature_flags).
 *
 * The four global feature flags (quests/streaks/referrals/progressMeter) are
 * the platform-wide kill switches; these per-plan toggles refine WHICH plans
 * see each mechanic when its global switch is on.
 */
export const gamificationPlanSettingsTable = pgTable("gamification_plan_settings", {
  planId: text("plan_id").primaryKey(),
  questsEnabled: boolean("quests_enabled").notNull().default(true),
  streaksEnabled: boolean("streaks_enabled").notNull().default(true),
  referralsEnabled: boolean("referrals_enabled").notNull().default(true),
  progressMeterEnabled: boolean("progress_meter_enabled").notNull().default(true),
  /**
   * Scales every quest/streak reward for this plan (100 = the catalog
   * amounts, 0 = rewards disabled while quests stay visible, 200 = double).
   */
  rewardMultiplierPercent: integer("reward_multiplier_percent").notNull().default(100),
  /** Referral: what the code OWNER earns per successful redemption. */
  referrerCaptionCredits: integer("referrer_caption_credits").notNull().default(5),
  referrerImageCredits: integer("referrer_image_credits").notNull().default(3),
  /** Referral: what a NEW user gets for redeeming this plan-holder's code. */
  refereeCaptionCredits: integer("referee_caption_credits").notNull().default(5),
  refereeImageCredits: integer("referee_image_credits").notNull().default(3),
  /** Cap on successful redemptions of one personal referral code. */
  referralMaxRedemptions: integer("referral_max_redemptions").notNull().default(25),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type GamificationPlanSettings = typeof gamificationPlanSettingsTable.$inferSelect;
