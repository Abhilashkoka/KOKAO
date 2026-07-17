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
  sweepStatusTable,
  type SweepFailure,
  type SweepStreak,
} from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";
import { logger } from "./logger";
import {
  notifySweepStalled,
  resolveSweepStalledNotifications,
} from "./notifications";
import {
  reverifyFacebook,
  reverifyInstagram,
  reverifyLinkedin,
  reverifyTwitter,
  reverifyThreads,
  reverifyYoutube,
} from "./socialReverify";

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
    result.failStreaks = priorStreaks;
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

  for (const [tenantId, platforms] of byTenant) {
    for (const platform of SWEEP_PLATFORMS) {
      if (!platforms.has(platform)) continue;
      result.accountsChecked += 1;
      try {
        await withSweepTimeout(platform, () => REVERIFIERS[platform](tenantId));
      } catch (err) {
        logger.error(
          { err, tenantId, platform },
          "Connection sweep re-verify failed",
        );
        result.errorCount += 1;
        result.lastError = err instanceof Error ? err.message : String(err);
        // Continue (or start) this check's consecutive-failure streak.
        // Successful checks never write a key, so a recovery resets the
        // tally automatically — result.failStreaks starts empty each run.
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
        });
      }
    }
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
  return result;
}

/**
 * Persist the outcome of a completed sweep run into the single-row
 * `sweep_status` table (id=1 upsert), so the admin dashboard can show
 * "last sweep ran at" even across restarts/redeploys. Best-effort: a
 * bookkeeping failure is logged and never affects the sweep itself.
 */
export async function recordSweepRun(
  lastRunAt: Date,
  durationMs: number,
  outcome: SweepResult,
): Promise<void> {
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
          updatedAt: sql`now()`,
        },
      });
  } catch (err) {
    logger.error({ err }, "Failed to record connection sweep status");
  }
  // The sweep just completed a run, so any outstanding "sweep stalled" alert
  // is resolved — clearing it also re-arms the dedupe for a future stall.
  await resolveSweepStalledNotifications();
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
