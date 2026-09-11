import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  pool,
  db,
  creditAccountsTable,
  creditAccountLedgerTable,
  creditMeterEventsTable,
  planSettingsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  setMeterMode,
  upsertCreditRate,
  invalidateCreditRateCache,
  MILLI,
} from "./creditRates";
import { meter, InsufficientCreditsError } from "./meter";
import { getCreditBalance, grantCredits, listCreditHistory } from "./creditAccounts";
import { quoteVideoJobCredits, quoteActionCredits } from "./creditQuote";
import { grantMonthlyCredits, monthlyGrantKey } from "./monthlyCreditGrant";
import { createTenant, deleteTenant } from "../test/dbHelpers";

let tenantId: number;

beforeAll(async () => {
  tenantId = (await createTenant()).tenantId;
});

afterAll(async () => {
  await setMeterMode("shadow");
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
  invalidateCreditRateCache();
});

describe("meter enforcement", () => {
  it("charges nothing in shadow mode, however much is generated", async () => {
    await setMeterMode("shadow");
    await meter({ tenantId }, "video", 30, async () => "clip");
    expect((await getCreditBalance(tenantId)).total).toBe(0);
  });

  it("debits the balance in enforce mode", async () => {
    await setMeterMode("enforce");
    await grantCredits({ tenantId, credits: 50, kind: "purchase" });
    await meter({ tenantId }, "video", 10, async () => "clip");
    expect((await getCreditBalance(tenantId)).total).toBe(40);
  });

  it("refuses the call when the balance cannot cover it", async () => {
    await setMeterMode("enforce");
    await grantCredits({ tenantId, credits: 3, kind: "purchase" });
    let ran = false;
    await expect(
      meter({ tenantId }, "video", 10, async () => {
        ran = true;
        return "clip";
      }),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);
    // The provider is never called for work that cannot be paid for.
    expect(ran).toBe(false);
    expect((await getCreditBalance(tenantId)).total).toBe(3);
  });

  it("refunds the customer when the provider call fails", async () => {
    await setMeterMode("enforce");
    await grantCredits({ tenantId, credits: 50, kind: "purchase" });
    await expect(
      meter({ tenantId }, "video", 10, async () => {
        throw new Error("provider rejected the prompt");
      }),
    ).rejects.toThrow("provider rejected");

    // Whole cost back: a failure that was never the customer's fault must not
    // cost them. The provider still billed it, which is why the meter event
    // records — that waste belongs to the platform, visibly.
    expect((await getCreditBalance(tenantId)).total).toBe(50);
    const history = await listCreditHistory(tenantId);
    expect(history.some((h) => h.kind === "refund")).toBe(true);
    const events = await db
      .select()
      .from(creditMeterEventsTable)
      .where(eq(creditMeterEventsTable.tenantId, tenantId));
    expect(events.some((e) => e.outcome === "failed")).toBe(true);
  });

  it("charges once and blocks a second provider dispatch with the same operation key", async () => {
    await setMeterMode("enforce");
    await grantCredits({ tenantId, credits: 50, kind: "purchase" });
    const ctx = { tenantId, operationKey: "job-99-scene-1" };
    let calls = 0;
    await meter(ctx, "video", 10, async () => "clip");
    await expect(
      meter(ctx, "video", 10, async () => {
        calls += 1;
        return "duplicate";
      }),
    ).rejects.toThrow(/already dispatched/i);
    expect(calls).toBe(0);
    expect((await getCreditBalance(tenantId)).total).toBe(40);
  });

  it("records the provider's own token and cost figures when reported", async () => {
    await setMeterMode("shadow");
    await meter(
      { tenantId },
      "video",
      5,
      async () => ({ videoTokens: 324_000, providerReportedActualUsd: 3.94 }),
      (r) => ({ tokens: r.videoTokens, usd: r.providerReportedActualUsd }),
    );
    const [event] = await db
      .select()
      .from(creditMeterEventsTable)
      .where(eq(creditMeterEventsTable.tenantId, tenantId));
    expect(event?.providerTokens).toBe(324_000);
    expect(event?.providerCostMicroUsd).toBe(3_940_000);
  });
});

