import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";

// Hermetic side channels: no real Clerk lookups or SendGrid sends.
vi.mock("./clerkUser", () => ({
  fetchVerifiedEmail: vi.fn(async (id: string) => `${id}@example.com`),
}));
vi.mock("./email", () => ({
  sendEmail: vi.fn(async () => true),
}));

import {
  db,
  pool,
  memberNotificationPreferencesTable,
  tenantMembersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { fetchVerifiedEmail } from "./clerkUser";
import { sendEmail } from "./email";
import {
  notifyTeamMemberRemoved,
  notifySeatRequestDecided,
  TEAM_MEMBER_REMOVED,
  SEAT_REQUEST_DECIDED,
} from "./notifications";
import {
  createTenant,
  deleteTenant,
  setNotificationPolicy,
  snapshotNotificationPolicy,
  clearNotificationPolicy,
  restoreNotificationPolicy,
} from "../test/dbHelpers";

const mockFetchEmail = vi.mocked(fetchVerifiedEmail);
const mockSendEmail = vi.mocked(sendEmail);

const TYPES = [TEAM_MEMBER_REMOVED, SEAT_REQUEST_DECIDED];

let policySnapshots: Map<
  string,
  Awaited<ReturnType<typeof snapshotNotificationPolicy>>
>;

beforeAll(async () => {
  policySnapshots = new Map();
  for (const type of TYPES) {
    policySnapshots.set(type, await snapshotNotificationPolicy(type));
  }
});

afterAll(async () => {
  for (const type of TYPES) {
    await restoreNotificationPolicy(type, policySnapshots.get(type)!);
  }
  await pool.end();
});

beforeEach(async () => {
  for (const type of TYPES) {
    await clearNotificationPolicy(type);
  }
  vi.clearAllMocks();
  mockFetchEmail.mockImplementation(async (id: string) => `${id}@example.com`);
  mockSendEmail.mockResolvedValue(true);
});

async function addAdmin(tenantId: number): Promise<string> {
  const clerkUserId = `test_admin_${randomUUID()}`;
  await db.insert(tenantMembersTable).values({
    tenantId,
    clerkUserId,
    email: `${clerkUserId}@example.com`,
    role: "admin",
  });
  return clerkUserId;
}

async function setMemberEmailPref(
  tenantId: number,
  clerkUserId: string,
  type: string,
  email: boolean,
) {
  await db.insert(memberNotificationPreferencesTable).values({
    tenantId,
    clerkUserId,
    type,
    inApp: true,
    email,
  });
}

async function cleanup(tenantId: number) {
  await db
    .delete(memberNotificationPreferencesTable)
    .where(eq(memberNotificationPreferencesTable.tenantId, tenantId));
  await db
    .delete(tenantMembersTable)
    .where(eq(tenantMembersTable.tenantId, tenantId));
  await deleteTenant(tenantId);
}

function sentRecipients(): string[] {
  return mockSendEmail.mock.calls.map((c) => c[0].to);
}

describe("notifyTeamMemberRemoved member-scoped email opt-out", () => {
  it("skips an admin who opted out while still emailing the owner and other admins", async () => {
    const tenant = await createTenant();
    try {
      const optedOut = await addAdmin(tenant.tenantId);
      const stillIn = await addAdmin(tenant.tenantId);
      await setMemberEmailPref(
        tenant.tenantId,
        optedOut,
        TEAM_MEMBER_REMOVED,
        false,
      );

      await notifyTeamMemberRemoved(
        tenant.tenantId,
        { email: "removed@example.com", role: "member" },
        { email: "actor@example.com", clerkUserId: "test_actor" },
      );

      const recipients = sentRecipients();
      expect(recipients).toContain(`${tenant.clerkUserId}@example.com`);
      expect(recipients).toContain(`${stillIn}@example.com`);
      expect(recipients).not.toContain(`${optedOut}@example.com`);
    } finally {
      await cleanup(tenant.tenantId);
    }
  });

  it("still emails admins with no stored member preference (default is on)", async () => {
    const tenant = await createTenant();
    try {
      const admin = await addAdmin(tenant.tenantId);

      await notifyTeamMemberRemoved(
        tenant.tenantId,
        { email: "removed@example.com", role: "member" },
        { email: "actor@example.com", clerkUserId: "test_actor" },
      );

      expect(sentRecipients()).toContain(`${admin}@example.com`);
    } finally {
      await cleanup(tenant.tenantId);
    }
  });

  it("ignores the member opt-out when the global policy forces email", async () => {
    await setNotificationPolicy(TEAM_MEMBER_REMOVED, {
      enabled: true,
      emailPolicy: "forced",
    });
    const tenant = await createTenant();
    try {
      const optedOut = await addAdmin(tenant.tenantId);
      await setMemberEmailPref(
        tenant.tenantId,
        optedOut,
        TEAM_MEMBER_REMOVED,
        false,
      );

      await notifyTeamMemberRemoved(
        tenant.tenantId,
        { email: "removed@example.com", role: "member" },
        { email: "actor@example.com", clerkUserId: "test_actor" },
      );

      expect(sentRecipients()).toContain(`${optedOut}@example.com`);
    } finally {
      await cleanup(tenant.tenantId);
    }
  });
});

describe("notifySeatRequestDecided member-scoped email opt-out", () => {
  it("skips an admin who opted out while still emailing the owner and other admins", async () => {
    const tenant = await createTenant();
    try {
      const optedOut = await addAdmin(tenant.tenantId);
      const stillIn = await addAdmin(tenant.tenantId);
      await setMemberEmailPref(
        tenant.tenantId,
        optedOut,
        SEAT_REQUEST_DECIDED,
        false,
      );

      await notifySeatRequestDecided(tenant.tenantId, {
        approved: true,
        grantedSeats: 5,
      });

      const recipients = sentRecipients();
      expect(recipients).toContain(`${tenant.clerkUserId}@example.com`);
      expect(recipients).toContain(`${stillIn}@example.com`);
      expect(recipients).not.toContain(`${optedOut}@example.com`);
    } finally {
      await cleanup(tenant.tenantId);
    }
  });

  it("still emails admins with no stored member preference (default is on)", async () => {
    const tenant = await createTenant();
    try {
      const admin = await addAdmin(tenant.tenantId);

      await notifySeatRequestDecided(tenant.tenantId, {
        approved: false,
        grantedSeats: null,
      });

      expect(sentRecipients()).toContain(`${admin}@example.com`);
    } finally {
      await cleanup(tenant.tenantId);
    }
  });

  it("ignores the member opt-out when the global policy forces email", async () => {
    await setNotificationPolicy(SEAT_REQUEST_DECIDED, {
      enabled: true,
      emailPolicy: "forced",
    });
    const tenant = await createTenant();
    try {
      const optedOut = await addAdmin(tenant.tenantId);
      await setMemberEmailPref(
        tenant.tenantId,
        optedOut,
        SEAT_REQUEST_DECIDED,
        false,
      );

      await notifySeatRequestDecided(tenant.tenantId, {
        approved: true,
        grantedSeats: 3,
      });

      expect(sentRecipients()).toContain(`${optedOut}@example.com`);
    } finally {
      await cleanup(tenant.tenantId);
    }
  });
});
