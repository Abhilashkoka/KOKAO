import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { db, notificationsTable, pool, seatRequestsTable } from "@workspace/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  resolveSeatRequestSubmittedNotifications,
  SEAT_REQUEST_SUBMITTED,
} from "./notifications";
import { createTenant, deleteTenant, getNotifications } from "../test/dbHelpers";

// The resolver is deliberately GLOBAL (alerts are only stale when the whole
// pending queue is empty), so the shared dev DB state matters. Park any real
// pre-existing pending seat requests under a sentinel status and remember any
// real unread seat_request_submitted notifications, restoring both afterwards.
const HOLD_STATUS = "pending__test_hold";
let heldRequestIds: number[] = [];
let preexistingUnreadIds: number[] = [];

beforeAll(async () => {
  const pendingRows = await db
    .select({ id: seatRequestsTable.id })
    .from(seatRequestsTable)
    .where(eq(seatRequestsTable.status, "pending"));
  heldRequestIds = pendingRows.map((r) => r.id);
  if (heldRequestIds.length > 0) {
    await db
      .update(seatRequestsTable)
      .set({ status: HOLD_STATUS })
      .where(inArray(seatRequestsTable.id, heldRequestIds));
  }

  const unreadRows = await db
    .select({ id: notificationsTable.id })
    .from(notificationsTable)
    .where(
      and(
        eq(notificationsTable.type, SEAT_REQUEST_SUBMITTED),
        isNull(notificationsTable.readAt),
      ),
    );
  preexistingUnreadIds = unreadRows.map((r) => r.id);
});

afterAll(async () => {
  if (heldRequestIds.length > 0) {
    await db
      .update(seatRequestsTable)
      .set({ status: "pending" })
      .where(inArray(seatRequestsTable.id, heldRequestIds));
  }
  if (preexistingUnreadIds.length > 0) {
    await db
      .update(notificationsTable)
      .set({ readAt: null })
      .where(inArray(notificationsTable.id, preexistingUnreadIds));
  }
  await pool.end();
});

async function insertSeatRequest(
  tenantId: number,
  status: string,
): Promise<number> {
  const [row] = await db
    .insert(seatRequestsTable)
    .values({ tenantId, requestedSeats: 5, note: null, status })
    .returning();
  return row.id;
}

async function insertSubmittedNotification(
  tenantId: number,
  referenceId: number | null = null,
): Promise<number> {
  const [row] = await db
    .insert(notificationsTable)
    .values({
      tenantId,
      type: SEAT_REQUEST_SUBMITTED,
      platform: null,
      referenceId,
      title: "New seat request awaiting review",
      message: "A workspace requested team seats.",
      linkUrl: "/admin",
      inApp: true,
    })
    .returning();
  return row.id;
}

async function cleanupSeatRequests(tenantId: number): Promise<void> {
  await db
    .delete(seatRequestsTable)
    .where(eq(seatRequestsTable.tenantId, tenantId));
}

describe("resolveSeatRequestSubmittedNotifications", () => {
  it("marks unread seat-request alerts read when no request is pending", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    const workspace = await createTenant();
    try {
      await insertSubmittedNotification(admin.tenantId);
      await insertSeatRequest(workspace.tenantId, "approved");

      await resolveSeatRequestSubmittedNotifications();

      const notes = (await getNotifications(admin.tenantId)).filter(
        (n) => n.type === SEAT_REQUEST_SUBMITTED,
      );
      expect(notes).toHaveLength(1);
      expect(notes[0].readAt).not.toBeNull();
    } finally {
      await cleanupSeatRequests(workspace.tenantId);
      await deleteTenant(admin.tenantId);
      await deleteTenant(workspace.tenantId);
    }
  });

  it("leaves unread alerts alone while another request is still pending", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    const workspace = await createTenant();
    try {
      await insertSubmittedNotification(admin.tenantId);
      await insertSeatRequest(workspace.tenantId, "denied");
      await insertSeatRequest(workspace.tenantId, "pending");

      await resolveSeatRequestSubmittedNotifications();

      const notes = (await getNotifications(admin.tenantId)).filter(
        (n) => n.type === SEAT_REQUEST_SUBMITTED,
      );
      expect(notes).toHaveLength(1);
      expect(notes[0].readAt).toBeNull();
    } finally {
      await cleanupSeatRequests(workspace.tenantId);
      await deleteTenant(admin.tenantId);
      await deleteTenant(workspace.tenantId);
    }
  });

  it("clears only the decided request's alerts while another request is still pending", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    const workspaceA = await createTenant();
    const workspaceB = await createTenant();
    try {
      // Two workspaces each have a pending request; workspace A's is decided.
      const requestA = await insertSeatRequest(workspaceA.tenantId, "approved");
      const requestB = await insertSeatRequest(workspaceB.tenantId, "pending");
      const noteA = await insertSubmittedNotification(admin.tenantId, requestA);
      const noteB = await insertSubmittedNotification(admin.tenantId, requestB);

      await resolveSeatRequestSubmittedNotifications(requestA);

      const notes = (await getNotifications(admin.tenantId)).filter(
        (n) => n.type === SEAT_REQUEST_SUBMITTED,
      );
      const byId = new Map(notes.map((n) => [n.id, n]));
      expect(byId.get(noteA)?.readAt).not.toBeNull();
      expect(byId.get(noteB)?.readAt).toBeNull();
    } finally {
      await cleanupSeatRequests(workspaceA.tenantId);
      await cleanupSeatRequests(workspaceB.tenantId);
      await deleteTenant(admin.tenantId);
      await deleteTenant(workspaceA.tenantId);
      await deleteTenant(workspaceB.tenantId);
    }
  });

  it("clears legacy untagged alerts too once nothing is pending", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    const workspace = await createTenant();
    try {
      const decided = await insertSeatRequest(workspace.tenantId, "approved");
      const tagged = await insertSubmittedNotification(admin.tenantId, decided);
      const legacy = await insertSubmittedNotification(admin.tenantId, null);

      await resolveSeatRequestSubmittedNotifications(decided);

      const notes = (await getNotifications(admin.tenantId)).filter(
        (n) => n.type === SEAT_REQUEST_SUBMITTED,
      );
      const byId = new Map(notes.map((n) => [n.id, n]));
      expect(byId.get(tagged)?.readAt).not.toBeNull();
      expect(byId.get(legacy)?.readAt).not.toBeNull();
    } finally {
      await cleanupSeatRequests(workspace.tenantId);
      await deleteTenant(admin.tenantId);
      await deleteTenant(workspace.tenantId);
    }
  });

  it("does not touch already-read rows and never blocks a fresh alert", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    try {
      const id = await insertSubmittedNotification(admin.tenantId);
      await db
        .update(notificationsTable)
        .set({ readAt: new Date("2026-01-01T00:00:00Z") })
        .where(eq(notificationsTable.id, id));

      await resolveSeatRequestSubmittedNotifications();

      // A later request inserts a fresh row regardless of prior read rows.
      await insertSubmittedNotification(admin.tenantId);
      const notes = (await getNotifications(admin.tenantId)).filter(
        (n) => n.type === SEAT_REQUEST_SUBMITTED,
      );
      expect(notes).toHaveLength(2);
      const unread = notes.filter((n) => n.readAt === null);
      expect(unread).toHaveLength(1);
    } finally {
      await deleteTenant(admin.tenantId);
    }
  });
});
