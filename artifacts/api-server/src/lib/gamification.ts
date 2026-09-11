import {
  db,
  gamificationClaimsTable,
  gamificationPlanSettingsTable,
  usageEventsTable,
  brandKitsTable,
  connectedAccountsTable,
  scheduledPostsTable,
  videoGenerationsTable,
  type GamificationPlanSettings,
  type Tenant,
} from "@workspace/db";
import { and, eq, gte, sql, desc } from "drizzle-orm";
import { grantCredits, type CreditBalance } from "./creditAccounts";
import { creditsMilliFor, MILLI } from "./creditRates";
import { getFeatureFlags } from "./featureFlags";

/**
 * Gamification engine: getting-started quests and daily creation streaks.
 *
 * Everything is derived from data the app already writes (usage_events,
 * brand_kits, connected_accounts, scheduled_posts, video_generations) — no
 * new tracking calls anywhere in the product code. Rewards flow through the
 * ordinary credits ledger via grantCredits, and every claim is idempotent
 * behind the unique (tenantId, key) index on gamification_claims.
 *
 * Feature layering: the global `quests`/`streaks`/`referrals`/`progressMeter`
 * kill switches gate each mechanic platform-wide; per-plan rows in
 * gamification_plan_settings refine which PLANS see it and how big the
 * rewards are. No row = defaults (everything on, 100% rewards).
 */

export interface RewardAmounts {
  captionCredits: number;
  imageCredits: number;
  videoCredits: number;
  /** Canonical prepaid amount. Null means the legacy amount is not mappable. */
  credits?: number | null;
  /** Present when an old generation bucket has no safe rate-card mapping. */
  mappingError?: string;
}

export interface PlanGamification {
  questsEnabled: boolean;
  streaksEnabled: boolean;
  referralsEnabled: boolean;
  progressMeterEnabled: boolean;
  rewardMultiplierPercent: number;
  referrerCaptionCredits: number;
  referrerImageCredits: number;
  refereeCaptionCredits: number;
  refereeImageCredits: number;
  referralMaxRedemptions: number;
  rewardCreditOverrides: Record<string, number>;
}

export const DEFAULT_PLAN_GAMIFICATION: PlanGamification = {
  questsEnabled: true,
  streaksEnabled: true,
  referralsEnabled: true,
  progressMeterEnabled: true,
  rewardMultiplierPercent: 100,
  referrerCaptionCredits: 5,
  referrerImageCredits: 3,
  refereeCaptionCredits: 5,
  refereeImageCredits: 3,
  referralMaxRedemptions: 25,
  rewardCreditOverrides: {},
};

/** Effective per-plan settings: the stored row, else the defaults. */
export async function getPlanGamification(
  planId: string,
): Promise<PlanGamification> {
  const row = (
    await db
      .select()
      .from(gamificationPlanSettingsTable)
      .where(eq(gamificationPlanSettingsTable.planId, planId))
      .limit(1)
  )[0];
  return row ? rowToPlanGamification(row) : { ...DEFAULT_PLAN_GAMIFICATION };
}

export function rowToPlanGamification(
  row: GamificationPlanSettings,
): PlanGamification {
  return {
    questsEnabled: row.questsEnabled,
    streaksEnabled: row.streaksEnabled,
    referralsEnabled: row.referralsEnabled,
    progressMeterEnabled: row.progressMeterEnabled,
    rewardMultiplierPercent: row.rewardMultiplierPercent,
    referrerCaptionCredits: row.referrerCaptionCredits,
    referrerImageCredits: row.referrerImageCredits,
    refereeCaptionCredits: row.refereeCaptionCredits,
    refereeImageCredits: row.refereeImageCredits,
    referralMaxRedemptions: row.referralMaxRedemptions,
    rewardCreditOverrides: row.rewardCreditOverrides ?? {},
  };
}

/** Scale a base reward by the plan's multiplier percent (floors, never negative). */
export function applyMultiplier(
  base: RewardAmounts,
  percent: number,
): RewardAmounts {
  const p = Math.max(0, percent) / 100;
  return {
    captionCredits: Math.floor(base.captionCredits * p),
    imageCredits: Math.floor(base.imageCredits * p),
    videoCredits: Math.floor(base.videoCredits * p),
  };
}

