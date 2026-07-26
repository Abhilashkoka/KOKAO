import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";

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

// The OAuth callback's token exchange goes through platformFetch directly.
vi.mock("../lib/platformFetch", () => ({
  platformFetch: vi.fn(),
}));

// Stub only the Graph network functions; DB-backed logic stays real.
vi.mock("../lib/metaAdsApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/metaAdsApi")>();
  return {
    ...actual,
    readAdAccount: vi.fn(),
    listAdAccounts: vi.fn(),
  };
});

import {
  db,
  pool,
  adAccountConnectionsTable,
  notificationsTable,
} from "@workspace/db";
import { eq, and, isNull } from "drizzle-orm";
import { platformFetch } from "../lib/platformFetch";
import {
  readAdAccount,
  listAdAccounts,
  MetaAdsApiError,
} from "../lib/metaAdsApi";
import { encryptJson } from "../lib/secretCrypto";
import { requireTenant } from "../middlewares/requireTenant";
import adsRouter, { adsCallbackRouter } from "./ads";
import { signOAuthState } from "../lib/oauthState";
import { resetAuthState, actAs } from "../test/authState";
import { createTenant, deleteTenant } from "../test/dbHelpers";

const mockPlatformFetch = vi.mocked(platformFetch);
const mockReadAdAccount = vi.mocked(readAdAccount);
const mockListAdAccounts = vi.mocked(listAdAccounts);

function createAdsTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, () => void> }).log = {
      info() {},
      error() {},
      warn() {},
      debug() {},
    };
    next();
  });
  app.use("/api", adsCallbackRouter);
  app.use("/api", requireTenant, adsRouter);
  return app;
}

const app = createAdsTestApp();

function mockTokenExchange() {
  mockPlatformFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ access_token: "meta-fresh-token" }),
  } as never);
}

beforeEach(() => {
  resetAuthState();
  vi.clearAllMocks();
});

afterAll(async () => {
  await pool.end();
});

describe("meta reconnect fail-soft keeps the disconnected alert until re-pick", () => {
  it("callback lands on the picker without resolving the notification; select resolves it", async () => {
    const tenant = await createTenant();
    try {
      // A broken grant on an ad account that no longer exists in the fresh
      // grant: reverify flipped it to failed and left an unread
      // "Meta ad account disconnected" notification behind.
      const [conn] = await db
        .insert(adAccountConnectionsTable)
        .values({
          tenantId: tenant.tenantId,
          platform: "meta",
          status: "connected",
          adAccountId: "act_999999",
          adAccountName: "Old Dead Account",
          currency: "USD",
          verifyStatus: "failed",
          verifyError: "Access token revoked",
          encryptedCredentials: encryptJson({ accessToken: "meta-dead-token" }),
        })
        .returning({ id: adAccountConnectionsTable.id });
      const connectionId = conn!.id;
      const [notif] = await db
        .insert(notificationsTable)
        .values({
          tenantId: tenant.tenantId,
          type: "ads_connection_failed",
          platform: "meta",
          title: "Meta ad account disconnected",
          message: "Your Meta Ads connection is no longer valid.",
          linkUrl: "/ads",
        })
        .returning({ id: notificationsTable.id });

      // Fresh OAuth grant, but the previously selected account is gone:
      // the single-object read 404s, so the fast path fails soft.
      mockTokenExchange();
      mockReadAdAccount.mockRejectedValueOnce(
        new MetaAdsApiError("Unsupported get request (act_999999)", 404),
      );

      const state = signOAuthState(tenant.tenantId, "nonce");
      const res = await request(app).get(
        `/api/ads/meta/auth/callback?code=code123&state=${state}`,
      );
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain("meta=connected");

      // Fail-soft: row is pending selection (picker shown), NOT verified.
      const [pending] = await db
        .select()
        .from(adAccountConnectionsTable)
        .where(eq(adAccountConnectionsTable.id, connectionId));
      expect(pending!.status).toBe("pending_selection");
      expect(pending!.adAccountId).toBe("");
      expect(pending!.verifyStatus).toBeNull();
      expect(mockReadAdAccount).toHaveBeenCalledWith(
        "meta-fresh-token",
        "act_999999",
      );

      // Crucially, the disconnected notification is STILL unread — this path
      // does not auto-verify, so the banner must persist until re-pick.
      const [stillUnread] = await db
        .select()
        .from(notificationsTable)
        .where(eq(notificationsTable.id, notif!.id));
      expect(stillUnread!.readAt).toBeNull();

      // The tenant re-picks a live account from the picker.
      actAs(tenant.clerkUserId);
      mockListAdAccounts.mockResolvedValue([
        {
          adAccountId: "act_777001",
          name: "KOKAO Test Ad Account",
          currency: "USD",
          accountStatus: "1",
        },
      ]);
      const accounts = await request(app).get(
        "/api/ads/connections/meta/accounts",
      );
      expect(accounts.status).toBe(200);
      expect(accounts.body[0].adAccountId).toBe("act_777001");

      mockReadAdAccount.mockResolvedValueOnce({
        name: "KOKAO Test Ad Account",
        currency: "USD",
      });
      const sel = await request(app)
        .post("/api/ads/connections/meta/select")
        .send({ adAccountId: "act_777001" });
      expect(sel.status).toBe(200);
      expect(sel.body.status).toBe("connected");
      expect(sel.body.verifyStatus).toBe("verified");

      const [row] = await db
        .select()
        .from(adAccountConnectionsTable)
        .where(eq(adAccountConnectionsTable.id, connectionId));
      expect(row!.adAccountId).toBe("act_777001");
      expect(row!.verifyStatus).toBe("verified");

      // The select route resolved the lingering notification (read_at set).
      const [resolved] = await db
        .select()
        .from(notificationsTable)
        .where(eq(notificationsTable.id, notif!.id));
      expect(resolved!.readAt).not.toBeNull();

      // No other unread meta ads_connection_failed rows linger for the tenant.
      const lingering = await db
        .select()
        .from(notificationsTable)
        .where(
          and(
            eq(notificationsTable.tenantId, tenant.tenantId),
            eq(notificationsTable.type, "ads_connection_failed"),
            isNull(notificationsTable.readAt),
          ),
        );
      expect(lingering.length).toBe(0);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});
