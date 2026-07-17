import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
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

// Keep the settings route hermetic: the GET handler calls isEmailConfigured,
// which would otherwise hit the SendGrid connectors proxy over the network.
vi.mock("../lib/email", () => ({
  isEmailConfigured: vi.fn(async () => false),
}));

import { randomUUID } from "node:crypto";
import {
  db,
  pool,
  memberNotificationPreferencesTable,
  tenantMembersTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { createTestApp } from "../test/testApp";
import { resetAuthState, actAs } from "../test/authState";
import { SOCIAL_CONNECTION_FAILED } from "../lib/notifications";
import {
  createTenant,
  deleteTenant,
  getNotificationPreference,
  setNotificationPolicy,
  snapshotNotificationPolicy,
  clearNotificationPolicy,
  restoreNotificationPolicy,
} from "../test/dbHelpers";

const app = createTestApp();

let policySnapshot: Awaited<ReturnType<typeof snapshotNotificationPolicy>>;

beforeAll(async () => {
  policySnapshot = await snapshotNotificationPolicy(SOCIAL_CONNECTION_FAILED);
});

afterAll(async () => {
  await restoreNotificationPolicy(SOCIAL_CONNECTION_FAILED, policySnapshot);
  await pool.end();
});

beforeEach(async () => {
  resetAuthState();
  // Default policy (optional) unless a test overrides it.
  await clearNotificationPolicy(SOCIAL_CONNECTION_FAILED);
});

describe("GET /notification-settings", () => {
  it("returns the folded effective settings with defaults when nothing is stored", async () => {
    const tenant = await createTenant();
    try {
      actAs(tenant.clerkUserId);

      const res = await request(app).get("/api/notification-settings");
      expect(res.status).toBe(200);
      expect(res.body.emailConfigured).toBe(false);

      const type = res.body.types.find(
        (t: { type: string }) => t.type === SOCIAL_CONNECTION_FAILED,
      );
      expect(type).toBeDefined();
      // No policy row and no preference row -> built-in defaults.
      expect(type.enabled).toBe(true);
      expect(type.emailPolicy).toBe("optional");
      expect(type.preference).toEqual({ inApp: true, email: true });
      expect(type.effective).toMatchObject({ inApp: true, email: true });
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("folds a global policy over the stored preference in the effective channels", async () => {
    await setNotificationPolicy(SOCIAL_CONNECTION_FAILED, {
      enabled: true,
      emailPolicy: "off",
    });
    const tenant = await createTenant();
    try {
      actAs(tenant.clerkUserId);
      // Tenant opts into email, but the "off" policy must win in `effective`.
      await request(app)
        .put("/api/notification-settings")
        .send({
          preferences: [
            { type: SOCIAL_CONNECTION_FAILED, inApp: true, email: true },
          ],
        });

      const res = await request(app).get("/api/notification-settings");
      expect(res.status).toBe(200);
      const type = res.body.types.find(
        (t: { type: string }) => t.type === SOCIAL_CONNECTION_FAILED,
      );
      // Raw preference reflects what the toggle stored...
      expect(type.preference).toEqual({ inApp: true, email: true });
      // ...but the effective email channel is forced off by policy.
      expect(type.emailPolicy).toBe("off");
      expect(type.effective).toMatchObject({ inApp: true, email: false });
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});

describe("PUT /notification-settings", () => {
  it("persists a preference and returns the updated settings", async () => {
    const tenant = await createTenant();
    try {
      actAs(tenant.clerkUserId);

      const res = await request(app)
        .put("/api/notification-settings")
        .send({
          preferences: [
            { type: SOCIAL_CONNECTION_FAILED, inApp: true, email: false },
          ],
        });
      expect(res.status).toBe(200);

      // Persisted to the DB.
      const stored = await getNotificationPreference(
        tenant.tenantId,
        SOCIAL_CONNECTION_FAILED,
      );
      expect(stored.inApp).toBe(true);
      expect(stored.email).toBe(false);

      // Echoed back in the response payload.
      const type = res.body.types.find(
        (t: { type: string }) => t.type === SOCIAL_CONNECTION_FAILED,
      );
      expect(type.preference).toEqual({ inApp: true, email: false });
      // Default policy is "optional", so the tenant's choice takes effect.
      expect(type.effective).toMatchObject({ inApp: true, email: false });
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("rejects unknown notification types with 400 and writes nothing", async () => {
    const tenant = await createTenant();
    try {
      actAs(tenant.clerkUserId);

      const res = await request(app)
        .put("/api/notification-settings")
        .send({
          preferences: [
            { type: "totally_made_up_type", inApp: true, email: false },
          ],
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/unknown notification type/i);

      // No preference row should have been written for the bogus type.
      const stored = await getNotificationPreference(
        tenant.tenantId,
        "totally_made_up_type",
      );
      expect(stored).toBeUndefined();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("rejects a malformed body with 400", async () => {
    const tenant = await createTenant();
    try {
      actAs(tenant.clerkUserId);

      const res = await request(app)
        .put("/api/notification-settings")
        .send({ preferences: [{ type: SOCIAL_CONNECTION_FAILED }] });
      expect(res.status).toBe(400);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("stores a team member's choices member-scoped, leaving the owner's preferences untouched", async () => {
    const tenant = await createTenant();
    const memberClerkUserId = `test_member_${randomUUID()}`;
    try {
      // Owner opts INTO email for this type (tenant-scoped row).
      actAs(tenant.clerkUserId);
      await request(app)
        .put("/api/notification-settings")
        .send({
          preferences: [
            { type: SOCIAL_CONNECTION_FAILED, inApp: true, email: true },
          ],
        });

      // An admin member of the same workspace turns email OFF for themselves.
      await db.insert(tenantMembersTable).values({
        tenantId: tenant.tenantId,
        clerkUserId: memberClerkUserId,
        email: `${memberClerkUserId}@example.com`,
        role: "admin",
      });
      actAs(memberClerkUserId);

      const put = await request(app)
        .put("/api/notification-settings")
        .send({
          preferences: [
            { type: SOCIAL_CONNECTION_FAILED, inApp: true, email: false },
          ],
        });
      expect(put.status).toBe(200);
      expect(put.body.scope).toBe("member");
      const putType = put.body.types.find(
        (t: { type: string }) => t.type === SOCIAL_CONNECTION_FAILED,
      );
      expect(putType.preference).toEqual({ inApp: true, email: false });

      // Member-scoped row exists...
      const memberRows = await db
        .select()
        .from(memberNotificationPreferencesTable)
        .where(
          and(
            eq(memberNotificationPreferencesTable.tenantId, tenant.tenantId),
            eq(
              memberNotificationPreferencesTable.clerkUserId,
              memberClerkUserId,
            ),
          ),
        );
      expect(memberRows).toHaveLength(1);
      expect(memberRows[0].email).toBe(false);

      // ...and the OWNER's tenant-scoped preference is untouched.
      const ownerStored = await getNotificationPreference(
        tenant.tenantId,
        SOCIAL_CONNECTION_FAILED,
      );
      expect(ownerStored.email).toBe(true);

      // GET as the member reflects the member-scoped choice with scope=member.
      const memberGet = await request(app).get("/api/notification-settings");
      expect(memberGet.body.scope).toBe("member");
      const memberType = memberGet.body.types.find(
        (t: { type: string }) => t.type === SOCIAL_CONNECTION_FAILED,
      );
      expect(memberType.preference).toEqual({ inApp: true, email: false });

      // GET as the owner still shows the owner's own choice with scope=workspace.
      actAs(tenant.clerkUserId);
      const ownerGet = await request(app).get("/api/notification-settings");
      expect(ownerGet.body.scope).toBe("workspace");
      const ownerType = ownerGet.body.types.find(
        (t: { type: string }) => t.type === SOCIAL_CONNECTION_FAILED,
      );
      expect(ownerType.preference).toEqual({ inApp: true, email: true });
    } finally {
      await db
        .delete(memberNotificationPreferencesTable)
        .where(
          eq(memberNotificationPreferencesTable.tenantId, tenant.tenantId),
        );
      await db
        .delete(tenantMembersTable)
        .where(eq(tenantMembersTable.tenantId, tenant.tenantId));
      await deleteTenant(tenant.tenantId);
    }
  });

  it("requires authentication", async () => {
    const res = await request(app)
      .put("/api/notification-settings")
      .send({
        preferences: [
          { type: SOCIAL_CONNECTION_FAILED, inApp: true, email: false },
        ],
      });
    expect(res.status).toBe(401);
  });
});
