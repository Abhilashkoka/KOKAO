/**
 * On-demand "Social Health Report" audit engine. Runs a battery of checks
 * for one tenant built ENTIRELY from data KOKAO already stores (connected
 * accounts + sweep fail streaks, content library, scheduled posts, usage
 * events, brand kits) — no platform APIs are called.
 *
 * Scoring model (inspired by claude-ads): every check returns
 * pass / fail / unknown / not_applicable. The 0-100 score is computed from
 * KNOWN checks only (pass+fail); unknown checks lower the separate evidence
 * coverage percentage instead, and not_applicable checks are excluded from
 * both. Coverage grade: >=80% graded, 60-79% provisional, <60% insufficient.
 */
import {
  db,
  connectedAccountsTable,
  contentItemsTable,
  scheduledPostsTable,
  brandKitsTable,
  sweepStatusTable,
  tenantsTable,
  healthReportsTable,
  HEALTH_REPORT_HISTORY_LIMIT,
  type HealthCheckResult,
  type HealthCheckStatus,
  type HealthCategoryScore,
  type HealthReportPayload,
  type HealthReport,
} from "@workspace/db";
import { and, eq, gte, lt, desc, sql, inArray, notInArray } from "drizzle-orm";
import { getUsage } from "./usage";
import { getPlanLimits } from "./plans";

const DAY_MS = 86_400_000;

/** Sweep fail streak length treated as a chronic connection breakage. */
const CHRONIC_STREAK = 3;

/** Tokens expiring within this window are flagged. */
const TOKEN_EXPIRY_WINDOW_MS = 7 * DAY_MS;

/** Minimum published posts in 30 days for a consistent cadence. */
const MIN_POSTS_30D = 4;

/** Longest acceptable gap (days) between publishes in the last 90 days. */
const MAX_GAP_DAYS = 21;

/** Draft backlog size above which the library is considered clogged. */
const MAX_DRAFT_BACKLOG = 25;

/** Minimum share of recent posts that should carry an image. */
const MIN_IMAGE_RATIO = 0.3;

export const CATEGORY_LABELS: Record<string, string> = {
  connections: "Connections",
  publishing: "Publishing consistency",
  content_mix: "Content mix",
  brand_readiness: "Brand readiness",
  quota_health: "Quota health",
};

interface CheckInput {
  id: string;
  category: keyof typeof CATEGORY_LABELS;
  title: string;
  status: HealthCheckStatus;
  explanation: string;
  evidence?: string[];
  recommendation?: string | null;
  actionPath?: string | null;
}

