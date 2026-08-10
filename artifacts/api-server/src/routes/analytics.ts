import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  analyticsEventsTable,
  usageEventsTable,
  userConsentsTable,
  tenantsTable,
  tenantMembersTable,
} from "@workspace/db";
import { and, eq, gte, lte, isNotNull, inArray, sql, type SQL } from "drizzle-orm";
import { fetchVerifiedEmail } from "../lib/clerkUser";
import { isSuperadminEmail } from "../lib/superadmins";

/**
 * Analytics reporting endpoints. Access model:
 * - Superadmin ONLY (verified live, same trust chain as requireSuperadmin):
 *   platform-wide scope; `tenantId` query param drills into one tenant.
 * - Everyone else (workspace owners, admins, members): 403.
 */
const router: IRouter = Router();

interface Scope {
  /** null = platform-wide (superadmin without drilldown). */
  tenantId: number | null;
  platform: boolean;
}

async function resolveScope(req: Request): Promise<Scope | null> {
  let isSuper = false;
  if (req.memberRole === "owner") {
    if (req.tenantIsSuperadmin) {
      isSuper = true;
    } else if (req.isSuperadmin) {
      // Cached hint says superadmin — verify against the LIVE verified email
      // (fails closed to non-superadmin on any Clerk error).
      try {
        const email = await fetchVerifiedEmail(req.clerkUserId);
        isSuper = isSuperadminEmail(email);
      } catch {
        isSuper = false;
      }
    }
  }
  if (isSuper) {
    const raw = req.query.tenantId;
    const parsed = typeof raw === "string" ? Number.parseInt(raw, 10) : NaN;
    return {
      tenantId: Number.isFinite(parsed) ? parsed : null,
      platform: true,
    };
  }
  return null;
}

