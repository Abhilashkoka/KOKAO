/**
 * Unit tests for the daily USD→INR refresh sweep's stale-rate alerting:
 * a failed refresh checks how old the last successful refresh is and alerts
 * superadmins past the threshold; a success resolves the alert.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./aiCost", () => ({
  refreshUsdInrRate: vi.fn(),
  getAiCostConfig: vi.fn(),
}));
vi.mock("./notifications", () => ({
  notifyFxRateStale: vi.fn().mockResolvedValue(undefined),
  resolveFxRateStaleNotifications: vi.fn().mockResolvedValue(undefined),
}));

import { getAiCostConfig, refreshUsdInrRate } from "./aiCost";
import {
  notifyFxRateStale,
  resolveFxRateStaleNotifications,
} from "./notifications";
import {
  runFxRateRefreshOnce,
  checkFxRateStaleness,
  FX_RATE_STALE_ALERT_DAYS,
  FX_RATE_STALE_ALERT_MS,
} from "./fxRateSweep";

const DAY_MS = 24 * 60 * 60 * 1000;

const config = (rateAutoUpdatedAt: Date | null) => ({
  usdToInrPaise: 8600,
  marketRatePaise: 8400,
  rateMarkupPaise: 200,
  rateAutoUpdatedAt,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runFxRateRefreshOnce", () => {
  it("resolves any stale-rate alert after a successful refresh", async () => {
    vi.mocked(refreshUsdInrRate).mockResolvedValue(config(new Date()) as never);
    await runFxRateRefreshOnce();
    expect(resolveFxRateStaleNotifications).toHaveBeenCalledTimes(1);
    expect(notifyFxRateStale).not.toHaveBeenCalled();
  });

  it("alerts superadmins when a failed refresh leaves the rate stale past the threshold", async () => {
    const old = new Date(Date.now() - FX_RATE_STALE_ALERT_MS - DAY_MS);
    vi.mocked(refreshUsdInrRate).mockRejectedValue(new Error("api down"));
    vi.mocked(getAiCostConfig).mockResolvedValue(config(old) as never);
    await runFxRateRefreshOnce();
    expect(notifyFxRateStale).toHaveBeenCalledWith(
      old,
      FX_RATE_STALE_ALERT_DAYS,
    );
    expect(resolveFxRateStaleNotifications).not.toHaveBeenCalled();
  });

  it("stays quiet when a failed refresh is still within the staleness window", async () => {
    const recent = new Date(Date.now() - DAY_MS);
    vi.mocked(refreshUsdInrRate).mockRejectedValue(new Error("api down"));
    vi.mocked(getAiCostConfig).mockResolvedValue(config(recent) as never);
    await runFxRateRefreshOnce();
    expect(notifyFxRateStale).not.toHaveBeenCalled();
    expect(resolveFxRateStaleNotifications).not.toHaveBeenCalled();
  });

  it("skips the alert when the rate has never auto-refreshed", async () => {
    vi.mocked(refreshUsdInrRate).mockRejectedValue(new Error("api down"));
    vi.mocked(getAiCostConfig).mockResolvedValue(config(null) as never);
    await runFxRateRefreshOnce();
    expect(notifyFxRateStale).not.toHaveBeenCalled();
  });
});

describe("checkFxRateStaleness", () => {
  it("never throws when the config read fails", async () => {
    vi.mocked(getAiCostConfig).mockRejectedValue(new Error("db down"));
    await expect(checkFxRateStaleness()).resolves.toBeUndefined();
    expect(notifyFxRateStale).not.toHaveBeenCalled();
  });
});