function check(input: CheckInput): HealthCheckResult {
  return {
    id: input.id,
    category: input.category,
    title: input.title,
    status: input.status,
    explanation: input.explanation,
    evidence: input.evidence ?? [],
    recommendation: input.recommendation ?? null,
    actionPath: input.actionPath ?? null,
  };
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Everything the checks need, loaded in one pass. */
async function loadAuditData(tenantId: number) {
  const now = new Date();
  const d90 = new Date(now.getTime() - 90 * DAY_MS);
  const [accounts, sweepRow, tenantRow, items90, draftCount, staleScheduled, brandKits, recentBrandUse, usage] =
    await Promise.all([
      db
        .select({
          platform: connectedAccountsTable.platform,
          verifyStatus: connectedAccountsTable.verifyStatus,
          verifyError: connectedAccountsTable.verifyError,
          verifiedAt: connectedAccountsTable.verifiedAt,
          tokenExpiresAt: connectedAccountsTable.tokenExpiresAt,
        })
        .from(connectedAccountsTable)
        .where(eq(connectedAccountsTable.tenantId, tenantId)),
      db
        .select({ failStreaks: sweepStatusTable.failStreaks })
        .from(sweepStatusTable)
        .where(eq(sweepStatusTable.id, 1))
        .limit(1)
        .then((r) => r[0] ?? null),
      db
        .select({ plan: tenantsTable.plan })
        .from(tenantsTable)
        .where(eq(tenantsTable.id, tenantId))
        .limit(1)
        .then((r) => r[0] ?? null),
      db
        .select({
          status: contentItemsTable.status,
          platform: contentItemsTable.platform,
          imagePath: contentItemsTable.imagePath,
          brandKitId: contentItemsTable.brandKitId,
          failureReason: contentItemsTable.failureReason,
          publishedPlatforms: contentItemsTable.publishedPlatforms,
          createdAt: contentItemsTable.createdAt,
          updatedAt: contentItemsTable.updatedAt,
        })
        .from(contentItemsTable)
        .where(
          and(
            eq(contentItemsTable.tenantId, tenantId),
            gte(contentItemsTable.updatedAt, d90),
          ),
        ),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(contentItemsTable)
        .where(
          and(
            eq(contentItemsTable.tenantId, tenantId),
            eq(contentItemsTable.status, "draft"),
          ),
        )
        .then((r) => r[0]?.count ?? 0),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(scheduledPostsTable)
        .where(
          and(
            eq(scheduledPostsTable.tenantId, tenantId),
            eq(scheduledPostsTable.status, "pending"),
            lt(scheduledPostsTable.scheduledAt, new Date(now.getTime() - 3 * DAY_MS)),
          ),
        )
        .then((r) => r[0]?.count ?? 0),
      db
        .select({
          status: brandKitsTable.status,
          isDefault: brandKitsTable.isDefault,
          isArchived: brandKitsTable.isArchived,
        })
        .from(brandKitsTable)
        .where(eq(brandKitsTable.tenantId, tenantId)),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(contentItemsTable)
        .where(
          and(
            eq(contentItemsTable.tenantId, tenantId),
            gte(contentItemsTable.createdAt, new Date(now.getTime() - 30 * DAY_MS)),
            sql`${contentItemsTable.brandKitId} IS NOT NULL`,
          ),
        )
        .then((r) => r[0]?.count ?? 0),
      getUsage(tenantId),
    ]);
  const limits = await getPlanLimits(tenantRow?.plan ?? "free");
  return {
    now,
    tenantId,
    accounts,
    failStreaks: sweepRow?.failStreaks ?? null,
    items90,
    draftCount,
    staleScheduled,
    brandKits: brandKits.filter((k) => !k.isArchived),
    recentBrandUse,
    usage,
    limits,
  };
}

type AuditData = Awaited<ReturnType<typeof loadAuditData>>;

/** Published timestamps (ms) inside the window, from the publish-history map. */
function publishTimes(data: AuditData, sinceMs: number): number[] {
  const times: number[] = [];
  for (const item of data.items90) {
    for (const info of Object.values(item.publishedPlatforms ?? {})) {
      const t = Date.parse(info.publishedAt);
      if (Number.isFinite(t) && t >= sinceMs) times.push(t);
    }
  }
  return times.sort((a, b) => a - b);
}

function connectionChecks(data: AuditData): HealthCheckResult[] {
  const out: HealthCheckResult[] = [];
  const { accounts, now } = data;

  out.push(
    accounts.length === 0
      ? check({
          id: "accounts_connected",
          category: "connections",
          title: "Social accounts connected",
          status: "fail",
          explanation: "No social accounts are connected, so nothing can be published.",
          evidence: [`0 connected accounts as of ${fmtDate(now)}`],
          recommendation: "Connect at least one social account.",
          actionPath: "/accounts",
        })
      : check({
          id: "accounts_connected",
          category: "connections",
          title: "Social accounts connected",
          status: "pass",
          explanation: `${accounts.length} social account${accounts.length === 1 ? "" : "s"} connected.`,
          evidence: [
            `${accounts.length} connected: ${accounts.map((a) => a.platform).join(", ")}`,
          ],
        }),
  );

  if (accounts.length === 0) {
    out.push(
      check({
        id: "connections_verified",
        category: "connections",
        title: "Connections verified and healthy",
        status: "not_applicable",
        explanation: "No accounts to verify.",
      }),
      check({
        id: "tokens_not_expiring",
        category: "connections",
        title: "No tokens about to expire",
        status: "not_applicable",
        explanation: "No accounts, so no tokens to check.",
      }),
      check({
        id: "no_chronic_failures",
        category: "connections",
        title: "No chronic connection failures",
        status: "not_applicable",
        explanation: "No accounts, so no failure history to check.",
      }),
    );
    return out;
  }

  // The reverify paths persist "verified" (see socialReverify.ts); accept the
  // legacy "ok" value too so older rows never read as unknown.
  const verified = accounts.filter(
    (a) => a.verifyStatus === "verified" || a.verifyStatus === "ok",
  );
  const failed = accounts.filter((a) => a.verifyStatus === "failed");
  const untested = accounts.filter((a) => !a.verifyStatus);
  if (failed.length > 0) {
    out.push(
      check({
        id: "connections_verified",
        category: "connections",
        title: "Connections verified and healthy",
        status: "fail",
        explanation: `${failed.length} connection${failed.length === 1 ? "" : "s"} failed the last automatic check.`,
        evidence: failed.map(
          (a) =>
            `${a.platform}: last check failed${a.verifiedAt ? ` on ${fmtDate(a.verifiedAt)}` : ""}${a.verifyError ? ` (${a.verifyError})` : ""}`,
        ),
        recommendation: "Reconnect the failing accounts.",
        actionPath: "/accounts",
      }),
    );
  } else if (verified.length > 0 && untested.length === 0) {
    out.push(
      check({
        id: "connections_verified",
        category: "connections",
        title: "Connections verified and healthy",
        status: "pass",
        explanation: "Every connection passed its last automatic check.",
        evidence: verified.map(
          (a) => `${a.platform}: verified${a.verifiedAt ? ` on ${fmtDate(a.verifiedAt)}` : ""}`,
        ),
      }),
    );
  } else {
    out.push(
      check({
        id: "connections_verified",
        category: "connections",
        title: "Connections verified and healthy",
        status: "unknown",
        explanation:
          verified.length > 0
            ? `${verified.length} connection${verified.length === 1 ? "" : "s"} verified, but ${untested.length} ${untested.length === 1 ? "has" : "have"} not been automatically tested yet.`
            : `${untested.length} connection${untested.length === 1 ? " has" : "s have"} not been automatically tested yet.`,
        recommendation: "Open the Accounts page to trigger a verification.",
        actionPath: "/accounts",
      }),
    );
  }

  const withExpiry = accounts.filter((a) => a.tokenExpiresAt);
  const expiring = withExpiry.filter(
    (a) => a.tokenExpiresAt!.getTime() - now.getTime() < TOKEN_EXPIRY_WINDOW_MS,
  );
  if (withExpiry.length === 0) {
    out.push(
      check({
        id: "tokens_not_expiring",
        category: "connections",
        title: "No tokens about to expire",
        status: "unknown",
        explanation: "None of the connections report a token expiry date.",
      }),
    );
  } else if (expiring.length > 0) {
    out.push(
      check({
        id: "tokens_not_expiring",
        category: "connections",
        title: "No tokens about to expire",
        status: "fail",
        explanation: `${expiring.length} token${expiring.length === 1 ? "" : "s"} expire${expiring.length === 1 ? "s" : ""} within 7 days.`,
        evidence: expiring.map(
          (a) => `${a.platform}: token expires ${fmtDate(a.tokenExpiresAt!)}`,
        ),
        recommendation: "Reconnect these accounts before the token expires.",
        actionPath: "/accounts",
      }),
    );
  } else {
    out.push(
      check({
        id: "tokens_not_expiring",
        category: "connections",
        title: "No tokens about to expire",
        status: "pass",
        explanation: "No stored token expires within the next 7 days.",
        evidence: withExpiry.map(
          (a) => `${a.platform}: token valid until ${fmtDate(a.tokenExpiresAt!)}`,
        ),
      }),
    );
  }

  if (data.failStreaks === null) {
    out.push(
      check({
        id: "no_chronic_failures",
        category: "connections",
        title: "No chronic connection failures",
        status: "unknown",
        explanation: "The background connection checker has not recorded a run yet.",
      }),
    );
  } else {
    const platforms = new Set(accounts.map((a) => a.platform));
    const chronic = Object.entries(data.failStreaks).filter(([key, streak]) => {
      const idx = key.indexOf(":");
      const tid = Number(key.slice(0, idx));
      const platform = key.slice(idx + 1);
      return (
        tid === data.tenantId &&
        platforms.has(platform) &&
        streak.count >= CHRONIC_STREAK
      );
    });
    out.push(
      chronic.length > 0
        ? check({
            id: "no_chronic_failures",
            category: "connections",
            title: "No chronic connection failures",
            status: "fail",
            explanation: `${chronic.length} connection${chronic.length === 1 ? " keeps" : "s keep"} failing the automatic background checks.`,
            evidence: chronic.map(([key, s]) => {
              const platform = key.slice(key.indexOf(":") + 1);
              return `${platform}: failed ${s.count} checks in a row since ${fmtDate(new Date(s.firstFailedAt))}`;
            }),
            recommendation: "Reconnect the accounts that keep failing.",
            actionPath: "/accounts",
          })
        : check({
            id: "no_chronic_failures",
            category: "connections",
            title: "No chronic connection failures",
            status: "pass",
            explanation: "No connection is repeatedly failing the background checks.",
            evidence: [`No chronic failure streaks as of ${fmtDate(now)}`],
          }),
    );
  }
  return out;
}

function publishingChecks(data: AuditData): HealthCheckResult[] {
  const out: HealthCheckResult[] = [];
  const { now, accounts } = data;
  const na = accounts.length === 0;

  const t30 = publishTimes(data, now.getTime() - 30 * DAY_MS);
  const t90 = publishTimes(data, now.getTime() - 90 * DAY_MS);

  if (na) {
    out.push(
      check({
        id: "posting_frequency",
        category: "publishing",
        title: "Consistent posting in the last 30 days",
        status: "not_applicable",
        explanation: "No accounts are connected, so publishing cannot be assessed.",
      }),
      check({
        id: "no_long_gaps",
        category: "publishing",
        title: "No long gaps in the last 90 days",
        status: "not_applicable",
        explanation: "No accounts are connected, so publishing cannot be assessed.",
      }),
    );
  } else {
    out.push(
      t30.length >= MIN_POSTS_30D
        ? check({
            id: "posting_frequency",
            category: "publishing",
            title: "Consistent posting in the last 30 days",
            status: "pass",
            explanation: `Published ${t30.length} times in the last 30 days.`,
            evidence: [`${t30.length} posts published between ${fmtDate(new Date(now.getTime() - 30 * DAY_MS))} and ${fmtDate(now)}`],
          })
        : check({
            id: "posting_frequency",
            category: "publishing",
            title: "Consistent posting in the last 30 days",
            status: "fail",
            explanation: `Only ${t30.length} post${t30.length === 1 ? "" : "s"} published in the last 30 days (target: at least ${MIN_POSTS_30D}).`,
            evidence: [`${t30.length} posts in the last 30 days as of ${fmtDate(now)}`],
            recommendation: "Publish more regularly — aim for at least one post a week.",
            actionPath: "/library",
          }),
    );

    if (t90.length < 2) {
      out.push(
        check({
          id: "no_long_gaps",
          category: "publishing",
          title: "No long gaps in the last 90 days",
          status: t90.length === 0 ? "fail" : "unknown",
          explanation:
            t90.length === 0
              ? "Nothing was published in the last 90 days."
              : "Only one post in the last 90 days — not enough to measure gaps.",
          evidence: [`${t90.length} posts in the last 90 days as of ${fmtDate(now)}`],
          recommendation: t90.length === 0 ? "Start publishing from your library." : null,
          actionPath: t90.length === 0 ? "/library" : null,
        }),
      );
    } else {
      let maxGap = 0;
      for (let i = 1; i < t90.length; i++) maxGap = Math.max(maxGap, t90[i]! - t90[i - 1]!);
      maxGap = Math.max(maxGap, now.getTime() - t90[t90.length - 1]!);
      const gapDays = Math.round(maxGap / DAY_MS);
      out.push(
        gapDays <= MAX_GAP_DAYS
          ? check({
              id: "no_long_gaps",
              category: "publishing",
              title: "No long gaps in the last 90 days",
              status: "pass",
              explanation: `Longest quiet stretch was ${gapDays} day${gapDays === 1 ? "" : "s"}.`,
              evidence: [`Longest gap between posts: ${gapDays} days (${t90.length} posts in 90 days)`],
            })
          : check({
              id: "no_long_gaps",
              category: "publishing",
              title: "No long gaps in the last 90 days",
              status: "fail",
              explanation: `There was a ${gapDays}-day stretch with no posts (target: under ${MAX_GAP_DAYS} days).`,
              evidence: [`Longest gap between posts: ${gapDays} days (${t90.length} posts in 90 days)`],
              recommendation: "Schedule posts ahead to avoid long quiet stretches.",
              actionPath: "/schedule",
            }),
      );
    }
  }

  out.push(
    data.staleScheduled > 0
      ? check({
          id: "no_stale_scheduled",
          category: "publishing",
          title: "No overdue scheduled posts",
          status: "fail",
          explanation: `${data.staleScheduled} scheduled post${data.staleScheduled === 1 ? " is" : "s are"} more than 3 days past the planned time and still unpublished.`,
          evidence: [`${data.staleScheduled} overdue scheduled posts as of ${fmtDate(now)}`],
          recommendation: "Publish or reschedule the overdue posts. Note: scheduling records the plan — publishing is done from the library.",
          actionPath: "/schedule",
        })
      : check({
          id: "no_stale_scheduled",
          category: "publishing",
          title: "No overdue scheduled posts",
          status: "pass",
          explanation: "No scheduled post is sitting overdue.",
          evidence: [`0 overdue scheduled posts as of ${fmtDate(now)}`],
        }),
  );

  const failedRecent = data.items90.filter(
    (i) =>
      i.failureReason &&
      i.updatedAt.getTime() >= now.getTime() - 14 * DAY_MS,
  );
  out.push(
    failedRecent.length > 0
      ? check({
          id: "no_recent_publish_failures",
          category: "publishing",
          title: "No recent publish failures",
          status: "fail",
          explanation: `${failedRecent.length} publish failure${failedRecent.length === 1 ? "" : "s"} in the last 14 days.`,
          evidence: failedRecent
            .slice(0, 5)
            .map((i) => `${fmtDate(i.updatedAt)} (${i.platform}): ${i.failureReason}`),
          recommendation: "Review the failed items and retry after fixing the cause.",
          actionPath: "/library",
        })
      : check({
          id: "no_recent_publish_failures",
          category: "publishing",
          title: "No recent publish failures",
          status: "pass",
          explanation: "No publish attempts failed in the last 14 days.",
          evidence: [`0 publish failures in the 14 days up to ${fmtDate(now)}`],
        }),
  );
  return out;
}

function contentMixChecks(data: AuditData): HealthCheckResult[] {
  const out: HealthCheckResult[] = [];
  const { now } = data;

  const platforms = new Set<string>();
  for (const item of data.items90) {
    for (const p of Object.keys(item.publishedPlatforms ?? {})) platforms.add(p);
  }
  if (platforms.size === 0) {
    out.push(
      check({
        id: "platform_balance",
        category: "content_mix",
        title: "Posting across multiple platforms",
        status: "not_applicable",
        explanation: "Nothing has been published in the last 90 days, so platform balance cannot be assessed.",
      }),
    );
  } else {
    out.push(
      platforms.size >= 2
        ? check({
            id: "platform_balance",
            category: "content_mix",
            title: "Posting across multiple platforms",
            status: "pass",
            explanation: `Published to ${platforms.size} platforms in the last 90 days.`,
            evidence: [`Platforms used: ${[...platforms].join(", ")}`],
          })
        : check({
            id: "platform_balance",
            category: "content_mix",
            title: "Posting across multiple platforms",
            status: "fail",
            explanation: `All recent posts went to a single platform (${[...platforms][0]}).`,
            evidence: [`Only ${[...platforms][0]} used in the 90 days up to ${fmtDate(now)}`],
            recommendation: "Repurpose content for a second platform to widen reach.",
            actionPath: "/studio",
          }),
    );
  }

  out.push(
    data.draftCount > MAX_DRAFT_BACKLOG
      ? check({
          id: "draft_backlog",
          category: "content_mix",
          title: "Draft backlog under control",
          status: "fail",
          explanation: `${data.draftCount} drafts are sitting unpublished (target: under ${MAX_DRAFT_BACKLOG}).`,
          evidence: [`${data.draftCount} drafts in the library as of ${fmtDate(now)}`],
          recommendation: "Publish, schedule, or delete old drafts.",
          actionPath: "/library",
        })
      : check({
          id: "draft_backlog",
          category: "content_mix",
          title: "Draft backlog under control",
          status: "pass",
          explanation: `${data.draftCount} draft${data.draftCount === 1 ? "" : "s"} in the library.`,
          evidence: [`${data.draftCount} drafts as of ${fmtDate(now)}`],
        }),
  );

  const recent = data.items90;
  if (recent.length === 0) {
    out.push(
      check({
        id: "image_ratio",
        category: "content_mix",
        title: "Healthy mix of image and text posts",
        status: "unknown",
        explanation: "No content created in the last 90 days to measure.",
      }),
    );
  } else {
    const withImage = recent.filter((i) => i.imagePath).length;
    const ratio = withImage / recent.length;
    const pct = Math.round(ratio * 100);
    out.push(
      ratio >= MIN_IMAGE_RATIO
        ? check({
            id: "image_ratio",
            category: "content_mix",
            title: "Healthy mix of image and text posts",
            status: "pass",
            explanation: `${pct}% of recent content includes an image.`,
            evidence: [`${withImage} of ${recent.length} items in the last 90 days include an image`],
          })
        : check({
            id: "image_ratio",
            category: "content_mix",
            title: "Healthy mix of image and text posts",
            status: "fail",
            explanation: `Only ${pct}% of recent content includes an image (target: at least ${Math.round(MIN_IMAGE_RATIO * 100)}%).`,
            evidence: [`${withImage} of ${recent.length} items in the last 90 days include an image`],
            recommendation: "Add images to more posts — visual content performs better.",
            actionPath: "/studio",
          }),
    );
  }
  return out;
}

function brandReadinessChecks(data: AuditData): HealthCheckResult[] {
  const out: HealthCheckResult[] = [];
  const { now, brandKits } = data;
  const active = brandKits.filter((k) => k.status === "active");

  out.push(
    active.length > 0
      ? check({
          id: "active_brand_kit",
          category: "brand_readiness",
          title: "At least one active brand kit",
          status: "pass",
          explanation: `${active.length} active brand kit${active.length === 1 ? "" : "s"}.`,
          evidence: [`${active.length} active of ${brandKits.length} total brand kits as of ${fmtDate(now)}`],
        })
      : check({
          id: "active_brand_kit",
          category: "brand_readiness",
          title: "At least one active brand kit",
          status: "fail",
          explanation:
            brandKits.length === 0
              ? "No brand kit exists yet, so AI content has no brand rules to follow."
              : "Brand kits exist but none is activated.",
          evidence: [`${brandKits.length} brand kits, 0 active as of ${fmtDate(now)}`],
          recommendation: "Create and activate a brand kit.",
          actionPath: "/brand-kits",
        }),
  );

  if (brandKits.length === 0) {
    out.push(
      check({
        id: "default_brand_kit",
        category: "brand_readiness",
        title: "A default brand kit is set",
        status: "not_applicable",
        explanation: "No brand kits exist yet.",
      }),
    );
  } else {
    const hasDefault = brandKits.some((k) => k.isDefault);
    out.push(
      hasDefault
        ? check({
            id: "default_brand_kit",
            category: "brand_readiness",
            title: "A default brand kit is set",
            status: "pass",
            explanation: "A default brand kit is set, so new content starts on-brand.",
            evidence: [`Default brand kit set as of ${fmtDate(now)}`],
          })
        : check({
            id: "default_brand_kit",
            category: "brand_readiness",
            title: "A default brand kit is set",
            status: "fail",
            explanation: "No brand kit is marked as the default.",
            evidence: [`${brandKits.length} brand kits, none set as default`],
            recommendation: "Mark one brand kit as the default.",
            actionPath: "/brand-kits",
          }),
    );
  }

  const recentItems = data.items90.filter(
    (i) => i.createdAt.getTime() >= data.now.getTime() - 30 * DAY_MS,
  );
  if (active.length === 0) {
    out.push(
      check({
        id: "brand_kit_used",
        category: "brand_readiness",
        title: "Brand kit used in recent content",
        status: "not_applicable",
        explanation: "No active brand kit to use.",
      }),
    );
  } else if (recentItems.length === 0) {
    out.push(
      check({
        id: "brand_kit_used",
        category: "brand_readiness",
        title: "Brand kit used in recent content",
        status: "unknown",
        explanation: "No content was created in the last 30 days to measure.",
      }),
    );
  } else {
    out.push(
      data.recentBrandUse > 0
        ? check({
            id: "brand_kit_used",
            category: "brand_readiness",
            title: "Brand kit used in recent content",
            status: "pass",
            explanation: `${data.recentBrandUse} item${data.recentBrandUse === 1 ? "" : "s"} in the last 30 days used a brand kit.`,
            evidence: [`${data.recentBrandUse} brand-kit-linked items in the 30 days up to ${fmtDate(now)}`],
          })
        : check({
            id: "brand_kit_used",
            category: "brand_readiness",
            title: "Brand kit used in recent content",
            status: "fail",
            explanation: "Recent content was created without a brand kit.",
            evidence: [`0 of ${recentItems.length} items in the last 30 days used a brand kit`],
            recommendation: "Pick a brand kit in the AI Studio when generating content.",
            actionPath: "/studio",
          }),
    );
  }
  return out;
}

function quotaChecks(data: AuditData): HealthCheckResult[] {
  const { now, usage, limits } = data;
  const daysInMonth = new Date(
    now.getUTCFullYear(),
    now.getUTCMonth() + 1,
    0,
  ).getUTCDate();
  const dayOfMonth = now.getUTCDate();
  const monthFraction = dayOfMonth / daysInMonth;

  const one = (
    kind: "captions" | "images",
    used: number,
    limit: number,
  ): HealthCheckResult => {
    const title = kind === "captions" ? "Caption quota on pace" : "Image quota on pace";
    const id = kind === "captions" ? "caption_quota_pace" : "image_quota_pace";
    if (limit === -1) {
      return check({
        id,
        category: "quota_health",
        title,
        status: "pass",
        explanation: `Your plan has unlimited ${kind}.`,
        evidence: [`${used} ${kind} used this month; plan limit: unlimited`],
      });
    }
    if (limit === 0) {
      return check({
        id,
        category: "quota_health",
        title,
        status: "not_applicable",
        explanation: `Your plan has no monthly ${kind} allowance (usage draws from credits).`,
        evidence: [`${used} ${kind} used this month`],
      });
    }
    const projected = monthFraction > 0 ? used / monthFraction : used;
    const willRunOut = projected > limit;
    const usedPct = Math.round((used / limit) * 100);
    if (used >= limit) {
      return check({
        id,
        category: "quota_health",
        title,
        status: "fail",
        explanation: `The monthly ${kind} quota is fully used (${used} of ${limit}).`,
        evidence: [`${used} of ${limit} ${kind} used by day ${dayOfMonth} of ${daysInMonth}`],
        recommendation: "Upgrade the plan or buy credits to keep generating.",
        actionPath: "/settings",
      });
    }
    return willRunOut
      ? check({
          id,
          category: "quota_health",
          title,
          status: "fail",
          explanation: `At the current pace the ${kind} quota will run out before month end (${usedPct}% used with ${daysInMonth - dayOfMonth} days left).`,
          evidence: [
            `${used} of ${limit} ${kind} used by day ${dayOfMonth} of ${daysInMonth} (projected ~${Math.round(projected)} by month end)`,
          ],
          recommendation: "Slow down generation, upgrade the plan, or buy credits.",
          actionPath: "/settings",
        })
      : check({
          id,
          category: "quota_health",
          title,
          status: "pass",
          explanation: `${kind === "captions" ? "Caption" : "Image"} usage is on pace (${usedPct}% used with ${daysInMonth - dayOfMonth} days left in the month).`,
          evidence: [`${used} of ${limit} ${kind} used by day ${dayOfMonth} of ${daysInMonth}`],
        });
  };

  return [
    one("captions", usage.captions, limits.captions),
    one("images", usage.images, limits.images),
  ];
}

export type CoverageGrade = "graded" | "provisional" | "insufficient";

export function coverageGrade(coverage: number): CoverageGrade {
  if (coverage >= 80) return "graded";
  if (coverage >= 60) return "provisional";
  return "insufficient";
}

/** Roll checks up into category scores, overall score, and coverage. */
export function summarize(checks: HealthCheckResult[]): {
  score: number | null;
  coverage: number;
  grade: CoverageGrade;
  categories: HealthCategoryScore[];
} {
  const categories: HealthCategoryScore[] = [];
  for (const [category, label] of Object.entries(CATEGORY_LABELS)) {
    const own = checks.filter((c) => c.category === category);
    const passed = own.filter((c) => c.status === "pass").length;
    const failed = own.filter((c) => c.status === "fail").length;
    const unknown = own.filter((c) => c.status === "unknown").length;
    const notApplicable = own.filter((c) => c.status === "not_applicable").length;
    const known = passed + failed;
    categories.push({
      category,
      label,
      score: known > 0 ? Math.round((passed / known) * 100) : null,
      passed,
      failed,
      unknown,
      notApplicable,
    });
  }
  const passed = checks.filter((c) => c.status === "pass").length;
  const failed = checks.filter((c) => c.status === "fail").length;
  const unknown = checks.filter((c) => c.status === "unknown").length;
  const known = passed + failed;
  const evaluable = known + unknown;
  const coverage = evaluable > 0 ? Math.round((known / evaluable) * 100) : 0;
  return {
    score: known > 0 ? Math.round((passed / known) * 100) : null,
    coverage,
    grade: coverageGrade(coverage),
    categories,
  };
}

/** Run every check for a tenant and return the full payload plus rollups. */
export async function runHealthAudit(tenantId: number): Promise<{
  payload: HealthReportPayload;
  score: number | null;
  coverage: number;
  grade: CoverageGrade;
}> {
  const data = await loadAuditData(tenantId);
  const checks = [
    ...connectionChecks(data),
    ...publishingChecks(data),
    ...contentMixChecks(data),
    ...brandReadinessChecks(data),
    ...quotaChecks(data),
  ];
  const { score, coverage, grade, categories } = summarize(checks);
  return {
    payload: { version: 1, checks, categories },
    score,
    coverage,
    grade,
  };
}

/**
 * Run an audit and persist it, trimming the tenant's history to the bounded
 * limit (newest rows kept). Returns the stored row.
 */
export async function runAndStoreHealthAudit(
  tenantId: number,
): Promise<HealthReport> {
  const { payload, score, coverage, grade } = await runHealthAudit(tenantId);
  const [row] = await db
    .insert(healthReportsTable)
    .values({
      tenantId,
      score,
      coverage,
      coverageGrade: grade,
      report: payload,
    })
    .returning();

  // Trim history beyond the cap. Runs after the insert so the new report is
  // never lost; errors propagate so an over-cap history is never silent.
  const keep = await db
    .select({ id: healthReportsTable.id })
    .from(healthReportsTable)
    .where(eq(healthReportsTable.tenantId, tenantId))
    .orderBy(desc(healthReportsTable.createdAt), desc(healthReportsTable.id))
    .limit(HEALTH_REPORT_HISTORY_LIMIT);
  if (keep.length === HEALTH_REPORT_HISTORY_LIMIT) {
    await db
      .delete(healthReportsTable)
      .where(
        and(
          eq(healthReportsTable.tenantId, tenantId),
          notInArray(
            healthReportsTable.id,
            keep.map((k) => k.id),
          ),
        ),
      );
  }
  return row!;
}
