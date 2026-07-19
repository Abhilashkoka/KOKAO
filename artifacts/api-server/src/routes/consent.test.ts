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

import { pool, db, userConsentsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireTenant } from "../middlewares/requireTenant";
import consentRouter from "./consent";
import { resetAuthState, actAs } from "../test/authState";
import { createTenant, deleteTenant } from "../test/dbHelpers";

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
  app.use("/api", requireTenant, consentRouter);
  return app;
}

const app = buildApp();

async function consentRow(clerkUserId: string) {
  const rows = await db
    .select()
    .from(userConsentsTable)
    .where(eq(userConsentsTable.clerkUserId, clerkUserId))
    .limit(1);
  return rows[0];
}

async function cleanupConsent(clerkUserId: string) {
  await db
    .delete(userConsentsTable)
    .where(eq(userConsentsTable.clerkUserId, clerkUserId));
}

beforeEach(() => {
  resetAuthState();
});

afterAll(async () => {
  await pool.end();
});

describe("POST /consent/dismiss-prompt", () => {
  it("creates the row with promptDismissed=true and never marks it responded", async () => {
    const tenant = await createTenant();
    try {
      actAs(tenant.clerkUserId, "u@example.com");
      const res = await request(app).post("/api/consent/dismiss-prompt");
      expect(res.status).toBe(200);
      expect(res.body.promptDismissed).toBe(true);
      expect(res.body.responded).toBe(false);

      const row = await consentRow(tenant.clerkUserId);
      expect(row).toBeDefined();
      expect(row.promptDismissedAt).not.toBeNull();
      expect(row.respondedAt).toBeNull();

      // Dismissing again (existing row) still must not set respondedAt.
      const res2 = await request(app).post("/api/consent/dismiss-prompt");
      expect(res2.status).toBe(200);
      expect(res2.body.promptDismissed).toBe(true);
      expect(res2.body.responded).toBe(false);
      const row2 = await consentRow(tenant.clerkUserId);
      expect(row2.respondedAt).toBeNull();
    } finally {
      await cleanupConsent(tenant.clerkUserId);
      await deleteTenant(tenant.tenantId);
    }
  });

  it("a later PUT /consent sets responded=true while keeping promptDismissed=true", async () => {
    const tenant = await createTenant();
    try {
      actAs(tenant.clerkUserId, "u@example.com");
      await request(app).post("/api/consent/dismiss-prompt");

      const res = await request(app)
        .put("/api/consent")
        .send({ analytics: true, deviceDetails: false });
      expect(res.status).toBe(200);
      expect(res.body.responded).toBe(true);
      expect(res.body.promptDismissed).toBe(true);
      expect(res.body.analytics).toBe(true);

      const row = await consentRow(tenant.clerkUserId);
      expect(row.respondedAt).not.toBeNull();
      expect(row.promptDismissedAt).not.toBeNull();
      expect(row.analytics).toBe(true);
    } finally {
      await cleanupConsent(tenant.clerkUserId);
      await deleteTenant(tenant.tenantId);
    }
  });

  it("dismissing after responding keeps responded=true and consent flags intact", async () => {
    const tenant = await createTenant();
    try {
      actAs(tenant.clerkUserId, "u@example.com");
      const put = await request(app)
        .put("/api/consent")
        .send({ analytics: true, locationCoarse: true });
      expect(put.status).toBe(200);
      expect(put.body.responded).toBe(true);

      const res = await request(app).post("/api/consent/dismiss-prompt");
      expect(res.status).toBe(200);
      expect(res.body.promptDismissed).toBe(true);
      expect(res.body.responded).toBe(true);
      expect(res.body.analytics).toBe(true);
      expect(res.body.locationCoarse).toBe(true);

      const row = await consentRow(tenant.clerkUserId);
      expect(row.respondedAt).not.toBeNull();
      expect(row.promptDismissedAt).not.toBeNull();
      expect(row.analytics).toBe(true);
      expect(row.locationCoarse).toBe(true);

      // GET reflects the same state.
      const get = await request(app).get("/api/consent");
      expect(get.status).toBe(200);
      expect(get.body.responded).toBe(true);
      expect(get.body.promptDismissed).toBe(true);
      expect(get.body.analytics).toBe(true);
    } finally {
      await cleanupConsent(tenant.clerkUserId);
      await deleteTenant(tenant.tenantId);
    }
  });
});
