import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  db,
  pool,
  walletBalancesTable,
  walletLedgerTable,
  walletSettingsTable,
  aiSpendSettingsTable,
  featureFlagsTable,
  tenantsTable,
  aiModelPricesTable,
  videoGenerationsTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  gstOn,
  withGst,
  getWalletConfig,
  setWalletConfig,
  getWalletBalancePaise,
  isWalletFunded,
  estimateChargePaise,
  actualChargePaise,
  reserveWallet,
  settleWallet,
  refundWallet,
  creditWalletTopup,
  adminAdjustWallet,
  listWalletHistory,
  listPendingPricedModels,
  reservationFromRow,
  trueUpModel,
  sweepStuckPendingTrueUps,
  reconcilePendingModel,
  startTrueUpRetrySweep,
  stopTrueUpRetrySweep,
} from "./wallet";
import { setAiSpendConfig } from "./aiSpend";
import { getAiCostConfig, setAiCostConfig, upsertModelPrice } from "./aiCost";
import { inArray } from "drizzle-orm";
import { invalidateFeatureFlagCache } from "./featureFlags";
import {
  createTenant,
  deleteTenant,
  snapshotAiSpendSettings,
  restoreAiSpendSettings,
  snapshotWalletSettings,
  restoreWalletSettings,
} from "../test/dbHelpers";
import type { AiSpendSettings, WalletSettings } from "@workspace/db";

let tenantId: number;

