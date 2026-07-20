import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
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

// Force the live Facebook credential test to report the token as revoked so the
// re-verify path transitions verified -> failed.
vi.mock("../lib/metaApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/metaApi")>();
  return {
    ...actual,
    testFacebookCredentials: vi.fn(async () => ({
      ok: false,
      transient: false,
      error: "Token expired",
    })),
  };
});

import { pool } from "@workspace/db";
import { createTestApp } from "../test/testApp";
import { resetAuthState, actAs } from "../test/authState";
import {
  createTenant,
  deleteTenant,
  insertConnectedAccount,
  getNotifications,
} from "../test/dbHelpers";
import { reverifyFacebook } from "../lib/socialReverify";

const app = createTestApp();

beforeEach(() => {
  resetAuthState();
});

afterAll(async () => {
  await pool.end();
});

describe("social connection failure notifications", () => {
  it("creates a notification when a verified connection flips to failed, and dedupes on re-check", async () => {
    const tenant = await createTenant();
    try {
      await insertConnectedAccount(
        tenant.tenantId,
        "facebook",
        { pageId: "PAGE_1", pageAccessToken: "tok" },
        "verified",
      );

      // First forced re-verify: token is reported revoked -> transition -> notify.
      await reverifyFacebook(tenant.tenantId, { force: true });
      let notes = await getNotifications(tenant.tenantId);
      expect(notes).toHaveLength(1);
      expect(notes[0].type).toBe("social_connection_failed");
      expect(notes[0].platform).toBe("facebook");
      expect(notes[0].linkUrl).toBe("/accounts");

      // Second forced re-verify: still failed (prior status already failed) and
      // an unread notification exists -> no duplicate.
      await reverifyFacebook(tenant.tenantId, { force: true });
      notes = await getNotifications(tenant.tenantId);
      expect(notes).toHaveLength(1);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("lists unread notifications and dismisses them via the API", async () => {
    const tenant = await createTenant();
    try {
      await insertConnectedAccount(
        tenant.tenantId,
        "facebook",
        { pageId: "PAGE_1", pageAccessToken: "tok" },
        "verified",
      );
      await reverifyFacebook(tenant.tenantId, { force: true });

      actAs(tenant.clerkUserId);

      const listRes = await request(app).get("/api/notifications");
      expect(listRes.status).toBe(200);
      expect(listRes.body).toHaveLength(1);
      const id = listRes.body[0].id as number;

      const readRes = await request(app).post(
        `/api/notifications/${id}/read`,
      );
      expect(readRes.status).toBe(204);

      const afterRes = await request(app).get("/api/notifications");
      expect(afterRes.status).toBe(200);
      expect(afterRes.body).toHaveLength(0);

      // The inbox view (?all=true) still includes the read notification,
      // with readAt populated so the client can render read/unread state.
      const inboxRes = await request(app).get("/api/notifications?all=true");
      expect(inboxRes.status).toBe(200);
      expect(inboxRes.body).toHaveLength(1);
      expect(inboxRes.body[0].id).toBe(id);
      expect(inboxRes.body[0].readAt).toEqual(expect.any(String));

      // Unread notifications carry readAt: null in the inbox view.
      const unreadInList = listRes.body[0];
      expect(unreadInList.readAt).toBeNull();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("marks all unread notifications read at once, scoped to the tenant", async () => {
    const tenant = await createTenant();
    const other = await createTenant();
    try {
      // Two unread notifications for the tenant (different platforms so dedupe
      // does not collapse them).
      for (const platform of ["facebook", "instagram"] as const) {
        await insertConnectedAccount(
          tenant.tenantId,
          "facebook",
          { pageId: `PAGE_${platform}`, pageAccessToken: "tok" },
          "verified",
        );
      }
      await reverifyFacebook(tenant.tenantId, { force: true });

      // One unread notification for the other tenant that must stay unread.
      await insertConnectedAccount(
        other.tenantId,
        "facebook",
        { pageId: "PAGE_OTHER", pageAccessToken: "tok" },
        "verified",
      );
      await reverifyFacebook(other.tenantId, { force: true });

      actAs(tenant.clerkUserId);

      const before = await request(app).get("/api/notifications");
      expect(before.status).toBe(200);
      expect(before.body.length).toBeGreaterThan(0);

      const res = await request(app).post("/api/notifications/read-all");
      expect(res.status).toBe(204);

      const after = await request(app).get("/api/notifications");
      expect(after.status).toBe(200);
      expect(after.body).toHaveLength(0);

      // Inbox view still shows them, now read.
      const inbox = await request(app).get("/api/notifications?all=true");
      expect(inbox.status).toBe(200);
      expect(inbox.body.length).toBe(before.body.length);
      for (const n of inbox.body) {
        expect(n.readAt).toEqual(expect.any(String));
      }

      // Other tenant's notification is untouched.
      actAs(other.clerkUserId);
      const otherList = await request(app).get("/api/notifications");
      expect(otherList.status).toBe(200);
      expect(otherList.body).toHaveLength(1);
      expect(otherList.body[0].readAt).toBeNull();
    } finally {
      await deleteTenant(tenant.tenantId);
      await deleteTenant(other.tenantId);
    }
  });

  it("does not leak another tenant's notifications", async () => {
    const owner = await createTenant();
    const attacker = await createTenant();
    try {
      await insertConnectedAccount(
        owner.tenantId,
        "facebook",
        { pageId: "PAGE_1", pageAccessToken: "tok" },
        "verified",
      );
      await reverifyFacebook(owner.tenantId, { force: true });

      const [ownerNote] = await getNotifications(owner.tenantId);

      actAs(attacker.clerkUserId);
      const listRes = await request(app).get("/api/notifications");
      expect(listRes.status).toBe(200);
      expect(listRes.body).toHaveLength(0);

      // Attacker cannot dismiss the owner's notification.
      const readRes = await request(app).post(
        `/api/notifications/${ownerNote.id}/read`,
      );
      expect(readRes.status).toBe(404);
    } finally {
      await deleteTenant(owner.tenantId);
      await deleteTenant(attacker.tenantId);
    }
  });
});
