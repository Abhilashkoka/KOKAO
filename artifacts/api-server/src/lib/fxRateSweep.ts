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
import { refreshUsdInrRate } from "./aiCost";

/** How often the auto-refresh runs. */
export const FX_RATE_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

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
  } catch (err) {
    logger.error(
      { err },
      "USD→INR rate auto-refresh failed; keeping the previous rate",
    );
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
