import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import {
  db,
  pool,
  walletBalancesTable,
  walletLedgerTable,
  walletProviderOperationsTable,
  walletSettlementRetriesTable,
  walletSettingsTable,
  aiSpendSettingsTable,
  featureFlagsTable,
  tenantsTable,
  aiModelPricesTable,
  videoGenerationsTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
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
  settleWalletDurably,
  beginWalletProviderOperation,
  confirmWalletProviderOperationSucceeded,
  executeWalletProviderOperation,
  markWalletProviderOperationFailed,
  refundWalletProviderOperation,
  settleWalletProviderOperationDurably,
  sweepWalletProviderOperations,
  retryWalletSettlement,
  sweepWalletSettlementRetries,
  listWalletSettlementRetries,
  refundWallet,
  creditWalletTopup,
  adminAdjustWallet,
  listWalletHistory,
  listPendingPricedModels,
  listVideoWalletReconciliationReport,
  getVideoJobWalletChargesPaise,
  reconcileVideoJobWalletCost,
  reservationFromRow,
  trueUpModel,
  sweepStuckPendingTrueUps,
  reconcilePendingModel,
  startTrueUpRetrySweep,
  stopTrueUpRetrySweep,
  initTrueUpFailCounts,
  resetTrueUpFailCounts,
  WALLET_TRUEUP_FAIL_ALERT_THRESHOLD,
  WALLET_SETTLEMENT_MAX_ATTEMPTS,
  WalletProviderPostSuccessError,
} from "./wallet";
import * as notifications from "./notifications";
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
  await db
    .delete(walletProviderOperationsTable)
    .where(eq(walletProviderOperationsTable.tenantId, tenantId));
  await db
    .delete(walletSettlementRetriesTable)
    .where(eq(walletSettlementRetriesTable.tenantId, tenantId));
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
  await db
    .delete(walletProviderOperationsTable)
    .where(eq(walletProviderOperationsTable.tenantId, tenantId));
  await db
    .delete(walletSettlementRetriesTable)
    .where(eq(walletSettlementRetriesTable.tenantId, tenantId));
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

  it("reserves the known actual cost including the platform fee before a provider call", async () => {
    // Test setup's fee is 20%, so a 100-paise known cost must hold 120.
    await adminAdjustWallet({ tenantId, amountPaise: 119 });
    expect(await reserveWallet(tenantId, "caption", {}, 1, 100)).toBeNull();
    await adminAdjustWallet({ tenantId, amountPaise: 1 });
    const reservation = await reserveWallet(tenantId, "caption", {}, 1, 100);
    expect(reservation?.amountPaise).toBe(120);
    expect(await getWalletBalancePaise(tenantId)).toBe(0);
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

  it("settles one reservation exactly once when duplicate retries race", async () => {
    await adminAdjustWallet({ tenantId, amountPaise: 10_000 });
    const reservation = await reserveWallet(tenantId, "caption");
    const meta = {
      kind: "caption" as const,
      costPaise: 100,
      provider: "test",
      model: "duplicate-retry",
    };

    const [first, second] = await Promise.all([
      settleWallet(tenantId, reservation!, meta),
      settleWallet(tenantId, reservation!, meta),
    ]);

    expect(first.chargedPaise).toBe(120);
    expect(second.chargedPaise).toBe(120);
    const rows = await db
      .select()
      .from(walletLedgerTable)
      .where(eq(walletLedgerTable.reservationId, reservation!.id));
    expect(rows.filter((row) => row.kind === "settle")).toHaveLength(1);
    expect(await getWalletBalancePaise(tenantId)).toBe(9_880);
  });
});

