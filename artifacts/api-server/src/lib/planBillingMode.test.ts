import { describe, it, expect, afterAll, beforeAll, beforeEach, vi } from "vitest";

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

import { pool, db, tenantsTable, planSettingsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { applyPlanBillingMode, invalidatePlanCache } from "./plans";
import { createTenant, deleteTenant } from "../test/dbHelpers";

const createdTenantIds: number[] = [];
const savedPlanRows: (typeof planSettingsTable.$inferSelect)[] = [];

const deterministicPlanFixtures = [
  {
    id: "free",
    name: "Free (billing-mode test)",
    priceLabel: "$0 / mo",
    captions: 20,
    images: 10,
    videos: 3,
    brandKits: 1,
    scheduledPosts: 10,
    teamSeats: 0,
    watermark: true,
    billingMode: "quota" as const,
    monthlyCredits: 0,
    features: [],
    sortOrder: 0,
    archived: false,
  },
  {
    id: "payg",
    name: "Pay As You Go (billing-mode test)",
    priceLabel: "No monthly fee",
    captions: 0,
    images: 0,
    videos: 0,
    brandKits: 3,
    scheduledPosts: 50,
    teamSeats: 0,
    watermark: false,
    // The production credit rollout uses the unified credits rail for payg.
    billingMode: "credits" as const,
    monthlyCredits: 0,
    features: [],
    sortOrder: 1,
    archived: false,
  },
];

async function makeTenant(): Promise<number> {
  const { tenantId } = await createTenant();
  createdTenantIds.push(tenantId);
  return tenantId;
}

async function tenantBilling(id: number) {
  const row = (
    await db
      .select({
        billingMode: tenantsTable.billingMode,
        overriddenAt: tenantsTable.billingModeOverriddenAt,
      })
      .from(tenantsTable)
      .where(eq(tenantsTable.id, id))
      .limit(1)
  )[0];
  if (!row) throw new Error("tenant not found");
  return row;
}

afterAll(async () => {
  for (const id of createdTenantIds) await deleteTenant(id);
  await db
    .delete(planSettingsTable)
    .where(inArray(planSettingsTable.id, ["free", "payg"]));
  if (savedPlanRows.length > 0) {
    await db.insert(planSettingsTable).values(savedPlanRows);
  }
  invalidatePlanCache();
  await pool.end();
});

beforeAll(async () => {
  const rows = await db
    .select()
    .from(planSettingsTable)
    .where(inArray(planSettingsTable.id, ["free", "payg"]));
  savedPlanRows.push(...rows);
  await db
    .delete(planSettingsTable)
    .where(inArray(planSettingsTable.id, ["free", "payg"]));
  await db.insert(planSettingsTable).values(deterministicPlanFixtures);
  invalidatePlanCache();
});

beforeEach(() => {
  invalidatePlanCache();
});

describe("applyPlanBillingMode", () => {
  it("applies the configured payg billing mode when a tenant lands on it", async () => {
    const tenantId = await makeTenant();
    expect((await tenantBilling(tenantId)).billingMode).toBe("quota");

    await applyPlanBillingMode(tenantId, "payg");
    expect((await tenantBilling(tenantId)).billingMode).toBe("credits");
  });

  it("switches back to quota when landing on a quota plan", async () => {
    const tenantId = await makeTenant();
    await applyPlanBillingMode(tenantId, "payg");
    expect((await tenantBilling(tenantId)).billingMode).toBe("credits");

    await applyPlanBillingMode(tenantId, "free");
    expect((await tenantBilling(tenantId)).billingMode).toBe("quota");
  });

  it("never touches a tenant whose billing mode was manually overridden", async () => {
    const tenantId = await makeTenant();
    await db
      .update(tenantsTable)
      .set({ billingMode: "quota", billingModeOverriddenAt: new Date() })
      .where(eq(tenantsTable.id, tenantId));

    await applyPlanBillingMode(tenantId, "payg");
    expect((await tenantBilling(tenantId)).billingMode).toBe("quota");
  });

  it("respects a plan_settings override row's billing mode", async () => {
    const tenantId = await makeTenant();
    // Custom plan row with wallet billing.
    const planId = `bmtest-${tenantId}`;
    await db.insert(planSettingsTable).values({
      id: planId,
      name: "BM Test",
      priceLabel: "test",
      captions: 1,
      images: 1,
      videos: 0,
      brandKits: 1,
      scheduledPosts: 1,
      teamSeats: 0,
      watermark: false,
      billingMode: "wallet",
      features: [],
      sortOrder: 99,
      archived: false,
    });
    invalidatePlanCache();
    try {
      await applyPlanBillingMode(tenantId, planId);
      expect((await tenantBilling(tenantId)).billingMode).toBe("wallet");
    } finally {
      await db.delete(planSettingsTable).where(eq(planSettingsTable.id, planId));
      invalidatePlanCache();
    }
  });

  it("no-ops on an unknown plan even when the tenant is payg-billed", async () => {
    const tenantId = await makeTenant();
    await applyPlanBillingMode(tenantId, "payg");
    expect((await tenantBilling(tenantId)).billingMode).toBe("credits");

    await expect(
      applyPlanBillingMode(tenantId, "no-such-plan"),
    ).resolves.toBeUndefined();
    // Must stay on payg's configured mode — an unknown id must not fall back
    // to a default plan.
    expect((await tenantBilling(tenantId)).billingMode).toBe("credits");
  });
});
