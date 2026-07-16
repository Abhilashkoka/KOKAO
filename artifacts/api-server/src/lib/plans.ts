import { db, planSettingsTable } from "@workspace/db";
import { logger } from "./logger";

export interface PlanLimits {
  captions: number;
  images: number;
  brandKits: number;
  scheduledPosts: number;
}

export interface Plan {
  id: string;
  name: string;
  priceLabel: string;
  limits: PlanLimits;
  features: string[];
  /**
   * Team add-on: default seat allotment (including the owner) for workspaces
   * on this plan. 0 = the team feature is not included. Superadmins can
   * override per workspace via tenants.seatLimit (approved seat requests).
   */
  teamSeats: number;
}

export const DEFAULT_PLANS: Plan[] = [
  {
    id: "free",
    name: "Free",
    priceLabel: "$0 / mo",
    limits: { captions: 20, images: 10, brandKits: 1, scheduledPosts: 10 },
    teamSeats: 0,
    features: [
      "20 AI captions / month",
      "10 AI images / month",
      "1 brand kit",
      "Schedule up to 10 posts",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    priceLabel: "$29 / mo",
    limits: { captions: 500, images: 200, brandKits: 10, scheduledPosts: 200 },
    teamSeats: 0,
    features: [
      "500 AI captions / month",
      "200 AI images / month",
      "10 brand kits",
      "Schedule up to 200 posts",
      "Priority generation",
    ],
  },
  {
    id: "business",
    name: "Business",
    priceLabel: "$99 / mo",
    limits: { captions: -1, images: -1, brandKits: -1, scheduledPosts: -1 },
    teamSeats: 5,
    features: [
      "Unlimited AI captions",
      "Unlimited AI images",
      "Unlimited brand kits",
      "Unlimited scheduling",
      "Team collaboration",
    ],
  },
];

/** Ids of the built-in default plans (deletable via an archived marker row). */
export const DEFAULT_PLAN_IDS = DEFAULT_PLANS.map((p) => p.id);

/** The fallback plan for new signups; cannot be deleted. */
export const FALLBACK_PLAN_ID = "free";

const CACHE_TTL_MS = 30_000;

let cache: { plans: Plan[]; expiresAt: number } | null = null;

export function invalidatePlanCache(): void {
  cache = null;
}

/**
 * Returns the plan catalog: built-in defaults merged with superadmin rows in
 * plan_settings. A row with a default id overrides that default (or, when
 * archived, removes it); rows with new ids are custom plans. Cached briefly to
 * keep quota checks cheap. Falls back to defaults if the DB read fails.
 */
export async function listPlans(): Promise<Plan[]> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.plans;

  let plans: Plan[];
  try {
    const rows = await db.select().from(planSettingsTable);
    const byId = new Map(rows.map((r) => [r.id, r]));

    const entries: { plan: Plan; sortOrder: number }[] = [];
    DEFAULT_PLANS.forEach((p, index) => {
      const row = byId.get(p.id);
      byId.delete(p.id);
      if (row?.archived) return;
      entries.push(
        row
          ? { plan: rowToPlan(row), sortOrder: row.sortOrder || index }
          : { plan: p, sortOrder: index },
      );
    });
    for (const row of byId.values()) {
      if (row.archived) continue;
      entries.push({ plan: rowToPlan(row), sortOrder: row.sortOrder });
    }

    entries.sort((a, b) => a.sortOrder - b.sortOrder);
    plans = entries.map((e) => e.plan);

    // Never serve an empty catalog: the fallback plan is undeletable, but be
    // defensive against manual DB edits.
    if (plans.length === 0) plans = DEFAULT_PLANS;
  } catch (error) {
    // Serve the built-in defaults rather than failing every quota check and
    // the public /plans endpoint if the overrides table is unreadable. Do NOT
    // cache this degraded result so a recovered DB is picked up immediately.
    logger.error({ err: error }, "Failed to read plan_settings; using default plans");
    return DEFAULT_PLANS;
  }

  cache = { plans, expiresAt: now + CACHE_TTL_MS };
  return plans;
}

function rowToPlan(r: typeof planSettingsTable.$inferSelect): Plan {
  return {
    id: r.id,
    name: r.name,
    priceLabel: r.priceLabel,
    limits: {
      captions: r.captions,
      images: r.images,
      brandKits: r.brandKits,
      scheduledPosts: r.scheduledPosts,
    },
    features: r.features,
    teamSeats: r.teamSeats,
  };
}

export async function getPlan(planId: string): Promise<Plan> {
  const plans = await listPlans();
  return (
    plans.find((p) => p.id === planId) ??
    plans.find((p) => p.id === FALLBACK_PLAN_ID) ??
    plans[0]!
  );
}

export async function getPlanLimits(planId: string): Promise<PlanLimits> {
  return (await getPlan(planId)).limits;
}
