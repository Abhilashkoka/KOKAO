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

import { createHmac, createHash } from "crypto";
import { pool, type AppCredential } from "@workspace/db";
import { createTestApp } from "../test/testApp";
import { resetAuthState, actAs } from "../test/authState";
import { decryptJson } from "../lib/secretCrypto";
import type { TwitterOAuth2Credentials } from "../lib/twitterApi";
import {
  createTenant,
  deleteTenant,
  insertConnectedAccount,
  insertContentItem,
  getContentItem,
  getConnectedAccount,
  setAccountState,
  snapshotTwitterRow,
  setVerifiedTwitterRow,
  clearTwitterRow,
  restoreTwitterRow,
} from "../test/dbHelpers";
import { ObjectStorageService } from "../lib/objectStorage";
import { splitIntoTweets, TWEET_MAX_LENGTH } from "../lib/twitterApi";

const app = createTestApp();

// Per-tenant OAuth 2.0 user tokens. The refresh token is the long-lived secret
// that must never leave the server in a URL or reach the X API endpoints; the
// short-lived access token rides in the Authorization header as a bearer token.
const X_ACCESS_TOKEN = "x_access_token_oauth2";
const X_REFRESH_TOKEN = "x_refresh_token_secret_never_leaked";

// A legacy OAuth 1.0a credential blob left over from before this migration. It
// can no longer publish and must prompt the tenant to reconnect via OAuth 2.0.
const X_LEGACY_ACCESS_TOKEN = "x_legacy_access_token";
const X_LEGACY_TOKEN_SECRET = "x_legacy_token_secret";

// ---------------------------------------------------------------------------
// Thread splitter unit tests
// ---------------------------------------------------------------------------

describe("splitIntoTweets", () => {
  it("returns a single tweet when within the limit", () => {
    expect(splitIntoTweets("short caption")).toEqual(["short caption"]);
    const exact = "a".repeat(TWEET_MAX_LENGTH);
    expect(splitIntoTweets(exact)).toEqual([exact]);
  });

  it("splits on word boundaries and keeps every tweet within the limit", () => {
    const caption = Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ");
    const tweets = splitIntoTweets(caption);
    expect(tweets.length).toBeGreaterThan(1);
    for (const t of tweets) {
      expect(t.length).toBeLessThanOrEqual(TWEET_MAX_LENGTH);
    }
    // No content lost: every word survives the split.
    const rejoined = tweets.join(" ");
    for (let i = 0; i < 120; i++) {
      expect(rejoined).toContain(`word${i}`);
    }
  });

  it("hard-splits a single token longer than a whole tweet", () => {
    const caption = "b".repeat(700);
    const tweets = splitIntoTweets(caption);
    for (const t of tweets) {
      expect(t.length).toBeLessThanOrEqual(TWEET_MAX_LENGTH);
    }
    expect(tweets.join("")).toBe(caption);
  });

  it("returns a single empty tweet for empty input", () => {
    expect(splitIntoTweets("")).toEqual([""]);
    expect(splitIntoTweets("   ")).toEqual([""]);
  });
});

let twitterSnapshot: AppCredential | null = null;

beforeAll(async () => {
  twitterSnapshot = await snapshotTwitterRow();
});

afterAll(async () => {
  await restoreTwitterRow(twitterSnapshot);
  await pool.end();
});

beforeEach(() => {
  resetAuthState();
  process.env.SESSION_SECRET =
    process.env.SESSION_SECRET || "test-session-secret";
});

/**
 * Connect a tenant's X account with a valid OAuth 2.0 token set and no expiry
 * (so publishing uses the stored access token without a refresh round-trip).
 */
async function connectVerifiedX(
  tenantId: number,
  accountName = "@testhandle",
): Promise<void> {
  await insertConnectedAccount(
    tenantId,
    "twitter",
    {
      accessToken: X_ACCESS_TOKEN,
      refreshToken: X_REFRESH_TOKEN,
    },
    "verified",
    accountName,
  );
  await setAccountState(tenantId, "twitter", {
    providerUserId: "x_user_123",
    tokenExpiresAt: null,
  });
}

