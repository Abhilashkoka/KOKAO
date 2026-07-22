import type { Request, Response, NextFunction } from "express";
import { db, featureFlagsTable } from "@workspace/db";

/**
 * Platform-wide feature kill switches, superadmin-controlled.
 *
 * Catalog of the app modules that can be turned off for ALL tenants at once.
 * No DB row = enabled (default-on, same pattern as ads_settings). When a
 * feature is off, its API routes answer 403 { code: "feature_disabled" } and
 * the web app hides the module. Admin routes are never gated, so a superadmin
 * can always turn a feature back on.
 */
export const FEATURES = [
  {
    id: "aiStudio",
    label: "AI Studio",
    description:
      "AI caption/image generation, topic ideas, campaigns, and voice transcription.",
  },
  {
    id: "contentLibrary",
    label: "Content Library",
    description: "Saving, editing, and managing content items.",
  },
  {
    id: "scheduling",
    label: "Scheduling",
    description: "The post schedule queue and automatic publishing of due posts.",
  },
  {
    id: "brandKits",
    label: "Brand Kits",
    description: "Brand kit creation, editing, and the onboarding wizard.",
  },
  {
    id: "connectedAccounts",
    label: "Connected Accounts",
    description:
      "Connecting social accounts and publishing to Facebook, Instagram, LinkedIn, X, Threads, and YouTube.",
  },
  {
    id: "analytics",
    label: "Analytics",
    description: "Tenant-facing analytics reports (event ingestion stays on).",
  },
  {
    id: "team",
    label: "Team",
    description: "Team invites, member management, and seat requests.",
  },
  {
    id: "billing",
    label: "Billing",
    description: "Subscriptions, plan upgrades, and credit pack purchases.",
  },
  {
    id: "pushNotifications",
    label: "Push Notifications",
    description:
      "Mobile push notification delivery and device push-token registration.",
  },
  {
    id: "promoCodes",
    label: "Promo Codes",
    description:
      "Redeeming promotional codes for free credits on the Billing page.",
  },
  {
    id: "carousel",
    label: "Carousel Posts",
    description:
      "Multi-slide carousel generation in AI Studio (per-slide images) and LinkedIn document-carousel publishing.",
  },
  {
    id: "aiSpend",
    label: "AI Spend Display",
    description:
      "Showing the 'AI amount spent' figure on generated captions, images, campaigns, and carousels.",
  },
  {
    id: "aiCostTracking",
    label: "AI Cost Tracking",
    description:
      "Recording the actual provider cost of each AI generation and the superadmin cost report.",
  },
  {
    id: "referenceImages",
    label: "Reference Images",
    description:
      "Uploading a reference image in AI Studio to guide image generation.",
  },
] as const;

export type FeatureId = (typeof FEATURES)[number]["id"];

export const FEATURE_IDS = FEATURES.map((f) => f.id) as FeatureId[];
const FEATURE_ID_SET = new Set<string>(FEATURE_IDS);

export function isKnownFeature(id: string): id is FeatureId {
  return FEATURE_ID_SET.has(id);
}

const CACHE_TTL_MS = 30_000;
let cache: { flags: Record<FeatureId, boolean>; loadedAt: number } | null = null;

export function invalidateFeatureFlagCache(): void {
  cache = null;
}

/** Load all flags (default true when no row exists), with a 30s cache. */
export async function getFeatureFlags(): Promise<Record<FeatureId, boolean>> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache.flags;
  const rows = await db.select().from(featureFlagsTable);
  const byId = new Map(rows.map((r) => [r.feature, r.enabled]));
  const flags = Object.fromEntries(
    FEATURE_IDS.map((id) => [id, byId.get(id) ?? true]),
  ) as Record<FeatureId, boolean>;
  cache = { flags, loadedAt: Date.now() };
  return flags;
}

export async function isFeatureEnabled(id: FeatureId): Promise<boolean> {
  const flags = await getFeatureFlags();
  return flags[id];
}

/**
 * Express middleware factory: rejects requests with 403 feature_disabled when
 * the given platform switch is off. Fails OPEN on DB errors so a transient
 * outage never locks tenants out of the whole app.
 */
export function requireFeature(id: FeatureId) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!(await isFeatureEnabled(id))) {
        res.status(403).json({
          error: "This feature is currently disabled by the administrator.",
          code: "feature_disabled",
        });
        return;
      }
    } catch (error) {
      req.log?.error({ err: error }, "Feature flag check failed; allowing request");
    }
    next();
  };
}
