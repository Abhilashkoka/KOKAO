import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";

const featureTest = vi.hoisted(() => ({ disabled: false }));
// Override only this router's feature middleware in this test harness; the
// shared database's platform flags (and its 30-second cache) remain untouched.
vi.mock("../lib/featureFlags", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/featureFlags")>();
  return {
    ...original,
    getFeatureFlags: async () => ({
      ...await original.getFeatureFlags(),
      creatorProgram: !featureTest.disabled,
    }),
    requireFeature: (id: Parameters<typeof original.requireFeature>[0]) =>
      id === "creatorProgram"
        ? (_req: unknown, res: { status: (status: number) => { json: (body: object) => void } }, next: () => void) =>
          featureTest.disabled
            ? res.status(403).json({ error: "This feature is currently disabled by the administrator.", code: "feature_disabled" })
            : next()
        : original.requireFeature(id),
  };
});
vi.mock("@clerk/express", async () => {
  const { authState } = await import("../test/authState");
  return {
    getAuth: () => authState.userId ? { userId: authState.userId, sessionClaims: { userId: authState.userId } } : {},
    clerkClient: { users: { getUser: async (id: string) => {
      const user = authState.users[id];
      if (!user) throw new Error("user not found");
      return user;
    } } },
    clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});

import { pool, db, creatorAccountsTable, creatorCodesTable, creatorCommissionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireTenant } from "../middlewares/requireTenant";
import creatorRouter from "./creatorProgram";
import { resetAuthState, actAs } from "../test/authState";
import { createTenant, deleteTenant, setTenantSuperadmin } from "../test/dbHelpers";

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as unknown as { log: Record<string, () => void> }).log = {
    info() {}, error() {}, warn() {}, debug() {},
  };
  next();
});
app.use("/api", requireTenant, creatorRouter);
// An unrelated authenticated admin-prefixed route: proves creator-specific
// superadmin middleware does not bleed onto other admin modules.
app.get("/api/admin/other-module/health", requireTenant, (_req, res) => res.json({ ok: true }));
beforeEach(() => { featureTest.disabled = false; resetAuthState(); });
afterAll(async () => { await pool.end(); });