/**
 * Convert the old caption/image generation buckets to the canonical
 * credit-rate-card unit. Video generations intentionally do not get guessed:
 * the rate card prices video seconds while the old reward was one opaque
 * generation, so an administrator must provide an explicit override for those
 * rewards before they can be claimed.
 */
export async function legacyRewardToCreditsMilli(
  reward: RewardAmounts,
): Promise<number> {
  if (reward.videoCredits > 0) {
    throw new RewardMappingError(
      "This reward includes a legacy video generation with no duration. Set an explicit credit override before claiming it.",
    );
  }
  const [captionRate, imageRate] = await Promise.all([
    reward.captionCredits > 0
      ? creditsMilliFor("caption", 1)
      : Promise.resolve(0),
    reward.imageCredits > 0 ? creditsMilliFor("image", 1) : Promise.resolve(0),
  ]);
  if (reward.captionCredits > 0 && captionRate === null) {
    throw new RewardMappingError(
      "The current credit rate card has no caption rate for this reward.",
    );
  }
  if (reward.imageCredits > 0 && imageRate === null) {
    throw new RewardMappingError(
      "The current credit rate card has no image rate for this reward.",
    );
  }
  return (
    reward.captionCredits * (captionRate ?? 0) +
    reward.imageCredits * (imageRate ?? 0)
  );
}

export class RewardMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RewardMappingError";
  }
}

function scaledMilli(baseMilli: number, percent: number): number {
  return Math.max(0, Math.floor((baseMilli * Math.max(0, percent)) / 100));
}

/**
 * Resolve the amount that will actually be granted. Explicit canonical
 * overrides win over conversion, while the existing plan multiplier continues
 * to apply to both forms.
 */
export async function resolveRewardCreditsMilli(
  reward: RewardAmounts,
  settings: PlanGamification,
  overrideKey: string,
): Promise<number> {
  const override = settings.rewardCreditOverrides[overrideKey];
  if (override !== undefined) {
    if (!Number.isInteger(override) || override < 0) {
      throw new RewardMappingError(
        `Invalid credit override for ${overrideKey}.`,
      );
    }
    return scaledMilli(override, settings.rewardMultiplierPercent);
  }
  return scaledMilli(
    await legacyRewardToCreditsMilli(reward),
    settings.rewardMultiplierPercent,
  );
}

async function displayReward(
  reward: RewardAmounts,
  settings: PlanGamification,
  overrideKey: string,
): Promise<RewardAmounts> {
  const displayed = applyMultiplier(reward, settings.rewardMultiplierPercent);
  try {
    const milli = await resolveRewardCreditsMilli(
      reward,
      settings,
      overrideKey,
    );
    return { ...displayed, credits: milli / MILLI };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "This reward cannot be converted to credits.";
    return { ...displayed, credits: null, mappingError: message };
  }
}

// ---------------------------------------------------------------------------
// Quests
// ---------------------------------------------------------------------------

export interface QuestDef {
  id: string;
  title: string;
  description: string;
  reward: RewardAmounts;
  /** Whether the tenant has done the underlying action. */
  check: (tenantId: number) => Promise<boolean>;
}

async function hasUsage(tenantId: number, kind: string): Promise<boolean> {
  const row = (
    await db
      .select({ one: sql<number>`1` })
      .from(usageEventsTable)
      .where(
        and(
          eq(usageEventsTable.tenantId, tenantId),
          eq(usageEventsTable.kind, kind),
        ),
      )
      .limit(1)
  )[0];
  return !!row;
}

