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

// Stub only the TikTok network functions; DB-backed engine logic stays real.
vi.mock("../lib/tiktokAdsApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/tiktokAdsApi")>();
  return {
    ...actual,
    readCampaignState: vi.fn(),
    readAdGroupState: vi.fn(),
    readAdState: vi.fn(),
    updateCampaign: vi.fn(),
    updateAdGroup: vi.fn(),
    updateAd: vi.fn(),
    createCampaign: vi.fn(),
    listAdvertisers: vi.fn(),
    readAdvertiser: vi.fn(),
    listCampaigns: vi.fn(),
    getInsightsByLevel: vi.fn(),
  };
});

import {
  db,
  pool,
  adAccountConnectionsTable,
  adChangeRequestsTable,
  adsChangeLogsTable,
  adsSettingsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  readCampaignState,
  readAdGroupState,
  readAdState,
  updateCampaign,
  updateAdGroup,
  updateAd,
  createCampaign,
  listAdvertisers,
  readAdvertiser,
  listCampaigns,
  getInsightsByLevel,
  TiktokAdsApiError,
} from "../lib/tiktokAdsApi";
import { encryptJson } from "../lib/secretCrypto";
import { requireTenant } from "../middlewares/requireTenant";
import adsRouter from "./ads";
import { resetAuthState, actAs } from "../test/authState";
import { createTenant, deleteTenant } from "../test/dbHelpers";

const mockRead = vi.mocked(readCampaignState);
const mockReadAdGroup = vi.mocked(readAdGroupState);
const mockReadAd = vi.mocked(readAdState);
const mockUpdate = vi.mocked(updateCampaign);
const mockUpdateAdGroup = vi.mocked(updateAdGroup);
const mockUpdateAd = vi.mocked(updateAd);
const mockCreate = vi.mocked(createCampaign);
const mockListAdvertisers = vi.mocked(listAdvertisers);
const mockReadAdvertiser = vi.mocked(readAdvertiser);
const mockListCampaigns = vi.mocked(listCampaigns);
const mockInsightsByLevel = vi.mocked(getInsightsByLevel);

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

const REMOTE_STATE = {
  name: "Spring Push",
  status: "PAUSED",
  dailyBudget: 5000,
  lifetimeBudget: null,
  startTime: null,
  stopTime: null,
};

const ADGROUP_STATE = {
  name: "Prospecting AG",
  status: "PAUSED",
  dailyBudget: 3000,
  lifetimeBudget: null,
  startTime: null,
  stopTime: null,
};

const AD_STATE = {
  name: "Video Ad A",
  status: "ACTIVE",
  dailyBudget: null,
  lifetimeBudget: null,
  startTime: null,
  stopTime: null,
};