// ---------------------------------------------------------------------------
// Publishing gate
// ---------------------------------------------------------------------------

describe("X (Twitter) publishing gate", () => {
  it("blocks publish when no app-level X credentials are configured (400)", async () => {
    await clearTwitterRow();
    const tenant = await createTenant();
    try {
      await connectVerifiedX(tenant.tenantId);
      const itemId = await insertContentItem(tenant.tenantId);
      actAs(tenant.clerkUserId);

      const res = await request(app).post(
        `/api/content/${itemId}/publish-twitter`,
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/administrator/i);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("blocks publish when the tenant has not connected X (400)", async () => {
    await setVerifiedTwitterRow();
    const tenant = await createTenant();
    try {
      const itemId = await insertContentItem(tenant.tenantId);
      actAs(tenant.clerkUserId);

      const res = await request(app).post(
        `/api/content/${itemId}/publish-twitter`,
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/not connected or not verified/i);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("blocks publish when the tenant's X connection is not verified (400)", async () => {
    await setVerifiedTwitterRow();
    const tenant = await createTenant();
    try {
      await insertConnectedAccount(
        tenant.tenantId,
        "twitter",
        {
          accessToken: X_ACCESS_TOKEN,
          refreshToken: X_REFRESH_TOKEN,
        },
        "failed",
      );
      const itemId = await insertContentItem(tenant.tenantId);
      actAs(tenant.clerkUserId);

      const res = await request(app).post(
        `/api/content/${itemId}/publish-twitter`,
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/not connected or not verified/i);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("blocks publish for a legacy OAuth 1.0a connection and prompts reconnect (400)", async () => {
    await setVerifiedTwitterRow();
    const tenant = await createTenant();
    try {
      // A pre-migration OAuth 1.0a blob (has accessTokenSecret) marked verified.
      await insertConnectedAccount(
        tenant.tenantId,
        "twitter",
        {
          accessToken: X_LEGACY_ACCESS_TOKEN,
          accessTokenSecret: X_LEGACY_TOKEN_SECRET,
        },
        "verified",
      );
      const itemId = await insertContentItem(tenant.tenantId);
      actAs(tenant.clerkUserId);

      const res = await request(app).post(
        `/api/content/${itemId}/publish-twitter`,
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/not connected or not verified/i);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("does not publish another tenant's content (404 isolation)", async () => {
    await setVerifiedTwitterRow();
    const owner = await createTenant();
    const attacker = await createTenant();
    try {
      const itemId = await insertContentItem(owner.tenantId);
      await connectVerifiedX(attacker.tenantId);
      actAs(attacker.clerkUserId);

      const res = await request(app).post(
        `/api/content/${itemId}/publish-twitter`,
      );
      expect(res.status).toBe(404);
    } finally {
      await deleteTenant(owner.tenantId);
      await deleteTenant(attacker.tenantId);
    }
  });
});

// ---------------------------------------------------------------------------
// Happy-path publishing with the X API and object storage mocked. Proves a post
// actually reaches the /2/tweets endpoint (and, for images, the v2 media-upload
// flow) authorized with an OAuth 2.0 bearer token, marks the item published,
// and never leaks the refresh token.
// ---------------------------------------------------------------------------

interface MockCall {
  url: string;
  auth: string;
  body: unknown;
}

/**
 * Route mocked X API requests to canned responses. The v2 media-upload flow
 * (INIT/APPEND/FINALIZE) all POST to the same `/2/media/upload` URL, so the
 * command is read from the request body to pick a response. The OAuth 2.0 token
 * endpoint returns a refreshed token when a refresh round-trip occurs.
 */
function mockXApi(calls: MockCall[]) {
  let tweetSeq = 0;
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const auth =
          (init?.headers as Record<string, string> | undefined)
            ?.Authorization ?? "";
        calls.push({ url, auth, body: init?.body });

        const json = (body: unknown) =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          });

        if (url.includes("/2/oauth2/token")) {
          return json({
            access_token: "REFRESHED_ACCESS_TOKEN",
            refresh_token: "REFRESHED_REFRESH_TOKEN",
            expires_in: 7200,
            token_type: "bearer",
          });
        }
        if (url.includes("/2/media/upload")) {
          return json({ data: { id: "MEDIA_1" } });
        }
        if (url.includes("/2/tweets")) {
          tweetSeq += 1;
          // First tweet id stays "TWEET_1" for backwards-compatible assertions.
          return json({ data: { id: `TWEET_${tweetSeq}` } });
        }
        return json({});
      },
    );
}

describe("X (Twitter) publishing (happy path)", () => {
  beforeEach(async () => {
    await setVerifiedTwitterRow();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("publishes a text-only post with a bearer token, marks published, and never leaks the refresh token", async () => {
    const calls: MockCall[] = [];
    mockXApi(calls);
    const downloadSpy = vi.spyOn(
      ObjectStorageService.prototype,
      "getObjectEntityFile",
    );

    const tenant = await createTenant();
    try {
      await connectVerifiedX(tenant.tenantId);
      // No imagePath -> no media upload, no storage access.
      const itemId = await insertContentItem(tenant.tenantId);
      actAs(tenant.clerkUserId);

      const res = await request(app).post(
        `/api/content/${itemId}/publish-twitter`,
      );

      expect(res.status).toBe(200);
      expect(res.body.postId).toBe("TWEET_1");
      expect(res.body.permalink).toBe(
        "https://x.com/testhandle/status/TWEET_1",
      );
      expect(downloadSpy).not.toHaveBeenCalled();

      // Reached the tweet-create endpoint (and only that one).
      const tweetCall = calls.find((c) => c.url.includes("/2/tweets"));
      expect(tweetCall).toBeTruthy();
      expect(calls.some((c) => c.url.includes("/2/media/upload"))).toBe(false);
      // No refresh happened for a token with no expiry.
      expect(calls.some((c) => c.url.includes("/2/oauth2/token"))).toBe(false);

      // Tweet-create authorizes with the stored OAuth 2.0 bearer token.
      expect(tweetCall!.auth).toBe(`Bearer ${X_ACCESS_TOKEN}`);

      // The refresh token is never sent anywhere; the access token rides only in
      // the Authorization header, never in a URL or body.
      for (const c of calls) {
        expect(c.url).not.toContain(X_ACCESS_TOKEN);
        expect(c.url).not.toContain(X_REFRESH_TOKEN);
        expect(c.auth).not.toContain(X_REFRESH_TOKEN);
        expect(JSON.stringify(c.body ?? "")).not.toContain(X_REFRESH_TOKEN);
      }

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).toBe("published");
      // The returned postId/permalink is persisted so the library keeps a
      // "View post" link after the success toast disappears.
      expect(item.postId).toBe("TWEET_1");
      expect(item.permalink).toBe("https://x.com/testhandle/status/TWEET_1");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("publishes an image post: uploads media via the v2 flow with a bearer token then attaches it to the tweet", async () => {
    const calls: MockCall[] = [];
    mockXApi(calls);
    const downloadSpy = vi
      .spyOn(ObjectStorageService.prototype, "getObjectEntityFile")
      .mockResolvedValue({
        download: async () => [Buffer.from("fake-image-bytes")],
      } as never);

    const tenant = await createTenant();
    try {
      await connectVerifiedX(tenant.tenantId);
      const itemId = await insertContentItem(tenant.tenantId, {
        imagePath: "/objects/uploads/test.png",
      });
      actAs(tenant.clerkUserId);

      const res = await request(app).post(
        `/api/content/${itemId}/publish-twitter`,
      );

      expect(res.status).toBe(200);
      expect(res.body.postId).toBe("TWEET_1");
      expect(downloadSpy).toHaveBeenCalledWith("/objects/uploads/test.png");

      // v2 media-upload runs its INIT/APPEND/FINALIZE command sequence.
      const uploadCalls = calls.filter((c) =>
        c.url.includes("/2/media/upload"),
      );
      const uploadBodies = uploadCalls.map((c) =>
        typeof c.body === "string" ? c.body : "[multipart]",
      );
      expect(uploadBodies.some((b) => b.includes("command=INIT"))).toBe(true);
      expect(uploadBodies.some((b) => b === "[multipart]")).toBe(true); // APPEND
      expect(uploadBodies.some((b) => b.includes("command=FINALIZE"))).toBe(
        true,
      );

      // Every media-upload request authorizes with the OAuth 2.0 bearer token.
      for (const c of uploadCalls) {
        expect(c.auth).toBe(`Bearer ${X_ACCESS_TOKEN}`);
      }

      // The tweet attaches the uploaded media id.
      const tweetCall = calls.find((c) => c.url.includes("/2/tweets"));
      expect(tweetCall).toBeTruthy();
      expect(tweetCall!.auth).toBe(`Bearer ${X_ACCESS_TOKEN}`);
      const tweetBody = JSON.parse(tweetCall!.body as string) as {
        media?: { media_ids?: string[] };
      };
      expect(tweetBody.media?.media_ids).toEqual(["MEDIA_1"]);

      // No refresh-token leakage across the whole flow.
      for (const c of calls) {
        expect(c.url).not.toContain(X_REFRESH_TOKEN);
        expect(c.auth).not.toContain(X_REFRESH_TOKEN);
      }

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).toBe("published");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("refreshes an expired access token before publishing and persists the new token", async () => {
    const calls: MockCall[] = [];
    mockXApi(calls);

    const tenant = await createTenant();
    try {
      await connectVerifiedX(tenant.tenantId);
      // Force the stored token to look expired so a refresh is required.
      await setAccountState(tenant.tenantId, "twitter", {
        tokenExpiresAt: new Date(Date.now() - 60 * 1000),
      });
      const itemId = await insertContentItem(tenant.tenantId);
      actAs(tenant.clerkUserId);

      const res = await request(app).post(
        `/api/content/${itemId}/publish-twitter`,
      );

      expect(res.status).toBe(200);
      expect(res.body.postId).toBe("TWEET_1");

      // A refresh round-trip occurred, and the tweet used the refreshed token.
      expect(calls.some((c) => c.url.includes("/2/oauth2/token"))).toBe(true);
      const tweetCall = calls.find((c) => c.url.includes("/2/tweets"));
      expect(tweetCall!.auth).toBe("Bearer REFRESHED_ACCESS_TOKEN");

      // The new expiry was persisted (moved into the future).
      const row = await getConnectedAccount(tenant.tenantId, "twitter");
      expect(row.tokenExpiresAt).toBeTruthy();
      expect(row.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).toBe("published");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("prompts reconnect when an expired token has no refresh token (400)", async () => {
    const calls: MockCall[] = [];
    mockXApi(calls);

    const tenant = await createTenant();
    try {
      // Connected with an access token but no refresh token, already expired.
      await insertConnectedAccount(
        tenant.tenantId,
        "twitter",
        { accessToken: X_ACCESS_TOKEN, refreshToken: null },
        "verified",
      );
      await setAccountState(tenant.tenantId, "twitter", {
        tokenExpiresAt: new Date(Date.now() - 60 * 1000),
      });
      const itemId = await insertContentItem(tenant.tenantId);
      actAs(tenant.clerkUserId);

      const res = await request(app).post(
        `/api/content/${itemId}/publish-twitter`,
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/not connected or not verified/i);
      // No tweet was posted.
      expect(calls.some((c) => c.url.includes("/2/tweets"))).toBe(false);

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).not.toBe("published");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("posts captions longer than 280 characters as a reply-chained thread without truncation", async () => {
    const calls: MockCall[] = [];
    mockXApi(calls);

    const tenant = await createTenant();
    try {
      await connectVerifiedX(tenant.tenantId);
      // Many short words so it splits cleanly on word boundaries with no loss.
      const longCaption = Array.from({ length: 120 }, (_, i) => `word${i}`).join(
        " ",
      );
      const itemId = await insertContentItem(tenant.tenantId, {
        caption: longCaption,
      });
      actAs(tenant.clerkUserId);

      const res = await request(app).post(
        `/api/content/${itemId}/publish-twitter`,
      );
      expect(res.status).toBe(200);
      expect(res.body.postId).toBe("TWEET_1");
      expect(res.body.permalink).toBe("https://x.com/testhandle/status/TWEET_1");
      expect(res.body.tweetCount).toBeGreaterThan(1);

      const tweetCalls = calls.filter((c) => c.url.includes("/2/tweets"));
      expect(tweetCalls.length).toBe(res.body.tweetCount);

      const texts = tweetCalls.map(
        (c) => (JSON.parse(c.body as string) as { text: string }).text,
      );
      // Every tweet is within the limit, and none was truncated with an ellipsis.
      for (const t of texts) {
        expect([...t].length).toBeLessThanOrEqual(280);
        expect(t.endsWith("\u2026")).toBe(false);
      }

      // The full caption survives: rejoining the tweets reproduces every word.
      const rejoined = texts.join(" ");
      for (let i = 0; i < 120; i++) {
        expect(rejoined).toContain(`word${i}`);
      }

      // Tweets 2..N are chained as replies to the previous tweet.
      const replies = tweetCalls.map(
        (c) =>
          (
            JSON.parse(c.body as string) as {
              reply?: { in_reply_to_tweet_id?: string };
            }
          ).reply?.in_reply_to_tweet_id,
      );
      expect(replies[0]).toBeUndefined();
      for (let i = 1; i < replies.length; i++) {
        expect(replies[i]).toBe(`TWEET_${i}`);
      }
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("attaches the image to the first tweet only when threading", async () => {
    const calls: MockCall[] = [];
    mockXApi(calls);
    vi.spyOn(ObjectStorageService.prototype, "getObjectEntityFile").mockResolvedValue(
      {
        download: async () => [Buffer.from("fake-image-bytes")],
      } as never,
    );

    const tenant = await createTenant();
    try {
      await connectVerifiedX(tenant.tenantId);
      const longCaption = Array.from({ length: 120 }, (_, i) => `word${i}`).join(
        " ",
      );
      const itemId = await insertContentItem(tenant.tenantId, {
        caption: longCaption,
        imagePath: "/objects/uploads/test.png",
      });
      actAs(tenant.clerkUserId);

      const res = await request(app).post(
        `/api/content/${itemId}/publish-twitter`,
      );
      expect(res.status).toBe(200);
      expect(res.body.tweetCount).toBeGreaterThan(1);

      const tweetCalls = calls.filter((c) => c.url.includes("/2/tweets"));
      const withMedia = tweetCalls.filter(
        (c) =>
          (JSON.parse(c.body as string) as { media?: unknown }).media !==
          undefined,
      );
      // Exactly one tweet (the first) carries the image.
      expect(withMedia.length).toBe(1);
      const firstBody = JSON.parse(tweetCalls[0].body as string) as {
        media?: { media_ids?: string[] };
        reply?: unknown;
      };
      expect(firstBody.media?.media_ids).toEqual(["MEDIA_1"]);
      expect(firstBody.reply).toBeUndefined();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("posts an at-limit caption unchanged (no trim, no ellipsis)", async () => {
    const calls: MockCall[] = [];
    mockXApi(calls);

    const tenant = await createTenant();
    try {
      await connectVerifiedX(tenant.tenantId);
      const atLimitCaption = "a".repeat(TWEET_MAX_LENGTH);
      const itemId = await insertContentItem(tenant.tenantId, {
        caption: atLimitCaption,
      });
      actAs(tenant.clerkUserId);

      const res = await request(app).post(
        `/api/content/${itemId}/publish-twitter`,
      );
      expect(res.status).toBe(200);

      const tweetCall = calls.find((c) => c.url.includes("/2/tweets"));
      const tweetBody = JSON.parse(tweetCall!.body as string) as {
        text: string;
      };
      expect(tweetBody.text).toBe(atLimitCaption);
      expect(tweetBody.text.endsWith("\u2026")).toBe(false);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("returns 502 with a clear message when X rejects the tweet", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "Something went wrong" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    );

    const tenant = await createTenant();
    try {
      await connectVerifiedX(tenant.tenantId);
      const itemId = await insertContentItem(tenant.tenantId);
      actAs(tenant.clerkUserId);

      const res = await request(app).post(
        `/api/content/${itemId}/publish-twitter`,
      );
      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/X rejected the post/i);

      // A failed publish must not mark the item published.
      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).not.toBe("published");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});

// ---------------------------------------------------------------------------
// Connect flow (OAuth 2.0 PKCE). These cover the authorize-URL builder and the
// callback that finalizes the connection. A regression in the signed-state
// round-trip, the token exchange, or the /2/users/me lookup would otherwise let
// "Connect X" silently produce a broken or missing connection with no test
// catching it. The callback must NEVER write a connection when anything about
// the state, the OAuth handshake, or the user lookup is wrong.
// ---------------------------------------------------------------------------

/**
 * Craft an HMAC-signed `state` exactly as the route's private `signState` does,
 * so tests can forge valid, expired, wrong-tenant, and tampered states without
 * exporting internals. Format: base64url(`${tenantId}.${ts}.${verifier}.${sig}`),
 * where sig = HMAC-SHA256(SESSION_SECRET, `${tenantId}.${ts}.${verifier}`).
 */
function craftState(
  tenantId: number,
  verifier: string,
  ts: number = Date.now(),
): string {
  const secret = process.env.SESSION_SECRET!;
  const payload = `${tenantId}.${ts}.${verifier}`;
  const sig = createHmac("sha256", secret).update(payload).digest("hex");
  return Buffer.from(`${payload}.${sig}`, "utf8").toString("base64url");
}

/** Decode and verify a state the same way the route does. */
function parseState(state: string): {
  tenantId: number;
  ts: number;
  verifier: string;
  validSignature: boolean;
} {
  const secret = process.env.SESSION_SECRET!;
  const decoded = Buffer.from(state, "base64url").toString("utf8");
  const lastDot = decoded.lastIndexOf(".");
  const payload = decoded.slice(0, lastDot);
  const sig = decoded.slice(lastDot + 1);
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  const firstDot = payload.indexOf(".");
  const secondDot = payload.indexOf(".", firstDot + 1);
  return {
    tenantId: Number(payload.slice(0, firstDot)),
    ts: Number(payload.slice(firstDot + 1, secondDot)),
    verifier: payload.slice(secondDot + 1),
    validSignature: sig === expected,
  };
}

const X_CONNECT_ACCESS_TOKEN = "connect_access_token_oauth2";
const X_CONNECT_REFRESH_TOKEN = "connect_refresh_token_secret";
const X_CONNECT_USER_ID = "x_user_connect_777";
const X_CONNECT_USERNAME = "connectedhandle";

/**
 * Mock the two X endpoints the callback hits: the OAuth 2.0 token exchange and
 * the authenticated-user lookup. Each can be forced to fail independently to
 * exercise the callback's failure branches.
 */
function mockConnectApi(
  opts: { tokenFails?: boolean; userFails?: boolean } = {},
) {
  const calls: { url: string; auth: string; body: unknown }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const auth =
        (init?.headers as Record<string, string> | undefined)?.Authorization ??
        "";
      calls.push({ url, auth, body: init?.body });
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });

      if (url.includes("/2/oauth2/token")) {
        if (opts.tokenFails) {
          return json(
            { error: "invalid_grant", error_description: "bad code" },
            400,
          );
        }
        return json({
          access_token: X_CONNECT_ACCESS_TOKEN,
          refresh_token: X_CONNECT_REFRESH_TOKEN,
          expires_in: 7200,
          token_type: "bearer",
        });
      }
      if (url.includes("/2/users/me")) {
        if (opts.userFails) return json({}, 401);
        return json({
          data: { id: X_CONNECT_USER_ID, username: X_CONNECT_USERNAME },
        });
      }
      return json({});
    },
  );
  return calls;
}

describe("X (Twitter) connect: GET /twitter/auth/url", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 503 when no app-level X credentials are configured", async () => {
    await clearTwitterRow();
    const tenant = await createTenant();
    try {
      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/twitter/auth/url");
      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/not configured/i);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("returns an authorize URL carrying the PKCE challenge and a signed state bound to the tenant", async () => {
    await setVerifiedTwitterRow();
    const tenant = await createTenant();
    try {
      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/twitter/auth/url");
      expect(res.status).toBe(200);
      expect(typeof res.body.url).toBe("string");

      const url = new URL(res.body.url);
      expect(url.origin + url.pathname).toBe(
        "https://twitter.com/i/oauth2/authorize",
      );
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("client_id")).toBe("x-client-id-default");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");

      const challenge = url.searchParams.get("code_challenge");
      const state = url.searchParams.get("state");
      expect(challenge).toBeTruthy();
      expect(state).toBeTruthy();

      // The state is HMAC-signed, bound to this tenant, and embeds the PKCE
      // verifier whose S256 hash equals the challenge in the URL — proving the
      // authorize-URL builder and the state round-trip agree.
      const parsed = parseState(state!);
      expect(parsed.validSignature).toBe(true);
      expect(parsed.tenantId).toBe(tenant.tenantId);
      expect(parsed.verifier).toBeTruthy();
      const derivedChallenge = createHash("sha256")
        .update(parsed.verifier)
        .digest("base64url");
      expect(derivedChallenge).toBe(challenge);

      // The high-entropy verifier must never leak in the URL query.
      expect(res.body.url).not.toContain(parsed.verifier);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});

describe("X (Twitter) connect: GET /twitter/auth/callback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("persists an encrypted connection and redirects on the happy path", async () => {
    await setVerifiedTwitterRow();
    const calls = mockConnectApi();
    const tenant = await createTenant();
    try {
      actAs(tenant.clerkUserId);

      // Use the real signed state produced by the authorize-URL endpoint so the
      // full signState -> verifyState round-trip is exercised end to end.
      const urlRes = await request(app).get("/api/twitter/auth/url");
      const state = new URL(urlRes.body.url).searchParams.get("state")!;

      const res = await request(app)
        .get("/api/twitter/auth/callback")
        .query({ code: "AUTH_CODE", state });

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/accounts?twitter=connected");

      // The token endpoint and the user lookup were both hit.
      expect(calls.some((c) => c.url.includes("/2/oauth2/token"))).toBe(true);
      const userCall = calls.find((c) => c.url.includes("/2/users/me"));
      expect(userCall).toBeTruthy();
      // The user lookup authorizes with the freshly exchanged access token.
      expect(userCall!.auth).toBe(`Bearer ${X_CONNECT_ACCESS_TOKEN}`);

      const row = await getConnectedAccount(tenant.tenantId, "twitter");
      expect(row).toBeTruthy();
      expect(row.status).toBe("connected");
      expect(row.verifyStatus).toBe("verified");
      expect(row.verifyError).toBeNull();
      expect(row.providerUserId).toBe(X_CONNECT_USER_ID);
      expect(row.accountName).toBe(`@${X_CONNECT_USERNAME}`);
      expect(row.tokenExpiresAt).toBeTruthy();
      expect(row.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());
      // Legacy plaintext column stays unused for OAuth 2.0 connections.
      expect(row.accessToken).toBeNull();

      // Both tokens are stored encrypted at rest and decrypt to what X returned.
      expect(row.encryptedCredentials).toBeTruthy();
      const creds = decryptJson<TwitterOAuth2Credentials>(
        row.encryptedCredentials!,
      );
      expect(creds.accessToken).toBe(X_CONNECT_ACCESS_TOKEN);
      expect(creds.refreshToken).toBe(X_CONNECT_REFRESH_TOKEN);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("redirects with not_configured and writes nothing when app creds are missing", async () => {
    await clearTwitterRow();
    const tenant = await createTenant();
    try {
      actAs(tenant.clerkUserId);
      const state = craftState(tenant.tenantId, "some_verifier");
      const res = await request(app)
        .get("/api/twitter/auth/callback")
        .query({ code: "AUTH_CODE", state });

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(
        "/accounts?twitter=error&reason=not_configured",
      );
      expect(await getConnectedAccount(tenant.tenantId, "twitter")).toBeFalsy();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("redirects with the OAuth error and writes nothing when X returns error=", async () => {
    await setVerifiedTwitterRow();
    const calls = mockConnectApi();
    const tenant = await createTenant();
    try {
      actAs(tenant.clerkUserId);
      const state = craftState(tenant.tenantId, "some_verifier");
      const res = await request(app)
        .get("/api/twitter/auth/callback")
        .query({ error: "access_denied", state });

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(
        "/accounts?twitter=error&reason=access_denied",
      );
      // No token exchange should even be attempted.
      expect(calls.length).toBe(0);
      expect(await getConnectedAccount(tenant.tenantId, "twitter")).toBeFalsy();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("rejects a tampered state and writes nothing", async () => {
    await setVerifiedTwitterRow();
    const tenant = await createTenant();
    try {
      actAs(tenant.clerkUserId);
      const valid = craftState(tenant.tenantId, "some_verifier");
      // Flip the final character (part of the HMAC signature) to break it.
      const decoded = Buffer.from(valid, "base64url").toString("utf8");
      const tampered = Buffer.from(
        decoded.slice(0, -1) + (decoded.endsWith("a") ? "b" : "a"),
        "utf8",
      ).toString("base64url");

      const res = await request(app)
        .get("/api/twitter/auth/callback")
        .query({ code: "AUTH_CODE", state: tampered });

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(
        "/accounts?twitter=error&reason=invalid_state",
      );
      expect(await getConnectedAccount(tenant.tenantId, "twitter")).toBeFalsy();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("rejects an expired state and writes nothing", async () => {
    await setVerifiedTwitterRow();
    const tenant = await createTenant();
    try {
      actAs(tenant.clerkUserId);
      // Signed 11 minutes ago; the state TTL is 10 minutes.
      const expired = craftState(
        tenant.tenantId,
        "some_verifier",
        Date.now() - 11 * 60 * 1000,
      );
      const res = await request(app)
        .get("/api/twitter/auth/callback")
        .query({ code: "AUTH_CODE", state: expired });

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(
        "/accounts?twitter=error&reason=invalid_state",
      );
      expect(await getConnectedAccount(tenant.tenantId, "twitter")).toBeFalsy();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("rejects a state signed for a different tenant and writes nothing", async () => {
    await setVerifiedTwitterRow();
    const tenant = await createTenant();
    try {
      actAs(tenant.clerkUserId);
      // Validly signed, but bound to some other tenant id.
      const otherTenantState = craftState(
        tenant.tenantId + 999999,
        "some_verifier",
      );
      const res = await request(app)
        .get("/api/twitter/auth/callback")
        .query({ code: "AUTH_CODE", state: otherTenantState });

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(
        "/accounts?twitter=error&reason=invalid_state",
      );
      expect(await getConnectedAccount(tenant.tenantId, "twitter")).toBeFalsy();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("redirects with token_exchange and writes nothing when the token exchange fails", async () => {
    await setVerifiedTwitterRow();
    const calls = mockConnectApi({ tokenFails: true });
    const tenant = await createTenant();
    try {
      actAs(tenant.clerkUserId);
      const state = craftState(tenant.tenantId, "some_verifier");
      const res = await request(app)
        .get("/api/twitter/auth/callback")
        .query({ code: "AUTH_CODE", state });

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(
        "/accounts?twitter=error&reason=token_exchange",
      );
      // The user lookup must never run once the exchange failed.
      expect(calls.some((c) => c.url.includes("/2/users/me"))).toBe(false);
      expect(await getConnectedAccount(tenant.tenantId, "twitter")).toBeFalsy();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("redirects with userinfo and writes nothing when the user lookup fails", async () => {
    await setVerifiedTwitterRow();
    mockConnectApi({ userFails: true });
    const tenant = await createTenant();
    try {
      actAs(tenant.clerkUserId);
      const state = craftState(tenant.tenantId, "some_verifier");
      const res = await request(app)
        .get("/api/twitter/auth/callback")
        .query({ code: "AUTH_CODE", state });

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(
        "/accounts?twitter=error&reason=userinfo",
      );
      expect(await getConnectedAccount(tenant.tenantId, "twitter")).toBeFalsy();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});
