import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { pool, db, creditAccountsTable, creditAccountLedgerTable, creditMeterEventsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  listCreditRates,
  upsertCreditRate,
  creditsMilliFor,
  deleteCreditRate,
  setMeterMode,
  getMeterMode,
  invalidateCreditRateCache,
  MILLI,
} from "./creditRates";
import { meter, meterReport, tenantMeterCredits, InsufficientCreditsError } from "./meter";
import { getCreditBalance, grantCredits, listCreditHistory } from "./creditAccounts";
import { createTenant, deleteTenant } from "../test/dbHelpers";

let tenantId: number;

beforeAll(async () => {
  const t = await createTenant();
  tenantId = t.tenantId;
  await setMeterMode("shadow");
});

afterAll(async () => {
  await db.delete(creditMeterEventsTable).where(eq(creditMeterEventsTable.tenantId, tenantId));
  await db.delete(creditAccountLedgerTable).where(eq(creditAccountLedgerTable.tenantId, tenantId));
  await db.delete(creditAccountsTable).where(eq(creditAccountsTable.tenantId, tenantId));
  await deleteTenant(tenantId);
  await pool.end();
});

beforeEach(async () => {
  await db.delete(creditMeterEventsTable).where(eq(creditMeterEventsTable.tenantId, tenantId));
  await db.delete(creditAccountLedgerTable).where(eq(creditAccountLedgerTable.tenantId, tenantId));
  await db.delete(creditAccountsTable).where(eq(creditAccountsTable.tenantId, tenantId));
  await setMeterMode("shadow");
  invalidateCreditRateCache();
});

async function eventsFor(): Promise<
  {
    rateKey: string;
    creditsMilli: number;
    quantityMilli: number;
    outcome: string;
  }[]
> {
  return db
    .select({
      rateKey: creditMeterEventsTable.rateKey,
      creditsMilli: creditMeterEventsTable.creditsMilli,
      quantityMilli: creditMeterEventsTable.quantityMilli,
      outcome: creditMeterEventsTable.outcome,
    })
    .from(creditMeterEventsTable)
    .where(eq(creditMeterEventsTable.tenantId, tenantId));
}

describe("credit rate card", () => {
  it("seeds a usable card with video anchored at one credit per second", async () => {
    const rates = await listCreditRates();
    const byKey = new Map(rates.map((r) => [r.key, r]));
    expect(byKey.get("video")).toMatchObject({ unit: "second", credits: 1 });
    expect(byKey.get("image")?.unit).toBe("item");
    // The rates KOKAO spends on beyond video: voice and lip sync are both
    // per-second and must exist out of the box.
    expect(byKey.get("voice")?.unit).toBe("second");
    expect(byKey.get("lipsync")?.unit).toBe("second");
    expect(byKey.get("caption")?.unit).toBe("item");
  });

  it("prices fractional rates without floating-point drift", async () => {
    await upsertCreditRate({
      key: "caption",
      label: "Caption",
      unit: "item",
      credits: 0.2,
      active: true,
    });
    // Ten captions at a fifth of a credit is exactly two credits, not
    // 1.9999999999999998.
    expect(await creditsMilliFor("caption", 10)).toBe(2 * MILLI);
  });

  it("prices a fractional duration against a per-second rate", async () => {
    expect(await creditsMilliFor("video", 22.45)).toBe(22450);
  });

  it("returns null for an unpriced key and zero for a deactivated one", async () => {
    expect(await creditsMilliFor("no_such_action", 5)).toBeNull();
    const key = "meter_test_inactive";
    try {
      await upsertCreditRate({
        key,
        label: "Meter test inactive",
        unit: "second",
        credits: 2,
        active: false,
      });
      expect(await creditsMilliFor(key, 5)).toBe(0);
    } finally {
      await deleteCreditRate(key);
    }
  });
});

