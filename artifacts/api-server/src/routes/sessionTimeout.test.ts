import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import request from "supertest";
import express, { type Express } from "express";
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

import { pool, type SessionTimeoutSettings } from "@workspace/db";
import { requireTenant } from "../middlewares/requireTenant";
import sessionTimeoutRouter from "./sessionTimeout";
import {
  invalidateSessionTimeoutCache,
  saveSessionTimeoutSettings,
} from "../lib/sessionTimeout";
import { resetAuthState, actAs } from "../test/authState";
import {
  createTenant,
  deleteTenant,
  getAuditLogsForActor,
  snapshotSessionTimeoutSettings,
  restoreSessionTimeoutSettings,
  clearSessionTimeoutSettings,
  setSessionTimeoutSettings,
  getAllSessionTimeoutRows,
} from "../test/dbHelpers";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, () => void> }).log = {
      info() {},
      error() {},
      warn() {},
      debug() {},
    };
    next();
  });
  app.use("/api", requireTenant, sessionTimeoutRouter);
  return app;
}

const app = buildApp();
let snapshot: SessionTimeoutSettings | null = null;

beforeAll(async () => {
  snapshot = await snapshotSessionTimeoutSettings();
});

afterAll(async () => {
  await restoreSessionTimeoutSettings(snapshot);
  invalidateSessionTimeoutCache();
  await pool.end();
});

beforeEach(() => {
  resetAuthState();
  invalidateSessionTimeoutCache();
});

