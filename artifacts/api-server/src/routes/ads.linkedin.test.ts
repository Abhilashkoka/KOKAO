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

// Token-refresh network path (used by the auth-failure gate).
vi.mock("../lib/platformFetch", () => ({
  platformFetch: vi.fn(),
}));
vi.mock("../lib/linkedinApp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/linkedinApp")>();
  return {
    ...actual,
    getLinkedinAppCredentials: vi.fn(async () => ({
      clientId: "app-id",
      clientSecret: "app-secret",
    })),
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
    createLinkedinCampaignGroup: vi.fn(),
    updateLinkedinCampaign: vi.fn(),
    updateLinkedinCampaignGroup: vi.fn(),
    readLinkedinCampaignState: vi.fn(),
    readLinkedinCampaignGroupState: vi.fn(),
    readLinkedinCreativeState: vi.fn(),
    getLinkedinAdAccountReference: vi.fn(),
    uploadLinkedinAdImage: vi.fn(),
    createLinkedinAdPost: vi.fn(),
    createLinkedinCreative: vi.fn(),
    updateLinkedinCreative: vi.fn(),
    listLinkedinCreatives: vi.fn(),
    readLinkedinPostPreview: vi.fn(),
    searchLinkedinGeoLocations: vi.fn(),
    searchLinkedinTargetingEntities: vi.fn(),
    resolveLinkedinTargetingEntityNames: vi.fn(),
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
  notificationsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  listLinkedinAdAccounts,
  readLinkedinAdAccount,
  listLinkedinCampaignGroups,
  listLinkedinCampaigns,
  getLinkedinCampaign,
  getLinkedinAnalytics,
  createLinkedinCampaign,
  createLinkedinCampaignGroup,
  updateLinkedinCampaign,
  updateLinkedinCampaignGroup,
  readLinkedinCampaignState,
  readLinkedinCampaignGroupState,
  readLinkedinCreativeState,
  getLinkedinAdAccountReference,
  uploadLinkedinAdImage,
  createLinkedinAdPost,
  createLinkedinCreative,
  updateLinkedinCreative,
  listLinkedinCreatives,
  readLinkedinPostPreview,
  searchLinkedinGeoLocations,
  searchLinkedinTargetingEntities,
  resolveLinkedinTargetingEntityNames,
  LinkedinAdsApiError,
} from "../lib/linkedinAdsApi";
import { platformFetch } from "../lib/platformFetch";
import { LINKEDIN_ADS_REFRESH_WINDOW_MS } from "../lib/linkedinAdsRefresh";
import { encryptJson, decryptJson } from "../lib/secretCrypto";
import { requireTenant } from "../middlewares/requireTenant";
import adsRouter, { adsCallbackRouter, clearLinkedinGroupNamesCache } from "./ads";
import { signOAuthState } from "../lib/oauthState";
import { resetAuthState, actAs } from "../test/authState";
import { createTenant, deleteTenant } from "../test/dbHelpers";

const mockListAccounts = vi.mocked(listLinkedinAdAccounts);
const mockReadAccount = vi.mocked(readLinkedinAdAccount);
const mockListGroups = vi.mocked(listLinkedinCampaignGroups);
const mockListCampaigns = vi.mocked(listLinkedinCampaigns);
const mockAnalytics = vi.mocked(getLinkedinAnalytics);
const mockCreate = vi.mocked(createLinkedinCampaign);
const mockCreateGroup = vi.mocked(createLinkedinCampaignGroup);
const mockUpdate = vi.mocked(updateLinkedinCampaign);
const mockUpdateGroup = vi.mocked(updateLinkedinCampaignGroup);
const mockReadState = vi.mocked(readLinkedinCampaignState);
const mockReadGroupState = vi.mocked(readLinkedinCampaignGroupState);
const mockGetCampaign = vi.mocked(getLinkedinCampaign);
const mockReadCreativeState = vi.mocked(readLinkedinCreativeState);
const mockGetAccountRef = vi.mocked(getLinkedinAdAccountReference);
const mockUploadImage = vi.mocked(uploadLinkedinAdImage);
const mockCreatePost = vi.mocked(createLinkedinAdPost);
const mockCreateCreative = vi.mocked(createLinkedinCreative);
const mockUpdateCreative = vi.mocked(updateLinkedinCreative);
const mockListCreatives = vi.mocked(listLinkedinCreatives);
const mockReadPostPreview = vi.mocked(readLinkedinPostPreview);
const mockGeoSearch = vi.mocked(searchLinkedinGeoLocations);
const mockTargetingSearch = vi.mocked(searchLinkedinTargetingEntities);
const mockResolveNames = vi.mocked(resolveLinkedinTargetingEntityNames);
const mockPlatformFetch = vi.mocked(platformFetch);

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

