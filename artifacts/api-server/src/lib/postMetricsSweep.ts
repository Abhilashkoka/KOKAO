/**
 * Background post-metrics poller (connectionSweep pattern): a single
 * in-process loop that (1) seeds post_metrics rows for newly-published
 * content on supported platforms, and (2) refreshes every row whose
 * nextPollAt has passed, following the decay schedule in postMetrics.ts.
 *
 * Gated by the "postMetrics" kill switch: when the switch is off the tick
 * no-ops entirely (no platform calls, no row churn). Fetch outcomes:
 * - success: overwrite counters, advance nextPollAt (or mark done when the
 *   14-day tracking window has ended)
 * - transient failure: leave counters, nudge nextPollAt forward one hot
 *   interval so a broken token can't hot-loop
 * - definitive rejection: pollState=failed with the reason; never retried.
 */
import {
  db,
  contentItemsTable,
  postMetricsTable,
  type PublishedPlatformInfo,
} from "@workspace/db";
import { eq, isNotNull, sql } from "drizzle-orm";
import { logger } from "./logger";
import { isShuttingDown } from "./backgroundJobs";
import { isFeatureEnabled } from "./featureFlags";
import {
  METRICS_FETCHERS,
  METRICS_HOT_INTERVAL_MS,
  METRICS_TRACKING_WINDOW_MS,
  isMetricsPlatform,
  nextPollAt,
} from "./postMetrics";

export const POST_METRICS_SWEEP_INTERVAL_MS = (() => {
  const raw = Number(process.env.POST_METRICS_SWEEP_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 15 * 60 * 1000;
})();

export const POST_METRICS_INITIAL_DELAY_MS = (() => {
  const raw = Number(process.env.POST_METRICS_INITIAL_DELAY_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 90 * 1000;
})();

/** Cap the rows refreshed per tick so one tick can never run unbounded. */
export const POST_METRICS_BATCH_LIMIT = 200;

let timer: NodeJS.Timeout | null = null;
let running = false;

/**
 * Seed post_metrics rows for published platform posts that don't have one
 * yet. Reads the cumulative publishedPlatforms map, so republished items and
 * multi-platform publishes each get their own row. Posts already older than
 * the tracking window are seeded as done (no pointless platform calls) —
 * they still show whatever was never collected as zeros, so seeding is
 * limited to posts published within the window.
 */
export async function seedMetricsRows(): Promise<number> {
  const cutoff = new Date(Date.now() - METRICS_TRACKING_WINDOW_MS);
  const items = await db
    .select({
      id: contentItemsTable.id,
      tenantId: contentItemsTable.tenantId,
      publishedPlatforms: contentItemsTable.publishedPlatforms,
    })
    .from(contentItemsTable)
    .where(isNotNull(contentItemsTable.publishedPlatforms));

  let seeded = 0;
  for (const item of items) {
    const map = (item.publishedPlatforms ?? {}) as Record<
      string,
      PublishedPlatformInfo
    >;
    for (const [platform, info] of Object.entries(map)) {
      if (!isMetricsPlatform(platform)) continue;
      if (!info?.postId) continue;
      const publishedAt = new Date(info.publishedAt);
      if (Number.isNaN(publishedAt.getTime()) || publishedAt < cutoff) continue;
      const inserted = await db
        .insert(postMetricsTable)
        .values({
          tenantId: item.tenantId,
          contentItemId: item.id,
          platform,
          postId: info.postId,
          publishedAt,
          nextPollAt: new Date(),
          pollState: "active",
        })
        .onConflictDoNothing({
          target: [postMetricsTable.contentItemId, postMetricsTable.platform],
        })
        .returning({ id: postMetricsTable.id });
      seeded += inserted.length;
    }
  }
  return seeded;
}

/**
 * Refresh every active row whose nextPollAt has passed.
 *
 * Rows are CLAIMED atomically before any platform call: a single
 * UPDATE ... RETURNING over a FOR UPDATE SKIP LOCKED subselect pushes each
 * claimed row's nextPollAt one hot interval forward, so a concurrent
 * instance (or an overlapping tick) can never poll the same row twice. The
 * pushed nextPollAt doubles as the transient-failure backoff; success and
 * definitive-failure paths overwrite it.
 */
export async function pollDueMetrics(): Promise<void> {
  const due = await db
    .update(postMetricsTable)
    .set({ nextPollAt: new Date(Date.now() + METRICS_HOT_INTERVAL_MS) })
    .where(
      sql`${postMetricsTable.id} IN (
        SELECT id FROM post_metrics
        WHERE poll_state = 'active'
          AND next_poll_at IS NOT NULL
          AND next_poll_at <= now()
        ORDER BY next_poll_at
        LIMIT ${POST_METRICS_BATCH_LIMIT}
        FOR UPDATE SKIP LOCKED
      )`,
    )
    .returning();

  for (const row of due) {
    if (isShuttingDown()) return;
    if (!isMetricsPlatform(row.platform)) continue;
    try {
      const result = await METRICS_FETCHERS[row.platform](
        row.tenantId,
        row.postId,
      );
      if (result.ok) {
        const next = nextPollAt(row.publishedAt);
        await db
          .update(postMetricsTable)
          .set({
            ...result.counters,
            fetchedAt: new Date(),
            nextPollAt: next,
            pollState: next ? "active" : "done",
            failureReason: null,
          })
          .where(eq(postMetricsTable.id, row.id));
      } else if (result.transient) {
        // Leave counters; back off one hot interval so a broken token or
        // platform outage can't hot-loop the poller.
        await db
          .update(postMetricsTable)
          .set({
            nextPollAt: new Date(Date.now() + METRICS_HOT_INTERVAL_MS),
            failureReason: result.error,
          })
          .where(eq(postMetricsTable.id, row.id));
      } else {
        await db
          .update(postMetricsTable)
          .set({
            pollState: "failed",
            nextPollAt: null,
            failureReason: result.error,
          })
          .where(eq(postMetricsTable.id, row.id));
      }
    } catch (err) {
      logger.error(
        { err, postMetricsId: row.id, platform: row.platform },
        "Post metrics poll crashed for a row; will retry next interval",
      );
      await db
        .update(postMetricsTable)
        .set({
          nextPollAt: new Date(Date.now() + METRICS_HOT_INTERVAL_MS),
        })
        .where(eq(postMetricsTable.id, row.id))
        .catch(() => {});
    }
  }
}

export async function runPostMetricsSweepOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    if (!(await isFeatureEnabled("postMetrics"))) return;
    const seeded = await seedMetricsRows();
    if (seeded > 0) logger.info({ seeded }, "Seeded new post metrics rows");
    await pollDueMetrics();
  } catch (err) {
    logger.error({ err }, "Post metrics sweep failed");
  } finally {
    running = false;
  }
}

export function startPostMetricsSweep(): void {
  if (timer) return;
  const initial = setTimeout(() => {
    void runPostMetricsSweepOnce();
    timer = setInterval(() => {
      void runPostMetricsSweepOnce();
    }, POST_METRICS_SWEEP_INTERVAL_MS);
    timer.unref?.();
  }, POST_METRICS_INITIAL_DELAY_MS);
  initial.unref?.();
  timer = initial;
}

export function stopPostMetricsSweep(): void {
  if (timer) {
    clearTimeout(timer);
    clearInterval(timer);
    timer = null;
  }
}
