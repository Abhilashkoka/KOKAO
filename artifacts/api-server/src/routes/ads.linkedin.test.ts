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

// Stub only the LinkedIn network functions; DB-backed engine logic stays real.
vi.mock("../lib/linkedinAdsApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/linkedinAdsApi")>();
  return {
    ...actual,
    listLinkedinAdAccounts: vi.fn(),
    readLinkedinAdAccount: vi.fn(),
    listLinkedinCampaignGroups: vi.fn(),
    listLinkedinCampaigns: vi.fn(),
    getLinkedinCampaign: vi.fn(),
    getLinkedinAnalytics: vi.fn(),
    createLinkedinCampaign: vi.fn(),
    updateLinkedinCampaign: vi.fn(),
    readLinkedinCampaignState: vi.fn(),
  };
});

import {
  db,
  pool,
  adAccountConnectionsTable,
  adChangeRequestsTable,
  adsChangeLogsTable,
  adsSettingsTable,
  tenantMembersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  listLinkedinAdAccounts,
  readLinkedinAdAccount,
  listLinkedinCampaignGroups,
  listLinkedinCampaigns,
  getLinkedinAnalytics,
  createLinkedinCampaign,
  updateLinkedinCampaign,
  readLinkedinCampaignState,
  LinkedinAdsApiError,
} from "../lib/linkedinAdsApi";
import { encryptJson } from "../lib/secretCrypto";
import { requireTenant } from "../middlewares/requireTenant";
import adsRouter from "./ads";
import { resetAuthState, actAs } from "../test/authState";
import { createTenant, deleteTenant } from "../test/dbHelpers";

const mockListAccounts = vi.mocked(listLinkedinAdAccounts);
const mockReadAccount = vi.mocked(readLinkedinAdAccount);
const mockListGroups = vi.mocked(listLinkedinCampaignGroups);
const mockListCampaigns = vi.mocked(listLinkedinCampaigns);
const mockAnalytics = vi.mocked(getLinkedinAnalytics);
const mockCreate = vi.mocked(createLinkedinCampaign);
const mockUpdate = vi.mocked(updateLinkedinCampaign);
const mockReadState = vi.mocked(readLinkedinCampaignState);

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
  name: "Brand Push",
  status: "PAUSED",
  dailyBudget: 5000,
  lifetimeBudget: null,
  startTime: null,
  stopTime: null,
};

async function insertLinkedinAdConnection(
  tenantId: number,
  overrides: Partial<typeof adAccountConnectionsTable.$inferInsert> = {},
): Promise<number> {
  const [row] = await db
    .insert(adAccountConnectionsTable)
    .values({
      tenantId,
      platform: "linkedin",
      status: "connected",
      adAccountId: "512345678",
      adAccountName: "Test LinkedIn Account",
      currency: "USD",
      verifyStatus: "verified",
      encryptedCredentials: encryptJson({ accessToken: "li-ads-token" }),
      ...overrides,
    })
    .returning({ id: adAccountConnectionsTable.id });
  return row!.id;
}

async function addMember(
  tenantId: number,
  role: "admin" | "member",
): Promise<{ clerkUserId: string }> {
  const clerkUserId = `test_liads_member_${randomUUID()}`;
  await db
    .insert(tenantMembersTable)
    .values({ tenantId, clerkUserId, email: `${clerkUserId}@example.com`, role });
  return { clerkUserId };
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
      targetId: "cmp_1",
      status: "ACTIVE",
      dailyBudget: 7000,
      ...overrides,
    });
}

beforeEach(async () => {
  resetAuthState();
  vi.clearAllMocks();
  mockReadState.mockResolvedValue({ ...REMOTE_STATE });
  mockUpdate.mockResolvedValue(undefined as never);
  mockCreate.mockResolvedValue("cmp_new_1");
  mockListAccounts.mockResolvedValue([
    { adAccountId: "512345678", name: "Test LinkedIn Account", currency: "USD", accountStatus: "ACTIVE" },
  ]);
  mockReadAccount.mockResolvedValue({
    name: "Test LinkedIn Account",
    currency: "USD",
  });
  mockListGroups.mockResolvedValue([
    { id: "grp_1", name: "Always On", status: "ACTIVE", campaignGroupId: undefined } as never,
  ]);
  mockListCampaigns.mockResolvedValue([
    {
      id: "cmp_1",
      name: "Brand Push",
      status: "PAUSED",
      effectiveStatus: "PAUSED",
      objective: null,
      dailyBudget: 5000,
      lifetimeBudget: null,
      startTime: null,
      stopTime: null,
      campaignGroupId: "grp_1",
    } as never,
  ]);
  mockAnalytics.mockResolvedValue(new Map());
  await db.delete(adsSettingsTable);
});