/** The getting-started quest catalog. Ids are stable — they live in claim keys. */
export const QUESTS: readonly QuestDef[] = [
  {
    id: "create_brand_kit",
    title: "Create a brand kit",
    description: "Teach KOKAO your colors, voice, and style.",
    reward: { captionCredits: 2, imageCredits: 0, videoCredits: 0 },
    check: async (tenantId) =>
      !!(
        await db
          .select({ one: sql<number>`1` })
          .from(brandKitsTable)
          .where(eq(brandKitsTable.tenantId, tenantId))
          .limit(1)
      )[0],
  },
  {
    id: "first_caption",
    title: "Generate your first caption",
    description: "Let AI write an on-brand post for you.",
    reward: { captionCredits: 2, imageCredits: 0, videoCredits: 0 },
    check: (tenantId) => hasUsage(tenantId, "caption"),
  },
  {
    id: "first_image",
    title: "Generate your first image",
    description: "Create a visual to go with your words.",
    reward: { captionCredits: 0, imageCredits: 2, videoCredits: 0 },
    check: (tenantId) => hasUsage(tenantId, "image"),
  },
  {
    id: "first_video",
    title: "Make your first video",
    description: "Try the Video Studio — even a photo slideshow counts.",
    reward: { captionCredits: 0, imageCredits: 0, videoCredits: 1 },
    check: async (tenantId) =>
      (await hasUsage(tenantId, "video")) ||
      !!(
        await db
          .select({ one: sql<number>`1` })
          .from(videoGenerationsTable)
          .where(
            and(
              eq(videoGenerationsTable.tenantId, tenantId),
              eq(videoGenerationsTable.status, "succeeded"),
            ),
          )
          .limit(1)
      )[0],
  },
  {
    id: "connect_account",
    title: "Connect a social account",
    description: "Link Instagram, LinkedIn, X, or any platform.",
    reward: { captionCredits: 2, imageCredits: 1, videoCredits: 0 },
    check: async (tenantId) =>
      !!(
        await db
          .select({ one: sql<number>`1` })
          .from(connectedAccountsTable)
          .where(
            and(
              eq(connectedAccountsTable.tenantId, tenantId),
              eq(connectedAccountsTable.status, "connected"),
            ),
          )
          .limit(1)
      )[0],
  },
  {
    id: "schedule_post",
    title: "Schedule a post",
    description: "Queue content to publish itself.",
    reward: { captionCredits: 1, imageCredits: 1, videoCredits: 0 },
    check: async (tenantId) =>
      !!(
        await db
          .select({ one: sql<number>`1` })
          .from(scheduledPostsTable)
          .where(eq(scheduledPostsTable.tenantId, tenantId))
          .limit(1)
      )[0],
  },
] as const;

export function getQuestDef(id: string): QuestDef | undefined {
  return QUESTS.find((q) => q.id === id);
}

// ---------------------------------------------------------------------------
// Streaks
// ---------------------------------------------------------------------------

export interface StreakMilestoneDef {
  days: number;
  reward: RewardAmounts;
}

/** Milestone ladder. Days are stable — they live in claim keys. */
export const STREAK_MILESTONES: readonly StreakMilestoneDef[] = [
  { days: 3, reward: { captionCredits: 1, imageCredits: 1, videoCredits: 0 } },
  { days: 7, reward: { captionCredits: 2, imageCredits: 2, videoCredits: 0 } },
  { days: 14, reward: { captionCredits: 3, imageCredits: 3, videoCredits: 0 } },
  { days: 30, reward: { captionCredits: 5, imageCredits: 5, videoCredits: 1 } },
] as const;

/** How far back activity is scanned; comfortably covers the longest milestone. */
const STREAK_LOOKBACK_DAYS = 62;

function utcDayString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface StreakInfo {
  /** Consecutive UTC days with at least one generation, ending today or yesterday. */
  currentDays: number;
  /** Whether the tenant has generated something today (UTC). */
  activeToday: boolean;
  /** UTC date the current streak started (claim keys bind to it). */
  startDate: string | null;
}

/**
 * Compute the current streak from usage_events day coverage. Days are UTC —
 * one shared clock for everyone, matching how monthly quotas already reset.
 */
export async function getStreak(tenantId: number): Promise<StreakInfo> {
  const since = new Date(
    Date.now() - STREAK_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  );
  const rows = await db
    .select({
      day: sql<string>`to_char(${usageEventsTable.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`,
    })
    .from(usageEventsTable)
    .where(
      and(
        eq(usageEventsTable.tenantId, tenantId),
        gte(usageEventsTable.createdAt, since),
      ),
    )
    .groupBy(sql`1`)
    .orderBy(desc(sql`1`));

  const days = new Set(rows.map((r) => r.day));
  const today = new Date();
  const activeToday = days.has(utcDayString(today));

  // A streak is alive if it includes today or ended yesterday (grace: today
  // isn't over yet). Walk backwards from the anchor day.
  const anchor = new Date(today);
  if (!activeToday) anchor.setUTCDate(anchor.getUTCDate() - 1);
  let currentDays = 0;
  const cursor = new Date(anchor);
  while (currentDays < STREAK_LOOKBACK_DAYS && days.has(utcDayString(cursor))) {
    currentDays += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  if (currentDays === 0)
    return { currentDays: 0, activeToday, startDate: null };

  const start = new Date(anchor);
  start.setUTCDate(start.getUTCDate() - (currentDays - 1));
  return { currentDays, activeToday, startDate: utcDayString(start) };
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

export class ClaimError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "unknown_key"
      | "not_completed"
      | "already_claimed"
      | "disabled"
      | "mapping_missing",
  ) {
    super(message);
    this.name = "ClaimError";
  }
}

