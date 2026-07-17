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
import { notifyTeamMemberLeft, TEAM_MEMBER_LEFT } from "./notifications";
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

let policySnapshot: Awaited<ReturnType<typeof snapshotNotificationPolicy>>;

beforeAll(async () => {
  policySnapshot = await snapshotNotificationPolicy(TEAM_MEMBER_LEFT);
});

afterAll(async () => {
  await restoreNotificationPolicy(TEAM_MEMBER_LEFT, policySnapshot);
  await pool.end();
});

beforeEach(async () => {
  await clearNotificationPolicy(TEAM_MEMBER_LEFT);
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
  email: boolean,
) {
  await db.insert(memberNotificationPreferencesTable).values({
    tenantId,
    clerkUserId,
    type: TEAM_MEMBER_LEFT,
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

describe("notifyTeamMemberLeft member-scoped email opt-out", () => {
  it("skips an admin who opted out while still emailing the owner and other admins", async () => {
    const tenant = await createTenant();
    try {
      const optedOut = await addAdmin(tenant.tenantId);
      const stillIn = await addAdmin(tenant.tenantId);
      await setMemberEmailPref(tenant.tenantId, optedOut, false);

      await notifyTeamMemberLeft(tenant.tenantId, {
        email: "leaver@example.com",
        role: "member",
        clerkUserId: "test_leaver",
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

      await notifyTeamMemberLeft(tenant.tenantId, {
        email: "leaver@example.com",
        role: "member",
        clerkUserId: "test_leaver",
      });

      expect(sentRecipients()).toContain(`${admin}@example.com`);
    } finally {
      await cleanup(tenant.tenantId);
    }
  });

  it("ignores the member opt-out when the global policy forces email", async () => {
    await setNotificationPolicy(TEAM_MEMBER_LEFT, {
      enabled: true,
      emailPolicy: "forced",
    });
    const tenant = await createTenant();
    try {
      const optedOut = await addAdmin(tenant.tenantId);
      await setMemberEmailPref(tenant.tenantId, optedOut, false);

      await notifyTeamMemberLeft(tenant.tenantId, {
        email: "leaver@example.com",
        role: "member",
        clerkUserId: "test_leaver",
      });

      expect(sentRecipients()).toContain(`${optedOut}@example.com`);
    } finally {
      await cleanup(tenant.tenantId);
    }
  });
});