afterAll(async () => {
  await db.delete(adsSettingsTable);
  await pool.end();
});

describe("LinkedIn campaign listing", () => {
  it("lists campaigns with campaign group names and metrics", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      mockAnalytics.mockResolvedValue(
        new Map([
          ["cmp_1", { impressions: 100, clicks: 8, ctr: 8, spend: 42.5, results: 3 }],
        ]),
      );
      actAs(tenant.clerkUserId);
      const res = await request(app)
        .get("/api/ads/campaigns")
        .query({ connectionId });
      expect(res.status).toBe(200);
      expect(res.body.currency).toBe("USD");
      expect(res.body.campaigns).toHaveLength(1);
      expect(res.body.campaigns[0].campaignGroupName).toBe("Always On");
      expect(res.body.campaigns[0].metrics.spend).toBe(42.5);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("lists campaign groups with metrics", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      mockAnalytics.mockResolvedValue(
        new Map([
          ["grp_1", { impressions: 500, clicks: 20, ctr: 4, spend: 99, results: 5 }],
        ]),
      );
      actAs(tenant.clerkUserId);
      const res = await request(app)
        .get("/api/ads/linkedin/campaign-groups")
        .query({ connectionId });
      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(1);
      expect(res.body.groups[0].metrics.spend).toBe(99);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("marks the connection failed when LinkedIn rejects the token", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      mockListCampaigns.mockRejectedValue(
        new LinkedinAdsApiError("Token expired", 401, true),
      );
      actAs(tenant.clerkUserId);
      const res = await request(app)
        .get("/api/ads/campaigns")
        .query({ connectionId });
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

  it("rejects the campaign-groups endpoint for a non-LinkedIn connection", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId, {
        platform: "meta",
        adAccountId: "act_123",
      });
      actAs(tenant.clerkUserId);
      const res = await request(app)
        .get("/api/ads/linkedin/campaign-groups")
        .query({ connectionId });
      expect(res.status).toBe(400);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});

describe("LinkedIn account selection", () => {
  it("completes a pending connection after picking an ad account", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId, {
        status: "pending_selection",
        adAccountId: "",
        adAccountName: "",
        currency: null,
        verifyStatus: null,
      });
      actAs(tenant.clerkUserId);

      const choices = await request(app).get("/api/ads/connections/linkedin/accounts");
      expect(choices.status).toBe(200);
      expect(choices.body[0].adAccountId).toBe("512345678");

      const res = await request(app)
        .post("/api/ads/connections/linkedin/select")
        .send({ adAccountId: "512345678" });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("connected");
      expect(res.body.adAccountName).toBe("Test LinkedIn Account");
      expect(res.body.currency).toBe("USD");

      const [row] = await db
        .select()
        .from(adAccountConnectionsTable)
        .where(eq(adAccountConnectionsTable.id, connectionId));
      expect(row!.status).toBe("connected");
      expect(row!.verifyStatus).toBe("verified");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("rejects an unverifiable ad account selection", async () => {
    const tenant = await createTenant();
    try {
      await insertLinkedinAdConnection(tenant.tenantId, {
        status: "pending_selection",
        adAccountId: "",
        adAccountName: "",
      });
      mockReadAccount.mockRejectedValue(new LinkedinAdsApiError("Not found", 404));
      actAs(tenant.clerkUserId);
      const res = await request(app)
        .post("/api/ads/connections/linkedin/select")
        .send({ adAccountId: "999" });
      expect(res.status).toBe(400);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});

describe("LinkedIn draft creation", () => {
  it("captures a before/after diff for updates via the LinkedIn reader", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      const res = await createUpdateDraft(tenant.clerkUserId, connectionId);
      expect(res.status).toBe(201);
      expect(res.body.platform).toBe("linkedin");
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
      expect(mockReadState).toHaveBeenCalledWith("li-ads-token", "512345678", "cmp_1");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("requires a campaign group for LinkedIn campaign creates", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      actAs(tenant.clerkUserId);
      const missing = await request(app).post("/api/ads/drafts").send({
        connectionId,
        targetType: "campaign",
        action: "create",
        name: "LI Launch",
        dailyBudget: 10000,
      });
      expect(missing.status).toBe(400);
      expect(missing.body.error).toContain("campaignGroupId");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("marks the connection failed when the pre-draft read hits an auth error", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      mockReadState.mockRejectedValue(new LinkedinAdsApiError("Revoked", 401, true));
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

describe("LinkedIn draft apply", () => {
  it("applies an update end to end with owner approval and verification", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      const draftRes = await createUpdateDraft(tenant.clerkUserId, connectionId);
      const draftId = draftRes.body.id as number;

      mockReadState.mockResolvedValueOnce({ ...REMOTE_STATE }); // drift check
      mockReadState.mockResolvedValue({
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
      expect(mockUpdate.mock.calls[0]![0]).toBe("li-ads-token");
      expect(mockUpdate.mock.calls[0]![1]).toBe("512345678");
      expect(mockUpdate.mock.calls[0]![2]).toBe("cmp_1");

      const logs = await db
        .select()
        .from(adsChangeLogsTable)
        .where(eq(adsChangeLogsTable.tenantId, tenant.tenantId));
      expect(logs.length).toBe(1);
      expect(logs[0]!.platform).toBe("linkedin");
      expect(logs[0]!.outcome).toBe("applied");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("denies approval to an admin member", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      const draftRes = await createUpdateDraft(tenant.clerkUserId, connectionId);
      const draftId = draftRes.body.id as number;

      const admin = await addMember(tenant.tenantId, "admin");
      actAs(admin.clerkUserId);
      const denied = await request(app).post(`/api/ads/drafts/${draftId}/approve`);
      expect(denied.status).toBe(403);
      expect(mockUpdate).not.toHaveBeenCalled();

      const [row] = await db
        .select()
        .from(adChangeRequestsTable)
        .where(eq(adChangeRequestsTable.id, draftId));
      expect(row!.status).toBe("draft");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("expires a draft when the LinkedIn campaign drifted since drafting", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      const draftRes = await createUpdateDraft(tenant.clerkUserId, connectionId);
      const draftId = draftRes.body.id as number;

      mockReadState.mockResolvedValue({ ...REMOTE_STATE, name: "Renamed Elsewhere" });

      actAs(tenant.clerkUserId);
      const res = await request(app).post(`/api/ads/drafts/${draftId}/approve`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("expired");
      expect(mockUpdate).not.toHaveBeenCalled();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("creates and applies a new LinkedIn campaign draft end to end", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      actAs(tenant.clerkUserId);
      const draftRes = await request(app).post("/api/ads/drafts").send({
        connectionId,
        targetType: "campaign",
        action: "create",
        name: "LI Launch",
        campaignGroupId: "grp_1",
        dailyBudget: 10000,
      });
      expect(draftRes.status).toBe(201);

      mockReadState.mockResolvedValue({
        name: "LI Launch",
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
      expect(res.body.resultTargetId).toBe("cmp_new_1");
      expect(res.body.verifyStatus).toBe("verified");
      expect(mockCreate).toHaveBeenCalledTimes(1);
      const createParams = mockCreate.mock.calls[0]![2] as unknown as Record<
        string,
        unknown
      >;
      expect(createParams.campaignGroupId).toBe("grp_1");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("records a failed outcome when LinkedIn rejects the write", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      const draftRes = await createUpdateDraft(tenant.clerkUserId, connectionId);
      const draftId = draftRes.body.id as number;

      mockUpdate.mockRejectedValue(new LinkedinAdsApiError("Invalid budget", 422));

      actAs(tenant.clerkUserId);
      const res = await request(app).post(`/api/ads/drafts/${draftId}/approve`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("failed");
      expect(res.body.failureReason).toContain("Invalid budget");

      const logs = await db
        .select()
        .from(adsChangeLogsTable)
        .where(eq(adsChangeLogsTable.tenantId, tenant.tenantId));
      expect(logs.length).toBe(1);
      expect(logs[0]!.outcome).toBe("failed");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});
