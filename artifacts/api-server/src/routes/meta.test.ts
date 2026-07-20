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

// The publish routes now force a live re-verification against Meta right before
// publishing. Keep DB-backed helpers real; stub only the network test functions
// so this suite is deterministic and never hits the real Graph API.
vi.mock("../lib/metaApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/metaApi")>();
  return {
    ...actual,
    testFacebookCredentials: vi.fn(async () => ({
      ok: true,
      accountName: "Test Page",
    })),
    testInstagramCredentials: vi.fn(async () => ({
      ok: true,
      accountName: "@testig",
    })),
  };
});

import { pool } from "@workspace/db";
import {
  testFacebookCredentials,
  testInstagramCredentials,
} from "../lib/metaApi";
import { createTestApp } from "../test/testApp";
import { resetAuthState, actAs } from "../test/authState";
import {
  createTenant,
  deleteTenant,
  insertConnectedAccount,
  insertContentItem,
  getContentItem,
} from "../test/dbHelpers";
import { ObjectStorageService } from "../lib/objectStorage";
import {
  IG_CONTAINER_POLL,
  IG_PUBLISH_RETRY,
  FB_PUBLISH_RETRY,
  DEDUPE_PROBE,
  publishInstagramCore,
} from "./meta";
import { waitForPendingJobs } from "../lib/backgroundJobs";

const app = createTestApp();
const mockFb = vi.mocked(testFacebookCredentials);
const mockIg = vi.mocked(testInstagramCredentials);

/**
 * Build a minimal-but-valid PNG header carrying real pixel dimensions, for
 * tests exercising the caption-less duplicate-post probes (they parse the
 * stored image's dimensions as an identity signal).
 */
