import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";

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
import { eq } from "drizzle-orm";
import { applyPlanBillingMode, invalidatePlanCache } from "./plans";
import { createTenant, deleteTenant } from "../test/dbHelpers";

const createdTenantIds: number[] = [];

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
  await pool.end();
});

beforeEach(() => {
  invalidatePlanCache();
});

describe("applyPlanBillingMode", () => {
  it("switches a tenant to wallet billing when landing on payg (default wallet plan)", async () => {
    const tenantId = await makeTenant();
    expect((await tenantBilling(tenantId)).billingMode).toBe("quota");

    await applyPlanBillingMode(tenantId, "payg");
    expect((await tenantBilling(tenantId)).billingMode).toBe("wallet");
  });

  it("switches back to quota when landing on a quota plan", async () => {
    const tenantId = await makeTenant();
    await applyPlanBillingMode(tenantId, "payg");
    expect((await tenantBilling(tenantId)).billingMode).toBe("wallet");

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

  it("no-ops on an unknown plan even when the tenant is wallet-billed", async () => {
    const tenantId = await makeTenant();
    await applyPlanBillingMode(tenantId, "payg");
    expect((await tenantBilling(tenantId)).billingMode).toBe("wallet");

    await expect(
      applyPlanBillingMode(tenantId, "no-such-plan"),
    ).resolves.toBeUndefined();
    // Must stay wallet — an unknown id must not fall back to a default plan.
    expect((await tenantBilling(tenantId)).billingMode).toBe("wallet");
  });
});
