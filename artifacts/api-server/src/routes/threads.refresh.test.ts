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
  insertThreadsAccount,
  getConnectedAccount,
  getNotifications,
  snapshotAppCredentialRow,
  setAppCredentialRow,
  restoreAppCredentialRow,
} from "../test/dbHelpers";

const app = createTestApp();

const DAY_MS = 24 * 60 * 60 * 1000;

// Stored long-lived token that maybeRefreshToken sends to the refresh
// endpoint, and the rolled token a successful refresh must persist.
const TH_OLD_TOKEN = "th_old_long_lived_token_refresh";
const TH_ROLLED_TOKEN = "th_rolled_long_lived_token";

let threadsSnapshot: AppCredential | null = null;

beforeAll(async () => {
  process.env.SESSION_SECRET =
    process.env.SESSION_SECRET || "test-session-secret";
  threadsSnapshot = await snapshotAppCredentialRow("threads");
});

afterAll(async () => {
  await restoreAppCredentialRow("threads", threadsSnapshot);
  await pool.end();
});

beforeEach(async () => {
  resetAuthState();
  await setAppCredentialRow("threads", {
    appId: "th-app-id-default",
    appSecret: "th-app-secret-default",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface MockCall {
  url: string;
}

type RefreshBehavior =
  | { kind: "success"; accessToken: string; expiresIn: number }
  | { kind: "success-no-expiry"; accessToken: string }
  | { kind: "rejected"; status: number }
  | { kind: "network-error" }
  | { kind: "server-error"; status: number };

/**
 * Intercept the Threads refresh endpoint with the requested behavior; every
 * other outbound call gets an empty 200 so nothing hits the network.
 */
function mockRefreshApi(behavior: RefreshBehavior): MockCall[] {
  const calls: MockCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url });
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });

      if (url.startsWith("https://graph.threads.net/refresh_access_token")) {
        switch (behavior.kind) {
          case "success":
            return json({
              access_token: behavior.accessToken,
              expires_in: behavior.expiresIn,
            });
          case "success-no-expiry":
            return json({ access_token: behavior.accessToken });
          case "rejected":
            return json(
              { error: { message: "Token is invalid" } },
              behavior.status,
            );
          case "server-error":
            return json({ error: { message: "oops" } }, behavior.status);
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
  return calls.filter((c) =>
    c.url.startsWith("https://graph.threads.net/refresh_access_token"),
  );
}

// ---------------------------------------------------------------------------
// GET /threads/status exercises maybeRefreshToken: a token inside its 7-day
// renewal window (or already past expiry) triggers a refresh round-trip.
// These tests guard the three outcomes that matter:
//   1. a successful refresh persists the NEW token and expiry (no silent
//      no-op, no wiped expiry);
//   2. a definitive rejection flips the row to failed/reconnect instead of
//      still reporting "connected" on a dead token;
//   3. a transient network/server failure keeps the prior state untouched —
//      the stored token must never be scrubbed by a blip.
// ---------------------------------------------------------------------------

describe("Threads token auto-refresh via GET /threads/status", () => {
  it("does not call the refresh endpoint when the token is far from expiry", async () => {
    const calls = mockRefreshApi({ kind: "network-error" });
    const tenant = await createTenant();
    try {
      const farExpiry = new Date(Date.now() + 30 * DAY_MS);
      await insertThreadsAccount(tenant.tenantId, {
        accessToken: TH_OLD_TOKEN,
        tokenExpiresAt: farExpiry,
      });

      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/threads/status");
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(true);
      expect(refreshCalls(calls).length).toBe(0);

      const row = await getConnectedAccount(tenant.tenantId, "threads");
      expect(row?.accessToken).toBe(TH_OLD_TOKEN);
      expect(row?.tokenExpiresAt?.getTime()).toBe(farExpiry.getTime());
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("persists the rolled token and new expiry on a successful refresh", async () => {
    const calls = mockRefreshApi({
      kind: "success",
      accessToken: TH_ROLLED_TOKEN,
      expiresIn: 60 * DAY_MS / 1000, // 60 days, in seconds
    });
    const tenant = await createTenant();
    try {
      // Inside the renewal window but not yet expired.
      await insertThreadsAccount(tenant.tenantId, {
        accessToken: TH_OLD_TOKEN,
        tokenExpiresAt: new Date(Date.now() + 3 * DAY_MS),
      });

      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/threads/status");
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(true);
      expect(res.body.expired).toBe(false);
      expect(refreshCalls(calls).length).toBe(1);
      // The refresh request carried the STORED token.
      expect(refreshCalls(calls)[0].url).toContain(
        encodeURIComponent(TH_OLD_TOKEN),
      );

      const row = await getConnectedAccount(tenant.tenantId, "threads");
      expect(row?.accessToken).toBe(TH_ROLLED_TOKEN);
      expect(row?.status).toBe("connected");
      expect(row?.verifyStatus).toBe("verified");
      expect(row?.verifyError).toBeNull();
      // The expiry moved forward roughly 60 days — not wiped, not stale.
      expect(row?.tokenExpiresAt).toBeTruthy();
      expect(row!.tokenExpiresAt!.getTime()).toBeGreaterThan(
        Date.now() + 50 * DAY_MS,
      );
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("refreshes an already-expired token and reports connected again", async () => {
    mockRefreshApi({
      kind: "success",
      accessToken: TH_ROLLED_TOKEN,
      expiresIn: 60 * DAY_MS / 1000,
    });
    const tenant = await createTenant();
    try {
      await insertThreadsAccount(tenant.tenantId, {
        accessToken: TH_OLD_TOKEN,
        tokenExpiresAt: new Date(Date.now() - DAY_MS),
      });

      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/threads/status");
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(true);
      expect(res.body.expired).toBe(false);

      const row = await getConnectedAccount(tenant.tenantId, "threads");
      expect(row?.accessToken).toBe(TH_ROLLED_TOKEN);
      expect(row!.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("flags the connection for reconnect when an expired token's refresh is rejected", async () => {
    mockRefreshApi({ kind: "rejected", status: 401 });
    const tenant = await createTenant();
    try {
      await insertThreadsAccount(tenant.tenantId, {
        accessToken: TH_OLD_TOKEN,
        tokenExpiresAt: new Date(Date.now() - DAY_MS),
      });

      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/threads/status");
      expect(res.status).toBe(200);
      // The dead token must NOT read as connected — the UI needs the
      // reconnect prompt.
      expect(res.body.connected).toBe(false);
      expect(res.body.expired).toBe(true);

      const row = await getConnectedAccount(tenant.tenantId, "threads");
      expect(row?.status).toBe("error");
      expect(row?.verifyStatus).toBe("failed");
      expect(row?.verifyError).toContain("Reconnect Threads");

      // The breakage was surfaced as an in-app notification (fresh failure
      // on a previously verified row).
      const notifications = await getNotifications(tenant.tenantId);
      expect(
        notifications.some(
          (n) =>
            n.type === "social_connection_failed" && n.platform === "threads",
        ),
      ).toBe(true);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("flags a not-yet-expired token whose refresh gets a definitive 400 rejection", async () => {
    mockRefreshApi({ kind: "rejected", status: 400 });
    const tenant = await createTenant();
    try {
      // Still 3 days of validity left, but Threads says the token is bad.
      await insertThreadsAccount(tenant.tenantId, {
        accessToken: TH_OLD_TOKEN,
        tokenExpiresAt: new Date(Date.now() + 3 * DAY_MS),
      });

      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/threads/status");
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(false);
      expect(res.body.expired).toBe(true);

      const row = await getConnectedAccount(tenant.tenantId, "threads");
      expect(row?.verifyStatus).toBe("failed");
      expect(row?.verifyError).toContain("Reconnect Threads");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("keeps the stored token and state untouched on a transient network error", async () => {
    const calls = mockRefreshApi({ kind: "network-error" });
    const tenant = await createTenant();
    try {
      const nearExpiry = new Date(Date.now() + 2 * DAY_MS);
      await insertThreadsAccount(tenant.tenantId, {
        accessToken: TH_OLD_TOKEN,
        tokenExpiresAt: nearExpiry,
      });

      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/threads/status");
      expect(res.status).toBe(200);
      // Refresh was attempted, failed transiently — still connected on the
      // existing (not-yet-expired) token.
      expect(refreshCalls(calls).length).toBe(1);
      expect(res.body.connected).toBe(true);
      expect(res.body.expired).toBe(false);

      const row = await getConnectedAccount(tenant.tenantId, "threads");
      expect(row?.accessToken).toBe(TH_OLD_TOKEN);
      expect(row?.tokenExpiresAt?.getTime()).toBe(nearExpiry.getTime());
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

  it("keeps the stored token on a transient 5xx from the refresh endpoint (not-yet-expired token)", async () => {
    mockRefreshApi({ kind: "server-error", status: 500 });
    const tenant = await createTenant();
    try {
      const nearExpiry = new Date(Date.now() + 2 * DAY_MS);
      await insertThreadsAccount(tenant.tenantId, {
        accessToken: TH_OLD_TOKEN,
        tokenExpiresAt: nearExpiry,
      });

      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/threads/status");
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(true);

      const row = await getConnectedAccount(tenant.tenantId, "threads");
      expect(row?.accessToken).toBe(TH_OLD_TOKEN);
      expect(row?.tokenExpiresAt?.getTime()).toBe(nearExpiry.getTime());
      expect(row?.verifyStatus).toBe("verified");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("does not attempt a refresh on a row already marked failed", async () => {
    const calls = mockRefreshApi({
      kind: "success",
      accessToken: TH_ROLLED_TOKEN,
      expiresIn: 60 * DAY_MS / 1000,
    });
    const tenant = await createTenant();
    try {
      await insertThreadsAccount(tenant.tenantId, {
        accessToken: TH_OLD_TOKEN,
        tokenExpiresAt: new Date(Date.now() - DAY_MS),
        status: "error",
        verifyStatus: "failed",
        verifyError: "Your Threads access is no longer valid.",
      });

      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/threads/status");
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(false);
      expect(res.body.expired).toBe(true);
      // A dead row must reconnect via OAuth, not sneak back in via refresh.
      expect(refreshCalls(calls).length).toBe(0);

      const row = await getConnectedAccount(tenant.tenantId, "threads");
      expect(row?.accessToken).toBe(TH_OLD_TOKEN);
      expect(row?.verifyStatus).toBe("failed");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});
