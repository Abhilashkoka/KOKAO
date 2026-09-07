import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listModelPrices: vi.fn(),
  refresh: vi.fn(),
  notify: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock("./aiCost", () => ({ listModelPrices: mocks.listModelPrices }));
vi.mock("./modelPricingSync", () => ({
  refreshBytePlusSeedancePricing: mocks.refresh,
}));
vi.mock("./notifications", () => ({
  notifySeedancePricingStale: mocks.notify,
  resolveSeedancePricingStaleNotifications: mocks.resolve,
}));

import {
  checkSeedancePricingStaleness,
  runSeedancePricingRefreshOnce,
  SEEDANCE_PRICING_STALE_ALERT_DAYS,
  SEEDANCE_PRICING_STALE_ALERT_MS,
} from "./seedancePricingSweep";

const DAY_MS = 24 * 60 * 60 * 1000;
const row = (sourceCheckedAt: Date | null) => ({
  kind: "video",
  provider: "byteplus",
  model: "dreamina-seedance-2-5-260628",
  sourceCheckedAt,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.notify.mockResolvedValue(undefined);
  mocks.resolve.mockResolvedValue(undefined);
});

describe("Seedance pricing sweep", () => {
  it("resolves the stale alert after a successful refresh", async () => {
    mocks.refresh.mockResolvedValue({ sourceCheckedAt: new Date() });
    await runSeedancePricingRefreshOnce();
    expect(mocks.resolve).toHaveBeenCalledOnce();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("keeps one bounded refresh in flight", async () => {
    let finish!: (value: unknown) => void;
    mocks.refresh.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const first = runSeedancePricingRefreshOnce();
    const second = runSeedancePricingRefreshOnce();
    expect(mocks.refresh).toHaveBeenCalledOnce();
    finish({ sourceCheckedAt: new Date() });
    await Promise.all([first, second]);
  });

  it("alerts after a failed refresh leaves the newest snapshot stale", async () => {
    const old = new Date(Date.now() - SEEDANCE_PRICING_STALE_ALERT_MS - DAY_MS);
    mocks.refresh.mockRejectedValue(new Error("provider down"));
    mocks.listModelPrices.mockResolvedValue([
      row(old),
      row(new Date(old.getTime() - DAY_MS)),
    ]);
    await runSeedancePricingRefreshOnce();
    expect(mocks.notify).toHaveBeenCalledWith(
      old,
      SEEDANCE_PRICING_STALE_ALERT_DAYS,
    );
  });

  it("stays quiet inside the source-age threshold and without a baseline", async () => {
    mocks.listModelPrices.mockResolvedValue([row(new Date(Date.now() - DAY_MS))]);
    await checkSeedancePricingStaleness();
    mocks.listModelPrices.mockResolvedValue([row(null)]);
    await checkSeedancePricingStaleness();
    expect(mocks.notify).not.toHaveBeenCalled();
  });
});