describe("event-level video wallet reconciliation", () => {
  it("applies the 20% fee once, includes narration once, and is concurrent-idempotent", async () => {
    const previousFx = (await getAiCostConfig()).usdToInrPaise;
    const visualModel = `visual-${randomUUID()}`;
    const lipModel = `lip-${randomUUID()}`;
    const priceIds: number[] = [];
    let jobId: number | null = null;
    try {
      await setAiCostConfig({ usdToInrPaise: 10_000 });
      priceIds.push(
        (
          await upsertModelPrice({
            kind: "video",
            provider: "replicate",
            model: visualModel,
            inputUsdPerMtok: null,
            outputUsdPerMtok: null,
            usdPerImage: null,
            usdPerSecond: null,
            usdPerVideo: 0.1,
          })
        ).id,
        (
          await upsertModelPrice({
            kind: "video",
            provider: "openrouter",
            model: lipModel,
            inputUsdPerMtok: null,
            outputUsdPerMtok: null,
            usdPerImage: null,
            usdPerSecond: 0.05,
            usdPerVideo: null,
          })
        ).id,
      );
      await adminAdjustWallet({ tenantId, amountPaise: 30_000 });
      const main = await reserveWallet(tenantId, "video", {}, 4);
      expect(main).not.toBeNull();

      const [job] = await db
        .insert(videoGenerationsTable)
        .values({
          tenantId,
          engine: "dialogue_lip_sync",
          status: "succeeded",
          funding: "wallet",
          walletReservationId: main!.id,
          walletReservedPaise: main!.amountPaise,
          walletReservedUnits: main!.units,
          spendPaise: 0,
          options: {
            aspectRatio: "16:9",
            characterDialogue: {
              version: 1,
              scriptApproved: true,
              locale: "en",
              modelId: "eleven_v3",
              direction: "ltr",
              script: "Latin",
              scriptName: "Latin",
              fontCandidates: ["Noto Sans"],
              characterId: 1,
              outfitId: 1,
              brandKitId: 1,
              scenes: [
                {
                  id: "scene-a",
                  text: "A",
                  visualPrompt: "A",
                  estimatedDurationSec: 4,
                  checkpoint: {
                    visualEvent: {
                      provider: "replicate",
                      model: visualModel,
                      durationSec: 4,
                      requestBytes: 1,
                      label: "character_plate:scene-a",
                      costPaise: null,
                    },
                    lipSyncEvent: {
                      provider: "openrouter",
                      model: lipModel,
                      durationSec: 4,
                      requestBytes: 1,
                      label: "lip_sync:scene-a",
                      costPaise: null,
                    },
                  },
                },
                {
                  id: "scene-b",
                  text: "B",
                  visualPrompt: "B",
                  estimatedDurationSec: 6,
                  checkpoint: {
                    visualEvent: {
                      provider: "replicate",
                      model: visualModel,
                      durationSec: 6,
                      requestBytes: 1,
                      label: "character_plate:scene-b",
                      costPaise: null,
                    },
                    lipSyncEvent: {
                      provider: "openrouter",
                      model: lipModel,
                      durationSec: 6,
                      requestBytes: 1,
                      label: "lip_sync:scene-b",
                      costPaise: null,
                    },
                  },
                },
              ],
            },
          },
        })
        .returning({ id: videoGenerationsTable.id });
      jobId = job.id;

      await expect(reconcileVideoJobWalletCost(job.id)).rejects.toThrow(
        /no settled video reservation/,
      );

      // Simulate the old aggregate undercharge: ₹25 provider cost + 20% = ₹30.
      await settleWalletDurably(tenantId, main!, {
        kind: "video",
        costPaise: 2_500,
        provider: "replicate",
        model: lipModel,
        refKind: "videoJob",
        refId: String(job.id),
      });
      await db
        .update(walletSettlementRetriesTable)
        .set({ status: "pending", updatedAt: new Date() })
        .where(eq(walletSettlementRetriesTable.reservationId, main!.id));
      await expect(reconcileVideoJobWalletCost(job.id)).rejects.toThrow(
        /pending settlement retry/,
      );
      await db
        .update(walletSettlementRetriesTable)
        .set({ status: "settled", settledAt: new Date(), updatedAt: new Date() })
        .where(eq(walletSettlementRetriesTable.reservationId, main!.id));
      const narration = await reserveWallet(tenantId, "caption");
      await settleWalletDurably(tenantId, narration!, {
        kind: "caption",
        costPaise: 100,
        provider: "elevenlabs",
        model: "eleven_v3",
        refKind: "videoJob",
        refId: `${job.id}:0`,
      });

      const [first, second] = await Promise.all([
        reconcileVideoJobWalletCost(job.id),
        reconcileVideoJobWalletCost(job.id),
      ]);
      const applied = [first.appliedPaise, second.appliedPaise].sort((a, b) => a - b);
      // Visuals: 2 × ₹10 = ₹20. Lip-sync: 4s+6s × ₹5 = ₹50.
      // Raw ₹70 video + ₹1 narration, with one 20% fee = ₹85.20.
      // Existing charges were ₹30 + ₹1.20, so the correction is ₹54.
      expect(applied).toEqual([-5_400, 0]);
      expect(first.rawProviderCostPaise).toBe(7_100);
      expect(first.targetChargePaise).toBe(8_520);
      const charges = await getVideoJobWalletChargesPaise(tenantId, [job.id]);
      expect(charges.get(job.id)).toBe(8_520);
      expect((await db.select().from(videoGenerationsTable)
        .where(eq(videoGenerationsTable.id, job.id)))[0]?.spendPaise).toBe(8_520);

      const rows = await db
        .select()
        .from(walletLedgerTable)
        .where(
          and(
            eq(walletLedgerTable.reservationId, main!.id),
            eq(walletLedgerTable.refKind, "videoJobReconciliation"),
          ),
        );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.amountPaise).toBe(-5_400);
      expect(await ledgerSum(tenantId)).toBe(await getWalletBalancePaise(tenantId));
    } finally {
      if (jobId !== null) {
        await db.delete(videoGenerationsTable).where(eq(videoGenerationsTable.id, jobId));
      }
      if (priceIds.length > 0) {
        await db.delete(aiModelPricesTable).where(inArray(aiModelPricesTable.id, priceIds));
      }
      await setAiCostConfig({ usdToInrPaise: previousFx });
    }
  });

  it("reconciles a three-job High Quality retry chain once and reports it read-only", async () => {
    await adminAdjustWallet({ tenantId, amountPaise: 30_000 });
    const reservations = await Promise.all([
      reserveWallet(tenantId, "video", {}, 1),
      reserveWallet(tenantId, "video", {}, 1),
      reserveWallet(tenantId, "video", {}, 1),
    ]);
    expect(reservations.every(Boolean)).toBe(true);
    const jobIds: number[] = [];
    try {
      const event = (
        eventId: string,
        label: string,
        costPaise: number,
        accounted = false,
      ) => ({
        eventId,
        provider: "replicate",
        model: "provider-free-test-model",
        durationSec: 1,
        requestBytes: 1,
        label,
        costPaise,
        ...(accounted ? { accounted: true } : {}),
      });
      const dialogue = (
        sourceJobId: number | null,
        firstVisual: ReturnType<typeof event>,
        secondVisual: ReturnType<typeof event> | undefined,
        firstLip: ReturnType<typeof event> | undefined,
        secondLip: ReturnType<typeof event> | undefined,
      ) => ({
        version: 1 as const,
        scriptApproved: true as const,
        locale: "en",
        modelId: "eleven_v3" as const,
        direction: "ltr" as const,
        script: "Latin",
        scriptName: "Latin",
        fontCandidates: ["Noto Sans"],
        characterId: 1,
        outfitId: 1,
        brandKitId: 1,
        ...(sourceJobId === null
          ? {}
          : {
              retry: {
                sourceJobId,
                fundedUnits: 1,
                state: "queued" as const,
              },
            }),
        scenes: [
          {
            id: "scene-a",
            text: "A",
            visualPrompt: "A",
            estimatedDurationSec: 1,
            checkpoint: {
              visualEvent: firstVisual,
              ...(firstLip ? { lipSyncEvent: firstLip } : {}),
            },
          },
          {
            id: "scene-b",
            text: "B",
            visualPrompt: "B",
            estimatedDurationSec: 1,
            ...(secondVisual || secondLip
              ? {
                  checkpoint: {
                    ...(secondVisual ? { visualEvent: secondVisual } : {}),
                    ...(secondLip ? { lipSyncEvent: secondLip } : {}),
                  },
                }
              : {}),
          },
        ],
      });
      const [source] = await db
        .insert(videoGenerationsTable)
        .values({
          tenantId,
          engine: "dialogue_lip_sync",
          status: "failed",
          funding: "wallet",
          walletReservationId: reservations[0]!.id,
          walletReservedPaise: reservations[0]!.amountPaise,
          walletReservedUnits: 1,
          spendPaise: 0,
          options: {
            aspectRatio: "16:9",
            characterDialogue: dialogue(
              null,
              event("chain:plate:a", "character_plate:scene-a", 2, true),
              undefined,
              undefined,
              undefined,
            ),
          },
        })
        .returning({ id: videoGenerationsTable.id });
      jobIds.push(source.id);
      const [retryOne] = await db
        .insert(videoGenerationsTable)
        .values({
          tenantId,
          engine: "dialogue_lip_sync",
          status: "failed",
          funding: "wallet",
          walletReservationId: reservations[1]!.id,
          walletReservedPaise: reservations[1]!.amountPaise,
          walletReservedUnits: 1,
          spendPaise: 0,
          options: {
            aspectRatio: "16:9",
            characterDialogue: dialogue(
              source.id,
              event("chain:plate:a", "character_plate:scene-a", 2, true),
              event("chain:plate:b", "character_plate:scene-b", 2, true),
              undefined,
              undefined,
            ),
          },
        })
        .returning({ id: videoGenerationsTable.id });
      jobIds.push(retryOne.id);
      const [final] = await db
        .insert(videoGenerationsTable)
        .values({
          tenantId,
          engine: "dialogue_lip_sync",
          status: "succeeded",
          funding: "wallet",
          walletReservationId: reservations[2]!.id,
          walletReservedPaise: reservations[2]!.amountPaise,
          walletReservedUnits: 1,
          spendPaise: 0,
          options: {
            aspectRatio: "16:9",
            characterDialogue: dialogue(
              retryOne.id,
              event("chain:plate:a", "character_plate:scene-a", 2, true),
              event("chain:plate:b", "character_plate:scene-b", 2, true),
              event("chain:lip:a", "lip_sync:scene-a", 1),
              event("chain:lip:b", "lip_sync:scene-b", 1),
            ),
          },
        })
        .returning({ id: videoGenerationsTable.id });
      jobIds.push(final.id);

      await settleWalletDurably(tenantId, reservations[0]!, {
        kind: "video",
        costPaise: 2,
        provider: "replicate",
        model: "provider-free-test-model",
        refKind: "videoJob",
        refId: String(source.id),
      });
      await settleWalletDurably(tenantId, reservations[1]!, {
        kind: "video",
        costPaise: 2,
        provider: "replicate",
        model: "provider-free-test-model",
        refKind: "videoJob",
        refId: String(retryOne.id),
      });
      await settleWalletDurably(tenantId, reservations[2]!, {
        kind: "video",
        costPaise: 2,
        provider: "replicate",
        model: "provider-free-test-model",
        refKind: "videoJob",
        refId: String(final.id),
      });
      const narration = await reserveWallet(tenantId, "caption");
      await settleWalletDurably(tenantId, narration!, {
        kind: "caption",
        costPaise: 2,
        provider: "elevenlabs",
        model: "eleven_v3",
        refKind: "videoJob",
        refId: `${source.id}:0`,
      });

      const beforeReportBalance = await getWalletBalancePaise(tenantId);
      const before = (await listVideoWalletReconciliationReport()).find(
        (row) => row.chainId === source.id,
      );
      expect(before).toMatchObject({
        completedJobId: final.id,
        jobIds: [source.id, retryOne.id, final.id],
        eventCount: 5,
        rawProviderCostPaise: 8,
        targetChargePaise: 10,
        chargedPaise: 8,
        discrepancyPaise: 2,
        status: "undercharged",
      });
      expect(await getWalletBalancePaise(tenantId)).toBe(beforeReportBalance);

      const [first, second] = await Promise.all([
        reconcileVideoJobWalletCost(final.id),
        reconcileVideoJobWalletCost(final.id),
      ]);
      expect([first.appliedPaise, second.appliedPaise].sort((a, b) => a - b)).toEqual([
        -2, 0,
      ]);
      expect(first.rawProviderCostPaise).toBe(8);
      expect(first.targetChargePaise).toBe(10);
      expect(first.chainId).toBe(source.id);
      const charges = await getVideoJobWalletChargesPaise(tenantId, [final.id]);
      expect(charges.get(final.id)).toBe(10);
      expect(
        (
          await db
            .select()
            .from(videoGenerationsTable)
            .where(eq(videoGenerationsTable.id, final.id))
        )[0]?.spendPaise,
      ).toBe(10);
      const after = (await listVideoWalletReconciliationReport()).find(
        (row) => row.chainId === source.id,
      );
      expect(after).toMatchObject({ chargedPaise: 10, discrepancyPaise: 0, status: "balanced" });
    } finally {
      if (jobIds.length > 0) {
        await db
          .delete(videoGenerationsTable)
          .where(inArray(videoGenerationsTable.id, jobIds));
      }
    }
  });

  it("keeps a chain with an unknown durable provider cost pending", async () => {
    await adminAdjustWallet({ tenantId, amountPaise: 10_000 });
    const reservation = await reserveWallet(tenantId, "video", {}, 1);
    expect(reservation).not.toBeNull();
    let jobId: number | null = null;
    try {
      const [job] = await db
        .insert(videoGenerationsTable)
        .values({
          tenantId,
          engine: "dialogue_lip_sync",
          status: "succeeded",
          funding: "wallet",
          walletReservationId: reservation!.id,
          walletReservedPaise: reservation!.amountPaise,
          walletReservedUnits: 1,
          spendPaise: 0,
          options: {
            aspectRatio: "16:9",
            characterDialogue: {
              version: 1,
              scriptApproved: true,
              locale: "en",
              modelId: "eleven_v3",
              direction: "ltr",
              script: "Latin",
              scriptName: "Latin",
              fontCandidates: ["Noto Sans"],
              characterId: 1,
              outfitId: 1,
              brandKitId: 1,
              scenes: [
                {
                  id: "scene-unknown",
                  text: "Unknown",
                  visualPrompt: "Unknown",
                  estimatedDurationSec: 1,
                  checkpoint: {
                    visualEvent: {
                      eventId: `unknown:${randomUUID()}`,
                      provider: "provider-without-a-price",
                      model: `unknown-${randomUUID()}`,
                      durationSec: null,
                      requestBytes: 1,
                      label: "character_plate:scene-unknown",
                      costPaise: null,
                    },
                  },
                },
              ],
            },
          },
        })
        .returning({ id: videoGenerationsTable.id });
      jobId = job.id;
      await settleWalletDurably(tenantId, reservation!, {
        kind: "video",
        costPaise: 1,
        provider: "provider-without-a-price",
        model: "historical-aggregate",
        refKind: "videoJob",
        refId: String(job.id),
      });
      const balanceBeforeReport = await getWalletBalancePaise(tenantId);
      const report = (await listVideoWalletReconciliationReport()).find(
        (row) => row.chainId === job.id,
      );
      expect(report).toMatchObject({
        rawProviderCostPaise: null,
        targetChargePaise: null,
        discrepancyPaise: null,
        status: "pending_cost",
      });
      expect(report?.pendingEventIds).toHaveLength(1);
      expect(await getWalletBalancePaise(tenantId)).toBe(balanceBeforeReport);
      await expect(reconcileVideoJobWalletCost(job.id)).rejects.toThrow(
        /unknown provider costs/,
      );
      expect(await getWalletBalancePaise(tenantId)).toBe(balanceBeforeReport);
    } finally {
      if (jobId !== null) {
        await db.delete(videoGenerationsTable).where(eq(videoGenerationsTable.id, jobId));
      }
    }
  });
});

