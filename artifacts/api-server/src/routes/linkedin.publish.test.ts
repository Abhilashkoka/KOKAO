import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  LINKEDIN_MAX_LENGTH,
  splitForLinkedin,
} from "@workspace/social-limits";

/**
 * End-to-end confirmation of the LinkedIn publish/retest/disconnect flow.
 *
 * We cannot hit LinkedIn's real API (it requires an approved developer app and
 * a live member token), so we drive the ACTUAL router with LinkedIn's HTTP
 * calls (`global.fetch`) and object storage mocked, and an in-memory `db`.
 * The test server is driven over `node:http` — NOT `fetch` — so the
 * `global.fetch` mock only ever intercepts the router's outbound LinkedIn
 * calls, never our own driver requests.
 */

const TEST_TENANT = 4242;

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  accounts: [] as Row[],
  content: [] as Row[],
}));

// The pre-publish re-verify fires a breakage notification when a
// previously-good token turns out dead; that path touches tables the fake db
// does not model, so stub it out (the notification itself is covered by the
// socialReverify/notifications tests).
vi.mock("../lib/notifications", () => ({
  notifySocialConnectionFailed: vi.fn(async () => {}),
  resolveSocialConnectionNotifications: vi.fn(async () => {}),
}));

vi.mock("../lib/objectStorage", () => ({
  ObjectStorageService: class {
    async getObjectEntityFile() {
      return {
        async download() {
          return [Buffer.from("fake-image-bytes")] as [Buffer];
        },
      };
    }
  },
}));

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  const { getTableName } = await import("drizzle-orm");
  const arrFor = (table: unknown): Row[] => {
    const name = getTableName(table as Parameters<typeof getTableName>[0]);
    if (name === "connected_accounts") return state.accounts;
    if (name === "content_items") return state.content;
    throw new Error(`unexpected table ${name}`);
  };
  const fakeDb = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: () => arrFor(table).slice(0, 1),
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Row) => ({
        where: () => {
          const arr = arrFor(table);
          if (arr[0]) Object.assign(arr[0], values);
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Row) => {
        arrFor(table).push({ ...values });
      },
    }),
  };
  return { ...actual, db: fakeDb };
});

// Imported after the mocks so the router picks up the fakes.
const { default: linkedinRouter, LINKEDIN_DEDUPE_PROBE } = await import(
  "./linkedin"
);

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

let fetchCalls: FetchCall[];

interface MockRes {
  status?: number;
  json?: unknown;
  headers?: Record<string, string>;
}

function makeRes({ status = 200, json = {}, headers = {} }: MockRes = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
    headers: {
      get: (k: string) => headers[k.toLowerCase()] ?? null,
    },
  };
}

const UPLOAD_URL = "https://upload.linkedin.test/put";

type FetchHandler = (call: FetchCall) => ReturnType<typeof makeRes>;
let fetchHandler: FetchHandler;

let server: http.Server;
let basePort: number;
let originalFetch: typeof fetch;

beforeEach(async () => {
  state.accounts = [];
  state.content = [];
  fetchCalls = [];
  fetchHandler = () => makeRes();

  originalFetch = global.fetch;
  global.fetch = vi.fn(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : (input as URL).toString();
      const headers = (init?.headers ?? {}) as Record<string, string>;
      let body: unknown = init?.body;
      if (typeof body === "string") {
        try {
          body = JSON.parse(body);
        } catch {
          /* leave as-is */
        }
      }
      const method = (init?.method ?? "GET").toUpperCase();
      const call: FetchCall = { url, method, body, headers };
      fetchCalls.push(call);
      return fetchHandler(call) as unknown as Response;
    },
  ) as unknown as typeof fetch;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { tenantId: number }).tenantId = TEST_TENANT;
    (req as unknown as { log: unknown }).log = {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };
    next();
  });
  app.use(linkedinRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      basePort = (server.address() as AddressInfo).port;
      resolve();
    });
  });
});

