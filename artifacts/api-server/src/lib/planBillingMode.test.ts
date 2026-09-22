import { describe, it, expect, afterAll, beforeAll, beforeEach, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

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
import { actAs, resetAuthState } from "../test/authState";
import { requireTenant } from "../middlewares/requireTenant";

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

function createProvisioningTestApp(): Express {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, () => void> }).log = {
      info() {},
      error() {},
      warn() {},
      debug() {},
    };
    next();
  });
  app.get("/api/probe", requireTenant, (req, res) => {
    res.json({ tenantId: req.tenantId });
  });
  return app;
}

const provisioningApp = createProvisioningTestApp();

async function configureFreeBillingMode(
  billingMode: "quota" | "wallet" | "credits",
): Promise<void> {
  await db
    .update(planSettingsTable)
    .set({ billingMode, updatedAt: new Date() })
    .where(eq(planSettingsTable.id, "free"));
  invalidatePlanCache();
}

async function findTenantForClerkUser(clerkUserId: string) {
  return (
    await db
      .select()
      .from(tenantsTable)
      .where(eq(tenantsTable.clerkUserId, clerkUserId))
      .limit(1)
  )[0];
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

beforeEach(async () => {
  resetAuthState();
  await configureFreeBillingMode("quota");
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

describe("new tenant plan billing mode", () => {
  it.each(["credits", "wallet", "quota"] as const)(
    "writes Free's configured %s mode in the provisioning INSERT",
    async (billingMode) => {
      await configureFreeBillingMode(billingMode);
      const clerkUserId = `billing-mode-new-${billingMode}-${Date.now()}`;
      actAs(clerkUserId, `${clerkUserId}@example.com`);

      const response = await request(provisioningApp).get("/api/probe");
      expect(response.status).toBe(200);

      const tenant = await findTenantForClerkUser(clerkUserId);
      expect(tenant).toMatchObject({
        plan: "free",
        billingMode,
        billingModeOverriddenAt: null,
      });
      createdTenantIds.push(tenant!.id);
    },
  );

  it("does not change an existing tenant's manual billing-mode override", async () => {
    await configureFreeBillingMode("credits");
    const existing = await createTenant({ email: "existing-override@example.com" });
    createdTenantIds.push(existing.tenantId);
    const overriddenAt = new Date();
    await db
      .update(tenantsTable)
      .set({ billingMode: "wallet", billingModeOverriddenAt: overriddenAt })
      .where(eq(tenantsTable.id, existing.tenantId));
    actAs(existing.clerkUserId, existing.email);

    expect((await request(provisioningApp).get("/api/probe")).status).toBe(200);

    const tenant = await findTenantForClerkUser(existing.clerkUserId);
    expect(tenant?.billingMode).toBe("wallet");
    expect(tenant?.billingModeOverriddenAt?.getTime()).toBe(
      overriddenAt.getTime(),
    );
  });

  it("keeps the concurrent INSERT winner's configured mode", async () => {
    await configureFreeBillingMode("credits");
    const clerkUserId = `billing-mode-race-${Date.now()}`;
    actAs(clerkUserId, `${clerkUserId}@example.com`);

    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        request(provisioningApp).get("/api/probe"),
      ),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);

    const rows = await db
      .select()
      .from(tenantsTable)
      .where(eq(tenantsTable.clerkUserId, clerkUserId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.billingMode).toBe("credits");
    createdTenantIds.push(rows[0]!.id);
  });
});
