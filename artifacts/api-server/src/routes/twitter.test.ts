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
  insertConnectedAccount,
  insertContentItem,
  getContentItem,
  snapshotTwitterRow,
  setVerifiedTwitterRow,
  clearTwitterRow,
  restoreTwitterRow,
} from "../test/dbHelpers";
import { ObjectStorageService } from "../lib/objectStorage";

const app = createTestApp();

// Per-tenant OAuth 1.0a user credentials. The token secret must never leave the
// server (it only signs requests); the access token rides in the OAuth header as
// the public `oauth_token` param but must never appear in a URL.
const X_ACCESS_TOKEN = "x_access_token_public";
const X_ACCESS_TOKEN_SECRET = "x_access_token_secret_never_sent";

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

async function connectVerifiedX(
  tenantId: number,
  accountName = "@testhandle",
): Promise<void> {
  await insertConnectedAccount(
    tenantId,
    "twitter",
    {
      accessToken: X_ACCESS_TOKEN,
      accessTokenSecret: X_ACCESS_TOKEN_SECRET,
    },
    "verified",
    accountName,
  );
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
          accessTokenSecret: X_ACCESS_TOKEN_SECRET,
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
// flow), marks the item published, and never leaks the token secret.
// ---------------------------------------------------------------------------

interface MockCall {
  url: string;
  auth: string;
  body: unknown;
}

/**
 * Route mocked X API requests to canned responses. The v2 media-upload flow
 * (INIT/APPEND/FINALIZE) all POST to the same `/2/media/upload` URL, so the
 * command is read from the request body to pick a response.
 */
function mockXApi(calls: MockCall[]) {
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

        if (url.includes("/2/media/upload")) {
          return json({ data: { id: "MEDIA_1" } });
        }
        if (url.includes("/2/tweets")) {
          return json({ data: { id: "TWEET_1" } });
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

  it("publishes a text-only post, marks published, and never leaks the token secret", async () => {
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
      expect(calls.some((c) => c.url.includes("/2/tweets"))).toBe(true);
      expect(calls.some((c) => c.url.includes("/2/media/upload"))).toBe(false);

      // The token secret is never sent anywhere; the access token is in the
      // OAuth header but never in a URL.
      for (const c of calls) {
        expect(c.url).not.toContain(X_ACCESS_TOKEN);
        expect(c.url).not.toContain(X_ACCESS_TOKEN_SECRET);
        expect(c.auth).not.toContain(X_ACCESS_TOKEN_SECRET);
        expect(JSON.stringify(c.body ?? "")).not.toContain(
          X_ACCESS_TOKEN_SECRET,
        );
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

  it("publishes an image post: uploads media via the v2 flow then attaches it to the tweet", async () => {
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
      const uploadBodies = calls
        .filter((c) => c.url.includes("/2/media/upload"))
        .map((c) =>
          typeof c.body === "string" ? c.body : "[multipart]",
        );
      expect(uploadBodies.some((b) => b.includes("command=INIT"))).toBe(true);
      expect(uploadBodies.some((b) => b === "[multipart]")).toBe(true); // APPEND
      expect(uploadBodies.some((b) => b.includes("command=FINALIZE"))).toBe(
        true,
      );

      // The tweet attaches the uploaded media id.
      const tweetCall = calls.find((c) => c.url.includes("/2/tweets"));
      expect(tweetCall).toBeTruthy();
      const tweetBody = JSON.parse(tweetCall!.body as string) as {
        media?: { media_ids?: string[] };
      };
      expect(tweetBody.media?.media_ids).toEqual(["MEDIA_1"]);

      // No secret leakage across the whole flow.
      for (const c of calls) {
        expect(c.url).not.toContain(X_ACCESS_TOKEN_SECRET);
        expect(c.auth).not.toContain(X_ACCESS_TOKEN_SECRET);
      }

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).toBe("published");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("truncates captions longer than 280 characters before posting", async () => {
    const calls: MockCall[] = [];
    mockXApi(calls);

    const tenant = await createTenant();
    try {
      await connectVerifiedX(tenant.tenantId);
      const longCaption = "a".repeat(500);
      const itemId = await insertContentItem(tenant.tenantId, {
        caption: longCaption,
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
      expect([...tweetBody.text].length).toBeLessThanOrEqual(280);
      expect(tweetBody.text.endsWith("\u2026")).toBe(true);
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