describe("credit quote", () => {
  it("prices a whole video job, keyframes included", async () => {
    await upsertCreditRate({ key: "video", label: "Video", unit: "second", credits: 1, active: true });
    await upsertCreditRate({ key: "image", label: "Image", unit: "item", credits: 3, active: true });
    await upsertCreditRate({ key: "caption", label: "Caption", unit: "item", credits: 0.2, active: true });

    const quote = await quoteVideoJobCredits({ durationSec: 20, sceneCount: 4 });
    // 20 seconds of video + 4 keyframes + 2 text passes.
    expect(quote.credits).toBe(20 + 12 + 0.4);
    expect(quote.lines.map((l) => l.rateKey)).toEqual(["video", "image", "caption"]);
  });

  it("bills 720p and above at the HD rate", async () => {
    await upsertCreditRate({ key: "video", label: "Video", unit: "second", credits: 1, active: true });
    await upsertCreditRate({ key: "video_hd", label: "HD", unit: "second", credits: 1.5, active: true });
    await upsertCreditRate({ key: "image", label: "Image", unit: "item", credits: 0, active: true });
    await upsertCreditRate({ key: "caption", label: "Caption", unit: "item", credits: 0, active: true });

    const sd = await quoteVideoJobCredits({ durationSec: 10, sceneCount: 1, resolution: "480p" });
    const hd = await quoteVideoJobCredits({ durationSec: 10, sceneCount: 1, resolution: "1080p" });
    expect(sd.credits).toBe(10);
    expect(hd.credits).toBe(15);
  });

  it("adds voice and lip sync only when the job uses them", async () => {
    await upsertCreditRate({ key: "video", label: "Video", unit: "second", credits: 1, active: true });
    await upsertCreditRate({ key: "image", label: "Image", unit: "item", credits: 0, active: true });
    await upsertCreditRate({ key: "caption", label: "Caption", unit: "item", credits: 0, active: true });
    await upsertCreditRate({ key: "voice", label: "Voice", unit: "second", credits: 0.1, active: true });
    await upsertCreditRate({ key: "lipsync", label: "Lip sync", unit: "second", credits: 2, active: true });

    const plain = await quoteVideoJobCredits({ durationSec: 10, sceneCount: 1 });
    const spoken = await quoteVideoJobCredits({
      durationSec: 10,
      sceneCount: 1,
      narrated: true,
      lipSync: true,
    });
    expect(plain.credits).toBe(10);
    expect(spoken.credits).toBe(10 + 1 + 20);
  });

  it("returns null for an action with no configured rate", async () => {
    expect(await quoteActionCredits("no_such_action")).toBeNull();
  });
});

describe("monthly plan grant", () => {
  const planId = "credit-test-plan";

  beforeEach(async () => {
    await db.delete(planSettingsTable).where(eq(planSettingsTable.id, planId));
  });

  afterAll(async () => {
    await db.delete(planSettingsTable).where(eq(planSettingsTable.id, planId));
  });

  it("grants nothing for a plan with no allowance", async () => {
    expect(
      await grantMonthlyCredits({ tenantId, planId, periodEnd: "2026-02-01T00:00:00.000Z" }),
    ).toBe(0);
  });

  it("grants the plan allowance exactly once per period", async () => {
    await db.insert(planSettingsTable).values({
      id: planId,
      name: "Credit test",
      priceLabel: "test",
      captions: 0,
      images: 0,
      videos: 0,
      monthlyCredits: 60,
      brandKits: 1,
      scheduledPosts: 1,
      features: [],
    });

    const period = "2026-02-01T00:00:00.000Z";
    expect(await grantMonthlyCredits({ tenantId, planId, periodEnd: period })).toBe(60);
    // A redelivered webhook for the same period must not grant again.
    expect(await grantMonthlyCredits({ tenantId, planId, periodEnd: period })).toBe(0);
    expect((await getCreditBalance(tenantId)).total).toBe(60);

    // The NEXT period does grant.
    expect(
      await grantMonthlyCredits({ tenantId, planId, periodEnd: "2026-03-01T00:00:00.000Z" }),
    ).toBe(60);
    expect((await getCreditBalance(tenantId)).total).toBe(120);
  });

  it("keys the grant on the period, not on when it ran", () => {
    expect(monthlyGrantKey(7, "2026-02-01T00:00:00.000Z")).toBe(
      "plan:7:2026-02-01T00:00:00.000Z",
    );
  });

  it("lands the allowance in the expiring bucket", async () => {
    await db.insert(planSettingsTable).values({
      id: planId,
      name: "Credit test",
      priceLabel: "test",
      captions: 0,
      images: 0,
      videos: 0,
      monthlyCredits: 15,
      brandKits: 1,
      scheduledPosts: 1,
      features: [],
    });
    await grantMonthlyCredits({ tenantId, planId, periodEnd: "2026-04-01T00:00:00.000Z" });
    const balance = await getCreditBalance(tenantId);
    expect(balance.granted).toBe(15);
    expect(balance.purchased).toBe(0);
    expect(balance.grantedExpiresAt).not.toBeNull();
  });
});
