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
import { db, connectedAccountsTable, sweepStatusTable } from "@workspace/db";
import { inArray, sql } from "drizzle-orm";
import { logger } from "./logger";
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

/** Outcome of one full sweep, persisted for admin-dashboard visibility. */
export interface SweepResult {
  accountsChecked: number;
  errorCount: number;
  lastError: string | null;
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
  };
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
        await REVERIFIERS[platform](tenantId);
      } catch (err) {
        logger.error(
          { err, tenantId, platform },
          "Connection sweep re-verify failed",
        );
        result.errorCount += 1;
        result.lastError = err instanceof Error ? err.message : String(err);
      }
    }
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
      })
      .onConflictDoUpdate({
        target: sweepStatusTable.id,
        set: {
          lastRunAt,
          durationMs,
          accountsChecked: outcome.accountsChecked,
          errorCount: outcome.errorCount,
          lastError: outcome.lastError,
          updatedAt: sql`now()`,
        },
      });
  } catch (err) {
    logger.error({ err }, "Failed to record connection sweep status");
  }
}

let sweepTimer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
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

/**
 * Run a sweep immediately, on demand (admin "Run now"). Respects the same
 * overlap guard as the periodic timer: if a sweep is already in flight this
 * returns false without starting another. Resolves after the sweep completes
 * (and its outcome is persisted), so callers can refetch stats right away.
 */
export async function triggerSweepNow(): Promise<boolean> {
  return runSweepOnce();
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
}