async function getClaimedKeys(
  tenantId: number,
): Promise<Map<string, number | null>> {
  const rows = await db
    .select({
      key: gamificationClaimsTable.key,
      rewardCreditsMilli: gamificationClaimsTable.rewardCreditsMilli,
    })
    .from(gamificationClaimsTable)
    .where(eq(gamificationClaimsTable.tenantId, tenantId));
  return new Map(rows.map((r) => [r.key, r.rewardCreditsMilli]));
}

function frozenDisplayReward(
  reward: RewardAmounts,
  settings: PlanGamification,
  rewardCreditsMilli: number,
): RewardAmounts {
  return {
    ...applyMultiplier(reward, settings.rewardMultiplierPercent),
    credits: rewardCreditsMilli / MILLI,
  };
}

export function questClaimKey(questId: string): string {
  return `quest:${questId}`;
}

export function streakClaimKey(days: number, startDate: string): string {
  return `streak:${days}:${startDate}`;
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    const e = current as { code?: string; message?: string; cause?: unknown };
    if (e.code === "23505" || /duplicate key/i.test(e.message ?? ""))
      return true;
    current = e.cause;
  }
  return false;
}

/**
 * Claim a quest or streak reward. Validates the underlying achievement
 * server-side (never trusts the client), inserts the claim row, and grants
 * canonical account credits in one transaction. Legacy generation buckets
 * remain on the claim as an audit snapshot but are never credited.
 */
