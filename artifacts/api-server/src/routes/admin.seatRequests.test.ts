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

// The admin router pulls in the connection sweep (used by /admin/stats and the
// on-demand sweep trigger). Neither is exercised here; stub it so importing the
// router can never touch live provider APIs.
vi.mock("../lib/connectionSweep", () => ({
  triggerSweepNow: vi.fn(() => true),
  isSweepRunning: vi.fn(() => false),
  checkSweepStaleness: vi.fn(async () => undefined),
}));

import { db, notificationsTable, pool, seatRequestsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { SEAT_REQUEST_SUBMITTED } from "../lib/notifications";
import { createTestApp, createAdminTestApp } from "../test/testApp";
import { resetAuthState, actAs } from "../test/authState";
import {
  createTenant,
  deleteTenant,
  getNotifications,
  purgeNotificationsByTypeSince,
  type TestTenant,
} from "../test/dbHelpers";

// Team routes (seat-request submission) live in the tenant app; the decision
// endpoint lives in the admin app. Both share the same DB and Clerk mock.
const tenantApp = createTestApp();
const adminApp = createAdminTestApp();

const testStart = new Date();

afterAll(async () => {
  // Submission fans out alerts to every PRE-EXISTING superadmin tenant in the
  // dev DB too; per-tenant cleanup never touches those, so purge everything of
  // this type created by this run.
  await purgeNotificationsByTypeSince(SEAT_REQUEST_SUBMITTED, testStart);
  await pool.end();
});

beforeEach(() => {
  resetAuthState();
});

/**
 * The submission route dispatches the admin alert in a detached async block
 * (deliberately off the response path), so the supertest response can return
 * before the notification row exists. Poll briefly for the tagged row.
 */
async function waitForSubmittedAlert(
  adminTenantId: number,
  seatRequestId: number,
): Promise<void> {
  // Generous deadline: under a full-suite run against the shared dev DB the
  // detached insert can lag well past a few seconds.
  const deadline = Date.now() + 20000;
  for (;;) {
    const rows = await db
      .select({ id: notificationsTable.id })
      .from(notificationsTable)
      .where(
        and(
          eq(notificationsTable.tenantId, adminTenantId),
          eq(notificationsTable.type, SEAT_REQUEST_SUBMITTED),
          eq(notificationsTable.referenceId, seatRequestId),
        ),
      )
      .limit(1);
    if (rows.length > 0) return;
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for the seat-request alert (request ${seatRequestId})`,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function submitSeatRequest(
  workspace: TestTenant,
  requestedSeats: number,
): Promise<number> {
  actAs(workspace.clerkUserId, workspace.email);
  const res = await request(tenantApp)
    .post("/api/team/seat-requests")
    .send({ requestedSeats });
  expect(res.status).toBe(200);

  const [row] = await db
    .select({ id: seatRequestsTable.id })
    .from(seatRequestsTable)
    .where(
      and(
        eq(seatRequestsTable.tenantId, workspace.tenantId),
        eq(seatRequestsTable.status, "pending"),
      ),
    )
    .limit(1);
  expect(row).toBeDefined();
  return row.id;
}

async function cleanupSeatRequests(tenantId: number): Promise<void> {
  await db
    .delete(seatRequestsTable)
    .where(eq(seatRequestsTable.tenantId, tenantId));
}

describe("PATCH /admin/seat-requests/:id — deciding a request clears exactly its alert", () => {
  it("marks only the decided request's admin alert read; the other workspace's pending alert stays unread", async () => {
    // A superadmin recipient (DB flag) plus two independent workspaces.
    const admin = await createTenant({
      isSuperadmin: true,
      email: `admin-${randomUUID()}@example.com`,
    });
    const workspaceA = await createTenant({
      email: `ws-a-${randomUUID()}@example.com`,
    });
    const workspaceB = await createTenant({
      email: `ws-b-${randomUUID()}@example.com`,
    });
    try {
      // Both workspaces submit seat requests through the real tenant route.
      const requestA = await submitSeatRequest(workspaceA, 5);
      const requestB = await submitSeatRequest(workspaceB, 8);

      // The alert dispatch is detached from the response; wait for both
      // tagged rows to land on the admin before deciding anything.
      await waitForSubmittedAlert(admin.tenantId, requestA);
      await waitForSubmittedAlert(admin.tenantId, requestB);

      // The superadmin decides workspace A's request via the real endpoint.
      actAs(admin.clerkUserId, admin.email);
      const decide = await request(adminApp)
        .patch(`/api/admin/seat-requests/${requestA}`)
        .send({ action: "approve" });
      expect(decide.status).toBe(200);
      expect(decide.body.status).toBe("approved");

      // Exactly request A's alert is cleared; request B's stays unread.
      const alerts = (await getNotifications(admin.tenantId)).filter(
        (n) => n.type === SEAT_REQUEST_SUBMITTED,
      );
      const alertA = alerts.find((n) => n.referenceId === requestA);
      const alertB = alerts.find((n) => n.referenceId === requestB);
      expect(alertA).toBeDefined();
      expect(alertB).toBeDefined();
      expect(alertA!.readAt).not.toBeNull();
      expect(alertB!.readAt).toBeNull();
    } finally {
      await cleanupSeatRequests(workspaceA.tenantId);
      await cleanupSeatRequests(workspaceB.tenantId);
      await deleteTenant(admin.tenantId);
      await deleteTenant(workspaceA.tenantId);
      await deleteTenant(workspaceB.tenantId);
    }
  });
});