const REMOTE_STATE = {
  name: "Brand Push",
  status: "PAUSED",
  dailyBudget: 5000,
  lifetimeBudget: null,
  startTime: null,
  stopTime: null,
  targetingLocations: [] as string[],
  targetingIndustries: [] as string[],
  targetingJobFunctions: [] as string[],
  targetingTitles: [] as string[],
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
  clearLinkedinGroupNamesCache();
  mockReadState.mockResolvedValue({ ...REMOTE_STATE });
  mockUpdate.mockResolvedValue(undefined as never);
  mockUpdateGroup.mockResolvedValue(undefined as never);
  mockReadGroupState.mockResolvedValue({
    name: "Always On",
    status: "ACTIVE",
    dailyBudget: null,
    lifetimeBudget: 200000,
    startTime: null,
    stopTime: null,
  });
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

describe("linkedin reconnect restores a failed connection", () => {
  it("flips a failed connection back to verified via select and resolves the lingering notification", async () => {
    const tenant = await createTenant();
    try {
      // A previously broken grant: reverify flipped it to failed and left an
      // unread "ad account disconnected" notification behind. The OAuth
      // reconnect callback has since stored a fresh access token.
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId, {
        verifyStatus: "failed",
        verifyError: "Token expired",
        encryptedCredentials: encryptJson({ accessToken: "li-ads-token-fresh" }),
      });
      await db.insert(notificationsTable).values({
        tenantId: tenant.tenantId,
        type: "ads_connection_failed",
        platform: "linkedin",
        title: "LinkedIn Ads account disconnected",
        message: "Your LinkedIn Ads connection is no longer valid.",
        linkUrl: "/ads",
      });

      actAs(tenant.clerkUserId);
      const list = await request(app).get("/api/ads/connections/linkedin/accounts");
      expect(list.status).toBe(200);
      expect(list.body.length).toBe(1);

      const sel = await request(app)
        .post("/api/ads/connections/linkedin/select")
        .send({ adAccountId: "512345678" });
      expect(sel.status).toBe(200);
      expect(sel.body.status).toBe("connected");
      expect(sel.body.verifyStatus).toBe("verified");

      const [row] = await db
        .select()
        .from(adAccountConnectionsTable)
        .where(eq(adAccountConnectionsTable.id, connectionId));
      expect(row!.verifyStatus).toBe("verified");
      expect(row!.verifyError).toBeNull();
      expect(row!.status).toBe("connected");
      const creds = decryptJson<{ accessToken: string }>(
        row!.encryptedCredentials!,
      );
      expect(creds.accessToken).toBe("li-ads-token-fresh");
      // The select call verified the account against LinkedIn with the fresh token.
      expect(mockReadAccount).toHaveBeenCalledWith("li-ads-token-fresh", "512345678");

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

describe("linkedin oauth callback reconnect fast path", () => {
  function mockTokenExchange() {
    mockPlatformFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "li-fresh-token", expires_in: 3600 }),
    } as never);
  }

  it("auto-verifies the previous ad account when still readable with the new token", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId, {
        verifyStatus: "failed",
        verifyError: "token revoked",
      });
      mockTokenExchange();
      await db.insert(notificationsTable).values({
        tenantId: tenant.tenantId,
        type: "ads_connection_failed",
        platform: "linkedin",
        title: "LinkedIn Ads account disconnected",
        message: "Your LinkedIn Ads connection is no longer valid.",
        linkUrl: "/ads",
      });

      const state = signOAuthState(tenant.tenantId, "nonce");
      const res = await request(app).get(
        `/api/ads/linkedin/auth/callback?code=code123&state=${state}`,
      );
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain("linkedin=connected");

      const [conn] = await db
        .select()
        .from(adAccountConnectionsTable)
        .where(eq(adAccountConnectionsTable.id, connectionId));
      expect(conn!.status).toBe("connected");
      expect(conn!.adAccountId).toBe("512345678");
      expect(conn!.verifyStatus).toBe("verified");
      expect(conn!.verifyError).toBeNull();
      expect(mockReadAccount).toHaveBeenCalledWith("li-fresh-token", "512345678");
      const creds = decryptJson<{ accessToken: string }>(
        conn!.encryptedCredentials!,
      );
      expect(creds.accessToken).toBe("li-fresh-token");

      // The lingering disconnected notification is auto-resolved.
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

  it("falls back to pending_selection when the previous ad account cannot be verified", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      mockTokenExchange();
      mockReadAccount.mockRejectedValue(
        new LinkedinAdsApiError("account gone", 404),
      );

      const state = signOAuthState(tenant.tenantId, "nonce");
      const res = await request(app).get(
        `/api/ads/linkedin/auth/callback?code=code123&state=${state}`,
      );
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain("linkedin=connected");

      const [conn] = await db
        .select()
        .from(adAccountConnectionsTable)
        .where(eq(adAccountConnectionsTable.id, connectionId));
      expect(conn!.status).toBe("pending_selection");
      expect(conn!.adAccountId).toBe("");
      expect(conn!.verifyStatus).toBeNull();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("stays pending_selection when there was no previously selected account", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId, {
        status: "pending_selection",
        adAccountId: "",
        adAccountName: "",
        currency: null,
        verifyStatus: null,
      });
      mockTokenExchange();

      const state = signOAuthState(tenant.tenantId, "nonce");
      const res = await request(app).get(
        `/api/ads/linkedin/auth/callback?code=code123&state=${state}`,
      );
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain("linkedin=connected");

      const [conn] = await db
        .select()
        .from(adAccountConnectionsTable)
        .where(eq(adAccountConnectionsTable.id, connectionId));
      expect(conn!.status).toBe("pending_selection");
      expect(mockReadAccount).not.toHaveBeenCalled();
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
      const groupChange = (
        draftRes.body.changes as {
          field: string;
          after: string | null;
          afterDetail?: string | null;
        }[]
      ).find((c) => c.field === "Campaign group");
      expect(groupChange).toBeDefined();
      expect(groupChange!.after).toBe("Always On");
      expect(groupChange!.afterDetail).toBe("grp_1");

      mockReadState.mockResolvedValue({
        ...REMOTE_STATE,
        name: "LI Launch",
        dailyBudget: 10000,
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

  it("creates and applies a campaign group draft end to end", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      actAs(tenant.clerkUserId);
      const draftRes = await request(app).post("/api/ads/drafts").send({
        connectionId,
        targetType: "campaign_group",
        action: "create",
        name: "Q3 Group",
        status: "PAUSED",
        lifetimeBudget: 500000,
      });
      expect(draftRes.status).toBe(201);
      expect(draftRes.body.targetType).toBe("campaign_group");

      mockCreateGroup.mockResolvedValue("grp_new_1");
      mockReadGroupState.mockResolvedValue({
        name: "Q3 Group",
        status: "PAUSED",
        dailyBudget: null,
        lifetimeBudget: 500000,
        startTime: null,
        stopTime: null,
      });
      const res = await request(app).post(
        `/api/ads/drafts/${draftRes.body.id}/approve`,
      );
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("applied");
      expect(res.body.resultTargetId).toBe("grp_new_1");
      expect(res.body.verifyStatus).toBe("verified");
      expect(mockCreateGroup).toHaveBeenCalledTimes(1);
      const params = mockCreateGroup.mock.calls[0]![2] as unknown as Record<
        string,
        unknown
      >;
      expect(params.name).toBe("Q3 Group");
      expect(params.lifetimeBudget).toBe(500000);
      expect(mockCreate).not.toHaveBeenCalled();

      const logs = await db
        .select()
        .from(adsChangeLogsTable)
        .where(eq(adsChangeLogsTable.tenantId, tenant.tenantId));
      expect(logs.length).toBe(1);
      expect(logs[0]!.targetType).toBe("campaign_group");
      expect(logs[0]!.outcome).toBe("applied");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("rejects campaign-only fields on group drafts (create and update)", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      actAs(tenant.clerkUserId);
      const badCreate = await request(app).post("/api/ads/drafts").send({
        connectionId,
        targetType: "campaign_group",
        action: "create",
        name: "Q3 Group",
        dailyBudget: 1000,
      });
      expect(badCreate.status).toBe(400);
      expect(badCreate.body.error).toContain("lifetime budget");

      const badUpdate = await request(app).post("/api/ads/drafts").send({
        connectionId,
        targetType: "campaign_group",
        action: "update",
        targetId: "grp_1",
        startTime: "2026-08-01T00:00:00.000Z",
      });
      expect(badUpdate.status).toBe(400);
      expect(badUpdate.body.error).toContain("lifetime budget");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("rejects campaign-group drafts on non-LinkedIn connections", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId, {
        platform: "meta",
        adAccountId: "act_123",
      });
      actAs(tenant.clerkUserId);
      const res = await request(app).post("/api/ads/drafts").send({
        connectionId,
        targetType: "campaign_group",
        action: "update",
        targetId: "grp_1",
        name: "Renamed",
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("LinkedIn");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("drafts a campaign-group update with a before/after diff from the group reader", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      actAs(tenant.clerkUserId);
      const res = await request(app).post("/api/ads/drafts").send({
        connectionId,
        targetType: "campaign_group",
        action: "update",
        targetId: "grp_1",
        name: "Evergreen",
        status: "PAUSED",
        lifetimeBudget: 300000,
      });
      expect(res.status).toBe(201);
      expect(res.body.targetType).toBe("campaign_group");
      expect(res.body.changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "Name", before: "Always On", after: "Evergreen" }),
          expect.objectContaining({ field: "Status", before: "ACTIVE", after: "PAUSED" }),
          expect.objectContaining({
            field: "Lifetime budget (minor units)",
            before: "200000",
            after: "300000",
          }),
        ]),
      );
      expect(mockReadGroupState).toHaveBeenCalledWith("li-ads-token", "512345678", "grp_1");
      expect(mockReadState).not.toHaveBeenCalled();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("applies a campaign-group update end to end via the group adapter", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      actAs(tenant.clerkUserId);
      const draftRes = await request(app).post("/api/ads/drafts").send({
        connectionId,
        targetType: "campaign_group",
        action: "update",
        targetId: "grp_1",
        name: "Evergreen",
        status: "PAUSED",
        lifetimeBudget: 300000,
      });
      expect(draftRes.status).toBe(201);

      // Drift check sees the unchanged group; read-back sees the applied one.
      mockReadGroupState.mockResolvedValueOnce({
        name: "Always On",
        status: "ACTIVE",
        dailyBudget: null,
        lifetimeBudget: 200000,
        startTime: null,
        stopTime: null,
      });
      mockReadGroupState.mockResolvedValue({
        name: "Evergreen",
        status: "PAUSED",
        dailyBudget: null,
        lifetimeBudget: 300000,
        startTime: null,
        stopTime: null,
      });

      const res = await request(app).post(
        `/api/ads/drafts/${draftRes.body.id}/approve`,
      );
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("applied");
      expect(res.body.verifyStatus).toBe("verified");
      expect(mockUpdateGroup).toHaveBeenCalledTimes(1);
      expect(mockUpdateGroup).toHaveBeenCalledWith(
        "li-ads-token",
        "512345678",
        "grp_1",
        expect.objectContaining({
          name: "Evergreen",
          status: "PAUSED",
          lifetimeBudget: 300000,
          currency: "USD",
        }),
      );
      expect(mockUpdate).not.toHaveBeenCalled();

      const logs = await db
        .select()
        .from(adsChangeLogsTable)
        .where(eq(adsChangeLogsTable.tenantId, tenant.tenantId));
      expect(logs.length).toBe(1);
      expect(logs[0]!.targetType).toBe("campaign_group");
      expect(logs[0]!.action).toBe("update");
      expect(logs[0]!.outcome).toBe("applied");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("removes a campaign group's lifetime budget end to end", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      actAs(tenant.clerkUserId);
      const draftRes = await request(app).post("/api/ads/drafts").send({
        connectionId,
        targetType: "campaign_group",
        action: "update",
        targetId: "grp_1",
        removeLifetimeBudget: true,
      });
      expect(draftRes.status).toBe(201);
      expect(draftRes.body.changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "Lifetime budget (minor units)",
            before: "200000",
            after: "(removed — no cap)",
          }),
        ]),
      );

      // Drift check sees the unchanged group; read-back sees the budget gone.
      mockReadGroupState.mockResolvedValueOnce({
        name: "Always On",
        status: "ACTIVE",
        dailyBudget: null,
        lifetimeBudget: 200000,
        startTime: null,
        stopTime: null,
      });
      mockReadGroupState.mockResolvedValue({
        name: "Always On",
        status: "ACTIVE",
        dailyBudget: null,
        lifetimeBudget: null,
        startTime: null,
        stopTime: null,
      });

      const res = await request(app).post(
        `/api/ads/drafts/${draftRes.body.id}/approve`,
      );
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("applied");
      expect(res.body.verifyStatus).toBe("verified");
      expect(mockUpdateGroup).toHaveBeenCalledTimes(1);
      expect(mockUpdateGroup).toHaveBeenCalledWith(
        "li-ads-token",
        "512345678",
        "grp_1",
        expect.objectContaining({
          removeLifetimeBudget: true,
          currency: "USD",
        }),
      );
      const params = mockUpdateGroup.mock.calls[0]![3] as unknown as Record<
        string,
        unknown
      >;
      expect(params.lifetimeBudget).toBeUndefined();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("flags a mismatch when the budget is still present after a removal", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      actAs(tenant.clerkUserId);
      const draftRes = await request(app).post("/api/ads/drafts").send({
        connectionId,
        targetType: "campaign_group",
        action: "update",
        targetId: "grp_1",
        removeLifetimeBudget: true,
      });
      expect(draftRes.status).toBe(201);

      // Both the drift check and read-back still show the budget: apply
      // succeeds but verification must flag the mismatch.
      mockReadGroupState.mockResolvedValue({
        name: "Always On",
        status: "ACTIVE",
        dailyBudget: null,
        lifetimeBudget: 200000,
        startTime: null,
        stopTime: null,
      });

      const res = await request(app).post(
        `/api/ads/drafts/${draftRes.body.id}/approve`,
      );
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("applied");
      expect(res.body.verifyStatus).toBe("mismatch");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("rejects removing and setting a lifetime budget in the same draft", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      actAs(tenant.clerkUserId);
      const both = await request(app).post("/api/ads/drafts").send({
        connectionId,
        targetType: "campaign_group",
        action: "update",
        targetId: "grp_1",
        lifetimeBudget: 100000,
        removeLifetimeBudget: true,
      });
      expect(both.status).toBe(400);
      expect(both.body.error).toContain("not both");

      const onCreate = await request(app).post("/api/ads/drafts").send({
        connectionId,
        targetType: "campaign_group",
        action: "create",
        name: "New Group",
        removeLifetimeBudget: true,
      });
      expect(onCreate.status).toBe(400);
      expect(onCreate.body.error).toContain("existing campaign group");

      const onCampaign = await request(app).post("/api/ads/drafts").send({
        connectionId,
        targetType: "campaign",
        action: "update",
        targetId: "cmp_1",
        removeLifetimeBudget: true,
      });
      expect(onCampaign.status).toBe(400);
      expect(onCampaign.body.error).toContain("campaign groups");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("rejects a budget-removal draft when the group has no budget", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      actAs(tenant.clerkUserId);
      mockReadGroupState.mockResolvedValueOnce({
        name: "Always On",
        status: "ACTIVE",
        dailyBudget: null,
        lifetimeBudget: null,
        startTime: null,
        stopTime: null,
      });
      const res = await request(app).post("/api/ads/drafts").send({
        connectionId,
        targetType: "campaign_group",
        action: "update",
        targetId: "grp_1",
        removeLifetimeBudget: true,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Nothing would change");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("expires a campaign-group update when the group drifted since drafting", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      actAs(tenant.clerkUserId);
      const draftRes = await request(app).post("/api/ads/drafts").send({
        connectionId,
        targetType: "campaign_group",
        action: "update",
        targetId: "grp_1",
        status: "PAUSED",
      });
      expect(draftRes.status).toBe(201);

      mockReadGroupState.mockResolvedValue({
        name: "Renamed Elsewhere",
        status: "ACTIVE",
        dailyBudget: null,
        lifetimeBudget: 200000,
        startTime: null,
        stopTime: null,
      });

      const res = await request(app).post(
        `/api/ads/drafts/${draftRes.body.id}/approve`,
      );
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("expired");
      expect(res.body.failureReason).toContain("campaign group");
      expect(mockUpdateGroup).not.toHaveBeenCalled();
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

describe("LinkedIn creative drafts", () => {
  it("creates and applies a text-only creative draft end to end", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      mockGetCampaign.mockResolvedValue({
        id: "cmp_1",
        name: "Brand Push",
        status: "PAUSED",
        effectiveStatus: "PAUSED",
      } as never);
      mockGetAccountRef.mockResolvedValue("urn:li:organization:987");
      mockCreatePost.mockResolvedValue("urn:li:share:555");
      mockCreateCreative.mockResolvedValue("urn:li:sponsoredCreative:777");
      mockReadCreativeState.mockResolvedValue({
        name: "urn:li:share:555",
        status: "PAUSED",
        dailyBudget: null,
        lifetimeBudget: null,
        startTime: null,
        stopTime: null,
      });

      actAs(tenant.clerkUserId);
      const draftRes = await request(app).post("/api/ads/drafts").send({
        connectionId,
        targetType: "creative",
        action: "create",
        campaignId: "cmp_1",
        text: "Try KOKAO for on-brand social content.",
        landingUrl: "https://example.com/offer",
      });
      expect(draftRes.status).toBe(201);
      expect(draftRes.body.targetType).toBe("creative");
      expect(
        (draftRes.body.changes as { field: string }[]).map((c) => c.field),
      ).toEqual(expect.arrayContaining(["Campaign", "Ad text", "Landing page"]));

      const res = await request(app).post(
        `/api/ads/drafts/${draftRes.body.id}/approve`,
      );
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("applied");
      expect(res.body.resultTargetId).toBe("urn:li:sponsoredCreative:777");
      expect(res.body.verifyStatus).toBe("verified");
      expect(mockUploadImage).not.toHaveBeenCalled();
      expect(mockCreatePost).toHaveBeenCalledWith(
        "li-ads-token",
        "urn:li:organization:987",
        "Try KOKAO for on-brand social content.",
        null,
        "https://example.com/offer",
      );
      expect(mockCreateCreative).toHaveBeenCalledWith(
        "li-ads-token",
        "512345678",
        "cmp_1",
        "urn:li:share:555",
        "PAUSED",
      );
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("rejects a creative draft whose imagePath belongs to another tenant", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      actAs(tenant.clerkUserId);
      const res = await request(app).post("/api/ads/drafts").send({
        connectionId,
        targetType: "creative",
        action: "create",
        campaignId: "cmp_1",
        text: "Sneaky",
        imagePath: `/objects/${tenant.tenantId + 999}/uploads/some-image`,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("content library");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("rejects creative drafts on non-LinkedIn connections and non-https landing URLs", async () => {
    const tenant = await createTenant();
    try {
      const metaConnId = await insertLinkedinAdConnection(tenant.tenantId, {
        platform: "meta",
        adAccountId: "act_123",
      });
      actAs(tenant.clerkUserId);
      const metaRes = await request(app).post("/api/ads/drafts").send({
        connectionId: metaConnId,
        targetType: "creative",
        action: "create",
        campaignId: "cmp_1",
        text: "Nope",
      });
      expect(metaRes.status).toBe(400);

      const liConnId = await insertLinkedinAdConnection(tenant.tenantId);
      const httpRes = await request(app).post("/api/ads/drafts").send({
        connectionId: liConnId,
        targetType: "creative",
        action: "create",
        campaignId: "cmp_1",
        text: "Bad link",
        landingUrl: "http://insecure.example.com",
      });
      expect(httpRes.status).toBe(400);
      expect(httpRes.body.error).toContain("https");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("pauses a live creative through a status-only update draft end to end", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      mockReadCreativeState.mockResolvedValue({
        name: "urn:li:share:555",
        status: "ACTIVE",
        dailyBudget: null,
        lifetimeBudget: null,
        startTime: null,
        stopTime: null,
      });
      mockUpdateCreative.mockResolvedValue(undefined);

      actAs(tenant.clerkUserId);
      const draftRes = await request(app).post("/api/ads/drafts").send({
        connectionId,
        targetType: "creative",
        action: "update",
        targetId: "777",
        status: "PAUSED",
      });
      expect(draftRes.status).toBe(201);
      expect(draftRes.body.targetType).toBe("creative");
      expect(draftRes.body.action).toBe("update");
      expect(
        (draftRes.body.changes as { field: string; after: string }[]).find(
          (c) => c.field === "Status",
        )?.after,
      ).toBe("PAUSED");

      // Drift check still sees the original state; post-apply verify reads
      // the new status.
      mockReadCreativeState
        .mockResolvedValueOnce({
          name: "urn:li:share:555",
          status: "ACTIVE",
          dailyBudget: null,
          lifetimeBudget: null,
          startTime: null,
          stopTime: null,
        })
        .mockResolvedValue({
          name: "urn:li:share:555",
          status: "PAUSED",
          dailyBudget: null,
          lifetimeBudget: null,
          startTime: null,
          stopTime: null,
        });
      const res = await request(app).post(
        `/api/ads/drafts/${draftRes.body.id}/approve`,
      );
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("applied");
      expect(res.body.verifyStatus).toBe("verified");
      expect(mockUpdateCreative).toHaveBeenCalledWith(
        "li-ads-token",
        "512345678",
        "777",
        { status: "PAUSED" },
      );

      // Change log recorded the applied outcome.
      const logRes = await request(app).get("/api/ads/change-log");
      expect(logRes.status).toBe(200);
      const entry = (logRes.body as { targetType: string; outcome: string }[]).find(
        (e) => e.targetType === "creative" && e.outcome === "applied",
      );
      expect(entry).toBeDefined();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("archives a creative (ARCHIVED status draft)", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      mockReadCreativeState.mockResolvedValue({
        name: "urn:li:share:555",
        status: "PAUSED",
        dailyBudget: null,
        lifetimeBudget: null,
        startTime: null,
        stopTime: null,
      });
      mockUpdateCreative.mockResolvedValue(undefined);

      actAs(tenant.clerkUserId);
      const draftRes = await request(app).post("/api/ads/drafts").send({
        connectionId,
        targetType: "creative",
        action: "update",
        targetId: "777",
        status: "ARCHIVED",
      });
      expect(draftRes.status).toBe(201);

      mockReadCreativeState
        .mockResolvedValueOnce({
          name: "urn:li:share:555",
          status: "PAUSED",
          dailyBudget: null,
          lifetimeBudget: null,
          startTime: null,
          stopTime: null,
        })
        .mockResolvedValue({
          name: "urn:li:share:555",
          status: "ARCHIVED",
          dailyBudget: null,
          lifetimeBudget: null,
          startTime: null,
          stopTime: null,
        });
      const res = await request(app).post(
        `/api/ads/drafts/${draftRes.body.id}/approve`,
      );
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("applied");
      expect(res.body.verifyStatus).toBe("verified");
      expect(mockUpdateCreative).toHaveBeenCalledWith(
        "li-ads-token",
        "512345678",
        "777",
        { status: "ARCHIVED" },
      );
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("expires a creative status draft when the creative drifted remotely", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      mockReadCreativeState.mockResolvedValue({
        name: "urn:li:share:555",
        status: "ACTIVE",
        dailyBudget: null,
        lifetimeBudget: null,
        startTime: null,
        stopTime: null,
      });
      actAs(tenant.clerkUserId);
      const draftRes = await request(app).post("/api/ads/drafts").send({
        connectionId,
        targetType: "creative",
        action: "update",
        targetId: "777",
        status: "PAUSED",
      });
      expect(draftRes.status).toBe(201);

      // Someone paused it in Campaign Manager after the draft was made.
      mockReadCreativeState.mockResolvedValue({
        name: "urn:li:share:555",
        status: "PAUSED",
        dailyBudget: null,
        lifetimeBudget: null,
        startTime: null,
        stopTime: null,
      });
      const res = await request(app).post(
        `/api/ads/drafts/${draftRes.body.id}/approve`,
      );
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("expired");
      expect(res.body.failureReason).toContain("changed on the ad platform");
      expect(mockUpdateCreative).not.toHaveBeenCalled();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("rejects non-status fields on creative updates and ARCHIVED elsewhere", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      actAs(tenant.clerkUserId);

      const withName = await request(app).post("/api/ads/drafts").send({
        connectionId,
        targetType: "creative",
        action: "update",
        targetId: "777",
        status: "PAUSED",
        name: "Renamed",
      });
      expect(withName.status).toBe(400);
      expect(withName.body.error).toContain("status changes");

      const noStatus = await request(app).post("/api/ads/drafts").send({
        connectionId,
        targetType: "creative",
        action: "update",
        targetId: "777",
      });
      expect(noStatus.status).toBe(400);
      expect(noStatus.body.error).toContain("status is required");

      const archivedCampaign = await request(app).post("/api/ads/drafts").send({
        connectionId,
        targetType: "campaign",
        action: "update",
        targetId: "cmp_1",
        status: "ARCHIVED",
      });
      expect(archivedCampaign.status).toBe(400);
      expect(archivedCampaign.body.error).toContain("archived");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("lists creatives in the campaign detail ads array", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      mockGetCampaign.mockResolvedValue({
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
        metrics: undefined,
      } as never);
      mockListCreatives.mockResolvedValue([
        {
          id: "urn:li:sponsoredCreative:777",
          status: "PAUSED",
          reviewStatus: "PENDING",
          rejectionReasons: [],
          postUrn: "urn:li:ugcPost:111",
        } as never,
        {
          id: "urn:li:sponsoredCreative:888",
          status: "ACTIVE",
          reviewStatus: null,
          rejectionReasons: [],
          postUrn: null,
        } as never,
        {
          id: "urn:li:sponsoredCreative:999",
          status: "PAUSED",
          reviewStatus: "REJECTED",
          rejectionReasons: ["EXCESSIVE_CAPITALIZATION", "PROHIBITED_CONTENT"],
          postUrn: null,
        } as never,
      ]);
      mockReadPostPreview.mockResolvedValue({
        text: "Fresh roasted beans, delivered.",
        imageUrl: "https://media.licdn.example/img.jpg",
      });
      actAs(tenant.clerkUserId);
      const res = await request(app)
        .get("/api/ads/campaign-detail")
        .query({ connectionId, campaignId: "cmp_1" });
      expect(res.status).toBe(200);
      expect(res.body.ads).toHaveLength(3);
      expect(res.body.ads[0].id).toBe("urn:li:sponsoredCreative:777");
      expect(res.body.ads[0].status).toBe("PAUSED");
      expect(res.body.ads[0].reviewStatus).toBe("PENDING");
      expect(res.body.ads[0].rejectionReasons).toEqual([]);
      expect(res.body.ads[1].reviewStatus).toBeNull();
      expect(res.body.ads[2].reviewStatus).toBe("REJECTED");
      expect(res.body.ads[2].rejectionReasons).toEqual([
        "EXCESSIVE_CAPITALIZATION",
        "PROHIBITED_CONTENT",
      ]);
      expect(res.body.ads[0].text).toBe("Fresh roasted beans, delivered.");
      expect(res.body.ads[0].imageUrl).toBe("https://media.licdn.example/img.jpg");
      // Creative without a resolvable post falls back to nulls.
      expect(res.body.ads[1].text).toBeNull();
      expect(res.body.ads[1].imageUrl).toBeNull();
      // Only the creative with a post URN triggered a post read.
      expect(mockReadPostPreview).toHaveBeenCalledTimes(1);
      expect(mockReadPostPreview).toHaveBeenCalledWith(
        expect.any(String),
        "urn:li:ugcPost:111",
      );
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});

describe("LinkedIn location targeting", () => {
  it("searches geo locations through the typeahead endpoint", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      mockGeoSearch.mockResolvedValue([
        { urn: "urn:li:geo:102713980", name: "India" },
      ]);
      actAs(tenant.clerkUserId);
      const res = await request(app)
        .get("/api/ads/linkedin/geo-search")
        .query({ connectionId, q: "ind" });
      expect(res.status).toBe(200);
      expect(res.body.results).toEqual([
        { urn: "urn:li:geo:102713980", name: "India" },
      ]);

      const shortQ = await request(app)
        .get("/api/ads/linkedin/geo-search")
        .query({ connectionId, q: "i" });
      expect(shortQ.status).toBe(400);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("flags authLost and marks the connection failed when geo search hits a dead grant", async () => {
    const tenant = await createTenant();
    try {
      // No refresh token stored → an auth failure is definitive.
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      mockGeoSearch.mockRejectedValue(
        new LinkedinAdsApiError("Token revoked", 401, true),
      );
      actAs(tenant.clerkUserId);
      const res = await request(app)
        .get("/api/ads/linkedin/geo-search")
        .query({ connectionId, q: "ind" });
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

  it("does not flag authLost when geo search fails for a non-auth reason", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      mockGeoSearch.mockRejectedValue(
        new LinkedinAdsApiError("LinkedIn is down", 500, false),
      );
      actAs(tenant.clerkUserId);
      const res = await request(app)
        .get("/api/ads/linkedin/geo-search")
        .query({ connectionId, q: "ind" });
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

  it("drafts and applies a targeting change with valid geo URNs", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      actAs(tenant.clerkUserId);
      const draftRes = await request(app).post("/api/ads/drafts").send({
        connectionId,
        targetType: "campaign",
        action: "update",
        targetId: "cmp_1",
        targetingLocations: [
          { urn: "urn:li:geo:102713980", name: "India" },
          { urn: "urn:li:geo:103644278", name: "United States" },
        ],
      });
      expect(draftRes.status).toBe(201);
      const changes = draftRes.body.changes as { field: string; after: string }[];
      const loc = changes.find((c) => c.field === "Target locations");
      expect(loc?.after).toBe("India, United States");

      const res = await request(app).post(
        `/api/ads/drafts/${draftRes.body.id}/approve`,
      );
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("applied");
      expect(mockUpdate).toHaveBeenCalledTimes(1);
      const params = mockUpdate.mock.calls[0]![3] as unknown as Record<string, unknown>;
      expect(params.targetingFacets).toEqual({
        locations: ["urn:li:geo:102713980", "urn:li:geo:103644278"],
        industries: [],
        jobFunctions: [],
        titles: [],
      });
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("rejects malformed geo URNs", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      actAs(tenant.clerkUserId);
      const res = await request(app).post("/api/ads/drafts").send({
        connectionId,
        targetType: "campaign",
        action: "update",
        targetId: "cmp_1",
        targetingLocations: [{ urn: "urn:li:organization:1", name: "Nope" }],
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("valid LinkedIn URN");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});

describe("LinkedIn facet targeting (industries, job functions, titles)", () => {
  it("searches targeting entities per facet through the typeahead endpoint", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      mockTargetingSearch.mockResolvedValue([
        { urn: "urn:li:industry:4", name: "Software Development" },
      ]);
      actAs(tenant.clerkUserId);
      const res = await request(app)
        .get("/api/ads/linkedin/targeting-search")
        .query({ connectionId, facet: "industries", q: "soft" });
      expect(res.status).toBe(200);
      expect(res.body.results).toEqual([
        { urn: "urn:li:industry:4", name: "Software Development" },
      ]);
      expect(mockTargetingSearch).toHaveBeenCalledWith(
        "li-ads-token",
        "industries",
        "soft",
      );

      const badFacet = await request(app)
        .get("/api/ads/linkedin/targeting-search")
        .query({ connectionId, facet: "companies", q: "soft" });
      expect(badFacet.status).toBe(400);

      const shortQ = await request(app)
        .get("/api/ads/linkedin/targeting-search")
        .query({ connectionId, facet: "industries", q: "s" });
      expect(shortQ.status).toBe(400);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("flags authLost and marks the connection failed when targeting search hits a dead grant", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      mockTargetingSearch.mockRejectedValue(
        new LinkedinAdsApiError("Token revoked", 401, true),
      );
      actAs(tenant.clerkUserId);
      const res = await request(app)
        .get("/api/ads/linkedin/targeting-search")
        .query({ connectionId, facet: "industries", q: "soft" });
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

  it("returns the campaign's current targeting with names resolved from URNs", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      mockGetCampaign.mockResolvedValue({
        id: "cmp_1",
        name: "Brand Push",
        status: "ACTIVE",
        effectiveStatus: "ACTIVE",
        objective: null,
        dailyBudget: 5000,
        lifetimeBudget: null,
        startTime: null,
        stopTime: null,
        campaignGroupId: null,
        targetingLocations: ["urn:li:geo:102713980"],
        targetingIndustries: ["urn:li:industry:4"],
        targetingJobFunctions: [],
        targetingTitles: ["urn:li:title:100"],
      });
      mockResolveNames.mockResolvedValue(
        new Map([
          ["urn:li:geo:102713980", "India"],
          ["urn:li:industry:4", "Software Development"],
        ]),
      );
      actAs(tenant.clerkUserId);
      const res = await request(app)
        .get("/api/ads/linkedin/campaign-targeting")
        .query({ connectionId, campaignId: "cmp_1" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        locations: [{ urn: "urn:li:geo:102713980", name: "India" }],
        industries: [{ urn: "urn:li:industry:4", name: "Software Development" }],
        jobFunctions: [],
        // Unresolvable URNs fall back to the raw URN.
        titles: [{ urn: "urn:li:title:100", name: "urn:li:title:100" }],
      });
      expect(mockResolveNames).toHaveBeenCalledWith("li-ads-token", [
        "urn:li:geo:102713980",
        "urn:li:industry:4",
        "urn:li:title:100",
      ]);

      const missingId = await request(app)
        .get("/api/ads/linkedin/campaign-targeting")
        .query({ connectionId });
      expect(missingId.status).toBe(400);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("skips the name lookup when the campaign has no targeting and flags authLost on dead grants", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      mockGetCampaign.mockResolvedValueOnce({
        id: "cmp_1",
        name: "Brand Push",
        status: "ACTIVE",
        effectiveStatus: "ACTIVE",
        objective: null,
        dailyBudget: 5000,
        lifetimeBudget: null,
        startTime: null,
        stopTime: null,
        campaignGroupId: null,
        targetingLocations: [],
        targetingIndustries: [],
        targetingJobFunctions: [],
        targetingTitles: [],
      });
      mockResolveNames.mockClear();
      actAs(tenant.clerkUserId);
      const empty = await request(app)
        .get("/api/ads/linkedin/campaign-targeting")
        .query({ connectionId, campaignId: "cmp_1" });
      expect(empty.status).toBe(200);
      expect(empty.body).toEqual({
        locations: [],
        industries: [],
        jobFunctions: [],
        titles: [],
      });
      expect(mockResolveNames).not.toHaveBeenCalled();

      mockGetCampaign.mockRejectedValueOnce(
        new LinkedinAdsApiError("Token revoked", 401, true),
      );
      const dead = await request(app)
        .get("/api/ads/linkedin/campaign-targeting")
        .query({ connectionId, campaignId: "cmp_1" });
      expect(dead.status).toBe(502);
      expect(dead.body.authLost).toBe(true);

      const [conn] = await db
        .select()
        .from(adAccountConnectionsTable)
        .where(eq(adAccountConnectionsTable.id, connectionId));
      expect(conn!.verifyStatus).toBe("failed");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("drafts, diffs, and applies an industry + title change while preserving untouched facets", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      const beforeState = {
        ...REMOTE_STATE,
        targetingLocations: ["urn:li:geo:102713980"],
        targetingJobFunctions: ["urn:li:function:12"],
      };
      mockReadState.mockResolvedValueOnce(beforeState); // draft creation read
      mockReadState.mockResolvedValueOnce(beforeState); // approve drift check
      mockReadState.mockResolvedValue({
        ...beforeState,
        targetingIndustries: ["urn:li:industry:4"],
        targetingTitles: ["urn:li:title:100"],
      }); // post-apply verify read
      actAs(tenant.clerkUserId);
      const draftRes = await request(app).post("/api/ads/drafts").send({
        connectionId,
        targetType: "campaign",
        action: "update",
        targetId: "cmp_1",
        targetingIndustries: [
          { urn: "urn:li:industry:4", name: "Software Development" },
        ],
        targetingTitles: [{ urn: "urn:li:title:100", name: "Product Manager" }],
      });
      expect(draftRes.status).toBe(201);
      const changes = draftRes.body.changes as { field: string; after: string }[];
      expect(changes.find((c) => c.field === "Target industries")?.after).toBe(
        "Software Development",
      );
      expect(changes.find((c) => c.field === "Target job titles")?.after).toBe(
        "Product Manager",
      );
      expect(changes.find((c) => c.field === "Target locations")).toBeUndefined();
      expect(changes.find((c) => c.field === "Target job functions")).toBeUndefined();

      const res = await request(app).post(
        `/api/ads/drafts/${draftRes.body.id}/approve`,
      );
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("applied");
      expect(res.body.verifyStatus).toBe("verified");
      expect(mockUpdate).toHaveBeenCalledTimes(1);
      const params = mockUpdate.mock.calls[0]![3] as unknown as Record<string, unknown>;
      expect(params.targetingFacets).toEqual({
        locations: ["urn:li:geo:102713980"],
        industries: ["urn:li:industry:4"],
        jobFunctions: ["urn:li:function:12"],
        titles: ["urn:li:title:100"],
      });
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("clears a facet with an empty array", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      mockReadState.mockResolvedValue({
        ...REMOTE_STATE,
        targetingLocations: ["urn:li:geo:102713980"],
        targetingIndustries: ["urn:li:industry:4"],
      });
      actAs(tenant.clerkUserId);
      const draftRes = await request(app).post("/api/ads/drafts").send({
        connectionId,
        targetType: "campaign",
        action: "update",
        targetId: "cmp_1",
        targetingIndustries: [],
      });
      expect(draftRes.status).toBe(201);
      const changes = draftRes.body.changes as { field: string; after: string }[];
      expect(changes.find((c) => c.field === "Target industries")?.after).toBe(
        "(none)",
      );

      const res = await request(app).post(
        `/api/ads/drafts/${draftRes.body.id}/approve`,
      );
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("applied");
      const params = mockUpdate.mock.calls[0]![3] as unknown as Record<string, unknown>;
      expect(params.targetingFacets).toEqual({
        locations: ["urn:li:geo:102713980"],
        industries: [],
        jobFunctions: [],
        titles: [],
      });
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("rejects a draft whose merged targeting would leave the campaign with no locations", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      // Current remote state has NO target locations (default REMOTE_STATE),
      // so an industries-only draft would wipe locations after the merge.
      actAs(tenant.clerkUserId);
      const res = await request(app).post("/api/ads/drafts").send({
        connectionId,
        targetType: "campaign",
        action: "update",
        targetId: "cmp_1",
        targetingIndustries: [
          { urn: "urn:li:industry:4", name: "Software Development" },
        ],
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("no target locations");
      expect(res.body.error).toContain("at least one location");

      const drafts = await db
        .select()
        .from(adChangeRequestsTable)
        .where(eq(adChangeRequestsTable.tenantId, tenant.tenantId));
      expect(drafts).toHaveLength(0);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("stores existing locations in the draft payload when only industries change", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      mockReadState.mockResolvedValue({
        ...REMOTE_STATE,
        targetingLocations: ["urn:li:geo:102713980"],
      });
      actAs(tenant.clerkUserId);
      const res = await request(app).post("/api/ads/drafts").send({
        connectionId,
        targetType: "campaign",
        action: "update",
        targetId: "cmp_1",
        targetingIndustries: [
          { urn: "urn:li:industry:4", name: "Software Development" },
        ],
      });
      expect(res.status).toBe(201);

      const [draft] = await db
        .select()
        .from(adChangeRequestsTable)
        .where(eq(adChangeRequestsTable.id, res.body.id));
      const payload = draft!.payload as Record<string, unknown>;
      expect(payload.targetingFacets).toEqual({
        locations: ["urn:li:geo:102713980"],
        industries: ["urn:li:industry:4"],
        jobFunctions: [],
        titles: [],
      });
      expect(payload.targetingLocations).toBeUndefined();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("rejects facet targeting on create drafts and malformed facet URNs", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      actAs(tenant.clerkUserId);
      const createRes = await request(app).post("/api/ads/drafts").send({
        connectionId,
        targetType: "campaign",
        action: "create",
        name: "New Campaign",
        campaignGroupId: "grp_1",
        dailyBudget: 1000,
        targetingIndustries: [
          { urn: "urn:li:industry:4", name: "Software Development" },
        ],
      });
      expect(createRes.status).toBe(400);
      expect(createRes.body.error).toContain("existing campaign");

      const badUrn = await request(app).post("/api/ads/drafts").send({
        connectionId,
        targetType: "campaign",
        action: "update",
        targetId: "cmp_1",
        targetingIndustries: [{ urn: "urn:li:geo:1", name: "Nope" }],
      });
      expect(badUrn.status).toBe(400);
      expect(badUrn.body.error).toContain("valid LinkedIn URN");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});

describe("LinkedIn campaign-detail auth-failure gating", () => {
  function farFutureCreds(refresh?: { refreshToken: string }) {
    return {
      accessToken: "li-ads-token",
      expiresAt: Date.now() + LINKEDIN_ADS_REFRESH_WINDOW_MS + 10 * 24 * 60 * 60 * 1000,
      ...(refresh ?? {}),
    };
  }

  function refreshResponse(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  }

  it("does NOT mark the connection failed on API 401 when the refresh attempt fails transiently", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId, {
        encryptedCredentials: encryptJson(
          farFutureCreds({ refreshToken: "still-valid-refresh" }),
        ),
      });
      mockGetCampaign.mockRejectedValue(
        new LinkedinAdsApiError("Token expired", 401, true),
      );
      mockPlatformFetch.mockResolvedValue(refreshResponse(503, {}));

      actAs(tenant.clerkUserId);
      const res = await request(app)
        .get("/api/ads/campaign-detail")
        .query({ connectionId: String(connectionId), campaignId: "cmp_1" });
      expect(res.status).toBe(502);

      const [conn] = await db
        .select()
        .from(adAccountConnectionsTable)
        .where(eq(adAccountConnectionsTable.id, connectionId));
      expect(conn!.verifyStatus).toBe("verified");
      expect(mockPlatformFetch).toHaveBeenCalledTimes(1);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("marks the connection failed on API 401 when the refresh token is definitively rejected", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId, {
        encryptedCredentials: encryptJson(
          farFutureCreds({ refreshToken: "dead-refresh" }),
        ),
      });
      mockGetCampaign.mockRejectedValue(
        new LinkedinAdsApiError("Token revoked", 401, true),
      );
      mockPlatformFetch.mockResolvedValue(
        refreshResponse(400, { error: "invalid_grant" }),
      );

      actAs(tenant.clerkUserId);
      const res = await request(app)
        .get("/api/ads/campaign-detail")
        .query({ connectionId: String(connectionId), campaignId: "cmp_1" });
      expect(res.status).toBe(502);

      const [conn] = await db
        .select()
        .from(adAccountConnectionsTable)
        .where(eq(adAccountConnectionsTable.id, connectionId));
      expect(conn!.verifyStatus).toBe("failed");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("renews the token instead of failing when the refresh succeeds after an API 401", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId, {
        encryptedCredentials: encryptJson(
          farFutureCreds({ refreshToken: "good-refresh" }),
        ),
      });
      mockGetCampaign.mockRejectedValue(
        new LinkedinAdsApiError("Token expired", 401, true),
      );
      mockPlatformFetch.mockResolvedValue(
        refreshResponse(200, { access_token: "renewed", expires_in: 5184000 }),
      );

      actAs(tenant.clerkUserId);
      const res = await request(app)
        .get("/api/ads/campaign-detail")
        .query({ connectionId: String(connectionId), campaignId: "cmp_1" });
      expect(res.status).toBe(502);

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

describe("GET /ads/connections auto re-verify (linkedin)", () => {
  it("flips a stale linkedin connection with an expired, unrefreshable token to failed on page load", async () => {
    const tenant = await createTenant();
    try {
      // verifiedAt null => stale; expiresAt in the past with no refresh token
      // is a definitive failure that needs no live call.
      await insertLinkedinAdConnection(tenant.tenantId, {
        encryptedCredentials: encryptJson({
          accessToken: "li-ads-token",
          expiresAt: Date.now() - 1000,
        }),
      });
      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/ads/connections");
      expect(res.status).toBe(200);
      const linkedin = res.body.find(
        (c: { platform: string }) => c.platform === "linkedin",
      );
      expect(linkedin.verifyStatus).toBe("failed");
      expect(mockReadAccount).not.toHaveBeenCalled();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("re-probes a stale linkedin connection and keeps it verified when the grant is alive", async () => {
    const tenant = await createTenant();
    try {
      await insertLinkedinAdConnection(tenant.tenantId); // verifiedAt null => stale
      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/ads/connections");
      expect(res.status).toBe(200);
      const linkedin = res.body.find(
        (c: { platform: string }) => c.platform === "linkedin",
      );
      expect(linkedin.verifyStatus).toBe("verified");
      expect(mockReadAccount).toHaveBeenCalledTimes(1);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("skips the re-check when the linkedin connection was verified recently", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      await db
        .update(adAccountConnectionsTable)
        .set({ verifiedAt: new Date() })
        .where(eq(adAccountConnectionsTable.id, connectionId));
      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/ads/connections");
      expect(res.status).toBe(200);
      expect(mockReadAccount).not.toHaveBeenCalled();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("keeps a verified linkedin status when the re-check fails transiently", async () => {
    const tenant = await createTenant();
    try {
      await insertLinkedinAdConnection(tenant.tenantId);
      mockReadAccount.mockRejectedValue(
        new LinkedinAdsApiError("LinkedIn is down", 500, false),
      );
      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/ads/connections");
      expect(res.status).toBe(200);
      const linkedin = res.body.find(
        (c: { platform: string }) => c.platform === "linkedin",
      );
      expect(linkedin.verifyStatus).toBe("verified");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});

describe("Legacy campaign group name resolution", () => {
  it("resolves a raw-id Campaign group field in older drafts at read time", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      await db.insert(adChangeRequestsTable).values({
        tenantId: tenant.tenantId,
        connectionId,
        platform: "linkedin",
        targetType: "campaign",
        targetId: null,
        targetName: "Old Draft",
        action: "create",
        changes: [
          { field: "Name", before: null, after: "Old Draft" },
          { field: "Status", before: null, after: "PAUSED" },
          { field: "Campaign group", before: null, after: "grp_1" },
        ],
        payload: { campaignGroupId: "grp_1", name: "Old Draft" },
        status: "draft",
        idempotencyKey: randomUUID(),
        createdByClerkUserId: tenant.clerkUserId,
      });

      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/ads/drafts");
      expect(res.status).toBe(200);
      const draft = res.body.find(
        (d: { targetName: string }) => d.targetName === "Old Draft",
      );
      expect(draft).toBeDefined();
      const groupChange = (
        draft.changes as { field: string; after: string | null; afterDetail?: string | null }[]
      ).find((c) => c.field === "Campaign group");
      expect(groupChange!.after).toBe("Always On");
      expect(groupChange!.afterDetail).toBe("grp_1");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("caches group name lookups so repeated page loads don't re-hit LinkedIn", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      await db.insert(adChangeRequestsTable).values({
        tenantId: tenant.tenantId,
        connectionId,
        platform: "linkedin",
        targetType: "campaign",
        targetId: null,
        targetName: "Cached Draft",
        action: "create",
        changes: [
          { field: "Name", before: null, after: "Cached Draft" },
          { field: "Status", before: null, after: "PAUSED" },
          { field: "Campaign group", before: null, after: "grp_1" },
        ],
        payload: { campaignGroupId: "grp_1", name: "Cached Draft" },
        status: "draft",
        idempotencyKey: randomUUID(),
        createdByClerkUserId: tenant.clerkUserId,
      });
      await db.insert(adsChangeLogsTable).values({
        tenantId: tenant.tenantId,
        platform: "linkedin",
        targetType: "campaign",
        targetId: "cmp_9",
        targetName: "Cached Applied",
        action: "create",
        changes: [
          { field: "Name", before: null, after: "Cached Applied" },
          { field: "Campaign group", before: null, after: "grp_1" },
        ],
        outcome: "applied",
        verifyStatus: "verified",
      });

      actAs(tenant.clerkUserId);
      const first = await request(app).get("/api/ads/drafts");
      expect(first.status).toBe(200);
      expect(mockListGroups).toHaveBeenCalledTimes(1);

      // Second drafts load and a change-log load within the TTL reuse the cache.
      const second = await request(app).get("/api/ads/drafts");
      expect(second.status).toBe(200);
      const log = await request(app).get("/api/ads/change-log");
      expect(log.status).toBe(200);
      expect(mockListGroups).toHaveBeenCalledTimes(1);

      // Names still resolve from the cache.
      const draft = second.body.find(
        (d: { targetName: string }) => d.targetName === "Cached Draft",
      );
      const groupChange = (
        draft.changes as { field: string; after: string | null; afterDetail?: string | null }[]
      ).find((c) => c.field === "Campaign group");
      expect(groupChange!.after).toBe("Always On");
      expect(groupChange!.afterDetail).toBe("grp_1");

      // An expired/cleared cache re-hits LinkedIn.
      clearLinkedinGroupNamesCache();
      const third = await request(app).get("/api/ads/drafts");
      expect(third.status).toBe(200);
      expect(mockListGroups).toHaveBeenCalledTimes(2);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("does not cache failed lookups — the next load retries LinkedIn", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      await db.insert(adChangeRequestsTable).values({
        tenantId: tenant.tenantId,
        connectionId,
        platform: "linkedin",
        targetType: "campaign",
        targetId: null,
        targetName: "Retry Draft",
        action: "create",
        changes: [
          { field: "Name", before: null, after: "Retry Draft" },
          { field: "Status", before: null, after: "PAUSED" },
          { field: "Campaign group", before: null, after: "grp_1" },
        ],
        payload: { campaignGroupId: "grp_1", name: "Retry Draft" },
        status: "draft",
        idempotencyKey: randomUUID(),
        createdByClerkUserId: tenant.clerkUserId,
      });

      actAs(tenant.clerkUserId);
      mockListGroups.mockRejectedValueOnce(
        new LinkedinAdsApiError("boom", 500, false),
      );
      const failed = await request(app).get("/api/ads/drafts");
      expect(failed.status).toBe(200);
      const rawDraft = failed.body.find(
        (d: { targetName: string }) => d.targetName === "Retry Draft",
      );
      const rawChange = (
        rawDraft.changes as { field: string; after: string | null }[]
      ).find((c) => c.field === "Campaign group");
      expect(rawChange!.after).toBe("grp_1");

      // Failure was not cached: the next load retries and resolves.
      const retried = await request(app).get("/api/ads/drafts");
      expect(retried.status).toBe(200);
      expect(mockListGroups).toHaveBeenCalledTimes(2);
      const draft = retried.body.find(
        (d: { targetName: string }) => d.targetName === "Retry Draft",
      );
      const groupChange = (
        draft.changes as { field: string; after: string | null; afterDetail?: string | null }[]
      ).find((c) => c.field === "Campaign group");
      expect(groupChange!.after).toBe("Always On");
      expect(groupChange!.afterDetail).toBe("grp_1");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("adds a resolved Campaign group field to very old drafts that stored none", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      await db.insert(adChangeRequestsTable).values({
        tenantId: tenant.tenantId,
        connectionId,
        platform: "linkedin",
        targetType: "campaign",
        targetId: null,
        targetName: "Ancient Draft",
        action: "create",
        changes: [
          { field: "Name", before: null, after: "Ancient Draft" },
          { field: "Status", before: null, after: "PAUSED" },
          { field: "Daily budget", before: null, after: "100.00 USD" },
        ],
        payload: { campaignGroupId: "grp_1", name: "Ancient Draft" },
        status: "draft",
        idempotencyKey: randomUUID(),
        createdByClerkUserId: tenant.clerkUserId,
      });

      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/ads/drafts");
      expect(res.status).toBe(200);
      const draft = res.body.find(
        (d: { targetName: string }) => d.targetName === "Ancient Draft",
      );
      const changes = draft.changes as {
        field: string;
        after: string | null;
        afterDetail?: string | null;
      }[];
      // Inserted after Name and Status, matching buildCreateDiff ordering.
      expect(changes[2]!.field).toBe("Campaign group");
      expect(changes[2]!.after).toBe("Always On");
      expect(changes[2]!.afterDetail).toBe("grp_1");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("falls back to the stored raw id when the lookup cannot resolve it", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      mockListGroups.mockRejectedValue(new LinkedinAdsApiError("boom", 500, false));
      await db.insert(adChangeRequestsTable).values({
        tenantId: tenant.tenantId,
        connectionId,
        platform: "linkedin",
        targetType: "campaign",
        targetId: null,
        targetName: "Unresolvable Draft",
        action: "create",
        changes: [
          { field: "Name", before: null, after: "Unresolvable Draft" },
          { field: "Status", before: null, after: "PAUSED" },
          { field: "Campaign group", before: null, after: "grp_gone" },
        ],
        payload: { campaignGroupId: "grp_gone", name: "Unresolvable Draft" },
        status: "draft",
        idempotencyKey: randomUUID(),
        createdByClerkUserId: tenant.clerkUserId,
      });

      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/ads/drafts");
      expect(res.status).toBe(200);
      const draft = res.body.find(
        (d: { targetName: string }) => d.targetName === "Unresolvable Draft",
      );
      const groupChange = (
        draft.changes as { field: string; after: string | null; afterDetail?: string | null }[]
      ).find((c) => c.field === "Campaign group");
      expect(groupChange!.after).toBe("grp_gone");
      expect(groupChange!.afterDetail ?? null).toBeNull();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("inserts the raw-id Campaign group field even when the lookup fails entirely", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertLinkedinAdConnection(tenant.tenantId);
      mockListGroups.mockRejectedValue(new LinkedinAdsApiError("boom", 500, false));
      await db.insert(adChangeRequestsTable).values({
        tenantId: tenant.tenantId,
        connectionId,
        platform: "linkedin",
        targetType: "campaign",
        targetId: null,
        targetName: "Ancient Unresolvable",
        action: "create",
        changes: [
          { field: "Name", before: null, after: "Ancient Unresolvable" },
          { field: "Status", before: null, after: "PAUSED" },
        ],
        payload: { campaignGroupId: "grp_gone", name: "Ancient Unresolvable" },
        status: "draft",
        idempotencyKey: randomUUID(),
        createdByClerkUserId: tenant.clerkUserId,
      });

      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/ads/drafts");
      expect(res.status).toBe(200);
      const draft = res.body.find(
        (d: { targetName: string }) => d.targetName === "Ancient Unresolvable",
      );
      const changes = draft.changes as {
        field: string;
        after: string | null;
        afterDetail?: string | null;
      }[];
      expect(changes[2]!.field).toBe("Campaign group");
      expect(changes[2]!.after).toBe("grp_gone");
      expect(changes[2]!.afterDetail ?? null).toBeNull();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("resolves raw-id Campaign group fields in older change-log entries", async () => {
    const tenant = await createTenant();
    try {
      await insertLinkedinAdConnection(tenant.tenantId);
      await db.insert(adsChangeLogsTable).values({
        tenantId: tenant.tenantId,
        platform: "linkedin",
        targetType: "campaign",
        targetId: "cmp_9",
        targetName: "Old Applied",
        action: "create",
        changes: [
          { field: "Name", before: null, after: "Old Applied" },
          { field: "Campaign group", before: null, after: "grp_1" },
        ],
        outcome: "applied",
        verifyStatus: "verified",
      });

      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/ads/change-log");
      expect(res.status).toBe(200);
      const entry = res.body.find(
        (e: { targetName: string }) => e.targetName === "Old Applied",
      );
      expect(entry).toBeDefined();
      const groupChange = (
        entry.changes as { field: string; after: string | null; afterDetail?: string | null }[]
      ).find((c) => c.field === "Campaign group");
      expect(groupChange!.after).toBe("Always On");
      expect(groupChange!.afterDetail).toBe("grp_1");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});
