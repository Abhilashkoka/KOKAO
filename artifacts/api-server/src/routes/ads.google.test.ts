import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
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

// Stub only the Google Ads network functions; DB-backed engine logic stays real.
vi.mock("../lib/googleAdsApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/googleAdsApi")>();
  return {
    ...actual,
    getGoogleAdsAuth: vi.fn(),
    readGoogleCampaignState: vi.fn(),
    updateGoogleCampaign: vi.fn(),
    createGoogleCampaign: vi.fn(),
    readGoogleAdGroupState: vi.fn(),
    updateGoogleAdGroup: vi.fn(),
    readGoogleAdState: vi.fn(),
    updateGoogleAd: vi.fn(),
    listCustomerChoices: vi.fn(),
    readCustomer: vi.fn(),
    isGoogleAdsConfigured: vi.fn(),
  };
});

import {
  db,
  pool,
  adAccountConnectionsTable,
  notificationsTable,
  adChangeRequestsTable,
  adsChangeLogsTable,
  adsSettingsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  getGoogleAdsAuth,
  readGoogleCampaignState,
  updateGoogleCampaign,
  createGoogleCampaign,
  readGoogleAdGroupState,
  updateGoogleAdGroup,
  readGoogleAdState,
  updateGoogleAd,
  listCustomerChoices,
  readCustomer,
  isGoogleAdsConfigured,
  GoogleAdsApiError,
} from "../lib/googleAdsApi";
import { encryptJson, decryptJson } from "../lib/secretCrypto";
import { requireTenant } from "../middlewares/requireTenant";
import adsRouter from "./ads";
import { resetAuthState, actAs } from "../test/authState";
import { createTenant, deleteTenant } from "../test/dbHelpers";

const mockAuth = vi.mocked(getGoogleAdsAuth);
const mockRead = vi.mocked(readGoogleCampaignState);
const mockUpdate = vi.mocked(updateGoogleCampaign);
const mockCreate = vi.mocked(createGoogleCampaign);
const mockReadAdGroup = vi.mocked(readGoogleAdGroupState);
const mockUpdateAdGroup = vi.mocked(updateGoogleAdGroup);
const mockReadAd = vi.mocked(readGoogleAdState);
const mockUpdateAd = vi.mocked(updateGoogleAd);
const mockChoices = vi.mocked(listCustomerChoices);
const mockReadCustomer = vi.mocked(readCustomer);
const mockConfigured = vi.mocked(isGoogleAdsConfigured);

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
  app.use("/api", requireTenant, adsRouter);
  return app;
}

const app = createAdsTestApp();

const AUTH = {
  accessToken: "google-access",
  developerToken: "dev-token",
  loginCustomerId: null as string | null,
};

const REMOTE_STATE = {
  name: "Search Push",
  status: "PAUSED",
  dailyBudget: 5000,
  lifetimeBudget: null,
  startTime: null,
  stopTime: null,
};

async function insertGoogleAdConnection(
  tenantId: number,
  overrides: Partial<typeof adAccountConnectionsTable.$inferInsert> = {},
): Promise<number> {
  const [row] = await db
    .insert(adAccountConnectionsTable)
    .values({
      tenantId,
      platform: "google",
      status: "connected",
      adAccountId: "1234567890",
      adAccountName: "Test Google Ads",
      currency: "INR",
      verifyStatus: "verified",
      encryptedCredentials: encryptJson({
        refreshToken: "google-refresh",
        loginCustomerId: null,
      }),
      ...overrides,
    })
    .returning({ id: adAccountConnectionsTable.id });
  return row!.id;
}

async function createUpdateDraft(
  ownerClerkUserId: string,
  connectionId: number,
  overrides: Record<string, unknown> = {},
) {
  actAs(ownerClerkUserId);
  return request(app)
    .post("/api/ads/drafts")
    .send({
      connectionId,
      targetType: "campaign",
      action: "update",
      targetId: "camp_g1",
      status: "ACTIVE",
      dailyBudget: 7000,
      ...overrides,
    });
}

