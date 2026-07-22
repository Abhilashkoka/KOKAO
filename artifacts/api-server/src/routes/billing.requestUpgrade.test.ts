import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";

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

// Never send real email from tests.
vi.mock("../lib/email", () => ({
  sendEmail: vi.fn(async () => true),
}));

import { db, pool, tenantMembersTable } from "@workspace/db";
import { requireTenant } from "../middlewares/requireTenant";
import billingRouter from "./billing";
import { UPGRADE_REQUESTED } from "../lib/notifications";
import { resetAuthState, actAs } from "../test/authState";
import {
  createTenant,
  deleteTenant,
  getNotifications,
  type TestTenant,
} from "../test/dbHelpers";

function createBillingTestApp(): Express {
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
  app.use("/api", requireTenant, billingRouter);
  return app;
}

const app = createBillingTestApp();

const createdTenants: TestTenant[] = [];

afterAll(async () => {
  for (const t of createdTenants) await deleteTenant(t.tenantId);
  await pool.end();
});

beforeEach(() => {
  resetAuthState();
});

async function setupWorkspaceWithMember(): Promise<{
  owner: TestTenant;
  memberClerkId: string;
}> {
  const ownerTenant = await createTenant();
  createdTenants.push(ownerTenant);
  const memberClerkId = `member_${Math.random().toString(36).slice(2)}`;
  await db.insert(tenantMembersTable).values({
    tenantId: ownerTenant.tenantId,
    clerkUserId: memberClerkId,
    role: "member",
  });
  return { owner: ownerTenant, memberClerkId };
}

describe("POST /billing/request-upgrade", () => {
  it("rejects the workspace owner with 400", async () => {
    const setup = await setupWorkspaceWithMember();

    actAs(setup.owner.clerkUserId, "owner@example.com");
    const res = await request(app).post("/api/billing/request-upgrade");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/owner/i);
  });

  it("lets a member submit and dedupes a repeat call while the alert is unread", async () => {
    const setup = await setupWorkspaceWithMember();

    actAs(setup.memberClerkId, "member@example.com");

    const first = await request(app).post("/api/billing/request-upgrade");
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ok: true, deduped: false });

    const notes = (await getNotifications(setup.owner.tenantId)).filter(
      (n) => n.type === UPGRADE_REQUESTED,
    );
    expect(notes).toHaveLength(1);

    // Second call while the alert is unread: deduped in place, still 200.
    const second = await request(app).post("/api/billing/request-upgrade");
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ ok: true, deduped: true });

    const notesAfter = (await getNotifications(setup.owner.tenantId)).filter(
      (n) => n.type === UPGRADE_REQUESTED,
    );
    expect(notesAfter).toHaveLength(1);
  });
});
