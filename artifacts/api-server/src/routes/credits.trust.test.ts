import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("./../lib/creditReconciliationGate", () => ({
  CREDIT_RECONCILIATION_GATE: {
    verdict: "go",
    reason: "trust pricing test override",
  },
  isCreditEnforcementAllowed: () => true,
  creditEnforcementLockReason: () => "trust pricing test override",
}));

vi.mock("../middlewares/requireTenant", () => ({
  requireTenant: (req: { header: (name: string) => string | undefined; tenantId?: number }, _res: unknown, next: () => void) => {
    req.tenantId = Number(req.header("x-test-tenant"));
    next();
  },
}));

import {
  pool,
  db,
  creditAccountLedgerTable,
  creditMeterSettingsTable,
  guidedStoryDraftsTable,
  videoGenerationsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import creditsRouter from "./credits";
import {
  DEFAULT_SPEND_GUARD,
  getSpendGuard,
  invalidateCreditRateCache,
  setMeterMode,
  setSpendGuard,
  SpendGuardNotReadyError,
  spendNeedsConfirmation,
} from "../lib/creditRates";
import { guidedDraftQuoteInput, quoteVideoJobCredits } from "../lib/creditQuote";
import { buildVideoJobCreditReceipt } from "../lib/creditReceipt";
import { createTenant, deleteTenant } from "../test/dbHelpers";

const app = express();
app.use(express.json());
app.use("/api", creditsRouter);

let tenantId: number;
let otherTenantId: number;

function guidedState(runtimeSeconds: number, scenes: number, spoken: boolean) {
  return {
    version: 1,
    setup: { width: 1080, height: 1920, durationSeconds: runtimeSeconds },
    script: {
      version: 1,
      title: "t",
      logline: "l",
      runtimeSeconds,
      roles: [],
      warnings: [],
      scenes: Array.from({ length: scenes }, (_, i) => ({
        id: `s${i + 1}`,
        startMs: i * 5000,
        endMs: (i + 1) * 5000,
        visualDirection: "v",
        roleIds: [],
        lines: spoken
          ? [{ id: `l${i}`, ownerRoleId: null, kind: "narration", text: "hi", startMs: i * 5000, endMs: i * 5000 + 2000 }]
          : [],
      })),
    },
  };
}

beforeAll(async () => {
  tenantId = (await createTenant()).tenantId;
  otherTenantId = (await createTenant()).tenantId;
  await setMeterMode("enforce");
});

beforeEach(() => {
  invalidateCreditRateCache();
});

afterAll(async () => {
  await setMeterMode("shadow");
  for (const id of [tenantId, otherTenantId]) {
    await db.delete(creditAccountLedgerTable).where(eq(creditAccountLedgerTable.tenantId, id));
    await db.delete(videoGenerationsTable).where(eq(videoGenerationsTable.tenantId, id));
    await db.delete(guidedStoryDraftsTable).where(eq(guidedStoryDraftsTable.tenantId, id));
    await deleteTenant(id);
  }
  await pool.end();
});

describe("spend guard", () => {
  it("defaults to 100 credits / 25% and is exposed on GET /credits", async () => {
    await db
      .update(creditMeterSettingsTable)
      .set({ confirmAboveCredits: null, confirmAbovePercent: null });
    invalidateCreditRateCache();
    const res = await request(app).get("/api/credits").set("x-test-tenant", String(tenantId));
    expect(res.status).toBe(200);
    expect(res.body.spendGuard).toEqual(DEFAULT_SPEND_GUARD);
  });

  it("saves new thresholds on the existing settings row", async () => {
    await setSpendGuard({ confirmAboveCredits: 40, confirmAbovePercent: 10 });
    expect(await getSpendGuard()).toEqual({ confirmAboveCredits: 40, confirmAbovePercent: 10 });
    await setSpendGuard(DEFAULT_SPEND_GUARD);
  });

  it("refuses out-of-range thresholds", async () => {
    await expect(
      setSpendGuard({ confirmAboveCredits: -1, confirmAbovePercent: 10 }),
    ).rejects.toThrow();
    await expect(
      setSpendGuard({ confirmAboveCredits: 10, confirmAbovePercent: 101 }),
    ).rejects.toThrow();
  });

  it("never creates the settings row itself", async () => {
    // The production bootstrap refuses to start over an unreviewed row, so the
    // guard must only ever update one that already exists.
    const saved = await db.select().from(creditMeterSettingsTable);
    await db.delete(creditMeterSettingsTable);
    invalidateCreditRateCache();
    try {
      await expect(setSpendGuard(DEFAULT_SPEND_GUARD)).rejects.toBeInstanceOf(
        SpendGuardNotReadyError,
      );
      expect(await db.select().from(creditMeterSettingsTable)).toHaveLength(0);
    } finally {
      if (saved.length) await db.insert(creditMeterSettingsTable).values(saved);
      invalidateCreditRateCache();
    }
  });

  it("asks above either threshold and treats 0 as off", () => {
    const guard = { confirmAboveCredits: 100, confirmAbovePercent: 25 };
    expect(spendNeedsConfirmation(guard, 50, 1000)).toBe(false);
    expect(spendNeedsConfirmation(guard, 101, 10_000)).toBe(true);
    expect(spendNeedsConfirmation(guard, 60, 200)).toBe(true);
    expect(spendNeedsConfirmation(guard, 0, 0)).toBe(false);
    expect(
      spendNeedsConfirmation({ confirmAboveCredits: 0, confirmAbovePercent: 0 }, 5000, 5000),
    ).toBe(false);
  });
});

describe("Guided Story quote", () => {
  it("prices from the approved script, not a 5-second default", () => {
    const input = guidedDraftQuoteInput(guidedState(30, 6, true) as never);
    expect(input).toEqual({
      durationSec: 30,
      sceneCount: 6,
      resolution: "1080p",
      narrated: true,
      lipSync: false,
    });
    expect(guidedDraftQuoteInput({ setup: null, script: null })).toBeNull();
  });

  it("GET /credits/quote?action=guided_story matches the whole-job quote", async () => {
    const [draft] = await db
      .insert(guidedStoryDraftsTable)
      .values({ tenantId, state: guidedState(20, 4, false) as never })
      .returning();
    const res = await request(app)
      .get(`/api/credits/quote?action=guided_story&draftId=${draft!.id}`)
      .set("x-test-tenant", String(tenantId));
    expect(res.status).toBe(200);
    const expected = await quoteVideoJobCredits({
      durationSec: 20,
      sceneCount: 4,
      resolution: "1080p",
      narrated: false,
      lipSync: false,
    });
    expect(res.body.credits).toBe(expected.credits);
  });

  it("does not price another workspace's draft", async () => {
    const [draft] = await db
      .insert(guidedStoryDraftsTable)
      .values({ tenantId: otherTenantId, state: guidedState(20, 4, false) as never })
      .returning();
    const res = await request(app)
      .get(`/api/credits/quote?action=guided_story&draftId=${draft!.id}`)
      .set("x-test-tenant", String(tenantId));
    expect(res.status).toBe(404);
  });
});

describe("video job receipt", () => {
  it("nets spends against refunds per rate and reports variance", () => {
    const receipt = buildVideoJobCreditReceipt(
      7,
      { credits: 40, lines: [] },
      [
        { kind: "spend", rateKey: "video", purchasedDeltaMilli: -30_000, grantedDeltaMilli: 0 },
        { kind: "spend", rateKey: "image", purchasedDeltaMilli: -6_000, grantedDeltaMilli: -6_000 },
        { kind: "refund", rateKey: "image", purchasedDeltaMilli: 3_000, grantedDeltaMilli: 0 },
      ],
    );
    expect(receipt.charged).toBe(42);
    expect(receipt.refunded).toBe(3);
    expect(receipt.net).toBe(39);
    expect(receipt.variancePercent).toBe(-2.5);
    expect(receipt.lines[0]).toEqual({ rateKey: "video", charged: 30, refunded: 0 });
  });

  it("has no variance without a quote or before any charge", () => {
    expect(buildVideoJobCreditReceipt(1, null, []).variancePercent).toBeNull();
    expect(buildVideoJobCreditReceipt(1, { credits: 10, lines: [] }, []).variancePercent).toBeNull();
  });

  it("GET receipt reads the frozen quote and this job's ledger rows only", async () => {
    const [job] = await db
      .insert(videoGenerationsTable)
      .values({
        tenantId,
        engine: "topic_to_video",
        status: "succeeded",
        options: {
          creditQuote: { version: 1, credits: 20, lines: [], quotedAt: new Date().toISOString() },
        },
      } as never)
      .returning();
    await db.insert(creditAccountLedgerTable).values([
      {
        tenantId,
        kind: "spend",
        purchasedDeltaMilli: -22_000,
        rateKey: "video",
        refKind: "videoJob",
        refId: String(job!.id),
        idempotencyKey: `trust-test-spend-${job!.id}`,
      },
      {
        tenantId,
        kind: "spend",
        purchasedDeltaMilli: -99_000,
        rateKey: "video",
        refKind: "videoJob",
        refId: String(job!.id + 100000),
        idempotencyKey: `trust-test-other-${job!.id}`,
      },
    ]);
    const res = await request(app)
      .get(`/api/credits/receipts/video-jobs/${job!.id}`)
      .set("x-test-tenant", String(tenantId));
    expect(res.status).toBe(200);
    expect(res.body.quoted).toBe(20);
    expect(res.body.net).toBe(22);
    expect(res.body.variancePercent).toBe(10);

    const other = await request(app)
      .get(`/api/credits/receipts/video-jobs/${job!.id}`)
      .set("x-test-tenant", String(otherTenantId));
    expect(other.status).toBe(404);
  });
});
