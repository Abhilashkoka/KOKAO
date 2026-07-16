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
  insertLinkedinAccount,
  getConnectedAccount,
  snapshotAppCredentialRow,
  setAppCredentialRow,
  restoreAppCredentialRow,
} from "../test/dbHelpers";

const app = createTestApp();

// Fresh identity/token minted by the mocked LinkedIn OAuth exchange.
const LI_NEW_ACCESS_TOKEN = "li_new_access_token";
const LI_NEW_PERSON_ID = "li_person_new_456";
const LI_NEW_NAME = "Fresh Person";

// The stale credentials on the dead row that must be fully replaced.
const LI_STALE_TOKEN = "li_stale_dead_token";

let linkedinSnapshot: AppCredential | null = null;

beforeAll(async () => {
  linkedinSnapshot = await snapshotAppCredentialRow("linkedin");
});

afterAll(async () => {
  await restoreAppCredentialRow("linkedin", linkedinSnapshot);
  await pool.end();
});

beforeEach(async () => {
  resetAuthState();
  process.env.SESSION_SECRET =
    process.env.SESSION_SECRET || "test-session-secret";
  await setAppCredentialRow("linkedin", {
    clientId: "li-client-id-default",
    clientSecret: "li-client-secret-default",
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
 * Route the two LinkedIn OAuth callback round-trips (code -> access token,
 * userinfo lookup) to canned success responses so the callback happy path runs
 * without the network.
 */
function mockLinkedinApi(): MockCall[] {
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

      if (url.startsWith("https://www.linkedin.com/oauth/v2/accessToken")) {
        return json({
          access_token: LI_NEW_ACCESS_TOKEN,
          expires_in: 60 * 24 * 60 * 60, // ~60 days
        });
      }
      if (url.startsWith("https://api.linkedin.com/v2/userinfo")) {
        return json({ sub: LI_NEW_PERSON_ID, name: LI_NEW_NAME });
      }
      return json({});
    },
  );
  return calls;
}

/**
 * Route the callback's LinkedIn round-trips to configurable failures so the
 * error branches run without the network.
 */
function mockLinkedinApiFailing(opts: {
  tokenStatus?: number;
  userinfoStatus?: number;
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

      if (url.startsWith("https://www.linkedin.com/oauth/v2/accessToken")) {
        if (opts.tokenStatus && opts.tokenStatus >= 400) {
          return json(
            { error: "invalid_grant", error_description: "Code expired" },
            opts.tokenStatus,
          );
        }
        return json({
          access_token: LI_NEW_ACCESS_TOKEN,
          expires_in: 60 * 24 * 60 * 60,
        });
      }
      if (url.startsWith("https://api.linkedin.com/v2/userinfo")) {
        if (opts.userinfoStatus && opts.userinfoStatus >= 400) {
          return json({ message: "Invalid access token" }, opts.userinfoStatus);
        }
        return json({ sub: LI_NEW_PERSON_ID, name: LI_NEW_NAME });
      }
      return json({});
    },
  );
  return calls;
}

/** Seed a pre-existing (dead) LinkedIn row and return its full snapshot. */
async function seedExistingRow(tenantId: number) {
  await insertLinkedinAccount(tenantId, {
    accessToken: LI_STALE_TOKEN,
    providerUserId: "li_person_old",
    tokenExpiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    status: "error",
    accountName: "Old Person",
    verifyStatus: "failed",
    verifyError:
      "Your LinkedIn access is no longer valid. Reconnect LinkedIn to keep publishing.",
  });
  return getConnectedAccount(tenantId, "linkedin");
}

/** Mint a real signed state for the tenant via the authorize-URL endpoint. */
async function mintState(clerkUserId: string): Promise<string> {
  actAs(clerkUserId);
  const urlRes = await request(app).get("/api/linkedin/auth/url");
  expect(urlRes.status).toBe(200);
  const state = new URL(urlRes.body.url).searchParams.get("state")!;
  expect(state).toBeTruthy();
  return state;
}

describe("LinkedIn connect: GET /linkedin/auth/callback (reconnect over a dead row)", () => {
  it("reactivates a dead connection in place on reconnect (UPDATE, not a second row)", async () => {
    const calls = mockLinkedinApi();
    const tenant = await createTenant();
    try {
      // Seed an existing LinkedIn row that went dead: verification failed, an
      // error recorded, a stale token, an old identity, and an expired clock.
      await insertLinkedinAccount(tenant.tenantId, {
        accessToken: LI_STALE_TOKEN,
        providerUserId: "li_person_old",
        tokenExpiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        status: "error",
        accountName: "Old Person",
        verifyStatus: "failed",
        verifyError:
          "Your LinkedIn access is no longer valid. Reconnect LinkedIn to keep publishing.",
      });
      const deadRow = await getConnectedAccount(tenant.tenantId, "linkedin");
      expect(deadRow.verifyStatus).toBe("failed");
      expect(deadRow.verifyError).toBeTruthy();

      // Drive the callback happy path for the same tenant with a real signed
      // state minted by the authorize-URL endpoint.
      actAs(tenant.clerkUserId);
      const urlRes = await request(app).get("/api/linkedin/auth/url");
      expect(urlRes.status).toBe(200);
      const state = new URL(urlRes.body.url).searchParams.get("state")!;
      expect(state).toBeTruthy();

      const res = await request(app)
        .get("/api/linkedin/auth/callback")
        .query({ code: "AUTH_CODE", state });

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/accounts?linkedin=connected");

      // Both OAuth round-trips actually happened.
      expect(
        calls.some((c) =>
          c.url.startsWith("https://www.linkedin.com/oauth/v2/accessToken"),
        ),
      ).toBe(true);
      expect(
        calls.some((c) =>
          c.url.startsWith("https://api.linkedin.com/v2/userinfo"),
        ),
      ).toBe(true);

      // Exactly one linkedin row exists for the tenant — the callback updated
      // the dead row rather than inserting a second one.
      const { rows } = await pool.query(
        "SELECT id FROM connected_accounts WHERE tenant_id = $1 AND platform = 'linkedin'",
        [tenant.tenantId],
      );
      expect(rows.length).toBe(1);
      expect(rows[0].id).toBe(deadRow.id);

      // The row was fully reactivated: status back to connected/verified, the
      // stale error cleared, and identity/token fields refreshed.
      const row = await getConnectedAccount(tenant.tenantId, "linkedin");
      expect(row.id).toBe(deadRow.id);
      expect(row.status).toBe("connected");
      expect(row.verifyStatus).toBe("verified");
      expect(row.verifyError).toBeNull();
      expect(row.providerUserId).toBe(LI_NEW_PERSON_ID);
      expect(row.accountName).toBe(LI_NEW_NAME);
      expect(row.accessToken).toBe(LI_NEW_ACCESS_TOKEN);
      expect(row.accessToken).not.toBe(LI_STALE_TOKEN);
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

describe("LinkedIn connect callback error paths leave the stored row untouched", () => {
  it("redirects with reason=token_exchange and does not modify the row when the token exchange fails", async () => {
    const calls = mockLinkedinApiFailing({ tokenStatus: 400 });
    const tenant = await createTenant();
    try {
      const before = await seedExistingRow(tenant.tenantId);
      const state = await mintState(tenant.clerkUserId);

      const res = await request(app)
        .get("/api/linkedin/auth/callback")
        .query({ code: "AUTH_CODE", state });

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(
        "/accounts?linkedin=error&reason=token_exchange",
      );

      // The token endpoint was hit, but userinfo never was.
      expect(
        calls.some((c) =>
          c.url.startsWith("https://www.linkedin.com/oauth/v2/accessToken"),
        ),
      ).toBe(true);
      expect(
        calls.some((c) =>
          c.url.startsWith("https://api.linkedin.com/v2/userinfo"),
        ),
      ).toBe(false);

      const after = await getConnectedAccount(tenant.tenantId, "linkedin");
      expect(after).toEqual(before);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("redirects with reason=userinfo and does not modify the row when userinfo fails after a successful token exchange", async () => {
    const calls = mockLinkedinApiFailing({ userinfoStatus: 401 });
    const tenant = await createTenant();
    try {
      const before = await seedExistingRow(tenant.tenantId);
      const state = await mintState(tenant.clerkUserId);

      const res = await request(app)
        .get("/api/linkedin/auth/callback")
        .query({ code: "AUTH_CODE", state });

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(
        "/accounts?linkedin=error&reason=userinfo",
      );

      // Both round-trips happened; the failure came from userinfo.
      expect(
        calls.some((c) =>
          c.url.startsWith("https://www.linkedin.com/oauth/v2/accessToken"),
        ),
      ).toBe(true);
      expect(
        calls.some((c) =>
          c.url.startsWith("https://api.linkedin.com/v2/userinfo"),
        ),
      ).toBe(true);

      // Crucially, the fresh access token from the successful exchange was NOT
      // partially written before the userinfo failure.
      const after = await getConnectedAccount(tenant.tenantId, "linkedin");
      expect(after).toEqual(before);
      expect(after.accessToken).toBe(LI_STALE_TOKEN);
      expect(after.accessToken).not.toBe(LI_NEW_ACCESS_TOKEN);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("redirects with reason=invalid_state and never calls LinkedIn when the state is tampered", async () => {
    const calls = mockLinkedinApiFailing({});
    const tenant = await createTenant();
    try {
      const before = await seedExistingRow(tenant.tenantId);
      const state = await mintState(tenant.clerkUserId);
      const tampered = `${state.slice(0, -4)}0000`;

      const res = await request(app)
        .get("/api/linkedin/auth/callback")
        .query({ code: "AUTH_CODE", state: tampered });

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(
        "/accounts?linkedin=error&reason=invalid_state",
      );
      expect(calls.length).toBe(0);

      const after = await getConnectedAccount(tenant.tenantId, "linkedin");
      expect(after).toEqual(before);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("redirects with reason=invalid_state and never calls LinkedIn when the state is missing", async () => {
    const calls = mockLinkedinApiFailing({});
    const tenant = await createTenant();
    try {
      const before = await seedExistingRow(tenant.tenantId);

      const res = await request(app)
        .get("/api/linkedin/auth/callback")
        .query({ code: "AUTH_CODE" });

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(
        "/accounts?linkedin=error&reason=invalid_state",
      );
      expect(calls.length).toBe(0);

      const after = await getConnectedAccount(tenant.tenantId, "linkedin");
      expect(after).toEqual(before);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("redirects with reason=invalid_state and never calls LinkedIn when the state has expired", async () => {
    const calls = mockLinkedinApiFailing({});
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
        const urlRes = await request(app).get("/api/linkedin/auth/url");
        expect(urlRes.status).toBe(200);
        state = new URL(urlRes.body.url).searchParams.get("state")!;
      } finally {
        vi.useRealTimers();
      }

      const res = await request(app)
        .get("/api/linkedin/auth/callback")
        .query({ code: "AUTH_CODE", state });

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(
        "/accounts?linkedin=error&reason=invalid_state",
      );
      expect(calls.length).toBe(0);

      const after = await getConnectedAccount(tenant.tenantId, "linkedin");
      expect(after).toEqual(before);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});
