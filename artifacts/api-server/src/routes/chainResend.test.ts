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

import {
  db,
  pool,
  contentItemsTable,
  type AppCredential,
  type ThreadChainState,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { createTestApp } from "../test/testApp";
import { resetAuthState, actAs } from "../test/authState";
import {
  createTenant,
  deleteTenant,
  insertThreadsAccount,
  insertConnectedAccount,
  setAccountState,
  insertContentItem,
  getContentItem,
  snapshotAppCredentialRow,
  setAppCredentialRow,
  restoreAppCredentialRow,
  snapshotTwitterRow,
  setVerifiedTwitterRow,
  restoreTwitterRow,
} from "../test/dbHelpers";

const app = createTestApp();

const TH_TOKEN = "th_tok_secret";
const TH_USER_ID = "th_user_123";
const TH_GRAPH_BASE = "https://graph.threads.net/v1.0";

const X_ACCESS_TOKEN = "x_access_token_oauth2";
const X_REFRESH_TOKEN = "x_refresh_token_secret";
const X_USER_ID = "x_user_123";
const X_API_BASE = "https://api.x.com";

let threadsSnapshot: AppCredential | null = null;
let twitterSnapshot: AppCredential | null = null;

beforeAll(async () => {
  threadsSnapshot = await snapshotAppCredentialRow("threads");
  twitterSnapshot = await snapshotTwitterRow();
});

afterAll(async () => {
  await restoreAppCredentialRow("threads", threadsSnapshot);
  await restoreTwitterRow(twitterSnapshot);
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
  await setVerifiedTwitterRow();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function setChainState(
  itemId: number,
  tenantId: number,
  column: "threadsChainState" | "twitterChainState",
  state: ThreadChainState | null,
): Promise<void> {
  await db
    .update(contentItemsTable)
    .set({ [column]: state, status: "published", postId: state?.firstPostId })
    .where(
      and(
        eq(contentItemsTable.id, itemId),
        eq(contentItemsTable.tenantId, tenantId),
      ),
    );
}

interface MockCall {
  url: string;
  method: string;
  body: string;
}

/**
 * Simulate the Threads Graph API. `failPublishFrom` makes the Nth publish
 * (1-based, counting publish POSTs in this run) and all later ones fail with
 * a 500 — used to force a mid-chain failure.
 */
function mockThreadsApi(
  opts: {
    failPublishFrom?: number;
    recentPosts?: unknown[];
    probeError?: boolean;
  } = {},
): MockCall[] {
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
        url.startsWith(`${TH_GRAPH_BASE}/${TH_USER_ID}/threads?`)
      ) {
        if (opts.probeError) throw new Error("probe network failure");
        return json({ data: opts.recentPosts ?? [] });
      }
      if (
        method === "POST" &&
        url === `${TH_GRAPH_BASE}/${TH_USER_ID}/threads`
      ) {
        containerSeq += 1;
        return json({ id: `CONTAINER_${containerSeq}` });
      }
      if (
        method === "POST" &&
        url === `${TH_GRAPH_BASE}/${TH_USER_ID}/threads_publish`
      ) {
        publishSeq += 1;
        if (opts.failPublishFrom && publishSeq >= opts.failPublishFrom) {
          return json({ error: { message: "transient failure" } }, 500);
        }
        return json({ id: `POST_${publishSeq}` });
      }
      return json({});
    },
  );
  return calls;
}

/** Simulate the X API: tweet creation, recent-tweets probe. */
function mockTwitterApi(
  opts: {
    failTweetFrom?: number;
    recentTweets?: unknown[];
    probeError?: boolean;
  } = {},
): MockCall[] {
  const calls: MockCall[] = [];
  let tweetSeq = 0;
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
        url.startsWith(`${X_API_BASE}/2/users/${X_USER_ID}/tweets`)
      ) {
        if (opts.probeError) throw new Error("probe network failure");
        return json({ data: opts.recentTweets ?? [] });
      }
      if (method === "POST" && url === `${X_API_BASE}/2/tweets`) {
        tweetSeq += 1;
        if (opts.failTweetFrom && tweetSeq >= opts.failTweetFrom) {
          return json({ detail: "transient failure" }, 500);
        }
        return json({ data: { id: `TWEET_${tweetSeq}` } });
      }
      return json({});
    },
  );
  return calls;
}

