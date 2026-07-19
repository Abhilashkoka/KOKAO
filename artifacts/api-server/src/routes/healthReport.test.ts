import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import express from "express";

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

import {
  pool,
  db,
  healthReportsTable,
  tenantMembersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireTenant } from "../middlewares/requireTenant";
import healthReportRouter from "./healthReport";
import { resetAuthState, actAs } from "../test/authState";
import {
  createTenant,
  deleteTenant,
  insertConnectedAccount,
  type TestTenant,
} from "../test/dbHelpers";
import { HEALTH_REPORT_HISTORY_LIMIT } from "@workspace/db";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, () => void> }).log = {
      info() {},
      error() {},
      warn() {},
      debug() {},
    };
    next();
  });
  app.use("/api", requireTenant, healthReportRouter);
  return app;
}

const app = buildApp();

const createdTenants: number[] = [];
const memberUserIds: string[] = [];

async function newTenant(): Promise<TestTenant> {
  const t = await createTenant();
  createdTenants.push(t.tenantId);
  return t;
}

async function addMember(tenantId: number, role: "admin" | "member") {
  const clerkUserId = `test_member_${Math.random().toString(36).slice(2)}`;
  await db.insert(tenantMembersTable).values({
    tenantId,
    clerkUserId,
    role,
  });
  memberUserIds.push(clerkUserId);
  return clerkUserId;
}

beforeEach(() => {
  resetAuthState();
});

afterAll(async () => {
  for (const id of memberUserIds) {
    await db
      .delete(tenantMembersTable)
      .where(eq(tenantMembersTable.clerkUserId, id));
  }
  for (const tenantId of createdTenants) {
    await db
      .delete(healthReportsTable)
      .where(eq(healthReportsTable.tenantId, tenantId));
    await deleteTenant(tenantId);
  }
  await pool.end();
});

describe("health report routes", () => {
  it("returns an empty overview before any audit has run", async () => {
    const t = await newTenant();
    actAs(t.clerkUserId);
    const res = await request(app).get("/api/health-report");
    expect(res.status).toBe(200);
    expect(res.body.latest).toBeNull();
    expect(res.body.history).toEqual([]);
  });

  it("runs an audit and returns a scored report with history", async () => {
    const t = await newTenant();
    actAs(t.clerkUserId);
    const res = await request(app).post("/api/health-report/run");
    expect(res.status).toBe(200);
    const { latest, history } = res.body;
    expect(latest).not.toBeNull();
    expect(latest.coverage).toBeGreaterThanOrEqual(0);
    expect(latest.coverage).toBeLessThanOrEqual(100);
    expect(["graded", "provisional", "insufficient"]).toContain(
      latest.coverageGrade,
    );
    expect(Array.isArray(latest.checks)).toBe(true);
    expect(latest.checks.length).toBeGreaterThan(0);
    expect(Array.isArray(latest.categories)).toBe(true);
    expect(history.length).toBe(1);
    expect(history[0].id).toBe(latest.id);

    // A follow-up GET returns the stored report.
    const res2 = await request(app).get("/api/health-report");
    expect(res2.status).toBe(200);
    expect(res2.body.latest.id).toBe(latest.id);
  });

  it("rejects plain team members with 403", async () => {
    const t = await newTenant();
    const memberId = await addMember(t.tenantId, "member");
    actAs(memberId);
    const getRes = await request(app).get("/api/health-report");
    expect(getRes.status).toBe(403);
    const runRes = await request(app).post("/api/health-report/run");
    expect(runRes.status).toBe(403);
  });

  it("allows workspace admins", async () => {
    const t = await newTenant();
    const adminId = await addMember(t.tenantId, "admin");
    actAs(adminId);
    const res = await request(app).get("/api/health-report");
    expect(res.status).toBe(200);
  });

  it("scopes reports per tenant", async () => {
    const a = await newTenant();
    const b = await newTenant();
    actAs(a.clerkUserId);
    const runRes = await request(app).post("/api/health-report/run");
    expect(runRes.status).toBe(200);

    actAs(b.clerkUserId);
    const res = await request(app).get("/api/health-report");
    expect(res.status).toBe(200);
    expect(res.body.latest).toBeNull();
  });

  it("treats verified connections as passing, not unknown", async () => {
    const t = await newTenant();
    await insertConnectedAccount(
      t.tenantId,
      "facebook",
      { pageAccessToken: "tok", pageId: "1" },
      "verified",
    );
    actAs(t.clerkUserId);
    const res = await request(app).post("/api/health-report/run");
    expect(res.status).toBe(200);
    const finding = res.body.latest.checks.find(
      (c: { id: string }) => c.id === "connections_verified",
    );
    expect(finding).toBeDefined();
    expect(finding.status).toBe("pass");
  });

  it("caps stored history at the limit", async () => {
    const t = await newTenant();
    // Seed more than the limit directly, then run once — the run must trim.
    const base = Date.now() - 1000 * 60 * 60;
    for (let i = 0; i < HEALTH_REPORT_HISTORY_LIMIT + 3; i++) {
      await db.insert(healthReportsTable).values({
        tenantId: t.tenantId,
        score: 50,
        coverage: 80,
        coverageGrade: "graded",
        report: { version: 1, checks: [], categories: [] },
        createdAt: new Date(base + i * 1000),
      });
    }
    actAs(t.clerkUserId);
    const res = await request(app).post("/api/health-report/run");
    expect(res.status).toBe(200);
    const rows = await db
      .select()
      .from(healthReportsTable)
      .where(eq(healthReportsTable.tenantId, t.tenantId));
    expect(rows.length).toBeLessThanOrEqual(HEALTH_REPORT_HISTORY_LIMIT);
    expect(res.body.history.length).toBeLessThanOrEqual(
      HEALTH_REPORT_HISTORY_LIMIT,
    );
  });
});
