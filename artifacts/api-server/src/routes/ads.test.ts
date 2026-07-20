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

// Stub only the Graph network functions; DB-backed engine logic stays real.
vi.mock("../lib/metaAdsApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/metaAdsApi")>();
  return {
    ...actual,
    readObjectState: vi.fn(),
    updateObject: vi.fn(),
    createCampaign: vi.fn(),
    listAdAccounts: vi.fn(),
    readAdAccount: vi.fn(),
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
  readObjectState,
  updateObject,
  createCampaign,
  readAdAccount,
  MetaAdsApiError,
} from "../lib/metaAdsApi";
import { encryptJson } from "../lib/secretCrypto";
import { requireTenant } from "../middlewares/requireTenant";
import adsRouter from "./ads";
import { resetAuthState, actAs } from "../test/authState";
import { createTenant, deleteTenant } from "../test/dbHelpers";
import { tenantsTable } from "@workspace/db";

const mockRead = vi.mocked(readObjectState);
const mockUpdate = vi.mocked(updateObject);
const mockCreate = vi.mocked(createCampaign);
const mockReadAdAccount = vi.mocked(readAdAccount);

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
  name: "Summer Sale",
  status: "PAUSED",
  dailyBudget: 5000,
  lifetimeBudget: null,
  startTime: null,
  stopTime: null,
};

async function insertMetaAdConnection(tenantId: number): Promise<number> {
  const [row] = await db
    .insert(adAccountConnectionsTable)
    .values({
      tenantId,
      platform: "meta",
      status: "connected",
      adAccountId: "act_123",
      adAccountName: "Test Ad Account",
      currency: "INR",
      verifyStatus: "verified",
      encryptedCredentials: encryptJson({ accessToken: "ads-token" }),
    })
    .returning({ id: adAccountConnectionsTable.id });
  return row!.id;
}

async function insertGoogleAdConnection(tenantId: number): Promise<number> {
  const [row] = await db
    .insert(adAccountConnectionsTable)
    .values({
      tenantId,
      platform: "google",
      status: "connected",
      adAccountId: "1234567890",
      adAccountName: "Test Google Ads Account",
      currency: "INR",
      verifyStatus: "verified",
      encryptedCredentials: encryptJson({ refreshToken: "g-refresh" }),
    })
    .returning({ id: adAccountConnectionsTable.id });
  return row!.id;
}

async function addMember(
  tenantId: number,
  role: "admin" | "member",
): Promise<{ clerkUserId: string }> {
  const clerkUserId = `test_ads_member_${randomUUID()}`;
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
  const res = await request(app)
    .post("/api/ads/drafts")
    .send({
      connectionId,
      targetType: "campaign",
      action: "update",
      targetId: "camp_1",
      status: "ACTIVE",
      dailyBudget: 7000,
      ...overrides,
    });
  return res;
}

beforeEach(async () => {
  resetAuthState();
  mockRead.mockReset();
  mockUpdate.mockReset();
  mockCreate.mockReset();
  mockRead.mockResolvedValue({ ...REMOTE_STATE });
  mockReadAdAccount.mockReset();
  mockReadAdAccount.mockResolvedValue({
    name: "Test Ad Account",
    currency: "INR",
  });
  mockUpdate.mockResolvedValue(undefined as never);
  mockCreate.mockResolvedValue("camp_new_1");
  // The module switch defaults to enabled when no row exists; force-enable to
  // be independent of other suites toggling it.
  await db.delete(adsSettingsTable);
});

afterAll(async () => {
  await db.delete(adsSettingsTable);
  await pool.end();
});

