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

import { pool, type AppCredential } from "@workspace/db";
import { createTestApp } from "../test/testApp";
import { resetAuthState, actAs } from "../test/authState";
import {
  createTenant,
  deleteTenant,
  insertYoutubeAccount,
  getConnectedAccount,
  getNotifications,
  snapshotAppCredentialRow,
  setAppCredentialRow,
  restoreAppCredentialRow,
} from "../test/dbHelpers";

const app = createTestApp();

const HOUR_MS = 60 * 60 * 1000;

// Stored short-lived access token, and the fresh one a successful refresh
// against Google must persist.
const YT_OLD_ACCESS = "yt_old_access_token";
const YT_NEW_ACCESS = "yt_new_access_token";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

let youtubeSnapshot: AppCredential | null = null;

beforeAll(async () => {
  process.env.SESSION_SECRET =
    process.env.SESSION_SECRET || "test-session-secret";
  youtubeSnapshot = await snapshotAppCredentialRow("youtube");
});

afterAll(async () => {
  await restoreAppCredentialRow("youtube", youtubeSnapshot);
  await pool.end();
});

beforeEach(async () => {
  resetAuthState();
  await setAppCredentialRow("youtube", {
    clientId: "yt-client-id-default",
    clientSecret: "yt-client-secret-default",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface MockCall {
  url: string;
  body: string;
}

type RefreshBehavior =
  | { kind: "success"; accessToken: string; expiresIn: number }
  | { kind: "invalid-grant" }
  | { kind: "rejected-401" }
  | { kind: "network-error" }
  | { kind: "server-error"; status: number };

/**
 * Intercept Google's token endpoint with the requested behavior; every other
 * outbound call gets an empty 200 so nothing hits the network.
 */
function mockGoogleTokenApi(behavior: RefreshBehavior): MockCall[] {
  const calls: MockCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, body: String(init?.body ?? "") });
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });

      if (url.startsWith(GOOGLE_TOKEN_URL)) {
        switch (behavior.kind) {
          case "success":
            return json({
              access_token: behavior.accessToken,
              expires_in: behavior.expiresIn,
            });
          case "invalid-grant":
            return json(
              { error: "invalid_grant", error_description: "Token revoked" },
              400,
            );
          case "rejected-401":
            return json({ error: "invalid_client" }, 401);
          case "server-error":
            return json({ error: "internal" }, behavior.status);
          case "network-error":
            throw new TypeError("fetch failed");
        }
      }
      return json({});
    },
  );
  return calls;
}

function refreshCalls(calls: MockCall[]): MockCall[] {
  return calls.filter(
    (c) =>
      c.url.startsWith(GOOGLE_TOKEN_URL) &&
      c.body.includes("grant_type=refresh_token"),
  );
}

// ---------------------------------------------------------------------------
// GET /youtube/status delegates to the shared ensureFreshYoutubeAccessToken
// core (lib/socialReverify.ts). These tests guard the outcomes that matter:
//   1. a still-fresh access token short-circuits — no refresh round-trip;
//   2. a successful refresh persists the NEW access token and expiry;
//   3. a definitive invalid_grant flips the row to failed + notification so
//      a revoked account can never keep reading as connected;
//   4. a transient network/5xx failure leaves the stored state untouched;
//   5. an already-failed row is never refreshed back to life.
// ---------------------------------------------------------------------------

