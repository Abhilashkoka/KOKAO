import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
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
  insertContentItem,
} from "../test/dbHelpers";

const app = createTestApp();

// A distinctive secret token value we can search for in every response body.
const SECRET_TOKEN = "li_super_secret_access_token_ABC123";

beforeAll(() => {
  // OAuth state signing needs a session secret; configure enough that the
  // "configured" flag is true where relevant. Real network is never called.
  process.env.LINKEDIN_CLIENT_ID ||= "test-client-id";
  process.env.LINKEDIN_CLIENT_SECRET ||= "test-client-secret";
  process.env.SESSION_SECRET ||= "test-session-secret-value";
});

beforeEach(() => {
  resetAuthState();
});

afterAll(async () => {
  await pool.end();
});

function bodyContainsToken(body: unknown, token: string): boolean {
  return JSON.stringify(body).includes(token);
}

describe("LinkedIn token leakage", () => {
  it("never returns the raw access token from GET /linkedin/status", async () => {
    const tenant = await createTenant();
    try {
      await insertLinkedinAccount(tenant.tenantId, {
        accessToken: SECRET_TOKEN,
        providerUserId: "person_1",
      });
      actAs(tenant.clerkUserId);

      const res = await request(app).get("/api/linkedin/status");
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(true);
      expect(res.body.accessToken).toBeUndefined();
      expect(bodyContainsToken(res.body, SECRET_TOKEN)).toBe(false);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("never returns the raw access token from DELETE /linkedin", async () => {
    const tenant = await createTenant();
    try {
      await insertLinkedinAccount(tenant.tenantId, {
        accessToken: SECRET_TOKEN,
        providerUserId: "person_1",
      });
      actAs(tenant.clerkUserId);

      const res = await request(app).delete("/api/linkedin");
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(false);
      expect(bodyContainsToken(res.body, SECRET_TOKEN)).toBe(false);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});

describe("LinkedIn tenant isolation", () => {
  it("GET /linkedin/status only reflects the caller's own connection", async () => {
    const owner = await createTenant();
    const other = await createTenant();
    try {
      // Only `owner` has a LinkedIn connection.
      await insertLinkedinAccount(owner.tenantId, {
        accessToken: SECRET_TOKEN,
        providerUserId: "person_owner",
        accountName: "Owner LinkedIn",
      });

      // The other tenant must not see the owner's connection.
      actAs(other.clerkUserId);
      const res = await request(app).get("/api/linkedin/status");
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(false);
      expect(res.body.accountName).toBeNull();
      expect(bodyContainsToken(res.body, SECRET_TOKEN)).toBe(false);
    } finally {
      await deleteTenant(owner.tenantId);
      await deleteTenant(other.tenantId);
    }
  });

  it("cannot publish another tenant's content (404, no cross-tenant data)", async () => {
    const owner = await createTenant();
    const attacker = await createTenant();
    try {
      const itemId = await insertContentItem(owner.tenantId);
      // Attacker has a fully valid LinkedIn connection of their own.
      await insertLinkedinAccount(attacker.tenantId, {
        accessToken: SECRET_TOKEN,
        providerUserId: "person_attacker",
      });
      actAs(attacker.clerkUserId);

      const res = await request(app).post(
        `/api/content/${itemId}/publish-linkedin`,
      );
      expect(res.status).toBe(404);
      expect(bodyContainsToken(res.body, SECRET_TOKEN)).toBe(false);
    } finally {
      await deleteTenant(owner.tenantId);
      await deleteTenant(attacker.tenantId);
    }
  });

  it("DELETE /linkedin does not touch another tenant's connection", async () => {
    const owner = await createTenant();
    const attacker = await createTenant();
    try {
      await insertLinkedinAccount(owner.tenantId, {
        accessToken: SECRET_TOKEN,
        providerUserId: "person_owner",
      });
      // Attacker disconnects their own (nonexistent) connection.
      actAs(attacker.clerkUserId);
      const delRes = await request(app).delete("/api/linkedin");
      expect(delRes.status).toBe(200);

      // The owner's connection is still intact and still usable.
      actAs(owner.clerkUserId);
      const statusRes = await request(app).get("/api/linkedin/status");
      expect(statusRes.body.connected).toBe(true);
      expect(statusRes.body.accountName).toBe("LinkedIn User");
    } finally {
      await deleteTenant(owner.tenantId);
      await deleteTenant(attacker.tenantId);
    }
  });
});

describe("LinkedIn publish authorization gate", () => {
  it("blocks publish when LinkedIn is not connected (400)", async () => {
    const tenant = await createTenant();
    try {
      const itemId = await insertContentItem(tenant.tenantId);
      actAs(tenant.clerkUserId);

      const res = await request(app).post(
        `/api/content/${itemId}/publish-linkedin`,
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/not connected/i);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("blocks publish when the stored token is expired (400)", async () => {
    const tenant = await createTenant();
    try {
      await insertLinkedinAccount(tenant.tenantId, {
        accessToken: SECRET_TOKEN,
        providerUserId: "person_1",
        tokenExpiresAt: new Date(Date.now() - 60_000),
      });
      const itemId = await insertContentItem(tenant.tenantId);
      actAs(tenant.clerkUserId);

      const res = await request(app).post(
        `/api/content/${itemId}/publish-linkedin`,
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/not connected/i);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("blocks publish when connected but the provider user id is missing (400)", async () => {
    const tenant = await createTenant();
    try {
      await insertLinkedinAccount(tenant.tenantId, {
        accessToken: SECRET_TOKEN,
        providerUserId: null,
      });
      const itemId = await insertContentItem(tenant.tenantId);
      actAs(tenant.clerkUserId);

      const res = await request(app).post(
        `/api/content/${itemId}/publish-linkedin`,
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/not connected/i);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("blocks re-test when there is no stored connection (400)", async () => {
    const tenant = await createTenant();
    try {
      actAs(tenant.clerkUserId);
      const res = await request(app).post("/api/linkedin/retest");
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/no stored linkedin connection/i);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  describe("with fetch mocked", () => {
    beforeEach(() => {
      // Prevent any real LinkedIn API call; force a failure so a connection
      // that passes the gate fails at the network step (502), never actually
      // posting.
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ message: "mocked failure" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      );
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("lets a valid connection past the gate (502, not a 400 'not connected')", async () => {
      const tenant = await createTenant();
      try {
        await insertLinkedinAccount(tenant.tenantId, {
          accessToken: SECRET_TOKEN,
          providerUserId: "person_ok",
        });
        // No imagePath -> text-only post, so the handler only calls fetch.
        const itemId = await insertContentItem(tenant.tenantId);
        actAs(tenant.clerkUserId);

        const res = await request(app).post(
          `/api/content/${itemId}/publish-linkedin`,
        );
        expect(res.status).toBe(502);
        expect(res.body.error).not.toMatch(/not connected/i);
        expect(bodyContainsToken(res.body, SECRET_TOKEN)).toBe(false);
      } finally {
        await deleteTenant(tenant.tenantId);
      }
    });
  });
});