function pngBytes(width: number, height: number): Buffer {
  const b = Buffer.alloc(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

beforeEach(() => {
  resetAuthState();
  // Default the forced pre-publish re-verification to "still valid" so it does
  // not flip a stored credential; individual tests override as needed.
  mockFb.mockReset();
  mockIg.mockReset();
  mockFb.mockResolvedValue({ ok: true, accountName: "Test Page" });
  mockIg.mockResolvedValue({ ok: true, accountName: "@testig" });
});

afterAll(async () => {
  await pool.end();
});

describe("Facebook publishing gate", () => {
  it("blocks publish when no Facebook credentials are connected (400)", async () => {
    const tenant = await createTenant();
    try {
      const itemId = await insertContentItem(tenant.tenantId);
      actAs(tenant.clerkUserId);

      const res = await request(app).post(
        `/api/content/${itemId}/publish-facebook`,
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/not connected or its access token/i);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("blocks publish when credentials exist but verifyStatus is not verified (400)", async () => {
    const tenant = await createTenant();
    try {
      await insertConnectedAccount(
        tenant.tenantId,
        "facebook",
        { pageId: "PAGE_1", pageAccessToken: "tok_unverified" },
        "failed",
      );
      const itemId = await insertContentItem(tenant.tenantId);
      actAs(tenant.clerkUserId);
      // The forced pre-publish re-verify also rejects the token, so it stays
      // failed and the gate blocks the publish.
      mockFb.mockResolvedValue({ ok: false, error: "token invalid" });

      const res = await request(app).post(
        `/api/content/${itemId}/publish-facebook`,
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/not connected or its access token/i);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("does not publish another tenant's content (404 isolation)", async () => {
    const owner = await createTenant();
    const attacker = await createTenant();
    try {
      const itemId = await insertContentItem(owner.tenantId);
      await insertConnectedAccount(
        attacker.tenantId,
        "facebook",
        { pageId: "PAGE_ATT", pageAccessToken: "tok_att" },
        "verified",
      );
      actAs(attacker.clerkUserId);

      const res = await request(app).post(
        `/api/content/${itemId}/publish-facebook`,
      );
      expect(res.status).toBe(404);
    } finally {
      await deleteTenant(owner.tenantId);
      await deleteTenant(attacker.tenantId);
    }
  });

  describe("with fetch mocked", () => {
    beforeEach(() => {
      // Let the pre-publish re-verification read succeed (so the credential
      // stays verified and we get past the gate), but force the actual publish
      // write to fail so the handler returns 502 rather than really posting.
      vi.spyOn(globalThis, "fetch").mockImplementation(
        async (input: string | URL | Request) => {
          const url = typeof input === "string" ? input : input.toString();
          const json = (body: unknown, status: number) =>
            new Response(JSON.stringify(body), {
              status,
              headers: { "content-type": "application/json" },
            });
          if (url.includes("fields=id,name"))
            return json({ id: lastPathSegment(url), name: "Test Page" }, 200);
          if (url.includes("fields=id,username"))
            return json({ id: lastPathSegment(url), username: "testacct" }, 200);
          return json({ error: { message: "mocked failure" } }, 400);
        },
      );
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("lets verified credentials past the gate (not a 400 'not connected')", async () => {
      const tenant = await createTenant();
      try {
        await insertConnectedAccount(
          tenant.tenantId,
          "facebook",
          { pageId: "PAGE_OK", pageAccessToken: "tok_ok" },
          "verified",
        );
        // No imagePath -> feed branch, which only calls fetch (no storage).
        const itemId = await insertContentItem(tenant.tenantId);
        actAs(tenant.clerkUserId);

        const res = await request(app).post(
          `/api/content/${itemId}/publish-facebook`,
        );
        // Passed the verification gate; failed at the (mocked) network call.
        expect(res.status).toBe(502);
        expect(res.body.error).not.toMatch(/not connected or not verified/i);
      } finally {
        await deleteTenant(tenant.tenantId);
      }
    });
  });
});

describe("Instagram publishing gate", () => {
  it("blocks publish when Instagram is not connected/verified (400)", async () => {
    const tenant = await createTenant();
    try {
      const itemId = await insertContentItem(tenant.tenantId, {
        imagePath: "/objects/uploads/test.png",
      });
      actAs(tenant.clerkUserId);

      const res = await request(app).post(
        `/api/content/${itemId}/publish-instagram`,
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Instagram is not connected/i);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("blocks publish when Instagram is verified but Facebook is not (400)", async () => {
    const tenant = await createTenant();
    try {
      await insertConnectedAccount(
        tenant.tenantId,
        "instagram",
        { igUserId: "IG_OK" },
        "verified",
      );
      const itemId = await insertContentItem(tenant.tenantId, {
        imagePath: "/objects/uploads/test.png",
      });
      actAs(tenant.clerkUserId);

      const res = await request(app).post(
        `/api/content/${itemId}/publish-instagram`,
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Facebook/i);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});

// ---------------------------------------------------------------------------
// Happy-path publishing: verified account + mocked object storage and Graph
// API. Proves a post actually reaches storage + the Graph API and marks the
// content item "published", and that the access token is never in a URL.
// ---------------------------------------------------------------------------

const FB_PAGE_TOKEN = "tok_fb_page_secret";

/**
 * Route a mocked Graph API request to a canned JSON response based on its URL,
 * while recording every requested URL so tests can assert the access token is
 * never placed in a URL (it must ride in the form body or Authorization header).
 */
function lastPathSegment(url: string): string {
  try {
    const seg = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    return decodeURIComponent(seg);
  } catch {
    return "";
  }
}

function mockGraph(calls: string[]) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(url);

      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });

      if (url.includes("/photos")) return json({ id: "PHOTO_1", post_id: "POST_1" });
      if (url.includes("/feed")) return json({ id: "FEED_POST_1" });
      if (url.includes("/media_publish")) return json({ id: "IG_PUBLISHED_1" });
      if (url.includes("fields=status_code")) return json({ status_code: "FINISHED" });
      if (url.includes("fields=permalink"))
        return json({ permalink: "https://www.instagram.com/p/abc123/" });
      // Pre-publish re-verification reads (id must match the entered Page ID).
      if (url.includes("fields=id,name"))
        return json({ id: lastPathSegment(url), name: "Test Page" });
      if (url.includes("fields=id,username"))
        return json({ id: lastPathSegment(url), username: "testacct" });
      if (url.includes("/media")) return json({ id: "IG_CONTAINER_1" });

      return json({});
    });
}

describe("Facebook publishing (happy path)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("publishes an image post: downloads from storage, posts to Graph, marks published", async () => {
    const calls: string[] = [];
    mockGraph(calls);
    const downloadSpy = vi
      .spyOn(ObjectStorageService.prototype, "getObjectEntityFile")
      .mockResolvedValue({
        download: async () => [Buffer.from("fake-image-bytes")],
      } as never);

    const tenant = await createTenant();
    try {
      await insertConnectedAccount(
        tenant.tenantId,
        "facebook",
        { pageId: "PAGE_OK", pageAccessToken: FB_PAGE_TOKEN },
        "verified",
      );
      const itemId = await insertContentItem(tenant.tenantId, {
        imagePath: "/objects/uploads/test.png",
      });
      actAs(tenant.clerkUserId);

      const res = await request(app).post(
        `/api/content/${itemId}/publish-facebook`,
      );

      expect(res.status).toBe(200);
      expect(res.body.postId).toBe("POST_1");
      expect(res.body.permalink).toBe("https://www.facebook.com/POST_1");
      expect(downloadSpy).toHaveBeenCalledWith(
        "/objects/uploads/test.png",
        expect.any(Number),
      );

      // Hit the photo-upload endpoint, and the token never appears in a URL.
      expect(calls.some((u) => u.includes("/PAGE_OK/photos"))).toBe(true);
      expect(calls.every((u) => !u.includes(FB_PAGE_TOKEN))).toBe(true);

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).toBe("published");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("publishes a text-only post via the feed endpoint and marks published", async () => {
    const calls: string[] = [];
    mockGraph(calls);
    const downloadSpy = vi.spyOn(
      ObjectStorageService.prototype,
      "getObjectEntityFile",
    );

    const tenant = await createTenant();
    try {
      await insertConnectedAccount(
        tenant.tenantId,
        "facebook",
        { pageId: "PAGE_OK", pageAccessToken: FB_PAGE_TOKEN },
        "verified",
      );
      // No imagePath -> feed (text) branch, which must not touch storage.
      const itemId = await insertContentItem(tenant.tenantId);
      actAs(tenant.clerkUserId);

      const res = await request(app).post(
        `/api/content/${itemId}/publish-facebook`,
      );

      expect(res.status).toBe(200);
      expect(res.body.postId).toBe("FEED_POST_1");
      expect(res.body.permalink).toBe("https://www.facebook.com/FEED_POST_1");
      expect(downloadSpy).not.toHaveBeenCalled();

      expect(calls.some((u) => u.includes("/PAGE_OK/feed"))).toBe(true);
      expect(calls.every((u) => !u.includes(FB_PAGE_TOKEN))).toBe(true);

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).toBe("published");
      expect(item.publishedPlatforms?.facebook).toMatchObject({
        postId: "FEED_POST_1",
        permalink: "https://www.facebook.com/FEED_POST_1",
      });
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});

describe("Facebook publish transient-error retry", () => {
  const originalRetry = { ...FB_PUBLISH_RETRY };

  beforeEach(() => {
    // Shrink the retry cap/delays so retries run instantly.
    FB_PUBLISH_RETRY.maxAttempts = 3;
    FB_PUBLISH_RETRY.initialDelayMs = 1;
    FB_PUBLISH_RETRY.maxDelayMs = 1;
    FB_PUBLISH_RETRY.backoffFactor = 1;
  });

  afterEach(() => {
    Object.assign(FB_PUBLISH_RETRY, originalRetry);
    vi.restoreAllMocks();
  });

  /**
   * Mock the Graph API so the photo endpoint fails transiently for the first
   * `failCount` attempts, then succeeds. Pre-publish re-verification reads
   * always succeed. Records requested URLs.
   */
  function mockGraphPhotoTransient(
    calls: string[],
    failCount: number,
    failResponse: { status: number; body: unknown },
  ) {
    let photoAttempts = 0;
    return vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        calls.push(url);
        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          });

        if (url.includes("/photos")) {
          photoAttempts += 1;
          if (photoAttempts <= failCount) {
            return json(failResponse.body, failResponse.status);
          }
          return json({ id: "PHOTO_1", post_id: "POST_1" });
        }
        // Pre-publish re-verification reads.
        if (url.includes("fields=id,name"))
          return json({ id: lastPathSegment(url), name: "Test Page" });
        if (url.includes("fields=id,username"))
          return json({ id: lastPathSegment(url), username: "testacct" });
        return json({});
      });
  }

  async function setupVerifiedFbTenant(
    itemOpts: { caption?: string; title?: string } = {},
  ) {
    const tenant = await createTenant();
    await insertConnectedAccount(
      tenant.tenantId,
      "facebook",
      { pageId: "PAGE_OK", pageAccessToken: FB_PAGE_TOKEN },
      "verified",
    );
    const itemId = await insertContentItem(tenant.tenantId, {
      imagePath: "/objects/uploads/test.png",
      ...itemOpts,
    });
    actAs(tenant.clerkUserId);
    return { tenant, itemId };
  }

  it("retries a transient Graph error and then publishes", async () => {
    const calls: string[] = [];
    // Two transient failures (code 2 = service temporarily unavailable), then success.
    mockGraphPhotoTransient(calls, 2, {
      status: 500,
      body: { error: { message: "temporarily unavailable", code: 2 } },
    });
    vi.spyOn(
      ObjectStorageService.prototype,
      "getObjectEntityFile",
    ).mockResolvedValue({
      download: async () => [Buffer.from("fake-image-bytes")],
    } as never);

    const { tenant, itemId } = await setupVerifiedFbTenant();
    try {
      const res = await request(app).post(
        `/api/content/${itemId}/publish-facebook`,
      );

      expect(res.status).toBe(200);
      expect(res.body.postId).toBe("POST_1");
      // Attempted the photo upload three times (two transient + one success).
      expect(calls.filter((u) => u.includes("/photos")).length).toBe(3);

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).toBe("published");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("gives up after the attempt cap when the error stays transient (503)", async () => {
    const calls: string[] = [];
    mockGraphPhotoTransient(calls, Infinity, {
      status: 503,
      body: { error: { message: "still unavailable", is_transient: true } },
    });
    vi.spyOn(
      ObjectStorageService.prototype,
      "getObjectEntityFile",
    ).mockResolvedValue({
      download: async () => [Buffer.from("fake-image-bytes")],
    } as never);

    const { tenant, itemId } = await setupVerifiedFbTenant();
    try {
      const res = await request(app).post(
        `/api/content/${itemId}/publish-facebook`,
      );

      // Transient exhaustion surfaces 503 so the scheduled executor's
      // bounded auto-retry re-queues the post instead of failing forever.
      expect(res.status).toBe(503);
      // Tried exactly the attempt cap and gave up.
      expect(calls.filter((u) => u.includes("/photos")).length).toBe(
        FB_PUBLISH_RETRY.maxAttempts,
      );

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).not.toBe("published");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  /**
   * Simulate the retry-idempotency hazard: the first /photos attempt actually
   * CREATES the post on Meta's side, but the response is lost (a transient
   * 500). The duplicate-post probe (GET /{page}/posts) then reports the post
   * as already existing, so the handler must NOT post again.
   */
  function mockGraphWriteThenLoseResponse(
    calls: string[],
    existingPost: {
      id: string;
      message?: string;
      created_time: string;
      attachments?: {
        data: Array<{ media?: { image?: { width: number; height: number } } }>;
      };
    },
  ) {
    let photoAttempts = 0;
    return vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        calls.push(url);
        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          });

        if (url.includes("/photos")) {
          photoAttempts += 1;
          if (photoAttempts === 1) {
            // The write committed, but the caller sees a transient failure.
            return json(
              { error: { message: "temporarily unavailable", code: 2 } },
              500,
            );
          }
          // Any further attempt would create a DUPLICATE post.
          return json({ id: "PHOTO_DUP", post_id: "POST_DUPLICATE" });
        }
        if (url.includes("/posts?")) {
          return json({ data: [existingPost] });
        }
        if (url.includes("fields=id,name"))
          return json({ id: lastPathSegment(url), name: "Test Page" });
        if (url.includes("fields=id,username"))
          return json({ id: lastPathSegment(url), username: "testacct" });
        return json({});
      });
  }

  it("does not double-post when a transient failure actually landed the post", async () => {
    const calls: string[] = [];
    mockGraphWriteThenLoseResponse(calls, {
      id: "POST_ALREADY_LANDED",
      // Must match what the handler sends (item caption).
      message: "hello world",
      created_time: new Date().toISOString(),
    });
    vi.spyOn(
      ObjectStorageService.prototype,
      "getObjectEntityFile",
    ).mockResolvedValue({
      download: async () => [Buffer.from("fake-image-bytes")],
    } as never);

    const { tenant, itemId } = await setupVerifiedFbTenant();
    try {
      const res = await request(app).post(
        `/api/content/${itemId}/publish-facebook`,
      );

      // Succeeds with the post that already landed, WITHOUT a second write.
      expect(res.status).toBe(200);
      expect(res.body.postId).toBe("POST_ALREADY_LANDED");
      expect(calls.filter((u) => u.includes("/photos")).length).toBe(1);
      // The probe queried recent Page posts and never put the token in a URL.
      expect(calls.some((u) => u.includes("/PAGE_OK/posts"))).toBe(true);
      expect(calls.every((u) => !u.includes(FB_PAGE_TOKEN))).toBe(true);

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).toBe("published");
      expect(item.postId).toBe("POST_ALREADY_LANDED");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("does not double-post a caption-less image when a transient failure actually landed the post", async () => {
    const calls: string[] = [];
    // The landed photo post has NO `message` (Graph omits it for caption-less
    // posts). The probe must match it by "blank + recent" instead of skipping.
    mockGraphWriteThenLoseResponse(calls, {
      id: "POST_BLANK_LANDED",
      created_time: new Date().toISOString(),
    });
    vi.spyOn(
      ObjectStorageService.prototype,
      "getObjectEntityFile",
    ).mockResolvedValue({
      download: async () => [Buffer.from("fake-image-bytes")],
    } as never);

    // Blank caption AND blank title -> the publish sends no message at all.
    const { tenant, itemId } = await setupVerifiedFbTenant({
      caption: "",
      title: "",
    });
    try {
      const res = await request(app).post(
        `/api/content/${itemId}/publish-facebook`,
      );

      expect(res.status).toBe(200);
      expect(res.body.postId).toBe("POST_BLANK_LANDED");
      // Exactly ONE write — no duplicate.
      expect(calls.filter((u) => u.includes("/photos")).length).toBe(1);
      expect(calls.some((u) => u.includes("/PAGE_OK/posts"))).toBe(true);

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).toBe("published");
      expect(item.postId).toBe("POST_BLANK_LANDED");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("a blank-caption probe does not match recent posts that HAVE a caption", async () => {
    const calls: string[] = [];
    // Only a recent post WITH text exists — not ours (ours is caption-less),
    // so the retry must proceed.
    mockGraphWriteThenLoseResponse(calls, {
      id: "POST_WITH_TEXT",
      message: "someone else's captioned post",
      created_time: new Date().toISOString(),
    });
    vi.spyOn(
      ObjectStorageService.prototype,
      "getObjectEntityFile",
    ).mockResolvedValue({
      download: async () => [Buffer.from("fake-image-bytes")],
    } as never);

    const { tenant, itemId } = await setupVerifiedFbTenant({
      caption: "",
      title: "",
    });
    try {
      const res = await request(app).post(
        `/api/content/${itemId}/publish-facebook`,
      );

      expect(res.status).toBe(200);
      expect(res.body.postId).toBe("POST_DUPLICATE");
      expect(calls.filter((u) => u.includes("/photos")).length).toBe(2);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("caption-less probe matches the landed post by photo dimensions", async () => {
    const calls: string[] = [];
    // Landed blank post whose photo attachment matches our uploaded image's
    // dimensions (1024x512) — this IS our post, so no second write.
    mockGraphWriteThenLoseResponse(calls, {
      id: "POST_BLANK_OURS",
      created_time: new Date().toISOString(),
      attachments: {
        data: [{ media: { image: { width: 1024, height: 512 } } }],
      },
    });
    vi.spyOn(
      ObjectStorageService.prototype,
      "getObjectEntityFile",
    ).mockResolvedValue({
      download: async () => [pngBytes(1024, 512)],
    } as never);

    const { tenant, itemId } = await setupVerifiedFbTenant({
      caption: "",
      title: "",
    });
    try {
      const res = await request(app).post(
        `/api/content/${itemId}/publish-facebook`,
      );

      expect(res.status).toBe(200);
      expect(res.body.postId).toBe("POST_BLANK_OURS");
      // Exactly ONE write — no duplicate.
      expect(calls.filter((u) => u.includes("/photos")).length).toBe(1);
      // The caption-less probe asked for the attachment media.
      expect(
        calls.some(
          (u) => u.includes("/PAGE_OK/posts") && u.includes("attachments"),
        ),
      ).toBe(true);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("caption-less probe does NOT match a concurrent blank post with a different image", async () => {
    const calls: string[] = [];
    // A concurrent caption-less post from ANOTHER tool: also blank, also
    // recent, but its photo has different dimensions — not our post, so the
    // retry must proceed (short-circuiting here would mean the user's post
    // never lands).
    mockGraphWriteThenLoseResponse(calls, {
      id: "POST_BLANK_SOMEONE_ELSES",
      created_time: new Date().toISOString(),
      attachments: {
        data: [{ media: { image: { width: 640, height: 480 } } }],
      },
    });
    vi.spyOn(
      ObjectStorageService.prototype,
      "getObjectEntityFile",
    ).mockResolvedValue({
      download: async () => [pngBytes(1024, 512)],
    } as never);

    const { tenant, itemId } = await setupVerifiedFbTenant({
      caption: "",
      title: "",
    });
    try {
      const res = await request(app).post(
        `/api/content/${itemId}/publish-facebook`,
      );

      expect(res.status).toBe(200);
      // The probe rejected the stranger's post, so the retry ran.
      expect(res.body.postId).toBe("POST_DUPLICATE");
      expect(calls.filter((u) => u.includes("/photos")).length).toBe(2);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("finds the landed post even when it is beyond the first page of results (busy Page)", async () => {
    const calls: string[] = [];
    let photoAttempts = 0;
    // A busy Page: the first probe page is full of OTHER tools' posts, and the
    // landed post only shows up on page 2 (reachable via paging.next).
    const filler = Array.from({ length: DEDUPE_PROBE.pageSize }, (_, i) => ({
      id: `POST_OTHER_${i}`,
      message: `unrelated concurrent post ${i}`,
      created_time: new Date().toISOString(),
    }));
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        calls.push(url);
        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          });

        if (url.includes("/photos")) {
          photoAttempts += 1;
          if (photoAttempts === 1) {
            // The write committed, but the caller sees a transient failure.
            return json(
              { error: { message: "temporarily unavailable", code: 2 } },
              500,
            );
          }
          // Any further attempt would create a DUPLICATE post.
          return json({ id: "PHOTO_DUP", post_id: "POST_DUPLICATE" });
        }
        if (url.includes("/posts?") && url.includes("after=PAGE2")) {
          return json({
            data: [
              {
                id: "POST_LANDED_PAGE2",
                message: "hello world",
                created_time: new Date().toISOString(),
              },
            ],
          });
        }
        if (url.includes("/posts?")) {
          // First probe page must carry the server-side `since` filter.
          expect(url).toMatch(/[?&]since=\d+/);
          return json({
            data: filler,
            paging: { next: `${url}&after=PAGE2` },
          });
        }
        if (url.includes("fields=id,name"))
          return json({ id: lastPathSegment(url), name: "Test Page" });
        if (url.includes("fields=id,username"))
          return json({ id: lastPathSegment(url), username: "testacct" });
        return json({});
      },
    );
    vi.spyOn(
      ObjectStorageService.prototype,
      "getObjectEntityFile",
    ).mockResolvedValue({
      download: async () => [Buffer.from("fake-image-bytes")],
    } as never);

    const { tenant, itemId } = await setupVerifiedFbTenant();
    try {
      const res = await request(app).post(
        `/api/content/${itemId}/publish-facebook`,
      );

      // Found on page 2 — no second write.
      expect(res.status).toBe(200);
      expect(res.body.postId).toBe("POST_LANDED_PAGE2");
      expect(calls.filter((u) => u.includes("/photos")).length).toBe(1);
      // The probe paginated: two /posts reads, the second via paging.next.
      expect(calls.filter((u) => u.includes("/posts?")).length).toBe(2);
      expect(calls.some((u) => u.includes("after=PAGE2"))).toBe(true);
      expect(calls.every((u) => !u.includes(FB_PAGE_TOKEN))).toBe(true);

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).toBe("published");
      expect(item.postId).toBe("POST_LANDED_PAGE2");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("gives up paginating after the page cap and falls back to the retry", async () => {
    const calls: string[] = [];
    let photoAttempts = 0;
    const filler = Array.from({ length: DEDUPE_PROBE.pageSize }, (_, i) => ({
      id: `POST_OTHER_${i}`,
      message: `unrelated concurrent post ${i}`,
      created_time: new Date().toISOString(),
    }));
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        calls.push(url);
        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          });

        if (url.includes("/photos")) {
          photoAttempts += 1;
          if (photoAttempts === 1) {
            return json(
              { error: { message: "temporarily unavailable", code: 2 } },
              500,
            );
          }
          return json({ id: "PHOTO_1", post_id: "POST_RETRIED" });
        }
        if (url.includes("/posts?")) {
          // Endless full pages that never contain our post.
          return json({
            data: filler,
            paging: { next: `${url.split("&after=")[0]}&after=MORE` },
          });
        }
        if (url.includes("fields=id,name"))
          return json({ id: lastPathSegment(url), name: "Test Page" });
        if (url.includes("fields=id,username"))
          return json({ id: lastPathSegment(url), username: "testacct" });
        return json({});
      },
    );
    vi.spyOn(
      ObjectStorageService.prototype,
      "getObjectEntityFile",
    ).mockResolvedValue({
      download: async () => [Buffer.from("fake-image-bytes")],
    } as never);

    const { tenant, itemId } = await setupVerifiedFbTenant();
    try {
      const res = await request(app).post(
        `/api/content/${itemId}/publish-facebook`,
      );

      // No match found within the page cap -> normal retry proceeds.
      expect(res.status).toBe(200);
      expect(res.body.postId).toBe("POST_RETRIED");
      expect(calls.filter((u) => u.includes("/photos")).length).toBe(2);
      // The probe stopped at the page cap instead of following next forever.
      expect(
        calls.filter((u) => u.includes("/posts?")).length,
      ).toBeLessThanOrEqual(DEDUPE_PROBE.maxPages);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("still retries when the probe finds no matching recent post", async () => {
    const calls: string[] = [];
    // First attempt fails transiently; the probe sees only an OLD post with a
    // different message, so it must not be mistaken for ours and the retry
    // proceeds and succeeds.
    let photoAttempts = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        calls.push(url);
        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          });

        if (url.includes("/photos")) {
          photoAttempts += 1;
          if (photoAttempts === 1) {
            return json(
              { error: { message: "temporarily unavailable", code: 2 } },
              500,
            );
          }
          return json({ id: "PHOTO_1", post_id: "POST_RETRIED" });
        }
        if (url.includes("/posts?")) {
          return json({
            data: [
              {
                id: "POST_UNRELATED",
                message: "an old unrelated post",
                created_time: new Date().toISOString(),
              },
              {
                id: "POST_OLD_SAME_TEXT",
                message: "hello world",
                // Way before this publish started -> not ours.
                created_time: new Date(Date.now() - 86_400_000).toISOString(),
              },
            ],
          });
        }
        if (url.includes("fields=id,name"))
          return json({ id: lastPathSegment(url), name: "Test Page" });
        if (url.includes("fields=id,username"))
          return json({ id: lastPathSegment(url), username: "testacct" });
        return json({});
      },
    );
    vi.spyOn(
      ObjectStorageService.prototype,
      "getObjectEntityFile",
    ).mockResolvedValue({
      download: async () => [Buffer.from("fake-image-bytes")],
    } as never);

    const { tenant, itemId } = await setupVerifiedFbTenant();
    try {
      const res = await request(app).post(
        `/api/content/${itemId}/publish-facebook`,
      );

      expect(res.status).toBe(200);
      expect(res.body.postId).toBe("POST_RETRIED");
      expect(calls.filter((u) => u.includes("/photos")).length).toBe(2);

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).toBe("published");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("does NOT retry a definitive error (fails fast, 502)", async () => {
    const calls: string[] = [];
    // A permission/param error (no transient markers) must fail on the first try.
    mockGraphPhotoTransient(calls, Infinity, {
      status: 400,
      body: { error: { message: "Invalid parameter", code: 100 } },
    });
    vi.spyOn(
      ObjectStorageService.prototype,
      "getObjectEntityFile",
    ).mockResolvedValue({
      download: async () => [Buffer.from("fake-image-bytes")],
    } as never);

    const { tenant, itemId } = await setupVerifiedFbTenant();
    try {
      const res = await request(app).post(
        `/api/content/${itemId}/publish-facebook`,
      );

      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/Invalid parameter/i);
      // No retry: exactly one photo attempt.
      expect(calls.filter((u) => u.includes("/photos")).length).toBe(1);

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).not.toBe("published");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});

describe("Instagram publishing (happy path)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs the create + publish container flow and marks published", async () => {
    const calls: string[] = [];
    mockGraph(calls);
    const signSpy = vi
      .spyOn(ObjectStorageService.prototype, "getSignedDownloadURL")
      .mockResolvedValue("https://signed.example.com/image.png?sig=xyz");

    const tenant = await createTenant();
    try {
      await insertConnectedAccount(
        tenant.tenantId,
        "instagram",
        { igUserId: "IG_OK" },
        "verified",
      );
      await insertConnectedAccount(
        tenant.tenantId,
        "facebook",
        { pageId: "PAGE_OK", pageAccessToken: FB_PAGE_TOKEN },
        "verified",
      );
      const itemId = await insertContentItem(tenant.tenantId, {
        imagePath: "/objects/uploads/test.png",
      });
      actAs(tenant.clerkUserId);

      const res = await request(app).post(
        `/api/content/${itemId}/publish-instagram`,
      );

      // The request returns immediately with the item queued for background
      // publishing; the real create/poll/publish work happens after.
      expect(res.status).toBe(202);
      expect(res.body.status).toBe("publishing");

      // Let the background job run to completion, then assert the outcome.
      await waitForPendingJobs();
      expect(signSpy).toHaveBeenCalledWith(
        "/objects/uploads/test.png",
        expect.any(Number),
        900,
      );

      // Full flow: create the container, poll its status, then publish it.
      expect(calls.some((u) => u.includes("/IG_OK/media"))).toBe(true);
      expect(
        calls.some((u) =>
          u.includes("/IG_CONTAINER_1?fields=status_code"),
        ),
      ).toBe(true);
      expect(calls.some((u) => u.includes("/IG_OK/media_publish"))).toBe(true);
      // The FB page token IG rides on must never appear in any URL.
      expect(calls.every((u) => !u.includes(FB_PAGE_TOKEN))).toBe(true);

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).toBe("published");
      expect(item.postId).toBe("IG_PUBLISHED_1");
      expect(item.permalink).toBe("https://www.instagram.com/p/abc123/");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

});

describe("Instagram container readiness", () => {
  const originalPoll = { ...IG_CONTAINER_POLL };
  const originalRetry = { ...IG_PUBLISH_RETRY };

  beforeEach(() => {
    // Shrink the poll cap/delays so the timeout path runs instantly.
    IG_CONTAINER_POLL.maxAttempts = 3;
    IG_CONTAINER_POLL.initialDelayMs = 1;
    IG_CONTAINER_POLL.maxDelayMs = 1;
    IG_CONTAINER_POLL.backoffFactor = 1;
    // These tests exercise the container-poll semantics only, so disable the
    // outer publish retry (a single attempt) to keep the poll counts exact.
    IG_PUBLISH_RETRY.maxAttempts = 1;
    IG_PUBLISH_RETRY.initialDelayMs = 1;
    IG_PUBLISH_RETRY.maxDelayMs = 1;
    IG_PUBLISH_RETRY.backoffFactor = 1;
  });

  afterEach(() => {
    Object.assign(IG_CONTAINER_POLL, originalPoll);
    Object.assign(IG_PUBLISH_RETRY, originalRetry);
    vi.restoreAllMocks();
  });

  /**
   * Like mockGraph, but the container status is driven by `statusSequence`:
   * each status poll returns the next entry (the last entry repeats). Publishing
   * is only allowed once a FINISHED status is observed.
   */
  function mockGraphWithStatus(calls: string[], statusSequence: string[]) {
    let statusIdx = 0;
    return vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        calls.push(url);
        const json = (body: unknown) =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          });

        if (url.includes("/media_publish")) return json({ id: "IG_PUBLISHED_1" });
        if (url.includes("fields=status_code")) {
          const status =
            statusSequence[Math.min(statusIdx, statusSequence.length - 1)];
          statusIdx += 1;
          return json({ status_code: status });
        }
        if (url.includes("fields=permalink"))
          return json({ permalink: "https://www.instagram.com/p/abc123/" });
        // Pre-publish re-verification reads.
        if (url.includes("fields=id,name"))
          return json({ id: lastPathSegment(url), name: "Test Page" });
        if (url.includes("fields=id,username"))
          return json({ id: lastPathSegment(url), username: "testacct" });
        if (url.includes("/media")) return json({ id: "IG_CONTAINER_1" });
        return json({});
      });
  }

  async function setupVerifiedTenant() {
    const tenant = await createTenant();
    await insertConnectedAccount(
      tenant.tenantId,
      "instagram",
      { igUserId: "IG_OK" },
      "verified",
    );
    await insertConnectedAccount(
      tenant.tenantId,
      "facebook",
      { pageId: "PAGE_OK", pageAccessToken: FB_PAGE_TOKEN },
      "verified",
    );
    const itemId = await insertContentItem(tenant.tenantId, {
      imagePath: "/objects/uploads/test.png",
    });
    actAs(tenant.clerkUserId);
    return { tenant, itemId };
  }

  it("polls IN_PROGRESS until FINISHED, then publishes", async () => {
    const calls: string[] = [];
    mockGraphWithStatus(calls, ["IN_PROGRESS", "IN_PROGRESS", "FINISHED"]);
    vi.spyOn(
      ObjectStorageService.prototype,
      "getSignedDownloadURL",
    ).mockResolvedValue("https://signed.example.com/image.png?sig=xyz");

    const { tenant, itemId } = await setupVerifiedTenant();
    try {
      const res = await request(app).post(
        `/api/content/${itemId}/publish-instagram`,
      );

      expect(res.status).toBe(202);
      expect(res.body.status).toBe("publishing");
      await waitForPendingJobs();

      // Polled three times (two IN_PROGRESS + one FINISHED) before publishing.
      expect(
        calls.filter((u) => u.includes("fields=status_code")).length,
      ).toBe(3);
      expect(calls.some((u) => u.includes("/media_publish"))).toBe(true);

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).toBe("published");
      expect(item.postId).toBe("IG_PUBLISHED_1");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("marks the item failed and never publishes when the container stays IN_PROGRESS past the cap", async () => {
    const calls: string[] = [];
    mockGraphWithStatus(calls, ["IN_PROGRESS"]);
    vi.spyOn(
      ObjectStorageService.prototype,
      "getSignedDownloadURL",
    ).mockResolvedValue("https://signed.example.com/image.png?sig=xyz");

    const { tenant, itemId } = await setupVerifiedTenant();
    try {
      const res = await request(app).post(
        `/api/content/${itemId}/publish-instagram`,
      );

      expect(res.status).toBe(202);
      await waitForPendingJobs();

      // Polled up to the cap and never attempted to publish.
      expect(
        calls.filter((u) => u.includes("fields=status_code")).length,
      ).toBe(IG_CONTAINER_POLL.maxAttempts);
      expect(calls.some((u) => u.includes("/media_publish"))).toBe(false);

      // The background job flips the item to "failed" so the UI can surface it
      // instead of leaving it stuck on "publishing".
      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).toBe("failed");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("marks the item failed and never publishes when the container ends in ERROR", async () => {
    const calls: string[] = [];
    mockGraphWithStatus(calls, ["IN_PROGRESS", "ERROR"]);
    vi.spyOn(
      ObjectStorageService.prototype,
      "getSignedDownloadURL",
    ).mockResolvedValue("https://signed.example.com/image.png?sig=xyz");

    const { tenant, itemId } = await setupVerifiedTenant();
    try {
      const res = await request(app).post(
        `/api/content/${itemId}/publish-instagram`,
      );

      expect(res.status).toBe(202);
      await waitForPendingJobs();

      expect(calls.some((u) => u.includes("/media_publish"))).toBe(false);

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).toBe("failed");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});

// ---------------------------------------------------------------------------
// Bounded automatic retry of transient Instagram publish failures.
// ---------------------------------------------------------------------------
describe("Instagram publish retry", () => {
  const originalRetry = { ...IG_PUBLISH_RETRY };
  const originalPoll = { ...IG_CONTAINER_POLL };

  beforeEach(() => {
    // Shrink retry backoff + the container poll so retries run instantly.
    IG_PUBLISH_RETRY.maxAttempts = 3;
    IG_PUBLISH_RETRY.initialDelayMs = 1;
    IG_PUBLISH_RETRY.maxDelayMs = 1;
    IG_PUBLISH_RETRY.backoffFactor = 1;
    IG_CONTAINER_POLL.maxAttempts = 1;
    IG_CONTAINER_POLL.initialDelayMs = 1;
    IG_CONTAINER_POLL.maxDelayMs = 1;
    IG_CONTAINER_POLL.backoffFactor = 1;
  });

  afterEach(() => {
    Object.assign(IG_PUBLISH_RETRY, originalRetry);
    Object.assign(IG_CONTAINER_POLL, originalPoll);
    vi.restoreAllMocks();
  });

  async function setupVerifiedTenant(
    itemOpts: { caption?: string; title?: string } = {},
  ) {
    const tenant = await createTenant();
    await insertConnectedAccount(
      tenant.tenantId,
      "instagram",
      { igUserId: "IG_OK" },
      "verified",
    );
    await insertConnectedAccount(
      tenant.tenantId,
      "facebook",
      { pageId: "PAGE_OK", pageAccessToken: FB_PAGE_TOKEN },
      "verified",
    );
    const itemId = await insertContentItem(tenant.tenantId, {
      imagePath: "/objects/uploads/test.png",
      ...itemOpts,
    });
    actAs(tenant.clerkUserId);
    return { tenant, itemId };
  }

  /**
   * Graph mock where the container-create call returns the given HTTP `status`
   * for its first `failTimes` calls, then succeeds. Everything else follows the
   * happy path (FINISHED status, media_publish returns an id).
   */
  function mockGraphCreateFailing(
    calls: string[],
    failTimes: number,
    status: number,
  ) {
    let createCalls = 0;
    return vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        calls.push(url);
        const json = (body: unknown, s = 200) =>
          new Response(JSON.stringify(body), {
            status: s,
            headers: { "content-type": "application/json" },
          });

        if (url.includes("/media_publish")) return json({ id: "IG_PUBLISHED_1" });
        if (url.includes("fields=status_code"))
          return json({ status_code: "FINISHED" });
        if (url.includes("fields=permalink"))
          return json({ permalink: "https://www.instagram.com/p/abc123/" });
        if (url.includes("fields=id,name"))
          return json({ id: lastPathSegment(url), name: "Test Page" });
        if (url.includes("fields=id,username"))
          return json({ id: lastPathSegment(url), username: "testacct" });
        // Container creation: fail transiently the first `failTimes` calls.
        if (url.includes("/media")) {
          createCalls += 1;
          if (createCalls <= failTimes)
            return json({ error: { message: "temporary glitch" } }, status);
          return json({ id: "IG_CONTAINER_1" });
        }
        return json({});
      });
  }

  it("retries a transient 5xx failure and eventually publishes", async () => {
    const calls: string[] = [];
    // Fail the first create with a 503, then succeed on the retry.
    mockGraphCreateFailing(calls, 1, 503);
    vi.spyOn(
      ObjectStorageService.prototype,
      "getSignedDownloadURL",
    ).mockResolvedValue("https://signed.example.com/image.png?sig=xyz");

    const { tenant, itemId } = await setupVerifiedTenant();
    try {
      const res = await request(app).post(
        `/api/content/${itemId}/publish-instagram`,
      );
      expect(res.status).toBe(202);
      await waitForPendingJobs();

      // Two container-create attempts: the failed one + the successful retry.
      expect(
        calls.filter((u) => u.endsWith("/IG_OK/media")).length,
      ).toBe(2);
      expect(calls.some((u) => u.includes("/media_publish"))).toBe(true);

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).toBe("published");
      expect(item.postId).toBe("IG_PUBLISHED_1");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("gives up and marks failed after exhausting retries on persistent 5xx", async () => {
    const calls: string[] = [];
    // Always fail create with a 500 (more than maxAttempts).
    mockGraphCreateFailing(calls, 99, 500);
    vi.spyOn(
      ObjectStorageService.prototype,
      "getSignedDownloadURL",
    ).mockResolvedValue("https://signed.example.com/image.png?sig=xyz");

    const { tenant, itemId } = await setupVerifiedTenant();
    try {
      const res = await request(app).post(
        `/api/content/${itemId}/publish-instagram`,
      );
      expect(res.status).toBe(202);
      await waitForPendingJobs();

      // Tried exactly maxAttempts times, then gave up.
      expect(
        calls.filter((u) => u.endsWith("/IG_OK/media")).length,
      ).toBe(IG_PUBLISH_RETRY.maxAttempts);
      expect(calls.some((u) => u.includes("/media_publish"))).toBe(false);

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).toBe("failed");
      // The final failure reason is persisted so the UI can explain the
      // failure next to the Retry button.
      expect(item.failureReason).toMatch(/^Instagram rejected the post/);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("treats a 429 rate limit as transient: retries and surfaces 503 when it persists", async () => {
    const calls: string[] = [];
    // Always fail create with a bare 429 (no is_transient hint in the body).
    mockGraphCreateFailing(calls, 99, 429);
    vi.spyOn(
      ObjectStorageService.prototype,
      "getSignedDownloadURL",
    ).mockResolvedValue("https://signed.example.com/image.png?sig=xyz");

    const { tenant, itemId } = await setupVerifiedTenant();
    try {
      const outcome = await publishInstagramCore(tenant.tenantId, itemId);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.errorStatus).toBe(503);
      }
      // The 429 was retried up to the attempt cap, not failed fast.
      expect(
        calls.filter((u) => u.endsWith("/IG_OK/media")).length,
      ).toBe(IG_PUBLISH_RETRY.maxAttempts);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("surfaces errorStatus 503 from the publish core after exhausting retries on persistent 5xx (scheduled auto-retry)", async () => {
    const calls: string[] = [];
    // Always fail create with a 500 (more than maxAttempts).
    mockGraphCreateFailing(calls, 99, 500);
    vi.spyOn(
      ObjectStorageService.prototype,
      "getSignedDownloadURL",
    ).mockResolvedValue("https://signed.example.com/image.png?sig=xyz");

    const { tenant, itemId } = await setupVerifiedTenant();
    try {
      // Drive the shared core the scheduled publisher uses so the transient
      // classification (errorStatus 503) that gates its bounded auto-retry
      // is pinned here.
      const outcome = await publishInstagramCore(tenant.tenantId, itemId);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.errorStatus).toBe(503);
      }

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).toBe("failed");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("fails fast on a non-retryable 4xx without wasting retries", async () => {
    const calls: string[] = [];
    // A 400 (e.g. revoked token / bad request) must not be retried.
    mockGraphCreateFailing(calls, 99, 400);
    vi.spyOn(
      ObjectStorageService.prototype,
      "getSignedDownloadURL",
    ).mockResolvedValue("https://signed.example.com/image.png?sig=xyz");

    const { tenant, itemId } = await setupVerifiedTenant();
    try {
      const res = await request(app).post(
        `/api/content/${itemId}/publish-instagram`,
      );
      expect(res.status).toBe(202);
      await waitForPendingJobs();

      // Only a single create attempt — the 4xx is definitive.
      expect(
        calls.filter((u) => u.endsWith("/IG_OK/media")).length,
      ).toBe(1);
      expect(calls.some((u) => u.includes("/media_publish"))).toBe(false);

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).toBe("failed");
      expect(item.failureReason).toMatch(/^Instagram rejected the post/);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  /**
   * Simulate the IG retry-idempotency hazard: media_publish actually COMMITS
   * the post, but the response is lost (a transient 500). The duplicate-post
   * probe (GET /{ig-user-id}/media) then reports the post as already existing,
   * so the retry loop must NOT re-run the create -> poll -> publish flow.
   */
  function mockGraphIgPublishThenLoseResponse(
    calls: string[],
    existingMedia: {
      id: string;
      caption?: string;
      timestamp: string;
      media_url?: string;
    } | null,
    // Binary image responses for candidate media_url downloads, keyed by URL.
    images: Record<string, Uint8Array> = {},
  ) {
    let publishAttempts = 0;
    return vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        calls.push(url);
        const json = (body: unknown, s = 200) =>
          new Response(JSON.stringify(body), {
            status: s,
            headers: { "content-type": "application/json" },
          });

        if (images[url]) {
          return new Response(new Uint8Array(images[url]), {
            status: 200,
            headers: { "content-type": "image/png" },
          });
        }
        if (url.includes("/media_publish")) {
          publishAttempts += 1;
          if (publishAttempts === 1) {
            // The publish committed, but the caller sees a transient failure.
            return json({ error: { message: "temporarily unavailable" } }, 500);
          }
          // Any further publish would create a DUPLICATE post.
          return json({ id: "IG_DUPLICATE" });
        }
        if (url.includes("/media?fields=id,caption,timestamp")) {
          return json({ data: existingMedia ? [existingMedia] : [] });
        }
        if (url.includes("fields=status_code"))
          return json({ status_code: "FINISHED" });
        if (url.includes("fields=permalink"))
          return json({ permalink: "https://www.instagram.com/p/landed/" });
        if (url.includes("fields=id,name"))
          return json({ id: lastPathSegment(url), name: "Test Page" });
        if (url.includes("fields=id,username"))
          return json({ id: lastPathSegment(url), username: "testacct" });
        if (url.includes("/media")) return json({ id: "IG_CONTAINER_1" });
        return json({});
      });
  }

  it("does not double-post when a transient media_publish failure actually landed the post", async () => {
    const calls: string[] = [];
    mockGraphIgPublishThenLoseResponse(calls, {
      id: "IG_ALREADY_LANDED",
      // Must match what the handler sends (item caption).
      caption: "hello world",
      timestamp: new Date().toISOString(),
    });
    vi.spyOn(
      ObjectStorageService.prototype,
      "getSignedDownloadURL",
    ).mockResolvedValue("https://signed.example.com/image.png?sig=xyz");

    const { tenant, itemId } = await setupVerifiedTenant();
    try {
      const res = await request(app).post(
        `/api/content/${itemId}/publish-instagram`,
      );
      expect(res.status).toBe(202);
      await waitForPendingJobs();

      // Exactly ONE publish write — the "lost" one. No second publish, and no
      // second container-create either.
      expect(calls.filter((u) => u.includes("/media_publish")).length).toBe(1);
      expect(calls.filter((u) => u.endsWith("/IG_OK/media")).length).toBe(1);
      // The probe queried recent media and never put the token in a URL.
      expect(
        calls.some((u) =>
          u.includes("/IG_OK/media?fields=id,caption,timestamp"),
        ),
      ).toBe(true);
      expect(calls.every((u) => !u.includes(FB_PAGE_TOKEN))).toBe(true);

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).toBe("published");
      expect(item.postId).toBe("IG_ALREADY_LANDED");
      expect(item.permalink).toBe("https://www.instagram.com/p/landed/");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("does not double-post a caption-less image when a transient media_publish failure actually landed the post", async () => {
    const calls: string[] = [];
    // The landed IG media has NO `caption` (Graph omits it for caption-less
    // media). The probe must match it by "blank + recent" instead of skipping.
    mockGraphIgPublishThenLoseResponse(calls, {
      id: "IG_BLANK_LANDED",
      timestamp: new Date().toISOString(),
    });
    vi.spyOn(
      ObjectStorageService.prototype,
      "getSignedDownloadURL",
    ).mockResolvedValue("https://signed.example.com/image.png?sig=xyz");
    // Unparseable stored image -> no dimension signal -> the probe degrades
    // to the weaker blank-match rather than risking a duplicate.
    vi.spyOn(
      ObjectStorageService.prototype,
      "getObjectEntityFile",
    ).mockResolvedValue({
      download: async () => [Buffer.from("fake-image-bytes")],
    } as never);

    // Blank caption AND blank title -> the publish sends an empty caption.
    const { tenant, itemId } = await setupVerifiedTenant({
      caption: "",
      title: "",
    });
    try {
      const res = await request(app).post(
        `/api/content/${itemId}/publish-instagram`,
      );
      expect(res.status).toBe(202);
      await waitForPendingJobs();

      // Exactly ONE publish write — the "lost" one. No second publish.
      expect(calls.filter((u) => u.includes("/media_publish")).length).toBe(1);
      expect(calls.filter((u) => u.endsWith("/IG_OK/media")).length).toBe(1);

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).toBe("published");
      expect(item.postId).toBe("IG_BLANK_LANDED");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("finds the landed IG post even when it is beyond the first page of results (busy account)", async () => {
    const calls: string[] = [];
    let publishAttempts = 0;
    // A busy IG account: page 1 of the probe is full of OTHER tools' media;
    // the landed post only shows up on page 2 via paging.next.
    const filler = Array.from({ length: DEDUPE_PROBE.pageSize }, (_, i) => ({
      id: `IG_OTHER_${i}`,
      caption: `unrelated concurrent media ${i}`,
      timestamp: new Date().toISOString(),
    }));
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        calls.push(url);
        const json = (body: unknown, s = 200) =>
          new Response(JSON.stringify(body), {
            status: s,
            headers: { "content-type": "application/json" },
          });

        if (url.includes("/media_publish")) {
          publishAttempts += 1;
          if (publishAttempts === 1) {
            // The publish committed, but the caller sees a transient failure.
            return json({ error: { message: "temporarily unavailable" } }, 500);
          }
          // Any further publish would create a DUPLICATE post.
          return json({ id: "IG_DUPLICATE" });
        }
        if (
          url.includes("/media?fields=id,caption,timestamp") &&
          url.includes("after=PAGE2")
        ) {
          return json({
            data: [
              {
                id: "IG_LANDED_PAGE2",
                caption: "hello world",
                timestamp: new Date().toISOString(),
              },
            ],
          });
        }
        if (url.includes("/media?fields=id,caption,timestamp")) {
          // First probe page must carry the server-side `since` filter.
          expect(url).toMatch(/[?&]since=\d+/);
          return json({
            data: filler,
            paging: { next: `${url}&after=PAGE2` },
          });
        }
        if (url.includes("fields=status_code"))
          return json({ status_code: "FINISHED" });
        if (url.includes("fields=permalink"))
          return json({ permalink: "https://www.instagram.com/p/landed2/" });
        if (url.includes("fields=id,name"))
          return json({ id: lastPathSegment(url), name: "Test Page" });
        if (url.includes("fields=id,username"))
          return json({ id: lastPathSegment(url), username: "testacct" });
        if (url.includes("/media")) return json({ id: "IG_CONTAINER_1" });
        return json({});
      },
    );
    vi.spyOn(
      ObjectStorageService.prototype,
      "getSignedDownloadURL",
    ).mockResolvedValue("https://signed.example.com/image.png?sig=xyz");

    const { tenant, itemId } = await setupVerifiedTenant();
    try {
      const res = await request(app).post(
        `/api/content/${itemId}/publish-instagram`,
      );
      expect(res.status).toBe(202);
      await waitForPendingJobs();

      // Found on page 2 — no second publish, no second container-create.
      expect(calls.filter((u) => u.includes("/media_publish")).length).toBe(1);
      expect(calls.filter((u) => u.endsWith("/IG_OK/media")).length).toBe(1);
      expect(
        calls.filter((u) =>
          u.includes("/media?fields=id,caption,timestamp"),
        ).length,
      ).toBe(2);
      expect(calls.some((u) => u.includes("after=PAGE2"))).toBe(true);
      expect(calls.every((u) => !u.includes(FB_PAGE_TOKEN))).toBe(true);

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).toBe("published");
      expect(item.postId).toBe("IG_LANDED_PAGE2");
      expect(item.permalink).toBe("https://www.instagram.com/p/landed2/");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("a blank-caption probe does not match recent media that HAS a caption", async () => {
    const calls: string[] = [];
    // Only recent media WITH text exists — not ours (ours is caption-less),
    // so the retry must proceed.
    mockGraphIgPublishThenLoseResponse(calls, {
      id: "IG_WITH_TEXT",
      caption: "someone else's captioned media",
      timestamp: new Date().toISOString(),
    });
    vi.spyOn(
      ObjectStorageService.prototype,
      "getSignedDownloadURL",
    ).mockResolvedValue("https://signed.example.com/image.png?sig=xyz");
    vi.spyOn(
      ObjectStorageService.prototype,
      "getObjectEntityFile",
    ).mockResolvedValue({
      download: async () => [Buffer.from("fake-image-bytes")],
    } as never);

    const { tenant, itemId } = await setupVerifiedTenant({
      caption: "",
      title: "",
    });
    try {
      const res = await request(app).post(
        `/api/content/${itemId}/publish-instagram`,
      );
      expect(res.status).toBe(202);
      await waitForPendingJobs();

      // The failed publish + the successful retry.
      expect(calls.filter((u) => u.includes("/media_publish")).length).toBe(2);

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).toBe("published");
      expect(item.postId).toBe("IG_DUPLICATE");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("caption-less IG probe matches the landed media by image dimensions", async () => {
    const calls: string[] = [];
    // The landed blank media's media_url serves an image with the SAME
    // dimensions as our stored image — this IS our post, so no second publish.
    mockGraphIgPublishThenLoseResponse(
      calls,
      {
        id: "IG_BLANK_OURS",
        timestamp: new Date().toISOString(),
        media_url: "https://cdn.example.com/landed.png",
      },
      { "https://cdn.example.com/landed.png": pngBytes(1024, 512) },
    );
    vi.spyOn(
      ObjectStorageService.prototype,
      "getSignedDownloadURL",
    ).mockResolvedValue("https://signed.example.com/image.png?sig=xyz");
    vi.spyOn(
      ObjectStorageService.prototype,
      "getObjectEntityFile",
    ).mockResolvedValue({
      download: async () => [pngBytes(1024, 512)],
    } as never);

    const { tenant, itemId } = await setupVerifiedTenant({
      caption: "",
      title: "",
    });
    try {
      const res = await request(app).post(
        `/api/content/${itemId}/publish-instagram`,
      );
      expect(res.status).toBe(202);
      await waitForPendingJobs();

      // Exactly ONE publish write — no duplicate.
      expect(calls.filter((u) => u.includes("/media_publish")).length).toBe(1);
      expect(calls.filter((u) => u.endsWith("/IG_OK/media")).length).toBe(1);
      // The caption-less probe asked for media_url and downloaded the
      // candidate image to verify it.
      expect(
        calls.some((u) =>
          u.includes("/media?fields=id,caption,timestamp,media_url"),
        ),
      ).toBe(true);
      expect(calls.some((u) => u === "https://cdn.example.com/landed.png")).toBe(
        true,
      );

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).toBe("published");
      expect(item.postId).toBe("IG_BLANK_OURS");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("caption-less IG probe does NOT match a concurrent blank post with a different image", async () => {
    const calls: string[] = [];
    // A concurrent caption-less post from ANOTHER tool: also blank, also
    // recent, but its image has different dimensions — not our post, so the
    // retry must proceed (short-circuiting here would mean the user's post
    // never lands).
    mockGraphIgPublishThenLoseResponse(
      calls,
      {
        id: "IG_BLANK_SOMEONE_ELSES",
        timestamp: new Date().toISOString(),
        media_url: "https://cdn.example.com/other.png",
      },
      { "https://cdn.example.com/other.png": pngBytes(640, 480) },
    );
    vi.spyOn(
      ObjectStorageService.prototype,
      "getSignedDownloadURL",
    ).mockResolvedValue("https://signed.example.com/image.png?sig=xyz");
    vi.spyOn(
      ObjectStorageService.prototype,
      "getObjectEntityFile",
    ).mockResolvedValue({
      download: async () => [pngBytes(1024, 512)],
    } as never);

    const { tenant, itemId } = await setupVerifiedTenant({
      caption: "",
      title: "",
    });
    try {
      const res = await request(app).post(
        `/api/content/${itemId}/publish-instagram`,
      );
      expect(res.status).toBe(202);
      await waitForPendingJobs();

      // The probe rejected the stranger's post, so the retry ran.
      expect(calls.filter((u) => u.includes("/media_publish")).length).toBe(2);

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).toBe("published");
      expect(item.postId).toBe("IG_DUPLICATE");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("still retries when the probe finds no matching recent media", async () => {
    const calls: string[] = [];
    // Probe sees only an OLD post with the same caption — created long before
    // this publish started, so it must not be mistaken for ours.
    mockGraphIgPublishThenLoseResponse(calls, {
      id: "IG_OLD_SAME_TEXT",
      caption: "hello world",
      timestamp: new Date(Date.now() - 86_400_000).toISOString(),
    });
    vi.spyOn(
      ObjectStorageService.prototype,
      "getSignedDownloadURL",
    ).mockResolvedValue("https://signed.example.com/image.png?sig=xyz");

    const { tenant, itemId } = await setupVerifiedTenant();
    try {
      const res = await request(app).post(
        `/api/content/${itemId}/publish-instagram`,
      );
      expect(res.status).toBe(202);
      await waitForPendingJobs();

      // The failed publish + the successful retry.
      expect(calls.filter((u) => u.includes("/media_publish")).length).toBe(2);

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).toBe("published");
      expect(item.postId).toBe("IG_DUPLICATE");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});
