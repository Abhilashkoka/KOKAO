/**
 * Periodic background sweep that proactively re-verifies every tenant's stored
 * social connections, so a user who never opens the Accounts page still learns
 * promptly (in-app notification + best-effort email) when a token expires or
 * is revoked — instead of finding out when a post silently can't go out.
 *
 * Reuses the exact same reverify helpers as the Accounts-page on-load path:
 * each helper is staleness-gated (force=false respects the shared
 * REVERIFY_STALE_MS clock, so the sweep never hammers provider APIs), flips a
 * previously-verified row to failed only on a definitive rejection, and fires
 * the deduped notifySocialConnectionFailed on a fresh verified -> failed
 * transition. An already-known breakage produces no duplicate spam.
 */
import {
  db,
  connectedAccountsTable,
  adAccountConnectionsTable,
  sweepStatusTable,
  type SweepFailure,
  type SweepStreak,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { logger } from "./logger";
import {
  notifySweepFailRatio,
  notifySweepFailStreak,
  notifySweepHistoryTrimmed,
  notifySweepStalled,
  resolveSweepFailRatioNotifications,
  resolveSweepFailStreakNotifications,
  resolveSweepHistoryTrimmedNotifications,
  resolveSweepStalledNotifications,
} from "./notifications";
import { refreshDueLinkedinAdsTokens } from "./linkedinAdsRefresh";
import {
  reverifyFacebook,
  reverifyInstagram,
  reverifyLinkedin,
  reverifyTwitter,
  reverifyThreads,
  reverifyYoutube,
} from "./socialReverify";
import { AD_SWEEP_PLATFORMS, reverifyAdConnection } from "./adsReverify";

/** How often the sweep runs. Matches the reverify staleness window so each
 * cycle re-checks anything whose last verification has gone stale. */
export const CONNECTION_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/** Delay before the first sweep after boot, so startup traffic settles. */
export const CONNECTION_SWEEP_INITIAL_DELAY_MS = 60 * 1000;

/** A recorded run older than this means the sweep has stalled (interval is
 * 15 min, so 35 min = two missed cycles plus slack). */
export const SWEEP_STALE_THRESHOLD_MS = 35 * 60 * 1000;

/** How often the independent watchdog timer checks for staleness. */
export const SWEEP_WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;

/** Minimum spacing between staleness checks triggered from request paths. */
const WATCHDOG_MIN_CHECK_SPACING_MS = 5 * 60 * 1000;

/** Hard cap on a single tenant+platform re-verify. Every outbound platform
 * call already goes through the bounded platformFetch helper, so this is a
 * belt-and-suspenders guard: even if a future code path forgets the helper, a
 * hung check fails loudly after this cap instead of stalling the whole sweep. */
export const SWEEP_CHECK_TIMEOUT_MS = (() => {
  const raw = Number(process.env.SWEEP_CHECK_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30 * 1000;
})();

class SweepCheckTimeoutError extends Error {
  constructor(platform: string) {
    super(
      `Re-verify for ${platform} exceeded ${Math.round(SWEEP_CHECK_TIMEOUT_MS / 1000)}s and was abandoned`,
    );
    this.name = "SweepCheckTimeoutError";
  }
}

/** Race a re-verify against the sweep's hard per-check cap. */
async function withSweepTimeout<T>(
  platform: string,
  run: () => Promise<T>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new SweepCheckTimeoutError(platform)),
          SWEEP_CHECK_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const SWEEP_PLATFORMS = [
  "facebook",
  "instagram",
  "linkedin",
  "twitter",
  "threads",
  "youtube",
] as const;

const REVERIFIERS: Record<
  (typeof SWEEP_PLATFORMS)[number],
  (tenantId: number) => Promise<unknown>
> = {
  facebook: (tenantId) => reverifyFacebook(tenantId),
  instagram: (tenantId) => reverifyInstagram(tenantId),
  linkedin: (tenantId) => reverifyLinkedin(tenantId),
  twitter: (tenantId) => reverifyTwitter(tenantId),
  threads: (tenantId) => reverifyThreads(tenantId),
  youtube: (tenantId) => reverifyYoutube(tenantId),
};

/** How many of the most recent failed checks to keep for the admin card. */
export const SWEEP_RECENT_FAILURES_CAP = 10;

/** Cap on the persisted fail_streaks map. Unlike recentFailures this map is
 * carried ACROSS runs, so with thousands of chronically broken connections it
 * would otherwise grow without bound and bloat the single sweep_status jsonb
 * row. When trimming, the LONGEST streaks are kept (ties broken by most
 * recent failure) so chronic offenders never lose their history to one-off
 * blips. Overridable for tests/ops via SWEEP_FAIL_STREAKS_CAP. */
export const SWEEP_FAIL_STREAKS_CAP = (() => {
  const raw = Number(process.env.SWEEP_FAIL_STREAKS_CAP);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 200;
})();

/**
 * Bound a fail-streak map to SWEEP_FAIL_STREAKS_CAP entries, keeping the
 * longest streaks (ties broken by most recent lastAt). Returns the same map
 * (with dropped=0) when already within the cap. `dropped` reports how many
 * entries were trimmed, so the sweep can tell admins the persisted failure
 * history is incomplete rather than silently losing it.
 */
export function capFailStreaks(streaks: Record<string, SweepStreak>): {
  streaks: Record<string, SweepStreak>;
  dropped: number;
} {
  const entries = Object.entries(streaks);
  if (entries.length <= SWEEP_FAIL_STREAKS_CAP) {
    return { streaks, dropped: 0 };
  }
  entries.sort(
    (a, b) =>
      b[1].count - a[1].count ||
      Date.parse(b[1].lastAt) - Date.parse(a[1].lastAt),
  );
  return {
    streaks: Object.fromEntries(entries.slice(0, SWEEP_FAIL_STREAKS_CAP)),
    dropped: entries.length - SWEEP_FAIL_STREAKS_CAP,
  };
}

/** A tenant+platform check failing this many sweeps IN A ROW (~1 hour at the
 * 15-minute interval) is a chronic breakage worth pushing to superadmins,
 * not just showing on the dashboard. Overridable for tests/ops. */
export const SWEEP_FAIL_STREAK_ALERT_THRESHOLD = (() => {
  const raw = Number(process.env.SWEEP_FAIL_STREAK_ALERT_THRESHOLD);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 4;
})();

/** A completed run whose failure ratio (errorCount / accountsChecked) is at
 * or above this fraction looks like a platform-wide outage even when the
 * fail-streak history never overflows its cap. Overridable for tests/ops. */
export const SWEEP_FAIL_RATIO_ALERT_THRESHOLD = (() => {
  const raw = Number(process.env.SWEEP_FAIL_RATIO_ALERT_THRESHOLD);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.5;
})();

/** Minimum accountsChecked before the failure-ratio alert can fire — a tiny
 * install where 2 of 3 checks fail is not a mass outage signal.
 * Overridable for tests/ops. */
export const SWEEP_FAIL_RATIO_MIN_CHECKS = (() => {
  const raw = Number(process.env.SWEEP_FAIL_RATIO_MIN_CHECKS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 10;
})();

/** Outcome of one full sweep, persisted for admin-dashboard visibility. */
export interface SweepResult {
  accountsChecked: number;
  errorCount: number;
  lastError: string | null;
  /** The most recent failed checks (newest first, capped), so an admin can
   * see WHICH tenant+platform keeps timing out — not just a count. */
  recentFailures: SweepFailure[];
  /** Consecutive-failure tally per tenant+platform (`"tenantId:platform"`),
   * carried across runs: incremented while a check keeps failing, key removed
   * the first run it succeeds. Lets an admin tell a chronic breakage from a
   * one-off blip. */
  failStreaks: Record<string, SweepStreak>;
  /** How many fail-streak entries were trimmed when the cross-run map
   * exceeded its cap this run. Non-zero means the persisted failure history
   * is incomplete and the admin dashboard should say so. */
  droppedStreaks: number;
}

/**
 * Load the previous run's consecutive-failure tallies so this run can
 * continue them. Best-effort: on any read failure returns an empty map
 * (streaks restart from 1 rather than blocking the sweep).
 */
async function loadPriorFailStreaks(): Promise<Record<string, SweepStreak>> {
  try {
    const [row] = await db
      .select({ failStreaks: sweepStatusTable.failStreaks })
      .from(sweepStatusTable)
      .where(eq(sweepStatusTable.id, 1))
      .limit(1);
    return row?.failStreaks ?? {};
  } catch (err) {
    logger.error({ err }, "Failed to load prior sweep fail streaks");
    return {};
  }
}

/**
 * Run one full sweep: find every tenant that has a connected-account row for a
 * sweepable platform, then re-verify each of their platforms sequentially
 * (force=false, so the shared staleness gate is the rate limiter). Each
 * tenant+platform check is individually guarded — one failure is logged and
 * never aborts the rest of the sweep. Never throws.
 */
export async function sweepDeadConnections(): Promise<SweepResult> {
  const result: SweepResult = {
    accountsChecked: 0,
    errorCount: 0,
    lastError: null,
    recentFailures: [],
    failStreaks: {},
    droppedStreaks: 0,
  };
  const priorStreaks = await loadPriorFailStreaks();
  let rows: { tenantId: number; platform: string }[];
  try {
    rows = await db
      .select({
        tenantId: connectedAccountsTable.tenantId,
        platform: connectedAccountsTable.platform,
      })
      .from(connectedAccountsTable)
      .where(inArray(connectedAccountsTable.platform, [...SWEEP_PLATFORMS]));
  } catch (err) {
    logger.error({ err }, "Connection sweep failed to list connected accounts");
    result.errorCount = 1;
    result.lastError = err instanceof Error ? err.message : String(err);
    // Nothing was actually checked, so carry the prior streaks unchanged —
    // a bookkeeping failure must not erase a chronic offender's history.
    const capped = capFailStreaks(priorStreaks);
    result.failStreaks = capped.streaks;
    result.droppedStreaks = capped.dropped;
    return result;
  }

  // Instagram verification rides on the Facebook Page token, so re-check
  // Facebook before Instagram for each tenant (the platform order below).
  const byTenant = new Map<number, Set<string>>();
  for (const row of rows) {
    let set = byTenant.get(row.tenantId);
    if (!set) {
      set = new Set();
      byTenant.set(row.tenantId, set);
    }
    set.add(row.platform);
  }

  // Shared failure bookkeeping for both the social and the ads loops:
  // continue (or start) this check's consecutive-failure streak. Successful
  // checks never write a key, so a recovery resets the tally automatically —
  // result.failStreaks starts empty each run.
  const recordCheckFailure = (
    tenantId: number,
    platform: string,
    err: unknown,
  ): void => {
    logger.error(
      { err, tenantId, platform },
      "Connection sweep re-verify failed",
    );
    result.errorCount += 1;
    result.lastError = err instanceof Error ? err.message : String(err);
    const streakKey = `${tenantId}:${platform}`;
    const prior = priorStreaks[streakKey];
    const nowIso = new Date().toISOString();
    const streak: SweepStreak = {
      count: (prior?.count ?? 0) + 1,
      firstFailedAt: prior?.firstFailedAt ?? nowIso,
      lastError: result.lastError,
      lastAt: nowIso,
    };
    result.failStreaks[streakKey] = streak;
    // Keep the newest offenders at the front. The cap is applied AFTER
    // the sweep completes (see below) so a chronic long-streak offender
    // can never be pushed out mid-run by fresher one-off failures.
    result.recentFailures.unshift({
      tenantId,
      platform,
      error: result.lastError,
      at: nowIso,
      consecutiveFailures: streak.count,
      firstFailedAt: streak.firstFailedAt,
    });
  };

  for (const [tenantId, platforms] of byTenant) {
    for (const platform of SWEEP_PLATFORMS) {
      if (!platforms.has(platform)) continue;
      result.accountsChecked += 1;
      try {
        await withSweepTimeout(platform, () => REVERIFIERS[platform](tenantId));
      } catch (err) {
        recordCheckFailure(tenantId, platform, err);
      }
    }
  }

  // Ad account connections (Meta/TikTok ads grants) ride the same sweep so a
  // revoked ads token surfaces a Reconnect prompt + tenant notification
  // BEFORE an owner tries to approve a drafted change. Only fully connected
  // rows are worth checking — a pending selection has nothing to verify.
  // Streak/failure keys use a "<platform>-ads" suffix so they can never
  // collide with organic social platform keys.
  try {
    const adRows = await db
      .select({
        tenantId: adAccountConnectionsTable.tenantId,
        platform: adAccountConnectionsTable.platform,
      })
      .from(adAccountConnectionsTable)
      .where(
        and(
          inArray(adAccountConnectionsTable.platform, [...AD_SWEEP_PLATFORMS]),
          eq(adAccountConnectionsTable.status, "connected"),
        ),
      );
    for (const row of adRows) {
      const platform = row.platform as (typeof AD_SWEEP_PLATFORMS)[number];
      const sweepKey = `${platform}-ads`;
      result.accountsChecked += 1;
      try {
        await withSweepTimeout(sweepKey, () =>
          reverifyAdConnection(row.tenantId, platform),
        );
      } catch (err) {
        recordCheckFailure(row.tenantId, sweepKey, err);
      }
    }
  } catch (err) {
    logger.error(
      { err },
      "Connection sweep failed to list ad account connections",
    );
    result.errorCount += 1;
    result.lastError = err instanceof Error ? err.message : String(err);
  }

  // Silent LinkedIn ads token refresh: renew any ads connection whose access
  // token expires soon (the OAuth callback stored a refresh token), so ads
  // tenants never see a reconnect prompt for a routine ~60-day expiry. The
  // helper never throws and handles per-row failures internally.
  try {
    const ads = await refreshDueLinkedinAdsTokens();
    result.accountsChecked += ads.checked;
    if (ads.errors > 0) {
      result.errorCount += ads.errors;
      result.lastError = "LinkedIn ads token refresh errored";
    }
  } catch (err) {
    logger.error({ err }, "LinkedIn ads token refresh phase crashed");
  }

  // Cap the persisted failure list so the sweep_status row stays small even
  // on a very broken run — but when trimming, keep the LONGEST consecutive
  // streaks first (ties broken by recency, since the list is newest-first
  // and sort is stable). A tenant+platform failing 8 sweeps in a row must
  // stay visible to admins even when 10+ one-off failures land in the same
  // run. Survivors keep their newest-first display order.
  if (result.recentFailures.length > SWEEP_RECENT_FAILURES_CAP) {
    const keep = new Set(
      [...result.recentFailures]
        .sort(
          (a, b) => (b.consecutiveFailures ?? 0) - (a.consecutiveFailures ?? 0),
        )
        .slice(0, SWEEP_RECENT_FAILURES_CAP),
    );
    result.recentFailures = result.recentFailures.filter((f) => keep.has(f));
  }
  // Bound the cross-run streak map the same way: keep the longest streaks so
  // the single sweep_status jsonb row can't grow without limit when many
  // connections stay broken. Entries only exist for accounts that were
  // actually checked this run, so deleted account rows fall out naturally.
  // When trimming happens, record HOW MANY were dropped so admins learn the
  // dashboard's failure history is incomplete instead of assuming it's full.
  const capped = capFailStreaks(result.failStreaks);
  result.failStreaks = capped.streaks;
  result.droppedStreaks = capped.dropped;
  if (capped.dropped > 0) {
    logger.warn(
      { droppedStreaks: capped.dropped, cap: SWEEP_FAIL_STREAKS_CAP },
      "Sweep fail-streak map exceeded its cap; shortest streaks were trimmed",
    );
  }
  return result;
}

/**
 * Persist the outcome of a completed sweep run into the single-row
 * `sweep_status` table (id=1 upsert), so the admin dashboard can show
 * "last sweep ran at" even across restarts/redeploys. Best-effort: a
 * bookkeeping failure is logged and never affects the sweep itself.
 *
 * The superadmin alert phase runs FIRST so that any alert delivery failure
 * (e.g. schema drift making every notification insert throw) is folded into
 * the persisted outcome — the run must never be recorded as a clean success
 * when the critical alerts it tried to write silently vanished.
 */
export async function recordSweepRun(
  lastRunAt: Date,
  durationMs: number,
  outcome: SweepResult,
): Promise<void> {
  // The sweep just completed a run, so any outstanding "sweep stalled" alert
  // is resolved — clearing it also re-arms the dedupe for a future stall.
  await resolveSweepStalledNotifications();
  // Chronic-breakage escalation: alert superadmins about every streak at or
  // above the threshold (deduped per streak, so a continuing streak stays
  // silent), and clear alerts for streaks that reset so the dedupe re-arms.
  let failedAlertDeliveries = await processFailStreakAlerts(
    outcome.failStreaks,
  );
  // Mass-outage escalation: a trimmed fail-streak history means MORE broken
  // connections than the cap can hold — almost always a platform-wide
  // outage. Alert superadmins proactively (deduped while trimming
  // continues); a clean run resolves the alert and re-arms the dedupe.
  if (outcome.droppedStreaks > 0) {
    failedAlertDeliveries += await notifySweepHistoryTrimmed(
      outcome.droppedStreaks,
      SWEEP_FAIL_STREAKS_CAP,
    );
  } else {
    await resolveSweepHistoryTrimmedNotifications();
  }
  // Ratio-based mass-outage escalation: catches platform-wide outages of any
  // size (e.g. 50 of 60 checks failing) that never overflow the fail-streak
  // cap. Requires a minimum sample so tiny installs don't false-positive.
  // Deduped while the outage continues; a run below the threshold resolves
  // the alert and re-arms the dedupe. Runs that checked too few accounts
  // (including bookkeeping-failure runs with accountsChecked=0) neither
  // alert nor resolve — they carry no signal either way.
  if (outcome.accountsChecked >= SWEEP_FAIL_RATIO_MIN_CHECKS) {
    const ratio = outcome.errorCount / outcome.accountsChecked;
    if (ratio >= SWEEP_FAIL_RATIO_ALERT_THRESHOLD) {
      failedAlertDeliveries += await notifySweepFailRatio(
        outcome.errorCount,
        outcome.accountsChecked,
        Math.round(SWEEP_FAIL_RATIO_ALERT_THRESHOLD * 100),
        outcome.recentFailures,
      );
    } else {
      await resolveSweepFailRatioNotifications();
    }
  }

  // Critical superadmin alerts must never vanish silently: when any alert
  // write failed (DB error, schema drift, etc.), the run is NOT a clean
  // success — surface the failure loudly in the log and fold it into the
  // persisted outcome so the admin dashboard shows a non-zero error count.
  if (failedAlertDeliveries > 0) {
    logger.error(
      { failedAlertDeliveries },
      "Connection sweep could not deliver superadmin alerts; the run is not a clean success",
    );
    outcome.errorCount += failedAlertDeliveries;
    outcome.lastError = `Failed to deliver ${failedAlertDeliveries} superadmin sweep alert(s) — check server logs (possible schema drift or DB error)`;
  }

  try {
    await db
      .insert(sweepStatusTable)
      .values({
        id: 1,
        lastRunAt,
        durationMs,
        accountsChecked: outcome.accountsChecked,
        errorCount: outcome.errorCount,
        lastError: outcome.lastError,
        recentFailures: outcome.recentFailures,
        failStreaks: outcome.failStreaks,
        droppedStreaks: outcome.droppedStreaks,
      })
      .onConflictDoUpdate({
        target: sweepStatusTable.id,
        set: {
          lastRunAt,
          durationMs,
          accountsChecked: outcome.accountsChecked,
          errorCount: outcome.errorCount,
          lastError: outcome.lastError,
          recentFailures: outcome.recentFailures,
          failStreaks: outcome.failStreaks,
          droppedStreaks: outcome.droppedStreaks,
          updatedAt: sql`now()`,
        },
      });
  } catch (err) {
    logger.error({ err }, "Failed to record connection sweep status");
  }
}

/**
 * Push chronic-breakage alerts to superadmins from a completed run's streak
 * map: every tenant+platform whose consecutive-failure count is at or above
 * SWEEP_FAIL_STREAK_ALERT_THRESHOLD gets a deduped superadmin notification,
 * and any outstanding alert whose streak has since reset (or dropped below
 * the threshold) is marked read so a future streak alerts afresh.
 * Best-effort: never throws.
 *
 * Returns the number of failed alert deliveries so the caller can surface
 * them instead of letting critical alerts vanish silently.
 */
export async function processFailStreakAlerts(
  failStreaks: Record<string, SweepStreak>,
): Promise<number> {
  let failedDeliveries = 0;
  try {
    const activeKeys: string[] = [];
    for (const [key, streak] of Object.entries(failStreaks)) {
      if (streak.count < SWEEP_FAIL_STREAK_ALERT_THRESHOLD) continue;
      const [tenantIdRaw, ...platformParts] = key.split(":");
      const tenantId = Number(tenantIdRaw);
      const platform = platformParts.join(":");
      if (!Number.isFinite(tenantId) || !platform) continue;
      activeKeys.push(`streak:${tenantId}:${platform}`);
      failedDeliveries += await notifySweepFailStreak({
        tenantId,
        platform,
        count: streak.count,
        firstFailedAt: streak.firstFailedAt,
        lastError: streak.lastError,
      });
    }
    // Streaks that recovered (or fell out of the map) release their alert,
    // re-arming the per-streak dedupe for the next chronic breakage.
    await resolveSweepFailStreakNotifications(activeKeys);
  } catch (err) {
    failedDeliveries += 1;
    logger.error({ err }, "Failed to process sweep fail-streak alerts");
  }
  return failedDeliveries;
}

let lastStalenessCheckAt = 0;

/**
 * Check whether the sweep's last recorded run is older than the stale
 * threshold, and if so alert all superadmins (deduped in-app notification +
 * best-effort email). Safe to call from any request path: checks are
 * self-throttled to one every WATCHDOG_MIN_CHECK_SPACING_MS unless `force`
 * is set (tests). A missing sweep_status row (fresh install that has never
 * completed a run) does not alert. Never throws.
 */
export async function checkSweepStaleness(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastStalenessCheckAt < WATCHDOG_MIN_CHECK_SPACING_MS) {
    return;
  }
  lastStalenessCheckAt = now;
  try {
    const [row] = await db
      .select({ lastRunAt: sweepStatusTable.lastRunAt })
      .from(sweepStatusTable)
      .where(eq(sweepStatusTable.id, 1))
      .limit(1);
    if (!row) return; // Never ran (fresh install) — nothing to compare against.

    const age = now - row.lastRunAt.getTime();
    if (age <= SWEEP_STALE_THRESHOLD_MS) return;

    logger.warn(
      { lastRunAt: row.lastRunAt.toISOString(), ageMs: age },
      "Connection sweep appears stalled; alerting superadmins",
    );
    await notifySweepStalled(
      row.lastRunAt,
      Math.round(SWEEP_STALE_THRESHOLD_MS / 60000),
    );
  } catch (err) {
    logger.error({ err }, "Sweep staleness check failed");
  }
}

let sweepTimer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
let watchdogTimer: NodeJS.Timeout | null = null;
let sweepRunning = false;

async function runSweepOnce(): Promise<boolean> {
  if (sweepRunning) return false; // Never overlap two sweeps.
  sweepRunning = true;
  const startedAt = Date.now();
  try {
    const outcome = await sweepDeadConnections();
    const durationMs = Date.now() - startedAt;
    logger.info(
      {
        durationMs,
        accountsChecked: outcome.accountsChecked,
        errorCount: outcome.errorCount,
      },
      "Connection sweep completed",
    );
    await recordSweepRun(new Date(startedAt), durationMs, outcome);
  } catch (err) {
    // sweepDeadConnections never throws, but guard anyway: a sweep failure
    // must never take down the interval or the process.
    logger.error({ err }, "Connection sweep crashed");  
  } finally {
    sweepRunning = false;
  }
  return true;
}

/** Whether a sweep is currently in flight (exposed for admin-dashboard polling). */
export function isSweepRunning(): boolean {
  return sweepRunning;
}

/**
 * Kick off a sweep immediately, on demand (admin "Run now"). Respects the
 * same overlap guard as the periodic timer: if a sweep is already in flight
 * this returns false without starting another. The sweep runs in the
 * BACKGROUND — this returns as soon as the run is started (sweepRunning is
 * set synchronously before the first await, so the overlap guard and
 * isSweepRunning() are race-free), letting the HTTP handler respond instantly
 * while the dashboard polls stats/isSweepRunning for completion.
 */
export function triggerSweepNow(): boolean {
  if (sweepRunning) return false;
  void runSweepOnce();
  return true;
}

/**
 * Start the periodic dead-connection sweep. Timers are unref'd so they never
 * hold the process open, and the first run is delayed so it doesn't compete
 * with startup. No-op if already started. Not started in tests.
 */
export function startConnectionSweep(): void {
  if (sweepTimer || initialTimer) return;
  initialTimer = setTimeout(() => {
    initialTimer = null;
    void runSweepOnce();
    sweepTimer = setInterval(() => {
      void runSweepOnce();
    }, CONNECTION_SWEEP_INTERVAL_MS);
    sweepTimer.unref();
  }, CONNECTION_SWEEP_INITIAL_DELAY_MS);
  initialTimer.unref();

  // Independent watchdog: alerts superadmins if the recorded last run goes
  // stale. Deliberately a SEPARATE timer from the sweep interval so a hung
  // sweep (e.g. sweepRunning stuck true on a wedged promise) still gets
  // reported. Admin request paths also trigger the same throttled check, so
  // staleness surfaces even if this process's timers were all lost.
  watchdogTimer = setInterval(() => {
    void checkSweepStaleness();
  }, SWEEP_WATCHDOG_INTERVAL_MS);
  watchdogTimer.unref();
}

/** Stop the periodic sweep (graceful shutdown / tests). */
export function stopConnectionSweep(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}
