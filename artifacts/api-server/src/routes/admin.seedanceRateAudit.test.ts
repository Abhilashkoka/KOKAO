import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const mocks = vi.hoisted(() => ({
  listModelPrices: vi.fn(),
  refreshBytePlusSeedancePricing: vi.fn(),
}));

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
          const user = authState.users[id];
          if (!user) throw new Error("user not found");
          return user;
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

vi.mock("../lib/aiCost", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/aiCost")>();
  return { ...actual, listModelPrices: mocks.listModelPrices };
});

vi.mock("../lib/modelPricingSync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/modelPricingSync")>();
  return {
    ...actual,
    refreshBytePlusSeedancePricing: mocks.refreshBytePlusSeedancePricing,
  };
});

import { and, desc, eq } from "drizzle-orm";
import { adminAuditLogsTable, db, pool } from "@workspace/db";
import { createAdminTestApp } from "../test/testApp";
import { actAs, resetAuthState } from "../test/authState";
import { createTenant, deleteTenant, type TestTenant } from "../test/dbHelpers";

const app = createAdminTestApp();
const model = "dreamina-seedance-2-5-260628";
const sourceUrl = "https://docs.byteplus.com/en/docs/ModelArk/1544106";
let admin: TestTenant;

function storedRows() {
  const checkedAt = new Date("2026-09-01T10:00:00.000Z");
  return [
    ["480p", 0.1, null, null],
    ["720p", 0.2, null, null],
    ["1080p", 0.5, 0.4, new Date("2026-09-10T06:00:00.000Z")],
  ].map(([resolution, list, promotion, expiry]) => ({
    kind: "video",
    provider: "byteplus",
    model,
    variantCriteria: { resolution },
    usdPerSecond: list,
    promotionalUsdPerSecond: promotion,
    promotionExpiresAt: expiry,
    sourceUrl,
    sourceCheckedAt: checkedAt,
  }));
}

function refreshedPricing(list1080p: number) {
  return {
    model,
    sourceUrl,
    sourceCheckedAt: new Date("2026-09-07T12:00:00.000Z"),
    prices: [
      {
        resolution: "480p",
        usdPerSecond: 0.1,
        promotionalUsdPerSecond: null,
        promotionExpiresAt: null,
      },
      {
        resolution: "720p",
        usdPerSecond: 0.2,
        promotionalUsdPerSecond: null,
        promotionExpiresAt: null,
      },
      {
        resolution: "1080p",
        usdPerSecond: list1080p,
        promotionalUsdPerSecond: 0.4,
        promotionExpiresAt: new Date("2026-09-10T06:00:00.000Z"),
      },
    ],
  };
}

beforeAll(async () => {
  admin = await createTenant({ isSuperadmin: true });
});

beforeEach(async () => {
  resetAuthState();
  actAs(admin.clerkUserId, admin.email);
  mocks.listModelPrices.mockResolvedValue(storedRows());
  await db
    .delete(adminAuditLogsTable)
    .where(
      and(
        eq(adminAuditLogsTable.actorTenantId, admin.tenantId),
        eq(adminAuditLogsTable.action, "seedance_rate_refresh"),
      ),
    );
});

afterAll(async () => {
  await deleteTenant(admin.tenantId);
  await pool.end();
});

describe("POST /admin/ai-cost/prices/byteplus-seedance/refresh audit", () => {
  it.each([
    [0.55, "changed"],
    [0.5, "no_change"],
  ])("records complete before/after rates with outcome %s", async (list1080p, outcome) => {
    mocks.refreshBytePlusSeedancePricing.mockResolvedValue(
      refreshedPricing(list1080p),
    );

    const response = await request(app).post(
      "/api/admin/ai-cost/prices/byteplus-seedance/refresh",
    );
    expect(response.status).toBe(200);

    const [audit] = await db
      .select()
      .from(adminAuditLogsTable)
      .where(
        and(
          eq(adminAuditLogsTable.actorTenantId, admin.tenantId),
          eq(adminAuditLogsTable.action, "seedance_rate_refresh"),
        ),
      )
      .orderBy(desc(adminAuditLogsTable.id))
      .limit(1);

    const before = JSON.parse(audit.oldValue!);
    const after = JSON.parse(audit.newValue!);
    expect(before.rates["480p"].listUsdPerSecond).toBe(0.1);
    expect(before.rates["720p"].listUsdPerSecond).toBe(0.2);
    expect(before.rates["1080p"]).toEqual({
      listUsdPerSecond: 0.5,
      promotionUsdPerSecond: 0.4,
      promotionExpiresAt: "2026-09-10T06:00:00.000Z",
    });
    expect(after.rates["1080p"].listUsdPerSecond).toBe(list1080p);
    expect(after.provider).toBe("byteplus");
    expect(after.sourceUrl).toBe(sourceUrl);
    expect(after.sourceCheckedAt).toBe("2026-09-07T12:00:00.000Z");
    expect(after.outcome).toBe(outcome);
  });
});