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
  fetchVerifiedEmail: vi.fn(async () => "admin@example.com"),
}));
vi.mock("./email", () => ({
  sendEmail: vi.fn(async () => true),
}));

import { db, notificationsTable, pool } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { fetchVerifiedEmail } from "./clerkUser";
import { sendEmail } from "./email";
import {
  notifySeatRequestSubmitted,
  SEAT_REQUEST_SUBMITTED,
} from "./notifications";
import {
  createTenant,
  deleteTenant,
  getNotifications,
  setNotificationPreference,
  snapshotNotificationPolicy,
  clearNotificationPolicy,
  restoreNotificationPolicy,
  purgeNotificationsByTypeSince,
} from "../test/dbHelpers";

const mockFetchEmail = vi.mocked(fetchVerifiedEmail);
const mockSendEmail = vi.mocked(sendEmail);

let policySnapshot: Awaited<ReturnType<typeof snapshotNotificationPolicy>>;
let suiteStart: Date;

beforeAll(async () => {
  suiteStart = new Date();
  policySnapshot = await snapshotNotificationPolicy(SEAT_REQUEST_SUBMITTED);
});

afterAll(async () => {
  // These notifications fan out to ALL superadmin tenants, including real
  // pre-existing ones in the dev DB — purge what this suite created so test
  // runs don't leave unread notifications on the real admin account.
  await purgeNotificationsByTypeSince(SEAT_REQUEST_SUBMITTED, suiteStart);
  await restoreNotificationPolicy(SEAT_REQUEST_SUBMITTED, policySnapshot);
  await pool.end();
});

/**
 * The dev DB can contain pre-existing superadmin tenants that also receive
 * this notification. Scope email assertions to the test's own recipient by
 * resolving a verified address ONLY for that tenant's clerkUserId.
 */
function mockEmailOnlyFor(clerkUserId: string) {
  mockFetchEmail.mockImplementation(async (id: string) =>
    id === clerkUserId ? "admin@example.com" : null,
  );
}

beforeEach(async () => {
  await clearNotificationPolicy(SEAT_REQUEST_SUBMITTED);
  vi.clearAllMocks();
  mockFetchEmail.mockResolvedValue(null);
  mockSendEmail.mockResolvedValue(true);
});

