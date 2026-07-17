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
  snapshotAppCredentialRow,
  setAppCredentialRow,
  restoreAppCredentialRow,
} from "../test/dbHelpers";

const app = createTestApp();

// Tokens minted by the mocked Threads OAuth exchange during reconnect.
const TH_SHORT_LIVED_TOKEN = "th_short_lived_token";
const TH_LONG_LIVED_TOKEN = "th_new_long_lived_token";
const TH_NEW_USER_ID = "th_user_new_456";
const TH_NEW_USERNAME = "freshhandle";

// The stale credentials on the dead row that must be fully replaced.
const TH_STALE_TOKEN = "th_stale_dead_token";

let threadsSnapshot: AppCredential | null = null;

beforeAll(async () => {
  threadsSnapshot = await snapshotAppCredentialRow("threads");
});

afterAll(async () => {
  await restoreAppCredentialRow("threads", threadsSnapshot);
  await pool.end();
});

beforeEach(async () => {
  resetAuthState();
  process.env.SESSION_SECRET =
    process.env.SESSION_SECRET || "test-session-secret";
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
  body: unknown;
}

/**
 * Route the three Threads OAuth callback round-trips (code -> short-lived
 * token, short-lived -> long-lived token, profile lookup) to canned success
 * responses so the callback happy path runs without the network.
 */
function mockThreadsApi(): MockCall[] {
  const calls: MockCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, body: init?.body });
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });

      if (url.startsWith("https://graph.threads.net/oauth/access_token")) {
        return json({ access_token: TH_SHORT_LIVED_TOKEN, user_id: 987 });
      }
      if (url.startsWith("https://graph.threads.net/access_token")) {
        return json({
          access_token: TH_LONG_LIVED_TOKEN,
          expires_in: 60 * 24 * 60 * 60, // ~60 days
        });
      }
      if (url.startsWith("https://graph.threads.net/v1.0/me")) {
        return json({ id: TH_NEW_USER_ID, username: TH_NEW_USERNAME });
      }
      return json({});
    },
  );
  return calls;
}

/**
 * Route the callback's Threads round-trips to configurable failures so the
 * error branches run without the network.
 */
function mockThreadsApiFailing(opts: {
  shortTokenStatus?: number;
  longTokenStatus?: number;
  profileStatus?: number;
}): MockCall[] {
  const calls: MockCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, body: init?.body });
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });

      if (url.startsWith("https://graph.threads.net/oauth/access_token")) {
        if (opts.shortTokenStatus && opts.shortTokenStatus >= 400) {
          return json(
            { error_message: "Invalid authorization code" },
            opts.shortTokenStatus,
          );
        }
        return json({ access_token: TH_SHORT_LIVED_TOKEN, user_id: 987 });
      }
      if (url.startsWith("https://graph.threads.net/access_token")) {
        if (opts.longTokenStatus && opts.longTokenStatus >= 400) {
          return json({ error: "invalid token" }, opts.longTokenStatus);
        }
        return json({
          access_token: TH_LONG_LIVED_TOKEN,
          expires_in: 60 * 24 * 60 * 60,
        });
      }
      if (url.startsWith("https://graph.threads.net/v1.0/me")) {
        if (opts.profileStatus && opts.profileStatus >= 400) {
          return json({ error: "bad token" }, opts.profileStatus);
        }
        return json({ id: TH_NEW_USER_ID, username: TH_NEW_USERNAME });
      }
      return json({});
    },
  );
  return calls;
}

/** Seed a pre-existing (dead) Threads row and return its full snapshot. */
async function seedExistingRow(tenantId: number) {
  await insertThreadsAccount(tenantId, {
    accessToken: TH_STALE_TOKEN,
    providerUserId: "th_user_old",
    tokenExpiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    status: "error",
    accountName: "@oldhandle",
    verifyStatus: "failed",
    verifyError:
      "Your Threads access is no longer valid. Reconnect Threads to keep publishing.",
  });
  return getConnectedAccount(tenantId, "threads");
}

/** Mint a real signed state for the tenant via the authorize-URL endpoint. */
async function mintState(clerkUserId: string): Promise<string> {
  actAs(clerkUserId);
  const urlRes = await request(app).get("/api/threads/auth/url");
  expect(urlRes.status).toBe(200);
  const state = new URL(urlRes.body.url).searchParams.get("state")!;
  expect(state).toBeTruthy();
  return state;
}

