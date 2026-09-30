import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";

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

import { pool } from "@workspace/db";
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
beforeEach(() => resetAuthState());
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
});