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

// The on-demand sweep endpoint delegates to the real sweep, which would hit
// live provider APIs for any connected accounts in the dev DB. Stub the
// trigger: this file tests the route's auth gating + response shape, while
// the sweep logic itself is covered by connectionSweep.test.ts.
vi.mock("../lib/connectionSweep", () => ({
  triggerSweepNow: vi.fn(() => true),
  isSweepRunning: vi.fn(() => false),
  // /admin/stats fires this watchdog check fire-and-forget; stub it so the
  // stats route never touches the real sweep-status/notification paths here.
  checkSweepStaleness: vi.fn(async () => undefined),
}));

import { pool } from "@workspace/db";
import { triggerSweepNow } from "../lib/connectionSweep";
import { createAdminTestApp } from "../test/testApp";
import { resetAuthState, actAs } from "../test/authState";
import {
  createTenant,
  deleteTenant,
  getTenant,
  getAuditLogsForTarget,
  getAuditLogsForActor,
  snapshotNotificationPolicy,
  setNotificationPolicy,
  clearNotificationPolicy,
  restoreNotificationPolicy,
  setTenantSuperadmin,
  getPlanSettingsRow,
  snapshotAppBrand,
  restoreAppBrand,
  getAppBrandRow,
} from "../test/dbHelpers";

// This is baked into the permanent allowlist in lib/superadmins.ts, so an actor
// whose LIVE verified email matches it is an "owner". Using the built-in email
// keeps the test independent of env-var load-order timing.
const OWNER_EMAIL = "abhilash.koka1@gmail.com";

const app = createAdminTestApp();

afterAll(async () => {
  await pool.end();
});

beforeEach(() => {
  resetAuthState();
});

describe("PATCH /admin/tenants/:id/superadmin — role management is owner-only", () => {
  it("rejects a merely-granted (non-owner) superadmin with 403 and leaves the DB flag unchanged", async () => {
    // Actor is a granted-in-app superadmin (DB flag set) but NOT allowlisted.
    const actor = await createTenant({
      isSuperadmin: true,
      email: `granted-${randomUUID()}@example.com`,
    });
    const target = await createTenant({
      email: `target-${randomUUID()}@example.com`,
    });
    try {
      actAs(actor.clerkUserId, actor.email);

      const res = await request(app)
        .patch(`/api/admin/tenants/${target.tenantId}/superadmin`)
        .send({ isSuperadmin: true });

      // Passes the requireSuperadmin gate (granted flag) but the handler
      // re-checks the live verified email and rejects a non-owner actor.
      expect(res.status).toBe(403);

      // The target must not have been promoted.
      const after = await getTenant(target.tenantId);
      expect(after.isSuperadmin).toBe(false);
    } finally {
      await deleteTenant(actor.tenantId);
      await deleteTenant(target.tenantId);
    }
  });

  it("lets an allowlisted owner GRANT the superadmin role (200, DB flag set)", async () => {
    const owner = await createTenant({ email: OWNER_EMAIL });
    const target = await createTenant({
      email: `target-${randomUUID()}@example.com`,
    });
    try {
      actAs(owner.clerkUserId, OWNER_EMAIL);

      const res = await request(app)
        .patch(`/api/admin/tenants/${target.tenantId}/superadmin`)
        .send({ isSuperadmin: true });

      expect(res.status).toBe(200);
      expect(res.body.isSuperadmin).toBe(true);

      const after = await getTenant(target.tenantId);
      expect(after.isSuperadmin).toBe(true);
    } finally {
      await deleteTenant(owner.tenantId);
      await deleteTenant(target.tenantId);
    }
  });

  it("lets an allowlisted owner REVOKE the role, and the revoke takes effect immediately (DB flag read fresh)", async () => {
    const owner = await createTenant({ email: OWNER_EMAIL });
    // Target starts as a granted-in-app superadmin with a non-allowlisted email.
    const target = await createTenant({
      isSuperadmin: true,
      email: `granted-${randomUUID()}@example.com`,
    });
    try {
      // Before revoke: the granted target can reach an admin endpoint because
      // requireSuperadmin trusts the fresh DB flag loaded by requireTenant.
      actAs(target.clerkUserId, target.email);
      const beforeAccess = await request(app).get("/api/admin/tenants");
      expect(beforeAccess.status).toBe(200);

      // Owner revokes the target's role.
      actAs(owner.clerkUserId, OWNER_EMAIL);
      const revoke = await request(app)
        .patch(`/api/admin/tenants/${target.tenantId}/superadmin`)
        .send({ isSuperadmin: false });
      expect(revoke.status).toBe(200);
      expect(revoke.body.isSuperadmin).toBe(false);

      const after = await getTenant(target.tenantId);
      expect(after.isSuperadmin).toBe(false);

      // Immediately after: the same target is now locked out (the DB flag is
      // re-read fresh every request, so there is no stale-grant window).
      actAs(target.clerkUserId, target.email);
      const afterAccess = await request(app).get("/api/admin/tenants");
      expect(afterAccess.status).toBe(403);
    } finally {
      await deleteTenant(owner.tenantId);
      await deleteTenant(target.tenantId);
    }
  });

  it("rejects a write whose TARGET is an allowlisted owner (400, permanent), leaving the flag untouched", async () => {
    const owner = await createTenant({ email: OWNER_EMAIL });
    // A second allowlisted tenant is the target; owners are permanent and must
    // not be demoted via this endpoint (email is not unique in the schema).
    const targetOwner = await createTenant({
      isSuperadmin: false,
      email: OWNER_EMAIL,
    });
    try {
      actAs(owner.clerkUserId, OWNER_EMAIL);

      const res = await request(app)
        .patch(`/api/admin/tenants/${targetOwner.tenantId}/superadmin`)
        .send({ isSuperadmin: true });

      expect(res.status).toBe(400);

      // The DB flag was not toggled by the rejected write.
      const after = await getTenant(targetOwner.tenantId);
      expect(after.isSuperadmin).toBe(false);
    } finally {
      await deleteTenant(owner.tenantId);
      await deleteTenant(targetOwner.tenantId);
    }
  });

  it("returns 401 to an unauthenticated caller", async () => {
    const target = await createTenant({
      email: `target-${randomUUID()}@example.com`,
    });
    try {
      resetAuthState(); // no current user

      const res = await request(app)
        .patch(`/api/admin/tenants/${target.tenantId}/superadmin`)
        .send({ isSuperadmin: true });

      expect(res.status).toBe(401);
    } finally {
      await deleteTenant(target.tenantId);
    }
  });

  it("returns 403 to an authenticated non-superadmin (fails closed on the whole /admin surface)", async () => {
    const actor = await createTenant({
      email: `plain-${randomUUID()}@example.com`,
    });
    const target = await createTenant({
      email: `target-${randomUUID()}@example.com`,
    });
    try {
      actAs(actor.clerkUserId, actor.email);

      const res = await request(app)
        .patch(`/api/admin/tenants/${target.tenantId}/superadmin`)
        .send({ isSuperadmin: true });

      expect(res.status).toBe(403);

      const after = await getTenant(target.tenantId);
      expect(after.isSuperadmin).toBe(false);
    } finally {
      await deleteTenant(actor.tenantId);
      await deleteTenant(target.tenantId);
    }
  });
});

