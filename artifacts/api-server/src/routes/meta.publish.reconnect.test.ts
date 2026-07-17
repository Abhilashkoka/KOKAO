import {
  describe,
  it,
  expect,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import request from "supertest";

/**
 * Publishing to Facebook or Instagram with BROKEN credentials must block with
 * a clear reconnect-style message — never a raw Graph API error — and the
 * content item must stay unpublished. Mirrors the "LinkedIn publish with a
 * dead token" and Threads pinning tests.
 *
 * Unlike meta.test.ts, this suite does NOT stub testFacebookCredentials /
 * testInstagramCredentials: it mocks `global.fetch` so the REAL pre-publish
 * re-verification runs against a Graph API that rejects the token (401), the
 * same way Meta rejects a revoked/expired token in production.
 */

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

import { pool } from "@workspace/db";
import { createTestApp } from "../test/testApp";
import { resetAuthState, actAs } from "../test/authState";
import {
  createTenant,
  deleteTenant,
  insertConnectedAccount,
  insertContentItem,
  getContentItem,
  getConnectedAccount,
} from "../test/dbHelpers";
import { ObjectStorageService } from "../lib/objectStorage";
import { IG_CONTAINER_POLL, IG_PUBLISH_RETRY } from "./meta";
import { waitForPendingJobs } from "../lib/backgroundJobs";

const app = createTestApp();

// The raw platform message a revoked/expired token produces on Graph reads.
const RAW_GRAPH_ERROR = "Error validating access token: Session has expired";

const FB_PAGE_TOKEN = "tok_fb_page_secret";

function lastPathSegment(url: string): string {
  try {
    const seg = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    return decodeURIComponent(seg);
  } catch {
    return "";
  }
}

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Mock the Graph API so token-verification reads are REJECTED like a dead
 * token (401 + raw OAuth error), while any accidental write attempt would
 * "succeed" — proving the block comes from the reconnect gate, not from a
 * downstream platform error. Records every requested URL.
 */
function mockGraphDeadToken(
  calls: string[],
  opts: { failFacebook?: boolean; failInstagram?: boolean } = {},
) {
  const { failFacebook = true, failInstagram = true } = opts;
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(url);
      // Verification reads.
      if (url.includes("fields=id,name")) {
        return failFacebook
          ? jsonRes({ error: { message: RAW_GRAPH_ERROR, code: 190 } }, 401)
          : jsonRes({ id: lastPathSegment(url), name: "Test Page" });
      }
      if (url.includes("fields=id,username")) {
        return failInstagram
          ? jsonRes({ error: { message: RAW_GRAPH_ERROR, code: 190 } }, 401)
          : jsonRes({ id: lastPathSegment(url), username: "testacct" });
      }
      // Token inspection (only reached when an app-level Meta row exists).
      if (url.includes("/debug_token")) {
        return jsonRes({
          data: {
            type: "PAGE",
            scopes: ["pages_read_engagement", "pages_manage_posts"],
          },
        });
      }
      // Any write would "succeed" — it must never be reached.
      if (url.includes("/photos")) return jsonRes({ id: "PHOTO_BAD", post_id: "POST_BAD" });
      if (url.includes("/feed")) return jsonRes({ id: "FEED_POST_BAD" });
      if (url.includes("/media_publish")) return jsonRes({ id: "IG_BAD" });
      if (url.includes("/media")) return jsonRes({ id: "IG_CONTAINER_BAD" });
      return jsonRes({});
    });
}

/**
 * Mock a Graph API where verification reads SUCCEED but write endpoints
 * reject the token with a 401/code-190 OAuth error — the token was revoked
 * in the tiny window BETWEEN the pre-publish re-verify and the actual write.
 */