describe("notifySeatRequestSubmitted", () => {
  it("records an in-app notification for a superadmin tenant and not for a regular tenant", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    const regular = await createTenant();
    try {
      await notifySeatRequestSubmitted({
        seatRequestId: 900001,
        requestingTenantId: regular.tenantId,
        requestingTenantName: "Acme Co",
        requestedSeats: 7,
        note: "Growing team",
      });

      const adminNotes = (await getNotifications(admin.tenantId)).filter(
        (n) => n.type === SEAT_REQUEST_SUBMITTED,
      );
      expect(adminNotes).toHaveLength(1);
      expect(adminNotes[0].title).toMatch(/seat request/i);
      expect(adminNotes[0].message).toContain('"Acme Co"');
      expect(adminNotes[0].message).toContain("7 team seats");
      expect(adminNotes[0].message).toContain('Note: "Growing team"');
      expect(adminNotes[0].linkUrl).toBe("/admin");

      const regularNotes = (await getNotifications(regular.tenantId)).filter(
        (n) => n.type === SEAT_REQUEST_SUBMITTED,
      );
      expect(regularNotes).toHaveLength(0);
    } finally {
      await deleteTenant(admin.tenantId);
      await deleteTenant(regular.tenantId);
    }
  });

  it("respects the recipient's email opt-out while still recording in-app", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    try {
      mockEmailOnlyFor(admin.clerkUserId);
      await setNotificationPreference(admin.tenantId, SEAT_REQUEST_SUBMITTED, {
        inApp: true,
        email: false,
      });

      await notifySeatRequestSubmitted({
        seatRequestId: 900001,
        requestingTenantId: 999999,
        requestingTenantName: "Acme Co",
        requestedSeats: 3,
        note: null,
      });

      const notes = (await getNotifications(admin.tenantId)).filter(
        (n) => n.type === SEAT_REQUEST_SUBMITTED,
      );
      expect(notes).toHaveLength(1);
      expect(notes[0].inApp).toBe(true);
      expect(
        mockSendEmail.mock.calls.filter(
          (c) => c[0].to === "admin@example.com",
        ),
      ).toHaveLength(0);
    } finally {
      await deleteTenant(admin.tenantId);
    }
  });

  it("emails the recipient's verified address when the email channel is opted in", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    try {
      mockEmailOnlyFor(admin.clerkUserId);
      await setNotificationPreference(admin.tenantId, SEAT_REQUEST_SUBMITTED, {
        inApp: true,
        email: true,
      });

      await notifySeatRequestSubmitted({
        seatRequestId: 900001,
        requestingTenantId: 999999,
        requestingTenantName: "Acme Co",
        requestedSeats: 3,
        note: null,
      });

      const calls = mockSendEmail.mock.calls.filter(
        (c) => c[0].to === "admin@example.com",
      );
      expect(calls).toHaveLength(1);
      expect(calls[0][0].subject).toMatch(/seat request/i);
      expect(calls[0][0].text).toContain("3 team seats");
    } finally {
      await deleteTenant(admin.tenantId);
    }
  });

  it("does not stack a duplicate unread alert or re-email when the same workspace resubmits", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    try {
      mockEmailOnlyFor(admin.clerkUserId);
      await setNotificationPreference(admin.tenantId, SEAT_REQUEST_SUBMITTED, {
        inApp: true,
        email: true,
      });

      const details = {
        seatRequestId: 900002,
        requestingTenantId: 424242,
        requestingTenantName: "Acme Co",
        requestedSeats: 3,
        note: null,
      };
      await notifySeatRequestSubmitted(details);
      // Resubmit with different content — still the same workspace.
      await notifySeatRequestSubmitted({ ...details, requestedSeats: 9 });

      const notes = (await getNotifications(admin.tenantId)).filter(
        (n) => n.type === SEAT_REQUEST_SUBMITTED,
      );
      expect(notes).toHaveLength(1);
      expect(
        mockSendEmail.mock.calls.filter(
          (c) => c[0].to === "admin@example.com",
        ),
      ).toHaveLength(1);
    } finally {
      await deleteTenant(admin.tenantId);
    }
  });

  it("updates the unread alert's message in place when the same workspace resubmits with new details", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    try {
      mockEmailOnlyFor(admin.clerkUserId);
      await setNotificationPreference(admin.tenantId, SEAT_REQUEST_SUBMITTED, {
        inApp: true,
        email: true,
      });

      await notifySeatRequestSubmitted({
        seatRequestId: 987654,
        requestingTenantId: 424242,
        requestingTenantName: "Acme Co",
        requestedSeats: 3,
        note: null,
      });
      await notifySeatRequestSubmitted({
        seatRequestId: 987654,
        requestingTenantId: 424242,
        requestingTenantName: "Acme Co",
        requestedSeats: 9,
        note: "We hired more people",
      });

      const notes = (await getNotifications(admin.tenantId)).filter(
        (n) => n.type === SEAT_REQUEST_SUBMITTED,
      );
      expect(notes).toHaveLength(1);
      expect(notes[0].message).toContain("9 team seats");
      expect(notes[0].message).toContain('Note: "We hired more people"');
      expect(notes[0].message).not.toContain("3 team seats");
      // Still exactly one email — the in-place update must not re-email.
      expect(
        mockSendEmail.mock.calls.filter(
          (c) => c[0].to === "admin@example.com",
        ),
      ).toHaveLength(1);
    } finally {
      await deleteTenant(admin.tenantId);
    }
  });

  it("still alerts for a request from a different workspace", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    try {
      await notifySeatRequestSubmitted({
        seatRequestId: 900001,
        requestingTenantId: 424242,
        requestingTenantName: "Acme Co",
        requestedSeats: 3,
        note: null,
      });
      await notifySeatRequestSubmitted({
        seatRequestId: 900001,
        requestingTenantId: 535353,
        requestingTenantName: "Beta Inc",
        requestedSeats: 5,
        note: null,
      });

      const notes = (await getNotifications(admin.tenantId)).filter(
        (n) => n.type === SEAT_REQUEST_SUBMITTED,
      );
      expect(notes).toHaveLength(2);
      const messages = notes.map((n) => n.message).join(" | ");
      expect(messages).toContain('"Acme Co"');
      expect(messages).toContain('"Beta Inc"');
    } finally {
      await deleteTenant(admin.tenantId);
    }
  });

  it("re-arms the dedupe once the admin reads the alert", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    try {
      const details = {
        seatRequestId: 900002,
        requestingTenantId: 424242,
        requestingTenantName: "Acme Co",
        requestedSeats: 3,
        note: null,
      };
      await notifySeatRequestSubmitted(details);

      // Admin dismisses the banner.
      await db
        .update(notificationsTable)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(notificationsTable.tenantId, admin.tenantId),
            eq(notificationsTable.type, SEAT_REQUEST_SUBMITTED),
          ),
        );

      await notifySeatRequestSubmitted(details);

      const notes = (await getNotifications(admin.tenantId)).filter(
        (n) => n.type === SEAT_REQUEST_SUBMITTED,
      );
      expect(notes).toHaveLength(2);
    } finally {
      await deleteTenant(admin.tenantId);
    }
  });
});