describe("GET /admin/tenants — cross-tenant list stays admin-only", () => {
  it("returns 401 to an unauthenticated caller", async () => {
    resetAuthState();
    const res = await request(app).get("/api/admin/tenants");
    expect(res.status).toBe(401);
  });

  it("returns 403 to an authenticated non-superadmin (no tenant data leaks)", async () => {
    const actor = await createTenant({
      email: `plain-${randomUUID()}@example.com`,
    });
    try {
      actAs(actor.clerkUserId, actor.email);
      const res = await request(app).get("/api/admin/tenants");
      expect(res.status).toBe(403);
      expect(Array.isArray(res.body)).toBe(false);
    } finally {
      await deleteTenant(actor.tenantId);
    }
  });

  it("lets a granted (DB-flag) superadmin read the full tenant list", async () => {
    const actor = await createTenant({
      isSuperadmin: true,
      email: `granted-${randomUUID()}@example.com`,
    });
    const other = await createTenant({
      email: `other-${randomUUID()}@example.com`,
    });
    try {
      actAs(actor.clerkUserId, actor.email);
      const res = await request(app).get("/api/admin/tenants");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);

      // The list is cross-tenant: it includes tenants other than the actor.
      const ids = (res.body as Array<{ id: number }>).map((t) => t.id);
      expect(ids).toContain(actor.tenantId);
      expect(ids).toContain(other.tenantId);

      // Each row carries the admin-only counts/usage shape.
      const row = (res.body as Array<{ id: number }>).find(
        (t) => t.id === other.tenantId,
      ) as Record<string, unknown> | undefined;
      expect(row).toBeDefined();
      expect(row).toHaveProperty("counts");
      expect(row).toHaveProperty("usage");
    } finally {
      await deleteTenant(actor.tenantId);
      await deleteTenant(other.tenantId);
    }
  });

  it("lets an allowlisted owner read the tenant list", async () => {
    const owner = await createTenant({ email: OWNER_EMAIL });
    try {
      actAs(owner.clerkUserId, OWNER_EMAIL);
      const res = await request(app).get("/api/admin/tenants");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    } finally {
      await deleteTenant(owner.tenantId);
    }
  });
});

describe("GET /admin/stats — platform stats stay admin-only", () => {
  it("returns 401 to an unauthenticated caller", async () => {
    resetAuthState();
    const res = await request(app).get("/api/admin/stats");
    expect(res.status).toBe(401);
  });

  it("returns 403 to an authenticated non-superadmin", async () => {
    const actor = await createTenant({
      email: `plain-${randomUUID()}@example.com`,
    });
    try {
      actAs(actor.clerkUserId, actor.email);
      const res = await request(app).get("/api/admin/stats");
      expect(res.status).toBe(403);
    } finally {
      await deleteTenant(actor.tenantId);
    }
  });

  it("lets a granted (DB-flag) superadmin read platform stats", async () => {
    const actor = await createTenant({
      isSuperadmin: true,
      email: `granted-${randomUUID()}@example.com`,
    });
    try {
      actAs(actor.clerkUserId, actor.email);
      const res = await request(app).get("/api/admin/stats");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("totalTenants");
      expect(res.body).toHaveProperty("tenantsByPlan");
      expect(res.body.tenantsByPlan).toHaveProperty("free");
      expect(res.body.tenantsByPlan).toHaveProperty("pro");
      expect(res.body.tenantsByPlan).toHaveProperty("business");
    } finally {
      await deleteTenant(actor.tenantId);
    }
  });

  it("surfaces the sweep's recent failed checks with resolved tenant names", async () => {
    const { db, sweepStatusTable, tenantsTable } = await import(
      "@workspace/db"
    );
    const { eq } = await import("drizzle-orm");
    const actor = await createTenant({
      isSuperadmin: true,
      email: `granted-${randomUUID()}@example.com`,
    });
    try {
      const [tenantRow] = await db
        .select({ name: tenantsTable.name })
        .from(tenantsTable)
        .where(eq(tenantsTable.id, actor.tenantId));
      const failures = [
        {
          tenantId: actor.tenantId,
          platform: "facebook",
          error: "Re-verify for facebook exceeded 30s and was abandoned",
          at: "2026-07-16T10:00:00.000Z",
          consecutiveFailures: 6,
          firstFailedAt: "2026-07-16T08:45:00.000Z",
        },
        {
          tenantId: 999999999, // deleted tenant — name resolves to null
          platform: "linkedin",
          error: "boom",
          at: "2026-07-16T09:59:00.000Z",
        },
      ];
      const values = {
        lastRunAt: new Date("2026-07-16T10:00:05Z"),
        durationMs: 5000,
        accountsChecked: 4,
        errorCount: 2,
        lastError: failures[0].error,
        recentFailures: failures,
      };
      await db
        .insert(sweepStatusTable)
        .values({ id: 1, ...values })
        .onConflictDoUpdate({ target: sweepStatusTable.id, set: values });

      actAs(actor.clerkUserId, actor.email);
      const res = await request(app).get("/api/admin/stats");
      expect(res.status).toBe(200);
      expect(res.body.connectionSweep.recentFailures).toEqual([
        {
          tenantId: actor.tenantId,
          tenantName: tenantRow!.name,
          platform: "facebook",
          error: failures[0].error,
          at: failures[0].at,
          // Streak count is passed through so the UI can flag repeat offenders.
          consecutiveFailures: 6,
          // Streak start is passed through so the UI can show "failing for".
          firstFailedAt: "2026-07-16T08:45:00.000Z",
        },
        {
          tenantId: 999999999,
          tenantName: null,
          platform: "linkedin",
          error: "boom",
          at: failures[1].at,
          // Rows persisted before streak tracking default to a streak of 1.
          consecutiveFailures: 1,
          // Legacy rows without firstFailedAt fall back to the failure time.
          firstFailedAt: failures[1].at,
        },
      ]);
    } finally {
      await deleteTenant(actor.tenantId);
    }
  });
});

