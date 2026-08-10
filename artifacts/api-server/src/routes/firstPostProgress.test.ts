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
  tenantsTable,
  contentItemsTable,
  connectedAccountsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireTenant } from "../middlewares/requireTenant";
import firstPostProgressRouter from "./firstPostProgress";
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
  app.use("/api", requireTenant, firstPostProgressRouter);
  return app;
}

const app = buildApp();

beforeEach(() => {
  resetAuthState();
});

afterAll(async () => {
  await pool.end();
});

describe("GET /first-post-progress", () => {
  it("reports all-false for a fresh tenant", async () => {
    const tenant = await createTenant();
    try {
      actAs(tenant.clerkUserId, "u@example.com");
      const res = await request(app).get("/api/first-post-progress");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        generated: false,
        saved: false,
        connected: false,
        published: false,
        dismissed: false,
      });
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("reflects saved/generated, connected, and published tenant state", async () => {
    const tenant = await createTenant();
    try {
      actAs(tenant.clerkUserId, "u@example.com");

      // A draft content item => generated + saved.
      const [item] = await db
        .insert(contentItemsTable)
        .values({
          tenantId: tenant.tenantId,
          title: "First draft",
          caption: "hello",
          status: "draft",
        })
        .returning();

      let res = await request(app).get("/api/first-post-progress");
      expect(res.status).toBe(200);
      expect(res.body.generated).toBe(true);
      expect(res.body.saved).toBe(true);
      expect(res.body.connected).toBe(false);
      expect(res.body.published).toBe(false);

      // A live connected account => connected. A dead one must not count.
      await db.insert(connectedAccountsTable).values({
        tenantId: tenant.tenantId,
        platform: "facebook",
        accountName: "Page",
        status: "connected",
      });
      // Publish the item => published.
      await db
        .update(contentItemsTable)
        .set({ status: "published" })
        .where(eq(contentItemsTable.id, item.id));

      res = await request(app).get("/api/first-post-progress");
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(true);
      expect(res.body.published).toBe(true);
    } finally {
      await db
        .delete(contentItemsTable)
        .where(eq(contentItemsTable.tenantId, tenant.tenantId));
      await db
        .delete(connectedAccountsTable)
        .where(eq(connectedAccountsTable.tenantId, tenant.tenantId));
      await deleteTenant(tenant.tenantId);
    }
  });

  it("ignores disconnected accounts", async () => {
    const tenant = await createTenant();
    try {
      actAs(tenant.clerkUserId, "u@example.com");
      await db.insert(connectedAccountsTable).values({
        tenantId: tenant.tenantId,
        platform: "linkedin",
        accountName: "Dead",
        status: "disconnected",
      });
      const res = await request(app).get("/api/first-post-progress");
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(false);
    } finally {
      await db
        .delete(connectedAccountsTable)
        .where(eq(connectedAccountsTable.tenantId, tenant.tenantId));
      await deleteTenant(tenant.tenantId);
    }
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/first-post-progress");
    expect(res.status).toBe(401);
  });
});

describe("POST /first-post-progress/dismiss", () => {
  it("persists the dismissal idempotently (keeps the first timestamp)", async () => {
    const tenant = await createTenant();
    try {
      actAs(tenant.clerkUserId, "u@example.com");
      const res = await request(app).post("/api/first-post-progress/dismiss");
      expect(res.status).toBe(200);
      expect(res.body.dismissed).toBe(true);

      const first = (
        await db
          .select({ at: tenantsTable.firstPostNudgeDismissedAt })
          .from(tenantsTable)
          .where(eq(tenantsTable.id, tenant.tenantId))
      )[0];
      expect(first.at).not.toBeNull();

      // Second dismiss must not move the timestamp.
      const res2 = await request(app).post("/api/first-post-progress/dismiss");
      expect(res2.status).toBe(200);
      expect(res2.body.dismissed).toBe(true);
      const second = (
        await db
          .select({ at: tenantsTable.firstPostNudgeDismissedAt })
          .from(tenantsTable)
          .where(eq(tenantsTable.id, tenant.tenantId))
      )[0];
      expect(second.at?.toISOString()).toBe(first.at?.toISOString());

      // GET reflects the dismissal.
      const get = await request(app).get("/api/first-post-progress");
      expect(get.body.dismissed).toBe(true);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});
