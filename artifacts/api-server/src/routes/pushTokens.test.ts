import {
  describe,
  it,
  expect,
  afterAll,
  afterEach,
  beforeEach,
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
  pushTokensTable,
  pushReceiptQueueTable,
  notificationsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp } from "../test/testApp";
import { resetAuthState, actAs } from "../test/authState";
import { createTenant, deleteTenant } from "../test/dbHelpers";
import {
  sendTenantPush,
  checkDuePushReceipts,
  pruneUnseenPushTokens,
  PUSH_TOKEN_MAX_UNSEEN_MS,
} from "../lib/push";
import {
  SOCIAL_CONNECTION_FAILED,
  SCHEDULED_POST_PUBLISHED,
  SCHEDULED_PUBLISH_FAILED,
  notifyScheduledPostPublished,
  notifyScheduledPublishFailed,
} from "../lib/notifications";

const app = createTestApp();

const TOKEN_A = "ExponentPushToken[test-push-a]";
const TOKEN_B = "ExponentPushToken[test-push-b]";

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  resetAuthState();
  await db
    .delete(pushReceiptQueueTable)
    .where(inArray(pushReceiptQueueTable.token, [TOKEN_A, TOKEN_B]));
  await db
    .delete(pushTokensTable)
    .where(inArray(pushTokensTable.token, [TOKEN_A, TOKEN_B]));
});

afterEach(async () => {
  await db
    .delete(pushReceiptQueueTable)
    .where(inArray(pushReceiptQueueTable.token, [TOKEN_A, TOKEN_B]));
  await db
    .delete(pushTokensTable)
    .where(inArray(pushTokensTable.token, [TOKEN_A, TOKEN_B]));
  vi.restoreAllMocks();
});

async function pendingReceiptsInDb() {
  return db
    .select()
    .from(pushReceiptQueueTable)
    .where(inArray(pushReceiptQueueTable.token, [TOKEN_A, TOKEN_B]));
}