describe("POST /admin/sweep/run — on-demand sweep stays admin-only", () => {
  it("returns 401 to an unauthenticated caller", async () => {
    resetAuthState();
    const res = await request(app).post("/api/admin/sweep/run");
    expect(res.status).toBe(401);
  });

  it("returns 403 to an authenticated non-superadmin", async () => {
    const actor = await createTenant({
      email: `plain-${randomUUID()}@example.com`,
    });
    try {
      actAs(actor.clerkUserId, actor.email);
      const res = await request(app).post("/api/admin/sweep/run");
      expect(res.status).toBe(403);
    } finally {
      await deleteTenant(actor.tenantId);
    }
  });

  it("lets a superadmin trigger a sweep and reports whether it started", async () => {
    const actor = await createTenant({
      isSuperadmin: true,
      email: `granted-${randomUUID()}@example.com`,
    });
    try {
      actAs(actor.clerkUserId, actor.email);
      const res = await request(app).post("/api/admin/sweep/run");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ started: true });

      // The manual trigger is audited: actor recorded, no target, outcome in
      // newValue — best-effort like the other privileged actions.
      const logs = await getAuditLogsForActor(actor.tenantId);
      const sweepLogs = logs.filter((l) => l.action === "sweep_run");
      expect(sweepLogs).toHaveLength(1);
      expect(sweepLogs[0].actorEmail).toBe(actor.email);
      expect(sweepLogs[0].targetTenantId).toBeNull();
      expect(JSON.parse(sweepLogs[0].newValue ?? "")).toEqual({
        started: true,
      });
    } finally {
      await deleteTenant(actor.tenantId);
    }
  });

  it("locks a revoked superadmin out on the very next request, with NO sweep triggered", async () => {
    const actor = await createTenant({
      email: `revoked-${randomUUID()}@example.com`,
    });
    try {
      actAs(actor.clerkUserId, actor.email);
      vi.mocked(triggerSweepNow).mockClear();

      // Not yet a superadmin: denied, sweep untouched.
      const before = await request(app).post("/api/admin/sweep/run");
      expect(before.status).toBe(403);
      expect(vi.mocked(triggerSweepNow)).not.toHaveBeenCalled();

      // Grant the DB flag; the very next request can trigger a sweep.
      await setTenantSuperadmin(actor.tenantId, true);
      const granted = await request(app).post("/api/admin/sweep/run");
      expect(granted.status).toBe(200);
      expect(vi.mocked(triggerSweepNow)).toHaveBeenCalledTimes(1);

      // Revoke: the gate reads the flag fresh each request, so the very next
      // request is rejected AND the sweep is never invoked (no side effect).
      await setTenantSuperadmin(actor.tenantId, false);
      const revoked = await request(app).post("/api/admin/sweep/run");
      expect(revoked.status).toBe(403);
      expect(vi.mocked(triggerSweepNow)).toHaveBeenCalledTimes(1);
    } finally {
      await deleteTenant(actor.tenantId);
    }
  });
});

describe("PATCH /admin/tenants/:id — plan override stays admin-only", () => {
  it("returns 401 to an unauthenticated caller and does not change the plan", async () => {
    const target = await createTenant({
      email: `target-${randomUUID()}@example.com`,
    });
    try {
      resetAuthState();
      const res = await request(app)
        .patch(`/api/admin/tenants/${target.tenantId}`)
        .send({ plan: "pro" });
      expect(res.status).toBe(401);

      const after = await getTenant(target.tenantId);
      expect(after.plan).toBe("free");
    } finally {
      await deleteTenant(target.tenantId);
    }
  });

  it("returns 403 to an authenticated non-superadmin and does not change the plan", async () => {
    const actor = await createTenant({
      email: `plain-${randomUUID()}@example.com`,
    });
    const target = await createTenant({
      email: `target-${randomUUID()}@example.com`,
    });
    try {
      actAs(actor.clerkUserId, actor.email);
      const res = await request(app)
        .patch(`/api/admin/tenants/${target.tenantId}`)
        .send({ plan: "business" });
      expect(res.status).toBe(403);

      const after = await getTenant(target.tenantId);
      expect(after.plan).toBe("free");
    } finally {
      await deleteTenant(actor.tenantId);
      await deleteTenant(target.tenantId);
    }
  });

  it("lets a granted (DB-flag) superadmin override a tenant's plan (200, DB persisted)", async () => {
    const actor = await createTenant({
      isSuperadmin: true,
      email: `granted-${randomUUID()}@example.com`,
    });
    const target = await createTenant({
      email: `target-${randomUUID()}@example.com`,
    });
    try {
      actAs(actor.clerkUserId, actor.email);
      const res = await request(app)
        .patch(`/api/admin/tenants/${target.tenantId}`)
        .send({ plan: "business" });
      expect(res.status).toBe(200);
      expect(res.body.plan).toBe("business");

      const after = await getTenant(target.tenantId);
      expect(after.plan).toBe("business");
    } finally {
      await deleteTenant(actor.tenantId);
      await deleteTenant(target.tenantId);
    }
  });

  it("rejects an invalid plan with 400 and does not write", async () => {
    const actor = await createTenant({
      isSuperadmin: true,
      email: `granted-${randomUUID()}@example.com`,
    });
    const target = await createTenant({
      email: `target-${randomUUID()}@example.com`,
    });
    try {
      actAs(actor.clerkUserId, actor.email);
      const res = await request(app)
        .patch(`/api/admin/tenants/${target.tenantId}`)
        .send({ plan: "enterprise" });
      expect(res.status).toBe(400);

      const after = await getTenant(target.tenantId);
      expect(after.plan).toBe("free");
    } finally {
      await deleteTenant(actor.tenantId);
      await deleteTenant(target.tenantId);
    }
  });

  it("returns 404 for a non-existent tenant id", async () => {
    const actor = await createTenant({
      isSuperadmin: true,
      email: `granted-${randomUUID()}@example.com`,
    });
    try {
      actAs(actor.clerkUserId, actor.email);
      // A valid-looking but almost-certainly-unused id.
      const res = await request(app)
        .patch(`/api/admin/tenants/2000000000`)
        .send({ plan: "pro" });
      expect(res.status).toBe(404);
    } finally {
      await deleteTenant(actor.tenantId);
    }
  });
});