describe("YouTube token refresh via GET /youtube/status", () => {
  it("does not call the token endpoint when the access token is still fresh", async () => {
    const calls = mockGoogleTokenApi({ kind: "network-error" });
    const tenant = await createTenant();
    try {
      const farExpiry = new Date(Date.now() + 2 * HOUR_MS);
      await insertYoutubeAccount(tenant.tenantId, {
        accessToken: YT_OLD_ACCESS,
        tokenExpiresAt: farExpiry,
      });

      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/youtube/status");
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(true);
      expect(res.body.expired).toBe(false);
      expect(res.body.accountName).toBe("Test Channel");
      expect(refreshCalls(calls).length).toBe(0);

      const row = await getConnectedAccount(tenant.tenantId, "youtube");
      expect(row?.accessToken).toBe(YT_OLD_ACCESS);
      expect(row?.tokenExpiresAt?.getTime()).toBe(farExpiry.getTime());
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("persists the fresh access token and expiry after refreshing an expired one", async () => {
    const calls = mockGoogleTokenApi({
      kind: "success",
      accessToken: YT_NEW_ACCESS,
      expiresIn: 3600,
    });
    const tenant = await createTenant();
    try {
      await insertYoutubeAccount(tenant.tenantId, {
        accessToken: YT_OLD_ACCESS,
        tokenExpiresAt: new Date(Date.now() - HOUR_MS),
      });

      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/youtube/status");
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(true);
      expect(res.body.expired).toBe(false);
      expect(refreshCalls(calls).length).toBe(1);
      // The refresh request carried the STORED refresh token.
      expect(refreshCalls(calls)[0].body).toContain(
        `refresh_token=${encodeURIComponent("yt_refresh_secret")}`,
      );

      const row = await getConnectedAccount(tenant.tenantId, "youtube");
      expect(row?.accessToken).toBe(YT_NEW_ACCESS);
      expect(row?.status).toBe("connected");
      expect(row?.verifyStatus).toBe("verified");
      expect(row?.verifyError).toBeNull();
      // The expiry moved forward ~1 hour — not wiped, not stale.
      expect(row?.tokenExpiresAt).toBeTruthy();
      expect(row!.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("flags a revoked account (invalid_grant) as failed with a reconnect notification", async () => {
    mockGoogleTokenApi({ kind: "invalid-grant" });
    const tenant = await createTenant();
    try {
      await insertYoutubeAccount(tenant.tenantId, {
        accessToken: YT_OLD_ACCESS,
        tokenExpiresAt: new Date(Date.now() - HOUR_MS),
      });

      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/youtube/status");
      expect(res.status).toBe(200);
      // The revoked account must NOT read as connected — the UI needs the
      // reconnect prompt.
      expect(res.body.connected).toBe(false);
      expect(res.body.expired).toBe(true);
      expect(res.body.accountName).toBeNull();

      const row = await getConnectedAccount(tenant.tenantId, "youtube");
      expect(row?.status).toBe("error");
      expect(row?.verifyStatus).toBe("failed");
      expect(row?.verifyError).toContain("Reconnect");

      // The breakage was surfaced as an in-app notification (fresh failure
      // on a previously verified row).
      const notifications = await getNotifications(tenant.tenantId);
      expect(
        notifications.some(
          (n) =>
            n.type === "social_connection_failed" && n.platform === "youtube",
        ),
      ).toBe(true);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("flags a 401 rejection from the token endpoint the same way", async () => {
    mockGoogleTokenApi({ kind: "rejected-401" });
    const tenant = await createTenant();
    try {
      await insertYoutubeAccount(tenant.tenantId, {
        accessToken: YT_OLD_ACCESS,
        tokenExpiresAt: new Date(Date.now() - HOUR_MS),
      });

      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/youtube/status");
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(false);
      expect(res.body.expired).toBe(true);

      const row = await getConnectedAccount(tenant.tenantId, "youtube");
      expect(row?.verifyStatus).toBe("failed");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("keeps the stored token and state untouched on a transient network error", async () => {
    const calls = mockGoogleTokenApi({ kind: "network-error" });
    const tenant = await createTenant();
    try {
      const pastExpiry = new Date(Date.now() - HOUR_MS);
      await insertYoutubeAccount(tenant.tenantId, {
        accessToken: YT_OLD_ACCESS,
        tokenExpiresAt: pastExpiry,
      });

      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/youtube/status");
      expect(res.status).toBe(200);
      // Refresh was attempted, failed transiently — the connection still
      // reads as connected because the refresh token was never rejected.
      expect(refreshCalls(calls).length).toBe(1);
      expect(res.body.connected).toBe(true);
      expect(res.body.expired).toBe(false);

      const row = await getConnectedAccount(tenant.tenantId, "youtube");
      expect(row?.accessToken).toBe(YT_OLD_ACCESS);
      expect(row?.tokenExpiresAt?.getTime()).toBe(pastExpiry.getTime());
      expect(row?.status).toBe("connected");
      expect(row?.verifyStatus).toBe("verified");
      expect(row?.verifyError).toBeNull();

      // No breakage notification for a transient blip.
      const notifications = await getNotifications(tenant.tenantId);
      expect(notifications.length).toBe(0);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("keeps the stored state untouched on a transient 5xx from the token endpoint", async () => {
    mockGoogleTokenApi({ kind: "server-error", status: 500 });
    const tenant = await createTenant();
    try {
      const pastExpiry = new Date(Date.now() - HOUR_MS);
      await insertYoutubeAccount(tenant.tenantId, {
        accessToken: YT_OLD_ACCESS,
        tokenExpiresAt: pastExpiry,
      });

      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/youtube/status");
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(true);

      const row = await getConnectedAccount(tenant.tenantId, "youtube");
      expect(row?.accessToken).toBe(YT_OLD_ACCESS);
      expect(row?.verifyStatus).toBe("verified");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("does not attempt a refresh on a row already marked failed", async () => {
    const calls = mockGoogleTokenApi({
      kind: "success",
      accessToken: YT_NEW_ACCESS,
      expiresIn: 3600,
    });
    const tenant = await createTenant();
    try {
      await insertYoutubeAccount(tenant.tenantId, {
        accessToken: YT_OLD_ACCESS,
        tokenExpiresAt: new Date(Date.now() - HOUR_MS),
        status: "error",
        verifyStatus: "failed",
        verifyError:
          "YouTube rejected the stored access. Reconnect YouTube to restore the connection.",
      });

      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/youtube/status");
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(false);
      expect(res.body.expired).toBe(true);
      // A dead row must reconnect via OAuth, not sneak back in via refresh.
      expect(refreshCalls(calls).length).toBe(0);

      const row = await getConnectedAccount(tenant.tenantId, "youtube");
      expect(row?.accessToken).toBe(YT_OLD_ACCESS);
      expect(row?.verifyStatus).toBe("failed");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});