describe("POST /push-tokens", () => {
  it("registers a token for the signed-in user and is idempotent", async () => {
    const tenant = await createTenant();
    try {
      actAs(tenant.clerkUserId);

      const res = await request(app)
        .post("/api/push-tokens")
        .send({ token: TOKEN_A, platform: "ios" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });

      const again = await request(app)
        .post("/api/push-tokens")
        .send({ token: TOKEN_A, platform: "ios" });
      expect(again.status).toBe(200);

      const rows = await db
        .select()
        .from(pushTokensTable)
        .where(eq(pushTokensTable.token, TOKEN_A));
      expect(rows).toHaveLength(1);
      expect(rows[0].clerkUserId).toBe(tenant.clerkUserId);
      expect(rows[0].platform).toBe("ios");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("re-binds an existing token to the current signer", async () => {
    const tenantA = await createTenant();
    const tenantB = await createTenant();
    try {
      actAs(tenantA.clerkUserId);
      await request(app).post("/api/push-tokens").send({ token: TOKEN_A });

      actAs(tenantB.clerkUserId);
      const res = await request(app)
        .post("/api/push-tokens")
        .send({ token: TOKEN_A, platform: "android" });
      expect(res.status).toBe(200);

      const rows = await db
        .select()
        .from(pushTokensTable)
        .where(eq(pushTokensTable.token, TOKEN_A));
      expect(rows).toHaveLength(1);
      expect(rows[0].clerkUserId).toBe(tenantB.clerkUserId);
    } finally {
      await deleteTenant(tenantA.tenantId);
      await deleteTenant(tenantB.tenantId);
    }
  });

  it("rejects non-Expo tokens and malformed bodies", async () => {
    const tenant = await createTenant();
    try {
      actAs(tenant.clerkUserId);

      const bad = await request(app)
        .post("/api/push-tokens")
        .send({ token: "not-an-expo-token" });
      expect(bad.status).toBe(400);

      const malformed = await request(app).post("/api/push-tokens").send({});
      expect(malformed.status).toBe(400);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("requires authentication", async () => {
    const res = await request(app)
      .post("/api/push-tokens")
      .send({ token: TOKEN_A });
    expect(res.status).toBe(401);
  });
});

describe("POST /push-tokens/unregister", () => {
  it("removes only the caller's own token and is idempotent", async () => {
    const tenantA = await createTenant();
    const tenantB = await createTenant();
    try {
      actAs(tenantA.clerkUserId);
      await request(app).post("/api/push-tokens").send({ token: TOKEN_A });

      // Someone else cannot silence tenant A's device.
      actAs(tenantB.clerkUserId);
      const foreign = await request(app)
        .post("/api/push-tokens/unregister")
        .send({ token: TOKEN_A });
      expect(foreign.status).toBe(200);
      let rows = await db
        .select()
        .from(pushTokensTable)
        .where(eq(pushTokensTable.token, TOKEN_A));
      expect(rows).toHaveLength(1);

      // The owner can, and a repeat succeeds too.
      actAs(tenantA.clerkUserId);
      const own = await request(app)
        .post("/api/push-tokens/unregister")
        .send({ token: TOKEN_A });
      expect(own.status).toBe(200);
      const repeat = await request(app)
        .post("/api/push-tokens/unregister")
        .send({ token: TOKEN_A });
      expect(repeat.status).toBe(200);

      rows = await db
        .select()
        .from(pushTokensTable)
        .where(eq(pushTokensTable.token, TOKEN_A));
      expect(rows).toHaveLength(0);
    } finally {
      await deleteTenant(tenantA.tenantId);
      await deleteTenant(tenantB.tenantId);
    }
  });
});

describe("sendTenantPush", () => {
  it("sends to the owner's registered devices for an enabled type", async () => {
    const tenant = await createTenant();
    try {
      await db.insert(pushTokensTable).values({
        clerkUserId: tenant.clerkUserId,
        token: TOKEN_A,
        platform: "ios",
      });

      // Seed the tenant's in-app feed so the push carries a badge count:
      // two unread in-app rows, one read, one email-only (excluded).
      await db.insert(notificationsTable).values([
        {
          tenantId: tenant.tenantId,
          type: SOCIAL_CONNECTION_FAILED,
          title: "Unread 1",
          message: "m",
          inApp: true,
        },
        {
          tenantId: tenant.tenantId,
          type: SOCIAL_CONNECTION_FAILED,
          title: "Unread 2",
          message: "m",
          inApp: true,
        },
        {
          tenantId: tenant.tenantId,
          type: SOCIAL_CONNECTION_FAILED,
          title: "Read",
          message: "m",
          inApp: true,
          readAt: new Date(),
        },
        {
          tenantId: tenant.tenantId,
          type: SOCIAL_CONNECTION_FAILED,
          title: "Email only",
          message: "m",
          inApp: false,
        },
      ]);

      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(JSON.stringify({ data: [{ status: "ok" }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );

      await sendTenantPush(tenant.tenantId, SOCIAL_CONNECTION_FAILED, {
        title: "Test",
        message: "Test message",
        linkUrl: "/accounts",
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(String(url)).toContain("exp.host");
      const body = JSON.parse(String(init?.body));
      expect(body).toHaveLength(1);
      expect(body[0].to).toBe(TOKEN_A);
      expect(body[0].title).toBe("Test");
      expect(body[0].data).toEqual({
        url: "/accounts",
        type: SOCIAL_CONNECTION_FAILED,
      });
      expect(body[0].badge).toBe(2);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("does not send when the owner's push preference is off", async () => {
    const tenant = await createTenant();
    try {
      await db.insert(pushTokensTable).values({
        clerkUserId: tenant.clerkUserId,
        token: TOKEN_A,
        platform: "ios",
      });

      actAs(tenant.clerkUserId);
      const put = await request(app)
        .put("/api/notification-settings")
        .send({
          preferences: [
            {
              type: SOCIAL_CONNECTION_FAILED,
              inApp: true,
              email: true,
              push: false,
            },
          ],
        });
      expect(put.status).toBe(200);

      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(JSON.stringify({ data: [] }), { status: 200 }),
        );

      await sendTenantPush(tenant.tenantId, SOCIAL_CONNECTION_FAILED, {
        title: "Test",
        message: "Should not send",
      });

      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("deletes tokens Expo reports as DeviceNotRegistered", async () => {
    const tenant = await createTenant();
    try {
      await db.insert(pushTokensTable).values({
        clerkUserId: tenant.clerkUserId,
        token: TOKEN_B,
        platform: "android",
      });

      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [
              {
                status: "error",
                details: { error: "DeviceNotRegistered" },
              },
            ],
          }),
          { status: 200 },
        ),
      );

      await sendTenantPush(tenant.tenantId, SOCIAL_CONNECTION_FAILED, {
        title: "Test",
        message: "Dead device",
      });

      const rows = await db
        .select()
        .from(pushTokensTable)
        .where(eq(pushTokensTable.token, TOKEN_B));
      expect(rows).toHaveLength(0);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("queues successful tickets for a delayed receipt check", async () => {
    const tenant = await createTenant();
    try {
      await db.insert(pushTokensTable).values({
        clerkUserId: tenant.clerkUserId,
        token: TOKEN_A,
        platform: "ios",
      });

      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({ data: [{ status: "ok", id: "ticket-1" }] }),
          { status: 200 },
        ),
      );

      await sendTenantPush(tenant.tenantId, SOCIAL_CONNECTION_FAILED, {
        title: "Test",
        message: "Queued for receipt",
      });

      const pending = await pendingReceiptsInDb();
      expect(pending).toHaveLength(1);
      expect(pending[0].ticketId).toBe("ticket-1");
      expect(pending[0].token).toBe(TOKEN_A);
      expect(pending[0].dueAt.getTime()).toBeGreaterThan(Date.now());
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("never throws even when the Expo API call fails", async () => {
    const tenant = await createTenant();
    try {
      await db.insert(pushTokensTable).values({
        clerkUserId: tenant.clerkUserId,
        token: TOKEN_A,
        platform: "ios",
      });
      vi.spyOn(globalThis, "fetch").mockRejectedValue(
        new Error("network down"),
      );

      await expect(
        sendTenantPush(tenant.tenantId, SOCIAL_CONNECTION_FAILED, {
          title: "Test",
          message: "Failure path",
        }),
      ).resolves.toBeUndefined();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});

describe("publish-outcome push payloads (tap deep-link contract)", () => {
  it("scheduled_post_published carries the content item id in the wire payload", async () => {
    const tenant = await createTenant();
    try {
      await db.insert(pushTokensTable).values({
        clerkUserId: tenant.clerkUserId,
        token: TOKEN_A,
        platform: "ios",
      });

      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(JSON.stringify({ data: [{ status: "ok" }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );

      await notifyScheduledPostPublished(
        tenant.tenantId,
        "My post",
        "facebook",
        123,
      );

      const pushCall = fetchSpy.mock.calls.find(([url]) =>
        String(url).includes("push/send"),
      );
      expect(pushCall).toBeTruthy();
      const body = JSON.parse(String(pushCall![1]?.body));
      expect(body[0].to).toBe(TOKEN_A);
      expect(body[0].data).toEqual({
        url: "/library?item=123",
        contentItemId: 123,
        type: SCHEDULED_POST_PUBLISHED,
      });
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("scheduled_publish_failed carries the content item id in the wire payload", async () => {
    const tenant = await createTenant();
    try {
      await db.insert(pushTokensTable).values({
        clerkUserId: tenant.clerkUserId,
        token: TOKEN_A,
        platform: "android",
      });

      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(JSON.stringify({ data: [{ status: "ok" }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );

      await notifyScheduledPublishFailed(
        tenant.tenantId,
        null,
        "My post",
        "instagram",
        "Token expired.",
        456,
      );

      const pushCall = fetchSpy.mock.calls.find(([url]) =>
        String(url).includes("push/send"),
      );
      expect(pushCall).toBeTruthy();
      const body = JSON.parse(String(pushCall![1]?.body));
      expect(body[0].to).toBe(TOKEN_A);
      expect(body[0].data).toEqual({
        url: "/library?item=456",
        contentItemId: 456,
        type: SCHEDULED_PUBLISH_FAILED,
      });
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("omits contentItemId from the wire payload when the id is absent", async () => {
    const tenant = await createTenant();
    try {
      await db.insert(pushTokensTable).values({
        clerkUserId: tenant.clerkUserId,
        token: TOKEN_A,
        platform: "ios",
      });

      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(JSON.stringify({ data: [{ status: "ok" }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );

      await notifyScheduledPostPublished(
        tenant.tenantId,
        "My post",
        "linkedin",
        null,
      );

      const pushCall = fetchSpy.mock.calls.find(([url]) =>
        String(url).includes("push/send"),
      );
      expect(pushCall).toBeTruthy();
      const body = JSON.parse(String(pushCall![1]?.body));
      expect(body[0].data).toEqual({
        url: "/library",
        type: SCHEDULED_POST_PUBLISHED,
      });
      expect(body[0].data).not.toHaveProperty("contentItemId");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});

describe("checkDuePushReceipts", () => {
  it("deletes tokens whose receipt reports DeviceNotRegistered", async () => {
    const tenant = await createTenant();
    try {
      await db.insert(pushTokensTable).values({
        clerkUserId: tenant.clerkUserId,
        token: TOKEN_A,
        platform: "ios",
      });

      const now = Date.now();
      await db.insert(pushReceiptQueueTable).values({
        ticketId: "ticket-dead",
        token: TOKEN_A,
        dueAt: new Date(now - 1000),
        createdAt: new Date(now - 2000),
      });

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            data: {
              "ticket-dead": {
                status: "error",
                details: { error: "DeviceNotRegistered" },
              },
            },
          }),
          { status: 200 },
        ),
      );

      await checkDuePushReceipts();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(String(fetchSpy.mock.calls[0][0])).toContain("getReceipts");
      const body = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));
      expect(body.ids).toEqual(["ticket-dead"]);

      const rows = await db
        .select()
        .from(pushTokensTable)
        .where(eq(pushTokensTable.token, TOKEN_A));
      expect(rows).toHaveLength(0);
      expect(await pendingReceiptsInDb()).toHaveLength(0);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("keeps tokens whose receipt is ok, and re-queues missing receipts", async () => {
    const tenant = await createTenant();
    try {
      await db.insert(pushTokensTable).values({
        clerkUserId: tenant.clerkUserId,
        token: TOKEN_A,
        platform: "ios",
      });

      const now = Date.now();
      await db.insert(pushReceiptQueueTable).values([
        {
          ticketId: "ticket-ok",
          token: TOKEN_A,
          dueAt: new Date(now - 1000),
          createdAt: new Date(now - 2000),
        },
        {
          ticketId: "ticket-missing",
          token: TOKEN_B,
          dueAt: new Date(now - 1000),
          createdAt: new Date(now - 2000),
        },
        {
          ticketId: "ticket-not-due",
          token: TOKEN_B,
          dueAt: new Date(now + 60_000),
          createdAt: new Date(now),
        },
      ]);

      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({ data: { "ticket-ok": { status: "ok" } } }),
          { status: 200 },
        ),
      );

      await checkDuePushReceipts();

      const rows = await db
        .select()
        .from(pushTokensTable)
        .where(eq(pushTokensTable.token, TOKEN_A));
      expect(rows).toHaveLength(1);

      const pendingIds = (await pendingReceiptsInDb())
        .map((p) => p.ticketId)
        .sort();
      expect(pendingIds).toEqual(["ticket-missing", "ticket-not-due"]);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("re-queues the batch when the receipt fetch fails, and drops expired entries", async () => {
    const now = Date.now();
    await db.insert(pushReceiptQueueTable).values([
      {
        ticketId: "ticket-retry",
        token: TOKEN_A,
        dueAt: new Date(now - 1000),
        createdAt: new Date(now - 2000),
      },
      {
        ticketId: "ticket-expired",
        token: TOKEN_B,
        dueAt: new Date(now - 1000),
        createdAt: new Date(now - 25 * 60 * 60 * 1000),
      },
    ]);

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

    await expect(checkDuePushReceipts()).resolves.toBeUndefined();

    const pendingIds = (await pendingReceiptsInDb()).map((p) => p.ticketId);
    expect(pendingIds).toEqual(["ticket-retry"]);
  });
});

describe("pruneUnseenPushTokens", () => {
  it("deletes tokens unseen beyond the window and keeps recent ones", async () => {
    const tenant = await createTenant();
    try {
      const stale = new Date(Date.now() - PUSH_TOKEN_MAX_UNSEEN_MS - 60_000);
      await db.insert(pushTokensTable).values([
        {
          clerkUserId: tenant.clerkUserId,
          token: TOKEN_A,
          platform: "ios",
          lastSeenAt: stale,
        },
        {
          clerkUserId: tenant.clerkUserId,
          token: TOKEN_B,
          platform: "android",
        },
      ]);

      await pruneUnseenPushTokens();

      const rows = await db
        .select()
        .from(pushTokensTable)
        .where(inArray(pushTokensTable.token, [TOKEN_A, TOKEN_B]));
      expect(rows).toHaveLength(1);
      expect(rows[0].token).toBe(TOKEN_B);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});

describe("push token registration refreshes lastSeenAt", () => {
  it("bumps lastSeenAt when an existing token re-registers", async () => {
    const tenant = await createTenant();
    try {
      const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      await db.insert(pushTokensTable).values({
        clerkUserId: tenant.clerkUserId,
        token: TOKEN_A,
        platform: "ios",
        lastSeenAt: past,
      });

      actAs(tenant.clerkUserId);
      const res = await request(app)
        .post("/api/push-tokens")
        .send({ token: TOKEN_A, platform: "ios" });
      expect(res.status).toBe(200);

      const rows = await db
        .select()
        .from(pushTokensTable)
        .where(eq(pushTokensTable.token, TOKEN_A));
      expect(rows).toHaveLength(1);
      expect(rows[0].lastSeenAt.getTime()).toBeGreaterThan(
        past.getTime() + 1000,
      );
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});
