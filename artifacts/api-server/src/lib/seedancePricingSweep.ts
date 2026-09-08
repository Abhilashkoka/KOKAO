/**
 * Scheduled refresh for BytePlus Seedance's authoritative pricing table.
 *
 * A failed provider read leaves the atomically stored last-known snapshot
 * untouched. Once that snapshot is old enough, superadmins receive one
 * deduplicated operational alert which is resolved by the next success.
 */
import { listModelPrices } from "./aiCost";
import {
  BYTEPLUS_SEEDANCE_25_MODEL,
  BYTEPLUS_SEEDANCE_25_PRICING_URL,
} from "./byteplusPricing";
import { logger } from "./logger";
import { refreshBytePlusSeedancePricing } from "./modelPricingSync";
import {
  notifySeedancePricingChanged,
  notifySeedancePricingStale,
  resolveSeedancePricingStaleNotifications,
} from "./notifications";
import type { BytePlusSeedancePricing } from "./byteplusPricing";
import { recordAdminAction } from "./adminAudit";

export const SEEDANCE_PRICING_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const SEEDANCE_PRICING_STALE_ALERT_DAYS = 3;
export const SEEDANCE_PRICING_STALE_ALERT_MS =
  SEEDANCE_PRICING_STALE_ALERT_DAYS * 24 * 60 * 60 * 1000;
export const SEEDANCE_PRICING_SWEEP_INITIAL_DELAY_MS = 45 * 1000;

let initialTimer: NodeJS.Timeout | null = null;
let sweepTimer: NodeJS.Timeout | null = null;
let refreshInFlight: Promise<void> | null = null;

type SweepRateSnapshot = Parameters<typeof notifySeedancePricingChanged>[0];

function emptyRateSnapshot(): SweepRateSnapshot {
  return {
    sourceCheckedAt: null,
    rates: {
      "480p": {
        listUsdPerSecond: null,
        promotionUsdPerSecond: null,
        promotionExpiresAt: null,
      },
      "720p": {
        listUsdPerSecond: null,
        promotionUsdPerSecond: null,
        promotionExpiresAt: null,
      },
      "1080p": {
        listUsdPerSecond: null,
        promotionUsdPerSecond: null,
        promotionExpiresAt: null,
      },
    },
  };
}

async function storedRateSnapshot(): Promise<SweepRateSnapshot> {
  const snapshot = emptyRateSnapshot();
  let newestSourceCheckedAt: Date | null = null;
  for (const row of (await listModelPrices()) ?? []) {
    if (
      row.kind !== "video" ||
      row.provider.trim().toLowerCase() !== "byteplus" ||
      row.model.trim().toLowerCase() !== BYTEPLUS_SEEDANCE_25_MODEL
    ) {
      continue;
    }
    const resolution = row.variantCriteria?.resolution;
    if (resolution !== "480p" && resolution !== "720p" && resolution !== "1080p") {
      continue;
    }
    snapshot.rates[resolution] = {
      listUsdPerSecond: row.usdPerSecond,
      promotionUsdPerSecond: row.promotionalUsdPerSecond,
      promotionExpiresAt: row.promotionExpiresAt?.toISOString() ?? null,
    };
    if (
      row.sourceCheckedAt &&
      (!newestSourceCheckedAt || row.sourceCheckedAt > newestSourceCheckedAt)
    ) {
      newestSourceCheckedAt = row.sourceCheckedAt;
    }
  }
  snapshot.sourceCheckedAt = newestSourceCheckedAt?.toISOString() ?? null;
  return snapshot;
}

function refreshedRateSnapshot(
  pricing: BytePlusSeedancePricing,
): SweepRateSnapshot {
  const snapshot = emptyRateSnapshot();
  snapshot.sourceCheckedAt = pricing.sourceCheckedAt.toISOString();
  for (const price of pricing.prices) {
    snapshot.rates[price.resolution] = {
      listUsdPerSecond: price.usdPerSecond,
      promotionUsdPerSecond: price.promotionalUsdPerSecond,
      promotionExpiresAt: price.promotionExpiresAt?.toISOString() ?? null,
    };
  }
  return snapshot;
}

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
      const before = await storedRateSnapshot();
      const pricing = await refreshBytePlusSeedancePricing();
      const after = refreshedRateSnapshot(pricing);
      const changed = JSON.stringify(before.rates) !== JSON.stringify(after.rates);
      try {
        await recordAdminAction({
          action: "seedance_rate_refresh",
          actorTenantId: 0,
          actorEmail: "system (scheduled Seedance pricing refresh)",
          targetTenantId: null,
          targetEmail: null,
          oldValue: JSON.stringify({
            provider: "byteplus",
            model: BYTEPLUS_SEEDANCE_25_MODEL,
            sourceUrl: BYTEPLUS_SEEDANCE_25_PRICING_URL,
            ...before,
          }),
          newValue: JSON.stringify({
            provider: "byteplus",
            model: pricing.model,
            sourceUrl: pricing.sourceUrl,
            ...after,
            outcome: changed ? "changed" : "no_change",
          }),
        });
      } catch (err) {
        logger.error({ err }, "Failed to audit scheduled Seedance pricing refresh");
      }
      if (changed) {
        await notifySeedancePricingChanged(before, after);
      }
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