describe("meter", () => {
  it("records a successful call and returns the provider result untouched", async () => {
    const result = await meter({ tenantId }, "video", 10, async () => "clip");
    expect(result).toBe("clip");

    const events = await eventsFor();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      rateKey: "video",
      outcome: "ok",
      quantityMilli: 10 * MILLI,
      creditsMilli: 10 * MILLI,
    });
  });

  it("records actual quantity at the pre-dispatch unit rate", async () => {
    const actualCost = await creditsMilliFor("voice", 3.25);
    await meter(
      { tenantId, operationKey: "meter-actual-quantity" },
      "voice",
      10,
      async () => ({ durationSec: 3.25 }),
      (result) => ({ actualQuantity: result.durationSec }),
    );

    expect(await eventsFor()).toEqual([
      expect.objectContaining({
        rateKey: "voice",
        outcome: "ok",
        quantityMilli: 3_250,
        creditsMilli: actualCost,
      }),
    ]);
  });

  it("records a FAILED call and still rethrows", async () => {
    // The whole point: a provider bills for a render that then fails, and
    // nothing else in the app records it because usage is only written on
    // success.
    await expect(
      meter({ tenantId }, "image", 1, async () => {
        throw new Error("safety filter rejected the prompt");
      }),
    ).rejects.toThrow("safety filter rejected the prompt");

    const events = await eventsFor();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ rateKey: "image", outcome: "failed" });
  });

  it("counts a retry as two billed calls, not one", async () => {
    let attempts = 0;
    const attempt = () =>
      meter({ tenantId }, "image", 1, async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("keyframe generation failed");
        return "keyframe";
      });
    await expect(attempt()).rejects.toThrow();
    expect(await attempt()).toBe("keyframe");

    const events = await eventsFor();
    expect(events).toHaveLength(2);
    expect(events.filter((e) => e.outcome === "failed")).toHaveLength(1);
    expect(events.filter((e) => e.outcome === "ok")).toHaveLength(1);
  });

  it("is a pass-through when there is no billable workspace", async () => {
    expect(await meter(null, "video", 30, async () => "playground")).toBe("playground");
    expect(await eventsFor()).toHaveLength(0);
  });

  it("records nothing while the meter is off", async () => {
    await setMeterMode("off");
    try {
      expect(await getMeterMode()).toBe("off");
      expect(await meter({ tenantId }, "video", 5, async () => "clip")).toBe("clip");
      expect(await eventsFor()).toHaveLength(0);
    } finally {
      await setMeterMode("shadow");
    }
  });

  it("records an unpriced key at zero rather than dropping the call", async () => {
    await meter({ tenantId }, "some_future_provider", 3, async () => "ok");
    const events = await eventsFor();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      rateKey: "some_future_provider",
      creditsMilli: 0,
    });
  });

  it("never lets a metering problem change the outcome of a real call", async () => {
    // A quantity that cannot be priced must not stop the provider result
    // reaching the caller.
    expect(await meter({ tenantId }, "video", Number.NaN, async () => "clip")).toBe("clip");
  });

  it("keeps shadow mode as a pass-through without debiting", async () => {
    await grantCredits({ tenantId, credits: 20, kind: "purchase" });
    const before = await getCreditBalance(tenantId);

    const result = await meter({ tenantId, operationKey: "meter-shadow-pass-through" }, "video", 5, async () => ({
      providerResult: "unchanged",
    }));

    expect(result).toEqual({ providerResult: "unchanged" });
    expect(await getCreditBalance(tenantId)).toEqual(before);
    expect((await listCreditHistory(tenantId)).filter((row) => row.kind === "spend")).toHaveLength(0);
  });

  it("does not dispatch a new provider call against an old debit receipt", async () => {
    await grantCredits({ tenantId, credits: 20, kind: "purchase" });
    await setMeterMode("enforce");
    const ctx = { tenantId, operationKey: "meter-idempotent-success" };
    let calls = 0;

    await meter(ctx, "video", 5, async () => {
      calls += 1;
      return "first";
    });
    await expect(
      meter(ctx, "video", 5, async () => {
        calls += 1;
        return "replay";
      }),
    ).rejects.toThrow(/already dispatched/i);

    expect(calls).toBe(1);
    expect((await getCreditBalance(tenantId)).total).toBe(15);
    const spends = (await listCreditHistory(tenantId)).filter((row) => row.kind === "spend");
    expect(spends).toHaveLength(1);
  });

  it("refunds an enforce debit when the provider fails", async () => {
    await grantCredits({ tenantId, credits: 20, kind: "purchase" });
    await setMeterMode("enforce");

    await expect(
      meter({ tenantId, operationKey: "meter-failure-refund" }, "video", 5, async () => {
        throw new Error("provider failed");
      }),
    ).rejects.toThrow("provider failed");

    expect((await getCreditBalance(tenantId)).total).toBe(20);
    const history = await listCreditHistory(tenantId);
    expect(history.filter((row) => row.kind === "spend")).toHaveLength(1);
    expect(history.filter((row) => row.kind === "refund")).toHaveLength(1);
  });

  it("does not refund an earlier successful debit when its replay fails", async () => {
    await grantCredits({ tenantId, credits: 20, kind: "purchase" });
    await setMeterMode("enforce");
    const ctx = { tenantId, operationKey: "meter-success-then-failed-replay" };

    await meter(ctx, "video", 5, async () => "first");
    let replayCalled = false;
    await expect(
      meter(ctx, "video", 5, async () => {
        replayCalled = true;
        throw new Error("replay failed");
      }),
    ).rejects.toThrow(/already dispatched/i);

    expect(replayCalled).toBe(false);
    expect((await getCreditBalance(tenantId)).total).toBe(15);
    expect((await listCreditHistory(tenantId)).filter((row) => row.kind === "refund")).toHaveLength(0);
  });

  it("charges a failed-then-successful retry with the same stable operation key", async () => {
    await grantCredits({ tenantId, credits: 20, kind: "purchase" });
    await setMeterMode("enforce");

    await expect(
      meter({ tenantId, operationKey: "retry-operation" }, "video", 5, async () => {
        throw new Error("transient provider failure");
      }),
    ).rejects.toThrow("transient provider failure");
    await expect(
      meter({ tenantId, operationKey: "retry-operation" }, "video", 5, async () => "recovered"),
    ).resolves.toBe("recovered");

    expect((await getCreditBalance(tenantId)).total).toBe(15);
    const history = await listCreditHistory(tenantId);
    expect(history.filter((row) => row.kind === "spend")).toHaveLength(2);
    expect(history.filter((row) => row.kind === "refund")).toHaveLength(1);
    const receipts = await db
      .select({
        kind: creditAccountLedgerTable.kind,
        idempotencyKey: creditAccountLedgerTable.idempotencyKey,
      })
      .from(creditAccountLedgerTable)
      .where(eq(creditAccountLedgerTable.tenantId, tenantId));
    expect(receipts).toEqual(expect.arrayContaining([
      {
        kind: "spend",
        idempotencyKey: "spend:retry-operation:video:attempt:1",
      },
      {
        kind: "refund",
        idempotencyKey: "refund:retry-operation:video:attempt:1",
      },
      {
        kind: "spend",
        idempotencyKey: "spend:retry-operation:video:attempt:2",
      },
    ]));
  });

  it("blocks replay through an earlier refunded attempt after a later family attempt succeeds", async () => {
    await grantCredits({ tenantId, credits: 20, kind: "purchase" });
    await setMeterMode("enforce");
    const family = "video-job:77:scene:2";

    await expect(
      meter(
        { tenantId, operationKey: `${family}:submit:0`, operationFamilyKey: family },
        "video",
        5,
        async () => {
          throw new Error("transient submit failure");
        },
      ),
    ).rejects.toThrow("transient submit failure");
    await expect(
      meter(
        { tenantId, operationKey: `${family}:submit:1`, operationFamilyKey: family },
        "video",
        5,
        async () => "recovered",
      ),
    ).resolves.toBe("recovered");

    let replayCalled = false;
    await expect(
      meter(
        { tenantId, operationKey: `${family}:submit:0`, operationFamilyKey: family },
        "video",
        5,
        async () => {
          replayCalled = true;
          return "duplicate";
        },
      ),
    ).rejects.toMatchObject({ code: "METER_DISPATCH_REPLAY" });

    expect(replayCalled).toBe(false);
    expect((await getCreditBalance(tenantId)).total).toBe(15);
    const history = await listCreditHistory(tenantId);
    expect(history.filter((row) => row.kind === "spend")).toHaveLength(2);
    expect(history.filter((row) => row.kind === "refund")).toHaveLength(1);
  });

  it("allows only one concurrent dispatch for the same stable operation key", async () => {
    await grantCredits({ tenantId, credits: 20, kind: "purchase" });
    await setMeterMode("enforce");
    let providerCalls = 0;
    const ctx = { tenantId, operationKey: "concurrent-meter-operation" };
    const invoke = () => meter(ctx, "video", 5, async () => {
      providerCalls += 1;
      return "ok";
    });

    const results = await Promise.allSettled([invoke(), invoke()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(providerCalls).toBe(1);
    expect((await getCreditBalance(tenantId)).total).toBe(15);
  });

  it("settles an enforce reservation down to authoritative actual quantity", async () => {
    await grantCredits({ tenantId, credits: 20, kind: "purchase" });
    await setMeterMode("enforce");
    await meter(
      { tenantId, operationKey: "voice-settle-down" },
      "voice",
      10,
      async () => ({ durationSec: 3.25 }),
      (result) => ({ actualQuantity: result.durationSec }),
    );

    expect((await getCreditBalance(tenantId)).total).toBe(19.675);
    expect((await eventsFor())[0]).toMatchObject({
      quantityMilli: 3_250,
      creditsMilli: await creditsMilliFor("voice", 3.25),
    });
  });

  it("refund-only settles actual quantity above the initial estimate but below its bound", async () => {
    await grantCredits({ tenantId, credits: 20, kind: "purchase" });
    await setMeterMode("enforce");
    await meter(
      { tenantId, operationKey: "voice-settle-up" },
      "voice",
      10,
      async () => ({ durationSec: 12 }),
      (result) => ({ actualQuantity: result.durationSec }),
      { reservationQuantity: 15 },
    );

    expect((await getCreditBalance(tenantId)).total).toBe(18.8);
    const history = await listCreditHistory(tenantId);
    expect(history.filter((row) => row.kind === "spend")).toHaveLength(1);
    expect(history.filter((row) => row.kind === "refund")).toHaveLength(1);
    expect((await eventsFor())[0]).toMatchObject({
      quantityMilli: 12_000,
      creditsMilli: await creditsMilliFor("voice", 12),
    });
  });

  it("records the price snapshotted before provider dispatch", async () => {
    const key = "meter_snapshot_test";
    try {
      await upsertCreditRate({ key, label: "Snapshot test", unit: "item", credits: 2, active: true });
      await meter({ tenantId }, key, 3, async () => {
        await upsertCreditRate({ key, label: "Snapshot test", unit: "item", credits: 9, active: true });
        return "ok";
      });

      expect((await eventsFor())[0]).toMatchObject({ creditsMilli: 6 * MILLI });
    } finally {
      await deleteCreditRate(key);
    }
  });

  it("settles actual quantity without rereading a changed rate", async () => {
    const key = "meter_actual_snapshot_test";
    try {
      await upsertCreditRate({ key, label: "Actual snapshot", unit: "second", credits: 2, active: true });
      await grantCredits({ tenantId, credits: 20, kind: "purchase" });
      await setMeterMode("enforce");
      await meter(
        { tenantId, operationKey: "actual-snapshot" },
        key,
        3,
        async () => {
          await upsertCreditRate({ key, label: "Actual snapshot", unit: "second", credits: 9, active: true });
          return { durationSec: 4 };
        },
        (result) => ({ actualQuantity: result.durationSec }),
        { reservationQuantity: 5 },
      );

      expect((await getCreditBalance(tenantId)).total).toBe(12);
      expect((await eventsFor())[0]).toMatchObject({ quantityMilli: 4_000, creditsMilli: 8 * MILLI });
    } finally {
      await deleteCreditRate(key);
    }
  });

  it("rejects an unfundable upper-bound reservation before provider dispatch", async () => {
    await grantCredits({ tenantId, credits: 1, kind: "purchase" });
    await setMeterMode("enforce");
    let providerCalled = false;

    await expect(
      meter(
        { tenantId, operationKey: "voice-insufficient-bound" },
        "voice",
        1,
        async () => {
          providerCalled = true;
          return { durationSec: 2 };
        },
        (result) => ({ actualQuantity: result.durationSec }),
        { reservationQuantity: 30 },
      ),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect(providerCalled).toBe(false);
    expect(await eventsFor()).toHaveLength(0);
    expect((await getCreditBalance(tenantId)).total).toBe(1);
  });
});

describe("meter report", () => {
  it("totals credits and surfaces failed calls separately", async () => {
    await meter({ tenantId }, "video", 10, async () => "a");
    await meter({ tenantId }, "video", 5, async () => "b");
    await expect(
      meter({ tenantId }, "image", 1, async () => {
        throw new Error("nope");
      }),
    ).rejects.toThrow();

    const report = await meterReport(1);
    const video = report.rows.find((r) => r.rateKey === "video");
    expect(video?.calls).toBe(2);
    expect(video?.quantity).toBe(15);
    expect(video?.credits).toBe(15);

    const image = report.rows.find((r) => r.rateKey === "image");
    expect(image?.failedCalls).toBe(1);
    expect(report.failedCalls).toBeGreaterThanOrEqual(1);

    expect(await tenantMeterCredits(tenantId, 1)).toBeGreaterThanOrEqual(15);
  });

  it("distinguishes unpriced, configured-free, and inactive keys", async () => {
    const unpricedKey = "meter_test_missing_rate";
    const freeKey = "meter_test_free_rate";
    const inactiveKey = "meter_test_inactive_rate";
    try {
      await upsertCreditRate({
        key: freeKey,
        label: "Meter test free",
        unit: "item",
        credits: 0,
        active: true,
      });
      await upsertCreditRate({
        key: inactiveKey,
        label: "Meter test inactive",
        unit: "item",
        credits: 3,
        active: false,
      });
      await meter({ tenantId }, unpricedKey, 1, async () => "missing");
      await meter({ tenantId }, freeKey, 1, async () => "free");
      await meter({ tenantId }, inactiveKey, 1, async () => "inactive");

      const report = await meterReport(1);
      expect(report.rows.find((row) => row.rateKey === unpricedKey)?.pricingStatus).toBe("unpriced");
      expect(report.rows.find((row) => row.rateKey === freeKey)?.pricingStatus).toBe("free");
      expect(report.rows.find((row) => row.rateKey === inactiveKey)?.pricingStatus).toBe("inactive");
      expect(report.unpricedKeys).toContain(unpricedKey);
      expect(report.unpricedKeys).not.toContain(freeKey);
      expect(report.unpricedKeys).not.toContain(inactiveKey);
    } finally {
      await deleteCreditRate(freeKey);
      await deleteCreditRate(inactiveKey);
    }
  });
});
