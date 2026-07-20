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

import { db, pool, pushTokensTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp } from "../test/testApp";
import { resetAuthState, actAs } from "../test/authState";
import { createTenant, deleteTenant } from "../test/dbHelpers";
import { sendTenantPush } from "../lib/push";
import { SOCIAL_CONNECTION_FAILED } from "../lib/notifications";

const app = createTestApp();

const TOKEN_A = "ExponentPushToken[test-push-a]";
const TOKEN_B = "ExponentPushToken[test-push-b]";

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  resetAuthState();
  await db
    .delete(pushTokensTable)
    .where(inArray(pushTokensTable.token, [TOKEN_A, TOKEN_B]));
});

afterEach(async () => {
  await db
    .delete(pushTokensTable)
    .where(inArray(pushTokensTable.token, [TOKEN_A, TOKEN_B]));
  vi.restoreAllMocks();
});

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