function parseWindow(req: Request): { from: Date; to: Date } {
  const parse = (v: unknown): Date | null => {
    if (typeof v !== "string") return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const to = parse(req.query.to) ?? new Date();
  const from =
    parse(req.query.from) ?? new Date(to.getTime() - 30 * 86_400_000);
  return { from, to };
}

function eventConds(scope: Scope, from: Date, to: Date): SQL[] {
  const conds: SQL[] = [
    gte(analyticsEventsTable.createdAt, from),
    lte(analyticsEventsTable.createdAt, to),
  ];
  if (scope.tenantId !== null) {
    conds.push(eq(analyticsEventsTable.tenantId, scope.tenantId));
  }
  return conds;
}

/** Distinct actor: signed-in user id, else anonymous id. */
const actor = sql<string>`coalesce(${analyticsEventsTable.clerkUserId}, ${analyticsEventsTable.anonymousId})`;

type Handler = (
  req: Request,
  scope: Scope,
  from: Date,
  to: Date,
) => Promise<unknown>;

function analyticsRoute(path: string, handler: Handler): void {
  router.get(path, async (req: Request, res: Response) => {
    try {
      const scope = await resolveScope(req);
      if (!scope) {
        res.status(403).json({ error: "Analytics are available to platform administrators only" });
        return;
      }
      const { from, to } = parseWindow(req);
      res.json(await handler(req, scope, from, to));
    } catch (error) {
      req.log.error({ err: error, path }, "Analytics query failed");
      res.status(500).json({ error: "Failed to load analytics" });
    }
  });
}

async function topCounts(
  field: SQL<string | null>,
  conds: SQL[],
  limit = 10,
): Promise<{ name: string; count: number }[]> {
  const rows = await db
    .select({ name: field, count: sql<number>`count(*)::int` })
    .from(analyticsEventsTable)
    .where(and(...conds, sql`${field} IS NOT NULL`))
    .groupBy(field)
    .orderBy(sql`count(*) DESC`)
    .limit(limit);
  return rows.map((r) => ({ name: r.name ?? "unknown", count: r.count }));
}

analyticsRoute("/analytics/audience", async (_req, scope, from, to) => {
  const conds = eventConds(scope, from, to);
  const notServer = sql`${analyticsEventsTable.platform} IS DISTINCT FROM 'server'`;

  const [dauRows, mauRow, sessionRows, retention, countries, platforms, browsers, deviceModels] =
    await Promise.all([
      db
        .select({
          date: sql<string>`to_char(${analyticsEventsTable.createdAt}, 'YYYY-MM-DD')`,
          count: sql<number>`count(distinct ${actor})::int`,
        })
        .from(analyticsEventsTable)
        .where(and(...conds, notServer))
        .groupBy(sql`1`)
        .orderBy(sql`1`),
      db
        .select({ mau: sql<number>`count(distinct ${actor})::int` })
        .from(analyticsEventsTable)
        .where(and(...conds, notServer)),
      db
        .select({
          sessions: sql<number>`count(*)::int`,
          avgLen: sql<number>`coalesce(avg(len), 0)::float`,
        })
        .from(
          db
            .select({
              sessionId: analyticsEventsTable.sessionId,
              len: sql<number>`extract(epoch from (max(${analyticsEventsTable.createdAt}) - min(${analyticsEventsTable.createdAt})))`.as(
                "len",
              ),
            })
            .from(analyticsEventsTable)
            .where(and(...conds, notServer, isNotNull(analyticsEventsTable.sessionId)))
            .groupBy(analyticsEventsTable.sessionId)
            .as("s"),
        ),
      (async () => {
        // Sign-up cohort in the window; retained = any later event past N days.
        const cohort = await db
          .select({
            user: sql<string>`${actor}`,
            signedUpAt: sql<string>`min(${analyticsEventsTable.createdAt})`,
          })
          .from(analyticsEventsTable)
          .where(and(...conds, eq(analyticsEventsTable.eventName, "sign_up")))
          .groupBy(sql`1`);
        if (cohort.length === 0) return { d1: 0, d7: 0, d30: 0 };
        const users = cohort.map((c) => c.user);
        const lastSeen = await db
          .select({
            user: sql<string>`${actor}`,
            last: sql<string>`max(${analyticsEventsTable.createdAt})`,
          })
          .from(analyticsEventsTable)
          .where(
            and(
              scope.tenantId !== null
                ? eq(analyticsEventsTable.tenantId, scope.tenantId)
                : sql`true`,
              inArray(actor, users),
            ),
          )
          .groupBy(sql`1`);
        const lastByUser = new Map(lastSeen.map((r) => [r.user, new Date(r.last).getTime()]));
        const rate = (days: number) => {
          let retained = 0;
          for (const c of cohort) {
            const last = lastByUser.get(c.user) ?? 0;
            if (last >= new Date(c.signedUpAt).getTime() + days * 86_400_000) retained += 1;
          }
          return retained / cohort.length;
        };
        return { d1: rate(1), d7: rate(7), d30: rate(30) };
      })(),
      topCounts(sql<string | null>`${analyticsEventsTable.country}`, [...conds, notServer]),
      topCounts(sql<string | null>`${analyticsEventsTable.platform}`, [...conds, notServer]),
      topCounts(sql<string | null>`${analyticsEventsTable.browser}`, [...conds, notServer]),
      topCounts(sql<string | null>`${analyticsEventsTable.deviceModel}`, [...conds, notServer]),
    ]);

  const mau = mauRow[0]?.mau ?? 0;
  const lastDau = dauRows[dauRows.length - 1]?.count ?? 0;
  return {
    dau: dauRows,
    mau,
    stickiness: mau > 0 ? lastDau / mau : 0,
    sessions: sessionRows[0]?.sessions ?? 0,
    avgSessionLengthSec: sessionRows[0]?.avgLen ?? 0,
    retention,
    countries,
    platforms,
    browsers,
    deviceModels,
  };
});

analyticsRoute("/analytics/acquisition", async (_req, scope, from, to) => {
  const conds = eventConds(scope, from, to);
  const countEvent = async (name: string) =>
    (
      await db
        .select({ count: sql<number>`count(*)::int` })
        .from(analyticsEventsTable)
        .where(and(...conds, eq(analyticsEventsTable.eventName, name)))
    )[0]?.count ?? 0;

  const [firstOpens, signUps, logins, signUpMethods, sources, landingPages] =
    await Promise.all([
      countEvent("first_open"),
      countEvent("sign_up"),
      countEvent("login"),
      db
        .select({
          name: sql<string>`coalesce(${analyticsEventsTable.params} ->> 'method', 'unknown')`,
          count: sql<number>`count(*)::int`,
        })
        .from(analyticsEventsTable)
        .where(and(...conds, eq(analyticsEventsTable.eventName, "sign_up")))
        .groupBy(sql`1`)
        .orderBy(sql`count(*) DESC`),
      db
        .select({
          source: sql<string>`coalesce(${analyticsEventsTable.source}, 'direct')`,
          medium: sql<string>`coalesce(${analyticsEventsTable.medium}, '')`,
          campaign: sql<string>`coalesce(${analyticsEventsTable.campaign}, '')`,
          count: sql<number>`count(distinct coalesce(${analyticsEventsTable.sessionId}, ${actor}))::int`,
        })
        .from(analyticsEventsTable)
        .where(and(...conds, eq(analyticsEventsTable.eventName, "session_start")))
        .groupBy(sql`1, 2, 3`)
        .orderBy(sql`4 DESC`)
        .limit(15),
      db
        .select({
          name: sql<string>`coalesce(f.page, 'unknown')`,
          count: sql<number>`count(*)::int`,
        })
        .from(
          db
            .select({
              page: sql<string>`(${analyticsEventsTable.params} ->> 'page')`.as("page"),
              rn: sql<number>`row_number() over (partition by ${analyticsEventsTable.sessionId} order by ${analyticsEventsTable.createdAt})`.as(
                "rn",
              ),
            })
            .from(analyticsEventsTable)
            .where(
              and(
                ...conds,
                eq(analyticsEventsTable.eventName, "page_view"),
                isNotNull(analyticsEventsTable.sessionId),
              ),
            )
            .as("f"),
        )
        .where(sql`f.rn = 1`)
        .groupBy(sql`1`)
        .orderBy(sql`count(*) DESC`)
        .limit(10),
    ]);

  return { firstOpens, signUps, logins, signUpMethods, sources, landingPages };
});

const KEY_ACTIONS = [
  "caption_generated",
  "image_generated",
  "campaign_generated",
  "content_saved",
  "post_scheduled",
  "post_published",
];

analyticsRoute("/analytics/funnels", async (_req, scope, from, to) => {
  const conds = eventConds(scope, from, to);
  const distinctUsers = async (names: string[]) =>
    (
      await db
        .select({ count: sql<number>`count(distinct ${actor})::int` })
        .from(analyticsEventsTable)
        .where(and(...conds, inArray(analyticsEventsTable.eventName, names)))
    )[0]?.count ?? 0;

  // Avg seconds between a user's first `fromName` and first `toName` event in
  // the window (only counting users where the pair is causally ordered).
  const avgTimeBetween = (fromName: string, toName: string) =>
    db
      .select({
        avgSec: sql<number>`coalesce(avg(extract(epoch from (c.done - s.begun))), 0)::float`,
      })
      .from(
        db
          .select({
            user: sql<string>`${actor}`.as("suser"),
            begun: sql<string>`min(${analyticsEventsTable.createdAt})`.as("begun"),
          })
          .from(analyticsEventsTable)
          .where(and(...conds, eq(analyticsEventsTable.eventName, fromName)))
          .groupBy(sql`1`)
          .as("s"),
      )
      .innerJoin(
        db
          .select({
            user: sql<string>`${actor}`.as("cuser"),
            done: sql<string>`min(${analyticsEventsTable.createdAt})`.as("done"),
          })
          .from(analyticsEventsTable)
          .where(and(...conds, eq(analyticsEventsTable.eventName, toName)))
          .groupBy(sql`1`)
          .as("c"),
        sql`s.suser = c.cuser AND c.done >= s.begun`,
      );

  const [started, completed, completionTime, signedUp, activated, firstGen, saved, connected, scheduledOrPublished, firstPublishTime] =
    await Promise.all([
      distinctUsers(["onboarding_started"]),
      distinctUsers(["onboarding_completed"]),
      avgTimeBetween("onboarding_started", "onboarding_completed"),
      distinctUsers(["sign_up"]),
      (async () => {
        const rows = await db
          .select({ count: sql<number>`count(distinct a.auser)::int` })
          .from(
            db
              .select({ user: sql<string>`${actor}`.as("auser") })
              .from(analyticsEventsTable)
              .where(and(...conds, eq(analyticsEventsTable.eventName, "sign_up")))
              .as("a"),
          )
          .where(
            sql`EXISTS (SELECT 1 FROM analytics_events k WHERE coalesce(k.clerk_user_id, k.anonymous_id) = a.auser AND k.event_name IN (${sql.join(
              KEY_ACTIONS.map((k) => sql`${k}`),
              sql`, `,
            )}) AND k.created_at BETWEEN ${from} AND ${to})`,
          );
        return rows[0]?.count ?? 0;
      })(),
      distinctUsers(["caption_generated", "image_generated", "campaign_generated"]),
      distinctUsers(["content_saved"]),
      distinctUsers(["account_connected"]),
      distinctUsers(["post_scheduled", "post_published"]),
      avgTimeBetween("sign_up", "post_published"),
    ]);

  const steps = [
    { step: "Signed up", count: signedUp },
    { step: "Completed onboarding", count: completed },
    { step: "Generated first content", count: firstGen },
    { step: "Saved to library", count: saved },
    { step: "Scheduled or published", count: scheduledOrPublished },
  ];
  const funnel = steps.map((s, i) => ({
    ...s,
    dropOffPct:
      i === 0 || steps[i - 1]!.count === 0
        ? 0
        : Math.max(0, (1 - s.count / steps[i - 1]!.count) * 100),
  }));

  return {
    onboarding: {
      started,
      completed,
      completionRate: started > 0 ? completed / started : 0,
      avgCompletionTimeSec: completionTime[0]?.avgSec ?? 0,
    },
    activationRate: signedUp > 0 ? activated / signedUp : 0,
    // Independent adoption count, not a sequential funnel step: connecting an
    // account can happen at any point, so it may exceed earlier funnel steps.
    accountsConnected: connected,
    avgTimeToFirstPublishSec: firstPublishTime[0]?.avgSec ?? 0,
    funnel,
  };
});

analyticsRoute("/analytics/engagement", async (_req, scope, from, to) => {
  const conds = eventConds(scope, from, to);
  const pageParam = sql<string>`coalesce(${analyticsEventsTable.params} ->> 'page', 'unknown')`;

  const [pageViewCount, topPages, navigationPaths, searchStats, topTerms, features, keyActions] =
    await Promise.all([
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(analyticsEventsTable)
        .where(and(...conds, sql`${analyticsEventsTable.eventName} IN ('page_view', 'screen_view')`)),
      db
        .select({ name: pageParam, count: sql<number>`count(*)::int` })
        .from(analyticsEventsTable)
        .where(and(...conds, sql`${analyticsEventsTable.eventName} IN ('page_view', 'screen_view')`))
        .groupBy(sql`1`)
        .orderBy(sql`count(*) DESC`)
        .limit(10),
      db
        .select({
          from: sql<string>`coalesce(${analyticsEventsTable.params} ->> 'referrer_page', 'entry')`,
          to: pageParam,
          count: sql<number>`count(*)::int`,
        })
        .from(analyticsEventsTable)
        .where(and(...conds, sql`${analyticsEventsTable.eventName} IN ('page_view', 'screen_view')`))
        .groupBy(sql`1, 2`)
        .orderBy(sql`3 DESC`)
        .limit(15),
      db
        .select({
          total: sql<number>`count(*)::int`,
          zero: sql<number>`count(*) FILTER (WHERE (${analyticsEventsTable.params} ->> 'results')::int = 0)::int`,
        })
        .from(analyticsEventsTable)
        .where(and(...conds, eq(analyticsEventsTable.eventName, "search"))),
      db
        .select({
          name: sql<string>`coalesce(${analyticsEventsTable.params} ->> 'term', 'unknown')`,
          count: sql<number>`count(*)::int`,
        })
        .from(analyticsEventsTable)
        .where(and(...conds, eq(analyticsEventsTable.eventName, "search")))
        .groupBy(sql`1`)
        .orderBy(sql`count(*) DESC`)
        .limit(10),
      db
        .select({
          feature: sql<string>`coalesce(${analyticsEventsTable.params} ->> 'feature', 'unknown')`,
          uses: sql<number>`count(*)::int`,
          uniqueUsers: sql<number>`count(distinct ${actor})::int`,
        })
        .from(analyticsEventsTable)
        .where(and(...conds, eq(analyticsEventsTable.eventName, "feature_use")))
        .groupBy(sql`1`)
        .orderBy(sql`count(*) DESC`)
        .limit(15),
      db
        .select({
          name: analyticsEventsTable.eventName,
          count: sql<number>`count(*)::int`,
        })
        .from(analyticsEventsTable)
        .where(and(...conds, inArray(analyticsEventsTable.eventName, KEY_ACTIONS)))
        .groupBy(analyticsEventsTable.eventName)
        .orderBy(sql`count(*) DESC`),
    ]);

  const total = searchStats[0]?.total ?? 0;
  return {
    pageViews: pageViewCount[0]?.count ?? 0,
    topPages,
    navigationPaths,
    search: {
      total,
      zeroResultRate: total > 0 ? (searchStats[0]?.zero ?? 0) / total : 0,
      topTerms,
    },
    features,
    keyActions,
  };
});

analyticsRoute("/analytics/revenue", async (_req, scope, from, to) => {
  const conds = eventConds(scope, from, to);
  const amount = sql<number>`coalesce((${analyticsEventsTable.params} ->> 'amount_paise')::bigint, 0)`;
  const countEvent = async (name: string) =>
    (
      await db
        .select({ count: sql<number>`count(*)::int` })
        .from(analyticsEventsTable)
        .where(and(...conds, eq(analyticsEventsTable.eventName, name)))
    )[0]?.count ?? 0;

  const byItemType = async (itemType: string) =>
    db
      .select({
        name: sql<string>`coalesce(${analyticsEventsTable.params} ->> 'item_name', 'unknown')`,
        count: sql<number>`count(*)::int`,
        totalPaise: sql<number>`coalesce(sum((${analyticsEventsTable.params} ->> 'amount_paise')::bigint), 0)::bigint`,
      })
      .from(analyticsEventsTable)
      .where(
        and(
          ...conds,
          eq(analyticsEventsTable.eventName, "purchase"),
          sql`${analyticsEventsTable.params} ->> 'item_type' = ${itemType}`,
        ),
      )
      .groupBy(sql`1`)
      .orderBy(sql`3 DESC`);

  const [purchases, refunds, started, renewed, cancelled, cancelReasons, byPlan, byCreditPack] =
    await Promise.all([
      db
        .select({
          count: sql<number>`count(*)::int`,
          totalPaise: sql<number>`coalesce(sum(${amount}), 0)::bigint`,
          payers: sql<number>`count(distinct ${analyticsEventsTable.tenantId})::int`,
        })
        .from(analyticsEventsTable)
        .where(and(...conds, eq(analyticsEventsTable.eventName, "purchase"))),
      db
        .select({
          count: sql<number>`count(*)::int`,
          totalPaise: sql<number>`coalesce(sum(${amount}), 0)::bigint`,
        })
        .from(analyticsEventsTable)
        .where(and(...conds, eq(analyticsEventsTable.eventName, "refund"))),
      countEvent("subscription_started"),
      countEvent("subscription_renewed"),
      countEvent("subscription_cancelled"),
      db
        .select({
          name: sql<string>`coalesce(${analyticsEventsTable.params} ->> 'reason', 'not given')`,
          count: sql<number>`count(*)::int`,
        })
        .from(analyticsEventsTable)
        .where(and(...conds, eq(analyticsEventsTable.eventName, "subscription_cancelled")))
        .groupBy(sql`1`)
        .orderBy(sql`count(*) DESC`),
      byItemType("subscription"),
      byItemType("credit_pack"),
    ]);

  const p = purchases[0];
  const totalPaise = Number(p?.totalPaise ?? 0);
  const payers = p?.payers ?? 0;
  return {
    purchaseCount: p?.count ?? 0,
    purchaseTotalPaise: totalPaise,
    refundCount: refunds[0]?.count ?? 0,
    refundTotalPaise: Number(refunds[0]?.totalPaise ?? 0),
    arpuPaise: payers > 0 ? Math.round(totalPaise / payers) : 0,
    subscriptionsStarted: started,
    subscriptionsRenewed: renewed,
    subscriptionsCancelled: cancelled,
    cancelReasons,
    byPlan: byPlan.map((r) => ({ ...r, totalPaise: Number(r.totalPaise) })),
    byCreditPack: byCreditPack.map((r) => ({ ...r, totalPaise: Number(r.totalPaise) })),
  };
});

analyticsRoute("/analytics/data-consumption", async (_req, scope, from, to) => {
  const conds: SQL[] = [
    gte(usageEventsTable.createdAt, from),
    lte(usageEventsTable.createdAt, to),
  ];
  if (scope.tenantId !== null) {
    conds.push(eq(usageEventsTable.tenantId, scope.tenantId));
  }
  const reqB = sql<number>`coalesce(sum(${usageEventsTable.requestBytes}), 0)::bigint`;
  const resB = sql<number>`coalesce(sum(${usageEventsTable.responseBytes}), 0)::bigint`;
  const totB = sql<number>`coalesce(sum(coalesce(${usageEventsTable.requestBytes}, 0) + coalesce(${usageEventsTable.responseBytes}, 0)), 0)::bigint`;

  const [totals, monthly, byTenant, campaignRows] = await Promise.all([
    db
      .select({
        kind: usageEventsTable.kind,
        count: sql<number>`count(*)::int`,
        requestBytes: reqB,
        responseBytes: resB,
        totalBytes: totB,
      })
      .from(usageEventsTable)
      .where(and(...conds))
      .groupBy(usageEventsTable.kind),
    db
      .select({
        month: sql<string>`to_char(${usageEventsTable.createdAt}, 'YYYY-MM')`,
        kind: usageEventsTable.kind,
        count: sql<number>`count(*)::int`,
        totalBytes: totB,
      })
      .from(usageEventsTable)
      .where(and(...conds))
      .groupBy(sql`1`, usageEventsTable.kind)
      .orderBy(sql`1`),
    scope.platform && scope.tenantId === null
      ? db
          .select({
            tenantId: usageEventsTable.tenantId,
            tenantName: tenantsTable.name,
            count: sql<number>`count(*)::int`,
            totalBytes: totB,
          })
          .from(usageEventsTable)
          .leftJoin(tenantsTable, eq(tenantsTable.id, usageEventsTable.tenantId))
          .where(and(...conds))
          .groupBy(usageEventsTable.tenantId, tenantsTable.name)
          .orderBy(sql`4 DESC`)
          .limit(25)
      : Promise.resolve([]),
    db
      .select({
        campaignId: usageEventsTable.campaignId,
        platform: usageEventsTable.platform,
        totalBytes: totB,
        latest: sql<string>`max(${usageEventsTable.createdAt})`,
      })
      .from(usageEventsTable)
      .where(and(...conds, isNotNull(usageEventsTable.campaignId)))
      .groupBy(usageEventsTable.campaignId, usageEventsTable.platform)
      .orderBy(sql`max(${usageEventsTable.createdAt}) DESC`)
      .limit(100),
  ]);

  // Fold per-platform campaign rows into one entry per campaign.
  const campaignMap = new Map<
    string,
    { campaignId: string; platforms: { platform: string; totalBytes: number }[]; totalBytes: number; createdAt: string }
  >();
  for (const row of campaignRows) {
    if (!row.campaignId) continue;
    const entry = campaignMap.get(row.campaignId) ?? {
      campaignId: row.campaignId,
      platforms: [],
      totalBytes: 0,
      createdAt: row.latest,
    };
    entry.platforms.push({
      platform: row.platform ?? "unknown",
      totalBytes: Number(row.totalBytes),
    });
    entry.totalBytes += Number(row.totalBytes);
    if (row.latest > entry.createdAt) entry.createdAt = row.latest;
    campaignMap.set(row.campaignId, entry);
  }

  return {
    totals: totals.map((t) => ({
      ...t,
      requestBytes: Number(t.requestBytes),
      responseBytes: Number(t.responseBytes),
      totalBytes: Number(t.totalBytes),
    })),
    monthly: monthly.map((m) => ({ ...m, totalBytes: Number(m.totalBytes) })),
    byTenant: byTenant.map((t) => ({
      tenantId: t.tenantId,
      tenantName: t.tenantName ?? null,
      count: t.count,
      totalBytes: Number(t.totalBytes),
    })),
    recentCampaigns: Array.from(campaignMap.values()).slice(0, 20),
  };
});

analyticsRoute("/analytics/reliability", async (_req, scope, from, to) => {
  const conds = eventConds(scope, from, to);
  const durationMs = sql`(${analyticsEventsTable.params} ->> 'duration_ms')::numeric`;

  const [errors, errorsByType, errorsByScreen, crashes, sessions, crashedSessions, anrCount, startup, apiLatency] =
    await Promise.all([
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(analyticsEventsTable)
        .where(and(...conds, eq(analyticsEventsTable.eventName, "error_occurred"))),
      db
        .select({
          name: sql<string>`coalesce(${analyticsEventsTable.params} ->> 'error_type', 'unknown')`,
          count: sql<number>`count(*)::int`,
        })
        .from(analyticsEventsTable)
        .where(and(...conds, eq(analyticsEventsTable.eventName, "error_occurred")))
        .groupBy(sql`1`)
        .orderBy(sql`count(*) DESC`)
        .limit(10),
      db
        .select({
          name: sql<string>`coalesce(${analyticsEventsTable.params} ->> 'screen', 'unknown')`,
          count: sql<number>`count(*)::int`,
        })
        .from(analyticsEventsTable)
        .where(and(...conds, eq(analyticsEventsTable.eventName, "error_occurred")))
        .groupBy(sql`1`)
        .orderBy(sql`count(*) DESC`)
        .limit(10),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(analyticsEventsTable)
        .where(
          and(
            ...conds,
            eq(analyticsEventsTable.eventName, "error_occurred"),
            sql`${analyticsEventsTable.params} ->> 'fatal' = 'true'`,
          ),
        ),
      db
        .select({ count: sql<number>`count(distinct ${analyticsEventsTable.sessionId})::int` })
        .from(analyticsEventsTable)
        .where(and(...conds, isNotNull(analyticsEventsTable.sessionId))),
      db
        .select({ count: sql<number>`count(distinct ${analyticsEventsTable.sessionId})::int` })
        .from(analyticsEventsTable)
        .where(
          and(
            ...conds,
            isNotNull(analyticsEventsTable.sessionId),
            eq(analyticsEventsTable.eventName, "error_occurred"),
            sql`${analyticsEventsTable.params} ->> 'fatal' = 'true'`,
          ),
        ),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(analyticsEventsTable)
        .where(and(...conds, eq(analyticsEventsTable.eventName, "app_not_responding"))),
      db
        .select({
          platform: sql<string>`coalesce(${analyticsEventsTable.platform}, 'unknown')`,
          avgMs: sql<number>`coalesce(avg(${durationMs}), 0)::float`,
          p95Ms: sql<number>`coalesce(percentile_cont(0.95) within group (order by ${durationMs}), 0)::float`,
          count: sql<number>`count(*)::int`,
        })
        .from(analyticsEventsTable)
        .where(and(...conds, eq(analyticsEventsTable.eventName, "app_startup")))
        .groupBy(sql`1`),
      db
        .select({
          group: sql<string>`coalesce(${analyticsEventsTable.params} ->> 'group', 'unknown')`,
          count: sql<number>`count(*)::int`,
          errorRate: sql<number>`(count(*) FILTER (WHERE (${analyticsEventsTable.params} ->> 'status')::int >= 500))::float / count(*)`,
          p50Ms: sql<number>`coalesce(percentile_cont(0.5) within group (order by ${durationMs}), 0)::float`,
          p95Ms: sql<number>`coalesce(percentile_cont(0.95) within group (order by ${durationMs}), 0)::float`,
          p99Ms: sql<number>`coalesce(percentile_cont(0.99) within group (order by ${durationMs}), 0)::float`,
        })
        .from(analyticsEventsTable)
        .where(and(...conds, eq(analyticsEventsTable.eventName, "api_request")))
        .groupBy(sql`1`)
        .orderBy(sql`count(*) DESC`)
        .limit(15),
    ]);

  const totalSessions = sessions[0]?.count ?? 0;
  const crashed = crashedSessions[0]?.count ?? 0;
  return {
    errorCount: errors[0]?.count ?? 0,
    errorsByType,
    errorsByScreen,
    crashCount: crashes[0]?.count ?? 0,
    crashFreeSessionRate:
      totalSessions > 0 ? 1 - crashed / totalSessions : 1,
    anrCount: anrCount[0]?.count ?? 0,
    startup,
    apiLatency,
  };
});

analyticsRoute("/analytics/consent-stats", async (_req, scope, from, to) => {
  // Consent is per-user. Workspace scope = the workspace's owner + members;
  // platform scope = every known user.
  let userFilter: SQL | null = null;
  if (scope.tenantId !== null) {
    const [owner, members] = await Promise.all([
      db
        .select({ id: tenantsTable.clerkUserId })
        .from(tenantsTable)
        .where(eq(tenantsTable.id, scope.tenantId)),
      db
        .select({ id: tenantMembersTable.clerkUserId })
        .from(tenantMembersTable)
        .where(eq(tenantMembersTable.tenantId, scope.tenantId)),
    ]);
    const ids = [...owner.map((o) => o.id), ...members.map((m) => m.id)];
    userFilter = inArray(
      userConsentsTable.clerkUserId,
      ids.length > 0 ? ids : ["__none__"],
    );
  }

  const [totalUsersRow, consentAgg, trends] = await Promise.all([
    scope.tenantId !== null
      ? (async () => {
          const members = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(tenantMembersTable)
            .where(eq(tenantMembersTable.tenantId, scope.tenantId!));
          return (members[0]?.count ?? 0) + 1; // + owner
        })()
      : (async () => {
          const [owners, members] = await Promise.all([
            db.select({ count: sql<number>`count(*)::int` }).from(tenantsTable),
            db.select({ count: sql<number>`count(*)::int` }).from(tenantMembersTable),
          ]);
          return (owners[0]?.count ?? 0) + (members[0]?.count ?? 0);
        })(),
    db
      .select({
        responded: sql<number>`count(*) FILTER (WHERE ${userConsentsTable.respondedAt} IS NOT NULL)::int`,
        analytics: sql<number>`count(*) FILTER (WHERE ${userConsentsTable.analytics})::int`,
        deviceDetails: sql<number>`count(*) FILTER (WHERE ${userConsentsTable.deviceDetails})::int`,
        locationCoarse: sql<number>`count(*) FILTER (WHERE ${userConsentsTable.locationCoarse})::int`,
        locationPrecise: sql<number>`count(*) FILTER (WHERE ${userConsentsTable.locationPrecise})::int`,
        carrier: sql<number>`count(*) FILTER (WHERE ${userConsentsTable.carrier})::int`,
      })
      .from(userConsentsTable)
      .where(userFilter ?? sql`true`),
    db
      .select({
        date: sql<string>`to_char(${userConsentsTable.updatedAt}, 'YYYY-MM-DD')`,
        optIns: sql<number>`count(*) FILTER (WHERE ${userConsentsTable.analytics})::int`,
        optOuts: sql<number>`count(*) FILTER (WHERE NOT ${userConsentsTable.analytics})::int`,
      })
      .from(userConsentsTable)
      .where(
        and(
          gte(userConsentsTable.updatedAt, from),
          lte(userConsentsTable.updatedAt, to),
          userFilter ?? sql`true`,
        ),
      )
      .groupBy(sql`1`)
      .orderBy(sql`1`),
  ]);

  const agg = consentAgg[0];
  return {
    totalUsers: totalUsersRow,
    respondedUsers: agg?.responded ?? 0,
    optIns: {
      analytics: agg?.analytics ?? 0,
      deviceDetails: agg?.deviceDetails ?? 0,
      locationCoarse: agg?.locationCoarse ?? 0,
      locationPrecise: agg?.locationPrecise ?? 0,
      carrier: agg?.carrier ?? 0,
    },
    trends,
  };
});

export default router;
