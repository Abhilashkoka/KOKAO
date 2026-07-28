import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";

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
}));

// Stub the Razorpay client so the create-plan route's price sync can be
// exercised without live credentials or network calls.
vi.mock("../lib/razorpay", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/razorpay")>();
  return {
    ...original,
    isRazorpayConfigured: vi.fn(async () => true),
    createRazorpayPlan: vi.fn(async () => ({ id: "plan_test_created" })),
  };
});

import { pool, db, planSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { isRazorpayConfigured, createRazorpayPlan } from "../lib/razorpay";
import { createAdminTestApp } from "../test/testApp";
import { resetAuthState, actAs } from "../test/authState";
import {
  createTenant,
  deleteTenant,
  setTenantSuperadmin,
  getPlanSettingsRow,
} from "../test/dbHelpers";

const app = createAdminTestApp();

afterAll(async () => {
  await pool.end();
});

beforeEach(() => {
  resetAuthState();
  vi.mocked(isRazorpayConfigured).mockClear();
  vi.mocked(createRazorpayPlan).mockClear();
  vi.mocked(isRazorpayConfigured).mockResolvedValue(true);
  vi.mocked(createRazorpayPlan).mockResolvedValue({
    id: "plan_test_created",
  } as Awaited<ReturnType<typeof createRazorpayPlan>>);
});

describe("POST /admin/plans — price sync on create", () => {
  it("creating a plan WITH a price mints a Razorpay Plan and persists both fields", async () => {
    const tenant = await createTenant({
      email: `plan-create-${randomUUID()}@example.com`,
    });
    const planId = `create-priced-${randomUUID().slice(0, 8)}`;
    try {
      actAs(tenant.clerkUserId, tenant.email);
      await setTenantSuperadmin(tenant.tenantId, true);

      const res = await request(app).post("/api/admin/plans").send({
        id: planId,
        name: "Priced Custom",
        priceLabel: "Rs 499/mo",
        priceInr: 49900,
        limits: { captions: 10, images: 5, brandKits: 1, scheduledPosts: 10 },
        features: ["test feature"],
      });
      expect(res.status).toBe(200);
      expect(vi.mocked(createRazorpayPlan)).toHaveBeenCalledWith(
        "Priced Custom",
        49900,
      );

      // The row is purchasable immediately: price AND Razorpay plan id set.
      const row = await getPlanSettingsRow(planId);
      expect(row?.priceInr).toBe(49900);
      expect(row?.razorpayPlanId).toBe("plan_test_created");

      // The returned catalog reflects the same.
      const created = (res.body as Array<Record<string, unknown>>).find(
        (p) => p.id === planId,
      );
      expect(created?.priceInr).toBe(49900);
      expect(created?.razorpayPlanId).toBe("plan_test_created");
    } finally {
      await db.delete(planSettingsTable).where(eq(planSettingsTable.id, planId));
      await deleteTenant(tenant.tenantId);
    }
  });

  it("saves a priced create without Razorpay keys, leaving the plan unpurchasable (no mint)", async () => {
    vi.mocked(isRazorpayConfigured).mockResolvedValue(false);
    const tenant = await createTenant({
      email: `plan-create-${randomUUID()}@example.com`,
    });
    const planId = `create-noconf-${randomUUID().slice(0, 8)}`;
    try {
      actAs(tenant.clerkUserId, tenant.email);
      await setTenantSuperadmin(tenant.tenantId, true);

      const res = await request(app).post("/api/admin/plans").send({
        id: planId,
        name: "Priced Without Keys",
        priceLabel: "Rs 499/mo",
        priceInr: 49900,
        limits: { captions: 10, images: 5, brandKits: 1, scheduledPosts: 10 },
        features: ["test feature"],
      });
      expect(res.status).toBe(200);
      expect(vi.mocked(createRazorpayPlan)).not.toHaveBeenCalled();
      const row = await getPlanSettingsRow(planId);
      expect(row?.priceInr).toBe(49900);
      expect(row?.razorpayPlanId).toBeNull();
    } finally {
      await db.delete(planSettingsTable).where(eq(planSettingsTable.id, planId));
      await deleteTenant(tenant.tenantId);
    }
  });

  it("creating a plan WITHOUT a price never touches Razorpay", async () => {
    const tenant = await createTenant({
      email: `plan-create-${randomUUID()}@example.com`,
    });
    const planId = `create-free-${randomUUID().slice(0, 8)}`;
    try {
      actAs(tenant.clerkUserId, tenant.email);
      await setTenantSuperadmin(tenant.tenantId, true);

      const res = await request(app).post("/api/admin/plans").send({
        id: planId,
        name: "Unpriced Custom",
        priceLabel: "Contact us",
        limits: { captions: 10, images: 5, brandKits: 1, scheduledPosts: 10 },
        features: ["test feature"],
      });
      expect(res.status).toBe(200);
      expect(vi.mocked(createRazorpayPlan)).not.toHaveBeenCalled();
      const row = await getPlanSettingsRow(planId);
      expect(row?.priceInr).toBeNull();
      expect(row?.razorpayPlanId).toBeNull();
    } finally {
      await db.delete(planSettingsTable).where(eq(planSettingsTable.id, planId));
      await deleteTenant(tenant.tenantId);
    }
  });
});