function mockGraphTokenDiesMidPublish(calls: string[]) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(url);
      if (url.includes("fields=id,name"))
        return jsonRes({ id: lastPathSegment(url), name: "Test Page" });
      if (url.includes("fields=id,username"))
        return jsonRes({ id: lastPathSegment(url), username: "testacct" });
      if (url.includes("/debug_token"))
        return jsonRes({
          data: {
            type: "PAGE",
            scopes: ["pages_read_engagement", "pages_manage_posts"],
          },
        });
      // Every write fails like a token revoked mid-publish.
      if (
        url.includes("/photos") ||
        url.includes("/feed") ||
        url.includes("/media_publish") ||
        url.includes("/media")
      ) {
        return jsonRes(
          {
            error: {
              message: RAW_GRAPH_ERROR,
              code: 190,
              type: "OAuthException",
            },
          },
          401,
        );
      }
      return jsonRes({});
    });
}

/** Mock a fully healthy Graph API for the regression (valid creds) cases. */
function mockGraphHealthy(calls: string[]) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(url);
      if (url.includes("/photos")) return jsonRes({ id: "PHOTO_1", post_id: "POST_1" });
      if (url.includes("/feed")) return jsonRes({ id: "FEED_POST_1" });
      if (url.includes("/media_publish")) return jsonRes({ id: "IG_PUBLISHED_1" });
      if (url.includes("fields=status_code")) return jsonRes({ status_code: "FINISHED" });
      if (url.includes("fields=permalink"))
        return jsonRes({ permalink: "https://www.instagram.com/p/abc123/" });
      if (url.includes("fields=id,name"))
        return jsonRes({ id: lastPathSegment(url), name: "Test Page" });
      if (url.includes("fields=id,username"))
        return jsonRes({ id: lastPathSegment(url), username: "testacct" });
      if (url.includes("/debug_token"))
        return jsonRes({
          data: {
            type: "PAGE",
            scopes: ["pages_read_engagement", "pages_manage_posts"],
          },
        });
      if (url.includes("/media")) return jsonRes({ id: "IG_CONTAINER_1" });
      return jsonRes({});
    });
}

beforeEach(() => {
  resetAuthState();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await pool.end();
});

async function setupFbTenant(verifyStatus: string) {
  const tenant = await createTenant();
  await insertConnectedAccount(
    tenant.tenantId,
    "facebook",
    { pageId: "PAGE_OK", pageAccessToken: FB_PAGE_TOKEN },
    verifyStatus,
  );
  const itemId = await insertContentItem(tenant.tenantId);
  actAs(tenant.clerkUserId);
  return { tenant, itemId };
}

async function setupIgTenant(
  igVerifyStatus: string,
  fbVerifyStatus = "verified",
) {
  const tenant = await createTenant();
  await insertConnectedAccount(
    tenant.tenantId,
    "facebook",
    { pageId: "PAGE_OK", pageAccessToken: FB_PAGE_TOKEN },
    fbVerifyStatus,
  );
  await insertConnectedAccount(
    tenant.tenantId,
    "instagram",
    { igUserId: "IG_OK" },
    igVerifyStatus,
  );
  const itemId = await insertContentItem(tenant.tenantId, {
    imagePath: "/objects/uploads/test.png",
  });
  actAs(tenant.clerkUserId);
  return { tenant, itemId };
}

