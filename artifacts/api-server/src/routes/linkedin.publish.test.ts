import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

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
const { default: linkedinRouter } = await import("./linkedin");

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
    title: "My Title",
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

  it("trims a caption over LinkedIn's limit before sending", async () => {
    const longCaption = "a".repeat(4000);
    seedConnectedAccount();
    seedContentItem({ caption: longCaption });
    fetchHandler = (call) => {
      if (call.url.endsWith("/rest/posts")) {
        return makeRes({
          status: 201,
          headers: { "x-restli-id": "urn:li:share:555" },
        });
      }
      return makeRes();
    };

    const res = await drive("POST", "/content/1/publish-linkedin");

    expect(res.status).toBe(200);
    const post = fetchCalls.find((c) => c.url.endsWith("/rest/posts"));
    const commentary = (post!.body as Record<string, unknown>)
      .commentary as string;
    // The visible text is capped at LinkedIn's 3000-char limit (2999 + ellipsis).
    expect(commentary.length).toBe(3000);
    expect(commentary.endsWith("\u2026")).toBe(true);
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
    expect(state.content[0].status).toBe("draft");
    // The post was never attempted after the init failure.
    expect(fetchCalls.some((c) => c.url.endsWith("/rest/posts"))).toBe(false);
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