describe("Audit trail — privileged actions are recorded", () => {
  it("records a plan_change with actor, target, old and new value", async () => {
    const actor = await createTenant({
      isSuperadmin: true,
      email: `granted-${randomUUID()}@example.com`,
    });
    const target = await createTenant({
      email: `target-${randomUUID()}@example.com`,
    });
    try {
      actAs(actor.clerkUserId, actor.email);
      const res = await request(app)
        .patch(`/api/admin/tenants/${target.tenantId}`)
        .send({ plan: "business" });
      expect(res.status).toBe(200);

      const logs = await getAuditLogsForTarget(target.tenantId);
      expect(logs).toHaveLength(1);
      const log = logs[0];
      expect(log.action).toBe("plan_change");
      expect(log.actorTenantId).toBe(actor.tenantId);
      expect(log.actorEmail).toBe(actor.email);
      expect(log.targetTenantId).toBe(target.tenantId);
      expect(log.targetEmail).toBe(target.email);
      expect(log.oldValue).toBe("free");
      expect(log.newValue).toBe("business");
    } finally {
      await deleteTenant(actor.tenantId);
      await deleteTenant(target.tenantId);
    }
  });

  it("does not record a plan_change when the plan is unchanged", async () => {
    const actor = await createTenant({
      isSuperadmin: true,
      email: `granted-${randomUUID()}@example.com`,
    });
    const target = await createTenant({
      email: `target-${randomUUID()}@example.com`,
    });
    try {
      actAs(actor.clerkUserId, actor.email);
      // Target already on "free"; setting it to "free" again is a no-op change.
      const res = await request(app)
        .patch(`/api/admin/tenants/${target.tenantId}`)
        .send({ plan: "free" });
      expect(res.status).toBe(200);

      const logs = await getAuditLogsForTarget(target.tenantId);
      expect(logs).toHaveLength(0);
    } finally {
      await deleteTenant(actor.tenantId);
      await deleteTenant(target.tenantId);
    }
  });

  it("records a superadmin_grant then a superadmin_revoke (append-only)", async () => {
    const owner = await createTenant({ email: OWNER_EMAIL });
    const target = await createTenant({
      email: `target-${randomUUID()}@example.com`,
    });
    try {
      actAs(owner.clerkUserId, OWNER_EMAIL);

      const grant = await request(app)
        .patch(`/api/admin/tenants/${target.tenantId}/superadmin`)
        .send({ isSuperadmin: true });
      expect(grant.status).toBe(200);

      const revoke = await request(app)
        .patch(`/api/admin/tenants/${target.tenantId}/superadmin`)
        .send({ isSuperadmin: false });
      expect(revoke.status).toBe(200);

      const logs = await getAuditLogsForTarget(target.tenantId);
      // Both actions are appended; the first row is never mutated in place.
      expect(logs).toHaveLength(2);
      const actions = logs.map((l) => l.action).sort();
      expect(actions).toEqual(["superadmin_grant", "superadmin_revoke"]);

      const grantLog = logs.find((l) => l.action === "superadmin_grant")!;
      expect(grantLog.actorTenantId).toBe(owner.tenantId);
      expect(grantLog.targetTenantId).toBe(target.tenantId);
      expect(grantLog.oldValue).toBe("false");
      expect(grantLog.newValue).toBe("true");

      const revokeLog = logs.find((l) => l.action === "superadmin_revoke")!;
      expect(revokeLog.oldValue).toBe("true");
      expect(revokeLog.newValue).toBe("false");
    } finally {
      await deleteTenant(owner.tenantId);
      await deleteTenant(target.tenantId);
    }
  });

  it("exposes the audit trail via GET /admin/audit-logs to a superadmin", async () => {
    const actor = await createTenant({
      isSuperadmin: true,
      email: `granted-${randomUUID()}@example.com`,
    });
    const target = await createTenant({
      email: `target-${randomUUID()}@example.com`,
    });
    try {
      actAs(actor.clerkUserId, actor.email);
      await request(app)
        .patch(`/api/admin/tenants/${target.tenantId}`)
        .send({ plan: "pro" });

      const res = await request(app).get("/api/admin/audit-logs");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.items)).toBe(true);
      expect(typeof res.body.total).toBe("number");
      expect(res.body.limit).toBe(50);
      expect(res.body.offset).toBe(0);

      const entry = (res.body.items as Array<Record<string, unknown>>).find(
        (r) => r.targetTenantId === target.tenantId,
      );
      expect(entry).toBeDefined();
      expect(entry).toMatchObject({
        action: "plan_change",
        actorTenantId: actor.tenantId,
        oldValue: "free",
        newValue: "pro",
      });
      expect(entry).toHaveProperty("createdAt");
    } finally {
      await deleteTenant(actor.tenantId);
      await deleteTenant(target.tenantId);
    }
  });

  it("audits a global notification-policy change (actor, old vs new values) and skips no-op saves", async () => {
    const actor = await createTenant({
      isSuperadmin: true,
      email: `granted-${randomUUID()}@example.com`,
    });
    const snapshot = await snapshotNotificationPolicy(
      "social_connection_failed",
    );
    try {
      actAs(actor.clerkUserId, actor.email);
      // Known starting point.
      await setNotificationPolicy("social_connection_failed", {
        enabled: true,
        emailPolicy: "optional",
      });

      // Real change: disable the type and force email off.
      const res = await request(app)
        .put("/api/admin/notification-policies")
        .send({
          policies: [
            {
              type: "social_connection_failed",
              enabled: false,
              emailPolicy: "off",
            },
          ],
        });
      expect(res.status).toBe(200);

      // Exactly ONE audit row total for this actor — nothing else may be
      // written as a side effect of the policy save.
      let logs = await getAuditLogsForActor(actor.tenantId);
      expect(logs).toHaveLength(1);
      expect(logs[0].action).toBe("notification_policy_change");
      expect(logs[0].actorTenantId).toBe(actor.tenantId);
      expect(logs[0].actorEmail).toBe(actor.email);
      expect(logs[0].targetTenantId).toBeNull();
      expect(logs[0].targetEmail).toBeNull();
      // Exact payloads — no extra or missing keys.
      expect(JSON.parse(logs[0].oldValue!)).toEqual({
        type: "social_connection_failed",
        enabled: true,
        emailPolicy: "optional",
      });
      expect(JSON.parse(logs[0].newValue!)).toEqual({
        type: "social_connection_failed",
        enabled: false,
        emailPolicy: "off",
      });

      // No-op save: identical values must not add another audit row.
      const noop = await request(app)
        .put("/api/admin/notification-policies")
        .send({
          policies: [
            {
              type: "social_connection_failed",
              enabled: false,
              emailPolicy: "off",
            },
          ],
        });
      expect(noop.status).toBe(200);

      logs = await getAuditLogsForActor(actor.tenantId);
      expect(logs).toHaveLength(1);
    } finally {
      await restoreNotificationPolicy("social_connection_failed", snapshot);
      await deleteTenant(actor.tenantId);
    }
  });

  it("supports filtering and pagination on GET /admin/audit-logs", async () => {
    const actor = await createTenant({
      isSuperadmin: true,
      email: `granted-${randomUUID()}@example.com`,
    });
    const target = await createTenant({
      email: `target-${randomUUID()}@example.com`,
    });
    try {
      actAs(actor.clerkUserId, actor.email);
      await request(app)
        .patch(`/api/admin/tenants/${target.tenantId}`)
        .send({ plan: "pro" });
      await request(app)
        .patch(`/api/admin/tenants/${target.tenantId}`)
        .send({ plan: "business" });

      // Filter by action + target
      const filtered = await request(app).get(
        `/api/admin/audit-logs?action=plan_change&target=${target.tenantId}`,
      );
      expect(filtered.status).toBe(200);
      expect(filtered.body.total).toBe(2);
      expect(
        (filtered.body.items as Array<Record<string, unknown>>).every(
          (r) =>
            r.action === "plan_change" && r.targetTenantId === target.tenantId,
        ),
      ).toBe(true);

      // Filter by actor email substring
      const byActor = await request(app).get(
        `/api/admin/audit-logs?actor=${encodeURIComponent(actor.email ?? "")}`,
      );
      expect(byActor.status).toBe(200);
      expect(byActor.body.total).toBeGreaterThanOrEqual(2);
      expect(
        (byActor.body.items as Array<Record<string, unknown>>).every(
          (r) => r.actorTenantId === actor.tenantId,
        ),
      ).toBe(true);

      // Pagination: limit 1 pages through both records, newest first
      const page1 = await request(app).get(
        `/api/admin/audit-logs?target=${target.tenantId}&limit=1&offset=0`,
      );
      const page2 = await request(app).get(
        `/api/admin/audit-logs?target=${target.tenantId}&limit=1&offset=1`,
      );
      expect(page1.body.items).toHaveLength(1);
      expect(page2.body.items).toHaveLength(1);
      expect(page1.body.items[0].id).not.toBe(page2.body.items[0].id);
      expect(page1.body.items[0].newValue).toBe("business");
      expect(page2.body.items[0].newValue).toBe("pro");

      // Date range excluding everything
      const none = await request(app).get(
        "/api/admin/audit-logs?to=2000-01-01T00:00:00.000Z",
      );
      expect(none.body.total).toBe(0);

      // Invalid inputs are rejected
      const badAction = await request(app).get(
        "/api/admin/audit-logs?action=bogus",
      );
      expect(badAction.status).toBe(400);
      const badDate = await request(app).get(
        "/api/admin/audit-logs?from=not-a-date",
      );
      expect(badDate.status).toBe(400);
    } finally {
      await deleteTenant(actor.tenantId);
      await deleteTenant(target.tenantId);
    }
  });

  it("exports filtered audit records as CSV via GET /admin/audit-logs/export", async () => {
    const actor = await createTenant({
      isSuperadmin: true,
      email: `granted-${randomUUID()}@example.com`,
    });
    const target = await createTenant({
      email: `target-${randomUUID()}@example.com`,
    });
    try {
      actAs(actor.clerkUserId, actor.email);
      await request(app)
        .patch(`/api/admin/tenants/${target.tenantId}`)
        .send({ plan: "pro" });
      await request(app)
        .patch(`/api/admin/tenants/${target.tenantId}`)
        .send({ plan: "business" });

      const res = await request(app).get(
        `/api/admin/audit-logs/export?action=plan_change&target=${target.tenantId}`,
      );
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/csv");
      expect(res.headers["content-disposition"]).toContain("attachment");
      expect(res.headers["content-disposition"]).toContain(".csv");

      const lines = res.text.trim().split(/\r\n/);
      expect(lines[0]).toBe(
        "id,createdAt,action,actorTenantId,actorEmail,targetTenantId,targetEmail,oldValue,newValue",
      );
      // Both plan changes are exported (not just one page), newest first.
      expect(lines).toHaveLength(3);
      expect(lines[1]).toContain("plan_change");
      expect(lines[1]).toContain("business");
      expect(lines[2]).toContain("pro");
      expect(lines[1]).toContain(String(target.tenantId));

      // Filters that match nothing yield only the header.
      const empty = await request(app).get(
        "/api/admin/audit-logs/export?to=2000-01-01T00:00:00.000Z",
      );
      expect(empty.status).toBe(200);
      expect(empty.text.trim().split(/\r\n/)).toHaveLength(1);

      // Invalid filters are rejected the same as the list endpoint.
      const bad = await request(app).get(
        "/api/admin/audit-logs/export?action=bogus",
      );
      expect(bad.status).toBe(400);
    } finally {
      await deleteTenant(actor.tenantId);
      await deleteTenant(target.tenantId);
    }
  });

  it("validates the export preflight via HEAD /admin/audit-logs/export", async () => {
    const actor = await createTenant({
      isSuperadmin: true,
      email: `granted-${randomUUID()}@example.com`,
    });
    const outsider = await createTenant({
      email: `outsider-${randomUUID()}@example.com`,
    });
    try {
      actAs(actor.clerkUserId, actor.email);

      // Valid filters: 204 with no body.
      const ok = await request(app).head("/api/admin/audit-logs/export");
      expect(ok.status).toBe(204);

      // Invalid filters are rejected just like the GET.
      const bad = await request(app).head(
        "/api/admin/audit-logs/export?action=bogus",
      );
      expect(bad.status).toBe(400);

      // Non-superadmins are rejected by the /admin gate.
      actAs(outsider.clerkUserId, outsider.email);
      const denied = await request(app).head("/api/admin/audit-logs/export");
      expect(denied.status).toBe(403);
    } finally {
      await deleteTenant(actor.tenantId);
      await deleteTenant(outsider.tenantId);
    }
  });

  it("neutralizes spreadsheet formula injection in exported CSV cells", async () => {
    const actor = await createTenant({
      isSuperadmin: true,
      email: `granted-${randomUUID()}@example.com`,
    });
    // A hostile email that a spreadsheet would interpret as a formula.
    const target = await createTenant({
      email: `=HYPERLINK("https://evil.example/${randomUUID()}")`,
    });
    try {
      actAs(actor.clerkUserId, actor.email);
      await request(app)
        .patch(`/api/admin/tenants/${target.tenantId}`)
        .send({ plan: "pro" });

      const res = await request(app).get(
        `/api/admin/audit-logs/export?target=${target.tenantId}`,
      );
      expect(res.status).toBe(200);
      // The raw formula must never appear at the start of a cell; it must be
      // prefixed with a single quote (inside the quoted CSV cell).
      expect(res.text).not.toContain(`,"=HYPERLINK`);
      expect(res.text).toContain(`"'=HYPERLINK`);
    } finally {
      await deleteTenant(actor.tenantId);
      await deleteTenant(target.tenantId);
    }
  });

  it("returns 403 to a non-superadmin for GET /admin/audit-logs/export", async () => {
    const actor = await createTenant({
      email: `plain-${randomUUID()}@example.com`,
    });
    try {
      actAs(actor.clerkUserId, actor.email);
      const forbidden = await request(app).get(
        "/api/admin/audit-logs/export",
      );
      expect(forbidden.status).toBe(403);
    } finally {
      await deleteTenant(actor.tenantId);
    }
  });

  it("returns 403 to a non-superadmin and 401 to an unauthenticated caller for GET /admin/audit-logs", async () => {
    const actor = await createTenant({
      email: `plain-${randomUUID()}@example.com`,
    });
    try {
      actAs(actor.clerkUserId, actor.email);
      const forbidden = await request(app).get("/api/admin/audit-logs");
      expect(forbidden.status).toBe(403);

      resetAuthState();
      const unauth = await request(app).get("/api/admin/audit-logs");
      expect(unauth.status).toBe(401);
    } finally {
      await deleteTenant(actor.tenantId);
    }
  });
});