describe("durable settlement retry", () => {
  it("survives a failed first attempt and settles after a simulated restart", async () => {
    await adminAdjustWallet({ tenantId, amountPaise: 10_000 });
    const reservation = await reserveWallet(tenantId, "caption");
    const realTransaction = db.transaction.bind(db);
    const transactionSpy = vi.spyOn(db, "transaction");
    transactionSpy
      .mockImplementationOnce((callback, config) => realTransaction(callback, config))
      .mockRejectedValueOnce(new Error("temporary settlement outage"));

    await expect(
      settleWalletDurably(tenantId, reservation!, {
        kind: "caption",
        costPaise: 100,
        provider: "test",
        model: "restart-safe",
        refKind: "character",
        refId: "42",
      }),
    ).rejects.toThrow("temporary settlement outage");
    transactionSpy.mockRestore();

    const pending = await listWalletSettlementRetries();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      reservationId: reservation!.id,
      status: "pending",
      attempts: 1,
      targetChargePaise: 120,
      lastError: "temporary settlement outage",
    });
    expect(await getWalletBalancePaise(tenantId)).toBe(9_760);

    // Simulate the next process boot: make the persisted row due, then invoke
    // the same sweep index.ts runs before starting its periodic timer.
    await db
      .update(walletSettlementRetriesTable)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(walletSettlementRetriesTable.reservationId, reservation!.id));
    const swept = await sweepWalletSettlementRetries(new Date());
    expect(swept).toEqual({ claimed: 1, settled: 1, failed: 0 });
    expect(await listWalletSettlementRetries()).toEqual([]);
    expect(await getWalletBalancePaise(tenantId)).toBe(9_880);
  });

  it("claims duplicate retry calls once and eventually succeeds", async () => {
    await adminAdjustWallet({ tenantId, amountPaise: 10_000 });
    const reservation = await reserveWallet(tenantId, "image");
    const realTransaction = db.transaction.bind(db);
    const firstAttempt = vi.spyOn(db, "transaction");
    firstAttempt
      .mockImplementationOnce((callback, config) => realTransaction(callback, config))
      .mockRejectedValueOnce(new Error("database temporarily unavailable"));
    await expect(
      settleWalletDurably(tenantId, reservation!, {
        kind: "image",
        costPaise: 250,
        provider: "test",
        model: "duplicate-queue-retry",
      }),
    ).rejects.toThrow("database temporarily unavailable");
    firstAttempt.mockRestore();

    const results = await Promise.all([
      retryWalletSettlement(reservation!.id),
      retryWalletSettlement(reservation!.id),
    ]);
    expect(results.some((result) => result?.status === "settled")).toBe(true);

    const settleRows = (
      await db
        .select()
        .from(walletLedgerTable)
        .where(eq(walletLedgerTable.reservationId, reservation!.id))
    ).filter((row) => row.kind === "settle");
    expect(settleRows).toHaveLength(1);
    expect(await getWalletBalancePaise(tenantId)).toBe(9_700);
  });

  it("keeps terminal failures visible to operators", async () => {
    await adminAdjustWallet({ tenantId, amountPaise: 10_000 });
    const reservation = await reserveWallet(tenantId, "caption");
    const realTransaction = db.transaction.bind(db);
    const firstAttempt = vi.spyOn(db, "transaction");
    firstAttempt
      .mockImplementationOnce((callback, config) => realTransaction(callback, config))
      .mockRejectedValueOnce(new Error("settlement unavailable"));
    await expect(
      settleWalletDurably(tenantId, reservation!, {
        kind: "caption",
        costPaise: 100,
        provider: "test",
        model: "terminal-failure",
      }),
    ).rejects.toThrow("settlement unavailable");
    firstAttempt.mockRestore();

    await db
      .update(walletSettlementRetriesTable)
      .set({
        attempts: WALLET_SETTLEMENT_MAX_ATTEMPTS - 1,
        status: "pending",
      })
      .where(eq(walletSettlementRetriesTable.reservationId, reservation!.id));
    const terminalAttempt = vi
      .spyOn(db, "transaction")
      .mockRejectedValueOnce(new Error("still unavailable"));
    const result = await retryWalletSettlement(reservation!.id);
    terminalAttempt.mockRestore();

    expect(result?.status).toBe("failed");
    const visible = await listWalletSettlementRetries();
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({
      reservationId: reservation!.id,
      status: "failed",
      attempts: WALLET_SETTLEMENT_MAX_ATTEMPTS,
      lastError: "still unavailable",
    });
  });

  it("never refunds a reservation once successful work has queued settlement", async () => {
    await adminAdjustWallet({ tenantId, amountPaise: 10_000 });
    const reservation = await reserveWallet(tenantId, "image");
    const realTransaction = db.transaction.bind(db);
    const settlementAttempt = vi.spyOn(db, "transaction");
    settlementAttempt
      .mockImplementationOnce((callback, config) => realTransaction(callback, config))
      .mockRejectedValueOnce(new Error("temporary settlement outage"));
    await expect(
      settleWalletDurably(tenantId, reservation!, {
        kind: "image",
        costPaise: 250,
        provider: "test",
        model: "successful-work-no-refund",
      }),
    ).rejects.toThrow("temporary settlement outage");
    settlementAttempt.mockRestore();

    await refundWallet(tenantId, reservation!, "later persistence failure");
    expect(await getWalletBalancePaise(tenantId)).toBe(9_400);
    const lifecycleRows = await db
      .select()
      .from(walletLedgerTable)
      .where(eq(walletLedgerTable.reservationId, reservation!.id));
    expect(lifecycleRows.filter((row) => row.kind === "refund")).toHaveLength(0);
    expect((await listWalletSettlementRetries())[0]).toMatchObject({
      reservationId: reservation!.id,
      status: "pending",
    });
  });
});

