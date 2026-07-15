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
import { db, connectedAccountsTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import { logger } from "./logger";
import {
  reverifyFacebook,
  reverifyInstagram,
  reverifyLinkedin,
  reverifyTwitter,
} from "./socialReverify";

/** How often the sweep runs. Matches the reverify staleness window so each
 * cycle re-checks anything whose last verification has gone stale. */
export const CONNECTION_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/** Delay before the first sweep after boot, so startup traffic settles. */
export const CONNECTION_SWEEP_INITIAL_DELAY_MS = 60 * 1000;

const SWEEP_PLATFORMS = ["facebook", "instagram", "linkedin", "twitter"] as const;

const REVERIFIERS: Record<
  (typeof SWEEP_PLATFORMS)[number],
  (tenantId: number) => Promise<unknown>
> = {
  facebook: (tenantId) => reverifyFacebook(tenantId),
  instagram: (tenantId) => reverifyInstagram(tenantId),
  linkedin: (tenantId) => reverifyLinkedin(tenantId),
  twitter: (tenantId) => reverifyTwitter(tenantId),
};

/**
 * Run one full sweep: find every tenant that has a connected-account row for a
 * sweepable platform, then re-verify each of their platforms sequentially
 * (force=false, so the shared staleness gate is the rate limiter). Each
 * tenant+platform check is individually guarded — one failure is logged and
 * never aborts the rest of the sweep. Never throws.
 */
export async function sweepDeadConnections(): Promise<void> {
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
    return;
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
      try {
        await REVERIFIERS[platform](tenantId);
      } catch (err) {
        logger.error(
          { err, tenantId, platform },
          "Connection sweep re-verify failed",
        );
      }
    }
  }
}

let sweepTimer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
let sweepRunning = false;

async function runSweepOnce(): Promise<void> {
  if (sweepRunning) return; // Never overlap two sweeps.
  sweepRunning = true;
  const startedAt = Date.now();
  try {
    await sweepDeadConnections();
    logger.info(
      { durationMs: Date.now() - startedAt },
      "Connection sweep completed",
    );
  } catch (err) {
    // sweepDeadConnections never throws, but guard anyway: a sweep failure
    // must never take down the interval or the process.
    logger.error({ err }, "Connection sweep crashed");  
  } finally {
    sweepRunning = false;
  }
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