async function connectVerifiedX(tenantId: number): Promise<void> {
  await insertConnectedAccount(
    tenantId,
    "twitter",
    { accessToken: X_ACCESS_TOKEN, refreshToken: X_REFRESH_TOKEN },
    "verified",
    "@testhandle",
  );
  await setAccountState(tenantId, "twitter", {
    providerUserId: X_USER_ID,
    tokenExpiresAt: null,
  });
}

// ---------------------------------------------------------------------------
// Threads: mid-chain failure records resumable state; resend completes it.
// ---------------------------------------------------------------------------

describe("Threads reply-chain resend", () => {
  // ~200 words -> multiple 500-char chunks
  const longCaption = Array.from({ length: 200 }, (_, i) => `word${i}`).join(
    " ",
  );

  it("publish persists chain state when a follow-up reply fails mid-chain", async () => {
    // First publish POST (anchor) succeeds, second (first reply) fails.
    mockThreadsApi({ failPublishFrom: 2 });

    const tenant = await createTenant();
    try {
      await insertThreadsAccount(tenant.tenantId, {
        accessToken: TH_TOKEN,
        providerUserId: TH_USER_ID,
      });
      const itemId = await insertContentItem(tenant.tenantId, {
        caption: longCaption,
      });
      actAs(tenant.clerkUserId);

      const res = await request(app).post(
        `/api/content/${itemId}/publish-threads`,
      );

      expect(res.status).toBe(200);
      expect(res.body.publishWarning).toMatch(/could not be posted/i);

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).toBe("published");
      const state = item.threadsChainState as ThreadChainState;
      expect(state).toBeTruthy();
      expect(state.postedCount).toBe(1);
      expect(state.lastPostedId).toBe("POST_1");
      expect(state.posts.length).toBeGreaterThan(1);
      expect(state.posts[0].startsWith("word0")).toBe(true);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("resend posts only the missing pieces, chained onto the last posted id, and clears the state", async () => {
    const calls = mockThreadsApi();

    const tenant = await createTenant();
    try {
      await insertThreadsAccount(tenant.tenantId, {
        accessToken: TH_TOKEN,
        providerUserId: TH_USER_ID,
      });
      const itemId = await insertContentItem(tenant.tenantId, {
        caption: longCaption,
      });
      const posts = ["first chunk", "second chunk", "third chunk"];
      await setChainState(itemId, tenant.tenantId, "threadsChainState", {
        firstPostId: "ANCHOR",
        lastPostedId: "ANCHOR",
        posts,
        postedCount: 1,
      });
      actAs(tenant.clerkUserId);

      const res = await request(app).post(
        `/api/content/${itemId}/resend-threads-posts`,
      );

      expect(res.status).toBe(200);
      expect(res.body.postsPublished).toBe(3);
      expect(res.body.postsRemaining).toBe(0);
      expect(res.body.publishWarning).toBeUndefined();

      // Only the two missing pieces were posted; the first chunk was not.
      const containerCalls = calls.filter(
        (c) =>
          c.method === "POST" &&
          c.url === `${TH_GRAPH_BASE}/${TH_USER_ID}/threads`,
      );
      expect(containerCalls.length).toBe(2);
      expect(containerCalls[0].body).toContain("text=second+chunk");
      // The first resent piece chains onto the last successfully posted id.
      expect(containerCalls[0].body).toContain("reply_to_id=ANCHOR");
      expect(containerCalls[1].body).toContain("reply_to_id=POST_1");

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.threadsChainState).toBeNull();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("a mid-resend failure keeps resumable state so a later resend can continue", async () => {
    // First publish POST in the resend succeeds, second fails.
    mockThreadsApi({ failPublishFrom: 2 });

    const tenant = await createTenant();
    try {
      await insertThreadsAccount(tenant.tenantId, {
        accessToken: TH_TOKEN,
        providerUserId: TH_USER_ID,
      });
      const itemId = await insertContentItem(tenant.tenantId, {
        caption: longCaption,
      });
      await setChainState(itemId, tenant.tenantId, "threadsChainState", {
        firstPostId: "ANCHOR",
        lastPostedId: "ANCHOR",
        posts: ["first chunk", "second chunk", "third chunk"],
        postedCount: 1,
      });
      actAs(tenant.clerkUserId);

      const res = await request(app).post(
        `/api/content/${itemId}/resend-threads-posts`,
      );

      expect(res.status).toBe(200);
      expect(res.body.postsPublished).toBe(2);
      expect(res.body.postsRemaining).toBe(1);
      expect(res.body.publishWarning).toMatch(/still could not/i);

      const item = await getContentItem(itemId, tenant.tenantId);
      const state = item.threadsChainState as ThreadChainState;
      expect(state.postedCount).toBe(2);
      expect(state.lastPostedId).toBe("POST_1");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("double-click resend: the second click reuses posts that landed via the dedupe probe instead of double-posting", async () => {
    // First click: the first missing piece ("second chunk") posts as POST_1,
    // then the next publish fails with a transient 500 — but simulate that
    // the write actually LANDED on Threads despite the error response.
    const firstCalls = mockThreadsApi({ failPublishFrom: 2 });

    const tenant = await createTenant();
    try {
      await insertThreadsAccount(tenant.tenantId, {
        accessToken: TH_TOKEN,
        providerUserId: TH_USER_ID,
      });
      const itemId = await insertContentItem(tenant.tenantId, {
        caption: longCaption,
      });
      await setChainState(itemId, tenant.tenantId, "threadsChainState", {
        firstPostId: "ANCHOR",
        lastPostedId: "ANCHOR",
        posts: ["first chunk", "second chunk", "third chunk"],
        postedCount: 1,
      });
      actAs(tenant.clerkUserId);

      const first = await request(app).post(
        `/api/content/${itemId}/resend-threads-posts`,
      );
      expect(first.status).toBe(200);
      expect(first.body.postsRemaining).toBe(1);
      expect(first.body.publishWarning).toMatch(/try resending again/i);
      const firstPublishes = firstCalls.filter(
        (c) =>
          c.method === "POST" &&
          c.url === `${TH_GRAPH_BASE}/${TH_USER_ID}/threads_publish`,
      );
      expect(firstPublishes.length).toBe(2); // one landed, one "failed"

      // Second click: the probe now reports the "failed" third chunk as
      // having landed. No new posts should be created.
      vi.restoreAllMocks();
      const secondCalls = mockThreadsApi({
        recentPosts: [
          {
            id: "LANDED_3",
            text: "third chunk",
            timestamp: new Date().toISOString(),
          },
        ],
      });

      const second = await request(app).post(
        `/api/content/${itemId}/resend-threads-posts`,
      );
      expect(second.status).toBe(200);
      expect(second.body.postsPublished).toBe(3);
      expect(second.body.postsRemaining).toBe(0);
      expect(second.body.publishWarning).toBeUndefined();

      // The second click created ZERO new posts — it reused the landed one.
      const secondContainers = secondCalls.filter(
        (c) =>
          c.method === "POST" &&
          c.url === `${TH_GRAPH_BASE}/${TH_USER_ID}/threads`,
      );
      expect(secondContainers.length).toBe(0);

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.threadsChainState).toBeNull();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("double-click resend: even when the dedupe probe errors, the second click never re-posts pieces that the state says landed", async () => {
    mockThreadsApi({ failPublishFrom: 2 });

    const tenant = await createTenant();
    try {
      await insertThreadsAccount(tenant.tenantId, {
        accessToken: TH_TOKEN,
        providerUserId: TH_USER_ID,
      });
      const itemId = await insertContentItem(tenant.tenantId, {
        caption: longCaption,
      });
      await setChainState(itemId, tenant.tenantId, "threadsChainState", {
        firstPostId: "ANCHOR",
        lastPostedId: "ANCHOR",
        posts: ["first chunk", "second chunk", "third chunk"],
        postedCount: 1,
      });
      actAs(tenant.clerkUserId);

      const first = await request(app).post(
        `/api/content/${itemId}/resend-threads-posts`,
      );
      expect(first.status).toBe(200);
      expect(first.body.postsRemaining).toBe(1);

      // Second click: the dedupe probe itself blows up. The endpoint must
      // fall back to the persisted state and post ONLY the remaining piece.
      vi.restoreAllMocks();
      const secondCalls = mockThreadsApi({ probeError: true });

      const second = await request(app).post(
        `/api/content/${itemId}/resend-threads-posts`,
      );
      expect(second.status).toBe(200);
      expect(second.body.postsPublished).toBe(3);
      expect(second.body.postsRemaining).toBe(0);

      const secondContainers = secondCalls.filter(
        (c) =>
          c.method === "POST" &&
          c.url === `${TH_GRAPH_BASE}/${TH_USER_ID}/threads`,
      );
      expect(secondContainers.length).toBe(1);
      expect(secondContainers[0].body).toContain("text=third+chunk");
      // Chained onto the post that landed during the FIRST click, so the
      // already-posted "second chunk" is never re-posted.
      expect(secondContainers[0].body).toContain("reply_to_id=POST_1");

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.threadsChainState).toBeNull();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("returns 400 when there is nothing to resend", async () => {
    mockThreadsApi();
    const tenant = await createTenant();
    try {
      await insertThreadsAccount(tenant.tenantId, {
        accessToken: TH_TOKEN,
        providerUserId: TH_USER_ID,
      });
      const itemId = await insertContentItem(tenant.tenantId, {
        caption: "hello",
      });
      actAs(tenant.clerkUserId);

      const res = await request(app).post(
        `/api/content/${itemId}/resend-threads-posts`,
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/no missing/i);
      expect(res.body.code).toBe("already_complete");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("two truly simultaneous resends: the second is rejected with 409 while the first is still running, and nothing double-posts", async () => {
    // Gate the first container-create call so the first request stalls
    // mid-resend while the second request arrives.
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let firstPublishStarted!: () => void;
    const publishStarted = new Promise<void>((resolve) => {
      firstPublishStarted = resolve;
    });
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
          url.startsWith(`${TH_GRAPH_BASE}/${TH_USER_ID}/threads?`)
        ) {
          return json({ data: [] });
        }
        if (
          method === "POST" &&
          url === `${TH_GRAPH_BASE}/${TH_USER_ID}/threads`
        ) {
          containerSeq += 1;
          if (containerSeq === 1) {
            firstPublishStarted();
            await gate; // hold the first resend mid-flight
          }
          return json({ id: `CONTAINER_${containerSeq}` });
        }
        if (
          method === "POST" &&
          url === `${TH_GRAPH_BASE}/${TH_USER_ID}/threads_publish`
        ) {
          publishSeq += 1;
          return json({ id: `POST_${publishSeq}` });
        }
        return json({});
      },
    );

    const tenant = await createTenant();
    try {
      await insertThreadsAccount(tenant.tenantId, {
        accessToken: TH_TOKEN,
        providerUserId: TH_USER_ID,
      });
      const itemId = await insertContentItem(tenant.tenantId, {
        caption: longCaption,
      });
      await setChainState(itemId, tenant.tenantId, "threadsChainState", {
        firstPostId: "ANCHOR",
        lastPostedId: "ANCHOR",
        posts: ["first chunk", "second chunk", "third chunk"],
        postedCount: 1,
      });
      actAs(tenant.clerkUserId);

      // .then() forces the lazy supertest request to actually start now.
      const firstPromise = request(app)
        .post(`/api/content/${itemId}/resend-threads-posts`)
        .then((r) => r);
      // Wait until the first request is genuinely mid-resend (it has read
      // the chain state and started posting), then fire the second.
      await publishStarted;
      const second = await request(app).post(
        `/api/content/${itemId}/resend-threads-posts`,
      );
      expect(second.status).toBe(409);
      expect(second.body.error).toMatch(/already in progress/i);

      releaseGate();
      const first = await firstPromise;
      expect(first.status).toBe(200);
      expect(first.body.postsPublished).toBe(3);
      expect(first.body.postsRemaining).toBe(0);

      // Only the first request posted anything: exactly the 2 missing pieces.
      const containerCalls = calls.filter(
        (c) =>
          c.method === "POST" &&
          c.url === `${TH_GRAPH_BASE}/${TH_USER_ID}/threads`,
      );
      expect(containerCalls.length).toBe(2);

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.threadsChainState).toBeNull();

      // The lock is released after the first finishes: a later resend gets
      // a normal 400 (nothing left), not a 409.
      const third = await request(app).post(
        `/api/content/${itemId}/resend-threads-posts`,
      );
      expect(third.status).toBe(400);
    } finally {
      releaseGate();
      await deleteTenant(tenant.tenantId);
    }
  });

  it("cannot resend another tenant's content item", async () => {
    mockThreadsApi();
    const owner = await createTenant();
    const attacker = await createTenant();
    try {
      await insertThreadsAccount(owner.tenantId, {
        accessToken: TH_TOKEN,
        providerUserId: TH_USER_ID,
      });
      const itemId = await insertContentItem(owner.tenantId, {
        caption: "hello",
      });
      await setChainState(itemId, owner.tenantId, "threadsChainState", {
        firstPostId: "ANCHOR",
        lastPostedId: "ANCHOR",
        posts: ["a", "b"],
        postedCount: 1,
      });
      actAs(attacker.clerkUserId);

      const res = await request(app).post(
        `/api/content/${itemId}/resend-threads-posts`,
      );
      expect(res.status).toBe(404);
    } finally {
      await deleteTenant(owner.tenantId);
      await deleteTenant(attacker.tenantId);
    }
  });
});

// ---------------------------------------------------------------------------
// X: same contract for tweet threads.
// ---------------------------------------------------------------------------

describe("X thread resend", () => {
  const longCaption = Array.from({ length: 120 }, (_, i) => `tweet${i}`).join(
    " ",
  );

  it("publish persists chain state when a follow-up tweet fails mid-thread", async () => {
    mockTwitterApi({ failTweetFrom: 2 });

    const tenant = await createTenant();
    try {
      await connectVerifiedX(tenant.tenantId);
      const itemId = await insertContentItem(tenant.tenantId, {
        caption: longCaption,
      });
      actAs(tenant.clerkUserId);

      const res = await request(app).post(
        `/api/content/${itemId}/publish-twitter`,
      );

      expect(res.status).toBe(200);
      expect(res.body.publishWarning).toMatch(/could not be posted/i);

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).toBe("published");
      const state = item.twitterChainState as ThreadChainState;
      expect(state).toBeTruthy();
      expect(state.postedCount).toBe(1);
      expect(state.lastPostedId).toBe("TWEET_1");
      expect(state.posts.length).toBeGreaterThan(1);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("resend posts only the missing tweets, replying to the last posted id, and clears the state", async () => {
    const calls = mockTwitterApi();

    const tenant = await createTenant();
    try {
      await connectVerifiedX(tenant.tenantId);
      const itemId = await insertContentItem(tenant.tenantId, {
        caption: longCaption,
      });
      await setChainState(itemId, tenant.tenantId, "twitterChainState", {
        firstPostId: "ANCHOR_T",
        lastPostedId: "ANCHOR_T",
        posts: ["tweet one", "tweet two", "tweet three"],
        postedCount: 1,
      });
      actAs(tenant.clerkUserId);

      const res = await request(app).post(
        `/api/content/${itemId}/resend-twitter-posts`,
      );

      expect(res.status).toBe(200);
      expect(res.body.postsPublished).toBe(3);
      expect(res.body.postsRemaining).toBe(0);

      const tweetCalls = calls.filter(
        (c) => c.method === "POST" && c.url === `${X_API_BASE}/2/tweets`,
      );
      expect(tweetCalls.length).toBe(2);
      const first = JSON.parse(tweetCalls[0].body);
      const second = JSON.parse(tweetCalls[1].body);
      expect(first.text).toBe("tweet two");
      expect(first.reply.in_reply_to_tweet_id).toBe("ANCHOR_T");
      expect(second.text).toBe("tweet three");
      expect(second.reply.in_reply_to_tweet_id).toBe("TWEET_1");

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.twitterChainState).toBeNull();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("dedupe: reuses a missing tweet that already landed recently instead of re-posting it", async () => {
    const calls = mockTwitterApi({
      recentTweets: [
        {
          id: "ALREADY_LANDED",
          text: "tweet two",
          created_at: new Date().toISOString(),
        },
      ],
    });

    const tenant = await createTenant();
    try {
      await connectVerifiedX(tenant.tenantId);
      const itemId = await insertContentItem(tenant.tenantId, {
        caption: longCaption,
      });
      await setChainState(itemId, tenant.tenantId, "twitterChainState", {
        firstPostId: "ANCHOR_T",
        lastPostedId: "ANCHOR_T",
        posts: ["tweet one", "tweet two", "tweet three"],
        postedCount: 1,
      });
      actAs(tenant.clerkUserId);

      const res = await request(app).post(
        `/api/content/${itemId}/resend-twitter-posts`,
      );

      expect(res.status).toBe(200);
      expect(res.body.postsRemaining).toBe(0);

      // Only ONE new tweet was created (the third); the second was reused.
      const tweetCalls = calls.filter(
        (c) => c.method === "POST" && c.url === `${X_API_BASE}/2/tweets`,
      );
      expect(tweetCalls.length).toBe(1);
      const only = JSON.parse(tweetCalls[0].body);
      expect(only.text).toBe("tweet three");
      expect(only.reply.in_reply_to_tweet_id).toBe("ALREADY_LANDED");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("double-click resend: the second click reuses tweets that landed via the dedupe probe instead of double-posting", async () => {
    // First click: "tweet two" posts as TWEET_1, then "tweet three" fails
    // with a transient 500 — but simulate that it actually LANDED on X.
    const firstCalls = mockTwitterApi({ failTweetFrom: 2 });

    const tenant = await createTenant();
    try {
      await connectVerifiedX(tenant.tenantId);
      const itemId = await insertContentItem(tenant.tenantId, {
        caption: longCaption,
      });
      await setChainState(itemId, tenant.tenantId, "twitterChainState", {
        firstPostId: "ANCHOR_T",
        lastPostedId: "ANCHOR_T",
        posts: ["tweet one", "tweet two", "tweet three"],
        postedCount: 1,
      });
      actAs(tenant.clerkUserId);

      const first = await request(app).post(
        `/api/content/${itemId}/resend-twitter-posts`,
      );
      expect(first.status).toBe(200);
      expect(first.body.postsRemaining).toBe(1);
      expect(first.body.publishWarning).toMatch(/try resending again/i);
      const firstTweets = firstCalls.filter(
        (c) => c.method === "POST" && c.url === `${X_API_BASE}/2/tweets`,
      );
      expect(firstTweets.length).toBe(2); // one landed, one "failed"

      // Second click: the probe reports the "failed" tweet as landed.
      vi.restoreAllMocks();
      const secondCalls = mockTwitterApi({
        recentTweets: [
          {
            id: "LANDED_T3",
            text: "tweet three",
            created_at: new Date().toISOString(),
          },
        ],
      });

      const second = await request(app).post(
        `/api/content/${itemId}/resend-twitter-posts`,
      );
      expect(second.status).toBe(200);
      expect(second.body.postsPublished).toBe(3);
      expect(second.body.postsRemaining).toBe(0);
      expect(second.body.publishWarning).toBeUndefined();

      // ZERO new tweets on the second click — the landed one was reused.
      const secondTweets = secondCalls.filter(
        (c) => c.method === "POST" && c.url === `${X_API_BASE}/2/tweets`,
      );
      expect(secondTweets.length).toBe(0);

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.twitterChainState).toBeNull();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("double-click resend: even when the dedupe probe errors, the second click never re-posts tweets that the state says landed", async () => {
    mockTwitterApi({ failTweetFrom: 2 });

    const tenant = await createTenant();
    try {
      await connectVerifiedX(tenant.tenantId);
      const itemId = await insertContentItem(tenant.tenantId, {
        caption: longCaption,
      });
      await setChainState(itemId, tenant.tenantId, "twitterChainState", {
        firstPostId: "ANCHOR_T",
        lastPostedId: "ANCHOR_T",
        posts: ["tweet one", "tweet two", "tweet three"],
        postedCount: 1,
      });
      actAs(tenant.clerkUserId);

      const first = await request(app).post(
        `/api/content/${itemId}/resend-twitter-posts`,
      );
      expect(first.status).toBe(200);
      expect(first.body.postsRemaining).toBe(1);

      // Second click with a broken probe: fall back to the persisted state
      // and post ONLY the remaining tweet.
      vi.restoreAllMocks();
      const secondCalls = mockTwitterApi({ probeError: true });

      const second = await request(app).post(
        `/api/content/${itemId}/resend-twitter-posts`,
      );
      expect(second.status).toBe(200);
      expect(second.body.postsPublished).toBe(3);
      expect(second.body.postsRemaining).toBe(0);

      const secondTweets = secondCalls.filter(
        (c) => c.method === "POST" && c.url === `${X_API_BASE}/2/tweets`,
      );
      expect(secondTweets.length).toBe(1);
      const only = JSON.parse(secondTweets[0].body);
      expect(only.text).toBe("tweet three");
      // Chained onto the tweet that landed during the FIRST click, so the
      // already-posted "tweet two" is never re-posted.
      expect(only.reply.in_reply_to_tweet_id).toBe("TWEET_1");

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.twitterChainState).toBeNull();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("two truly simultaneous resends: the second is rejected with 409 while the first is still running, and nothing double-posts", async () => {
    // Gate the first tweet-create call so the first request stalls
    // mid-resend while the second request arrives.
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let firstTweetStarted!: () => void;
    const tweetStarted = new Promise<void>((resolve) => {
      firstTweetStarted = resolve;
    });
    const calls: MockCall[] = [];
    let tweetSeq = 0;
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
          url.startsWith(`${X_API_BASE}/2/users/${X_USER_ID}/tweets`)
        ) {
          return json({ data: [] });
        }
        if (method === "POST" && url === `${X_API_BASE}/2/tweets`) {
          tweetSeq += 1;
          if (tweetSeq === 1) {
            firstTweetStarted();
            await gate; // hold the first resend mid-flight
          }
          return json({ data: { id: `TWEET_${tweetSeq}` } });
        }
        return json({});
      },
    );

    const tenant = await createTenant();
    try {
      await connectVerifiedX(tenant.tenantId);
      const itemId = await insertContentItem(tenant.tenantId, {
        caption: longCaption,
      });
      await setChainState(itemId, tenant.tenantId, "twitterChainState", {
        firstPostId: "ANCHOR_T",
        lastPostedId: "ANCHOR_T",
        posts: ["tweet one", "tweet two", "tweet three"],
        postedCount: 1,
      });
      actAs(tenant.clerkUserId);

      // .then() forces the lazy supertest request to actually start now.
      const firstPromise = request(app)
        .post(`/api/content/${itemId}/resend-twitter-posts`)
        .then((r) => r);
      // Wait until the first request is genuinely mid-resend (it has read
      // the chain state and started posting), then fire the second.
      await tweetStarted;
      const second = await request(app).post(
        `/api/content/${itemId}/resend-twitter-posts`,
      );
      expect(second.status).toBe(409);
      expect(second.body.error).toMatch(/already in progress/i);

      releaseGate();
      const first = await firstPromise;
      expect(first.status).toBe(200);
      expect(first.body.postsPublished).toBe(3);
      expect(first.body.postsRemaining).toBe(0);

      // Only the first request tweeted anything: exactly the 2 missing pieces.
      const tweetCalls = calls.filter(
        (c) => c.method === "POST" && c.url === `${X_API_BASE}/2/tweets`,
      );
      expect(tweetCalls.length).toBe(2);

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.twitterChainState).toBeNull();

      // The lock is released after the first finishes: a later resend gets
      // a normal 400 (nothing left), not a 409.
      const third = await request(app).post(
        `/api/content/${itemId}/resend-twitter-posts`,
      );
      expect(third.status).toBe(400);
    } finally {
      releaseGate();
      await deleteTenant(tenant.tenantId);
    }
  });

  it("returns 400 when there is nothing to resend", async () => {
    mockTwitterApi();
    const tenant = await createTenant();
    try {
      await connectVerifiedX(tenant.tenantId);
      const itemId = await insertContentItem(tenant.tenantId, {
        caption: "hello",
      });
      actAs(tenant.clerkUserId);

      const res = await request(app).post(
        `/api/content/${itemId}/resend-twitter-posts`,
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/no missing/i);
      expect(res.body.code).toBe("already_complete");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});