/** SUM(ledger) must always equal the stored balance — the whole point. */
async function ledgerSum(id: number): Promise<number> {
  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(${walletLedgerTable.amountPaise}), 0)::int`,
    })
    .from(walletLedgerTable)
    .where(eq(walletLedgerTable.tenantId, id));
  return row?.total ?? 0;
}

async function setWalletFeature(enabled: boolean): Promise<void> {
  await db
    .insert(featureFlagsTable)
    .values({ feature: "wallet", enabled })
    .onConflictDoUpdate({
      target: featureFlagsTable.feature,
      set: { enabled, updatedAt: new Date() },
    });
  invalidateFeatureFlagCache();
}

let aiSpendSnapshot: AiSpendSettings | null = null;
let walletSettingsSnapshot: WalletSettings | null = null;

beforeAll(async () => {
  const t = await createTenant();
  tenantId = t.tenantId;
  // Snapshot the real dev settings so cleanup can restore (never wipe) them.
  aiSpendSnapshot = await snapshotAiSpendSettings();
  walletSettingsSnapshot = await snapshotWalletSettings();
  // ₹2.00 per caption, ₹5.00 per image, ₹10.00 per video, 20% platform fee.
  await setAiSpendConfig({
    captionCostPaise: 200,
    imageCostPaise: 500,
    videoCostPaise: 1_000,
    feePercent: 20,
  });
  await setWalletConfig({
    gstPercent: 18,
    minTopupPaise: 10_000,
    lowBalanceThresholdPaise: 5_000,
    videoCostPaise: 1_000,
  });
});

afterAll(async () => {
  await db.delete(walletLedgerTable).where(eq(walletLedgerTable.tenantId, tenantId));
  await db.delete(walletBalancesTable).where(eq(walletBalancesTable.tenantId, tenantId));
  await restoreWalletSettings(walletSettingsSnapshot);
  await restoreAiSpendSettings(aiSpendSnapshot);
  await db.delete(featureFlagsTable).where(eq(featureFlagsTable.feature, "wallet"));
  invalidateFeatureFlagCache();
  await deleteTenant(tenantId);
  await pool.end();
});

beforeEach(async () => {
  await db.delete(walletLedgerTable).where(eq(walletLedgerTable.tenantId, tenantId));
  await db.delete(walletBalancesTable).where(eq(walletBalancesTable.tenantId, tenantId));
});

describe("GST", () => {
  it("adds GST on top of the base, never inside it", () => {
    // ₹1,000 base at 18% → tenant pays ₹1,180, wallet receives ₹1,000.
    expect(gstOn(100_000, 18)).toBe(18_000);
    expect(withGst(100_000, 18)).toBe(118_000);
  });

  it("treats a zero or missing rate as no GST", () => {
    expect(gstOn(100_000, 0)).toBe(0);
    expect(withGst(100_000, 0)).toBe(100_000);
    expect(gstOn(0, 18)).toBe(0);
  });

  it("rounds to whole paise", () => {
    // 5% of ₹1.01 = 5.05 paise → 5.
    expect(gstOn(101, 5)).toBe(5);
  });
});

describe("wallet settings", () => {
  it("round-trips and defaults sensibly", async () => {
    const config = await getWalletConfig();
    expect(config.gstPercent).toBe(18);
    expect(config.minTopupPaise).toBe(10_000);
    expect(config.lowBalanceThresholdPaise).toBe(5_000);
  });
});

describe("pricing", () => {
  it("estimates a generation at the display rate with the fee folded in", async () => {
    // ₹2.00 + 20% = ₹2.40
    expect(await estimateChargePaise("caption")).toBe(240);
    // ₹5.00 + 20% = ₹6.00
    expect(await estimateChargePaise("image")).toBe(600);
    // ₹10.00 + 20% = ₹12.00
    expect(await estimateChargePaise("video")).toBe(1_200);
  });

  it("charges the real provider cost plus the fee when it is known", async () => {
    expect(await actualChargePaise({ kind: "caption", costPaise: 100 })).toEqual({
      paise: 120,
      estimated: false,
    });
  });

  it("falls back to the display rate — never free — when the cost is unknown", async () => {
    expect(await actualChargePaise({ kind: "caption", costPaise: null })).toEqual({
      paise: 240,
      estimated: true,
    });
    // Multi-unit work (a 3-platform campaign) falls back per unit.
    expect(
      await actualChargePaise({ kind: "caption", costPaise: null, units: 3 }),
    ).toEqual({ paise: 720, estimated: true });
  });

  it("treats a computed cost of zero as unknown, not as free", async () => {
    // A `:free` OpenRouter model, or any cost that rounds below half a paise,
    // must not make the generation cost the tenant nothing.
    expect(await actualChargePaise({ kind: "caption", costPaise: 0 })).toEqual({
      paise: 240,
      estimated: true,
    });
  });
});

describe("billing mode", () => {
  it("needs BOTH the platform switch and the tenant setting", async () => {
    await setWalletFeature(true);
    await db
      .update(tenantsTable)
      .set({ billingMode: "quota" })
      .where(eq(tenantsTable.id, tenantId));
    expect(await isWalletFunded(tenantId)).toBe(false);

    await db
      .update(tenantsTable)
      .set({ billingMode: "wallet" })
      .where(eq(tenantsTable.id, tenantId));
    expect(await isWalletFunded(tenantId)).toBe(true);

    // The kill switch wins over the per-tenant setting.
    await setWalletFeature(false);
    expect(await isWalletFunded(tenantId)).toBe(false);
    await setWalletFeature(true);
  });
});

describe("reserve / settle / refund", () => {
  it("refuses to reserve more than the balance", async () => {
    expect(await reserveWallet(tenantId, "caption")).toBeNull();
    expect(await getWalletBalancePaise(tenantId)).toBe(0);
  });

  it("debits the estimate up front, then trues it up to the real cost", async () => {
    await adminAdjustWallet({ tenantId, amountPaise: 10_000 });

    const reservation = await reserveWallet(tenantId, "caption");
    expect(reservation).not.toBeNull();
    // Estimate is ₹2.40.
    expect(reservation!.amountPaise).toBe(240);
    expect(await getWalletBalancePaise(tenantId)).toBe(9_760);

    // Real cost came in at ₹1.00 → charge ₹1.20, so ₹1.20 comes back.
    const settled = await settleWallet(tenantId, reservation!, {
      kind: "caption",
      costPaise: 100,
      provider: "openrouter",
      model: "gpt-test",
    });
    expect(settled.estimated).toBe(false);
    expect(settled.chargedPaise).toBe(120);
    expect(await getWalletBalancePaise(tenantId)).toBe(9_880);
    expect(await ledgerSum(tenantId)).toBe(9_880);
  });

  it("settles ABOVE the estimate when the real cost is higher", async () => {
    await adminAdjustWallet({ tenantId, amountPaise: 10_000 });
    const reservation = await reserveWallet(tenantId, "caption");
    // Real cost ₹9.00 → charge ₹10.80, well above the ₹2.40 estimate.
    const settled = await settleWallet(tenantId, reservation!, {
      kind: "caption",
      costPaise: 900,
    });
    expect(settled.chargedPaise).toBe(1_080);
    expect(await getWalletBalancePaise(tenantId)).toBe(10_000 - 1_080);
    expect(await ledgerSum(tenantId)).toBe(await getWalletBalancePaise(tenantId));
  });

  it("flags an unknown model's charge as estimated so an admin can price it", async () => {
    await adminAdjustWallet({ tenantId, amountPaise: 10_000 });
    const reservation = await reserveWallet(tenantId, "caption", {
      model: "brand-new-model",
      provider: "somewhere",
    });
    const settled = await settleWallet(tenantId, reservation!, {
      kind: "caption",
      costPaise: null,
      model: "brand-new-model",
      provider: "somewhere",
    });
    expect(settled.estimated).toBe(true);
    // Charged the display rate, not nothing.
    expect(settled.chargedPaise).toBe(240);

    const pending = await listPendingPricedModels();
    expect(
      pending.some((p) => p.model === "brand-new-model" && p.usageKind === "caption"),
    ).toBe(true);
  });

  it("gives the whole reservation back when the generation fails", async () => {
    await adminAdjustWallet({ tenantId, amountPaise: 10_000 });
    const reservation = await reserveWallet(tenantId, "image");
    expect(await getWalletBalancePaise(tenantId)).toBe(10_000 - 600);
    await refundWallet(tenantId, reservation!, "provider blew up");
    expect(await getWalletBalancePaise(tenantId)).toBe(10_000);
    expect(await ledgerSum(tenantId)).toBe(10_000);
  });

  it("reserves multi-unit work as one all-or-nothing debit", async () => {
    await adminAdjustWallet({ tenantId, amountPaise: 1_000 });
    // 5 captions at ₹2.40 = ₹12.00, more than the ₹10.00 balance.
    expect(await reserveWallet(tenantId, "caption", {}, 5)).toBeNull();
    expect(await getWalletBalancePaise(tenantId)).toBe(1_000);

    const reservation = await reserveWallet(tenantId, "caption", {}, 4);
    expect(reservation!.amountPaise).toBe(960);
    expect(reservation!.units).toBe(4);
  });

  it("never lets a concurrent pair both spend the last rupee", async () => {
    await adminAdjustWallet({ tenantId, amountPaise: 300 });
    const [a, b] = await Promise.all([
      reserveWallet(tenantId, "caption"),
      reserveWallet(tenantId, "caption"),
    ]);
    // Balance covers exactly one ₹2.40 reservation.
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await getWalletBalancePaise(tenantId)).toBe(60);
  });
});

describe("top-ups", () => {
  it("credits the base amount only, and records the GST split", async () => {
    const orderId = `order_${randomUUID()}`;
    expect(
      await creditWalletTopup({
        tenantId,
        basePaise: 100_000,
        gstPaise: 18_000,
        gstPercent: 18,
        razorpayOrderId: orderId,
      }),
    ).toBe(true);
    // The wallet gets ₹1,000 even though ₹1,180 was charged.
    expect(await getWalletBalancePaise(tenantId)).toBe(100_000);

    const [entry] = await listWalletHistory(tenantId, 1);
    expect(entry.kind).toBe("topup");
    expect(entry.baseAmountPaise).toBe(100_000);
    expect(entry.gstAmountPaise).toBe(18_000);
    expect(entry.gstPercent).toBe(18);
  });

  it("is idempotent per Razorpay order", async () => {
    const orderId = `order_${randomUUID()}`;
    const params = {
      tenantId,
      basePaise: 50_000,
      gstPaise: 9_000,
      gstPercent: 18,
      razorpayOrderId: orderId,
    };
    expect(await creditWalletTopup(params)).toBe(true);
    // A webhook redelivery racing the browser verification must not double it.
    expect(await creditWalletTopup(params)).toBe(false);
    expect(await getWalletBalancePaise(tenantId)).toBe(50_000);
  });
});

describe("admin adjustments", () => {
  it("adds and deducts, and never goes negative", async () => {
    await adminAdjustWallet({ tenantId, amountPaise: 5_000, note: "goodwill" });
    expect(await getWalletBalancePaise(tenantId)).toBe(5_000);

    // Deducting more than the balance clamps at zero, and the ledger records
    // the delta that was ACTUALLY applied so it still reconciles.
    const result = await adminAdjustWallet({ tenantId, amountPaise: -9_000 });
    expect(result.balancePaise).toBe(0);
    expect(result.appliedPaise).toBe(-5_000);
    expect(await ledgerSum(tenantId)).toBe(0);
  });
});

describe("reservationFromRow", () => {
  it("rebuilds a background job's reservation, and returns null without one", () => {
    expect(
      reservationFromRow({ walletReservationId: 7, walletReservedPaise: 240 }),
    ).toEqual({ id: 7, amountPaise: 240, units: 1 });
    expect(
      reservationFromRow({ walletReservationId: null, walletReservedPaise: null }),
    ).toBeNull();
  });

  it("carries a multi-unit job's real unit count", () => {
    // A 12-scene character video reserved 12 units; rebuilding it as 1 would
    // settle at a twelfth of what was taken.
    expect(
      reservationFromRow({
        walletReservationId: 9,
        walletReservedPaise: 14_400,
        walletReservedUnits: 12,
      }),
    ).toEqual({ id: 9, amountPaise: 14_400, units: 12 });
  });
});

describe("multi-unit settlement", () => {
  it("settles a 12-unit video against 12 units of the display rate", async () => {
    await adminAdjustWallet({ tenantId, amountPaise: 50_000 });
    const reservation = await reserveWallet(tenantId, "video", {}, 12);
    // ₹12.00 per unit × 12.
    expect(reservation!.amountPaise).toBe(14_400);

    // Video providers report no cost, so this settles at the display rate —
    // for all twelve units, not one.
    const settled = await settleWallet(tenantId, reservation!, {
      kind: "video",
      costPaise: null,
    });
    expect(settled.estimated).toBe(true);
    expect(settled.chargedPaise).toBe(14_400);
    expect(await getWalletBalancePaise(tenantId)).toBe(50_000 - 14_400);
    expect(await ledgerSum(tenantId)).toBe(await getWalletBalancePaise(tenantId));
  });
});

describe("true-up after a price is saved", () => {
  const CASE_MODEL = "Foo/Bar-Model";
  const FALLBACK_MODEL = `Foo/Bar-Fallback-${Date.now()}`;
  let originalRatePaise: number;
  const priceIds: number[] = [];

  beforeAll(async () => {
    originalRatePaise = (await getAiCostConfig()).usdToInrPaise;
    await setAiCostConfig({ usdToInrPaise: 8_600 }); // ₹86 per USD
  });

  afterAll(async () => {
    if (priceIds.length > 0) {
      await db.delete(aiModelPricesTable).where(inArray(aiModelPricesTable.id, priceIds));
    }
    await setAiCostConfig({ usdToInrPaise: originalRatePaise });
  });

  it("collects the shortfall even when the saved price's casing/whitespace differs", async () => {
    await adminAdjustWallet({ tenantId, amountPaise: 10_000 });

    // Charge at the ₹2.40 display rate because the model has no price yet.
    const reservation = await reserveWallet(tenantId, "caption", {
      model: CASE_MODEL,
      provider: "openrouter",
    });
    const settled = await settleWallet(tenantId, reservation!, {
      kind: "caption",
      costPaise: null,
      provider: "openrouter",
      model: CASE_MODEL,
      inputTokens: 100_000,
      outputTokens: 50_000,
    });
    expect(settled.estimated).toBe(true);
    expect(settled.chargedPaise).toBe(240);
    expect(await getWalletBalancePaise(tenantId)).toBe(9_760);

    // Admin types the price with different case AND surrounding whitespace.
    const price = await upsertModelPrice({
      kind: "text",
      provider: " OpenRouter ",
      model: " foo/bar-model ",
      inputUsdPerMtok: 2,
      outputUsdPerMtok: 8,
      usdPerImage: null,
      usdPerSecond: null,
      usdPerVideo: null,
    });
    priceIds.push(price.id);

    // Real cost: $0.2 + $0.4 = $0.6 → 5,160 paise → +20% fee = 6,192.
    // Already charged 240, so the shortfall is 5,952.
    const result = await trueUpModel({
      kind: "text",
      provider: price.provider,
      model: price.model,
    });
    expect(result.rowsTruedUp).toBe(1);
    expect(result.netPaise).toBe(-5_952);
    expect(await getWalletBalancePaise(tenantId)).toBe(9_760 - 5_952);
    expect(await ledgerSum(tenantId)).toBe(await getWalletBalancePaise(tenantId));

    // The pending row is cleared — a second save must not charge again.
    const pending = await listPendingPricedModels();
    expect(pending.some((p) => p.model === CASE_MODEL)).toBe(false);
    const again = await trueUpModel({
      kind: "text",
      provider: price.provider,
      model: price.model,
    });
    expect(again.rowsTruedUp).toBe(0);
    expect(await getWalletBalancePaise(tenantId)).toBe(9_760 - 5_952);
  });

  it("trues up via the model-only fallback when the catalog row's provider differs", async () => {
    await adminAdjustWallet({ tenantId, amountPaise: 10_000 });

    // Ledger says openrouter; the admin saves the price under builtin.
    const reservation = await reserveWallet(tenantId, "caption", {
      model: FALLBACK_MODEL,
      provider: "openrouter",
    });
    const settled = await settleWallet(tenantId, reservation!, {
      kind: "caption",
      costPaise: null,
      provider: "openrouter",
      model: FALLBACK_MODEL,
      inputTokens: 5_000,
      outputTokens: 5_000,
    });
    expect(settled.estimated).toBe(true);
    expect(settled.chargedPaise).toBe(240);

    const price = await upsertModelPrice({
      kind: "text",
      provider: "builtin",
      model: FALLBACK_MODEL,
      inputUsdPerMtok: 1,
      outputUsdPerMtok: 1,
      usdPerImage: null,
      usdPerSecond: null,
      usdPerVideo: null,
    });
    priceIds.push(price.id);

    // Real cost: $0.01 → 86 paise → +20% fee = 103. Charged 240, so the
    // 137-paise OVERCHARGE comes back as a refund.
    const result = await trueUpModel({
      kind: "text",
      provider: price.provider,
      model: price.model,
    });
    expect(result.rowsTruedUp).toBe(1);
    expect(result.netPaise).toBe(137);
    expect(await getWalletBalancePaise(tenantId)).toBe(9_760 + 137);
    expect(await ledgerSum(tenantId)).toBe(await getWalletBalancePaise(tenantId));
    expect((await listPendingPricedModels()).some((p) => p.model === FALLBACK_MODEL)).toBe(
      false,
    );
  });

  it("trues up an estimated video per-second using the job's stored duration", async () => {
    await adminAdjustWallet({ tenantId, amountPaise: 20_000 });
    const model = `video-persec-${randomUUID().slice(0, 8)}`;

    // The job the settle row links back to: it stored the requested clip
    // length, which is what the per-second true-up prices.
    const [job] = await db
      .insert(videoGenerationsTable)
      .values({
        tenantId,
        engine: "text_to_video",
        status: "succeeded",
        options: { aspectRatio: "16:9", durationSec: 10 },
        provider: "replicate",
        model,
      })
      .returning({ id: videoGenerationsTable.id });

    try {
      // Settled at the ₹12.00 display fallback (₹10.00 + 20% fee).
      const reservation = await reserveWallet(tenantId, "video", {
        model,
        provider: "replicate",
      });
      const settled = await settleWallet(tenantId, reservation!, {
        kind: "video",
        costPaise: null,
        provider: "replicate",
        model,
        refKind: "videoJob",
        refId: String(job.id),
      });
      expect(settled.estimated).toBe(true);
      expect(settled.chargedPaise).toBe(1_200);

      const price = await upsertModelPrice({
        kind: "video",
        provider: "replicate",
        model,
        inputUsdPerMtok: null,
        outputUsdPerMtok: null,
        usdPerImage: null,
        usdPerSecond: 0.05,
        usdPerVideo: null,
      });
      priceIds.push(price.id);

      // Real cost: 10s × $0.05 = $0.50 → 4,300 paise → +20% fee = 5,160.
      // Already charged 1,200, so the shortfall is 3,960.
      const result = await trueUpModel({ kind: "video", provider: "replicate", model });
      expect(result.rowsTruedUp).toBe(1);
      expect(result.netPaise).toBe(-3_960);
      expect(await getWalletBalancePaise(tenantId)).toBe(20_000 - 1_200 - 3_960);
      expect(await ledgerSum(tenantId)).toBe(await getWalletBalancePaise(tenantId));
      expect((await listPendingPricedModels()).some((p) => p.model === model)).toBe(false);
    } finally {
      await db.delete(videoGenerationsTable).where(eq(videoGenerationsTable.id, job.id));
    }
  });

  it("trues up a video at the flat per-video price when no duration is stored", async () => {
    await adminAdjustWallet({ tenantId, amountPaise: 20_000 });
    const model = `video-flat-${randomUUID().slice(0, 8)}`;

    // No job link at all: the flat per-video price must still apply.
    const reservation = await reserveWallet(tenantId, "video", {
      model,
      provider: "replicate",
    });
    const settled = await settleWallet(tenantId, reservation!, {
      kind: "video",
      costPaise: null,
      provider: "replicate",
      model,
    });
    expect(settled.estimated).toBe(true);
    expect(settled.chargedPaise).toBe(1_200);

    const price = await upsertModelPrice({
      kind: "video",
      provider: "replicate",
      model,
      inputUsdPerMtok: null,
      outputUsdPerMtok: null,
      usdPerImage: null,
      usdPerSecond: null,
      usdPerVideo: 0.1,
    });
    priceIds.push(price.id);

    // Real cost: $0.10 → 860 paise → +20% fee = 1,032. Charged 1,200, so
    // the 168-paise overcharge is refunded.
    const result = await trueUpModel({ kind: "video", provider: "replicate", model });
    expect(result.rowsTruedUp).toBe(1);
    expect(result.netPaise).toBe(168);
    expect(await getWalletBalancePaise(tenantId)).toBe(20_000 - 1_200 + 168);
    expect(await ledgerSum(tenantId)).toBe(await getWalletBalancePaise(tenantId));
  });

  it("leaves a video pending when it is priced per-second but no duration exists", async () => {
    await adminAdjustWallet({ tenantId, amountPaise: 20_000 });
    const model = `video-nodur-${randomUUID().slice(0, 8)}`;

    const reservation = await reserveWallet(tenantId, "video", {
      model,
      provider: "replicate",
    });
    await settleWallet(tenantId, reservation!, {
      kind: "video",
      costPaise: null,
      provider: "replicate",
      model,
    });

    // Per-second ONLY — with no stored duration the real cost cannot be
    // computed, and it must never be guessed.
    const price = await upsertModelPrice({
      kind: "video",
      provider: "replicate",
      model,
      inputUsdPerMtok: null,
      outputUsdPerMtok: null,
      usdPerImage: null,
      usdPerSecond: 0.05,
      usdPerVideo: null,
    });
    priceIds.push(price.id);

    const result = await trueUpModel({ kind: "video", provider: "replicate", model });
    expect(result.rowsTruedUp).toBe(0);
    expect((await listPendingPricedModels()).some((p) => p.model === model)).toBe(true);
    expect(await getWalletBalancePaise(tenantId)).toBe(20_000 - 1_200);
  });

  it("never forgives a shortfall the wallet cannot cover — the remainder is collected on the next top-up", async () => {
    const SHORTFALL_MODEL = `Foo/Bar-Shortfall-${randomUUID().slice(0, 8)}`;
    // Just enough for the reserve, almost nothing left after settling.
    await adminAdjustWallet({ tenantId, amountPaise: 300 });
    const reservation = await reserveWallet(tenantId, "caption", {
      model: SHORTFALL_MODEL,
      provider: "openrouter",
    });
    const settled = await settleWallet(tenantId, reservation!, {
      kind: "caption",
      costPaise: null,
      provider: "openrouter",
      model: SHORTFALL_MODEL,
      inputTokens: 100_000,
      outputTokens: 50_000,
    });
    expect(settled.estimated).toBe(true);
    expect(settled.chargedPaise).toBe(240);
    expect(await getWalletBalancePaise(tenantId)).toBe(60);

    const price = await upsertModelPrice({
      kind: "text",
      provider: "openrouter",
      model: SHORTFALL_MODEL,
      inputUsdPerMtok: 2,
      outputUsdPerMtok: 8,
      usdPerImage: null,
      usdPerSecond: null,
      usdPerVideo: null,
    });
    priceIds.push(price.id);

    // Real charge 6,192; already charged 240 → shortfall 5,952. Only ₹0.60
    // is in the wallet, so 60 is collected and 5,892 stays OWED.
    const result = await trueUpModel({
      kind: "text",
      provider: price.provider,
      model: price.model,
    });
    expect(result.rowsTruedUp).toBe(0); // not fully collected → still pending
    expect(result.netPaise).toBe(-60);
    expect(result.uncollectedPaise).toBe(5_892);
    expect(await getWalletBalancePaise(tenantId)).toBe(0);
    expect(await ledgerSum(tenantId)).toBe(0);

    // The row is NOT stamped trued-up: it still shows as pending, and the
    // partial true_up ledger row records exactly what is still due.
    expect(
      (await listPendingPricedModels()).some((p) => p.model === SHORTFALL_MODEL),
    ).toBe(true);
    const history = await listWalletHistory(tenantId, 10);
    const partial = history.find((e) => e.kind === "true_up");
    expect(partial?.amountPaise).toBe(-60);
    expect(partial?.note).toContain("5892 paise still due");

    // A top-up arrives → the remainder is collected automatically, once.
    await creditWalletTopup({
      tenantId,
      basePaise: 100_000,
      gstPaise: 18_000,
      gstPercent: 18,
      razorpayOrderId: `order_${randomUUID()}`,
    });
    expect(await getWalletBalancePaise(tenantId)).toBe(100_000 - 5_892);
    expect(await ledgerSum(tenantId)).toBe(100_000 - 5_892);
    expect(
      (await listPendingPricedModels()).some((p) => p.model === SHORTFALL_MODEL),
    ).toBe(false);

    // Neither a re-save of the price nor another top-up may charge again.
    const again = await trueUpModel({
      kind: "text",
      provider: price.provider,
      model: price.model,
    });
    expect(again.rowsTruedUp).toBe(0);
    expect(again.netPaise).toBe(0);
    await creditWalletTopup({
      tenantId,
      basePaise: 50_000,
      gstPaise: 9_000,
      gstPercent: 18,
      razorpayOrderId: `order_${randomUUID()}`,
    });
    expect(await getWalletBalancePaise(tenantId)).toBe(150_000 - 5_892);
    expect(await ledgerSum(tenantId)).toBe(150_000 - 5_892);
  });

  it("collects a partially collected VIDEO shortfall on the next top-up too", async () => {
    const MODEL = `video-shortfall-${randomUUID().slice(0, 8)}`;
    // ₹13.00: enough for the ₹12.00 video reserve, ₹1.00 left after settling.
    await adminAdjustWallet({ tenantId, amountPaise: 1_300 });
    const reservation = await reserveWallet(tenantId, "video", {
      model: MODEL,
      provider: "replicate",
    });
    const settled = await settleWallet(tenantId, reservation!, {
      kind: "video",
      costPaise: null,
      provider: "replicate",
      model: MODEL,
    });
    expect(settled.estimated).toBe(true);
    expect(settled.chargedPaise).toBe(1_200);
    expect(await getWalletBalancePaise(tenantId)).toBe(100);

    // Flat per-video price: $0.50 → 4,300 paise → +20% fee = 5,160. Already
    // charged 1,200 → shortfall 3,960; only ₹1.00 is available.
    const price = await upsertModelPrice({
      kind: "video",
      provider: "replicate",
      model: MODEL,
      inputUsdPerMtok: null,
      outputUsdPerMtok: null,
      usdPerImage: null,
      usdPerSecond: null,
      usdPerVideo: 0.5,
    });
    priceIds.push(price.id);

    const result = await trueUpModel({ kind: "video", provider: "replicate", model: MODEL });
    expect(result.rowsTruedUp).toBe(0);
    expect(result.netPaise).toBe(-100);
    expect(result.uncollectedPaise).toBe(3_860);
    expect(await getWalletBalancePaise(tenantId)).toBe(0);

    // The top-up collects the 3,860-paise remainder automatically.
    await creditWalletTopup({
      tenantId,
      basePaise: 100_000,
      gstPaise: 18_000,
      gstPercent: 18,
      razorpayOrderId: `order_${randomUUID()}`,
    });
    expect(await getWalletBalancePaise(tenantId)).toBe(100_000 - 3_860);
    expect(await ledgerSum(tenantId)).toBe(100_000 - 3_860);
    expect((await listPendingPricedModels()).some((p) => p.model === MODEL)).toBe(false);
  });

  it("one tenant's top-up never debits another tenant's pending shortfall", async () => {
    const MODEL = `Foo/Bar-Isolation-${randomUUID().slice(0, 8)}`;
    const other = await createTenant();
    try {
      // Both tenants owe a shortfall on the SAME model.
      for (const id of [tenantId, other.tenantId]) {
        await adminAdjustWallet({ tenantId: id, amountPaise: 300 });
        const reservation = await reserveWallet(id, "caption", {
          model: MODEL,
          provider: "openrouter",
        });
        await settleWallet(id, reservation!, {
          kind: "caption",
          costPaise: null,
          provider: "openrouter",
          model: MODEL,
          inputTokens: 100_000,
          outputTokens: 50_000,
        });
        expect(await getWalletBalancePaise(id)).toBe(60);
      }

      const price = await upsertModelPrice({
        kind: "text",
        provider: "openrouter",
        model: MODEL,
        inputUsdPerMtok: 2,
        outputUsdPerMtok: 8,
        usdPerImage: null,
        usdPerSecond: null,
        usdPerVideo: null,
      });
      priceIds.push(price.id);

      // Tenant A tops up. Only A's remainder may be collected; B keeps its
      // ₹0.60 and its row stays pending until B pays.
      await creditWalletTopup({
        tenantId,
        basePaise: 100_000,
        gstPaise: 18_000,
        gstPercent: 18,
        razorpayOrderId: `order_${randomUUID()}`,
      });
      // A: 60 remaining balance + 100,000 top-up − 6,192 real charge + 240 already paid.
      expect(await getWalletBalancePaise(tenantId)).toBe(100_000 + 60 - 5_952);
      expect(await getWalletBalancePaise(other.tenantId)).toBe(60);
      expect(await ledgerSum(other.tenantId)).toBe(60);

      // B's row is still pending — nothing was forgiven or taken.
      const [bPending] = await db
        .select()
        .from(walletLedgerTable)
        .where(eq(walletLedgerTable.tenantId, other.tenantId))
        .then((rows) => rows.filter((r) => r.kind === "settle"));
      expect(bPending.trueUpAt).toBeNull();
    } finally {
      await db
        .delete(walletLedgerTable)
        .where(eq(walletLedgerTable.tenantId, other.tenantId));
      await db
        .delete(walletBalancesTable)
        .where(eq(walletBalancesTable.tenantId, other.tenantId));
      await deleteTenant(other.tenantId);
    }
  });

  it("concurrent true-up triggers collect the shortfall exactly once", async () => {
    const MODEL = `Foo/Bar-Race-${randomUUID().slice(0, 8)}`;
    await adminAdjustWallet({ tenantId, amountPaise: 20_000 });
    const reservation = await reserveWallet(tenantId, "caption", {
      model: MODEL,
      provider: "openrouter",
    });
    await settleWallet(tenantId, reservation!, {
      kind: "caption",
      costPaise: null,
      provider: "openrouter",
      model: MODEL,
      inputTokens: 100_000,
      outputTokens: 50_000,
    });
    expect(await getWalletBalancePaise(tenantId)).toBe(19_760);

    const price = await upsertModelPrice({
      kind: "text",
      provider: "openrouter",
      model: MODEL,
      inputUsdPerMtok: 2,
      outputUsdPerMtok: 8,
      usdPerImage: null,
      usdPerSecond: null,
      usdPerVideo: null,
    });
    priceIds.push(price.id);

    // Price save and boot sweep firing at once must not both take 5,952.
    const [a, b] = await Promise.all([
      trueUpModel({ kind: "text", provider: price.provider, model: price.model }),
      trueUpModel({ kind: "text", provider: price.provider, model: price.model }),
    ]);
    expect(a.rowsTruedUp + b.rowsTruedUp).toBe(1);
    expect(a.netPaise + b.netPaise).toBe(-5_952);
    expect(await getWalletBalancePaise(tenantId)).toBe(19_760 - 5_952);
    expect(await ledgerSum(tenantId)).toBe(19_760 - 5_952);
  });
});

describe("sweepStuckPendingTrueUps", () => {
  const MODEL = `sweep-stuck-${randomUUID().slice(0, 8)}`;
  let sweepOriginalRatePaise = 0;

  beforeAll(async () => {
    sweepOriginalRatePaise = (await getAiCostConfig()).usdToInrPaise;
    await setAiCostConfig({ usdToInrPaise: 8_600 }); // ₹86 per USD
  });

  afterAll(async () => {
    await db
      .delete(aiModelPricesTable)
      .where(eq(aiModelPricesTable.model, MODEL.toUpperCase()));
    await setAiCostConfig({ usdToInrPaise: sweepOriginalRatePaise });
  });

  it("trues up rows stuck pending even though a matching price exists", async () => {
    await adminAdjustWallet({ tenantId, amountPaise: 10_000 });

    // An image generation settled at the display rate because the model had
    // no price: ₹6.00 charged (₹5.00 + 20% fee), flagged estimated.
    const reservation = await reserveWallet(tenantId, "image", {
      model: MODEL,
      provider: "somewhere",
    });
    const settled = await settleWallet(tenantId, reservation!, {
      kind: "image",
      costPaise: null,
      model: MODEL,
      provider: "somewhere",
    });
    expect(settled.estimated).toBe(true);
    expect(settled.chargedPaise).toBe(600);

    // A price row that ALREADY exists, but under different casing — exactly
    // the shape the old exact-match true-up left permanently stuck.
    await db.insert(aiModelPricesTable).values({
      kind: "image",
      provider: "elsewhere",
      model: MODEL.toUpperCase(),
      inputUsdPerMtok: null,
      outputUsdPerMtok: null,
      usdPerImage: 0.05, // ₹4.30 at the test rate → ₹5.16 with the 20% fee
      usdPerSecond: null,
      usdPerVideo: null,
    });

    await sweepStuckPendingTrueUps();

    // The pending list no longer shows the model...
    const pending = await listPendingPricedModels();
    expect(pending.some((p) => p.model === MODEL)).toBe(false);
    // ...and the ₹0.84 overcharge came back (600 - 516).
    expect(await getWalletBalancePaise(tenantId)).toBe(10_000 - 600 + 84);
    expect(await ledgerSum(tenantId)).toBe(await getWalletBalancePaise(tenantId));

    // Running the sweep again must not move money twice.
    await sweepStuckPendingTrueUps();
    expect(await getWalletBalancePaise(tenantId)).toBe(10_000 - 600 + 84);
  });

  it("clears stuck video rows once a price exists", async () => {
    await adminAdjustWallet({ tenantId, amountPaise: 20_000 });
    const model = `sweep-video-${randomUUID().slice(0, 8)}`;

    // A video settled at the ₹12.00 display fallback, stuck on the pending
    // list from before the sweep handled videos at all.
    const reservation = await reserveWallet(tenantId, "video", {
      model,
      provider: "replicate",
    });
    const settled = await settleWallet(tenantId, reservation!, {
      kind: "video",
      costPaise: null,
      provider: "replicate",
      model,
    });
    expect(settled.estimated).toBe(true);
    expect(settled.chargedPaise).toBe(1_200);

    const price = await upsertModelPrice({
      kind: "video",
      provider: "replicate",
      model,
      inputUsdPerMtok: null,
      outputUsdPerMtok: null,
      usdPerImage: null,
      usdPerSecond: null,
      usdPerVideo: 0.1, // $0.10 → 860 paise → ₹10.32 with the 20% fee
    });

    try {
      await sweepStuckPendingTrueUps();

      const pending = await listPendingPricedModels();
      expect(pending.some((p) => p.model === model)).toBe(false);
      // The ₹1.68 overcharge came back (1,200 - 1,032).
      expect(await getWalletBalancePaise(tenantId)).toBe(20_000 - 1_200 + 168);
      expect(await ledgerSum(tenantId)).toBe(await getWalletBalancePaise(tenantId));
    } finally {
      await db.delete(aiModelPricesTable).where(eq(aiModelPricesTable.id, price.id));
    }
  });

  it("leaves rows pending when the catalog still has no price", async () => {
    await adminAdjustWallet({ tenantId, amountPaise: 10_000 });
    const unpriced = `never-priced-${randomUUID().slice(0, 8)}`;
    const reservation = await reserveWallet(tenantId, "image", { model: unpriced });
    await settleWallet(tenantId, reservation!, {
      kind: "image",
      costPaise: null,
      model: unpriced,
    });

    await sweepStuckPendingTrueUps();

    const pending = await listPendingPricedModels();
    expect(pending.some((p) => p.model === unpriced)).toBe(true);
    expect(await getWalletBalancePaise(tenantId)).toBe(10_000 - 600);
  });
});

describe("pending-list diagnosis and manual reconcile", () => {
  let diagOriginalRatePaise = 0;
  const priceIds: number[] = [];

  beforeAll(async () => {
    diagOriginalRatePaise = (await getAiCostConfig()).usdToInrPaise;
    await setAiCostConfig({ usdToInrPaise: 8_600 }); // ₹86 per USD
  });

  afterAll(async () => {
    if (priceIds.length > 0) {
      await db.delete(aiModelPricesTable).where(inArray(aiModelPricesTable.id, priceIds));
    }
    await setAiCostConfig({ usdToInrPaise: diagOriginalRatePaise });
  });

  it("reports no_price when the catalog has no row at all", async () => {
    await adminAdjustWallet({ tenantId, amountPaise: 10_000 });
    const model = `diag-unpriced-${randomUUID().slice(0, 8)}`;
    const reservation = await reserveWallet(tenantId, "image", { model });
    await settleWallet(tenantId, reservation!, { kind: "image", costPaise: null, model });

    const group = (await listPendingPricedModels()).find((p) => p.model === model);
    expect(group).toBeDefined();
    expect(group!.reason).toBe("no_price");
    expect(group!.priceProvider).toBeNull();
  });

  it("reports missing_usage when a token-priced model's charges recorded no usage", async () => {
    await adminAdjustWallet({ tenantId, amountPaise: 10_000 });
    const model = `diag-nousage-${randomUUID().slice(0, 8)}`;
    // The prod shape: a caption charged at the display rate with NO tokens.
    const reservation = await reserveWallet(tenantId, "caption", {
      model,
      provider: "builtin",
    });
    await settleWallet(tenantId, reservation!, {
      kind: "caption",
      costPaise: null,
      provider: "builtin",
      model,
      inputTokens: null,
      outputTokens: null,
    });
    const price = await upsertModelPrice({
      kind: "text",
      provider: "builtin",
      model,
      inputUsdPerMtok: 2,
      outputUsdPerMtok: 8,
      usdPerImage: null,
      usdPerSecond: null,
      usdPerVideo: null,
    });
    priceIds.push(price.id);

    const group = (await listPendingPricedModels()).find((p) => p.model === model);
    expect(group).toBeDefined();
    expect(group!.reason).toBe("missing_usage");
    expect(group!.missingUsageCount).toBe(1);
    expect(group!.priceProvider).toBe("builtin");

    // Manual reconcile is honest: nothing settles, the reason survives.
    const result = await reconcilePendingModel({
      usageKind: "caption",
      provider: "builtin",
      model,
    });
    expect(result.settledRows).toBe(0);
    expect(result.remaining?.reason).toBe("missing_usage");
  });

  it("reports the model-only provider fallback in the diagnosis", async () => {
    await adminAdjustWallet({ tenantId, amountPaise: 10_000 });
    const model = `diag-fallback-${randomUUID().slice(0, 8)}`;
    const reservation = await reserveWallet(tenantId, "image", {
      model,
      provider: "openrouter",
    });
    await settleWallet(tenantId, reservation!, {
      kind: "image",
      costPaise: null,
      provider: "openrouter",
      model,
    });
    // Priced under a DIFFERENT provider — matched via the model-only fallback.
    const price = await upsertModelPrice({
      kind: "image",
      provider: "gemini",
      model,
      inputUsdPerMtok: null,
      outputUsdPerMtok: null,
      usdPerImage: 0.05, // 430 paise → 516 with the 20% fee
      usdPerSecond: null,
      usdPerVideo: null,
    });
    priceIds.push(price.id);

    const group = (await listPendingPricedModels()).find((p) => p.model === model);
    expect(group).toBeDefined();
    expect(group!.reason).toBe("not_reconciled");
    expect(group!.priceProvider).toBe("gemini");
    expect(group!.detail).toContain("model-only fallback");

    // Manual reconcile settles it and reports accurate counts.
    const before = await getWalletBalancePaise(tenantId);
    const result = await reconcilePendingModel({
      usageKind: "image",
      provider: "openrouter",
      model,
    });
    expect(result.settledRows).toBe(1);
    expect(result.remaining).toBeNull();
    // 600 charged, real is 516 → 84 refunded.
    expect(result.netPaise).toBe(84);
    expect(await getWalletBalancePaise(tenantId)).toBe(before + 84);
    expect((await listPendingPricedModels()).some((p) => p.model === model)).toBe(false);
  });

  it("reports price_incomplete when the row lacks the fields this kind needs", async () => {
    await adminAdjustWallet({ tenantId, amountPaise: 10_000 });
    const model = `diag-incomplete-${randomUUID().slice(0, 8)}`;
    const reservation = await reserveWallet(tenantId, "image", {
      model,
      provider: "openai",
    });
    await settleWallet(tenantId, reservation!, {
      kind: "image",
      costPaise: null,
      provider: "openai",
      model,
    });
    // An image price row with no per-image price and no token pair — bypass
    // upsertModelPrice's validation the way a hand-edited row could.
    const [row] = await db
      .insert(aiModelPricesTable)
      .values({
        kind: "image",
        provider: "openai",
        model,
        inputUsdPerMtok: null,
        outputUsdPerMtok: null,
        usdPerImage: null,
        usdPerSecond: null,
        usdPerVideo: null,
      })
      .returning({ id: aiModelPricesTable.id });
    priceIds.push(row.id);

    const group = (await listPendingPricedModels()).find((p) => p.model === model);
    expect(group).toBeDefined();
    expect(group!.reason).toBe("price_incomplete");
  });

  it("reports no_fx_rate when a usable price exists but the rate is unset", async () => {
    await adminAdjustWallet({ tenantId, amountPaise: 10_000 });
    const model = `diag-nofx-${randomUUID().slice(0, 8)}`;
    const reservation = await reserveWallet(tenantId, "image", { model });
    await settleWallet(tenantId, reservation!, { kind: "image", costPaise: null, model });
    const price = await upsertModelPrice({
      kind: "image",
      provider: "openai",
      model,
      inputUsdPerMtok: null,
      outputUsdPerMtok: null,
      usdPerImage: 0.05,
      usdPerSecond: null,
      usdPerVideo: null,
    });
    priceIds.push(price.id);

    await setAiCostConfig({ usdToInrPaise: 0 });
    try {
      const group = (await listPendingPricedModels()).find((p) => p.model === model);
      expect(group).toBeDefined();
      expect(group!.reason).toBe("no_fx_rate");
    } finally {
      await setAiCostConfig({ usdToInrPaise: 8_600 });
    }
  });

  it("the background retry loop trues up a priced model without a price re-save", async () => {
    await adminAdjustWallet({ tenantId, amountPaise: 10_000 });
    const model = `diag-retry-${randomUUID().slice(0, 8)}`;
    const reservation = await reserveWallet(tenantId, "image", {
      model,
      provider: "openai",
    });
    await settleWallet(tenantId, reservation!, {
      kind: "image",
      costPaise: null,
      provider: "openai",
      model,
    });
    // The price exists (as in prod) but the fire-and-forget save hook never
    // ran for these rows — insert directly so no true-up is triggered.
    const [row] = await db
      .insert(aiModelPricesTable)
      .values({
        kind: "image",
        provider: "openai",
        model,
        inputUsdPerMtok: null,
        outputUsdPerMtok: null,
        usdPerImage: 0.05, // 430 paise → 516 with the 20% fee
        usdPerSecond: null,
        usdPerVideo: null,
      })
      .returning({ id: aiModelPricesTable.id });
    priceIds.push(row.id);
    expect((await listPendingPricedModels()).some((p) => p.model === model)).toBe(true);

    startTrueUpRetrySweep(25);
    try {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (!(await listPendingPricedModels()).some((p) => p.model === model)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      stopTrueUpRetrySweep();
    }
    expect((await listPendingPricedModels()).some((p) => p.model === model)).toBe(false);
    expect(await ledgerSum(tenantId)).toBe(await getWalletBalancePaise(tenantId));
  });

  it("rejects an unknown usage kind", async () => {
    await expect(
      reconcilePendingModel({ usageKind: "nonsense", provider: null, model: "x" }),
    ).rejects.toThrow(/usage kind/i);
  });
});

describe("concurrent first movements", () => {
  it("credits two simultaneous first top-ups without losing one", async () => {
    // The balance row does not exist yet: without an upsert before the row
    // lock, both transactions would race to INSERT and one payment would be
    // silently lost.
    const [a, b] = await Promise.all([
      creditWalletTopup({
        tenantId,
        basePaise: 100_000,
        gstPaise: 18_000,
        gstPercent: 18,
        razorpayOrderId: `order_${randomUUID()}`,
      }),
      creditWalletTopup({
        tenantId,
        basePaise: 100_000,
        gstPaise: 18_000,
        gstPercent: 18,
        razorpayOrderId: `order_${randomUUID()}`,
      }),
    ]);
    expect([a, b]).toEqual([true, true]);
    expect(await getWalletBalancePaise(tenantId)).toBe(200_000);
    expect(await ledgerSum(tenantId)).toBe(200_000);
  });
});
