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
} from "./wallet";
import { setAiSpendConfig } from "./aiSpend";
import { invalidateFeatureFlagCache } from "./featureFlags";
import { createTenant, deleteTenant } from "../test/dbHelpers";

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

beforeAll(async () => {
  const t = await createTenant();
  tenantId = t.tenantId;
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
  await db.delete(walletSettingsTable);
  await db.delete(aiSpendSettingsTable);
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
