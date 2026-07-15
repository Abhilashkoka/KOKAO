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

import { pool } from "@workspace/db";
import { createTestApp } from "../test/testApp";
import { resetAuthState, actAs } from "../test/authState";
import {
  createTenant,
  deleteTenant,
  insertLinkedinAccount,
  insertThreadsAccount,
  getConnectedAccount,
} from "../test/dbHelpers";

const app = createTestApp();

const LI_SECRET = "li_disconnect_secret_token_XYZ789";
const TH_SECRET = "th_disconnect_secret_token_XYZ789";

beforeAll(() => {
  process.env.SESSION_SECRET ||= "test-session-secret-value";
});

beforeEach(() => {
  resetAuthState();
});

afterAll(async () => {
  await pool.end();
});

// ---------------------------------------------------------------------------
// LinkedIn / Threads disconnect
//
// DELETE /linkedin and DELETE /threads perform a SOFT disconnect: the row is
// kept (status "disconnected") but every credential-bearing field —
// accessToken, tokenExpiresAt, providerUserId — must be scrubbed to null. A
// regression that leaves the token behind would keep a live OAuth grant in
// the database after the user believes it's gone. These tests guard the
// scrub, the "not connected" response, the safe no-op when nothing is
// connected, and tenant isolation.
// ---------------------------------------------------------------------------