afterEach(async () => {
  global.fetch = originalFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface DriverResponse {
  status: number;
  json: any;
}

function drive(
  method: string,
  path: string,
): Promise<DriverResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: basePort, method, path },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            json: raw ? JSON.parse(raw) : null,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function seedConnectedAccount(overrides: Row = {}) {
  state.accounts.push({
    id: 1,
    tenantId: TEST_TENANT,
    platform: "linkedin",
    accountName: "Jane Member",
    status: "connected",
    accessToken: "valid-token",
    tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    providerUserId: "member123",
    ...overrides,
  });
}

function seedContentItem(overrides: Row = {}) {
  state.content.push({
    id: 1,
    tenantId: TEST_TENANT,
    title: "",
    caption: "Hello world",
    imagePath: null,
    status: "draft",
    ...overrides,
  });
}

describe("LinkedIn publish", () => {
  it("publishes a text-only post and flips the item to published", async () => {
    seedConnectedAccount();
    seedContentItem({ caption: "Check this (out) #great & more" });
    fetchHandler = (call) => {
      if (call.url.endsWith("/rest/posts")) {
        return makeRes({
          status: 201,
          headers: { "x-restli-id": "urn:li:share:999" },
        });
      }
      return makeRes();
    };

    const res = await drive("POST", "/content/1/publish-linkedin");

    expect(res.status).toBe(200);
    expect(res.json.postId).toBe("urn:li:share:999");
    expect(res.json.permalink).toContain("urn:li:share:999");
    expect(state.content[0].status).toBe("published");
    // The returned postId/permalink is persisted so the library keeps a
    // "View post" link after the success toast disappears.
    expect(state.content[0].postId).toBe("urn:li:share:999");
    expect(state.content[0].permalink).toBe(
      "https://www.linkedin.com/feed/update/urn:li:share:999",
    );

    // No image initialization for a text-only post.
    expect(fetchCalls.some((c) => c.url.includes("initializeUpload"))).toBe(
      false,
    );

    const post = fetchCalls.find((c) => c.url.endsWith("/rest/posts"));
    const body = post!.body as Record<string, unknown>;
    // Reserved "Little Text" characters must be backslash-escaped.
    expect(body.commentary).toBe("Check this \\(out\\) \\#great & more");
    expect(body.content).toBeUndefined();
    expect(body.author).toBe("urn:li:person:member123");
  });

  it("splits a caption over LinkedIn's limit into the post plus follow-up comments", async () => {
    // A whitespace-friendly caption well over the 3000-char post limit.
    const longCaption = "lorem ".repeat(800).trim();
    const { main, comments: expectedComments } = splitForLinkedin(longCaption);
    expect(expectedComments.length).toBeGreaterThan(0);

    seedConnectedAccount();
    seedContentItem({ caption: longCaption });
    fetchHandler = (call) => {
      if (call.url.endsWith("/rest/posts")) {
        return makeRes({
          status: 201,
          headers: { "x-restli-id": "urn:li:share:555" },
        });
      }
      if (call.url.includes("/socialActions/")) {
        return makeRes({ status: 201 });
      }
      return makeRes();
    };

    const res = await drive("POST", "/content/1/publish-linkedin");

    expect(res.status).toBe(200);
    expect(res.json.commentsTotal).toBe(expectedComments.length);
    expect(res.json.commentsPosted).toBe(expectedComments.length);
    expect(res.json.commentWarning).toBeUndefined();
    expect(state.content[0].status).toBe("published");

    // The main post carries the first chunk, still within the post limit.
    const post = fetchCalls.find((c) => c.url.endsWith("/rest/posts"));
    const commentary = (post!.body as Record<string, unknown>)
      .commentary as string;
    expect(commentary.length).toBeLessThanOrEqual(LINKEDIN_MAX_LENGTH);
    // No overflow was dropped: the remainder went out as comments in order.
    const commentCalls = fetchCalls.filter((c) =>
      c.url.includes("/socialActions/"),
    );
    expect(commentCalls.length).toBe(expectedComments.length);
    commentCalls.forEach((c, i) => {
      const body = c.body as Record<string, any>;
      expect(body.object).toBe("urn:li:share:555");
      expect(body.actor).toBe("urn:li:person:member123");
      expect(body.message.text).toBe(expectedComments[i]);
      // Multi-comment overflow is numbered so readers can follow the order
      // even if LinkedIn reorders comments, and stays within the limit.
      if (expectedComments.length > 1) {
        expect(body.message.text).toMatch(
          new RegExp(`^\\(${i + 1}/${expectedComments.length}\\) `),
        );
      }
      expect((body.message.text as string).length).toBeLessThanOrEqual(1250);
      // Comment URN is URL-encoded into the path.
      expect(c.url).toContain(encodeURIComponent("urn:li:share:555"));
    });
    // Sanity: the main chunk is what we escaped into the post commentary.
    expect(main.length).toBeLessThanOrEqual(LINKEDIN_MAX_LENGTH);
  });

  it("keeps the post published and surfaces a warning when a comment fails", async () => {
    const longCaption = "lorem ".repeat(800).trim();
    const { comments: expectedComments } = splitForLinkedin(longCaption);
    expect(expectedComments.length).toBeGreaterThan(0);

    seedConnectedAccount();
    seedContentItem({ caption: longCaption });
    fetchHandler = (call) => {
      if (call.url.endsWith("/rest/posts")) {
        return makeRes({
          status: 201,
          headers: { "x-restli-id": "urn:li:share:556" },
        });
      }
      if (call.url.includes("/socialActions/")) {
        // First comment fails; the rest must not be attempted silently.
        return makeRes({ status: 500, json: { message: "rate limited" } });
      }
      return makeRes();
    };

    const res = await drive("POST", "/content/1/publish-linkedin");

    expect(res.status).toBe(200);
    // The main post still counts as published.
    expect(state.content[0].status).toBe("published");
    expect(res.json.postId).toBe("urn:li:share:556");
    expect(res.json.commentsPosted).toBe(0);
    expect(res.json.commentsTotal).toBe(expectedComments.length);
    // The failure is surfaced, not silent.
    expect(res.json.commentWarning).toBeTruthy();
    // We stop after the first failure rather than hammering the API.
    const commentCalls = fetchCalls.filter((c) =>
      c.url.includes("/socialActions/"),
    );
    expect(commentCalls.length).toBe(1);
    // The incomplete sequence is persisted so it can be resent later with
    // the same numbering, even if the caption is edited in the meantime.
    const saved = state.content[0].linkedinCommentState as {
      postUrn: string;
      comments: string[];
      postedCount: number;
    };
    expect(saved).toBeTruthy();
    expect(saved.postUrn).toBe("urn:li:share:556");
    expect(saved.comments).toEqual(expectedComments);
    expect(saved.postedCount).toBe(0);
  });

  it("publishes a post with an image (init -> upload -> attach)", async () => {
    seedConnectedAccount();
    seedContentItem({ imagePath: "/objects/pic.png" });
    fetchHandler = (call) => {
      if (call.url.includes("initializeUpload")) {
        return makeRes({
          json: {
            value: { uploadUrl: UPLOAD_URL, image: "urn:li:image:abc" },
          },
        });
      }
      if (call.url === UPLOAD_URL) return makeRes({ status: 201 });
      if (call.url.endsWith("/rest/posts")) {
        return makeRes({
          status: 201,
          headers: { "x-restli-id": "urn:li:share:777" },
        });
      }
      return makeRes();
    };

    const res = await drive("POST", "/content/1/publish-linkedin");

    expect(res.status).toBe(200);
    expect(state.content[0].status).toBe("published");

    const init = fetchCalls.find((c) => c.url.includes("initializeUpload"));
    expect(init).toBeTruthy();
    const upload = fetchCalls.find((c) => c.url === UPLOAD_URL);
    expect(upload?.method).toBe("PUT");

    const post = fetchCalls.find((c) => c.url.endsWith("/rest/posts"));
    const content = (post!.body as Record<string, any>).content;
    expect(content.media.id).toBe("urn:li:image:abc");
  });

  it("returns 400 and leaves the item as draft when not connected", async () => {
    seedConnectedAccount({ accessToken: null, status: "disconnected" });
    seedContentItem();

    const res = await drive("POST", "/content/1/publish-linkedin");

    expect(res.status).toBe(400);
    expect(state.content[0].status).toBe("draft");
    expect(fetchCalls.length).toBe(0);
  });

  it("surfaces a 502 (not a silent success) when image init fails", async () => {
    seedConnectedAccount();
    seedContentItem({ imagePath: "/objects/pic.png" });
    fetchHandler = (call) => {
      if (call.url.includes("initializeUpload")) {
        return makeRes({ status: 400, json: { message: "bad owner" } });
      }
      return makeRes();
    };

    const res = await drive("POST", "/content/1/publish-linkedin");

    expect(res.status).toBe(502);
    // The rejection is persisted so it stays reviewable after the toast.
    expect(state.content[0].status).toBe("failed");
    expect(state.content[0].failureReason).toContain("LinkedIn rejected the post");
    // The post was never attempted after the init failure.
    expect(fetchCalls.some((c) => c.url.endsWith("/rest/posts"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A dead LinkedIn token (expired by timestamp or revoked upstream) must block
// the publish with the clear 400 "reconnect" message — never a confusing raw
// LinkedIn platform error — and the item must stay unpublished. Mirrors the
// "Threads publish inline token refresh" pinning tests.
// ---------------------------------------------------------------------------
describe("LinkedIn publish with a dead token", () => {
  it("returns the clear 400 reconnect error for a timestamp-expired token, with no LinkedIn write traffic", async () => {
    seedConnectedAccount({
      tokenExpiresAt: new Date(Date.now() - 60 * 60 * 1000),
      verifyStatus: "verified",
      verifiedAt: new Date(),
    });
    seedContentItem();
    // Any LinkedIn API traffic would "succeed" — the block must come from the
    // expiry check, not from a platform error response.
    fetchHandler = () =>
      makeRes({ status: 201, headers: { "x-restli-id": "urn:li:share:bad" } });

    const res = await drive("POST", "/content/1/publish-linkedin");

    // The clear reconnect message — not a raw LinkedIn API error.
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/reconnect/i);
    expect(res.json.error).not.toMatch(/LinkedIn API error/i);

    // Nothing was posted on the dead token: no probe, no post, no comments.
    expect(
      fetchCalls.filter((c) => c.url.includes("/rest/posts")).length,
    ).toBe(0);

    // The item stays unpublished with no postId.
    expect(state.content[0].status).not.toBe("published");
    expect(state.content[0].postId ?? null).toBeNull();

    // The row was flipped so the Accounts page shows the reconnect prompt.
    expect(state.accounts[0].verifyStatus).toBe("failed");
  });

  it("returns the clear 400 reconnect error when LinkedIn rejects the stored token (401), with no post creation", async () => {
    // No timestamp expiry — the token only turns out dead when LinkedIn
    // rejects it during the forced pre-publish re-verify.
    seedConnectedAccount({
      tokenExpiresAt: null,
      verifyStatus: "verified",
      verifiedAt: new Date(),
    });
    seedContentItem();
    fetchHandler = (call) => {
      if (call.url.includes("/userinfo")) {
        return makeRes({ status: 401, json: { message: "Invalid access token" } });
      }
      return makeRes({
        status: 201,
        headers: { "x-restli-id": "urn:li:share:bad" },
      });
    };

    const res = await drive("POST", "/content/1/publish-linkedin");

    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/reconnect/i);
    // The raw platform message never leaks to the user.
    expect(res.json.error).not.toContain("Invalid access token");

    // The re-verify hit userinfo, but nothing was posted on the dead token.
    expect(fetchCalls.some((c) => c.url.includes("/userinfo"))).toBe(true);
    expect(
      fetchCalls.filter((c) => c.url.includes("/rest/posts")).length,
    ).toBe(0);

    expect(state.content[0].status).not.toBe("published");
    expect(state.content[0].postId ?? null).toBeNull();
    expect(state.accounts[0].verifyStatus).toBe("failed");
  });

  it("still publishes normally when the forced pre-publish re-verify confirms the token (regression guard)", async () => {
    seedConnectedAccount({ verifyStatus: "verified", verifiedAt: new Date() });
    seedContentItem();
    fetchHandler = (call) => {
      if (call.url.includes("/userinfo")) {
        return makeRes({ json: { sub: "member123", name: "Jane Member" } });
      }
      if (call.method === "GET" && call.url.includes("/rest/posts?")) {
        return makeRes({ json: { elements: [] } });
      }
      if (call.method === "POST" && call.url.endsWith("/rest/posts")) {
        return makeRes({
          status: 201,
          headers: { "x-restli-id": "urn:li:share:ok" },
        });
      }
      return makeRes();
    };

    const res = await drive("POST", "/content/1/publish-linkedin");

    expect(res.status).toBe(200);
    expect(res.json.postId).toBe("urn:li:share:ok");
    expect(state.content[0].status).toBe("published");
    expect(state.accounts[0].verifyStatus).toBe("verified");
  });
});

describe("LinkedIn publish dedupe (retry after committed-but-lost response)", () => {
  const CAPTION = "Check this (out) #great & more";
  // Same escaping the route applies before sending.
  const ESCAPED = "Check this \\(out\\) \\#great & more";

  function probeHandler(opts: {
    elements: unknown[];
    postId?: string;
    probeStatus?: number;
  }): FetchHandler {
    return (call) => {
      if (call.method === "GET" && call.url.includes("/rest/posts?")) {
        return makeRes({
          status: opts.probeStatus ?? 200,
          json: { elements: opts.elements },
        });
      }
      if (call.method === "POST" && call.url.endsWith("/rest/posts")) {
        return makeRes({
          status: 201,
          headers: { "x-restli-id": opts.postId ?? "urn:li:share:new" },
        });
      }
      if (call.url.includes("/socialActions/")) {
        return makeRes({ status: 201 });
      }
      return makeRes();
    };
  }

  it("simulates a committed-but-lost publish: the retry reuses the existing post instead of double-posting", async () => {
    seedConnectedAccount();
    seedContentItem({ caption: CAPTION });

    // First attempt: the post commits on LinkedIn but the response is lost
    // (server error surface). Probe sees nothing yet.
    let committed = false;
    fetchHandler = (call) => {
      if (call.method === "GET" && call.url.includes("/rest/posts?")) {
        return makeRes({
          json: {
            elements: committed
              ? [
                  {
                    id: "urn:li:share:landed",
                    commentary: ESCAPED,
                    createdAt: Date.now() - 30 * 1000,
                  },
                ]
              : [],
          },
        });
      }
      if (call.method === "POST" && call.url.endsWith("/rest/posts")) {
        // The write COMMITS but the response is "lost" (transient error).
        committed = true;
        return makeRes({ status: 500, json: { message: "gateway timeout" } });
      }
      return makeRes();
    };

    const first = await drive("POST", "/content/1/publish-linkedin");
    expect(first.status).toBe(502);
    expect(state.content[0].status).toBe("failed");

    // The user re-clicks Publish.
    const retry = await drive("POST", "/content/1/publish-linkedin");

    expect(retry.status).toBe(200);
    expect(retry.json.postId).toBe("urn:li:share:landed");
    expect(state.content[0].status).toBe("published");
    expect(state.content[0].postId).toBe("urn:li:share:landed");

    // Exactly ONE post creation happened across both attempts.
    const creates = fetchCalls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/rest/posts"),
    );
    expect(creates.length).toBe(1);
  });

  it("skips the image upload entirely when the post already landed", async () => {
    seedConnectedAccount();
    seedContentItem({ caption: CAPTION, imagePath: "/objects/pic.png" });
    fetchHandler = probeHandler({
      elements: [
        {
          id: "urn:li:share:landed",
          commentary: ESCAPED,
          createdAt: Date.now() - 60 * 1000,
        },
      ],
    });

    const res = await drive("POST", "/content/1/publish-linkedin");

    expect(res.status).toBe(200);
    expect(res.json.postId).toBe("urn:li:share:landed");
    expect(fetchCalls.some((c) => c.url.includes("initializeUpload"))).toBe(
      false,
    );
    expect(
      fetchCalls.filter(
        (c) => c.method === "POST" && c.url.endsWith("/rest/posts"),
      ).length,
    ).toBe(0);
  });

  it("still publishes when the identical post is older than the dedupe window (intentional re-post)", async () => {
    seedConnectedAccount();
    seedContentItem({ caption: CAPTION });
    fetchHandler = probeHandler({
      elements: [
        {
          id: "urn:li:share:old",
          commentary: ESCAPED,
          createdAt: Date.now() - 11 * 60 * 1000,
        },
      ],
      postId: "urn:li:share:fresh",
    });

    const res = await drive("POST", "/content/1/publish-linkedin");

    expect(res.status).toBe(200);
    expect(res.json.postId).toBe("urn:li:share:fresh");
    expect(
      fetchCalls.filter(
        (c) => c.method === "POST" && c.url.endsWith("/rest/posts"),
      ).length,
    ).toBe(1);
  });

  it("publishes normally when the probe itself fails (best-effort dedupe)", async () => {
    seedConnectedAccount();
    seedContentItem({ caption: CAPTION });
    fetchHandler = probeHandler({
      elements: [],
      probeStatus: 500,
      postId: "urn:li:share:fresh",
    });

    const res = await drive("POST", "/content/1/publish-linkedin");

    expect(res.status).toBe(200);
    expect(res.json.postId).toBe("urn:li:share:fresh");
    expect(state.content[0].status).toBe("published");
  });

  function pagedProbeHandler(opts: {
    pages: unknown[][];
    postId?: string;
  }): FetchHandler {
    return (call) => {
      if (call.method === "GET" && call.url.includes("/rest/posts?")) {
        const start = Number(
          new URL(call.url).searchParams.get("start") ?? "0",
        );
        const page = Math.floor(start / LINKEDIN_DEDUPE_PROBE.pageSize);
        return makeRes({ json: { elements: opts.pages[page] ?? [] } });
      }
      if (call.method === "POST" && call.url.endsWith("/rest/posts")) {
        return makeRes({
          status: 201,
          headers: { "x-restli-id": opts.postId ?? "urn:li:share:new" },
        });
      }
      if (call.url.includes("/socialActions/")) {
        return makeRes({ status: 201 });
      }
      return makeRes();
    };
  }

  const fillerPost = (i: number) => ({
    id: `urn:li:share:filler${i}`,
    commentary: `unrelated post ${i}`,
    createdAt: Date.now() - i * 1000,
  });

  const fullPage = (offset: number) =>
    Array.from({ length: LINKEDIN_DEDUPE_PROBE.pageSize }, (_, i) =>
      fillerPost(offset + i),
    );

  it("finds the landed post beyond the first page on a busy account (paginates)", async () => {
    seedConnectedAccount();
    seedContentItem({ caption: CAPTION });

    const savedPageSize = LINKEDIN_DEDUPE_PROBE.pageSize;
    LINKEDIN_DEDUPE_PROBE.pageSize = 3;
    try {
      // A busy account pushed the just-landed post onto page 2.
      fetchHandler = pagedProbeHandler({
        pages: [
          fullPage(0),
          [
            {
              id: "urn:li:share:landed",
              commentary: ESCAPED,
              createdAt: Date.now() - 30 * 1000,
            },
          ],
        ],
      });

      const res = await drive("POST", "/content/1/publish-linkedin");

      expect(res.status).toBe(200);
      expect(res.json.postId).toBe("urn:li:share:landed");
      // No new post was created — the retry reused the landed one.
      expect(
        fetchCalls.filter(
          (c) => c.method === "POST" && c.url.endsWith("/rest/posts"),
        ).length,
      ).toBe(0);
      const probeCalls = fetchCalls.filter(
        (c) => c.method === "GET" && c.url.includes("/rest/posts?"),
      );
      expect(probeCalls.length).toBe(2);
      expect(probeCalls[1].url).toContain("start=3");
    } finally {
      LINKEDIN_DEDUPE_PROBE.pageSize = savedPageSize;
    }
  });

  it("stops paginating at the maxPages cap and publishes normally", async () => {
    seedConnectedAccount();
    seedContentItem({ caption: CAPTION });

    const savedMaxPages = LINKEDIN_DEDUPE_PROBE.maxPages;
    LINKEDIN_DEDUPE_PROBE.maxPages = 2;
    try {
      // The matching post sits on page 3, past the cap — the probe gives up
      // (bounded work) and the publish proceeds as a fresh post.
      fetchHandler = pagedProbeHandler({
        pages: [
          fullPage(0),
          fullPage(LINKEDIN_DEDUPE_PROBE.pageSize),
          [
            {
              id: "urn:li:share:beyondcap",
              commentary: ESCAPED,
              createdAt: Date.now() - 30 * 1000,
            },
          ],
        ],
        postId: "urn:li:share:fresh",
      });

      const res = await drive("POST", "/content/1/publish-linkedin");

      expect(res.status).toBe(200);
      expect(res.json.postId).toBe("urn:li:share:fresh");
      const probeCalls = fetchCalls.filter(
        (c) => c.method === "GET" && c.url.includes("/rest/posts?"),
      );
      expect(probeCalls.length).toBe(2);
      expect(
        fetchCalls.filter(
          (c) => c.method === "POST" && c.url.endsWith("/rest/posts"),
        ).length,
      ).toBe(1);
    } finally {
      LINKEDIN_DEDUPE_PROBE.maxPages = savedMaxPages;
    }
  });

  it("keeps paginating past a page of old-but-recently-edited posts (LAST_MODIFIED ordering)", async () => {
    seedConnectedAccount();
    seedContentItem({ caption: CAPTION });

    const savedPageSize = LINKEDIN_DEDUPE_PROBE.pageSize;
    LINKEDIN_DEDUPE_PROBE.pageSize = 2;
    try {
      // The API sorts by LAST_MODIFIED: page 1 is full of OLD posts (ancient
      // createdAt) that were just edited, while the freshly created landed
      // post sits on page 2. The probe must not stop at the stale-looking
      // first page.
      fetchHandler = (call) => {
        if (call.method === "GET" && call.url.includes("/rest/posts?")) {
          const start = Number(
            new URL(call.url).searchParams.get("start") ?? "0",
          );
          return makeRes({
            json: {
              elements:
                start === 0
                  ? [
                      {
                        id: "urn:li:share:oldA",
                        commentary: "ancient a",
                        createdAt: Date.now() - 60 * 60 * 1000,
                      },
                      {
                        id: "urn:li:share:oldB",
                        commentary: "ancient b",
                        createdAt: Date.now() - 60 * 60 * 1000,
                      },
                    ]
                  : [
                      {
                        id: "urn:li:share:landed",
                        commentary: ESCAPED,
                        createdAt: Date.now() - 30 * 1000,
                      },
                    ],
            },
          });
        }
        if (call.method === "POST" && call.url.endsWith("/rest/posts")) {
          return makeRes({
            status: 201,
            headers: { "x-restli-id": "urn:li:share:dupe" },
          });
        }
        return makeRes();
      };

      const res = await drive("POST", "/content/1/publish-linkedin");

      expect(res.status).toBe(200);
      expect(res.json.postId).toBe("urn:li:share:landed");
      const probeCalls = fetchCalls.filter(
        (c) => c.method === "GET" && c.url.includes("/rest/posts?"),
      );
      expect(probeCalls.length).toBe(2);
      expect(
        fetchCalls.filter(
          (c) => c.method === "POST" && c.url.endsWith("/rest/posts"),
        ).length,
      ).toBe(0);
    } finally {
      LINKEDIN_DEDUPE_PROBE.pageSize = savedPageSize;
    }
  });

  it("posts overflow comments after a dedupe hit when the failed attempt never got to them", async () => {
    const longCaption = "lorem ".repeat(800).trim();
    const { main, comments: expectedComments } = splitForLinkedin(longCaption);
    expect(expectedComments.length).toBeGreaterThan(0);
    const escapedMain = main.replace(/[\\<>@~#*_(){}\[\]|]/g, (c) => `\\${c}`);

    seedConnectedAccount();
    // Previous attempt failed after the post committed: item is "failed", no
    // comment state — so no comments went out yet.
    seedContentItem({ caption: longCaption, status: "failed" });
    fetchHandler = probeHandler({
      elements: [
        {
          id: "urn:li:share:landed",
          commentary: escapedMain,
          createdAt: Date.now() - 60 * 1000,
        },
      ],
    });

    const res = await drive("POST", "/content/1/publish-linkedin");

    expect(res.status).toBe(200);
    expect(res.json.postId).toBe("urn:li:share:landed");
    expect(res.json.commentsPosted).toBe(expectedComments.length);
    // No new post; all comments attached to the found post.
    expect(
      fetchCalls.filter(
        (c) => c.method === "POST" && c.url.endsWith("/rest/posts"),
      ).length,
    ).toBe(0);
    const commentCalls = fetchCalls.filter((c) =>
      c.url.includes("/socialActions/"),
    );
    expect(commentCalls.length).toBe(expectedComments.length);
    commentCalls.forEach((c) => {
      expect(c.url).toContain(encodeURIComponent("urn:li:share:landed"));
    });
  });

  it("does not re-post comments that a previous attempt already delivered", async () => {
    const longCaption = "lorem ".repeat(800).trim();
    const { main, comments: expectedComments } = splitForLinkedin(longCaption);
    expect(expectedComments.length).toBeGreaterThan(1);
    const escapedMain = main.replace(/[\\<>@~#*_(){}\[\]|]/g, (c) => `\\${c}`);

    seedConnectedAccount();
    seedContentItem({
      caption: longCaption,
      status: "published",
      postId: "urn:li:share:landed",
      linkedinCommentState: {
        postUrn: "urn:li:share:landed",
        comments: expectedComments,
        postedCount: 1,
      },
    });
    fetchHandler = probeHandler({
      elements: [
        {
          id: "urn:li:share:landed",
          commentary: escapedMain,
          createdAt: Date.now() - 60 * 1000,
        },
      ],
    });

    const res = await drive("POST", "/content/1/publish-linkedin");

    expect(res.status).toBe(200);
    expect(res.json.commentsPosted).toBe(expectedComments.length);
    // Only the missing comments went out, starting from the second one.
    const commentCalls = fetchCalls.filter((c) =>
      c.url.includes("/socialActions/"),
    );
    expect(commentCalls.length).toBe(expectedComments.length - 1);
    expect((commentCalls[0]!.body as any).message.text).toBe(
      expectedComments[1],
    );
  });
});

describe("LinkedIn comment resend", () => {
  const COMMENTS = ["(1/3) part one", "(2/3) part two", "(3/3) part three"];

  function seedWithPendingComments(postedCount: number) {
    seedConnectedAccount();
    seedContentItem({
      status: "published",
      postId: "urn:li:share:556",
      permalink: "https://www.linkedin.com/feed/update/urn:li:share:556",
      linkedinCommentState: {
        postUrn: "urn:li:share:556",
        comments: COMMENTS,
        postedCount,
      },
    });
  }

  it("posts only the missing comments with their original numbering and clears the state", async () => {
    seedWithPendingComments(1);
    fetchHandler = (call) => {
      if (call.url.includes("/userinfo")) {
        return makeRes({ json: { sub: "member123", name: "Jane Member" } });
      }
      if (call.url.includes("/socialActions/")) {
        return call.method === "GET"
          ? makeRes({ json: { elements: [] } })
          : makeRes({ status: 201 });
      }
      return makeRes();
    };

    const res = await drive("POST", "/content/1/resend-linkedin-comments");

    expect(res.status).toBe(200);
    expect(res.json.commentsPosted).toBe(3);
    expect(res.json.commentsTotal).toBe(3);
    expect(res.json.commentsRemaining).toBe(0);
    expect(res.json.commentWarning).toBeUndefined();
    expect(res.json.permalink).toContain("urn:li:share:556");

    // Only the two missing comments went out — the already-posted first one
    // is never re-sent (no duplicates), and numbering is preserved.
    const commentCalls = fetchCalls.filter(
      (c) => c.url.includes("/socialActions/") && c.method === "POST",
    );
    expect(commentCalls.length).toBe(2);
    expect((commentCalls[0]!.body as any).message.text).toBe(COMMENTS[1]);
    expect((commentCalls[1]!.body as any).message.text).toBe(COMMENTS[2]);
    // Completed: the pending state is cleared.
    expect(state.content[0].linkedinCommentState).toBeNull();
  });

  it("keeps the remaining state and warns when a resend fails again mid-sequence", async () => {
    seedWithPendingComments(0);
    let commentCallCount = 0;
    fetchHandler = (call) => {
      if (call.url.includes("/userinfo")) {
        return makeRes({ json: { sub: "member123" } });
      }
      if (call.url.includes("/socialActions/")) {
        if (call.method === "GET") {
          return makeRes({ json: { elements: [] } });
        }
        commentCallCount += 1;
        // First comment succeeds, second fails.
        return commentCallCount === 1
          ? makeRes({ status: 201 })
          : makeRes({ status: 500, json: { message: "rate limited" } });
      }
      return makeRes();
    };

    const res = await drive("POST", "/content/1/resend-linkedin-comments");

    expect(res.status).toBe(200);
    expect(res.json.commentsPosted).toBe(1);
    expect(res.json.commentsRemaining).toBe(2);
    expect(res.json.commentWarning).toBeTruthy();
    // Progress is persisted so the next resend starts at the right comment.
    const saved = state.content[0].linkedinCommentState as {
      postedCount: number;
      comments: string[];
    };
    expect(saved.postedCount).toBe(1);
    expect(saved.comments).toEqual(COMMENTS);
  });

  it("skips comments that already exist on the post and only posts the truly missing ones", async () => {
    // The persisted state says only the first comment landed, but the second
    // actually reached LinkedIn too (its response was lost). The resend must
    // detect it via the comments probe and only post the third.
    seedWithPendingComments(1);
    fetchHandler = (call) => {
      if (call.url.includes("/userinfo")) {
        return makeRes({ json: { sub: "member123", name: "Jane Member" } });
      }
      if (call.url.includes("/socialActions/")) {
        if (call.method === "GET") {
          return makeRes({
            json: {
              elements: [
                { message: { text: COMMENTS[0] } },
                { message: { text: COMMENTS[1] } },
              ],
            },
          });
        }
        return makeRes({ status: 201 });
      }
      return makeRes();
    };

    const res = await drive("POST", "/content/1/resend-linkedin-comments");

    expect(res.status).toBe(200);
    expect(res.json.commentsPosted).toBe(3);
    expect(res.json.commentsRemaining).toBe(0);
    expect(res.json.commentWarning).toBeUndefined();

    // Only the genuinely missing third comment was posted; the second one
    // (already on the post) was skipped, not re-sent.
    const commentPosts = fetchCalls.filter(
      (c) => c.url.includes("/socialActions/") && c.method === "POST",
    );
    expect(commentPosts.length).toBe(1);
    expect((commentPosts[0]!.body as any).message.text).toBe(COMMENTS[2]);
    // Sequence complete: the pending state is cleared.
    expect(state.content[0].linkedinCommentState).toBeNull();
  });

  it("still resends from the persisted count when the comments probe fails", async () => {
    seedWithPendingComments(1);
    fetchHandler = (call) => {
      if (call.url.includes("/userinfo")) {
        return makeRes({ json: { sub: "member123" } });
      }
      if (call.url.includes("/socialActions/")) {
        if (call.method === "GET") {
          return makeRes({ status: 500, json: { message: "boom" } });
        }
        return makeRes({ status: 201 });
      }
      return makeRes();
    };

    const res = await drive("POST", "/content/1/resend-linkedin-comments");

    expect(res.status).toBe(200);
    expect(res.json.commentsPosted).toBe(3);
    const commentPosts = fetchCalls.filter(
      (c) => c.url.includes("/socialActions/") && c.method === "POST",
    );
    expect(commentPosts.length).toBe(2);
    expect((commentPosts[0]!.body as any).message.text).toBe(COMMENTS[1]);
  });

  it("returns 400 when there is nothing to resend", async () => {
    seedConnectedAccount();
    seedContentItem({ status: "published" });

    const res = await drive("POST", "/content/1/resend-linkedin-comments");

    expect(res.status).toBe(400);
    expect(fetchCalls.filter((c) => c.url.includes("/socialActions/")).length).toBe(0);
  });

  it("returns 400 when LinkedIn is no longer connected", async () => {
    seedWithPendingComments(0);
    state.accounts[0]!.accessToken = null;

    const res = await drive("POST", "/content/1/resend-linkedin-comments");

    expect(res.status).toBe(400);
    expect(res.json.error).toContain("Reconnect");
  });
});

describe("LinkedIn retest", () => {
  it("keeps the connection when the token is still valid", async () => {
    seedConnectedAccount();
    fetchHandler = () =>
      makeRes({ json: { sub: "member123", name: "Jane Updated" } });

    const res = await drive("POST", "/linkedin/retest");

    expect(res.status).toBe(200);
    expect(res.json.connected).toBe(true);
    expect(res.json.accountName).toBe("Jane Updated");
    expect(state.accounts[0].status).toBe("connected");
    expect(state.accounts[0].accessToken).toBe("valid-token");
  });

  it("clears the stored token when it no longer works", async () => {
    seedConnectedAccount();
    fetchHandler = () => makeRes({ status: 401, json: {} });

    const res = await drive("POST", "/linkedin/retest");

    expect(res.status).toBe(200);
    expect(res.json.connected).toBe(false);
    expect(state.accounts[0].status).toBe("disconnected");
    expect(state.accounts[0].accessToken).toBeNull();
    expect(state.accounts[0].tokenExpiresAt).toBeNull();
  });
});

describe("LinkedIn disconnect", () => {
  it("clears the stored token and account", async () => {
    seedConnectedAccount();

    const res = await drive("DELETE", "/linkedin");

    expect(res.status).toBe(200);
    expect(res.json.connected).toBe(false);
    expect(state.accounts[0].status).toBe("disconnected");
    expect(state.accounts[0].accessToken).toBeNull();
    expect(state.accounts[0].providerUserId).toBeNull();
  });
});
