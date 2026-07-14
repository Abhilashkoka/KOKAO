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
}

export const DEFAULT_PLANS: Plan[] = [
  {
    id: "free",
    name: "Free",
    priceLabel: "$0 / mo",
    limits: { captions: 20, images: 10, brandKits: 1, scheduledPosts: 10 },
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
    features: [
      "Unlimited AI captions",
      "Unlimited AI images",
      "Unlimited brand kits",
      "Unlimited scheduling",
      "Team collaboration",
    ],
  },
];

export const PLAN_IDS = DEFAULT_PLANS.map((p) => p.id);

const CACHE_TTL_MS = 30_000;

let cache: { plans: Plan[]; expiresAt: number } | null = null;

export function invalidatePlanCache(): void {
  cache = null;
}

/**
 * Returns the plan catalog: built-in defaults merged with any superadmin
 * overrides stored in plan_settings. Cached briefly to keep quota checks
 * cheap. Falls back to defaults if the DB read fails.
 */
export async function listPlans(): Promise<Plan[]> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.plans;

  let overrides: Map<string, Plan>;
  try {
    const rows = await db.select().from(planSettingsTable);
    overrides = new Map(
      rows.map((r) => [
        r.id,
        {
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
        },
      ]),
    );
  } catch (error) {
    // Serve the built-in defaults rather than failing every quota check and
    // the public /plans endpoint if the overrides table is unreadable. Do NOT
    // cache this degraded result so a recovered DB is picked up immediately.
    logger.error({ err: error }, "Failed to read plan_settings; using default plans");
    return DEFAULT_PLANS;
  }

  const plans = DEFAULT_PLANS.map((p) => overrides.get(p.id) ?? p);
  cache = { plans, expiresAt: now + CACHE_TTL_MS };
  return plans;
}

export async function getPlan(planId: string): Promise<Plan> {
  const plans = await listPlans();
  return plans.find((p) => p.id === planId) ?? plans[0]!;
}

export async function getPlanLimits(planId: string): Promise<PlanLimits> {
  return (await getPlan(planId)).limits;
}
