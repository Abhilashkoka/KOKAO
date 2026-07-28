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
    id: "upgradeRequests",
    label: "Upgrade Requests",
    description:
      "Letting team members ask the workspace owner for a plan upgrade from the Billing page.",
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
    id: "wallet",
    label: "Prepaid Wallet (₹)",
    description:
      "Master switch for rupee wallet billing: recharge with GST added at checkout, and every AI generation charged the real provider cost plus your platform fee. When off, every workspace falls back to plan quotas and unit credits regardless of its per-tenant setting — nothing is deducted and the wallet is hidden.",
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
  {
    id: "assetLibrary",
    label: "Asset Library",
    description:
      "Saved visual assets on the Brands page, reusable as reference images in AI Studio and source photos in the Video Studio.",
  },
  {
    id: "videoGen",
    label: "Video Studio",
    description:
      "AI video generation (text-to-video, image-to-video), photo slideshows, and Google Drive photo import.",
  },
  {
    id: "imageJobs",
    label: "Background Image Jobs",
    description:
      "Async AI image generation in AI Studio: images render as background jobs the browser polls, instead of one long blocking request. When off, the studio falls back to synchronous generation.",
  },
  {
    id: "signupCredits",
    label: "Signup Credits",
    description:
      "Automatically granting the configured welcome credit bundle to every brand-new workspace at first sign-in.",
  },
  {
    id: "quests",
    label: "Quests",
    description:
      "Getting-started quests in AI Studio that reward small credit bonuses (per-plan tuning on the Plans tab).",
  },
  {
    id: "streaks",
    label: "Streaks",
    description:
      "Daily creation streaks with milestone credit rewards (per-plan tuning on the Plans tab).",
  },
  {
    id: "referrals",
    label: "Referral Credits",
    description:
      "Personal invite codes: new users get bonus credits, referrers earn credits per signup (per-plan tuning on the Plans tab).",
  },
  {
    id: "freeWatermark",
    label: "Plan Watermark",
    description:
      "Stamps a 'Made with KOKAO.in' watermark on AI-generated images and videos for workspaces on plans with the watermark switch on (Plans tab).",
  },
  {
    id: "calendar",
    label: "Content Calendar",
    description:
      "The monthly calendar view of scheduled and published posts.",
  },
  {
    id: "postMetrics",
    label: "Post Performance",
    description:
      "Pulling per-post engagement metrics (likes, comments, shares, reach) back from Facebook, Instagram, and LinkedIn, and the performance displays built on them.",
  },
  {
    id: "campaigns",
    label: "Campaigns",
    description:
      "Persistent campaign containers: grouping content under a goal and the aggregated campaign performance report.",
  },
  {
    id: "studioQuickPublish",
    label: "Studio Quick Publish",
    description:
      "The inline publish panel in AI Studio: post now or schedule right after generating, plus campaign 'Schedule the week'.",
  },
  {
    id: "campaignStreaming",
    label: "Campaign Streaming",
    description:
      "Streaming campaign generation in AI Studio: platform captions appear live as they are written instead of after one long wait. When off, the studio falls back to the standard campaign request.",
  },
  {
    id: "composer",
    label: "Library Composer",
    description:
      "The one-sheet Publish / Schedule composer on Content Library cards: media preview, inline caption editing, and multi-platform publish or schedule in one place. When off, the library falls back to the legacy per-platform dialogs.",
  },
  {
    id: "viralToolkit",
    label: "Viral Toolkit",
    description:
      "Hook ideas and topic templates in the Video Studio, plus the multi-platform Platform Pack generator in AI Studio.",
  },
  {
    id: "brandVideo",
    label: "Brand Video",
    description:
      "Brand kits steering topic videos: brand voice in the script, brand colour on captions, and the brand logo watermarked on every frame. When off, the Brand kit picker is hidden and all videos render unbranded.",
  },
  {
    id: "providerResilience",
    label: "Provider Preflight",
    description:
      "Checks a video job's provider dependencies before any quota or credits are taken: a missing key refuses with a clear message, and a provider that is already failing asks the tenant to retry in a few minutes. When off, jobs fund immediately and rely on refunds if they fail.",
  },
  {
    id: "archivalFootage",
    label: "Archival Stock Footage",
    description:
      "Wikimedia Commons as a keyless, public-domain stock footage source for topic videos: selectable outright as Commons (archival) and used as failover when the keyed libraries are down or empty. When off, the picker option is hidden and only keyed libraries (Pexels, Pixabay) are used.",
  },
  {
    id: "imageLooks",
    label: "Image Look Presets",
    description:
      "The Look row in AI Studio image briefs: genre presets and camera detail pills that compile into photographic direction for the image model. When off, the row is hidden and prompts are sent exactly as typed.",
  },
  {
    id: "providerScoring",
    label: "Provider Auto-Scoring",
    description:
      "Evidence-based routing for image generation and speech-to-text fallbacks: providers are scored per request on recent success rate, speed, price, and quality, and the Auto option in the admin picker follows that ranking. When off, an Auto selection falls back to the built-in default provider and fallbacks are ordered by circuit-breaker health only.",
  },
  {
    id: "planGate",
    label: "Pre-render Plan Gate",
    description:
      "Scores a topic video's cut plan before the render: repairs held shots, warns on slow cut rates, and refuses (with refund) plans that would come out as one repeated still. When off, plans render exactly as submitted.",
  },
  {
    id: "referenceStyles",
    label: "Reference Styles",
    description:
      "Reference-video style profiles for topic videos: upload a video, analyze its pacing and hook shape once, and reuse it to steer scripts. When off, the picker and manager are hidden and all videos render without reference styling.",
  },
  {
    id: "progressMeter",
    label: "Upgrade Progress Meter",
    description:
      "The usage progress meter in AI Studio that nudges tenants on limited plans toward an upgrade.",
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
 * Like requireFeature, but passes when ANY of the given switches is on.
 * Used for endpoints that serve several mechanics at once (e.g. the
 * gamification state endpoint covers quests, streaks, referrals, and the
 * progress meter). Fails OPEN on DB errors, same as requireFeature.
 */
export function requireAnyFeature(...ids: FeatureId[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const flags = await getFeatureFlags();
      if (!ids.some((id) => flags[id])) {
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