beforeEach(async () => {
  resetAuthState();
  mockAuth.mockReset();
  mockRead.mockReset();
  mockUpdate.mockReset();
  mockCreate.mockReset();
  mockReadAdGroup.mockReset();
  mockUpdateAdGroup.mockReset();
  mockReadAd.mockReset();
  mockUpdateAd.mockReset();
  mockUpdateAdGroup.mockResolvedValue(undefined as never);
  mockUpdateAd.mockResolvedValue(undefined as never);
  mockChoices.mockReset();
  mockReadCustomer.mockReset();
  mockConfigured.mockReset();
  mockConfigured.mockResolvedValue(true);
  mockAuth.mockResolvedValue({ ...AUTH } as never);
  mockRead.mockResolvedValue({ ...REMOTE_STATE });
  mockUpdate.mockResolvedValue(undefined as never);
  mockCreate.mockResolvedValue("camp_g_new_1");
  await db.delete(adsSettingsTable);
});

afterAll(async () => {
  await db.delete(adsSettingsTable);
  await pool.end();
});

describe("google ads status", () => {
  it("reports the google platform availability from configured credentials", async () => {
    const tenant = await createTenant();
    try {
      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/ads/status");
      expect(res.status).toBe(200);
      const google = (
        res.body.platforms as { platform: string; available: boolean }[]
      ).find((p) => p.platform === "google");
      expect(google).toBeDefined();
      expect(google!.available).toBe(true);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});

describe("google customer selection", () => {
  it("lists non-manager choices and persists the selection with loginCustomerId", async () => {
    const tenant = await createTenant();
    try {
      await insertGoogleAdConnection(tenant.tenantId, {
        status: "pending_selection",
        adAccountId: "",
        adAccountName: "",
        verifyStatus: "untested",
      });
      mockChoices.mockResolvedValue([
        {
          customerId: "1112223334",
          name: "Client Account",
          currency: "INR",
          manager: false,
          loginCustomerId: "9998887776",
        },
        {
          customerId: "9998887776",
          name: "MCC",
          currency: "INR",
          manager: true,
          loginCustomerId: null,
        },
      ]);
      mockReadCustomer.mockResolvedValue({
        customerId: "1112223334",
        name: "Client Account",
        currency: "INR",
        manager: false,
      } as never);

      actAs(tenant.clerkUserId);
      const list = await request(app).get("/api/ads/connections/google/accounts");
      expect(list.status).toBe(200);
      expect(list.body.length).toBe(2);

      const sel = await request(app)
        .post("/api/ads/connections/google/select")
        .send({ customerId: "1112223334", loginCustomerId: "9998887776" });
      expect(sel.status).toBe(200);
      expect(sel.body.status).toBe("connected");
      expect(sel.body.adAccountId).toBe("1112223334");

      const [row] = await db
        .select()
        .from(adAccountConnectionsTable)
        .where(eq(adAccountConnectionsTable.tenantId, tenant.tenantId));
      expect(row!.status).toBe("connected");
      const creds = decryptJson<{ loginCustomerId: string | null }>(
        row!.encryptedCredentials!,
      );
      expect(creds.loginCustomerId).toBe("9998887776");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});

describe("google draft creation and apply", () => {
  it("captures a diff, applies, and verifies through the google adapter", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertGoogleAdConnection(tenant.tenantId);
      const draftRes = await createUpdateDraft(tenant.clerkUserId, connectionId);
      expect(draftRes.status).toBe(201);
      expect(draftRes.body.status).toBe("draft");
      const draftId = draftRes.body.id as number;

      mockRead.mockResolvedValueOnce({ ...REMOTE_STATE }); // drift check
      mockRead.mockResolvedValue({
        ...REMOTE_STATE,
        status: "ACTIVE",
        dailyBudget: 7000,
      });

      actAs(tenant.clerkUserId);
      const res = await request(app).post(`/api/ads/drafts/${draftId}/approve`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("applied");
      expect(res.body.verifyStatus).toBe("verified");
      expect(mockUpdate).toHaveBeenCalledTimes(1);

      const logs = await db
        .select()
        .from(adsChangeLogsTable)
        .where(eq(adsChangeLogsTable.tenantId, tenant.tenantId));
      expect(logs.length).toBe(1);
      expect(logs[0]!.outcome).toBe("applied");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("rejects lifetime budgets for google drafts with a 400", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertGoogleAdConnection(tenant.tenantId);
      const res = await createUpdateDraft(tenant.clerkUserId, connectionId, {
        dailyBudget: undefined,
        lifetimeBudget: 90000,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/lifetime/i);
      const rows = await db
        .select()
        .from(adChangeRequestsTable)
        .where(eq(adChangeRequestsTable.tenantId, tenant.tenantId));
      expect(rows.length).toBe(0);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("creates and applies a new google campaign draft end to end", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertGoogleAdConnection(tenant.tenantId);
      actAs(tenant.clerkUserId);
      const draftRes = await request(app).post("/api/ads/drafts").send({
        connectionId,
        targetType: "campaign",
        action: "create",
        name: "Google Launch",
        objective: "SEARCH",
        dailyBudget: 10000,
      });
      expect(draftRes.status).toBe(201);

      mockRead.mockResolvedValue({
        name: "Google Launch",
        status: "PAUSED",
        dailyBudget: 10000,
        lifetimeBudget: null,
        startTime: null,
        stopTime: null,
      });
      const res = await request(app).post(
        `/api/ads/drafts/${draftRes.body.id}/approve`,
      );
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("applied");
      expect(res.body.resultTargetId).toBe("camp_g_new_1");
      expect(res.body.verifyStatus).toBe("verified");
      expect(mockCreate).toHaveBeenCalledTimes(1);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("expires a google draft when the remote campaign drifted", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertGoogleAdConnection(tenant.tenantId);
      const draftRes = await createUpdateDraft(tenant.clerkUserId, connectionId);
      const draftId = draftRes.body.id as number;

      mockRead.mockResolvedValue({ ...REMOTE_STATE, name: "Renamed Elsewhere" });

      actAs(tenant.clerkUserId);
      const res = await request(app).post(`/api/ads/drafts/${draftId}/approve`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("expired");
      expect(mockUpdate).not.toHaveBeenCalled();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("drafts, applies, and verifies a google ad group status + CPC bid change", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertGoogleAdConnection(tenant.tenantId);
      const before = {
        name: "Ad Group A",
        status: "ACTIVE",
        dailyBudget: 1500,
        lifetimeBudget: null,
        startTime: null,
        stopTime: null,
      };
      mockReadAdGroup.mockResolvedValueOnce({ ...before }); // draft diff
      const draftRes = await createUpdateDraft(tenant.clerkUserId, connectionId, {
        targetType: "adset",
        targetId: "ag_1",
        status: "PAUSED",
        dailyBudget: 2000,
      });
      expect(draftRes.status).toBe(201);
      expect(draftRes.body.targetType).toBe("adset");

      mockReadAdGroup.mockResolvedValueOnce({ ...before }); // drift check
      mockReadAdGroup.mockResolvedValue({
        ...before,
        status: "PAUSED",
        dailyBudget: 2000,
      }); // verify read-back

      actAs(tenant.clerkUserId);
      const res = await request(app).post(
        `/api/ads/drafts/${draftRes.body.id}/approve`,
      );
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("applied");
      expect(res.body.verifyStatus).toBe("verified");
      expect(mockUpdateAdGroup).toHaveBeenCalledWith(expect.anything(), "ag_1", {
        name: undefined,
        status: "PAUSED",
        dailyBudget: 2000,
      });
      expect(mockUpdate).not.toHaveBeenCalled();

      const logs = await db
        .select()
        .from(adsChangeLogsTable)
        .where(eq(adsChangeLogsTable.tenantId, tenant.tenantId));
      expect(logs.length).toBe(1);
      expect(logs[0]!.targetType).toBe("adset");
      expect(logs[0]!.outcome).toBe("applied");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("drafts and applies a google ad pause", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertGoogleAdConnection(tenant.tenantId);
      const before = {
        name: "Ad 77",
        status: "ACTIVE",
        dailyBudget: null,
        lifetimeBudget: null,
        startTime: null,
        stopTime: null,
      };
      mockReadAd.mockResolvedValueOnce({ ...before });
      const draftRes = await createUpdateDraft(tenant.clerkUserId, connectionId, {
        targetType: "ad",
        targetId: "ad_77",
        status: "PAUSED",
        dailyBudget: undefined,
      });
      expect(draftRes.status).toBe(201);

      mockReadAd.mockResolvedValueOnce({ ...before }); // drift check
      mockReadAd.mockResolvedValue({ ...before, status: "PAUSED" });

      actAs(tenant.clerkUserId);
      const res = await request(app).post(
        `/api/ads/drafts/${draftRes.body.id}/approve`,
      );
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("applied");
      expect(res.body.verifyStatus).toBe("verified");
      expect(mockUpdateAd).toHaveBeenCalledWith(expect.anything(), "ad_77", {
        status: "PAUSED",
      });
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("rejects archiving a google ad with a 400", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertGoogleAdConnection(tenant.tenantId);
      const res = await createUpdateDraft(tenant.clerkUserId, connectionId, {
        targetType: "ad",
        targetId: "ad_77",
        status: "ARCHIVED",
        dailyBudget: undefined,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/archiv/i);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("rejects renaming a google ad with a 400", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertGoogleAdConnection(tenant.tenantId);
      const res = await createUpdateDraft(tenant.clerkUserId, connectionId, {
        targetType: "ad",
        targetId: "ad_77",
        name: "New Ad Name",
        status: "PAUSED",
        dailyBudget: undefined,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/renam/i);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("rejects a lifetime budget on a google ad group draft", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertGoogleAdConnection(tenant.tenantId);
      const res = await createUpdateDraft(tenant.clerkUserId, connectionId, {
        targetType: "adset",
        targetId: "ag_1",
        dailyBudget: undefined,
        lifetimeBudget: 90000,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/lifetime/i);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("expires a google ad group draft when the remote ad group drifted", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertGoogleAdConnection(tenant.tenantId);
      const before = {
        name: "Ad Group A",
        status: "ACTIVE",
        dailyBudget: 1500,
        lifetimeBudget: null,
        startTime: null,
        stopTime: null,
      };
      mockReadAdGroup.mockResolvedValueOnce({ ...before });
      const draftRes = await createUpdateDraft(tenant.clerkUserId, connectionId, {
        targetType: "adset",
        targetId: "ag_1",
        status: "PAUSED",
        dailyBudget: undefined,
      });
      expect(draftRes.status).toBe(201);

      mockReadAdGroup.mockResolvedValue({ ...before, dailyBudget: 9999 });

      actAs(tenant.clerkUserId);
      const res = await request(app).post(
        `/api/ads/drafts/${draftRes.body.id}/approve`,
      );
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("expired");
      expect(mockUpdateAdGroup).not.toHaveBeenCalled();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("marks the connection for reconnect when google auth fails during draft creation", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertGoogleAdConnection(tenant.tenantId);
      mockRead.mockRejectedValue(
        new GoogleAdsApiError("invalid_grant: token revoked", 401, true),
      );
      const res = await createUpdateDraft(tenant.clerkUserId, connectionId);
      expect(res.status).toBe(502);

      const [row] = await db
        .select()
        .from(adAccountConnectionsTable)
        .where(eq(adAccountConnectionsTable.id, connectionId));
      expect(row!.verifyStatus).toBe("failed");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});

describe("google reconnect restores a failed connection", () => {
  it("flips a failed connection back to verified via select and resolves the lingering notification", async () => {
    const tenant = await createTenant();
    try {
      // A previously broken grant: reverify flipped it to failed and left an
      // unread "ad account disconnected" notification behind. The OAuth
      // reconnect callback has since stored a fresh refresh token.
      const connectionId = await insertGoogleAdConnection(tenant.tenantId, {
        verifyStatus: "failed",
        verifyError: "invalid_grant: refresh token revoked",
        encryptedCredentials: encryptJson({
          refreshToken: "google-refresh-fresh",
          loginCustomerId: null,
        }),
      });
      await db.insert(notificationsTable).values({
        tenantId: tenant.tenantId,
        type: "ads_connection_failed",
        platform: "google",
        title: "Google Ads account disconnected",
        message: "Your Google Ads connection is no longer valid.",
        linkUrl: "/ads",
      });

      mockChoices.mockResolvedValue([
        {
          customerId: "1234567890",
          name: "Test Google Ads",
          currency: "INR",
          manager: false,
          loginCustomerId: "5556667778",
        },
      ]);
      mockReadCustomer.mockResolvedValue({
        customerId: "1234567890",
        name: "Test Google Ads",
        currency: "INR",
        manager: false,
      } as never);

      actAs(tenant.clerkUserId);
      const list = await request(app).get("/api/ads/connections/google/accounts");
      expect(list.status).toBe(200);
      expect(list.body.length).toBe(1);

      const sel = await request(app)
        .post("/api/ads/connections/google/select")
        .send({ customerId: "1234567890", loginCustomerId: "5556667778" });
      expect(sel.status).toBe(200);
      expect(sel.body.status).toBe("connected");
      expect(sel.body.verifyStatus).toBe("verified");

      const [row] = await db
        .select()
        .from(adAccountConnectionsTable)
        .where(eq(adAccountConnectionsTable.id, connectionId));
      expect(row!.verifyStatus).toBe("verified");
      expect(row!.verifyError).toBeNull();
      const creds = decryptJson<{
        refreshToken: string;
        loginCustomerId: string | null;
      }>(row!.encryptedCredentials!);
      expect(creds.refreshToken).toBe("google-refresh-fresh");
      expect(creds.loginCustomerId).toBe("5556667778");

      // The lingering disconnected notification is auto-resolved (marked read).
      const notifications = await db
        .select()
        .from(notificationsTable)
        .where(eq(notificationsTable.tenantId, tenant.tenantId));
      const lingering = notifications.filter(
        (n) => n.type === "ads_connection_failed" && n.readAt == null,
      );
      expect(lingering.length).toBe(0);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});

describe("GET /ads/connections auto re-verify (google)", () => {
  it("flips a stale google connection with a revoked refresh token to failed on page load", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertGoogleAdConnection(tenant.tenantId); // verifiedAt null => stale
      mockAuth.mockRejectedValue(
        new GoogleAdsApiError("invalid_grant: refresh token revoked", 401, true),
      );
      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/ads/connections");
      expect(res.status).toBe(200);
      const google = res.body.find(
        (c: { platform: string }) => c.platform === "google",
      );
      expect(google.verifyStatus).toBe("failed");
      expect(mockAuth).toHaveBeenCalledTimes(1);

      const [row] = await db
        .select()
        .from(adAccountConnectionsTable)
        .where(eq(adAccountConnectionsTable.id, connectionId));
      expect(row!.verifyStatus).toBe("failed");
      expect(row!.verifyError).toContain("invalid_grant");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("skips the re-check when the google connection was verified recently", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertGoogleAdConnection(tenant.tenantId);
      await db
        .update(adAccountConnectionsTable)
        .set({ verifiedAt: new Date() })
        .where(eq(adAccountConnectionsTable.id, connectionId));
      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/ads/connections");
      expect(res.status).toBe(200);
      expect(mockAuth).not.toHaveBeenCalled();
      expect(mockReadCustomer).not.toHaveBeenCalled();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("keeps a verified google status when the re-check fails transiently", async () => {
    const tenant = await createTenant();
    try {
      await insertGoogleAdConnection(tenant.tenantId);
      mockReadCustomer.mockRejectedValue(
        new GoogleAdsApiError("Google Ads is down", 500, false),
      );
      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/ads/connections");
      expect(res.status).toBe(200);
      const google = res.body.find(
        (c: { platform: string }) => c.platform === "google",
      );
      expect(google.verifyStatus).toBe("verified");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});
