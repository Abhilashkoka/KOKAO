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
  getConnectedAccount,
  getNotifications,
  insertConnectionFailedNotification,
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

afterEach(() => {
  vi.restoreAllMocks();
});

function bodyContainsToken(body: unknown, token: string): boolean {
  return JSON.stringify(body).includes(token);
}

/** More than LINKEDIN_REVERIFY_STALE_MS (15 min) in the past. */
function staleDate(): Date {
  return new Date(Date.now() - 20 * 60 * 1000);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Drive /linkedin/auth/url to get a validly-signed state for this tenant. */
async function getSignedState(clerkUserId: string): Promise<string> {
  actAs(clerkUserId);
  const res = await request(app).get("/api/linkedin/auth/url");
  expect(res.status).toBe(200);
  const url = new URL(res.body.url);
  const state = url.searchParams.get("state");
  expect(state).toBeTruthy();
  return state!;
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

describe("LinkedIn OAuth reconnect", () => {
  it("(d) clears a prior failed state on a successful reconnect", async () => {
    const tenant = await createTenant();
    try {
      // Simulate a connection that was proactively flipped to failed after its
      // token was revoked.
      await insertLinkedinAccount(tenant.tenantId, {
        status: "error",
        verifyStatus: "failed",
        verifyError:
          "Your LinkedIn access token is no longer valid. Reconnect LinkedIn to keep publishing.",
        accessToken: "dead-token",
      });
      // The breakage also left an unread "connection failed" notification.
      await insertConnectionFailedNotification(tenant.tenantId, "linkedin");

      const state = await getSignedState(tenant.clerkUserId);

      // Token exchange succeeds, then userinfo resolves the member.
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          jsonResponse({ access_token: "fresh-token", expires_in: 3600 }),
        )
        .mockResolvedValueOnce(
          jsonResponse({ sub: "sub_456", name: "Jane Doe" }),
        );

      actAs(tenant.clerkUserId);
      const res = await request(app)
        .get("/api/linkedin/auth/callback")
        .query({ code: "auth-code", state });

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/accounts?linkedin=connected");
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const row = await getConnectedAccount(tenant.tenantId, "linkedin");
      expect(row?.verifyStatus).toBe("verified");
      expect(row?.verifyError).toBeNull();
      expect(row?.status).toBe("connected");
      expect(row?.accessToken).toBe("fresh-token");
      expect(row?.providerUserId).toBe("sub_456");

      // The stale breakage notification is auto-dismissed by the reconnect.
      const notifications = await getNotifications(tenant.tenantId);
      const failed = notifications.filter(
        (n) => n.type === "social_connection_failed" && n.platform === "linkedin",
      );
      expect(failed.length).toBe(1);
      expect(failed[0].readAt).not.toBeNull();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});

describe("LinkedIn proactive re-verification (via /linkedin/status)", () => {
  it("(a) flips a stale token to failed when LinkedIn rejects it (401)", async () => {
    const tenant = await createTenant();
    try {
      await insertLinkedinAccount(tenant.tenantId, {
        verifyStatus: "verified",
        verifiedAt: staleDate(),
      });
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(jsonResponse({ error: "invalid" }, 401));

      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/linkedin/status");

      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(res.body.connected).toBe(false);
      expect(res.body.expired).toBe(true);

      const row = await getConnectedAccount(tenant.tenantId, "linkedin");
      expect(row?.verifyStatus).toBe("failed");
      expect(row?.status).toBe("error");
      expect(row?.verifyError).toMatch(/no longer valid/i);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("(b) does not re-check a fresh token (rate limiting)", async () => {
    const tenant = await createTenant();
    try {
      await insertLinkedinAccount(tenant.tenantId, {
        verifyStatus: "verified",
        verifiedAt: new Date(),
      });
      const fetchMock = vi.spyOn(globalThis, "fetch");

      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/linkedin/status");

      expect(res.status).toBe(200);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(res.body.connected).toBe(true);

      const row = await getConnectedAccount(tenant.tenantId, "linkedin");
      expect(row?.verifyStatus).toBe("verified");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("(c) keeps the prior status on a transient/network error", async () => {
    const tenant = await createTenant();
    try {
      const stale = staleDate();
      await insertLinkedinAccount(tenant.tenantId, {
        verifyStatus: "verified",
        verifiedAt: stale,
      });
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValueOnce(new Error("network down"));

      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/linkedin/status");

      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(res.body.connected).toBe(true);

      const row = await getConnectedAccount(tenant.tenantId, "linkedin");
      // Prior status preserved; only the check clock advanced.
      expect(row?.verifyStatus).toBe("verified");
      expect(row?.status).toBe("connected");
      expect(row?.verifyError).toBeNull();
      expect(row?.verifiedAt?.getTime()).toBeGreaterThan(stale.getTime());
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("notifies once when LinkedIn rejects the token (401)", async () => {
    const tenant = await createTenant();
    try {
      await insertLinkedinAccount(tenant.tenantId, {
        verifyStatus: "verified",
        verifiedAt: staleDate(),
      });
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        jsonResponse({ error: "invalid" }, 401),
      );

      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/linkedin/status");
      expect(res.status).toBe(200);

      const notes = await getNotifications(tenant.tenantId);
      expect(notes).toHaveLength(1);
      expect(notes[0].type).toBe("social_connection_failed");
      expect(notes[0].platform).toBe("linkedin");
      expect(notes[0].linkUrl).toBe("/accounts");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("notifies once when LinkedIn rejects the token (403)", async () => {
    const tenant = await createTenant();
    try {
      await insertLinkedinAccount(tenant.tenantId, {
        verifyStatus: "verified",
        verifiedAt: staleDate(),
      });
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        jsonResponse({ error: "forbidden" }, 403),
      );

      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/linkedin/status");
      expect(res.status).toBe(200);

      const notes = await getNotifications(tenant.tenantId);
      expect(notes).toHaveLength(1);
      expect(notes[0].platform).toBe("linkedin");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("does not notify on a transient/network error", async () => {
    const tenant = await createTenant();
    try {
      await insertLinkedinAccount(tenant.tenantId, {
        verifyStatus: "verified",
        verifiedAt: staleDate(),
      });
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
        new Error("network down"),
      );

      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/linkedin/status");
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(true);

      const notes = await getNotifications(tenant.tenantId);
      expect(notes).toHaveLength(0);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("treats an expired-by-timestamp token as expired without a live call", async () => {
    const tenant = await createTenant();
    try {
      await insertLinkedinAccount(tenant.tenantId, {
        verifyStatus: "verified",
        verifiedAt: staleDate(),
        tokenExpiresAt: new Date(Date.now() - 60 * 1000),
      });
      const fetchMock = vi.spyOn(globalThis, "fetch");

      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/linkedin/status");

      expect(res.status).toBe(200);
      // Expiry timestamp alone tells us it's dead — no live call spent.
      expect(fetchMock).not.toHaveBeenCalled();
      expect(res.body.connected).toBe(false);
      expect(res.body.expired).toBe(true);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});