describe("ads draft creation", () => {
  it("captures a before/after diff and snapshot for updates", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertMetaAdConnection(tenant.tenantId);
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

  it("rejects a draft that would change nothing", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertMetaAdConnection(tenant.tenantId);
      const res = await createUpdateDraft(tenant.clerkUserId, connectionId, {
        status: "PAUSED",
        dailyBudget: 5000,
      });
      expect(res.status).toBe(400);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("returns 409 with the existing draft for a duplicate idempotency key", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertMetaAdConnection(tenant.tenantId);
      const key = `test-key-${randomUUID()}`;
      const first = await createUpdateDraft(tenant.clerkUserId, connectionId, {
        idempotencyKey: key,
      });
      expect(first.status).toBe(201);
      const second = await createUpdateDraft(tenant.clerkUserId, connectionId, {
        idempotencyKey: key,
      });
      expect(second.status).toBe(409);
      expect(second.body.id).toBe(first.body.id);
      const rows = await db
        .select()
        .from(adChangeRequestsTable)
        .where(eq(adChangeRequestsTable.tenantId, tenant.tenantId));
      expect(rows.length).toBe(1);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("scopes idempotency keys per tenant: another tenant can reuse the same key", async () => {
    const tenantA = await createTenant();
    const tenantB = await createTenant();
    try {
      const connA = await insertMetaAdConnection(tenantA.tenantId);
      const connB = await insertMetaAdConnection(tenantB.tenantId);
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

  it("returns 503 when the ads module is globally disabled", async () => {
    const tenant = await createTenant();
    try {
      await db.insert(adsSettingsTable).values({ enabled: false });
      const connectionId = await insertMetaAdConnection(tenant.tenantId);
      const res = await createUpdateDraft(tenant.clerkUserId, connectionId);
      expect(res.status).toBe(503);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("gates every tenant ads endpoint (except status) when disabled", async () => {
    const tenant = await createTenant();
    try {
      await db.insert(adsSettingsTable).values({ enabled: false });
      const connectionId = await insertMetaAdConnection(tenant.tenantId);
      actAs(tenant.clerkUserId);

      const status = await request(app).get("/api/ads/status");
      expect(status.status).toBe(200);
      expect(status.body.enabled).toBe(false);

      const gated = [
        request(app).get("/api/ads/connections"),
        request(app).delete(`/api/ads/connections/${connectionId}`),
        request(app).get("/api/ads/connections/meta/accounts"),
        request(app)
          .post("/api/ads/connections/meta/select")
          .send({ adAccountId: "act_123" }),
        request(app).get("/api/ads/campaigns"),
        request(app).get("/api/ads/drafts"),
        request(app).post("/api/ads/drafts/1/approve"),
        request(app).post("/api/ads/drafts/1/reject"),
        request(app).get("/api/ads/change-log"),
      ];
      for (const req of gated) {
        const res = await req;
        expect(res.status).toBe(503);
      }
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});

describe("budget caps", () => {
  it("rejects a draft whose daily budget exceeds the cap", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertMetaAdConnection(tenant.tenantId);
      await db
        .update(tenantsTable)
        .set({ adsMaxDailyBudget: 6000 })
        .where(eq(tenantsTable.id, tenant.tenantId));
      const res = await createUpdateDraft(tenant.clerkUserId, connectionId, {
        dailyBudget: 60000,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/daily budget cap/i);
      const rows = await db
        .select()
        .from(adChangeRequestsTable)
        .where(eq(adChangeRequestsTable.tenantId, tenant.tenantId));
      expect(rows.length).toBe(0);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("rejects a create draft whose lifetime budget exceeds the cap", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertMetaAdConnection(tenant.tenantId);
      await db
        .update(tenantsTable)
        .set({ adsMaxLifetimeBudget: 100000 })
        .where(eq(tenantsTable.id, tenant.tenantId));
      actAs(tenant.clerkUserId);
      const res = await request(app).post("/api/ads/drafts").send({
        connectionId,
        targetType: "campaign",
        action: "create",
        name: "Big spender",
        lifetimeBudget: 1000000,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/lifetime budget cap/i);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("allows a draft at exactly the cap and with no caps set", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertMetaAdConnection(tenant.tenantId);
      await db
        .update(tenantsTable)
        .set({ adsMaxDailyBudget: 7000 })
        .where(eq(tenantsTable.id, tenant.tenantId));
      const atCap = await createUpdateDraft(tenant.clerkUserId, connectionId, {
        dailyBudget: 7000,
      });
      expect(atCap.status).toBe(201);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("only the owner can change caps; members can read them", async () => {
    const tenant = await createTenant();
    try {
      const admin = await addMember(tenant.tenantId, "admin");
      actAs(admin.clerkUserId);
      const forbidden = await request(app)
        .put("/api/ads/budget-caps")
        .send({ maxDailyBudget: 5000, maxLifetimeBudget: null });
      expect(forbidden.status).toBe(403);

      actAs(tenant.clerkUserId);
      const ok = await request(app)
        .put("/api/ads/budget-caps")
        .send({ maxDailyBudget: 5000, maxLifetimeBudget: null });
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ maxDailyBudget: 5000, maxLifetimeBudget: null });

      actAs(admin.clerkUserId);
      const read = await request(app).get("/api/ads/budget-caps");
      expect(read.status).toBe(200);
      expect(read.body.maxDailyBudget).toBe(5000);

      // Clearing caps
      actAs(tenant.clerkUserId);
      const cleared = await request(app)
        .put("/api/ads/budget-caps")
        .send({ maxDailyBudget: null, maxLifetimeBudget: null });
      expect(cleared.status).toBe(200);
      expect(cleared.body).toEqual({ maxDailyBudget: null, maxLifetimeBudget: null });
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("rejects approving a stale draft whose budget exceeds the current cap", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertMetaAdConnection(tenant.tenantId);
      // Draft created while no cap (or a looser cap) is in place.
      const draftRes = await createUpdateDraft(tenant.clerkUserId, connectionId, {
        dailyBudget: 60000,
      });
      expect(draftRes.status).toBe(201);
      const draftId = draftRes.body.id as number;

      // Owner tightens the cap AFTER the draft exists.
      await db
        .update(tenantsTable)
        .set({ adsMaxDailyBudget: 6000 })
        .where(eq(tenantsTable.id, tenant.tenantId));

      actAs(tenant.clerkUserId);
      const res = await request(app).post(`/api/ads/drafts/${draftId}/approve`);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/daily budget cap/i);
      expect(res.body.error).toMatch(/raise the cap/i);
      expect(mockUpdate).not.toHaveBeenCalled();

      // The draft stays pending, untouched.
      const [row] = await db
        .select()
        .from(adChangeRequestsTable)
        .where(eq(adChangeRequestsTable.id, draftId));
      expect(row!.status).toBe("draft");

      // Raising the cap back lets the same draft be approved.
      await db
        .update(tenantsTable)
        .set({ adsMaxDailyBudget: 60000 })
        .where(eq(tenantsTable.id, tenant.tenantId));
      const approved = await request(app).post(`/api/ads/drafts/${draftId}/approve`);
      expect(approved.status).toBe(200);
      expect(approved.body.status).toBe("applied");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("rejects approving a stale draft whose lifetime budget exceeds the current cap", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertMetaAdConnection(tenant.tenantId);
      const draftRes = await createUpdateDraft(tenant.clerkUserId, connectionId, {
        lifetimeBudget: 1000000,
      });
      expect(draftRes.status).toBe(201);
      const draftId = draftRes.body.id as number;

      await db
        .update(tenantsTable)
        .set({ adsMaxLifetimeBudget: 100000 })
        .where(eq(tenantsTable.id, tenant.tenantId));

      actAs(tenant.clerkUserId);
      const res = await request(app).post(`/api/ads/drafts/${draftId}/approve`);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/lifetime budget cap/i);
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

  it("rejects non-positive and fractional cap values", async () => {
    const tenant = await createTenant();
    try {
      actAs(tenant.clerkUserId);
      const zero = await request(app)
        .put("/api/ads/budget-caps")
        .send({ maxDailyBudget: 0, maxLifetimeBudget: null });
      expect(zero.status).toBe(400);
      const fractional = await request(app)
        .put("/api/ads/budget-caps")
        .send({ maxDailyBudget: 500.5, maxLifetimeBudget: null });
      expect(fractional.status).toBe(400);
      const fractionalLifetime = await request(app)
        .put("/api/ads/budget-caps")
        .send({ maxDailyBudget: null, maxLifetimeBudget: 99.9 });
      expect(fractionalLifetime.status).toBe(400);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});

describe("owner-only approval", () => {
  it("rejects approval from an admin team member (403) but allows the owner", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertMetaAdConnection(tenant.tenantId);
      const draftRes = await createUpdateDraft(tenant.clerkUserId, connectionId);
      const draftId = draftRes.body.id as number;

      const admin = await addMember(tenant.tenantId, "admin");
      actAs(admin.clerkUserId);
      const denied = await request(app).post(`/api/ads/drafts/${draftId}/approve`);
      expect(denied.status).toBe(403);

      // The draft was not touched.
      const [row] = await db
        .select()
        .from(adChangeRequestsTable)
        .where(eq(adChangeRequestsTable.id, draftId));
      expect(row!.status).toBe("draft");
      expect(mockUpdate).not.toHaveBeenCalled();

      actAs(tenant.clerkUserId);
      const approved = await request(app).post(`/api/ads/drafts/${draftId}/approve`);
      expect(approved.status).toBe(200);
      expect(approved.body.status).toBe("applied");
      expect(mockUpdate).toHaveBeenCalledTimes(1);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("lets an admin member create drafts but never apply them", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertMetaAdConnection(tenant.tenantId);
      const admin = await addMember(tenant.tenantId, "admin");
      const res = await createUpdateDraft(admin.clerkUserId, connectionId);
      expect(res.status).toBe(201);
      expect(res.body.status).toBe("draft");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});

describe("idempotent apply", () => {
  it("re-approving an applied draft returns its final state without a second platform write", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertMetaAdConnection(tenant.tenantId);
      const draftRes = await createUpdateDraft(tenant.clerkUserId, connectionId);
      const draftId = draftRes.body.id as number;

      // After apply, the read-back should reflect the new values.
      mockRead.mockResolvedValueOnce({ ...REMOTE_STATE }); // drift check
      mockRead.mockResolvedValue({
        ...REMOTE_STATE,
        status: "ACTIVE",
        dailyBudget: 7000,
      });

      actAs(tenant.clerkUserId);
      const first = await request(app).post(`/api/ads/drafts/${draftId}/approve`);
      expect(first.status).toBe(200);
      expect(first.body.status).toBe("applied");
      expect(first.body.verifyStatus).toBe("verified");
      expect(mockUpdate).toHaveBeenCalledTimes(1);

      const replay = await request(app).post(`/api/ads/drafts/${draftId}/approve`);
      expect(replay.status).toBe(200);
      expect(replay.body.status).toBe("applied");
      expect(mockUpdate).toHaveBeenCalledTimes(1); // no second write

      // Exactly one change-log entry.
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

  it("expires a draft when the remote object drifted since drafting", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertMetaAdConnection(tenant.tenantId);
      const draftRes = await createUpdateDraft(tenant.clerkUserId, connectionId);
      const draftId = draftRes.body.id as number;

      // Someone changed the campaign name on Meta in the meantime.
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
});

describe("post-apply verification", () => {
  it("marks the draft as mismatch when the read-back does not reflect the change", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertMetaAdConnection(tenant.tenantId);
      const draftRes = await createUpdateDraft(tenant.clerkUserId, connectionId);
      const draftId = draftRes.body.id as number;

      // Drift check passes, but the post-apply read-back still shows the old
      // values (Meta silently ignored the write).
      mockRead.mockResolvedValue({ ...REMOTE_STATE });

      actAs(tenant.clerkUserId);
      const res = await request(app).post(`/api/ads/drafts/${draftId}/approve`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("applied");
      expect(res.body.verifyStatus).toBe("mismatch");

      const logs = await db
        .select()
        .from(adsChangeLogsTable)
        .where(eq(adsChangeLogsTable.tenantId, tenant.tenantId));
      expect(logs.length).toBe(1);
      expect(logs[0]!.verifyStatus).toBe("mismatch");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("flags a mismatch when a schedule change does not stick on the platform", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertMetaAdConnection(tenant.tenantId);
      const stopTime = "2026-08-01T00:00:00+0000";
      const draftRes = await createUpdateDraft(tenant.clerkUserId, connectionId, {
        status: undefined,
        dailyBudget: undefined,
        stopTime,
      });
      expect(draftRes.status).toBe(201);
      const draftId = draftRes.body.id as number;

      // Drift check sees the original state; the read-back still shows no
      // stop time — Meta ignored the schedule write.
      mockRead.mockResolvedValue({ ...REMOTE_STATE, stopTime: null });

      actAs(tenant.clerkUserId);
      const res = await request(app).post(`/api/ads/drafts/${draftId}/approve`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("applied");
      expect(res.body.verifyStatus).toBe("mismatch");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("verifies a schedule change even when the platform echoes a different timestamp format", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertMetaAdConnection(tenant.tenantId);
      const stopTime = "2026-08-01T00:00:00+0000";
      const draftRes = await createUpdateDraft(tenant.clerkUserId, connectionId, {
        status: undefined,
        dailyBudget: undefined,
        stopTime,
      });
      expect(draftRes.status).toBe(201);
      const draftId = draftRes.body.id as number;

      mockRead.mockResolvedValueOnce({ ...REMOTE_STATE }); // drift check
      // Same instant, different textual offset.
      mockRead.mockResolvedValue({
        ...REMOTE_STATE,
        stopTime: "2026-08-01T05:30:00+05:30",
      });

      actAs(tenant.clerkUserId);
      const res = await request(app).post(`/api/ads/drafts/${draftId}/approve`);
      expect(res.status).toBe(200);
      expect(res.body.verifyStatus).toBe("verified");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("records a failed outcome in the change log when the platform rejects the write", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertMetaAdConnection(tenant.tenantId);
      const draftRes = await createUpdateDraft(tenant.clerkUserId, connectionId);
      const draftId = draftRes.body.id as number;

      mockUpdate.mockRejectedValue(new Error("(#100) Invalid budget"));

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

describe("campaign creation drafts", () => {
  it("creates and applies a new campaign draft end to end", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertMetaAdConnection(tenant.tenantId);
      actAs(tenant.clerkUserId);
      const draftRes = await request(app).post("/api/ads/drafts").send({
        connectionId,
        targetType: "campaign",
        action: "create",
        name: "New Launch",
        objective: "OUTCOME_TRAFFIC",
        dailyBudget: 10000,
      });
      expect(draftRes.status).toBe(201);

      mockRead.mockResolvedValue({
        name: "New Launch",
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
      expect(res.body.resultTargetId).toBe("camp_new_1");
      expect(res.body.verifyStatus).toBe("verified");
      expect(mockCreate).toHaveBeenCalledTimes(1);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});

describe("ad set and ad drafts", () => {
  it("creates an update draft for an ad set and reads state with the adset field set", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertMetaAdConnection(tenant.tenantId);
      mockRead.mockResolvedValue({
        name: "Retargeting",
        status: "PAUSED",
        dailyBudget: 2000,
        lifetimeBudget: null,
        startTime: null,
        stopTime: null,
      });
      actAs(tenant.clerkUserId);
      const res = await request(app).post("/api/ads/drafts").send({
        connectionId,
        targetType: "adset",
        action: "update",
        targetId: "adset_1",
        status: "ACTIVE",
        dailyBudget: 3000,
      });
      expect(res.status).toBe(201);
      expect(res.body.targetType).toBe("adset");
      expect(mockRead).toHaveBeenCalledWith("ads-token", "adset_1", "adset");
      expect(res.body.changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "Status", before: "PAUSED", after: "ACTIVE" }),
          expect.objectContaining({
            field: "Daily budget (minor units)",
            before: "2000",
            after: "3000",
          }),
        ]),
      );
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("applies an approved ad draft and passes the ad target type to reads", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertMetaAdConnection(tenant.tenantId);
      mockRead.mockResolvedValue({
        name: "Blue creative",
        status: "ACTIVE",
        dailyBudget: null,
        lifetimeBudget: null,
        startTime: null,
        stopTime: null,
      });
      actAs(tenant.clerkUserId);
      const draftRes = await request(app).post("/api/ads/drafts").send({
        connectionId,
        targetType: "ad",
        action: "update",
        targetId: "ad_1",
        status: "PAUSED",
      });
      expect(draftRes.status).toBe(201);

      mockRead.mockResolvedValueOnce({
        name: "Blue creative",
        status: "ACTIVE",
        dailyBudget: null,
        lifetimeBudget: null,
        startTime: null,
        stopTime: null,
      });
      mockRead.mockResolvedValueOnce({
        name: "Blue creative",
        status: "PAUSED",
        dailyBudget: null,
        lifetimeBudget: null,
        startTime: null,
        stopTime: null,
      });
      const applied = await request(app).post(
        `/api/ads/drafts/${draftRes.body.id}/approve`,
      );
      expect(applied.status).toBe(200);
      expect(applied.body.status).toBe("applied");
      expect(applied.body.verifyStatus).toBe("verified");
      expect(mockRead).toHaveBeenCalledWith("ads-token", "ad_1", "ad");
      expect(mockUpdate).toHaveBeenCalledTimes(1);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("expires an ad set draft when the remote object drifted, with an ad set message", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertMetaAdConnection(tenant.tenantId);
      mockRead.mockResolvedValue({
        name: "Retargeting",
        status: "PAUSED",
        dailyBudget: 2000,
        lifetimeBudget: null,
        startTime: null,
        stopTime: null,
      });
      actAs(tenant.clerkUserId);
      const draftRes = await request(app).post("/api/ads/drafts").send({
        connectionId,
        targetType: "adset",
        action: "update",
        targetId: "adset_1",
        status: "ACTIVE",
      });
      expect(draftRes.status).toBe(201);

      // Someone changed the budget on the platform after drafting.
      mockRead.mockResolvedValue({
        name: "Retargeting",
        status: "PAUSED",
        dailyBudget: 9999,
        lifetimeBudget: null,
        startTime: null,
        stopTime: null,
      });
      const applied = await request(app).post(
        `/api/ads/drafts/${draftRes.body.id}/approve`,
      );
      expect(applied.status).toBe(200);
      expect(applied.body.status).toBe("expired");
      expect(applied.body.failureReason).toContain("ad set changed");
      expect(mockUpdate).not.toHaveBeenCalled();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("rejects budget or schedule fields on an ad draft", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertMetaAdConnection(tenant.tenantId);
      actAs(tenant.clerkUserId);
      const res = await request(app).post("/api/ads/drafts").send({
        connectionId,
        targetType: "ad",
        action: "update",
        targetId: "ad_1",
        dailyBudget: 1000,
      });
      expect(res.status).toBe(400);
      expect(mockRead).not.toHaveBeenCalled();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("creates an ad set schedule draft with a before/after preview", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertMetaAdConnection(tenant.tenantId);
      mockRead.mockResolvedValue({
        name: "Retargeting",
        status: "PAUSED",
        dailyBudget: 2000,
        lifetimeBudget: null,
        startTime: "2026-07-01T00:00:00+0000",
        stopTime: "2026-08-01T00:00:00+0000",
      });
      actAs(tenant.clerkUserId);
      const res = await request(app).post("/api/ads/drafts").send({
        connectionId,
        targetType: "adset",
        action: "update",
        targetId: "adset_1",
        stopTime: "2026-09-01T00:00:00+0000",
      });
      expect(res.status).toBe(201);
      expect(res.body.changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "End time",
            before: "2026-08-01T00:00:00+0000",
            after: "2026-09-01T00:00:00+0000",
          }),
        ]),
      );
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("applies an ad set schedule draft with the adset target type and verifies the read-back", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertMetaAdConnection(tenant.tenantId);
      const before = {
        name: "Retargeting",
        status: "PAUSED",
        dailyBudget: 2000,
        lifetimeBudget: null,
        startTime: "2026-07-01T00:00:00+0000",
        stopTime: "2026-08-01T00:00:00+0000",
      };
      mockRead.mockResolvedValue(before);
      actAs(tenant.clerkUserId);
      const draftRes = await request(app).post("/api/ads/drafts").send({
        connectionId,
        targetType: "adset",
        action: "update",
        targetId: "adset_1",
        stopTime: "2026-09-01T00:00:00+0000",
      });
      expect(draftRes.status).toBe(201);

      // Drift check read, then post-apply verification read.
      mockRead.mockResolvedValueOnce(before);
      mockRead.mockResolvedValueOnce({
        ...before,
        stopTime: "2026-09-01T00:00:00+0000",
      });
      const applied = await request(app).post(
        `/api/ads/drafts/${draftRes.body.id}/approve`,
      );
      expect(applied.status).toBe(200);
      expect(applied.body.status).toBe("applied");
      expect(applied.body.verifyStatus).toBe("verified");
      expect(mockUpdate).toHaveBeenCalledWith(
        "ads-token",
        "adset_1",
        expect.objectContaining({
          stopTime: "2026-09-01T00:00:00+0000",
          targetType: "adset",
        }),
      );
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("still rejects schedule fields on a non-Meta ad set draft", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertGoogleAdConnection(tenant.tenantId);
      actAs(tenant.clerkUserId);
      const res = await request(app).post("/api/ads/drafts").send({
        connectionId,
        targetType: "adset",
        action: "update",
        targetId: "adgroup_1",
        startTime: "2026-08-01T00:00:00+0000",
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("only supported on Meta");
      expect(mockRead).not.toHaveBeenCalled();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("still refuses to create ad sets or ads", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertMetaAdConnection(tenant.tenantId);
      actAs(tenant.clerkUserId);
      const res = await request(app).post("/api/ads/drafts").send({
        connectionId,
        targetType: "adset",
        action: "create",
        name: "New ad set",
      });
      expect(res.status).toBe(400);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});

describe("GET /ads/connections auto re-verify", () => {
  it("flips a stale connection with a rejected token to failed on page load", async () => {
    const tenant = await createTenant();
    try {
      await insertMetaAdConnection(tenant.tenantId); // verifiedAt null => stale
      mockReadAdAccount.mockRejectedValue(
        new MetaAdsApiError("token expired", 401, true),
      );
      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/ads/connections");
      expect(res.status).toBe(200);
      const meta = res.body.find(
        (c: { platform: string }) => c.platform === "meta",
      );
      expect(meta.verifyStatus).toBe("failed");
      expect(mockReadAdAccount).toHaveBeenCalledTimes(1);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("skips the re-check when the connection was verified recently", async () => {
    const tenant = await createTenant();
    try {
      const connectionId = await insertMetaAdConnection(tenant.tenantId);
      await db
        .update(adAccountConnectionsTable)
        .set({ verifiedAt: new Date() })
        .where(eq(adAccountConnectionsTable.id, connectionId));
      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/ads/connections");
      expect(res.status).toBe(200);
      expect(mockReadAdAccount).not.toHaveBeenCalled();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("keeps a verified status when the re-check fails transiently", async () => {
    const tenant = await createTenant();
    try {
      await insertMetaAdConnection(tenant.tenantId);
      mockReadAdAccount.mockRejectedValue(
        new MetaAdsApiError("Graph is down", 500, false),
      );
      actAs(tenant.clerkUserId);
      const res = await request(app).get("/api/ads/connections");
      expect(res.status).toBe(200);
      const meta = res.body.find(
        (c: { platform: string }) => c.platform === "meta",
      );
      expect(meta.verifyStatus).toBe("verified");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});
