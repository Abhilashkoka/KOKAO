import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { vi } from "vitest";

vi.mock("@clerk/express", async () => {
  const { authState } = await import("../test/authState");
  return {
    getAuth: () =>
      authState.userId
        ? {
            userId: authState.userId,
            sessionClaims: { userId: authState.userId },
          }
        : {},
    clerkClient: {
      users: {
        getUser: async (id: string) => {
          const u = authState.users[id];
          if (!u) throw new Error("user not found");
          return u;
        },
      },
    },
    clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) =>
      next(),
  };
});

vi.mock("../lib/connectionSweep", () => ({
  triggerSweepNow: vi.fn(() => true),
  isSweepRunning: vi.fn(() => false),
  checkSweepStaleness: vi.fn(async () => undefined),
  SWEEP_FAIL_RATIO_ALERT_THRESHOLD: 0.5,
}));

import { pool, db, usageEventsTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import { createAdminTestApp } from "../test/testApp";
import { resetAuthState, actAs } from "../test/authState";
import { createTenant, deleteTenant, type TestTenant } from "../test/dbHelpers";

const app = createAdminTestApp();

// Seed into the CURRENT and PREVIOUS months so both buckets are guaranteed
// to land inside the newest-12 trend window. The shared dev DB has real rows
// in these months, so every summary/trend assertion uses before/after DELTAS.
const NOW = new Date();
const CUR_YEAR = NOW.getUTCFullYear();
const CUR_MONTH0 = NOW.getUTCMonth(); // 0-based
const PREV_YEAR = CUR_MONTH0 === 0 ? CUR_YEAR - 1 : CUR_YEAR;
const PREV_MONTH0 = CUR_MONTH0 === 0 ? 11 : CUR_MONTH0 - 1;
const fmt = (y: number, m0: number) => `${y}-${String(m0 + 1).padStart(2, "0")}`;
const MONTH_A = fmt(PREV_YEAR, PREV_MONTH0); // previous month
const MONTH_B = fmt(CUR_YEAR, CUR_MONTH0); // current month
const EMPTY_MONTH = "1998-06";

interface MonthTotal {
  month: string;
  captionCount: number;
  imageCount: number;
  totalCostPaise: number;
  displaySpendPaise: number;
  unknownCount: number;
}

interface Report {
  month: string;
  months: string[];
  displayRates: { captionPaise: number; imagePaise: number };
  summary: MonthTotal;
  trend: MonthTotal[];
  tenants: Array<{
    tenantId: number;
    captionCount: number;
    imageCount: number;
    captionCostPaise: number;
    imageCostPaise: number;
    unknownCaptionCount: number;
    unknownImageCount: number;
    totalCostPaise: number;
    displaySpendPaise: number;
  }>;
}

let admin: TestTenant;
const createdEventIds: number[] = [];

async function fetchReport(month?: string): Promise<Report> {
  const res = await request(app).get(
    month ? `/api/admin/ai-cost/report?month=${month}` : "/api/admin/ai-cost/report",
  );
  expect(res.status).toBe(200);
  return res.body as Report;
}

async function seedEvent(
  tenantId: number,
  kind: string,
  costPaise: number | null,
  createdAt: Date,
): Promise<void> {
  const [row] = await db
    .insert(usageEventsTable)
    .values({ tenantId, kind, costPaise, createdAt })
    .returning({ id: usageEventsTable.id });
  createdEventIds.push(row.id);
}

beforeAll(async () => {
  admin = await createTenant({ isSuperadmin: true });
});

afterAll(async () => {
  if (createdEventIds.length > 0) {
    await db
      .delete(usageEventsTable)
      .where(inArray(usageEventsTable.id, createdEventIds));
  }
  await deleteTenant(admin.tenantId);
  await pool.end();
});

beforeEach(() => {
  resetAuthState();
  actAs(admin.clerkUserId, admin.email);
});

describe("GET /admin/ai-cost/report", () => {
  it("rejects a malformed month", async () => {
    const res = await request(app).get("/api/admin/ai-cost/report?month=2024-13");
    expect(res.status).toBe(400);
  });

  it("is superadmin-only", async () => {
    const plain = await createTenant();
    try {
      actAs(plain.clerkUserId, plain.email);
      const res = await request(app).get("/api/admin/ai-cost/report");
      expect(res.status).toBe(403);
    } finally {
      await deleteTenant(plain.tenantId);
    }
  });

  it("aggregates summary, trend, and per-tenant totals from real usage_events rows", async () => {
    // Baselines BEFORE seeding, so any pre-existing rows in the shared dev DB
    // are subtracted out of every assertion.
    const beforeA = (await fetchReport(MONTH_A)).summary;
    const beforeB = (await fetchReport(MONTH_B)).summary;

    // Month A (previous month): 3 captions (100, 200, NULL) + 2 images (50, NULL)
    const inA = (day: number) => new Date(Date.UTC(PREV_YEAR, PREV_MONTH0, day, 12));
    await seedEvent(admin.tenantId, "caption", 100, inA(3));
    await seedEvent(admin.tenantId, "caption", 200, inA(10));
    await seedEvent(admin.tenantId, "caption", null, inA(20));
    await seedEvent(admin.tenantId, "image", 50, inA(5));
    await seedEvent(admin.tenantId, "image", null, inA(28));
    // Non-metered kinds must be excluded from the caption/image report.
    await seedEvent(admin.tenantId, "transcribe", 999, inA(15));

    // Month B (current month): 1 caption (500) + 1 image (NULL). Day 1 at
    // 00:30 UTC is always in the past within the current month bucket.
    const inB = () => new Date(Date.UTC(CUR_YEAR, CUR_MONTH0, 1, 0, 30));
    await seedEvent(admin.tenantId, "caption", 500, inB());
    await seedEvent(admin.tenantId, "image", null, inB());

    const reportA = await fetchReport(MONTH_A);
    const { captionPaise, imagePaise } = reportA.displayRates;

    // --- summary (month A) as a delta over the baseline ---
    expect(reportA.summary.month).toBe(MONTH_A);
    expect(reportA.summary.captionCount - beforeA.captionCount).toBe(3);
    expect(reportA.summary.imageCount - beforeA.imageCount).toBe(2);
    expect(reportA.summary.totalCostPaise - beforeA.totalCostPaise).toBe(350);
    expect(reportA.summary.unknownCount - beforeA.unknownCount).toBe(2);
    expect(reportA.summary.displaySpendPaise - beforeA.displaySpendPaise).toBe(
      3 * captionPaise + 2 * imagePaise,
    );

    // --- per-tenant row is fully deterministic (fresh tenant) ---
    const mineA = reportA.tenants.find((t) => t.tenantId === admin.tenantId);
    expect(mineA).toBeDefined();
    expect(mineA!.captionCount).toBe(3);
    expect(mineA!.imageCount).toBe(2);
    expect(mineA!.captionCostPaise).toBe(300);
    expect(mineA!.imageCostPaise).toBe(50);
    expect(mineA!.unknownCaptionCount).toBe(1);
    expect(mineA!.unknownImageCount).toBe(1);
    expect(mineA!.totalCostPaise).toBe(350);
    expect(mineA!.displaySpendPaise).toBe(3 * captionPaise + 2 * imagePaise);

    // --- summary (month B) ---
    const reportB = await fetchReport(MONTH_B);
    expect(reportB.summary.captionCount - beforeB.captionCount).toBe(1);
    expect(reportB.summary.imageCount - beforeB.imageCount).toBe(1);
    expect(reportB.summary.totalCostPaise - beforeB.totalCostPaise).toBe(500);
    expect(reportB.summary.unknownCount - beforeB.unknownCount).toBe(1);

    const mineB = reportB.tenants.find((t) => t.tenantId === admin.tenantId);
    expect(mineB).toBeDefined();
    expect(mineB!.totalCostPaise).toBe(500);
    expect(mineB!.unknownCaptionCount).toBe(0);
    expect(mineB!.unknownImageCount).toBe(1);

    // --- months list: contains both seeded months, newest first ---
    expect(reportA.months).toContain(MONTH_A);
    expect(reportA.months).toContain(MONTH_B);
    const sorted = [...reportA.months].sort().reverse();
    expect(reportA.months).toEqual(sorted);
    expect(reportA.months.indexOf(MONTH_B)).toBeLessThan(
      reportA.months.indexOf(MONTH_A),
    );

    // --- trend: capped at 12, newest first, mirrors the months list ---
    expect(reportA.trend.length).toBeLessThanOrEqual(12);
    expect(reportA.trend.length).toBe(Math.min(12, reportA.months.length));
    expect(reportA.trend.map((t) => t.month)).toEqual(
      reportA.months.slice(0, 12),
    );
    // Both seeded months are the newest two buckets, so they MUST be inside
    // the 12-month trend window; each trend row must agree with the summary
    // computed for that month (which was itself asserted via deltas above).
    const trendA = reportA.trend.find((t) => t.month === MONTH_A);
    expect(trendA).toBeDefined();
    expect(trendA).toEqual(reportA.summary);
    const trendB = reportA.trend.find((t) => t.month === MONTH_B);
    expect(trendB).toBeDefined();
    expect(trendB).toEqual(reportB.summary);
    // And the trend deltas over the pre-seed baselines match the seeded rows.
    expect(trendA!.totalCostPaise - beforeA.totalCostPaise).toBe(350);
    expect(trendA!.unknownCount - beforeA.unknownCount).toBe(2);
    expect(trendB!.totalCostPaise - beforeB.totalCostPaise).toBe(500);
    expect(trendB!.unknownCount - beforeB.unknownCount).toBe(1);
  });

  it("returns a zeroed fallback summary for a month with no events", async () => {
    const report = await fetchReport(EMPTY_MONTH);
    expect(report.months).not.toContain(EMPTY_MONTH);
    expect(report.summary).toEqual({
      month: EMPTY_MONTH,
      captionCount: 0,
      imageCount: 0,
      totalCostPaise: 0,
      displaySpendPaise: 0,
      unknownCount: 0,
    });
    expect(report.tenants.find((t) => t.tenantId === admin.tenantId)).toBeUndefined();
  });
});
