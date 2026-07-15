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
