import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";

// Stub the side channels (Clerk email lookup + SendGrid) so the test is hermetic.
vi.mock("./clerkUser", () => ({
  fetchVerifiedEmail: vi.fn(async () => null),
}));
vi.mock("./email", () => ({
  sendEmail: vi.fn(async () => true),
}));

import { db, notificationsTable, pool } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { fetchVerifiedEmail } from "./clerkUser";
import { sendEmail } from "./email";
import { notifyUpgradeRequested, UPGRADE_REQUESTED } from "./notifications";
import {
  createTenant,
  deleteTenant,
  getNotifications,
  setNotificationPreference,
  snapshotNotificationPolicy,
  clearNotificationPolicy,
  restoreNotificationPolicy,
} from "../test/dbHelpers";

const mockFetchEmail = vi.mocked(fetchVerifiedEmail);
const mockSendEmail = vi.mocked(sendEmail);

let policySnapshot: Awaited<ReturnType<typeof snapshotNotificationPolicy>>;

beforeAll(async () => {
  policySnapshot = await snapshotNotificationPolicy(UPGRADE_REQUESTED);
});

afterAll(async () => {
  await restoreNotificationPolicy(UPGRADE_REQUESTED, policySnapshot);
  await pool.end();
});

beforeEach(async () => {
  await clearNotificationPolicy(UPGRADE_REQUESTED);
  vi.clearAllMocks();
  mockFetchEmail.mockResolvedValue(null);
  mockSendEmail.mockResolvedValue(true);
});

const requester = { email: "member@example.com", clerkUserId: "member_clerk" };

describe("notifyUpgradeRequested", () => {
  it("records a fresh in-app notification naming the requester", async () => {
    const tenant = await createTenant();
    try {
      const outcome = await notifyUpgradeRequested(tenant.tenantId, requester);
      expect(outcome).toBe("created");

      const notes = (await getNotifications(tenant.tenantId)).filter(
        (n) => n.type === UPGRADE_REQUESTED,
      );
      expect(notes).toHaveLength(1);
      expect(notes[0].title).toMatch(/upgrade/i);
      expect(notes[0].message).toContain("member@example.com");
      expect(notes[0].linkUrl).toBe("/settings");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("emails the OWNER's verified address when the email channel is on", async () => {
    const tenant = await createTenant();
    try {
      mockFetchEmail.mockImplementation(async (id: string) =>
        id === tenant.clerkUserId ? "owner@example.com" : null,
      );
      await setNotificationPreference(tenant.tenantId, UPGRADE_REQUESTED, {
        inApp: true,
        email: true,
      });

      await notifyUpgradeRequested(tenant.tenantId, requester);

      const calls = mockSendEmail.mock.calls.filter(
        (c) => c[0].to === "owner@example.com",
      );
      expect(calls).toHaveLength(1);
      expect(calls[0][0].subject).toMatch(/upgrade/i);
      expect(calls[0][0].text).toContain("member@example.com");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("respects the workspace's email opt-out while still recording in-app", async () => {
    const tenant = await createTenant();
    try {
      mockFetchEmail.mockResolvedValue("owner@example.com");
      await setNotificationPreference(tenant.tenantId, UPGRADE_REQUESTED, {
        inApp: true,
        email: false,
      });

      await notifyUpgradeRequested(tenant.tenantId, requester);

      const notes = (await getNotifications(tenant.tenantId)).filter(
        (n) => n.type === UPGRADE_REQUESTED,
      );
      expect(notes).toHaveLength(1);
      expect(mockSendEmail).not.toHaveBeenCalled();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("updates an existing UNREAD alert in place instead of stacking or re-emailing", async () => {
    const tenant = await createTenant();
    try {
      mockFetchEmail.mockResolvedValue("owner@example.com");
      await setNotificationPreference(tenant.tenantId, UPGRADE_REQUESTED, {
        inApp: true,
        email: true,
      });

      await notifyUpgradeRequested(tenant.tenantId, requester);
      const outcome = await notifyUpgradeRequested(tenant.tenantId, {
        email: "other@example.com",
        clerkUserId: "other_clerk",
      });
      expect(outcome).toBe("updated");

      const notes = (await getNotifications(tenant.tenantId)).filter(
        (n) => n.type === UPGRADE_REQUESTED,
      );
      expect(notes).toHaveLength(1);
      // Updated in place with the latest requester.
      expect(notes[0].message).toContain("other@example.com");
      // Still exactly one email — the in-place update must not re-email.
      expect(mockSendEmail).toHaveBeenCalledTimes(1);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("enforces the cooldown after the alert is read, then allows a fresh one", async () => {
    const tenant = await createTenant();
    try {
      await notifyUpgradeRequested(tenant.tenantId, requester);

      // Owner reads the alert — the unread dedupe re-arms, but the recent
      // request is still inside the cooldown window.
      await db
        .update(notificationsTable)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(notificationsTable.tenantId, tenant.tenantId),
            eq(notificationsTable.type, UPGRADE_REQUESTED),
          ),
        );

      const blocked = await notifyUpgradeRequested(tenant.tenantId, requester);
      expect(blocked).toBe("cooldown");

      // Age the last request past the cooldown; a fresh alert is allowed.
      await db
        .update(notificationsTable)
        .set({ createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
        .where(
          and(
            eq(notificationsTable.tenantId, tenant.tenantId),
            eq(notificationsTable.type, UPGRADE_REQUESTED),
          ),
        );

      const outcome = await notifyUpgradeRequested(tenant.tenantId, requester);
      expect(outcome).toBe("created");

      const notes = (await getNotifications(tenant.tenantId)).filter(
        (n) => n.type === UPGRADE_REQUESTED,
      );
      expect(notes).toHaveLength(2);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});
