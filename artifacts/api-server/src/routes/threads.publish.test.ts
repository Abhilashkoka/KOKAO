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
import { chunkOnWhitespace } from "@workspace/social-limits";
import { createTestApp } from "../test/testApp";
import { resetAuthState, actAs } from "../test/authState";
import {
  createTenant,
  deleteTenant,
  insertThreadsAccount,
  insertContentItem,
  getContentItem,
  getConnectedAccount,
  snapshotAppCredentialRow,
  setAppCredentialRow,
  restoreAppCredentialRow,
} from "../test/dbHelpers";
import { ObjectStorageService } from "../lib/objectStorage";

const app = createTestApp();

const TH_TOKEN = "th_tok_secret";
const TH_USER_ID = "th_user_123";
const GRAPH_BASE = "https://graph.threads.net/v1.0";

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
  method: string;
  body: string;
}

type RecentPost = { id: string; text: string; timestamp: string };

/**
 * Simulate the Threads Graph API. `recentPosts` is what the duplicate-post
 * probe (GET /{user}/threads) sees — the posts a previous "committed but
 * response lost" attempt actually created. Set `recentPostsStatus` to make
 * the probe itself fail. Container creation and publish POSTs are recorded
 * and return sequential ids.
 */
function mockThreadsApi(opts: {
  recentPosts?: RecentPost[];
  recentPostsStatus?: number;
}): MockCall[] {
  const calls: MockCall[] = [];
  let containerSeq = 0;
  let publishSeq = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: String(init?.body ?? "") });
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });

      if (
        method === "GET" &&
        url.startsWith(`${GRAPH_BASE}/${TH_USER_ID}/threads?`)
      ) {
        if (opts.recentPostsStatus && opts.recentPostsStatus >= 400) {
          return json({ error: { message: "boom" } }, opts.recentPostsStatus);
        }
        return json({ data: opts.recentPosts ?? [] });
      }
      if (method === "POST" && url === `${GRAPH_BASE}/${TH_USER_ID}/threads`) {
        containerSeq += 1;
        return json({ id: `CONTAINER_${containerSeq}` });
      }
      if (
        method === "POST" &&
        url === `${GRAPH_BASE}/${TH_USER_ID}/threads_publish`
      ) {
        publishSeq += 1;
        return json({ id: `POST_${publishSeq}` });
      }
      return json({});
    },
  );
  return calls;
}

function publishPosts(calls: MockCall[]): MockCall[] {
  return calls.filter(
    (c) =>
      c.method === "POST" && c.url === `${GRAPH_BASE}/${TH_USER_ID}/threads`,
  );
}

