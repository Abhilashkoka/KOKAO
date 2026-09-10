import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { pool, db, creditMeterEventsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  listCreditRates,
  upsertCreditRate,
  creditsMilliFor,
  setMeterMode,
  getMeterMode,
  invalidateCreditRateCache,
  MILLI,
} from "./creditRates";
import { meter, meterReport, tenantMeterCredits } from "./meter";
import { createTenant, deleteTenant } from "../test/dbHelpers";

let tenantId: number;

beforeAll(async () => {
  const t = await createTenant();
  tenantId = t.tenantId;
  await setMeterMode("shadow");
});

afterAll(async () => {
  await db.delete(creditMeterEventsTable).where(eq(creditMeterEventsTable.tenantId, tenantId));
  await deleteTenant(tenantId);
  await pool.end();
});

beforeEach(async () => {
  await db.delete(creditMeterEventsTable).where(eq(creditMeterEventsTable.tenantId, tenantId));
  invalidateCreditRateCache();
});

async function eventsFor(): Promise<
  { rateKey: string; creditsMilli: number; quantityMilli: number; outcome: string }[]
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
    await upsertCreditRate({
      key: "lipsync",
      label: "Lip sync",
      unit: "second",
      credits: 2,
      active: false,
    });
    expect(await creditsMilliFor("lipsync", 5)).toBe(0);
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
    expect(events[0]).toMatchObject({ rateKey: "some_future_provider", creditsMilli: 0 });
  });

  it("never lets a metering problem change the outcome of a real call", async () => {
    // A quantity that cannot be priced must not stop the provider result
    // reaching the caller.
    expect(await meter({ tenantId }, "video", Number.NaN, async () => "clip")).toBe("clip");
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
});