async function insertTiktokConnection(
  tenantId: number,
  overrides: Partial<typeof adAccountConnectionsTable.$inferInsert> = {},
): Promise<number> {
  const [row] = await db
    .insert(adAccountConnectionsTable)
    .values({
      tenantId,
      platform: "tiktok",
      status: "connected",
      adAccountId: "adv_123",
      adAccountName: "Test Advertiser",
      currency: "INR",
      verifyStatus: "verified",
      encryptedCredentials: encryptJson({
        accessToken: "tiktok-token",
        advertiserIds: ["adv_123", "adv_456"],
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
      targetId: "tt_camp_1",
      status: "ACTIVE",
      dailyBudget: 7000,
      ...overrides,
    });
}

beforeEach(async () => {
  resetAuthState();
  mockRead.mockReset();
  mockUpdate.mockReset();
  mockCreate.mockReset();
  mockListAdvertisers.mockReset();
  mockReadAdvertiser.mockReset();
  mockReadAdGroup.mockReset();
  mockReadAd.mockReset();
  mockUpdateAdGroup.mockReset();
  mockUpdateAd.mockReset();
  mockRead.mockResolvedValue({ ...REMOTE_STATE });
  mockReadAdGroup.mockResolvedValue({ ...ADGROUP_STATE });
  mockReadAd.mockResolvedValue({ ...AD_STATE });
  mockUpdate.mockResolvedValue(undefined as never);
  mockUpdateAdGroup.mockResolvedValue(undefined as never);
  mockUpdateAd.mockResolvedValue(undefined as never);
  mockCreate.mockResolvedValue("tt_camp_new_1");
  mockListCampaigns.mockReset();
  mockInsightsByLevel.mockReset();
  mockInsightsByLevel.mockResolvedValue(new Map());
  await db.delete(adsSettingsTable);
});

afterAll(async () => {
  await db.delete(adsSettingsTable);
  await pool.end();
});

describe("tiktok draft rules", () => {
  it("captures a before/after diff for a campaign update", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertTiktokConnection(tenant.tenantId);
      const res = await createUpdateDraft(tenant.clerkUserId, connectionId);
      expect(res.status).toBe(201);
      expect(res.body.status).toBe("draft");
      expect(res.body.changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "Status", before: "PAUSED", after: "ACTIVE" }),
          expect.objectContaining({
            field: "Daily budget (minor units)",
            before: "5000",
            after: "7000",
          }),
        ]),
      );
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("rejects schedule fields for TikTok campaigns", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertTiktokConnection(tenant.tenantId);
      const res = await createUpdateDraft(tenant.clerkUserId, connectionId, {
        startTime: "2026-08-01T00:00:00+0000",
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/schedule/i);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("captures a before/after diff for a TikTok ad group update", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertTiktokConnection(tenant.tenantId);
      const res = await createUpdateDraft(tenant.clerkUserId, connectionId, {
        targetType: "adset",
        targetId: "ag_1",
        status: "ACTIVE",
        name: "Prospecting AG v2",
        dailyBudget: undefined,
      });
      expect(res.status).toBe(201);
      expect(res.body.targetType).toBe("adset");
      expect(res.body.changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "Status", before: "PAUSED", after: "ACTIVE" }),
          expect.objectContaining({
            field: "Name",
            before: "Prospecting AG",
            after: "Prospecting AG v2",
          }),
        ]),
      );
      expect(mockReadAdGroup).toHaveBeenCalledWith("tiktok-token", "adv_123", "ag_1");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("accepts a budget change draft on a TikTok ad group with a diff", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertTiktokConnection(tenant.tenantId);
      const res = await createUpdateDraft(tenant.clerkUserId, connectionId, {
        targetType: "adset",
        targetId: "ag_1",
        status: undefined,
        dailyBudget: 9000,
      });
      expect(res.status).toBe(201);
      expect(res.body.changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "Daily budget (minor units)",
            before: "3000",
            after: "9000",
          }),
        ]),
      );
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("still rejects budget changes on TikTok ads", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertTiktokConnection(tenant.tenantId);
      const res = await createUpdateDraft(tenant.clerkUserId, connectionId, {
        targetType: "ad",
        targetId: "ad_9",
        dailyBudget: 9000,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/name and status/i);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("rejects schedule fields on TikTok ad groups", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertTiktokConnection(tenant.tenantId);
      const res = await createUpdateDraft(tenant.clerkUserId, connectionId, {
        targetType: "adset",
        targetId: "ag_1",
        dailyBudget: undefined,
        startTime: "2026-08-01T00:00:00+0000",
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/schedule/i);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});

describe("tiktok approve → apply → verify", () => {
  it("applies an update end to end and records a change log entry", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertTiktokConnection(tenant.tenantId);
      const draftRes = await createUpdateDraft(tenant.clerkUserId, connectionId);
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
      // The engine passes the connection's advertiser id to the adapter.
      expect(mockUpdate.mock.calls[0]![1]).toBe("adv_123");

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

  it("applies an ad group status/name update end to end with change log", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertTiktokConnection(tenant.tenantId);
      const draftRes = await createUpdateDraft(tenant.clerkUserId, connectionId, {
        targetType: "adset",
        targetId: "ag_1",
        status: "ACTIVE",
        name: "Prospecting AG v2",
        dailyBudget: undefined,
      });
      expect(draftRes.status).toBe(201);
      const draftId = draftRes.body.id as number;

      mockReadAdGroup.mockResolvedValueOnce({ ...ADGROUP_STATE }); // drift check
      mockReadAdGroup.mockResolvedValue({
        ...ADGROUP_STATE,
        status: "ACTIVE",
        name: "Prospecting AG v2",
      });

      actAs(tenant.clerkUserId);
      const res = await request(app).post(`/api/ads/drafts/${draftId}/approve`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("applied");
      expect(res.body.verifyStatus).toBe("verified");
      expect(mockUpdateAdGroup).toHaveBeenCalledTimes(1);
      expect(mockUpdateAdGroup).toHaveBeenCalledWith("tiktok-token", "adv_123", "ag_1", {
        name: "Prospecting AG v2",
        status: "ACTIVE",
      });
      expect(mockUpdate).not.toHaveBeenCalled();

      const logs = await db
        .select()
        .from(adsChangeLogsTable)
        .where(eq(adsChangeLogsTable.tenantId, tenant.tenantId));
      expect(logs.length).toBe(1);
      expect(logs[0]!.outcome).toBe("applied");
      expect(logs[0]!.targetType).toBe("adset");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("applies an ad pause end to end and verifies the read-back", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertTiktokConnection(tenant.tenantId);
      const draftRes = await createUpdateDraft(tenant.clerkUserId, connectionId, {
        targetType: "ad",
        targetId: "ad_9",
        status: "PAUSED",
        dailyBudget: undefined,
      });
      expect(draftRes.status).toBe(201);
      const draftId = draftRes.body.id as number;

      mockReadAd.mockResolvedValueOnce({ ...AD_STATE }); // drift check
      mockReadAd.mockResolvedValue({ ...AD_STATE, status: "PAUSED" });

      actAs(tenant.clerkUserId);
      const res = await request(app).post(`/api/ads/drafts/${draftId}/approve`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("applied");
      expect(res.body.verifyStatus).toBe("verified");
      expect(mockUpdateAd).toHaveBeenCalledWith("tiktok-token", "adv_123", "ad_9", {
        name: undefined,
        status: "PAUSED",
      });

      const logs = await db
        .select()
        .from(adsChangeLogsTable)
        .where(eq(adsChangeLogsTable.tenantId, tenant.tenantId));
      expect(logs.length).toBe(1);
      expect(logs[0]!.targetType).toBe("ad");
      expect(logs[0]!.outcome).toBe("applied");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("applies an ad group budget update end to end and verifies read-back", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertTiktokConnection(tenant.tenantId);
      const draftRes = await createUpdateDraft(tenant.clerkUserId, connectionId, {
        targetType: "adset",
        targetId: "ag_1",
        status: undefined,
        dailyBudget: 9000,
      });
      expect(draftRes.status).toBe(201);
      const draftId = draftRes.body.id as number;

      mockReadAdGroup.mockResolvedValueOnce({ ...ADGROUP_STATE }); // drift check
      mockReadAdGroup.mockResolvedValue({ ...ADGROUP_STATE, dailyBudget: 9000 });

      actAs(tenant.clerkUserId);
      const res = await request(app).post(`/api/ads/drafts/${draftId}/approve`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("applied");
      expect(res.body.verifyStatus).toBe("verified");
      expect(mockUpdateAdGroup).toHaveBeenCalledTimes(1);
      expect(mockUpdateAdGroup.mock.calls[0]![3]).toMatchObject({
        dailyBudget: 9000,
      });
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("expires an ad group draft when the remote ad group drifted", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertTiktokConnection(tenant.tenantId);
      const draftRes = await createUpdateDraft(tenant.clerkUserId, connectionId, {
        targetType: "adset",
        targetId: "ag_1",
        status: "ACTIVE",
        dailyBudget: undefined,
      });
      const draftId = draftRes.body.id as number;

      mockReadAdGroup.mockResolvedValue({
        ...ADGROUP_STATE,
        name: "Renamed Elsewhere",
      });

      actAs(tenant.clerkUserId);
      const res = await request(app).post(`/api/ads/drafts/${draftId}/approve`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("expired");
      expect(res.body.failureReason).toMatch(/ad set/i);
      expect(mockUpdateAdGroup).not.toHaveBeenCalled();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("creates a new TikTok campaign with the TRAFFIC default objective", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertTiktokConnection(tenant.tenantId);
      actAs(tenant.clerkUserId);
      const draftRes = await request(app).post("/api/ads/drafts").send({
        connectionId,
        targetType: "campaign",
        action: "create",
        name: "TikTok Launch",
        dailyBudget: 10000,
      });
      expect(draftRes.status).toBe(201);

      mockRead.mockResolvedValue({
        name: "TikTok Launch",
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
      expect(res.body.resultTargetId).toBe("tt_camp_new_1");
      expect(res.body.verifyStatus).toBe("verified");
      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(mockCreate.mock.calls[0]![1]).toBe("adv_123");
      expect(mockCreate.mock.calls[0]![2]).toMatchObject({
        objective: "TRAFFIC",
      });
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("expires a draft when the remote campaign drifted since drafting", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertTiktokConnection(tenant.tenantId);
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

  it("marks the connection failed when TikTok reports an expired grant", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertTiktokConnection(tenant.tenantId);
      const draftRes = await createUpdateDraft(tenant.clerkUserId, connectionId);
      const draftId = draftRes.body.id as number;

      mockUpdate.mockRejectedValue(
        new TiktokAdsApiError("Access token expired", 401, 40102, true),
      );

      actAs(tenant.clerkUserId);
      const res = await request(app).post(`/api/ads/drafts/${draftId}/approve`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("failed");

      const [conn] = await db
        .select()
        .from(adAccountConnectionsTable)
        .where(eq(adAccountConnectionsTable.id, connectionId));
      expect(conn!.verifyStatus).toBe("failed");

      const [draft] = await db
        .select()
        .from(adChangeRequestsTable)
        .where(eq(adChangeRequestsTable.id, draftId));
      expect(draft!.status).toBe("failed");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("flags authLost and marks the connection failed when campaigns load hits an expired grant", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertTiktokConnection(tenant.tenantId);
      mockListCampaigns.mockRejectedValue(
        new TiktokAdsApiError("Access token expired", 401, 40102, true),
      );

      actAs(tenant.clerkUserId);
      const res = await request(app).get(
        `/api/ads/campaigns?connectionId=${connectionId}&datePreset=last_30d`,
      );
      expect(res.status).toBe(502);
      expect(res.body.authLost).toBe(true);

      const [conn] = await db
        .select()
        .from(adAccountConnectionsTable)
        .where(eq(adAccountConnectionsTable.id, connectionId));
      expect(conn!.verifyStatus).toBe("failed");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("does not flag authLost for a non-auth platform error", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertTiktokConnection(tenant.tenantId);
      mockListCampaigns.mockRejectedValue(
        new TiktokAdsApiError("Rate limited", 429, 40100, false),
      );

      actAs(tenant.clerkUserId);
      const res = await request(app).get(
        `/api/ads/campaigns?connectionId=${connectionId}&datePreset=last_30d`,
      );
      expect(res.status).toBe(502);
      expect(res.body.authLost).toBeUndefined();

      const [conn] = await db
        .select()
        .from(adAccountConnectionsTable)
        .where(eq(adAccountConnectionsTable.id, connectionId));
      expect(conn!.verifyStatus).toBe("verified");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});

describe("tiktok advertiser selection", () => {
  it("lists advertiser choices from the stored grant", async () => {
    const tenant = await createTenant();
    try {
      await insertTiktokConnection(tenant.tenantId, {
        status: "pending_selection",
        adAccountId: "",
        adAccountName: "",
        verifyStatus: "unverified",
      });
      mockListAdvertisers.mockResolvedValue([
        {
          advertiserId: "adv_123",
          name: "Main Advertiser",
          currency: "INR",
          status: "STATUS_ENABLE",
        },
        {
          advertiserId: "adv_456",
          name: "Second Advertiser",
          currency: "USD",
          status: "STATUS_ENABLE",
        },
      ]);

      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/ads/connections/tiktok/accounts");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([
        expect.objectContaining({ adAccountId: "adv_123", name: "Main Advertiser" }),
        expect.objectContaining({ adAccountId: "adv_456", name: "Second Advertiser" }),
      ]);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("rejects selecting an advertiser that is not part of the grant", async () => {
    const tenant = await createTenant();
    try {
      await insertTiktokConnection(tenant.tenantId, {
        status: "pending_selection",
        adAccountId: "",
        verifyStatus: "unverified",
      });
      actAs(tenant.clerkUserId);
      const res = await request(app)
        .post("/api/ads/connections/tiktok/select")
        .send({ adAccountId: "adv_evil" });
      expect(res.status).toBe(400);
      expect(mockReadAdvertiser).not.toHaveBeenCalled();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("completes the connection when a granted advertiser is selected", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertTiktokConnection(tenant.tenantId, {
        status: "pending_selection",
        adAccountId: "",
        adAccountName: "",
        verifyStatus: "unverified",
      });
      mockReadAdvertiser.mockResolvedValue({
        name: "Second Advertiser",
        currency: "USD",
      });

      actAs(tenant.clerkUserId);
      const res = await request(app)
        .post("/api/ads/connections/tiktok/select")
        .send({ adAccountId: "adv_456" });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("connected");
      expect(res.body.adAccountId).toBe("adv_456");
      expect(res.body.adAccountName).toBe("Second Advertiser");

      const [conn] = await db
        .select()
        .from(adAccountConnectionsTable)
        .where(eq(adAccountConnectionsTable.id, connectionId));
      expect(conn!.status).toBe("connected");
      expect(conn!.verifyStatus).toBe("verified");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("scopes idempotency keys per tenant for tiktok drafts", async () => {
    const tenantA = await createTenant();
    const tenantB = await createTenant();
    try {
      const connA = await insertTiktokConnection(tenantA.tenantId);
      const connB = await insertTiktokConnection(tenantB.tenantId);
      const key = `shared-key-${randomUUID()}`;
      const first = await createUpdateDraft(tenantA.clerkUserId, connA, {
        idempotencyKey: key,
      });
      expect(first.status).toBe(201);
      const second = await createUpdateDraft(tenantB.clerkUserId, connB, {
        idempotencyKey: key,
      });
      expect(second.status).toBe(201);
      expect(second.body.id).not.toBe(first.body.id);
    } finally {
      await deleteTenant(tenantA.tenantId);
      await deleteTenant(tenantB.tenantId);
    }
  });
});

describe("GET /ads/connections auto re-verify (tiktok)", () => {
  it("flips a stale tiktok connection with a rejected token to failed on page load", async () => {
    const tenant = await createTenant();
    try {
      await insertTiktokConnection(tenant.tenantId); // verifiedAt null => stale
      mockReadAdvertiser.mockRejectedValue(
        new TiktokAdsApiError("token expired", 401, 40102, true),
      );
      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/ads/connections");
      expect(res.status).toBe(200);
      const tiktok = res.body.find(
        (c: { platform: string }) => c.platform === "tiktok",
      );
      expect(tiktok.verifyStatus).toBe("failed");
      expect(mockReadAdvertiser).toHaveBeenCalledTimes(1);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("skips the re-check when the tiktok connection was verified recently", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertTiktokConnection(tenant.tenantId);
      await db
        .update(adAccountConnectionsTable)
        .set({ verifiedAt: new Date() })
        .where(eq(adAccountConnectionsTable.id, connectionId));
      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/ads/connections");
      expect(res.status).toBe(200);
      expect(mockReadAdvertiser).not.toHaveBeenCalled();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("keeps a verified tiktok status when the re-check fails transiently", async () => {
    const tenant = await createTenant();
    try {
      await insertTiktokConnection(tenant.tenantId);
      mockReadAdvertiser.mockRejectedValue(
        new TiktokAdsApiError("TikTok is down", 500, 50000, false),
      );
      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/ads/connections");
      expect(res.status).toBe(200);
      const tiktok = res.body.find(
        (c: { platform: string }) => c.platform === "tiktok",
      );
      expect(tiktok.verifyStatus).toBe("verified");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});
