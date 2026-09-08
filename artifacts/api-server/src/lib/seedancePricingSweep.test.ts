import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listModelPrices: vi.fn(),
  refresh: vi.fn(),
  notifyStale: vi.fn(),
  notifyChanged: vi.fn(),
  resolve: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("./aiCost", () => ({ listModelPrices: mocks.listModelPrices }));
vi.mock("./modelPricingSync", () => ({
  refreshBytePlusSeedancePricing: mocks.refresh,
}));
vi.mock("./notifications", () => ({
  notifySeedancePricingStale: mocks.notifyStale,
  notifySeedancePricingChanged: mocks.notifyChanged,
  resolveSeedancePricingStaleNotifications: mocks.resolve,
}));
vi.mock("./adminAudit", () => ({
  recordAdminAction: mocks.audit,
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
  mocks.listModelPrices.mockResolvedValue([]);
  mocks.notifyStale.mockResolvedValue(undefined);
  mocks.notifyChanged.mockResolvedValue(undefined);
  mocks.resolve.mockResolvedValue(undefined);
  mocks.audit.mockResolvedValue(undefined);
});

describe("Seedance pricing sweep", () => {
  it("resolves the stale alert after a successful refresh", async () => {
    mocks.refresh.mockResolvedValue({
      sourceCheckedAt: new Date(),
      prices: [],
    });
    await runSeedancePricingRefreshOnce();
    expect(mocks.resolve).toHaveBeenCalledOnce();
    expect(mocks.notifyStale).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "seedance_rate_refresh",
        actorTenantId: 0,
      }),
    );
  });

  it("keeps one bounded refresh in flight", async () => {
    let finish!: (value: unknown) => void;
    mocks.refresh.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const first = runSeedancePricingRefreshOnce();
    const second = runSeedancePricingRefreshOnce();
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
    finish({ sourceCheckedAt: new Date(), prices: [] });
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
    expect(mocks.notifyStale).toHaveBeenCalledWith(
      old,
      SEEDANCE_PRICING_STALE_ALERT_DAYS,
    );
  });

  it("stays quiet inside the source-age threshold and without a baseline", async () => {
    mocks.listModelPrices.mockResolvedValue([row(new Date(Date.now() - DAY_MS))]);
    await checkSeedancePricingStaleness();
    mocks.listModelPrices.mockResolvedValue([row(null)]);
    await checkSeedancePricingStaleness();
    expect(mocks.notifyStale).not.toHaveBeenCalled();
  });

  it("compares scheduled refreshes against the stored rate snapshot", async () => {
    const expiry = new Date("2026-09-30T00:00:00.000Z");
    mocks.listModelPrices.mockResolvedValue([
      {
        ...row(new Date()),
        variantCriteria: { resolution: "1080p" },
        usdPerSecond: 0.5,
        promotionalUsdPerSecond: 0.4,
        promotionExpiresAt: expiry,
      },
    ]);
    mocks.refresh.mockResolvedValue({
      sourceCheckedAt: new Date(),
      prices: [
        {
          resolution: "1080p",
          usdPerSecond: 0.55,
          promotionalUsdPerSecond: 0.4,
          promotionExpiresAt: expiry,
        },
      ],
    });

    await runSeedancePricingRefreshOnce();

    expect(mocks.notifyChanged).toHaveBeenCalledOnce();
    expect(mocks.notifyChanged.mock.calls[0]?.[0].rates["1080p"]).toMatchObject({
      listUsdPerSecond: 0.5,
      promotionUsdPerSecond: 0.4,
    });
    expect(mocks.notifyChanged.mock.calls[0]?.[1].rates["1080p"]).toMatchObject({
      listUsdPerSecond: 0.55,
      promotionUsdPerSecond: 0.4,
    });
    const auditAfter = JSON.parse(mocks.audit.mock.calls[0]?.[0].newValue);
    expect(auditAfter).toMatchObject({
      outcome: "changed",
      provider: "byteplus",
    });
  });
});