describe("GET/PUT /admin/notification-policies — global notification policy", () => {
  const TYPE = "social_connection_failed";

  it("GET returns the built-in defaults for every catalog type when no row is stored", async () => {
    const snapshot = await snapshotNotificationPolicy(TYPE);
    const actor = await createTenant({
      isSuperadmin: true,
      email: `granted-${randomUUID()}@example.com`,
    });
    try {
      await clearNotificationPolicy(TYPE);
      actAs(actor.clerkUserId, actor.email);

      const res = await request(app).get("/api/admin/notification-policies");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      // Every catalog type appears even without a stored row.
      expect(res.body.length).toBeGreaterThanOrEqual(1);
      const entry = (res.body as Array<Record<string, unknown>>).find(
        (p) => p.type === TYPE,
      );
      expect(entry).toBeDefined();
      expect(entry).toMatchObject({
        type: TYPE,
        enabled: true,
        emailPolicy: "optional",
      });
      expect(entry).toHaveProperty("label");
      expect(entry).toHaveProperty("description");
    } finally {
      await restoreNotificationPolicy(TYPE, snapshot);
      await deleteTenant(actor.tenantId);
    }
  });

  it("GET reflects a stored policy row instead of the defaults", async () => {
    const snapshot = await snapshotNotificationPolicy(TYPE);
    const actor = await createTenant({
      isSuperadmin: true,
      email: `granted-${randomUUID()}@example.com`,
    });
    try {
      await setNotificationPolicy(TYPE, {
        enabled: false,
        emailPolicy: "off",
      });
      actAs(actor.clerkUserId, actor.email);

      const res = await request(app).get("/api/admin/notification-policies");
      expect(res.status).toBe(200);
      expect(res.body[0]).toMatchObject({
        type: TYPE,
        enabled: false,
        emailPolicy: "off",
      });
    } finally {
      await restoreNotificationPolicy(TYPE, snapshot);
      await deleteTenant(actor.tenantId);
    }
  });

  it("PUT persists an enabled + emailPolicy change and a fresh GET reads it back", async () => {
    const snapshot = await snapshotNotificationPolicy(TYPE);
    const actor = await createTenant({
      isSuperadmin: true,
      email: `granted-${randomUUID()}@example.com`,
    });
    try {
      await clearNotificationPolicy(TYPE);
      actAs(actor.clerkUserId, actor.email);

      const put = await request(app)
        .put("/api/admin/notification-policies")
        .send({
          policies: [{ type: TYPE, enabled: false, emailPolicy: "forced" }],
        });
      expect(put.status).toBe(200);
      // The PUT response returns the folded list with the new values.
      expect(put.body[0]).toMatchObject({
        type: TYPE,
        enabled: false,
        emailPolicy: "forced",
      });

      // The change is persisted, not just echoed.
      const stored = await snapshotNotificationPolicy(TYPE);
      expect(stored).not.toBeNull();
      expect(stored!.enabled).toBe(false);
      expect(stored!.emailPolicy).toBe("forced");

      const get = await request(app).get("/api/admin/notification-policies");
      expect(get.status).toBe(200);
      expect(get.body[0]).toMatchObject({
        type: TYPE,
        enabled: false,
        emailPolicy: "forced",
      });
    } finally {
      await restoreNotificationPolicy(TYPE, snapshot);
      await deleteTenant(actor.tenantId);
    }
  });

  it("PUT rejects an emailPolicy outside optional/forced/off with 400 and does not write", async () => {
    const snapshot = await snapshotNotificationPolicy(TYPE);
    const actor = await createTenant({
      isSuperadmin: true,
      email: `granted-${randomUUID()}@example.com`,
    });
    try {
      await clearNotificationPolicy(TYPE);
      actAs(actor.clerkUserId, actor.email);

      const res = await request(app)
        .put("/api/admin/notification-policies")
        .send({
          policies: [{ type: TYPE, enabled: true, emailPolicy: "always" }],
        });
      expect(res.status).toBe(400);

      // No row was created by the rejected write.
      const stored = await snapshotNotificationPolicy(TYPE);
      expect(stored).toBeNull();
    } finally {
      await restoreNotificationPolicy(TYPE, snapshot);
      await deleteTenant(actor.tenantId);
    }
  });

  it("PUT rejects an unknown notification type with 400 and does not create a junk row", async () => {
    const actor = await createTenant({
      isSuperadmin: true,
      email: `granted-${randomUUID()}@example.com`,
    });
    try {
      actAs(actor.clerkUserId, actor.email);

      const res = await request(app)
        .put("/api/admin/notification-policies")
        .send({
          policies: [
            { type: "bogus_type", enabled: false, emailPolicy: "off" },
          ],
        });
      expect(res.status).toBe(400);

      const stored = await snapshotNotificationPolicy("bogus_type");
      expect(stored).toBeNull();
    } finally {
      await deleteTenant(actor.tenantId);
    }
  });

  it("is superadmin-gated: a plain tenant gets 403 on GET and PUT, and no write occurs", async () => {
    const snapshot = await snapshotNotificationPolicy(TYPE);
    const actor = await createTenant({
      email: `plain-${randomUUID()}@example.com`,
    });
    try {
      await clearNotificationPolicy(TYPE);
      actAs(actor.clerkUserId, actor.email);

      const get = await request(app).get("/api/admin/notification-policies");
      expect(get.status).toBe(403);

      const put = await request(app)
        .put("/api/admin/notification-policies")
        .send({
          policies: [{ type: TYPE, enabled: false, emailPolicy: "off" }],
        });
      expect(put.status).toBe(403);

      // The rejected write left no policy row behind.
      const stored = await snapshotNotificationPolicy(TYPE);
      expect(stored).toBeNull();
    } finally {
      await restoreNotificationPolicy(TYPE, snapshot);
      await deleteTenant(actor.tenantId);
    }
  });

  it("returns 401 to an unauthenticated caller on both GET and PUT", async () => {
    resetAuthState();
    const get = await request(app).get("/api/admin/notification-policies");
    expect(get.status).toBe(401);

    const put = await request(app)
      .put("/api/admin/notification-policies")
      .send({
        policies: [{ type: TYPE, enabled: false, emailPolicy: "off" }],
      });
    expect(put.status).toBe(401);
  });
});