export async function claimReward(
  tenant: Tenant,
  key: string,
): Promise<{ granted: RewardAmounts; credits: CreditBalance }> {
  const flags = await getFeatureFlags();
  const settings = await getPlanGamification(tenant.plan);

  let kind: "quest" | "streak";
  let baseReward: RewardAmounts;

  const questMatch = /^quest:([a-z0-9_]+)$/.exec(key);
  const streakMatch = /^streak:(\d+):(\d{4}-\d{2}-\d{2})$/.exec(key);

  if (questMatch) {
    if (!flags.quests || !settings.questsEnabled) {
      throw new ClaimError("Quests are not enabled for your plan.", "disabled");
    }
    const quest = getQuestDef(questMatch[1]!);
    if (!quest) throw new ClaimError("Unknown reward.", "unknown_key");
    if (!(await quest.check(tenant.id))) {
      throw new ClaimError(
        "Finish the quest first, then claim it.",
        "not_completed",
      );
    }
    kind = "quest";
    baseReward = quest.reward;
  } else if (streakMatch) {
    if (!flags.streaks || !settings.streaksEnabled) {
      throw new ClaimError(
        "Streaks are not enabled for your plan.",
        "disabled",
      );
    }
    const days = Number(streakMatch[1]);
    const milestone = STREAK_MILESTONES.find((m) => m.days === days);
    if (!milestone) throw new ClaimError("Unknown reward.", "unknown_key");
    const streak = await getStreak(tenant.id);
    // The key must name the CURRENT streak run and the run must have reached
    // the milestone — a stale key from a broken streak can never be claimed.
    if (
      streak.startDate === null ||
      streak.startDate !== streakMatch[2] ||
      streak.currentDays < days
    ) {
      throw new ClaimError(
        `Reach a ${days}-day streak first, then claim it.`,
        "not_completed",
      );
    }
    kind = "streak";
    baseReward = milestone.reward;
  } else {
    throw new ClaimError("Unknown reward.", "unknown_key");
  }

  const overrideKey = `${kind}:${kind === "quest" ? questMatch![1] : streakMatch![1]}`;
  let rewardCreditsMilli: number;
  try {
    rewardCreditsMilli = await resolveRewardCreditsMilli(
      baseReward,
      settings,
      overrideKey,
    );
  } catch (error) {
    if (error instanceof RewardMappingError) {
      throw new ClaimError(error.message, "mapping_missing");
    }
    throw error;
  }
  const granted: RewardAmounts = {
    ...applyMultiplier(baseReward, settings.rewardMultiplierPercent),
    credits: rewardCreditsMilli / MILLI,
  };

  try {
    const credits = await db.transaction(async (tx) => {
      await tx.insert(gamificationClaimsTable).values({
        tenantId: tenant.id,
        key,
        kind,
        captionCredits: granted.captionCredits,
        imageCredits: granted.imageCredits,
        videoCredits: granted.videoCredits,
        rewardCreditsMilli,
      });
      return grantCredits(
        {
          tenantId: tenant.id,
          credits: rewardCreditsMilli / MILLI,
          kind: "grant_promo",
          // Gamification rewards share the expiring promotional bucket.
          expiresInDays: Number(process.env.CREDIT_GRANT_EXPIRY_DAYS ?? 90),
          idempotencyKey: `gamification:${tenant.id}:${key}`,
          note: `Gamification reward: ${key}`,
        },
        tx,
      );
    });
    return { granted, credits };
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ClaimError(
        "You already claimed this reward.",
        "already_claimed",
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// State for the UI
// ---------------------------------------------------------------------------

export interface GamificationState {
  questsEnabled: boolean;
  streaksEnabled: boolean;
  referralsEnabled: boolean;
  progressMeterEnabled: boolean;
  quests: {
    id: string;
    title: string;
    description: string;
    completed: boolean;
    claimed: boolean;
    claimKey: string;
    reward: RewardAmounts;
  }[];
  streak: {
    currentDays: number;
    activeToday: boolean;
    milestones: {
      days: number;
      reward: RewardAmounts;
      reached: boolean;
      claimed: boolean;
      claimKey: string | null;
    }[];
  };
}

/** Everything the AI Studio gamification card needs, in one read. */
export async function getGamificationState(
  tenant: Tenant,
): Promise<GamificationState> {
  const [flags, settings] = await Promise.all([
    getFeatureFlags(),
    getPlanGamification(tenant.plan),
  ]);
  const questsEnabled = flags.quests && settings.questsEnabled;
  const streaksEnabled = flags.streaks && settings.streaksEnabled;
  const referralsEnabled = flags.referrals && settings.referralsEnabled;
  const progressMeterEnabled =
    flags.progressMeter && settings.progressMeterEnabled;

  const claimed =
    questsEnabled || streaksEnabled
      ? await getClaimedKeys(tenant.id)
      : new Map<string, number | null>();

  const quests = questsEnabled
    ? await Promise.all(
        QUESTS.map(async (quest) => {
          const key = questClaimKey(quest.id);
          const isClaimed = claimed.has(key);
          return {
            id: quest.id,
            title: quest.title,
            description: quest.description,
            // A claimed quest was necessarily completed; skip the re-check.
            completed: isClaimed || (await quest.check(tenant.id)),
            claimed: isClaimed,
            claimKey: key,
            reward:
              isClaimed &&
              claimed.get(key) !== null &&
              claimed.get(key) !== undefined
                ? frozenDisplayReward(quest.reward, settings, claimed.get(key)!)
                : await displayReward(
                    quest.reward,
                    settings,
                    `quest:${quest.id}`,
                  ),
          };
        }),
      )
    : [];

  const streak = streaksEnabled
    ? await getStreak(tenant.id)
    : { currentDays: 0, activeToday: false, startDate: null };

  return {
    questsEnabled,
    streaksEnabled,
    referralsEnabled,
    progressMeterEnabled,
    quests,
    streak: {
      currentDays: streak.currentDays,
      activeToday: streak.activeToday,
      milestones: streaksEnabled
        ? await Promise.all(
            STREAK_MILESTONES.map(async (m) => {
              const key = streak.startDate
                ? streakClaimKey(m.days, streak.startDate)
                : null;
              return {
                days: m.days,
                reward:
                  key !== null &&
                  claimed.get(key) !== null &&
                  claimed.get(key) !== undefined
                    ? frozenDisplayReward(m.reward, settings, claimed.get(key)!)
                    : await displayReward(
                        m.reward,
                        settings,
                        `streak:${m.days}`,
                      ),
                reached: streak.currentDays >= m.days,
                claimed: key !== null && claimed.has(key),
                claimKey: key,
              };
            }),
          )
        : [],
    },
  };
}