describe("creator API authorization and input validation", () => {
  it("requires a signed-in workspace for every route", async () => {
    expect((await request(app).get("/api/promoter/me")).status).toBe(401);
    expect((await request(app).get("/api/admin/creator-program/settings")).status).toBe(401);
  });

  it("refuses tenant access to admin review, commissions and settings", async () => {
    const tenant = await createTenant({ email: `creator-auth-${randomUUID()}@example.com` });
    try {
      actAs(tenant.clerkUserId, tenant.email);
      for (const path of ["/api/admin/creators", "/api/admin/commissions", "/api/admin/creator-program/settings"]) {
        expect((await request(app).get(path)).status).toBe(403);
      }
      expect((await request(app).put("/api/admin/creator-program/settings").send({ programEnabled: true })).status).toBe(403);
      expect((await request(app).post("/api/admin/creators/1/review").send({ decision: "approved" })).status).toBe(403);
      expect((await request(app).post("/api/admin/commissions/1/release").send({ reason: "test" })).status).toBe(403);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("validates agreement and code input before invoking creator operations", async () => {
    const tenant = await createTenant({ email: `creator-validation-${randomUUID()}@example.com` });
    try {
      actAs(tenant.clerkUserId, tenant.email);
      expect((await request(app).post("/api/promoter/apply").send({ displayName: "Test", agreementAccepted: false })).status).toBe(400);
      expect((await request(app).post("/api/credits/creator-code").send({ code: "" })).status).toBe(400);
      expect((await request(app).post("/api/credits/creator-code").send({ code: "KC-FAKE", tenantId: 1 })).status).toBe(400);
      expect((await request(app).get("/api/promoter/me")).status).toBe(404);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("blocks unsafe settings changes without mutating the program", async () => {
    const tenant = await createTenant({ email: `creator-admin-${randomUUID()}@example.com` });
    try {
      actAs(tenant.clerkUserId, tenant.email);
      await setTenantSuperadmin(tenant.tenantId, true);
      const before = await request(app).get("/api/admin/creator-program/settings");
      expect(before.status).toBe(200);
      for (const body of [
        { commissionSlabs: [{ minReferrals: 5, commissionBps: 1000 }] },
        { commissionSlabs: [{ minReferrals: 0, commissionBps: 1000 }, { minReferrals: 0, commissionBps: 1200 }] },
        { buyerBonusBps: 10001 },
        { id: 1, programEnabled: true },
        { programEnabled: "true" },
      ]) {
        expect((await request(app).put("/api/admin/creator-program/settings").send(body)).status).toBe(400);
      }
      const after = await request(app).get("/api/admin/creator-program/settings");
      expect(after.body.programEnabled).toBe(before.body.programEnabled);
      expect(after.body.commissionSlabs).toEqual(before.body.commissionSlabs);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
  it("promoter lifecycle response is enriched but suspended and rejected accounts have no codes", async () => {
    const tenant = await createTenant({ email: `promoter-lifecycle-${randomUUID()}@example.com` });
    try {
      actAs(tenant.clerkUserId, tenant.email);
      const absent = await request(app).get("/api/promoter/me");
      expect(absent.status).toBe(404);
      expect(absent.body.code).toBe("not_a_promoter");
      const [creator] = await db.insert(creatorAccountsTable).values({
        tenantId: tenant.tenantId, displayName: "Creator Fixture", contactEmail: tenant.email!,
        status: "applied", agreementVersion: "test",
      }).returning();
      for (const state of ["applied", "rejected", "suspended", "approved"]) {
        await db.update(creatorAccountsTable).set({ status: state }).where(eq(creatorAccountsTable.id, creator!.id));
        const result = await request(app).get("/api/promoter/me");
        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({ status: state, commission: { qualifyingPurchases: 0 }, earnings: { awaitingActivation: 0, inHoldWindow: 0 }, terms: { holdDays: expect.any(Number) } });
        if (state !== "approved") expect(result.body.codes).toEqual([]);
      }
    } finally {
      await db.delete(creatorAccountsTable).where(eq(creatorAccountsTable.tenantId, tenant.tenantId));
      await deleteTenant(tenant.tenantId);
    }
  });
  it("masks buyer identity and all risk details even for held commissions", async () => {
    const owner = await createTenant({ email: `promoter-owner-${randomUUID()}@example.com` });
    const buyer = await createTenant({ email: `promoter-buyer-${randomUUID()}@example.com` });
    try {
      const [creator] = await db.insert(creatorAccountsTable).values({
        tenantId: owner.tenantId, displayName: "Test Promoter", contactEmail: owner.email!, status: "approved",
      }).returning();
      const [code] = await db.insert(creatorCodesTable).values({
        creatorId: creator!.id, code: `KC-${randomUUID().slice(0, 8).toUpperCase()}`,
      }).returning();
      await db.insert(creatorCommissionsTable).values({
        creatorId: creator!.id, creatorCodeId: code!.id, tenantId: buyer.tenantId,
        purchaseKind: "credit_pack", purchaseRefId: `masked-${randomUUID()}`, grossPaise: 10000,
        netPaise: 10000, commissionBps: 1000, commissionPaise: 1000, state: "held",
        riskScore: 95, riskSignals: { sharedDomain: buyer.email },
      });
      actAs(owner.clerkUserId, owner.email);
      const result = await request(app).get("/api/promoter/commissions?state=held");
      expect(result.status).toBe(200);
      expect(result.body).toHaveLength(1);
      expect(result.body[0]).toMatchObject({ workspace: `Workspace #${buyer.tenantId}`, reason: "Under review" });
      expect(JSON.stringify(result.body)).not.toMatch(/riskScore|riskSignals|contactEmail/);
      expect(JSON.stringify(result.body)).not.toContain(buyer.email);
    } finally {
      await db.delete(creatorCommissionsTable).where(eq(creatorCommissionsTable.tenantId, buyer.tenantId));
      const [creator] = await db.select({ id: creatorAccountsTable.id }).from(creatorAccountsTable).where(eq(creatorAccountsTable.tenantId, owner.tenantId));
      if (creator) await db.delete(creatorCodesTable).where(eq(creatorCodesTable.creatorId, creator.id));
      await db.delete(creatorAccountsTable).where(eq(creatorAccountsTable.tenantId, owner.tenantId));
      await deleteTenant(buyer.tenantId);
      await deleteTenant(owner.tenantId);
    }
  });
  it("keeps unrelated admin routes reachable to regular tenants", async () => {
    const tenant = await createTenant({ email: `promoter-boundary-${randomUUID()}@example.com` });
    try {
      actAs(tenant.clerkUserId, tenant.email);
      expect((await request(app).get("/api/admin/promoter/metrics")).status).toBe(403);
      expect((await request(app).get("/api/admin/commissions/held")).status).toBe(403);
      expect((await request(app).get("/api/admin/other-module/health")).status).toBe(200);
    } finally { await deleteTenant(tenant.tenantId); }
  });
  it("refuses manual reversal of a paid commission", async () => {
    const admin = await createTenant({ email: `promoter-reversal-${randomUUID()}@example.com` });
    try {
      actAs(admin.clerkUserId, admin.email);
      await setTenantSuperadmin(admin.tenantId, true);
      const [creator] = await db.insert(creatorAccountsTable).values({
        tenantId: admin.tenantId, displayName: "Paid fixture", contactEmail: admin.email!, status: "approved",
      }).returning();
      const [code] = await db.insert(creatorCodesTable).values({
        creatorId: creator!.id, code: `KC-${randomUUID().slice(0, 8).toUpperCase()}`,
      }).returning();
      const [row] = await db.insert(creatorCommissionsTable).values({
        creatorId: creator!.id, creatorCodeId: code!.id, tenantId: admin.tenantId,
        purchaseKind: "credit_pack", purchaseRefId: `paid-${randomUUID()}`, grossPaise: 10000,
        netPaise: 10000, commissionBps: 1000, commissionPaise: 1000, state: "paid",
      }).returning();
      const result = await request(app).post(`/api/admin/commissions/${row!.id}/reverse`).send({ reason: "test" });
      expect(result.status).toBe(409);
      expect(result.body.code).toBe("already_paid");
      const [unchanged] = await db.select({ state: creatorCommissionsTable.state }).from(creatorCommissionsTable).where(eq(creatorCommissionsTable.id, row!.id));
      expect(unchanged?.state).toBe("paid");
    } finally {
      await db.delete(creatorCommissionsTable).where(eq(creatorCommissionsTable.tenantId, admin.tenantId));
      const [creator] = await db.select({ id: creatorAccountsTable.id }).from(creatorAccountsTable).where(eq(creatorAccountsTable.tenantId, admin.tenantId));
      if (creator) await db.delete(creatorCodesTable).where(eq(creatorCodesTable.creatorId, creator.id));
      await db.delete(creatorAccountsTable).where(eq(creatorAccountsTable.tenantId, admin.tenantId));
      await deleteTenant(admin.tenantId);
    }
  });
  it("feature-off blocks promoter pages and attachment but not admin settings or unrelated routes", async () => {
    const tenant = await createTenant({ email: `promoter-feature-${randomUUID()}@example.com` });
    const admin = await createTenant({ email: `promoter-feature-admin-${randomUUID()}@example.com` });
    try {
      featureTest.disabled = true;
      actAs(tenant.clerkUserId, tenant.email);
      for (const path of ["/api/promoter/me", "/api/promoter/commissions"]) {
        const response = await request(app).get(path);
        expect(response.status).toBe(403);
        expect(response.body.code).toBe("feature_disabled");
      }
      const apply = await request(app).post("/api/promoter/apply").send({ displayName: "Blocked", agreementAccepted: true });
      expect(apply.status).toBe(403);
      expect(apply.body.code).toBe("feature_disabled");
      const attach = await request(app).post("/api/credits/creator-code").send({ code: "KC-UNKNOWN" });
      expect(attach.status).toBe(403);
      expect(attach.body.code).toBe("feature_disabled");
      expect((await request(app).get("/api/admin/other-module/health")).status).toBe(200);
      actAs(admin.clerkUserId, admin.email);
      await setTenantSuperadmin(admin.tenantId, true);
      const settings = await request(app).get("/api/admin/promoter/settings");
      expect(settings.status).toBe(200);
      expect(settings.body.programEnabled).toBeDefined();
    } finally {
      featureTest.disabled = false;
      await deleteTenant(admin.tenantId);
      await deleteTenant(tenant.tenantId);
    }
  });
});