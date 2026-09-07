/**
 * Scheduled refresh for BytePlus Seedance's authoritative pricing table.
 *
 * A failed provider read leaves the atomically stored last-known snapshot
 * untouched. Once that snapshot is old enough, superadmins receive one
 * deduplicated operational alert which is resolved by the next success.
 */
import { listModelPrices } from "./aiCost";
import { BYTEPLUS_SEEDANCE_25_MODEL } from "./byteplusPricing";
import { logger } from "./logger";
import { refreshBytePlusSeedancePricing } from "./modelPricingSync";
import {
  notifySeedancePricingStale,
  resolveSeedancePricingStaleNotifications,
} from "./notifications";

export const SEEDANCE_PRICING_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const SEEDANCE_PRICING_STALE_ALERT_DAYS = 3;
export const SEEDANCE_PRICING_STALE_ALERT_MS =
  SEEDANCE_PRICING_STALE_ALERT_DAYS * 24 * 60 * 60 * 1000;
export const SEEDANCE_PRICING_SWEEP_INITIAL_DELAY_MS = 45 * 1000;

let initialTimer: NodeJS.Timeout | null = null;
let sweepTimer: NodeJS.Timeout | null = null;
let refreshInFlight: Promise<void> | null = null;

export async function checkSeedancePricingStaleness(): Promise<void> {
  try {
    const rows = (await listModelPrices()).filter(
      (row) =>
        row.kind === "video" &&
        row.provider.trim().toLowerCase() === "byteplus" &&
        row.model.trim().toLowerCase() === BYTEPLUS_SEEDANCE_25_MODEL,
    );
    const lastCheckedAt = rows.reduce<Date | null>((latest, row) => {
      if (!row.sourceCheckedAt) return latest;
      return !latest || row.sourceCheckedAt > latest ? row.sourceCheckedAt : latest;
    }, null);
    if (
      !lastCheckedAt ||
      Date.now() - lastCheckedAt.getTime() <= SEEDANCE_PRICING_STALE_ALERT_MS
    ) {
      return;
    }
    await notifySeedancePricingStale(
      lastCheckedAt,
      SEEDANCE_PRICING_STALE_ALERT_DAYS,
    );
  } catch (err) {
    logger.error({ err }, "Failed to check BytePlus Seedance pricing staleness");
  }
}

/** Run at most one provider refresh at a time. Never throws. */
export function runSeedancePricingRefreshOnce(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const pricing = await refreshBytePlusSeedancePricing();
      logger.info(
        { sourceCheckedAt: pricing.sourceCheckedAt },
        "BytePlus Seedance pricing auto-refreshed",
      );
      await resolveSeedancePricingStaleNotifications();
    } catch (err) {
      logger.error(
        { err },
        "BytePlus Seedance pricing auto-refresh failed; keeping the previous snapshot",
      );
      await checkSeedancePricingStaleness();
    }
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

export function startSeedancePricingSweep(): void {
  if (initialTimer || sweepTimer) return;
  initialTimer = setTimeout(() => {
    initialTimer = null;
    void runSeedancePricingRefreshOnce();
    sweepTimer = setInterval(() => {
      void runSeedancePricingRefreshOnce();
    }, SEEDANCE_PRICING_SWEEP_INTERVAL_MS);
    sweepTimer.unref();
  }, SEEDANCE_PRICING_SWEEP_INITIAL_DELAY_MS);
  initialTimer.unref();
}

export function stopSeedancePricingSweep(): void {
  if (initialTimer) clearTimeout(initialTimer);
  if (sweepTimer) clearInterval(sweepTimer);
  initialTimer = null;
  sweepTimer = null;
}