describe("durable provider-operation recovery", () => {
  it.each([
    ["character reference", "character_reference", "image"],
    ["character outfit", "character_outfit", "image"],
    ["video-style analysis", "video_style_analysis", "caption"],
  ] as const)(
    "settles a confirmed %s exactly once after a simulated pre-handoff crash",
    async (_label, operationKind, usageKind) => {
      await adminAdjustWallet({ tenantId, amountPaise: 10_000 });
      const reservation = await reserveWallet(tenantId, usageKind);
      expect(reservation).not.toBeNull();
      let providerCalls = 0;

      const executed = await executeWalletProviderOperation(
        {
          tenantId,
          reservation: reservation!,
          operationKind,
          operationKey: `${operationKind}:${reservation!.id}`,
          settlement: {
            kind: usageKind,
            costPaise: 100,
            provider: "test-provider",
            model: "price-frozen-before-provider",
            refKind: operationKind,
            refId: "crash-boundary",
          },
        },
        async () => {
          providerCalls += 1;
          return { providerResultId: `result-${reservation!.id}` };
        },
        (value) => ({ providerResultId: value.providerResultId }),
      );

      // Simulate process death immediately after the success receipt and before
      // the route's wallet handoff. A restart only reads durable state.
      await db
        .update(walletProviderOperationsTable)
        .set({ recoverAfter: new Date(0) })
        .where(eq(walletProviderOperationsTable.id, executed.operationId));

      const swept = await sweepWalletProviderOperations(new Date());
      expect(swept).toEqual({ settled: 1, refunded: 0, failed: 0 });
      expect(providerCalls).toBe(1);
      expect(await getWalletBalancePaise(tenantId)).toBe(9_880);

      const [operation] = await db
        .select()
        .from(walletProviderOperationsTable)
        .where(eq(walletProviderOperationsTable.id, executed.operationId));
      expect(operation).toMatchObject({
        status: "settled",
        targetChargePaise: 120,
        estimated: false,
        providerResultId: `result-${reservation!.id}`,
      });
      const lifecycle = await db
        .select()
        .from(walletLedgerTable)
        .where(eq(walletLedgerTable.reservationId, reservation!.id));
      expect(lifecycle.filter((row) => row.kind === "settle")).toHaveLength(1);
      expect(lifecycle.filter((row) => row.kind === "refund")).toHaveLength(0);

      expect(await sweepWalletProviderOperations(new Date())).toEqual({
        settled: 0,
        refunded: 0,
        failed: 0,
      });
      expect(providerCalls).toBe(1);
      expect(
        (
          await db
            .select()
            .from(walletLedgerTable)
            .where(eq(walletLedgerTable.reservationId, reservation!.id))
        ).filter((row) => row.kind === "settle"),
      ).toHaveLength(1);
    },
  );

  it("refunds a confirmed provider failure once and never generates during recovery", async () => {
    await adminAdjustWallet({ tenantId, amountPaise: 10_000 });
    const reservation = await reserveWallet(tenantId, "caption");
    let providerCalls = 0;
    await expect(
      executeWalletProviderOperation(
        {
          tenantId,
          reservation: reservation!,
          operationKind: "video_style_analysis",
          settlement: { kind: "caption", costPaise: 100 },
        },
        async () => {
          providerCalls += 1;
          throw new Error("provider confirmed failure");
        },
      ),
    ).rejects.toThrow("provider confirmed failure");

    expect(await sweepWalletProviderOperations(new Date())).toEqual({
      settled: 0,
      refunded: 1,
      failed: 0,
    });
    expect(await getWalletBalancePaise(tenantId)).toBe(10_000);
    expect(providerCalls).toBe(1);
    expect(await sweepWalletProviderOperations(new Date())).toEqual({
      settled: 0,
      refunded: 0,
      failed: 0,
    });
    const lifecycle = await db
      .select()
      .from(walletLedgerTable)
      .where(eq(walletLedgerTable.reservationId, reservation!.id));
    expect(lifecycle.filter((row) => row.kind === "refund")).toHaveLength(1);
    expect(lifecycle.filter((row) => row.kind === "settle")).toHaveLength(0);
  });

  it("leaves an unresolved pending provider operation reserved rather than guessing", async () => {
    await adminAdjustWallet({ tenantId, amountPaise: 10_000 });
    const reservation = await reserveWallet(tenantId, "image");
    const operation = await beginWalletProviderOperation({
      tenantId,
      reservation: reservation!,
      operationKind: "character_reference",
      operationKey: `unresolved:${reservation!.id}`,
      settlement: { kind: "image", costPaise: 100 },
    });

    expect(await sweepWalletProviderOperations(new Date())).toEqual({
      settled: 0,
      refunded: 0,
      failed: 0,
    });
    expect(await getWalletBalancePaise(tenantId)).toBe(9_400);
    const [stillPending] = await db
      .select()
      .from(walletProviderOperationsTable)
      .where(eq(walletProviderOperationsTable.id, operation.id));
    expect(stillPending?.status).toBe("pending");
    const lifecycle = await db
      .select()
      .from(walletLedgerTable)
      .where(eq(walletLedgerTable.reservationId, reservation!.id));
    expect(lifecycle.filter((row) => row.kind === "refund")).toHaveLength(0);
    expect(lifecycle.filter((row) => row.kind === "settle")).toHaveLength(0);
  });

  it("keeps an ambiguous provider rejection pending and non-refundable", async () => {
    await adminAdjustWallet({ tenantId, amountPaise: 10_000 });
    const reservation = await reserveWallet(tenantId, "caption");

    await expect(
      executeWalletProviderOperation(
        {
          tenantId,
          reservation: reservation!,
          operationKind: "brand_voice_clone",
          operationKey: `ambiguous:${reservation!.id}`,
          settlement: { kind: "caption", costPaise: 100 },
        },
        async () => {
          throw new Error("connection closed before response");
        },
        () => ({}),
        { isFailureConfirmed: () => false },
      ),
    ).rejects.toThrow("connection closed before response");
    await refundWallet(tenantId, reservation!, "ambiguous provider result");

    const [operation] = await db
      .select()
      .from(walletProviderOperationsTable)
      .where(eq(walletProviderOperationsTable.reservationId, reservation!.id));
    expect(operation.status).toBe("pending");
    const lifecycle = await db
      .select()
      .from(walletLedgerTable)
      .where(eq(walletLedgerTable.reservationId, reservation!.id));
    expect(lifecycle.filter((row) => row.kind === "refund")).toHaveLength(0);
    expect(lifecycle.filter((row) => row.kind === "settle")).toHaveLength(0);
  });

  it("never downgrades a confirmed success into a refundable failure", async () => {
    await adminAdjustWallet({ tenantId, amountPaise: 10_000 });
    const reservation = await reserveWallet(tenantId, "caption");
    const executed = await executeWalletProviderOperation(
      {
        tenantId,
        reservation: reservation!,
        operationKind: "video_style_analysis",
        operationKey: `confirmed:${reservation!.id}`,
        settlement: { kind: "caption", costPaise: 100 },
      },
      async () => "voice-id",
      (voiceId) => ({ providerResultId: voiceId }),
    );

    expect(
      await markWalletProviderOperationFailed(executed.operationId, "later local write failed"),
    ).toBe(false);
    expect(
      await refundWalletProviderOperation(executed.operationId, "later local write failed"),
    ).toBe(false);

    await db
      .update(walletProviderOperationsTable)
      .set({ recoverAfter: new Date(0) })
      .where(eq(walletProviderOperationsTable.id, executed.operationId));
    expect(await sweepWalletProviderOperations(new Date())).toEqual({
      settled: 1,
      refunded: 0,
      failed: 0,
    });
    const lifecycle = await db
      .select()
      .from(walletLedgerTable)
      .where(eq(walletLedgerTable.reservationId, reservation!.id));
    expect(lifecycle.filter((row) => row.kind === "settle")).toHaveLength(1);
    expect(lifecycle.filter((row) => row.kind === "refund")).toHaveLength(0);
  });

  it("serializes a success receipt against a generic refund before outbox handoff", async () => {
    await adminAdjustWallet({ tenantId, amountPaise: 10_000 });
    const reservation = await reserveWallet(tenantId, "caption");
    const operation = await beginWalletProviderOperation({
      tenantId,
      reservation: reservation!,
      operationKind: "video_style_analysis",
      settlement: { kind: "caption", costPaise: 100 },
    });

    // Whichever transaction obtains the shared reservation lock first, pending
    // provider work cannot be refunded and a confirmed success becomes
    // terminal before the settlement outbox exists.
    await Promise.all([
      refundWallet(tenantId, reservation!, "stale route error"),
      confirmWalletProviderOperationSucceeded(operation.id, {
        provider: "test-provider",
        providerResultId: "result-1",
      }),
    ]);
    await settleWalletProviderOperationDurably(operation.id);
    await Promise.all([
      refundWallet(tenantId, reservation!, "later route error"),
      settleWalletProviderOperationDurably(operation.id),
    ]);

    const lifecycle = await db
      .select()
      .from(walletLedgerTable)
      .where(eq(walletLedgerTable.reservationId, reservation!.id));
    expect(lifecycle.filter((row) => row.kind === "settle")).toHaveLength(1);
    expect(lifecycle.filter((row) => row.kind === "refund")).toHaveLength(0);
  });

  it("allows refund only after failure wins the provider outcome lock", async () => {
    await adminAdjustWallet({ tenantId, amountPaise: 10_000 });
    const reservation = await reserveWallet(tenantId, "caption");
    const operation = await beginWalletProviderOperation({
      tenantId,
      reservation: reservation!,
      operationKind: "brand_voice_clone",
      settlement: { kind: "caption", costPaise: 100 },
    });

    expect(await markWalletProviderOperationFailed(operation.id, "provider rejected")).toBe(true);
    await expect(
      confirmWalletProviderOperationSucceeded(operation.id, {
        providerResultId: "late-success",
      }),
    ).rejects.toThrow("cannot succeed from failed");
    await refundWallet(tenantId, reservation!, "provider rejected");
    await refundWallet(tenantId, reservation!, "duplicate refund");

    const lifecycle = await db
      .select()
      .from(walletLedgerTable)
      .where(eq(walletLedgerTable.reservationId, reservation!.id));
    expect(lifecycle.filter((row) => row.kind === "refund")).toHaveLength(1);
    expect(lifecycle.filter((row) => row.kind === "settle")).toHaveLength(0);
  });

  it("keeps an early provider acknowledgement chargeable when parsing fails afterward", async () => {
    await adminAdjustWallet({ tenantId, amountPaise: 10_000 });
    const reservation = await reserveWallet(tenantId, "caption");
    let operationId: number | undefined;

    try {
      await executeWalletProviderOperation(
        {
          tenantId,
          reservation: reservation!,
          operationKind: "video_style_analysis",
          settlement: { kind: "caption", costPaise: 100 },
        },
        async (confirmSuccess) => {
          await confirmSuccess({
            provider: "test-provider",
            model: "vision-model",
            inputTokens: 20,
            outputTokens: 10,
          });
          throw new Error("model response could not be parsed");
        },
      );
      throw new Error("expected executeWalletProviderOperation to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(WalletProviderPostSuccessError);
      operationId = (error as WalletProviderPostSuccessError).operationId;
      expect((error as WalletProviderPostSuccessError).originalError).toEqual(
        new Error("model response could not be parsed"),
      );
    }

    await db
      .update(walletProviderOperationsTable)
      .set({ recoverAfter: new Date(0) })
      .where(eq(walletProviderOperationsTable.id, operationId!));
    expect(await sweepWalletProviderOperations(new Date())).toEqual({
      settled: 1,
      refunded: 0,
      failed: 0,
    });
    const [operation] = await db
      .select()
      .from(walletProviderOperationsTable)
      .where(eq(walletProviderOperationsTable.id, operationId!));
    expect(operation).toMatchObject({
      status: "settled",
      provider: "test-provider",
      model: "vision-model",
      inputTokens: 20,
      outputTokens: 10,
    });
  });

  it("reprices a Brand Voice TTS ceiling from exact credits and refunds the unused hold", async () => {
    await adminAdjustWallet({ tenantId, amountPaise: 10_000 });
    const reservation = await reserveWallet(
      tenantId,
      "caption",
      { provider: "elevenlabs", model: "eleven_multilingual_v2" },
      1,
      100,
    );
    expect(reservation?.amountPaise).toBe(120);

    const executed = await executeWalletProviderOperation(
      {
        tenantId,
        reservation: reservation!,
        operationKind: "brand_voice_tts",
        operationKey: `tts-credit:${reservation!.id}`,
        settlement: {
          kind: "caption",
          costPaise: 100,
          provider: "elevenlabs",
          model: "eleven_multilingual_v2",
        },
      },
      async (confirmSuccess, recordReceipt) => {
        await recordReceipt({
          provider: "elevenlabs",
          model: "eleven_multilingual_v2",
          providerCredits: "4.00000000",
          providerRequestId: "request-exact-credits",
          providerResultId: "request-exact-credits",
        });
        await confirmSuccess({
          provider: "elevenlabs",
          model: "eleven_multilingual_v2",
          costPaise: 40,
          providerCredits: "4.00000000",
          providerRequestId: "request-exact-credits",
          providerResultId: "request-exact-credits",
        });
        return "audio";
      },
      () => ({}),
      { requireExplicitSuccessConfirmation: true },
    );
    expect(executed.confirmed).toBe(true);

    await settleWalletProviderOperationDurably(executed.operationId);
    expect(await getWalletBalancePaise(tenantId)).toBe(9_952);
    const [operation] = await db
      .select()
      .from(walletProviderOperationsTable)
      .where(eq(walletProviderOperationsTable.id, executed.operationId));
    expect(operation).toMatchObject({
      status: "settled",
      targetChargePaise: 48,
      estimated: false,
      providerCredits: "4.00000000",
      providerRequestId: "request-exact-credits",
    });
    const [settle] = await db
      .select()
      .from(walletLedgerTable)
      .where(
        and(
          eq(walletLedgerTable.reservationId, reservation!.id),
          eq(walletLedgerTable.kind, "settle"),
        ),
      );
    expect(settle).toMatchObject({
      amountPaise: 72,
      providerCredits: "4.00000000",
      providerRequestId: "request-exact-credits",
    });
  });

  it("keeps successful TTS with no meter receipt pending and non-refundable", async () => {
    await adminAdjustWallet({ tenantId, amountPaise: 10_000 });
    const reservation = await reserveWallet(tenantId, "caption", {}, 1, 100);
    const executed = await executeWalletProviderOperation(
      {
        tenantId,
        reservation: reservation!,
        operationKind: "brand_voice_tts",
        settlement: { kind: "caption", costPaise: 100 },
      },
      async (_confirmSuccess, recordReceipt) => {
        await recordReceipt({
          provider: "elevenlabs",
          providerRequestId: "request-unmetered",
          providerResultId: "request-unmetered",
          providerCredits: null,
        });
        return "audio";
      },
      () => ({}),
      { requireExplicitSuccessConfirmation: true },
    );
    expect(executed.confirmed).toBe(false);
    await expect(
      settleWalletProviderOperationDurably(executed.operationId),
    ).rejects.toThrow("no confirmed outcome");
    await refundWallet(tenantId, reservation!, "later local failure");
    expect(await getWalletBalancePaise(tenantId)).toBe(9_880);
    const [operation] = await db
      .select()
      .from(walletProviderOperationsTable)
      .where(eq(walletProviderOperationsTable.id, executed.operationId));
    expect(operation).toMatchObject({
      status: "pending",
      providerRequestId: "request-unmetered",
      providerCredits: null,
    });
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

// ── Real-DB persistence: initTrueUpFailCounts ─────────────────────────────

/**
 * These tests verify the full persistence round-trip for the consecutive-
 * failure counter: write a count to wallet_settings.trueUpFailCounts (the
 * same column saveTrueUpFailCounts writes to), wipe the in-memory map
 * (simulating a process restart), reload via initTrueUpFailCounts, and then
 * confirm that the restored state drives the correct alert behaviour.
 *
 * The proof of loading is indirect but reliable: sweepStuckPendingTrueUps's
 * auto-resolve loop calls resolveWalletTrueUpFailingNotifications for every
 * group whose in-memory count is > 0 but whose model has no corresponding
 * pending ledger rows. Since our test model has no ledger rows, an empty
 * sweep will resolve it — which only happens if initTrueUpFailCounts actually
 * put the count into the map. The resolve call is spied on and intercepted so
 * no real notification rows are created or modified.
 */
describe("initTrueUpFailCounts — real-DB persistence round-trip", () => {
  // Use a unique suffix per test run so parallel suites can't collide.
  const SUITE_SUFFIX = randomUUID().slice(0, 8);
  const makeKey = (label: string) => `image:persist-${label}-${SUITE_SUFFIX}`;

  /** Write a fail count directly into wallet_settings.trueUpFailCounts. */
  async function seedFailCount(key: string, count: number): Promise<void> {
    const [row] = await db
      .select({ id: walletSettingsTable.id })
      .from(walletSettingsTable)
      .limit(1);
    // The outer beforeAll already called setWalletConfig, so the row exists.
    if (!row) throw new Error("No wallet_settings row — outer beforeAll must run first");
    await db
      .update(walletSettingsTable)
      .set({
        trueUpFailCounts: sql`
          COALESCE(${walletSettingsTable.trueUpFailCounts}, '{}'::jsonb)
          || ${JSON.stringify({ [key]: { count, lastError: "pre-restart error" } })}::jsonb
        `,
      })
      .where(eq(walletSettingsTable.id, row.id));
  }

  /** Remove our test keys from wallet_settings.trueUpFailCounts. */
  async function clearSeededKeys(...keys: string[]): Promise<void> {
    const [row] = await db
      .select({ id: walletSettingsTable.id, counts: walletSettingsTable.trueUpFailCounts })
      .from(walletSettingsTable)
      .limit(1);
    if (!row) return;
    const current = (row.counts ?? {}) as Record<
      string,
      { count: number; lastError: string | null }
    >;
    for (const k of keys) delete current[k];
    await db
      .update(walletSettingsTable)
      .set({ trueUpFailCounts: current })
      .where(eq(walletSettingsTable.id, row.id));
  }

  afterEach(async () => {
    resetTrueUpFailCounts();
  });

  it("loads a persisted fail count into the in-memory map after a simulated restart", async () => {
    const key = makeKey("load");
    const [kind, model] = key.split(":");
    try {
      await seedFailCount(key, WALLET_TRUEUP_FAIL_ALERT_THRESHOLD - 1);

      // Simulate restart: clear in-memory state, then re-initialise from DB.
      resetTrueUpFailCounts();
      await initTrueUpFailCounts();

      // Proof: the resolve loop fires for any group that is tracked in memory
      // (count > 0) but absent from the live pending list. Our key has no
      // ledger rows, so sweepStuckPendingTrueUps resolves it immediately —
      // which is only possible if initTrueUpFailCounts put it into the map.
      const resolveSpy = vi
        .spyOn(notifications, "resolveWalletTrueUpFailingNotifications")
        .mockResolvedValue(undefined);
      try {
        await sweepStuckPendingTrueUps();
        const matched = resolveSpy.mock.calls.some(([k, m]) => k === kind && m === model);
        expect(matched).toBe(true);
      } finally {
        resolveSpy.mockRestore();
      }
    } finally {
      await clearSeededKeys(key);
    }
  });

  it("calling initTrueUpFailCounts twice does not double the loaded count", async () => {
    const key = makeKey("double");
    const [kind, model] = key.split(":");
    try {
      // Store a count that is already at the alert threshold.
      await seedFailCount(key, WALLET_TRUEUP_FAIL_ALERT_THRESHOLD);

      resetTrueUpFailCounts();
      // First init loads the count.
      await initTrueUpFailCounts();
      // Second init on the same live process must not overwrite or accumulate
      // (guarded by `!trueUpFailCounts.has(key)` inside initTrueUpFailCounts).
      await initTrueUpFailCounts();

      // The resolve loop must fire exactly once for our key, not twice.
      const resolveSpy = vi
        .spyOn(notifications, "resolveWalletTrueUpFailingNotifications")
        .mockResolvedValue(undefined);
      try {
        await sweepStuckPendingTrueUps();
        const calls = resolveSpy.mock.calls.filter(([k, m]) => k === kind && m === model);
        expect(calls).toHaveLength(1);
      } finally {
        resolveSpy.mockRestore();
      }
    } finally {
      await clearSeededKeys(key);
    }
  });

  it("erases a resolved persisted streak so a later restart cannot re-alert it", async () => {
    const key = makeKey("resolved");
    const [kind, model] = key.split(":");
    try {
      // Start at the alert threshold to cover the exact state that must not
      // come back after a recovered group and a process restart.
      await seedFailCount(key, WALLET_TRUEUP_FAIL_ALERT_THRESHOLD);

      resetTrueUpFailCounts();
      await initTrueUpFailCounts();

      const resolveSpy = vi
        .spyOn(notifications, "resolveWalletTrueUpFailingNotifications")
        .mockResolvedValue(undefined);
      try {
        // No pending ledger row exists for this model, so the resolve loop
        // removes its loaded in-memory count and persists the emptied map.
        await sweepStuckPendingTrueUps();
        expect(
          resolveSpy.mock.calls.some(([usageKind, resolvedModel]) =>
            usageKind === kind && resolvedModel === model,
          ),
        ).toBe(true);

        const [settings] = await db
          .select({ counts: walletSettingsTable.trueUpFailCounts })
          .from(walletSettingsTable)
          .limit(1);
        expect(Object.hasOwn(settings?.counts ?? {}, key)).toBe(false);

        // Simulate another process restart. With no DB key to restore, the
        // resolved group must not invoke the alert resolver again.
        resetTrueUpFailCounts();
        await initTrueUpFailCounts();
        resolveSpy.mockClear();
        await sweepStuckPendingTrueUps();
        expect(
          resolveSpy.mock.calls.some(([usageKind, resolvedModel]) =>
            usageKind === kind && resolvedModel === model,
          ),
        ).toBe(false);
      } finally {
        resolveSpy.mockRestore();
      }
    } finally {
      await clearSeededKeys(key);
    }
  });

  it("a count of zero in the DB is not loaded (group was already resolved before the restart)", async () => {
    const key = makeKey("zero");
    const [kind, model] = key.split(":");
    try {
      await seedFailCount(key, 0);

      resetTrueUpFailCounts();
      await initTrueUpFailCounts();

      // Nothing was loaded, so the resolve loop must not fire for our key.
      const resolveSpy = vi
        .spyOn(notifications, "resolveWalletTrueUpFailingNotifications")
        .mockResolvedValue(undefined);
      try {
        await sweepStuckPendingTrueUps();
        const matched = resolveSpy.mock.calls.some(([k, m]) => k === kind && m === model);
        expect(matched).toBe(false);
      } finally {
        resolveSpy.mockRestore();
      }
    } finally {
      await clearSeededKeys(key);
    }
  });

  it("is a no-op when wallet_settings.trueUpFailCounts is an empty object (fresh install)", async () => {
    // Overwrite the column with an empty object — the state a fresh install has
    // before any sweep failure has ever been persisted.
    const [row] = await db
      .select({ id: walletSettingsTable.id, counts: walletSettingsTable.trueUpFailCounts })
      .from(walletSettingsTable)
      .limit(1);
    const originalCounts = row?.counts ?? {};

    try {
      await db
        .update(walletSettingsTable)
        .set({ trueUpFailCounts: {} })
        .where(eq(walletSettingsTable.id, row!.id));

      resetTrueUpFailCounts();
      // Must complete without throwing and without populating the in-memory map.
      await expect(initTrueUpFailCounts()).resolves.toBeUndefined();

      // Since nothing was loaded, the resolve loop must not fire for any key.
      const resolveSpy = vi
        .spyOn(notifications, "resolveWalletTrueUpFailingNotifications")
        .mockResolvedValue(undefined);
      try {
        await sweepStuckPendingTrueUps();
        expect(resolveSpy).not.toHaveBeenCalled();
      } finally {
        resolveSpy.mockRestore();
      }
    } finally {
      await db
        .update(walletSettingsTable)
        .set({ trueUpFailCounts: originalCounts })
        .where(eq(walletSettingsTable.id, row!.id));
    }
  });

  it("writes each consecutive sweep failure count to the DB", async () => {
    const model = `persist-write-${SUITE_SUFFIX}`;
    const key = `image:${model}`;
    const [settings] = await db
      .select({
        id: walletSettingsTable.id,
        counts: walletSettingsTable.trueUpFailCounts,
      })
      .from(walletSettingsTable)
      .limit(1);
    if (!settings) throw new Error("No wallet_settings row — outer beforeAll must run first");

    const originalCounts = settings.counts ?? {};
    const originalRatePaise = (await getAiCostConfig()).usdToInrPaise;
    let priceId: number | null = null;
    let transactionSpy: ReturnType<typeof vi.spyOn> | null = null;

    try {
      resetTrueUpFailCounts();
      await setAiCostConfig({ usdToInrPaise: 8_600 });
      await adminAdjustWallet({ tenantId, amountPaise: 10_000 });

      // Settle at the display fallback first, then add a matching price directly
      // so the sweep finds this pending group without a price-save true-up.
      const reservation = await reserveWallet(tenantId, "image", {
        provider: "persist-test",
        model,
      });
      await settleWallet(tenantId, reservation!, {
        kind: "image",
        costPaise: null,
        provider: "persist-test",
        model,
      });
      const [price] = await db
        .insert(aiModelPricesTable)
        .values({
          kind: "image",
          provider: "persist-test",
          model,
          inputUsdPerMtok: null,
          outputUsdPerMtok: null,
          usdPerImage: 0.05,
          usdPerSecond: null,
          usdPerVideo: null,
        })
        .returning({ id: aiModelPricesTable.id });
      priceId = price.id;

      // Let the real sweep discover the real DB rows, but make trueUpModel's
      // settlement transaction fail. saveTrueUpFailCounts does not use a
      // transaction, so each completed sweep must still write the new streak.
      transactionSpy = vi
        .spyOn(db, "transaction")
        .mockRejectedValue(new Error("forced true-up transaction failure"));

      await sweepStuckPendingTrueUps();
      const [afterFirstTick] = await db
        .select({ counts: walletSettingsTable.trueUpFailCounts })
        .from(walletSettingsTable)
        .limit(1);
      expect(afterFirstTick?.counts?.[key]).toMatchObject({
        count: 1,
        lastError: "forced true-up transaction failure",
      });

      await sweepStuckPendingTrueUps();
      const [afterSecondTick] = await db
        .select({ counts: walletSettingsTable.trueUpFailCounts })
        .from(walletSettingsTable)
        .limit(1);
      expect(afterSecondTick?.counts?.[key]).toMatchObject({
        count: 2,
        lastError: "forced true-up transaction failure",
      });
    } finally {
      transactionSpy?.mockRestore();
      resetTrueUpFailCounts();
      if (priceId !== null) {
        await db.delete(aiModelPricesTable).where(eq(aiModelPricesTable.id, priceId));
      }
      await setAiCostConfig({ usdToInrPaise: originalRatePaise });
      await db
        .update(walletSettingsTable)
        .set({ trueUpFailCounts: originalCounts })
        .where(eq(walletSettingsTable.id, settings.id));
    }
  });
});