describe("revoking the superadmin DB flag instantly locks out every platform-wide admin surface", () => {
  const TYPE = "social_connection_failed";

  // A syntactically valid plan body; the writes below must never land, either
  // because the plan id is unknown (404 while granted) or because the actor
  // was revoked (403 afterwards).
  const planBody = {
    name: "Revoke Test Plan",
    priceLabel: "$0",
    limits: { captions: 1, images: 1, brandKits: 1, scheduledPosts: 1 },
    features: ["nothing"],
  };

  it("plan catalog (/admin/plans): access while granted, 403 on the very next request after revoke, no row written", async () => {
    const tenant = await createTenant({
      email: `revoked-${randomUUID()}@example.com`,
    });
    const bogusPlanId = `revoke-test-${randomUUID().slice(0, 8)}`;
    try {
      actAs(tenant.clerkUserId, tenant.email);

      // Not yet a superadmin: the gate rejects before the handler runs.
      const before = await request(app)
        .put(`/api/admin/plans/${bogusPlanId}`)
        .send(planBody);
      expect(before.status).toBe(403);

      // Granted: the request now clears the gate and reaches the handler,
      // which 404s on the unknown plan id (proof of access without mutating
      // the shared catalog).
      await setTenantSuperadmin(tenant.tenantId, true);
      const granted = await request(app)
        .put(`/api/admin/plans/${bogusPlanId}`)
        .send(planBody);
      expect(granted.status).toBe(404);

      // Revoked: the very next request is rejected at the gate again — the
      // flag is read fresh each request, so there is no caching window.
      await setTenantSuperadmin(tenant.tenantId, false);
      const revokedPut = await request(app)
        .put(`/api/admin/plans/${bogusPlanId}`)
        .send(planBody);
      expect(revokedPut.status).toBe(403);

      // Creation and deletion are locked out too.
      const revokedPost = await request(app)
        .post("/api/admin/plans")
        .send({ ...planBody, id: bogusPlanId });
      expect(revokedPost.status).toBe(403);
      const revokedDelete = await request(app).delete(
        `/api/admin/plans/${bogusPlanId}`,
      );
      expect(revokedDelete.status).toBe(403);

      // None of the rejected writes left a plan_settings row behind.
      expect(await getPlanSettingsRow(bogusPlanId)).toBeUndefined();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("notification policies (/admin/notification-policies): access while granted, 403 + no write after revoke", async () => {
    const snapshot = await snapshotNotificationPolicy(TYPE);
    const tenant = await createTenant({
      email: `revoked-${randomUUID()}@example.com`,
    });
    try {
      await clearNotificationPolicy(TYPE);
      actAs(tenant.clerkUserId, tenant.email);

      const before = await request(app).get(
        "/api/admin/notification-policies",
      );
      expect(before.status).toBe(403);

      await setTenantSuperadmin(tenant.tenantId, true);
      const granted = await request(app).get(
        "/api/admin/notification-policies",
      );
      expect(granted.status).toBe(200);

      await setTenantSuperadmin(tenant.tenantId, false);
      const revokedGet = await request(app).get(
        "/api/admin/notification-policies",
      );
      expect(revokedGet.status).toBe(403);

      const revokedPut = await request(app)
        .put("/api/admin/notification-policies")
        .send({
          policies: [{ type: TYPE, enabled: false, emailPolicy: "off" }],
        });
      expect(revokedPut.status).toBe(403);

      // The rejected write created no policy row.
      expect(await snapshotNotificationPolicy(TYPE)).toBeNull();
    } finally {
      await restoreNotificationPolicy(TYPE, snapshot);
      await deleteTenant(tenant.tenantId);
    }
  });

  it("platform credentials (/admin/platform-credentials/*): access while granted, 403 on read and write after revoke", async () => {
    const tenant = await createTenant({
      email: `revoked-${randomUUID()}@example.com`,
    });
    try {
      actAs(tenant.clerkUserId, tenant.email);

      const before = await request(app).get(
        "/api/admin/platform-credentials/meta",
      );
      expect(before.status).toBe(403);

      await setTenantSuperadmin(tenant.tenantId, true);
      const granted = await request(app).get(
        "/api/admin/platform-credentials/meta",
      );
      expect(granted.status).toBe(200);

      await setTenantSuperadmin(tenant.tenantId, false);
      const revokedGet = await request(app).get(
        "/api/admin/platform-credentials/meta",
      );
      expect(revokedGet.status).toBe(403);

      // Writes to app-level credentials are locked out too — and every other
      // provider surface behind the same path prefix rejects reads as well.
      const revokedPut = await request(app)
        .put("/api/admin/platform-credentials/meta")
        .send({ appId: "should-not-store", appSecret: "should-not-store" });
      expect(revokedPut.status).toBe(403);

      for (const provider of ["twitter", "linkedin", "youtube", "threads"]) {
        const res = await request(app).get(
          `/api/admin/platform-credentials/${provider}`,
        );
        expect(res.status).toBe(403);
      }
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("audit log (/admin/audit-logs): access while granted, 403 on the very next request after revoke", async () => {
    const tenant = await createTenant({
      email: `revoked-${randomUUID()}@example.com`,
    });
    try {
      actAs(tenant.clerkUserId, tenant.email);

      // Not yet a superadmin: the gate rejects the listing outright.
      const before = await request(app).get("/api/admin/audit-logs");
      expect(before.status).toBe(403);

      // Granted: the audit trail is readable.
      await setTenantSuperadmin(tenant.tenantId, true);
      const granted = await request(app).get("/api/admin/audit-logs");
      expect(granted.status).toBe(200);
      expect(Array.isArray(granted.body.items)).toBe(true);

      // Revoked: the very next request is rejected — the flag is read fresh
      // each request, so a demoted admin cannot keep browsing the trail.
      await setTenantSuperadmin(tenant.tenantId, false);
      const revoked = await request(app).get("/api/admin/audit-logs");
      expect(revoked.status).toBe(403);

      // The export surface behind the same gate is locked out too.
      const revokedExport = await request(app).get(
        "/api/admin/audit-logs/export",
      );
      expect(revokedExport.status).toBe(403);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("app branding (PUT /app-brand, POST /app-brand/upload-url): access while granted, 403 + no settings change after revoke", async () => {
    const snapshot = await snapshotAppBrand();
    const tenant = await createTenant({
      email: `revoked-${randomUUID()}@example.com`,
    });
    const grantedName = `Granted Brand ${randomUUID().slice(0, 8)}`;
    try {
      actAs(tenant.clerkUserId, tenant.email);

      // Not yet a superadmin: both branding writes are rejected at the gate.
      const beforePut = await request(app)
        .put("/api/app-brand")
        .send({ appName: "Should Not Land" });
      expect(beforePut.status).toBe(403);
      const beforeUpload = await request(app)
        .post("/api/app-brand/upload-url")
        .send({});
      expect(beforeUpload.status).toBe(403);

      // Granted: the branding write lands (proof of access).
      await setTenantSuperadmin(tenant.tenantId, true);
      const granted = await request(app)
        .put("/api/app-brand")
        .send({ appName: grantedName });
      expect(granted.status).toBe(200);
      expect(granted.body.appName).toBe(grantedName);
      expect((await getAppBrandRow())?.appName).toBe(grantedName);

      // Revoked: the very next branding write is rejected — the flag is read
      // fresh each request — and the stored settings row is untouched.
      await setTenantSuperadmin(tenant.tenantId, false);
      const revokedPut = await request(app)
        .put("/api/app-brand")
        .send({ appName: "Demoted Rebrand Attempt" });
      expect(revokedPut.status).toBe(403);
      expect((await getAppBrandRow())?.appName).toBe(grantedName);

      // The upload-URL minting surface is locked out too.
      const revokedUpload = await request(app)
        .post("/api/app-brand/upload-url")
        .send({});
      expect(revokedUpload.status).toBe(403);
    } finally {
      await restoreAppBrand(snapshot);
      await deleteTenant(tenant.tenantId);
    }
  });

  it("per-tenant plan override (PATCH /admin/tenants/:id): access while granted, 403 + no plan change after revoke", async () => {
    const actor = await createTenant({
      email: `revoked-${randomUUID()}@example.com`,
    });
    const target = await createTenant({
      email: `target-${randomUUID()}@example.com`,
    });
    try {
      actAs(actor.clerkUserId, actor.email);

      // Not yet a superadmin: the write is rejected and the plan is untouched.
      const before = await request(app)
        .patch(`/api/admin/tenants/${target.tenantId}`)
        .send({ plan: "pro" });
      expect(before.status).toBe(403);
      expect((await getTenant(target.tenantId)).plan).toBe("free");

      // Granted: the override lands.
      await setTenantSuperadmin(actor.tenantId, true);
      const granted = await request(app)
        .patch(`/api/admin/tenants/${target.tenantId}`)
        .send({ plan: "pro" });
      expect(granted.status).toBe(200);
      expect((await getTenant(target.tenantId)).plan).toBe("pro");

      // Revoked: the very next write is rejected and the target keeps its
      // current plan — no change is written by the demoted admin.
      await setTenantSuperadmin(actor.tenantId, false);
      const revoked = await request(app)
        .patch(`/api/admin/tenants/${target.tenantId}`)
        .send({ plan: "business" });
      expect(revoked.status).toBe(403);
      expect((await getTenant(target.tenantId)).plan).toBe("pro");
    } finally {
      await deleteTenant(actor.tenantId);
      await deleteTenant(target.tenantId);
    }
  });
});
