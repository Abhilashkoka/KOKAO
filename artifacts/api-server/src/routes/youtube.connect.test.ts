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
  snapshotAppCredentialRow,
  setAppCredentialRow,
  restoreAppCredentialRow,
} from "../test/dbHelpers";

const app = createTestApp();

// Tokens minted by the mocked Google OAuth exchange during reconnect.
const YT_NEW_ACCESS_TOKEN = "yt_new_access_token";

// The stale credentials on the dead row that must never be half-replaced.
const YT_STALE_TOKEN = "yt_stale_dead_token";

let youtubeSnapshot: AppCredential | null = null;

beforeAll(async () => {
  youtubeSnapshot = await snapshotAppCredentialRow("youtube");
});

afterAll(async () => {
  await restoreAppCredentialRow("youtube", youtubeSnapshot);
  await pool.end();
});

beforeEach(async () => {
  resetAuthState();
  process.env.SESSION_SECRET =
    process.env.SESSION_SECRET || "test-session-secret";
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
  body: unknown;
}

/**
 * Route the two Google round-trips of the YouTube OAuth callback (code ->
 * access token, channels/identity lookup) to configurable failures so the
 * error branches run without the network.
 */
function mockGoogleApiFailing(opts: {
  tokenStatus?: number;
  channelStatus?: number;
  noChannel?: boolean;
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

      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        if (opts.tokenStatus && opts.tokenStatus >= 400) {
          return json({ error: "invalid_grant" }, opts.tokenStatus);
        }
        return json({
          access_token: YT_NEW_ACCESS_TOKEN,
          refresh_token: "yt_new_refresh_token",
          expires_in: 3600,
        });
      }
      if (url.startsWith("https://www.googleapis.com/youtube/v3/channels")) {
        if (opts.channelStatus && opts.channelStatus >= 400) {
          return json({ error: { message: "forbidden" } }, opts.channelStatus);
        }
        if (opts.noChannel) {
          return json({ items: [] });
        }
        return json({
          items: [
            { id: "yt_channel_new", snippet: { title: "Fresh Channel" } },
          ],
        });
      }
      return json({});
    },
  );
  return calls;
}

/** Seed a pre-existing (dead) YouTube row and return its full snapshot. */
async function seedExistingRow(tenantId: number) {
  await insertYoutubeAccount(tenantId, {
    accessToken: YT_STALE_TOKEN,
    refreshToken: "yt_stale_refresh",
    providerUserId: "yt_channel_old",
    tokenExpiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    status: "error",
    accountName: "Old Channel",
    verifyStatus: "failed",
    verifyError:
      "YouTube rejected the stored access. Reconnect YouTube to restore the connection.",
  });
  return getConnectedAccount(tenantId, "youtube");
}

/** Mint a real signed state for the tenant via the authorize-URL endpoint. */
async function mintState(clerkUserId: string): Promise<string> {
  actAs(clerkUserId);
  const urlRes = await request(app).get("/api/youtube/auth/url");
  expect(urlRes.status).toBe(200);
  const state = new URL(urlRes.body.url).searchParams.get("state")!;
  expect(state).toBeTruthy();
  return state;
}