describe("GET /session-timeout (any signed-in user)", () => {
  it("returns the built-in defaults when no row exists", async () => {
    const tenant = await createTenant({
      email: `user-${randomUUID()}@example.com`,
    });
    try {
      await clearSessionTimeoutSettings();
      invalidateSessionTimeoutCache();
      actAs(tenant.clerkUserId, tenant.email);

      const res = await request(app).get("/api/session-timeout");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        enabled: true,
        timeoutMinutes: 30,
        warningSeconds: 60,
      });
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("returns the saved settings to a non-admin", async () => {
    const tenant = await createTenant({
      email: `user-${randomUUID()}@example.com`,
    });
    try {
      await setSessionTimeoutSettings({
        enabled: false,
        timeoutMinutes: 45,
        warningSeconds: 90,
      });
      invalidateSessionTimeoutCache();
      actAs(tenant.clerkUserId, tenant.email);

      const res = await request(app).get("/api/session-timeout");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        enabled: false,
        timeoutMinutes: 45,
        warningSeconds: 90,
      });
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});

describe("admin session-timeout endpoints", () => {
  it("saves and returns the updated values for a superadmin", async () => {
    const tenant = await createTenant({ isSuperadmin: true });
    try {
      await clearSessionTimeoutSettings();
      invalidateSessionTimeoutCache();
      actAs(tenant.clerkUserId);

      const res = await request(app)
        .put("/api/admin/session-timeout")
        .send({ enabled: true, timeoutMinutes: 60, warningSeconds: 120 });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        enabled: true,
        timeoutMinutes: 60,
        warningSeconds: 120,
      });

      // The GET reflects the persisted row (fresh read, cache invalidated).
      invalidateSessionTimeoutCache();
      const getRes = await request(app).get("/api/admin/session-timeout");
      expect(getRes.status).toBe(200);
      expect(getRes.body).toEqual({
        enabled: true,
        timeoutMinutes: 60,
        warningSeconds: 120,
      });
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("rejects warningSeconds >= timeoutMinutes*60 with a clear 400", async () => {
    const tenant = await createTenant({ isSuperadmin: true });
    try {
      await setSessionTimeoutSettings({
        enabled: true,
        timeoutMinutes: 30,
        warningSeconds: 60,
      });
      invalidateSessionTimeoutCache();
      actAs(tenant.clerkUserId);

      // timeoutMinutes 5 => window is 300s; warningSeconds 300 is NOT < 300.
      const res = await request(app)
        .put("/api/admin/session-timeout")
        .send({ enabled: true, timeoutMinutes: 5, warningSeconds: 300 });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/warningSeconds/);

      // The rejected write must not have changed the stored settings.
      invalidateSessionTimeoutCache();
      const getRes = await request(app).get("/api/admin/session-timeout");
      expect(getRes.body).toEqual({
        enabled: true,
        timeoutMinutes: 30,
        warningSeconds: 60,
      });
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("rejects a non-superadmin (403) and does not save", async () => {
    const tenant = await createTenant({
      email: `user-${randomUUID()}@example.com`,
    });
    try {
      await setSessionTimeoutSettings({
        enabled: true,
        timeoutMinutes: 30,
        warningSeconds: 60,
      });
      invalidateSessionTimeoutCache();
      actAs(tenant.clerkUserId, tenant.email);

      const getRes = await request(app).get("/api/admin/session-timeout");
      expect(getRes.status).toBe(403);

      const putRes = await request(app)
        .put("/api/admin/session-timeout")
        .send({ enabled: false, timeoutMinutes: 90, warningSeconds: 30 });
      expect(putRes.status).toBe(403);

      // Unchanged.
      invalidateSessionTimeoutCache();
      const [row] = await request(app)
        .get("/api/session-timeout")
        .then((r) => [r.body]);
      expect(row).toEqual({
        enabled: true,
        timeoutMinutes: 30,
        warningSeconds: 60,
      });
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("keeps exactly one row (id=1) under concurrent first saves", async () => {
    const tenant = await createTenant({
      email: `user-${randomUUID()}@example.com`,
    });
    try {
      await clearSessionTimeoutSettings();
      invalidateSessionTimeoutCache();

      // Two racing first-saves with no pre-existing row: the fixed-id upsert
      // must make the second racer conflict on the primary key and update the
      // same row instead of inserting a duplicate.
      await Promise.all([
        saveSessionTimeoutSettings({
          enabled: true,
          timeoutMinutes: 15,
          warningSeconds: 30,
        }),
        saveSessionTimeoutSettings({
          enabled: false,
          timeoutMinutes: 240,
          warningSeconds: 90,
        }),
      ]);

      const rows = await getAllSessionTimeoutRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(1);

      // Exactly one of the two writes won; the surviving row must match one of
      // them in full (last-writer-wins, never a torn/merged row) and the read
      // path returns that same singleton.
      actAs(tenant.clerkUserId, tenant.email);
      invalidateSessionTimeoutCache();
      const getRes = await request(app).get("/api/session-timeout");
      expect(getRes.status).toBe(200);
      expect(getRes.body).toEqual({
        enabled: rows[0].enabled,
        timeoutMinutes: rows[0].timeoutMinutes,
        warningSeconds: rows[0].warningSeconds,
      });
      expect([
        { enabled: true, timeoutMinutes: 15, warningSeconds: 30 },
        { enabled: false, timeoutMinutes: 240, warningSeconds: 90 },
      ]).toContainEqual(getRes.body);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("records a session_timeout_change audit row on save", async () => {
    const tenant = await createTenant({
      isSuperadmin: true,
      email: `admin-${randomUUID()}@example.com`,
    });
    try {
      await setSessionTimeoutSettings({
        enabled: true,
        timeoutMinutes: 30,
        warningSeconds: 60,
      });
      invalidateSessionTimeoutCache();
      actAs(tenant.clerkUserId, tenant.email);

      const res = await request(app)
        .put("/api/admin/session-timeout")
        .send({ enabled: false, timeoutMinutes: 120, warningSeconds: 45 });
      expect(res.status).toBe(200);

      const logs = (await getAuditLogsForActor(tenant.tenantId)).filter(
        (l) => l.action === "session_timeout_change",
      );
      expect(logs).toHaveLength(1);
      const log = logs[0];
      expect(log.targetTenantId).toBeNull();
      expect(JSON.parse(log.oldValue!)).toEqual({
        enabled: true,
        timeoutMinutes: 30,
        warningSeconds: 60,
      });
      expect(JSON.parse(log.newValue!)).toEqual({
        enabled: false,
        timeoutMinutes: 120,
        warningSeconds: 45,
      });
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});
