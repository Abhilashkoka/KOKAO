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
import { IG_CONTAINER_POLL } from "./meta";
import { waitForPendingJobs } from "../lib/backgroundJobs";

const app = createTestApp();
const mockFb = vi.mocked(testFacebookCredentials);
const mockIg = vi.mocked(testInstagramCredentials);

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
      expect(downloadSpy).toHaveBeenCalledWith("/objects/uploads/test.png");

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
      expect(signSpy).toHaveBeenCalledWith("/objects/uploads/test.png", 900);

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

  beforeEach(() => {
    // Shrink the poll cap/delays so the timeout path runs instantly.
    IG_CONTAINER_POLL.maxAttempts = 3;
    IG_CONTAINER_POLL.initialDelayMs = 1;
    IG_CONTAINER_POLL.maxDelayMs = 1;
    IG_CONTAINER_POLL.backoffFactor = 1;
  });

  afterEach(() => {
    Object.assign(IG_CONTAINER_POLL, originalPoll);
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