describe("Facebook publish with broken credentials", () => {
  it("blocks with a clear reconnect message when Meta rejects a previously-verified token (401)", async () => {
    const calls: string[] = [];
    mockGraphDeadToken(calls);

    const { tenant, itemId } = await setupFbTenant("verified");
    try {
      const res = await request(app).post(
        `/api/content/${itemId}/publish-facebook`,
      );

      // The clear reconnect message — never the raw Graph error.
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/reconnect/i);
      expect(res.body.error).not.toContain(RAW_GRAPH_ERROR);
      expect(res.body.error).not.toMatch(/error validating access token/i);

      // No write was ever attempted on the dead token.
      expect(calls.some((u) => u.includes("/feed"))).toBe(false);
      expect(calls.some((u) => u.includes("/photos"))).toBe(false);

      // The item stays unpublished, untouched by the failed attempt.
      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).toBe("draft");
      expect(item.postId ?? null).toBeNull();

      // The row was flipped so the Accounts page shows the reconnect prompt.
      const account = await getConnectedAccount(tenant.tenantId, "facebook");
      expect(account.verifyStatus).toBe("failed");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("blocks with the reconnect message when verifyStatus is already 'failed'", async () => {
    const calls: string[] = [];
    mockGraphDeadToken(calls);

    const { tenant, itemId } = await setupFbTenant("failed");
    try {
      const res = await request(app).post(
        `/api/content/${itemId}/publish-facebook`,
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/reconnect/i);
      expect(res.body.error).not.toContain(RAW_GRAPH_ERROR);

      expect(calls.some((u) => u.includes("/feed"))).toBe(false);
      expect(calls.some((u) => u.includes("/photos"))).toBe(false);

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).toBe("draft");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("maps a mid-publish token death (verify passes, write fails with code 190) to the reconnect message", async () => {
    const calls: string[] = [];
    mockGraphTokenDiesMidPublish(calls);

    const { tenant, itemId } = await setupFbTenant("verified");
    try {
      const res = await request(app).post(
        `/api/content/${itemId}/publish-facebook`,
      );

      // The friendly reconnect message — never the raw Graph error.
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/reconnect/i);
      expect(res.body.error).not.toContain(RAW_GRAPH_ERROR);
      expect(res.body.error).not.toMatch(/error validating access token/i);

      // The write was attempted exactly once — auth errors never retry.
      const writeCalls = calls.filter((u) => u.includes("/feed"));
      expect(writeCalls.length).toBe(1);

      // The item records the failure with the friendly message.
      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).toBe("failed");
      expect(item.failureReason).toMatch(/reconnect/i);
      expect(item.failureReason).not.toContain(RAW_GRAPH_ERROR);
      expect(item.postId ?? null).toBeNull();

      // The account row flipped so the Accounts page prompts a reconnect.
      const account = await getConnectedAccount(tenant.tenantId, "facebook");
      expect(account.verifyStatus).toBe("failed");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("still publishes normally with valid credentials (regression guard)", async () => {
    const calls: string[] = [];
    mockGraphHealthy(calls);

    const { tenant, itemId } = await setupFbTenant("verified");
    try {
      const res = await request(app).post(
        `/api/content/${itemId}/publish-facebook`,
      );

      expect(res.status).toBe(200);
      expect(res.body.postId).toBe("FEED_POST_1");
      expect(calls.some((u) => u.includes("/PAGE_OK/feed"))).toBe(true);

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).toBe("published");

      const account = await getConnectedAccount(tenant.tenantId, "facebook");
      expect(account.verifyStatus).toBe("verified");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});

describe("Instagram publish with broken credentials", () => {
  it("blocks with a clear reconnect message when Meta rejects the Page token the IG publish rides on (401)", async () => {
    const calls: string[] = [];
    mockGraphDeadToken(calls);

    const { tenant, itemId } = await setupIgTenant("verified");
    try {
      const res = await request(app).post(
        `/api/content/${itemId}/publish-instagram`,
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/reconnect/i);
      expect(res.body.error).not.toContain(RAW_GRAPH_ERROR);
      expect(res.body.error).not.toMatch(/error validating access token/i);

      // Nothing was created or published on the dead token.
      expect(calls.some((u) => u.includes("/media"))).toBe(false);

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).toBe("draft");
      expect(item.postId ?? null).toBeNull();

      const fb = await getConnectedAccount(tenant.tenantId, "facebook");
      expect(fb.verifyStatus).toBe("failed");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("blocks with a clear reconnect message when the IG account itself is rejected while the Page stays valid", async () => {
    const calls: string[] = [];
    mockGraphDeadToken(calls, { failFacebook: false, failInstagram: true });

    const { tenant, itemId } = await setupIgTenant("verified");
    try {
      const res = await request(app).post(
        `/api/content/${itemId}/publish-instagram`,
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/reconnect/i);
      expect(res.body.error).not.toContain(RAW_GRAPH_ERROR);

      // The IG media create/publish endpoints were never touched (the only
      // /media hit is the verification read carrying fields=id,username).
      expect(
        calls.some(
          (u) => u.includes("/media") && !u.includes("fields=id,username"),
        ),
      ).toBe(false);

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).toBe("draft");

      const ig = await getConnectedAccount(tenant.tenantId, "instagram");
      expect(ig.verifyStatus).toBe("failed");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("blocks with the reconnect message when IG verifyStatus is already 'failed'", async () => {
    const calls: string[] = [];
    mockGraphDeadToken(calls);

    const { tenant, itemId } = await setupIgTenant("failed");
    try {
      const res = await request(app).post(
        `/api/content/${itemId}/publish-instagram`,
      );

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/reconnect/i);
      expect(res.body.error).not.toContain(RAW_GRAPH_ERROR);

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).toBe("draft");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("maps a mid-publish token death (verify passes, write fails with code 190) to the reconnect message", async () => {
    const originalPoll = { ...IG_CONTAINER_POLL };
    const originalRetry = { ...IG_PUBLISH_RETRY };
    IG_CONTAINER_POLL.initialDelayMs = 1;
    IG_CONTAINER_POLL.maxDelayMs = 1;
    IG_PUBLISH_RETRY.initialDelayMs = 1;
    IG_PUBLISH_RETRY.maxDelayMs = 1;

    const calls: string[] = [];
    mockGraphTokenDiesMidPublish(calls);
    vi.spyOn(
      ObjectStorageService.prototype,
      "getSignedDownloadURL",
    ).mockResolvedValue("https://storage.example/signed/test.png");

    const { tenant, itemId } = await setupIgTenant("verified");
    try {
      const res = await request(app).post(
        `/api/content/${itemId}/publish-instagram`,
      );

      // The pre-publish re-verify passed, so the request is accepted and
      // handed to the background job — the failure surfaces on the item.
      expect(res.status).toBe(202);
      await waitForPendingJobs();

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).toBe("failed");
      expect(item.failureReason).toMatch(/reconnect/i);
      expect(item.failureReason).not.toContain(RAW_GRAPH_ERROR);
      expect(item.failureReason).not.toMatch(/error validating access token/i);

      // The write was attempted exactly once — auth errors never retry.
      const writeCalls = calls.filter(
        (u) =>
          u.includes("/IG_OK/media") && !u.includes("fields=id,username"),
      );
      expect(writeCalls.length).toBe(1);

      // The account row flipped so the Accounts page prompts a reconnect.
      const fb = await getConnectedAccount(tenant.tenantId, "facebook");
      expect(fb.verifyStatus).toBe("failed");
    } finally {
      Object.assign(IG_CONTAINER_POLL, originalPoll);
      Object.assign(IG_PUBLISH_RETRY, originalRetry);
      await deleteTenant(tenant.tenantId);
    }
  });

  it("still publishes normally with valid credentials (regression guard)", async () => {
    const originalPoll = { ...IG_CONTAINER_POLL };
    const originalRetry = { ...IG_PUBLISH_RETRY };
    IG_CONTAINER_POLL.initialDelayMs = 1;
    IG_CONTAINER_POLL.maxDelayMs = 1;
    IG_PUBLISH_RETRY.initialDelayMs = 1;
    IG_PUBLISH_RETRY.maxDelayMs = 1;

    const calls: string[] = [];
    mockGraphHealthy(calls);
    vi.spyOn(
      ObjectStorageService.prototype,
      "getSignedDownloadURL",
    ).mockResolvedValue("https://storage.example/signed/test.png");

    const { tenant, itemId } = await setupIgTenant("verified");
    try {
      const res = await request(app).post(
        `/api/content/${itemId}/publish-instagram`,
      );

      // Accepted and handed to the background job.
      expect(res.status).toBe(202);
      await waitForPendingJobs();

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).toBe("published");
      expect(item.publishedPlatforms?.instagram?.postId).toBe(
        "IG_PUBLISHED_1",
      );
      expect(calls.some((u) => u.includes("/IG_OK/media"))).toBe(true);
      // The Page token never rides in a URL.
      expect(calls.every((u) => !u.includes(FB_PAGE_TOKEN))).toBe(true);
    } finally {
      Object.assign(IG_CONTAINER_POLL, originalPoll);
      Object.assign(IG_PUBLISH_RETRY, originalRetry);
      await deleteTenant(tenant.tenantId);
    }
  });
});
