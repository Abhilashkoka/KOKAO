/**
 * Per-post engagement metrics: fetchers that pull cumulative counters back
 * from the platforms (Meta + LinkedIn first), plus the decay schedule that
 * decides when a post is next refreshed.
 *
 * Counters are cumulative platform totals, so each fetch simply overwrites
 * the row — no history bookkeeping. A fetch either returns counters, reports
 * a transient problem (network blip / 5xx — try again later without
 * penalty), or a definitive rejection (deleted post, dead token — stop
 * polling that row and record the reason).
 */
import { db, connectedAccountsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { platformFetch, PlatformTimeoutError } from "./platformFetch";
import { decryptJson } from "./secretCrypto";
import { GRAPH_BASE, type FacebookCredentials } from "./metaApi";

export const LINKEDIN_REST_BASE = "https://api.linkedin.com/rest";
const LINKEDIN_VERSION = process.env.LINKEDIN_API_VERSION || "202506";

/** Track a post for this long after publish, then stop. */
export const METRICS_TRACKING_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** Refresh hot posts (first 48h) this often. */
export const METRICS_HOT_INTERVAL_MS = 60 * 60 * 1000;

/** After the hot window, refresh daily until the tracking window ends. */
export const METRICS_COLD_INTERVAL_MS = 24 * 60 * 60 * 1000;

const HOT_WINDOW_MS = 48 * 60 * 60 * 1000;

/** Platforms the metrics poller knows how to fetch. */
export const METRICS_PLATFORMS = ["facebook", "instagram", "linkedin"] as const;
export type MetricsPlatform = (typeof METRICS_PLATFORMS)[number];

export function isMetricsPlatform(p: string): p is MetricsPlatform {
  return (METRICS_PLATFORMS as readonly string[]).includes(p);
}

/**
 * When to poll a post next, based on how old it is. Returns null when the
 * tracking window has ended (caller marks the row done).
 */
export function nextPollAt(publishedAt: Date, now = new Date()): Date | null {
  const age = now.getTime() - publishedAt.getTime();
  if (age >= METRICS_TRACKING_WINDOW_MS) return null;
  const interval =
    age < HOT_WINDOW_MS ? METRICS_HOT_INTERVAL_MS : METRICS_COLD_INTERVAL_MS;
  // Never schedule past the end of the tracking window by more than one
  // interval; the final poll lands whenever the next tick sees it due.
  return new Date(now.getTime() + interval);
}

export interface MetricCounters {
  likes: number;
  comments: number;
  shares: number;
  impressions: number;
}

export type MetricsFetchResult =
  | { ok: true; counters: MetricCounters }
  | { ok: false; transient: boolean; error: string };

function transient(error: string): MetricsFetchResult {
  return { ok: false, transient: true, error };
}
function rejected(error: string): MetricsFetchResult {
  return { ok: false, transient: false, error };
}

function asCount(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0
    ? Math.floor(v)
    : 0;
}

/** Classify an HTTP failure: 5xx/429 are transient, other 4xx definitive. */
function classifyStatus(status: number, message: string): MetricsFetchResult {
  if (status >= 500 || status === 429) return transient(message);
  return rejected(message);
}

async function loadAccount(tenantId: number, platform: string) {
  return (
    await db
      .select()
      .from(connectedAccountsTable)
      .where(
        and(
          eq(connectedAccountsTable.tenantId, tenantId),
          eq(connectedAccountsTable.platform, platform),
        ),
      )
      .limit(1)
  )[0];
}

/** The tenant's Facebook Page token (shared by FB and IG metrics). */
async function loadPageToken(tenantId: number): Promise<string | null> {
  const row = await loadAccount(tenantId, "facebook");
  if (!row?.encryptedCredentials) return null;
  try {
    return decryptJson<FacebookCredentials>(row.encryptedCredentials)
      .pageAccessToken;
  } catch {
    return null;
  }
}

interface GraphErrorShape {
  error?: { message?: string; code?: number };
}

/**
 * Facebook Page post: likes/comments/shares from the post node; impressions
 * from post insights (best-effort — some Pages lack the metric).
 */
export async function fetchFacebookPostMetrics(
  tenantId: number,
  postId: string,
): Promise<MetricsFetchResult> {
  const token = await loadPageToken(tenantId);
  if (!token) return rejected("Facebook Page is not connected");
  try {
    const res = await platformFetch(
      `${GRAPH_BASE}/${encodeURIComponent(postId)}` +
        `?fields=likes.summary(true),comments.summary(true),shares`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const json = (await res.json().catch(() => ({}))) as GraphErrorShape & {
      likes?: { summary?: { total_count?: number } };
      comments?: { summary?: { total_count?: number } };
      shares?: { count?: number };
    };
    if (!res.ok) {
      return classifyStatus(
        res.status,
        json.error?.message || `Meta API error (${res.status})`,
      );
    }
    const counters: MetricCounters = {
      likes: asCount(json.likes?.summary?.total_count),
      comments: asCount(json.comments?.summary?.total_count),
      shares: asCount(json.shares?.count),
      impressions: 0,
    };
    // Impressions are a separate insights call; missing metric is not fatal.
    try {
      const ins = await platformFetch(
        `${GRAPH_BASE}/${encodeURIComponent(postId)}/insights?metric=post_impressions`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const insJson = (await ins.json().catch(() => ({}))) as {
        data?: Array<{ values?: Array<{ value?: number }> }>;
      };
      if (ins.ok) {
        counters.impressions = asCount(insJson.data?.[0]?.values?.[0]?.value);
      }
    } catch {
      // best-effort
    }
    return { ok: true, counters };
  } catch (err) {
    if (err instanceof PlatformTimeoutError) return transient(err.message);
    return transient(err instanceof Error ? err.message : "Network error");
  }
}

/**
 * Instagram media: like_count/comments_count from the media node (rides the
 * Facebook Page token); reach from media insights, best-effort.
 */
export async function fetchInstagramPostMetrics(
  tenantId: number,
  mediaId: string,
): Promise<MetricsFetchResult> {
  const token = await loadPageToken(tenantId);
  if (!token) return rejected("Facebook Page is not connected");
  try {
    const res = await platformFetch(
      `${GRAPH_BASE}/${encodeURIComponent(mediaId)}?fields=like_count,comments_count`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const json = (await res.json().catch(() => ({}))) as GraphErrorShape & {
      like_count?: number;
      comments_count?: number;
    };
    if (!res.ok) {
      return classifyStatus(
        res.status,
        json.error?.message || `Meta API error (${res.status})`,
      );
    }
    const counters: MetricCounters = {
      likes: asCount(json.like_count),
      comments: asCount(json.comments_count),
      shares: 0,
      impressions: 0,
    };
    try {
      const ins = await platformFetch(
        `${GRAPH_BASE}/${encodeURIComponent(mediaId)}/insights?metric=reach`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const insJson = (await ins.json().catch(() => ({}))) as {
        data?: Array<{ values?: Array<{ value?: number }> }>;
      };
      if (ins.ok) {
        counters.impressions = asCount(insJson.data?.[0]?.values?.[0]?.value);
      }
    } catch {
      // best-effort
    }
    return { ok: true, counters };
  } catch (err) {
    if (err instanceof PlatformTimeoutError) return transient(err.message);
    return transient(err instanceof Error ? err.message : "Network error");
  }
}

/**
 * LinkedIn member post: likes/comments from socialActions summaries. Member
 * posts expose no share or impression counts to the API — those stay 0.
 */
export async function fetchLinkedinPostMetrics(
  tenantId: number,
  postUrn: string,
): Promise<MetricsFetchResult> {
  const row = await loadAccount(tenantId, "linkedin");
  if (!row?.accessToken) return rejected("LinkedIn is not connected");
  if (row.tokenExpiresAt !== null && row.tokenExpiresAt.getTime() <= Date.now()) {
    // The connection sweep owns silent refresh; from here an expired token
    // is just "try again later" — the next poll uses the refreshed token.
    return transient("LinkedIn token expired; awaiting refresh");
  }
  try {
    const res = await platformFetch(
      `${LINKEDIN_REST_BASE}/socialActions/${encodeURIComponent(postUrn)}`,
      {
        headers: {
          Authorization: `Bearer ${row.accessToken}`,
          "LinkedIn-Version": LINKEDIN_VERSION,
          "X-Restli-Protocol-Version": "2.0.0",
        },
      },
    );
    const json = (await res.json().catch(() => ({}))) as {
      message?: string;
      likesSummary?: { totalLikes?: number };
      commentsSummary?: { aggregatedTotalComments?: number; totalFirstLevelComments?: number };
    };
    if (!res.ok) {
      return classifyStatus(
        res.status,
        json.message || `LinkedIn API error (${res.status})`,
      );
    }
    return {
      ok: true,
      counters: {
        likes: asCount(json.likesSummary?.totalLikes),
        comments: asCount(
          json.commentsSummary?.aggregatedTotalComments ??
            json.commentsSummary?.totalFirstLevelComments,
        ),
        shares: 0,
        impressions: 0,
      },
    };
  } catch (err) {
    if (err instanceof PlatformTimeoutError) return transient(err.message);
    return transient(err instanceof Error ? err.message : "Network error");
  }
}

export const METRICS_FETCHERS: Record<
  MetricsPlatform,
  (tenantId: number, postId: string) => Promise<MetricsFetchResult>
> = {
  facebook: fetchFacebookPostMetrics,
  instagram: fetchInstagramPostMetrics,
  linkedin: fetchLinkedinPostMetrics,
};
