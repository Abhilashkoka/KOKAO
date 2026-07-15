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

import { pool } from "@workspace/db";
import { createAdminTestApp } from "../test/testApp";
import { resetAuthState, actAs } from "../test/authState";
import {
  createTenant,
  deleteTenant,
  getTenant,
  getAuditLogsForTarget,
  snapshotNotificationPolicy,
  setNotificationPolicy,
  clearNotificationPolicy,
  restoreNotificationPolicy,
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
      expect(Array.isArray(res.body)).toBe(true);

      const entry = (res.body as Array<Record<string, unknown>>).find(
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
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({
        type: TYPE,
        enabled: true,
        emailPolicy: "optional",
      });
      expect(res.body[0]).toHaveProperty("label");
      expect(res.body[0]).toHaveProperty("description");
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
