/**
 * Welcome-banner dismissal persistence (task: mobile WelcomeCreditsBanner).
 *
 * The mobile banner renders iff the default (unread-only) notification list
 * contains a `signup_credits_granted` row, and dismisses via the mark-read
 * endpoint. This verifies the full server contract the banner relies on:
 * 1. unread signup_credits_granted appears in GET /api/notifications
 * 2. POST /api/notifications/:id/read persists readAt in the DB
 * 3. a FRESH list fetch (app restart) no longer includes it -> banner gone
 * 4. dismissal is idempotent-safe for other tenants (scoped by tenantId)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";

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

import { db, notificationsTable, pool } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { createTestApp } from "../test/testApp";
import { actAs, resetAuthState } from "../test/authState";
import { createTenant, deleteTenant, type TestTenant } from "../test/dbHelpers";
import { SIGNUP_CREDITS_GRANTED } from "../lib/notifications";

const app = createTestApp();

let tenant: TestTenant;
let otherTenant: TestTenant;

async function seedWelcomeNotification(tenantId: number): Promise<number> {
  const [row] = await db
    .insert(notificationsTable)
    .values({
      tenantId,
      type: SIGNUP_CREDITS_GRANTED,
      platform: null,
      title: "Welcome! You received free credits",
      message: "Your new workspace received 10 caption credits to get started.",
      linkUrl: "/studio",
      inApp: true,
    })
    .returning({ id: notificationsTable.id });
  return row.id;
}

beforeAll(async () => {
  tenant = await createTenant();
  otherTenant = await createTenant();
});

afterAll(async () => {
  await deleteTenant(tenant.tenantId);
  await deleteTenant(otherTenant.tenantId);
  resetAuthState();
  await pool.end();
});

describe("welcome credits banner dismissal persists", () => {
  it("shows while unread, disappears from fresh loads after mark-read", async () => {
    const notificationId = await seedWelcomeNotification(tenant.tenantId);
    actAs(tenant.clerkUserId);

    // 1. Banner data source: unread list contains the welcome notification.
    const first = await request(app).get("/api/notifications");
    expect(first.status).toBe(200);
    const welcome = (first.body as Array<{ id: number; type: string; readAt: string | null }>).find(
      (n) => n.type === SIGNUP_CREDITS_GRANTED,
    );
    expect(welcome).toBeDefined();
    expect(welcome!.id).toBe(notificationId);
    expect(welcome!.readAt).toBeNull();

    // 2. Dismiss = mark read; must persist in the DB.
    const dismiss = await request(app).post(
      `/api/notifications/${notificationId}/read`,
    );
    expect(dismiss.status).toBe(204);
    const dbRow = (
      await db
        .select({ readAt: notificationsTable.readAt })
        .from(notificationsTable)
        .where(eq(notificationsTable.id, notificationId))
    )[0];
    expect(dbRow.readAt).not.toBeNull();

    // 3. Fresh load (app restart => brand-new query, no client cache):
    //    the default unread list no longer contains it, so the banner
    //    renders nothing.
    const fresh = await request(app).get("/api/notifications");
    expect(fresh.status).toBe(200);
    expect(
      (fresh.body as Array<{ type: string }>).some(
        (n) => n.type === SIGNUP_CREDITS_GRANTED,
      ),
    ).toBe(false);
  });

  it("cannot dismiss another workspace's welcome notification", async () => {
    const foreignId = await seedWelcomeNotification(otherTenant.tenantId);
    actAs(tenant.clerkUserId);

    const res = await request(app).post(`/api/notifications/${foreignId}/read`);
    expect(res.status).toBe(404);

    const row = (
      await db
        .select({ readAt: notificationsTable.readAt })
        .from(notificationsTable)
        .where(
          and(
            eq(notificationsTable.id, foreignId),
            eq(notificationsTable.tenantId, otherTenant.tenantId),
          ),
        )
    )[0];
    expect(row.readAt).toBeNull();
  });
});
