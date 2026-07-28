/**
 * Daily USD→INR rate auto-refresh for actual AI cost tracking.
 *
 * Once a day (plus once shortly after boot, so a redeploy never leaves the
 * rate a full day stale) the sweep fetches the live market rate, adds the
 * admin-configured markup (default ₹2.00), and saves the result as the
 * AI-cost conversion rate. Failures are logged and keep the previous rate —
 * the stored rate is never zeroed or guessed.
 */
import { logger } from "./logger";
import { getAiCostConfig, refreshUsdInrRate } from "./aiCost";
import {
  notifyFxRateStale,
  resolveFxRateStaleNotifications,
} from "./notifications";

/** How often the auto-refresh runs. */
export const FX_RATE_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** How stale the last successful refresh may get before superadmins are
 * alerted that AI cost tracking is drifting on an old rate. */
export const FX_RATE_STALE_ALERT_DAYS = 3;
export const FX_RATE_STALE_ALERT_MS =
  FX_RATE_STALE_ALERT_DAYS * 24 * 60 * 60 * 1000;

/** Delay before the first refresh after boot, so startup traffic settles. */
export const FX_RATE_SWEEP_INITIAL_DELAY_MS = 30 * 1000;

let initialTimer: NodeJS.Timeout | null = null;
let sweepTimer: NodeJS.Timeout | null = null;

/** One guarded refresh: success logs the new rate, failure logs and keeps
 * the previous rate. Never throws. */
export async function runFxRateRefreshOnce(): Promise<void> {
  try {
    const config = await refreshUsdInrRate();
    logger.info(
      {
        usdToInrPaise: config.usdToInrPaise,
        marketRatePaise: config.marketRatePaise,
        rateMarkupPaise: config.rateMarkupPaise,
      },
      "USD→INR rate auto-refreshed",
    );
    // A fresh success clears any outstanding stale-rate alert and re-arms
    // its dedupe for a future outage.
    await resolveFxRateStaleNotifications();
  } catch (err) {
    logger.error(
      { err },
      "USD→INR rate auto-refresh failed; keeping the previous rate",
    );
    await checkFxRateStaleness();
  }
}

/**
 * After a failed refresh, alert superadmins when the last SUCCESSFUL refresh
 * is older than the staleness threshold — the API being down for days means
 * AI cost tracking is silently drifting on an old rate. A rate that has
 * never auto-refreshed (rateAutoUpdatedAt null) is skipped: there is no
 * baseline to drift from, and the admin AI tab already flags that state.
 * Never throws.
 */
export async function checkFxRateStaleness(): Promise<void> {
  try {
    const { rateAutoUpdatedAt } = await getAiCostConfig();
    if (!rateAutoUpdatedAt) return;
    if (Date.now() - rateAutoUpdatedAt.getTime() <= FX_RATE_STALE_ALERT_MS) {
      return;
    }
    await notifyFxRateStale(rateAutoUpdatedAt, FX_RATE_STALE_ALERT_DAYS);
  } catch (err) {
    logger.error({ err }, "Failed to check USD→INR rate staleness");
  }
}

/**
 * Start the daily rate refresh. Timers are unref'd so they never hold the
 * process open. No-op if already started. Not started in tests.
 */
export function startFxRateSweep(): void {
  if (sweepTimer || initialTimer) return;
  initialTimer = setTimeout(() => {
    initialTimer = null;
    void runFxRateRefreshOnce();
    sweepTimer = setInterval(() => {
      void runFxRateRefreshOnce();
    }, FX_RATE_SWEEP_INTERVAL_MS);
    sweepTimer.unref();
  }, FX_RATE_SWEEP_INITIAL_DELAY_MS);
  initialTimer.unref();
}

/** Stop the daily refresh (graceful shutdown / tests). */
export function stopFxRateSweep(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