describe("LinkedIn disconnect endpoint", () => {
  it("scrubs stored OAuth credentials and reports not connected", async () => {
    const tenant = await createTenant();
    try {
      await insertLinkedinAccount(tenant.tenantId, {
        accessToken: LI_SECRET,
        providerUserId: "li_person_del",
        tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });
      // Sanity check: the token really is stored before the disconnect.
      const before = await getConnectedAccount(tenant.tenantId, "linkedin");
      expect(before?.accessToken).toBe(LI_SECRET);

      actAs(tenant.clerkUserId);
      const res = await request(app).delete("/api/linkedin");

      // Response is the "not connected" state with no leaked token.
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(false);
      expect(res.body.expired).toBe(false);
      expect(res.body.accountName).toBeNull();
      expect(JSON.stringify(res.body)).not.toContain(LI_SECRET);

      // Every credential-bearing field is scrubbed — no stale OAuth grant.
      const after = await getConnectedAccount(tenant.tenantId, "linkedin");
      expect(after).toBeDefined();
      expect(after?.status).toBe("disconnected");
      expect(after?.accessToken).toBeNull();
      expect(after?.tokenExpiresAt).toBeNull();
      expect(after?.providerUserId).toBeNull();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("reads back as not connected after a disconnect", async () => {
    const tenant = await createTenant();
    try {
      await insertLinkedinAccount(tenant.tenantId, {
        accessToken: LI_SECRET,
      });
      actAs(tenant.clerkUserId);
      await request(app).delete("/api/linkedin");

      const status = await request(app).get("/api/linkedin/status");
      expect(status.status).toBe(200);
      expect(status.body.connected).toBe(false);
      expect(status.body.expired).toBe(false);
      expect(status.body.accountName).toBeNull();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("is a safe no-op when nothing is connected", async () => {
    const tenant = await createTenant();
    try {
      expect(
        await getConnectedAccount(tenant.tenantId, "linkedin"),
      ).toBeUndefined();

      actAs(tenant.clerkUserId);
      const res = await request(app).delete("/api/linkedin");

      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(false);

      // The no-op didn't create a row.
      expect(
        await getConnectedAccount(tenant.tenantId, "linkedin"),
      ).toBeUndefined();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("leaves another tenant's stored connection intact", async () => {
    const owner = await createTenant();
    const other = await createTenant();
    try {
      await insertLinkedinAccount(owner.tenantId, {
        accessToken: LI_SECRET,
        providerUserId: "li_person_owner",
      });
      await insertLinkedinAccount(other.tenantId, {
        accessToken: "li_other_token",
        providerUserId: "li_person_other",
      });

      // `other` disconnects — only their own row may change.
      actAs(other.clerkUserId);
      const res = await request(app).delete("/api/linkedin");
      expect(res.status).toBe(200);

      const otherRow = await getConnectedAccount(other.tenantId, "linkedin");
      expect(otherRow?.accessToken).toBeNull();
      expect(otherRow?.status).toBe("disconnected");

      // Owner's credentials are untouched in the DB.
      const ownerRow = await getConnectedAccount(owner.tenantId, "linkedin");
      expect(ownerRow?.accessToken).toBe(LI_SECRET);
      expect(ownerRow?.providerUserId).toBe("li_person_owner");
      expect(ownerRow?.status).toBe("connected");
    } finally {
      await deleteTenant(owner.tenantId);
      await deleteTenant(other.tenantId);
    }
  });
});

describe("Threads disconnect endpoint", () => {
  it("scrubs stored OAuth credentials and reports not connected", async () => {
    const tenant = await createTenant();
    try {
      await insertThreadsAccount(tenant.tenantId, {
        accessToken: TH_SECRET,
        providerUserId: "th_user_del",
        tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });
      const before = await getConnectedAccount(tenant.tenantId, "threads");
      expect(before?.accessToken).toBe(TH_SECRET);

      actAs(tenant.clerkUserId);
      const res = await request(app).delete("/api/threads");

      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(false);
      expect(res.body.expired).toBe(false);
      expect(res.body.accountName).toBeNull();
      expect(JSON.stringify(res.body)).not.toContain(TH_SECRET);

      const after = await getConnectedAccount(tenant.tenantId, "threads");
      expect(after).toBeDefined();
      expect(after?.status).toBe("disconnected");
      expect(after?.accessToken).toBeNull();
      expect(after?.tokenExpiresAt).toBeNull();
      expect(after?.providerUserId).toBeNull();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("reads back as not connected after a disconnect", async () => {
    const tenant = await createTenant();
    try {
      await insertThreadsAccount(tenant.tenantId, {
        accessToken: TH_SECRET,
      });
      actAs(tenant.clerkUserId);
      await request(app).delete("/api/threads");

      const status = await request(app).get("/api/threads/status");
      expect(status.status).toBe(200);
      expect(status.body.connected).toBe(false);
      expect(status.body.expired).toBe(false);
      expect(status.body.accountName).toBeNull();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("is a safe no-op when nothing is connected", async () => {
    const tenant = await createTenant();
    try {
      expect(
        await getConnectedAccount(tenant.tenantId, "threads"),
      ).toBeUndefined();

      actAs(tenant.clerkUserId);
      const res = await request(app).delete("/api/threads");

      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(false);

      expect(
        await getConnectedAccount(tenant.tenantId, "threads"),
      ).toBeUndefined();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("leaves another tenant's stored connection intact", async () => {
    const owner = await createTenant();
    const other = await createTenant();
    try {
      await insertThreadsAccount(owner.tenantId, {
        accessToken: TH_SECRET,
        providerUserId: "th_user_owner",
      });
      await insertThreadsAccount(other.tenantId, {
        accessToken: "th_other_token",
        providerUserId: "th_user_other",
      });

      actAs(other.clerkUserId);
      const res = await request(app).delete("/api/threads");
      expect(res.status).toBe(200);

      const otherRow = await getConnectedAccount(other.tenantId, "threads");
      expect(otherRow?.accessToken).toBeNull();
      expect(otherRow?.status).toBe("disconnected");

      const ownerRow = await getConnectedAccount(owner.tenantId, "threads");
      expect(ownerRow?.accessToken).toBe(TH_SECRET);
      expect(ownerRow?.providerUserId).toBe("th_user_owner");
      expect(ownerRow?.status).toBe("connected");
    } finally {
      await deleteTenant(owner.tenantId);
      await deleteTenant(other.tenantId);
    }
  });

  it("does not disconnect when unauthenticated (401)", async () => {
    const tenant = await createTenant();
    try {
      await insertThreadsAccount(tenant.tenantId, {
        accessToken: TH_SECRET,
      });
      resetAuthState(); // no current user

      const liRes = await request(app).delete("/api/linkedin");
      expect(liRes.status).toBe(401);
      const thRes = await request(app).delete("/api/threads");
      expect(thRes.status).toBe(401);

      // The stored credentials were not touched.
      const row = await getConnectedAccount(tenant.tenantId, "threads");
      expect(row?.accessToken).toBe(TH_SECRET);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});
