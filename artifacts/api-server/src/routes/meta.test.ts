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

import { pool } from "@workspace/db";
import { createTestApp } from "../test/testApp";
import { resetAuthState, actAs } from "../test/authState";
import {
  createTenant,
  deleteTenant,
  insertConnectedAccount,
  insertContentItem,
} from "../test/dbHelpers";

const app = createTestApp();

beforeEach(() => {
  resetAuthState();
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
      expect(res.body.error).toMatch(/not connected or not verified/i);
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

      const res = await request(app).post(
        `/api/content/${itemId}/publish-facebook`,
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/not connected or not verified/i);
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
      // Prevent any real Graph API calls; force an error so the handler returns
      // 502 rather than actually posting.
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "mocked failure" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
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