describe("Threads connect: GET /threads/auth/callback (reconnect over a dead row)", () => {
  it("reactivates a dead connection in place on reconnect (UPDATE, not a second row)", async () => {
    const calls = mockThreadsApi();
    const tenant = await createTenant();
    try {
      // Seed an existing Threads row that went dead: verification failed, an
      // error recorded, a stale token, an old identity, and an expired clock.
      await insertThreadsAccount(tenant.tenantId, {
        accessToken: TH_STALE_TOKEN,
        providerUserId: "th_user_old",
        tokenExpiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        status: "error",
        accountName: "@oldhandle",
        verifyStatus: "failed",
        verifyError:
          "Your Threads access is no longer valid. Reconnect Threads to keep publishing.",
      });
      const deadRow = await getConnectedAccount(tenant.tenantId, "threads");
      expect(deadRow.verifyStatus).toBe("failed");
      expect(deadRow.verifyError).toBeTruthy();

      // Drive the callback happy path for the same tenant with a real signed
      // state minted by the authorize-URL endpoint.
      actAs(tenant.clerkUserId);
      const urlRes = await request(app).get("/api/threads/auth/url");
      expect(urlRes.status).toBe(200);
      const state = new URL(urlRes.body.url).searchParams.get("state")!;
      expect(state).toBeTruthy();

      const res = await request(app)
        .get("/api/threads/auth/callback")
        .query({ code: "AUTH_CODE", state });

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/accounts?threads=connected");

      // All three OAuth round-trips actually happened.
      expect(
        calls.some((c) =>
          c.url.startsWith("https://graph.threads.net/oauth/access_token"),
        ),
      ).toBe(true);
      expect(
        calls.some((c) =>
          c.url.startsWith("https://graph.threads.net/access_token"),
        ),
      ).toBe(true);
      expect(
        calls.some((c) =>
          c.url.startsWith("https://graph.threads.net/v1.0/me"),
        ),
      ).toBe(true);

      // Exactly one threads row exists for the tenant — the callback updated
      // the dead row rather than inserting a second one.
      const { rows } = await pool.query(
        "SELECT id FROM connected_accounts WHERE tenant_id = $1 AND platform = 'threads'",
        [tenant.tenantId],
      );
      expect(rows.length).toBe(1);
      expect(rows[0].id).toBe(deadRow.id);

      // The row was fully reactivated: status back to connected/verified, the
      // stale error cleared, and identity/token fields refreshed.
      const row = await getConnectedAccount(tenant.tenantId, "threads");
      expect(row.id).toBe(deadRow.id);
      expect(row.status).toBe("connected");
      expect(row.verifyStatus).toBe("verified");
      expect(row.verifyError).toBeNull();
      expect(row.providerUserId).toBe(TH_NEW_USER_ID);
      expect(row.accountName).toBe(`@${TH_NEW_USERNAME}`);
      expect(row.accessToken).toBe(TH_LONG_LIVED_TOKEN);
      expect(row.accessToken).not.toBe(TH_STALE_TOKEN);
      expect(row.tokenExpiresAt).toBeTruthy();
      expect(row.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());
      expect(row.verifiedAt).toBeTruthy();
      expect(row.verifiedAt!.getTime()).toBeGreaterThan(
        deadRow.verifiedAt!.getTime(),
      );
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});

describe("Threads connect callback error paths leave the stored row untouched", () => {
  it("redirects with reason=token_exchange and does not modify the row when the short-lived token exchange fails", async () => {
    const calls = mockThreadsApiFailing({ shortTokenStatus: 400 });
    const tenant = await createTenant();
    try {
      const before = await seedExistingRow(tenant.tenantId);
      const state = await mintState(tenant.clerkUserId);

      const res = await request(app)
        .get("/api/threads/auth/callback")
        .query({ code: "AUTH_CODE", state });

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(
        "/accounts?threads=error&reason=token_exchange",
      );

      // The short-lived token endpoint was hit, but neither the long-lived
      // upgrade nor the profile lookup ever ran.
      expect(
        calls.some((c) =>
          c.url.startsWith("https://graph.threads.net/oauth/access_token"),
        ),
      ).toBe(true);
      expect(
        calls.some((c) =>
          c.url.startsWith("https://graph.threads.net/access_token"),
        ),
      ).toBe(false);
      expect(
        calls.some((c) => c.url.startsWith("https://graph.threads.net/v1.0/me")),
      ).toBe(false);

      const after = await getConnectedAccount(tenant.tenantId, "threads");
      expect(after).toEqual(before);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("redirects with reason=token_exchange and does not modify the row when the long-lived upgrade fails", async () => {
    const calls = mockThreadsApiFailing({ longTokenStatus: 400 });
    const tenant = await createTenant();
    try {
      const before = await seedExistingRow(tenant.tenantId);
      const state = await mintState(tenant.clerkUserId);

      const res = await request(app)
        .get("/api/threads/auth/callback")
        .query({ code: "AUTH_CODE", state });

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(
        "/accounts?threads=error&reason=token_exchange",
      );

      // Both token endpoints were hit; the profile lookup never ran.
      expect(
        calls.some((c) =>
          c.url.startsWith("https://graph.threads.net/access_token"),
        ),
      ).toBe(true);
      expect(
        calls.some((c) => c.url.startsWith("https://graph.threads.net/v1.0/me")),
      ).toBe(false);

      // Crucially, the fresh short-lived token from the successful first
      // exchange was NOT partially written before the upgrade failed.
      const after = await getConnectedAccount(tenant.tenantId, "threads");
      expect(after).toEqual(before);
      expect(after.accessToken).toBe(TH_STALE_TOKEN);
      expect(after.accessToken).not.toBe(TH_SHORT_LIVED_TOKEN);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("redirects with reason=profile_lookup and does not modify the row when the profile lookup fails after successful token exchanges", async () => {
    const calls = mockThreadsApiFailing({ profileStatus: 401 });
    const tenant = await createTenant();
    try {
      const before = await seedExistingRow(tenant.tenantId);
      const state = await mintState(tenant.clerkUserId);

      const res = await request(app)
        .get("/api/threads/auth/callback")
        .query({ code: "AUTH_CODE", state });

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(
        "/accounts?threads=error&reason=profile_lookup",
      );

      // All three round-trips happened; the failure came from the profile.
      expect(
        calls.some((c) =>
          c.url.startsWith("https://graph.threads.net/oauth/access_token"),
        ),
      ).toBe(true);
      expect(
        calls.some((c) =>
          c.url.startsWith("https://graph.threads.net/access_token"),
        ),
      ).toBe(true);
      expect(
        calls.some((c) => c.url.startsWith("https://graph.threads.net/v1.0/me")),
      ).toBe(true);

      // Crucially, the fresh long-lived token from the successful exchange
      // was NOT partially written before the profile lookup failure.
      const after = await getConnectedAccount(tenant.tenantId, "threads");
      expect(after).toEqual(before);
      expect(after.accessToken).toBe(TH_STALE_TOKEN);
      expect(after.accessToken).not.toBe(TH_LONG_LIVED_TOKEN);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("redirects with reason=invalid_state and never calls Threads when the state is tampered", async () => {
    const calls = mockThreadsApiFailing({});
    const tenant = await createTenant();
    try {
      const before = await seedExistingRow(tenant.tenantId);
      const state = await mintState(tenant.clerkUserId);
      const tampered = `${state.slice(0, -4)}0000`;

      const res = await request(app)
        .get("/api/threads/auth/callback")
        .query({ code: "AUTH_CODE", state: tampered });

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(
        "/accounts?threads=error&reason=invalid_state",
      );
      expect(calls.length).toBe(0);

      const after = await getConnectedAccount(tenant.tenantId, "threads");
      expect(after).toEqual(before);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("redirects with reason=invalid_state and never calls Threads when the state is missing", async () => {
    const calls = mockThreadsApiFailing({});
    const tenant = await createTenant();
    try {
      const before = await seedExistingRow(tenant.tenantId);

      const res = await request(app)
        .get("/api/threads/auth/callback")
        .query({ code: "AUTH_CODE" });

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(
        "/accounts?threads=error&reason=invalid_state",
      );
      expect(calls.length).toBe(0);

      const after = await getConnectedAccount(tenant.tenantId, "threads");
      expect(after).toEqual(before);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("redirects with reason=invalid_state and never calls Threads when the state has expired", async () => {
    const calls = mockThreadsApiFailing({});
    const tenant = await createTenant();
    try {
      const before = await seedExistingRow(tenant.tenantId);

      // Mint the state while the clock is shifted far into the past so the
      // signed TTL has already lapsed by the time the callback verifies it.
      vi.useFakeTimers();
      let state: string;
      try {
        vi.setSystemTime(Date.now() - 24 * 60 * 60 * 1000);
        actAs(tenant.clerkUserId);
        const urlRes = await request(app).get("/api/threads/auth/url");
        expect(urlRes.status).toBe(200);
        state = new URL(urlRes.body.url).searchParams.get("state")!;
      } finally {
        vi.useRealTimers();
      }

      const res = await request(app)
        .get("/api/threads/auth/callback")
        .query({ code: "AUTH_CODE", state });

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(
        "/accounts?threads=error&reason=invalid_state",
      );
      expect(calls.length).toBe(0);

      const after = await getConnectedAccount(tenant.tenantId, "threads");
      expect(after).toEqual(before);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});
