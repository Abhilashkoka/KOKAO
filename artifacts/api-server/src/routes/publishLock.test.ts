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
  insertThreadsAccount,
  insertContentItem,
  getContentItem,
  snapshotAppCredentialRow,
  setAppCredentialRow,
  restoreAppCredentialRow,
} from "../test/dbHelpers";

const app = createTestApp();

const TH_TOKEN = "th_tok_secret";
const TH_USER_ID = "th_user_123";
const TH_GRAPH_BASE = "https://graph.threads.net/v1.0";

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

describe("publish lock: overlapping publish clicks", () => {
  it("two truly simultaneous Threads publishes: the second is rejected with 409 while the first is still running, and nothing double-posts", async () => {
    // Gate the container-create call so the first request stalls mid-publish
    // while the second request arrives.
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
            await gate; // hold the first publish mid-flight
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
        caption: "hello world",
      });
      actAs(tenant.clerkUserId);

      // .then() forces the lazy supertest request to actually start now.
      const firstPromise = request(app)
        .post(`/api/content/${itemId}/publish-threads`)
        .then((r) => r);
      // Wait until the first request is genuinely mid-publish (it has read
      // the item, passed its dedupe probe, and started posting), then fire
      // the second.
      await publishStarted;
      const second = await request(app).post(
        `/api/content/${itemId}/publish-threads`,
      );
      expect(second.status).toBe(409);
      expect(second.body.error).toMatch(/publish.*already in progress/i);

      releaseGate();
      const first = await firstPromise;
      expect(first.status).toBe(200);

      // Only the first request posted anything: exactly one container +
      // one publish call reached Threads.
      const containerCalls = calls.filter(
        (c) =>
          c.method === "POST" &&
          c.url === `${TH_GRAPH_BASE}/${TH_USER_ID}/threads`,
      );
      expect(containerCalls.length).toBe(1);
      const publishCalls = calls.filter(
        (c) =>
          c.method === "POST" &&
          c.url === `${TH_GRAPH_BASE}/${TH_USER_ID}/threads_publish`,
      );
      expect(publishCalls.length).toBe(1);

      const item = await getContentItem(itemId, tenant.tenantId);
      expect(item.status).toBe("published");

      // The lock is released once the first publish finishes: a later
      // publish is not blocked with a 409 (the dedupe probe reuses the
      // recent post instead of re-posting, so it still succeeds).
      const third = await request(app).post(
        `/api/content/${itemId}/publish-threads`,
      );
      expect(third.status).not.toBe(409);
    } finally {
      releaseGate();
      await deleteTenant(tenant.tenantId);
    }
  });
});