describe("YouTube connect callback error paths leave the stored row untouched", () => {
  it("redirects with reason=token_exchange and does not modify the row when the token exchange fails", async () => {
    const calls = mockGoogleApiFailing({ tokenStatus: 400 });
    const tenant = await createTenant();
    try {
      const before = await seedExistingRow(tenant.tenantId);
      const state = await mintState(tenant.clerkUserId);

      const res = await request(app)
        .get("/api/youtube/auth/callback")
        .query({ code: "AUTH_CODE", state });

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(
        "/accounts?youtube=error&reason=token_exchange",
      );

      // The token endpoint was hit, but the channel lookup never ran.
      expect(
        calls.some((c) => c.url.startsWith("https://oauth2.googleapis.com/token")),
      ).toBe(true);
      expect(
        calls.some((c) =>
          c.url.startsWith("https://www.googleapis.com/youtube/v3/channels"),
        ),
      ).toBe(false);

      const after = await getConnectedAccount(tenant.tenantId, "youtube");
      expect(after).toEqual(before);
      expect(after.accessToken).toBe(YT_STALE_TOKEN);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("redirects with reason=channel_lookup and does not modify the row when the channel lookup fails after a successful token exchange", async () => {
    const calls = mockGoogleApiFailing({ channelStatus: 403 });
    const tenant = await createTenant();
    try {
      const before = await seedExistingRow(tenant.tenantId);
      const state = await mintState(tenant.clerkUserId);

      const res = await request(app)
        .get("/api/youtube/auth/callback")
        .query({ code: "AUTH_CODE", state });

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(
        "/accounts?youtube=error&reason=channel_lookup",
      );

      // Both round-trips happened; the failure came from the channel lookup.
      expect(
        calls.some((c) => c.url.startsWith("https://oauth2.googleapis.com/token")),
      ).toBe(true);
      expect(
        calls.some((c) =>
          c.url.startsWith("https://www.googleapis.com/youtube/v3/channels"),
        ),
      ).toBe(true);

      // Crucially, the fresh access token from the successful exchange was
      // NOT partially written before the lookup failure.
      const after = await getConnectedAccount(tenant.tenantId, "youtube");
      expect(after).toEqual(before);
      expect(after.accessToken).toBe(YT_STALE_TOKEN);
      expect(after.accessToken).not.toBe(YT_NEW_ACCESS_TOKEN);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("redirects with reason=no_channel and does not modify the row when the Google account has no YouTube channel", async () => {
    const calls = mockGoogleApiFailing({ noChannel: true });
    const tenant = await createTenant();
    try {
      const before = await seedExistingRow(tenant.tenantId);
      const state = await mintState(tenant.clerkUserId);

      const res = await request(app)
        .get("/api/youtube/auth/callback")
        .query({ code: "AUTH_CODE", state });

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(
        "/accounts?youtube=error&reason=no_channel",
      );
      expect(
        calls.some((c) =>
          c.url.startsWith("https://www.googleapis.com/youtube/v3/channels"),
        ),
      ).toBe(true);

      const after = await getConnectedAccount(tenant.tenantId, "youtube");
      expect(after).toEqual(before);
      expect(after.accessToken).toBe(YT_STALE_TOKEN);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("redirects with reason=invalid_state and never calls Google when the state is tampered", async () => {
    const calls = mockGoogleApiFailing({});
    const tenant = await createTenant();
    try {
      const before = await seedExistingRow(tenant.tenantId);
      const state = await mintState(tenant.clerkUserId);
      const tampered = `${state.slice(0, -4)}0000`;

      const res = await request(app)
        .get("/api/youtube/auth/callback")
        .query({ code: "AUTH_CODE", state: tampered });

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(
        "/accounts?youtube=error&reason=invalid_state",
      );
      expect(calls.length).toBe(0);

      const after = await getConnectedAccount(tenant.tenantId, "youtube");
      expect(after).toEqual(before);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("redirects with reason=invalid_state and never calls Google when the state is missing", async () => {
    const calls = mockGoogleApiFailing({});
    const tenant = await createTenant();
    try {
      const before = await seedExistingRow(tenant.tenantId);

      const res = await request(app)
        .get("/api/youtube/auth/callback")
        .query({ code: "AUTH_CODE" });

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(
        "/accounts?youtube=error&reason=invalid_state",
      );
      expect(calls.length).toBe(0);

      const after = await getConnectedAccount(tenant.tenantId, "youtube");
      expect(after).toEqual(before);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("redirects with reason=invalid_state and never calls Google when the state has expired", async () => {
    const calls = mockGoogleApiFailing({});
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
        const urlRes = await request(app).get("/api/youtube/auth/url");
        expect(urlRes.status).toBe(200);
        state = new URL(urlRes.body.url).searchParams.get("state")!;
      } finally {
        vi.useRealTimers();
      }

      const res = await request(app)
        .get("/api/youtube/auth/callback")
        .query({ code: "AUTH_CODE", state });

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(
        "/accounts?youtube=error&reason=invalid_state",
      );
      expect(calls.length).toBe(0);

      const after = await getConnectedAccount(tenant.tenantId, "youtube");
      expect(after).toEqual(before);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});
