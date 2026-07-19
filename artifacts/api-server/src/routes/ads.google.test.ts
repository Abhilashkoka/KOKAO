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
    listCustomerChoices: vi.fn(),
    readCustomer: vi.fn(),
    isGoogleAdsConfigured: vi.fn(),
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
  getGoogleAdsAuth,
  readGoogleCampaignState,
  updateGoogleCampaign,
  createGoogleCampaign,
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