describe("Threads publish duplicate-post guard", () => {
  it("short-circuits with the existing post when the publish already landed (committed but response lost)", async () => {
    const caption = "hello world";
    const calls = mockThreadsApi({
      recentPosts: [
        {
          id: "EXISTING_1",
          text: caption,
          timestamp: new Date().toISOString(),
        },
      ],
    });
    const signedUrlSpy = vi.spyOn(
      ObjectStorageService.prototype,
      "getSignedDownloadURL",
    );

    const tenant = await createTenant();
    try {
      await insertThreadsAccount(tenant.tenantId, {
        accessToken: TH_TOKEN,
        providerUserId: TH_USER_ID,
      });
      const itemId = await insertContentItem(tenant.tenantId, {
        caption,
        imagePath: "/objects/uploads/test.png",
      });
      actAs(tenant.clerkUserId);

      const res = await request(app).post(
        `/api/content/${itemId}/publish-threads`,
      );

      expect(res.status).toBe(200);
      expect(res.body.postId).toBe("EXISTING_1");
      // Only one post happened in total (the original, before this request):
      // no new container/publish POSTs were made.
      expect(publishPosts(calls).length).toBe(0);
      expect(
        calls.filter((c) => c.url.endsWith("/threads_publish")).length,
      ).toBe(0);
      // The image already went with the landed post — no new signed URL.
      expect(signedUrlSpy).not.toHaveBeenCalled();

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).toBe("published");
      expect(item.postId).toBe("EXISTING_1");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("resumes a partially landed reply chain: skips the landed first post and chains the rest from it", async () => {
    const caption = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
    const chunks = chunkOnWhitespace(caption, 500);
    expect(chunks.length).toBeGreaterThan(1);

    const calls = mockThreadsApi({
      recentPosts: [
        {
          id: "EXISTING_FIRST",
          text: chunks[0],
          timestamp: new Date().toISOString(),
        },
      ],
    });

    const tenant = await createTenant();
    try {
      await insertThreadsAccount(tenant.tenantId, {
        accessToken: TH_TOKEN,
        providerUserId: TH_USER_ID,
      });
      const itemId = await insertContentItem(tenant.tenantId, { caption });
      actAs(tenant.clerkUserId);

      const res = await request(app).post(
        `/api/content/${itemId}/publish-threads`,
      );

      expect(res.status).toBe(200);
      // The already-landed first post is reused as the thread anchor.
      expect(res.body.postId).toBe("EXISTING_FIRST");
      expect(res.body.postsTotal).toBe(chunks.length);

      // Only the follow-up chunks were posted; the first was NOT re-posted.
      const containerCalls = publishPosts(calls);
      expect(containerCalls.length).toBe(chunks.length - 1);
      for (const c of containerCalls) {
        expect(c.body).not.toContain(encodeURIComponent(chunks[0]));
      }
      // The first follow-up chains as a reply to the EXISTING post.
      expect(containerCalls[0].body).toContain("reply_to_id=EXISTING_FIRST");

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).toBe("published");
      expect(item.postId).toBe("EXISTING_FIRST");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("posts normally when the identical recent post is older than the dedupe window", async () => {
    const caption = "hello world";
    const calls = mockThreadsApi({
      recentPosts: [
        {
          id: "OLD_POST",
          text: caption,
          timestamp: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        },
      ],
    });

    const tenant = await createTenant();
    try {
      await insertThreadsAccount(tenant.tenantId, {
        accessToken: TH_TOKEN,
        providerUserId: TH_USER_ID,
      });
      const itemId = await insertContentItem(tenant.tenantId, { caption });
      actAs(tenant.clerkUserId);

      const res = await request(app).post(
        `/api/content/${itemId}/publish-threads`,
      );

      expect(res.status).toBe(200);
      expect(res.body.postId).toBe("POST_1");
      expect(publishPosts(calls).length).toBe(1);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("still publishes when the duplicate-post probe itself fails (best-effort)", async () => {
    const calls = mockThreadsApi({ recentPostsStatus: 500 });

    const tenant = await createTenant();
    try {
      await insertThreadsAccount(tenant.tenantId, {
        accessToken: TH_TOKEN,
        providerUserId: TH_USER_ID,
      });
      const itemId = await insertContentItem(tenant.tenantId, {
        caption: "hello world",
      });
      actAs(tenant.clerkUserId);

      const res = await request(app).post(
        `/api/content/${itemId}/publish-threads`,
      );

      expect(res.status).toBe(200);
      expect(res.body.postId).toBe("POST_1");
      expect(publishPosts(calls).length).toBe(1);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("always addresses the probe to the stored providerUserId, never a client-supplied id", async () => {
    const calls = mockThreadsApi({ recentPosts: [] });

    const tenant = await createTenant();
    try {
      await insertThreadsAccount(tenant.tenantId, {
        accessToken: TH_TOKEN,
        providerUserId: TH_USER_ID,
      });
      const itemId = await insertContentItem(tenant.tenantId, {
        caption: "hello world",
      });
      actAs(tenant.clerkUserId);

      // A hostile client tries to steer the probe toward someone else's
      // account. The endpoint takes no user id, so none of these must ever
      // reach the Threads API.
      const res = await request(app)
        .post(
          `/api/content/${itemId}/publish-threads?userId=attacker_999&providerUserId=attacker_999`,
        )
        .send({ userId: "attacker_999", providerUserId: "attacker_999" });

      expect(res.status).toBe(200);

      // The probe ran exactly once and was addressed to the STORED account id.
      const probeCalls = calls.filter(
        (c) => c.method === "GET" && c.url.includes("/threads?"),
      );
      expect(probeCalls.length).toBe(1);
      expect(
        probeCalls[0].url.startsWith(`${GRAPH_BASE}/${TH_USER_ID}/threads?`),
      ).toBe(true);

      // No outbound request anywhere carried the client-supplied id.
      for (const c of calls) {
        expect(c.url).not.toContain("attacker_999");
        expect(c.body).not.toContain("attacker_999");
      }
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("never probes when providerUserId is missing: publish is blocked with a reconnect prompt", async () => {
    // Threads cannot publish at all without the stored account id (both the
    // probe and every publish call are addressed by it), so a missing
    // providerUserId must block the publish outright — it must never fall
    // back to some other identifier for the probe.
    const calls = mockThreadsApi({
      recentPosts: [
        {
          id: "EXISTING_1",
          text: "hello world",
          timestamp: new Date().toISOString(),
        },
      ],
    });

    const tenant = await createTenant();
    try {
      await insertThreadsAccount(tenant.tenantId, {
        accessToken: TH_TOKEN,
        providerUserId: null,
      });
      const itemId = await insertContentItem(tenant.tenantId, {
        caption: "hello world",
      });
      actAs(tenant.clerkUserId);

      const res = await request(app).post(
        `/api/content/${itemId}/publish-threads`,
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/reconnect/i);
      // No Threads API traffic at all: no probe, no container, no publish.
      expect(calls.length).toBe(0);

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).not.toBe("published");
      expect(item.postId ?? null).toBeNull();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});

// ---------------------------------------------------------------------------
// Token auto-refresh runs INLINE before a publish (same maybeRefreshToken as
// GET /threads/status). These tests pin the publish-path outcomes:
//   1. a rejected refresh of a dead token returns the clear 400 reconnect
//      error and never touches the Graph publish endpoints;
//   2. a transient refresh blip with a still-valid token lets the publish
//      proceed on the STORED token;
//   3. a successful refresh publishes with the ROLLED token.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const REFRESH_URL = "https://graph.threads.net/refresh_access_token";
const TH_ROLLED_TOKEN = "th_rolled_token_publish";

type RefreshBehavior =
  | { kind: "success"; accessToken: string; expiresIn: number }
  | { kind: "rejected"; status: number }
  | { kind: "network-error" };

/**
 * Like mockThreadsApi, but also intercepts the refresh endpoint with the
 * requested behavior so publish + inline refresh can be exercised together.
 */
function mockThreadsApiWithRefresh(behavior: RefreshBehavior): MockCall[] {
  const calls: MockCall[] = [];
  let containerSeq = 0;
  let publishSeq = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: String(init?.body ?? "") });
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });

      if (url.startsWith(REFRESH_URL)) {
        switch (behavior.kind) {
          case "success":
            return json({
              access_token: behavior.accessToken,
              expires_in: behavior.expiresIn,
            });
          case "rejected":
            return json(
              { error: { message: "Token is invalid" } },
              behavior.status,
            );
          case "network-error":
            throw new TypeError("fetch failed");
        }
      }
      if (
        method === "GET" &&
        url.startsWith(`${GRAPH_BASE}/${TH_USER_ID}/threads?`)
      ) {
        return json({ data: [] });
      }
      if (method === "POST" && url === `${GRAPH_BASE}/${TH_USER_ID}/threads`) {
        containerSeq += 1;
        return json({ id: `CONTAINER_${containerSeq}` });
      }
      if (
        method === "POST" &&
        url === `${GRAPH_BASE}/${TH_USER_ID}/threads_publish`
      ) {
        publishSeq += 1;
        return json({ id: `POST_${publishSeq}` });
      }
      return json({});
    },
  );
  return calls;
}

function graphCalls(calls: MockCall[]): MockCall[] {
  return calls.filter((c) => c.url.startsWith(GRAPH_BASE));
}

describe("Threads publish inline token refresh", () => {
  it("returns the 400 reconnect error and makes no publish calls when an expired token's refresh is rejected", async () => {
    const calls = mockThreadsApiWithRefresh({ kind: "rejected", status: 401 });

    const tenant = await createTenant();
    try {
      await insertThreadsAccount(tenant.tenantId, {
        accessToken: TH_TOKEN,
        providerUserId: TH_USER_ID,
        tokenExpiresAt: new Date(Date.now() - DAY_MS),
      });
      const itemId = await insertContentItem(tenant.tenantId, {
        caption: "hello world",
      });
      actAs(tenant.clerkUserId);

      const res = await request(app).post(
        `/api/content/${itemId}/publish-threads`,
      );

      // The clear reconnect message — not a confusing Threads platform error.
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/reconnect/i);

      // The refresh was attempted, but no Graph traffic followed: no probe,
      // no container, no publish on the dead token.
      expect(calls.some((c) => c.url.startsWith(REFRESH_URL))).toBe(true);
      expect(graphCalls(calls).length).toBe(0);

      // The row was flipped so the Accounts page shows the reconnect prompt.
      const row = await getConnectedAccount(tenant.tenantId, "threads");
      expect(row?.verifyStatus).toBe("failed");
      expect(row?.verifyError).toContain("Reconnect Threads");

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).not.toBe("published");
      expect(item.postId ?? null).toBeNull();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("publishes on the stored token when the refresh fails transiently but the token is still valid", async () => {
    const calls = mockThreadsApiWithRefresh({ kind: "network-error" });

    const tenant = await createTenant();
    try {
      // Inside the 7-day renewal window but not yet expired.
      const nearExpiry = new Date(Date.now() + 2 * DAY_MS);
      await insertThreadsAccount(tenant.tenantId, {
        accessToken: TH_TOKEN,
        providerUserId: TH_USER_ID,
        tokenExpiresAt: nearExpiry,
      });
      const itemId = await insertContentItem(tenant.tenantId, {
        caption: "hello world",
      });
      actAs(tenant.clerkUserId);

      const res = await request(app).post(
        `/api/content/${itemId}/publish-threads`,
      );

      // A transient refresh blip must not block the publish.
      expect(res.status).toBe(200);
      expect(res.body.postId).toBe("POST_1");

      // The refresh was attempted; the publish went through on the STORED
      // token.
      expect(calls.some((c) => c.url.startsWith(REFRESH_URL))).toBe(true);
      const containers = calls.filter(
        (c) =>
          c.method === "POST" &&
          c.url === `${GRAPH_BASE}/${TH_USER_ID}/threads`,
      );
      expect(containers.length).toBe(1);
      expect(containers[0].body).toContain(encodeURIComponent(TH_TOKEN));

      // Token and state untouched by the blip.
      const row = await getConnectedAccount(tenant.tenantId, "threads");
      expect(row?.accessToken).toBe(TH_TOKEN);
      expect(row?.tokenExpiresAt?.getTime()).toBe(nearExpiry.getTime());
      expect(row?.verifyStatus).toBe("verified");

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).toBe("published");
      expect(item.postId).toBe("POST_1");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("publishes with the rolled token after a successful inline refresh", async () => {
    const calls = mockThreadsApiWithRefresh({
      kind: "success",
      accessToken: TH_ROLLED_TOKEN,
      expiresIn: (60 * DAY_MS) / 1000,
    });

    const tenant = await createTenant();
    try {
      await insertThreadsAccount(tenant.tenantId, {
        accessToken: TH_TOKEN,
        providerUserId: TH_USER_ID,
        tokenExpiresAt: new Date(Date.now() + 2 * DAY_MS),
      });
      const itemId = await insertContentItem(tenant.tenantId, {
        caption: "hello world",
      });
      actAs(tenant.clerkUserId);

      const res = await request(app).post(
        `/api/content/${itemId}/publish-threads`,
      );

      expect(res.status).toBe(200);
      expect(res.body.postId).toBe("POST_1");

      // The publish carried the NEW token, not the stale one.
      const containers = calls.filter(
        (c) =>
          c.method === "POST" &&
          c.url === `${GRAPH_BASE}/${TH_USER_ID}/threads`,
      );
      expect(containers.length).toBe(1);
      expect(containers[0].body).toContain(
        encodeURIComponent(TH_ROLLED_TOKEN),
      );
      expect(containers[0].body).not.toContain(encodeURIComponent(TH_TOKEN));

      const row = await getConnectedAccount(tenant.tenantId, "threads");
      expect(row?.accessToken).toBe(TH_ROLLED_TOKEN);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("refreshes an already-expired token inline and publishes on the rolled token", async () => {
    mockThreadsApiWithRefresh({
      kind: "success",
      accessToken: TH_ROLLED_TOKEN,
      expiresIn: (60 * DAY_MS) / 1000,
    });

    const tenant = await createTenant();
    try {
      await insertThreadsAccount(tenant.tenantId, {
        accessToken: TH_TOKEN,
        providerUserId: TH_USER_ID,
        tokenExpiresAt: new Date(Date.now() - DAY_MS),
      });
      const itemId = await insertContentItem(tenant.tenantId, {
        caption: "hello world",
      });
      actAs(tenant.clerkUserId);

      const res = await request(app).post(
        `/api/content/${itemId}/publish-threads`,
      );

      // The expired-but-refreshable token recovers transparently.
      expect(res.status).toBe(200);
      expect(res.body.postId).toBe("POST_1");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("blocks the publish when the token is expired and the refresh fails transiently", async () => {
    const calls = mockThreadsApiWithRefresh({ kind: "network-error" });

    const tenant = await createTenant();
    try {
      await insertThreadsAccount(tenant.tenantId, {
        accessToken: TH_TOKEN,
        providerUserId: TH_USER_ID,
        tokenExpiresAt: new Date(Date.now() - DAY_MS),
      });
      const itemId = await insertContentItem(tenant.tenantId, {
        caption: "hello world",
      });
      actAs(tenant.clerkUserId);

      const res = await request(app).post(
        `/api/content/${itemId}/publish-threads`,
      );

      // An expired token with no successful refresh must NOT be sent to the
      // Graph API (confusing platform error) — clear 400 instead.
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/reconnect/i);
      expect(graphCalls(calls).length).toBe(0);

      // Transient failure: the stored token survives for the next attempt.
      const row = await getConnectedAccount(tenant.tenantId, "threads");
      expect(row?.accessToken).toBe(TH_TOKEN);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});
