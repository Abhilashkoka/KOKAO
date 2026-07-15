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
import { randomUUID } from "crypto";

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

// Keep the DB-backed helpers real; only stub the functions that make live
// network calls to Meta so tests never hit the real Graph API.
vi.mock("../lib/metaApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/metaApi")>();
  return {
    ...actual,
    testMetaAppCredentials: vi.fn(async () => ({ ok: true })),
    testFacebookCredentials: vi.fn(async () => ({
      ok: true,
      accountName: "Test Page",
    })),
    testInstagramCredentials: vi.fn(async () => ({
      ok: true,
      accountName: "@testig",
    })),
  };
});

import { pool, type AppCredential } from "@workspace/db";
import { createTestApp } from "../test/testApp";
import { resetAuthState, actAs } from "../test/authState";
import {
  createTenant,
  deleteTenant,
  insertConnectedAccount,
  getConnectedAccount,
  setAccountState,
  snapshotMetaRow,
  setMetaRow,
  setVerifiedMetaRow,
  restoreMetaRow,
  getAuditLogsForActor,
} from "../test/dbHelpers";

const app = createTestApp();
let metaSnapshot: AppCredential | null = null;

beforeAll(async () => {
  metaSnapshot = await snapshotMetaRow();
});

afterAll(async () => {
  await restoreMetaRow(metaSnapshot);
  await pool.end();
});

beforeEach(() => {
  resetAuthState();
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
});

// ---------------------------------------------------------------------------
// Admin (superadmin-only) Meta app credential endpoints
// ---------------------------------------------------------------------------

describe("admin Meta credential endpoints", () => {
  it("rejects unauthenticated requests (401)", async () => {
    resetAuthState(); // no current user
    const getRes = await request(app).get(
      "/api/admin/platform-credentials/meta",
    );
    expect(getRes.status).toBe(401);

    const putRes = await request(app)
      .put("/api/admin/platform-credentials/meta")
      .send({ appId: "x", appSecret: "y" });
    expect(putRes.status).toBe(401);
  });

  it("rejects authenticated non-superadmins (403)", async () => {
    const tenant = await createTenant({
      email: `user-${randomUUID()}@example.com`,
    });
    try {
      actAs(tenant.clerkUserId, tenant.email);

      const getRes = await request(app).get(
        "/api/admin/platform-credentials/meta",
      );
      expect(getRes.status).toBe(403);

      const putRes = await request(app)
        .put("/api/admin/platform-credentials/meta")
        .send({ appId: "should-not-save", appSecret: "should-not-save" });
      expect(putRes.status).toBe(403);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("returns masked values with no plaintext secrets to a superadmin", async () => {
    const tenant = await createTenant({ isSuperadmin: true });
    try {
      actAs(tenant.clerkUserId);
      await setMetaRow("1234567890", "topsecretvalue987", "verified");

      const res = await request(app).get(
        "/api/admin/platform-credentials/meta",
      );
      expect(res.status).toBe(200);
      expect(res.body.configured).toBe(true);
      // No raw secret fields present.
      expect(res.body).not.toHaveProperty("appId");
      expect(res.body).not.toHaveProperty("appSecret");
      // Masked, not the raw value.
      expect(res.body.appIdMasked).not.toBe("1234567890");
      expect(res.body.appSecretMasked).not.toBe("topsecretvalue987");
      // The raw secret must not appear anywhere in the serialized response.
      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain("topsecretvalue987");
      expect(raw).not.toContain("topsecretvalue");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("saves credentials (encrypted, masked response) for a superadmin", async () => {
    const tenant = await createTenant({ isSuperadmin: true });
    try {
      actAs(tenant.clerkUserId);
      const res = await request(app)
        .put("/api/admin/platform-credentials/meta")
        .send({ appId: "app-999", appSecret: "brand-new-secret-xyz" });

      expect(res.status).toBe(200);
      expect(res.body.testStatus).toBe("verified");
      expect(res.body).not.toHaveProperty("appSecret");
      expect(JSON.stringify(res.body)).not.toContain("brand-new-secret-xyz");

      // The value is stored encrypted, never as plaintext.
      const stored = await snapshotMetaRow();
      expect(stored?.encryptedCredentials).toBeTruthy();
      expect(stored?.encryptedCredentials).not.toContain("brand-new-secret-xyz");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("audits a credential save with masked values only (no secrets in the audit row)", async () => {
    const tenant = await createTenant({ isSuperadmin: true });
    try {
      actAs(tenant.clerkUserId, tenant.email);
      await setMetaRow("old-app-id-111", "old-secret-abc", "verified");

      const res = await request(app)
        .put("/api/admin/platform-credentials/meta")
        .send({ appId: "new-app-id-999", appSecret: "new-secret-xyz" });
      expect(res.status).toBe(200);

      const logs = (await getAuditLogsForActor(tenant.tenantId)).filter(
        (l) => l.action === "credential_change",
      );
      expect(logs).toHaveLength(1);
      const log = logs[0];
      expect(log.targetTenantId).toBeNull();
      expect(JSON.parse(log.newValue!)).toMatchObject({ provider: "meta" });
      expect(JSON.parse(log.oldValue!)).toMatchObject({ provider: "meta" });

      // No secret material — old or new — may appear in the audit row.
      const raw = `${log.oldValue}${log.newValue}`;
      expect(raw).not.toContain("old-secret-abc");
      expect(raw).not.toContain("new-secret-xyz");
      expect(raw).not.toContain("new-app-id-999");
      expect(raw).not.toContain("old-app-id-111");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("fails closed when SESSION_SECRET is unavailable (400, no write)", async () => {
    const tenant = await createTenant({ isSuperadmin: true });
    const before = await snapshotMetaRow();
    const saved = process.env.SESSION_SECRET;
    try {
      actAs(tenant.clerkUserId);
      delete process.env.SESSION_SECRET;

      const res = await request(app)
        .put("/api/admin/platform-credentials/meta")
        .send({ appId: "app-1", appSecret: "should-not-persist" });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/SESSION_SECRET/);

      // Nothing was written.
      const after = await snapshotMetaRow();
      expect(after?.encryptedCredentials).toBe(before?.encryptedCredentials);
    } finally {
      process.env.SESSION_SECRET = saved;
      await deleteTenant(tenant.tenantId);
    }
  });
});

// ---------------------------------------------------------------------------
// Tenant per-platform social credential endpoints
// ---------------------------------------------------------------------------

describe("tenant social credential endpoints", () => {
  beforeEach(async () => {
    // Tenant save/verify requires app-level Meta keys to be configured.
    await setVerifiedMetaRow();
  });

  it("masks the stored Facebook Page access token on read", async () => {
    const tenant = await createTenant();
    try {
      await insertConnectedAccount(
        tenant.tenantId,
        "facebook",
        { pageId: "PAGE_ABC", pageAccessToken: "TOKEN_SECRET_XYZ" },
        "verified",
      );
      actAs(tenant.clerkUserId);

      const res = await request(app).get("/api/social-credentials/facebook");
      expect(res.status).toBe(200);
      // Page ID is a public identifier and is intentionally returned.
      expect(res.body.pageId).toBe("PAGE_ABC");
      // The token is a secret: it is masked and never returned raw.
      expect(res.body).not.toHaveProperty("pageAccessToken");
      expect(res.body.pageAccessTokenMasked).toBeTruthy();
      expect(res.body.pageAccessTokenMasked).not.toBe("TOKEN_SECRET_XYZ");
      expect(JSON.stringify(res.body)).not.toContain("TOKEN_SECRET_XYZ");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("returns the Instagram status with no leaked secrets on read", async () => {
    const tenant = await createTenant();
    try {
      // IG publishing rides on the Facebook Page token; store both so we can
      // prove the FB token never leaks into the IG response.
      await insertConnectedAccount(
        tenant.tenantId,
        "facebook",
        { pageId: "PAGE_FB", pageAccessToken: "PAGE_TOKEN_LEAK_TEST" },
        "verified",
      );
      await insertConnectedAccount(
        tenant.tenantId,
        "instagram",
        { igUserId: "IG_PUBLIC_123" },
        "verified",
      );
      actAs(tenant.clerkUserId);

      const res = await request(app).get("/api/social-credentials/instagram");
      expect(res.status).toBe(200);
      // Contract: igUserId is a PUBLIC account identifier and is intentionally
      // returned (the UI displays it) — it is not a secret.
      expect(res.body.igUserId).toBe("IG_PUBLIC_123");
      // No secret-bearing fields are ever present in the IG response.
      expect(res.body).not.toHaveProperty("pageAccessToken");
      expect(res.body).not.toHaveProperty("accessToken");
      expect(res.body).not.toHaveProperty("appSecret");
      // The Facebook Page token IG rides on must never leak into this response.
      expect(JSON.stringify(res.body)).not.toContain("PAGE_TOKEN_LEAK_TEST");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("saves Instagram credentials and returns a no-secret response", async () => {
    const tenant = await createTenant();
    try {
      // A verified Facebook Page must exist before Instagram can be saved.
      await insertConnectedAccount(
        tenant.tenantId,
        "facebook",
        { pageId: "PAGE_FB", pageAccessToken: "PAGE_TOKEN_SAVE_TEST" },
        "verified",
      );
      actAs(tenant.clerkUserId);

      const res = await request(app)
        .put("/api/social-credentials/instagram")
        .send({ igUserId: "IG_SAVE_456" });

      expect(res.status).toBe(200);
      expect(res.body.verifyStatus).toBe("verified");
      // igUserId echoed back as the public identifier.
      expect(res.body.igUserId).toBe("IG_SAVE_456");
      // No secret-bearing fields, and no FB token leakage.
      expect(res.body).not.toHaveProperty("pageAccessToken");
      expect(res.body).not.toHaveProperty("accessToken");
      expect(res.body).not.toHaveProperty("appSecret");
      expect(JSON.stringify(res.body)).not.toContain("PAGE_TOKEN_SAVE_TEST");

      // The stored blob is encrypted, not plaintext.
      const row = await getConnectedAccount(tenant.tenantId, "instagram");
      expect(row?.encryptedCredentials).toBeTruthy();
      expect(row?.encryptedCredentials).not.toContain("IG_SAVE_456");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("reads only the caller's own Instagram row (tenant isolation)", async () => {
    const tenantA = await createTenant();
    const tenantB = await createTenant();
    try {
      await insertConnectedAccount(
        tenantA.tenantId,
        "instagram",
        { igUserId: "IG_A" },
        "verified",
      );
      await insertConnectedAccount(
        tenantB.tenantId,
        "instagram",
        { igUserId: "IG_B" },
        "verified",
      );

      actAs(tenantA.clerkUserId);
      const resA = await request(app).get("/api/social-credentials/instagram");
      expect(resA.body.igUserId).toBe("IG_A");

      actAs(tenantB.clerkUserId);
      const resB = await request(app).get("/api/social-credentials/instagram");
      expect(resB.body.igUserId).toBe("IG_B");
    } finally {
      await deleteTenant(tenantA.tenantId);
      await deleteTenant(tenantB.tenantId);
    }
  });

  it("writes only the caller's own Instagram row (tenant isolation)", async () => {
    const tenantA = await createTenant();
    const tenantB = await createTenant();
    try {
      // Both tenants need a verified Facebook Page first.
      await insertConnectedAccount(
        tenantA.tenantId,
        "facebook",
        { pageId: "PAGE_A", pageAccessToken: "tok_a" },
        "verified",
      );
      await insertConnectedAccount(
        tenantB.tenantId,
        "facebook",
        { pageId: "PAGE_B", pageAccessToken: "tok_b" },
        "verified",
      );

      actAs(tenantA.clerkUserId);
      const saveA = await request(app)
        .put("/api/social-credentials/instagram")
        .send({ igUserId: "IG_WRITE_A" });
      expect(saveA.status).toBe(200);

      // B has no Instagram row yet.
      const bRow = await getConnectedAccount(tenantB.tenantId, "instagram");
      expect(bRow).toBeUndefined();

      actAs(tenantB.clerkUserId);
      const saveB = await request(app)
        .put("/api/social-credentials/instagram")
        .send({ igUserId: "IG_WRITE_B" });
      expect(saveB.status).toBe(200);

      actAs(tenantA.clerkUserId);
      const resA = await request(app).get("/api/social-credentials/instagram");
      expect(resA.body.igUserId).toBe("IG_WRITE_A");

      actAs(tenantB.clerkUserId);
      const resB = await request(app).get("/api/social-credentials/instagram");
      expect(resB.body.igUserId).toBe("IG_WRITE_B");
    } finally {
      await deleteTenant(tenantA.tenantId);
      await deleteTenant(tenantB.tenantId);
    }
  });

  it("reads only the caller's own credential row (tenant isolation)", async () => {
    const tenantA = await createTenant();
    const tenantB = await createTenant();
    try {
      await insertConnectedAccount(
        tenantA.tenantId,
        "facebook",
        { pageId: "PAGE_A", pageAccessToken: "tok_a" },
        "verified",
      );
      await insertConnectedAccount(
        tenantB.tenantId,
        "facebook",
        { pageId: "PAGE_B", pageAccessToken: "tok_b" },
        "verified",
      );

      actAs(tenantA.clerkUserId);
      const resA = await request(app).get("/api/social-credentials/facebook");
      expect(resA.body.pageId).toBe("PAGE_A");

      actAs(tenantB.clerkUserId);
      const resB = await request(app).get("/api/social-credentials/facebook");
      expect(resB.body.pageId).toBe("PAGE_B");
    } finally {
      await deleteTenant(tenantA.tenantId);
      await deleteTenant(tenantB.tenantId);
    }
  });

  it("writes only the caller's own credential row (tenant isolation)", async () => {
    const tenantA = await createTenant();
    const tenantB = await createTenant();
    try {
      // A saves — B must remain untouched.
      actAs(tenantA.clerkUserId);
      const saveA = await request(app)
        .put("/api/social-credentials/facebook")
        .send({ pageId: "WRITE_A", pageAccessToken: "tok_write_a" });
      expect(saveA.status).toBe(200);

      const bRow = await getConnectedAccount(tenantB.tenantId, "facebook");
      expect(bRow).toBeUndefined();

      // B saves its own — A's row must not change.
      actAs(tenantB.clerkUserId);
      const saveB = await request(app)
        .put("/api/social-credentials/facebook")
        .send({ pageId: "WRITE_B", pageAccessToken: "tok_write_b" });
      expect(saveB.status).toBe(200);

      actAs(tenantA.clerkUserId);
      const resA = await request(app).get("/api/social-credentials/facebook");
      expect(resA.body.pageId).toBe("WRITE_A");

      actAs(tenantB.clerkUserId);
      const resB = await request(app).get("/api/social-credentials/facebook");
      expect(resB.body.pageId).toBe("WRITE_B");
    } finally {
      await deleteTenant(tenantA.tenantId);
      await deleteTenant(tenantB.tenantId);
    }
  });

  it("Facebook save fails closed when SESSION_SECRET is unavailable (400, no write)", async () => {
    const tenant = await createTenant();
    const saved = process.env.SESSION_SECRET;
    try {
      actAs(tenant.clerkUserId);
      delete process.env.SESSION_SECRET;

      const res = await request(app)
        .put("/api/social-credentials/facebook")
        .send({ pageId: "PAGE_X", pageAccessToken: "should-not-persist" });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/SESSION_SECRET/);

      // No row was created.
      process.env.SESSION_SECRET = saved;
      const row = await getConnectedAccount(tenant.tenantId, "facebook");
      expect(row).toBeUndefined();
    } finally {
      process.env.SESSION_SECRET = saved;
      await deleteTenant(tenant.tenantId);
    }
  });

  it("blocks Instagram save until a verified Facebook Page exists (400)", async () => {
    const tenant = await createTenant();
    try {
      actAs(tenant.clerkUserId);
      const res = await request(app)
        .put("/api/social-credentials/instagram")
        .send({ igUserId: "IG_123" });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Facebook/i);

      const row = await getConnectedAccount(tenant.tenantId, "instagram");
      expect(row).toBeUndefined();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});

// ---------------------------------------------------------------------------
// Facebook / Instagram disconnect
//
// DELETE /social-credentials/facebook and /social-credentials/instagram
// HARD-DELETE the tenant's connected_accounts row (unlike X, which performs a
// soft disconnect that keeps the row). Both respond with the serialized status
// for a missing row — the "Not connected" state: saved=false, verifyStatus
// null, no identifiers or masked secrets. These tests guard that "Disconnect"
// really removes the stored encrypted Meta credentials, is a safe no-op when
// nothing is saved, and never touches another tenant's row.
// ---------------------------------------------------------------------------

describe("Facebook / Instagram disconnect endpoints", () => {
  beforeEach(async () => {
    await setVerifiedMetaRow();
  });

  it("hard-deletes the Facebook row and reports not connected", async () => {
    const tenant = await createTenant();
    try {
      await insertConnectedAccount(
        tenant.tenantId,
        "facebook",
        { pageId: "PAGE_DEL", pageAccessToken: "FB_TOKEN_TO_DELETE" },
        "verified",
      );
      // Sanity check: credentials really are stored before the disconnect.
      const before = await getConnectedAccount(tenant.tenantId, "facebook");
      expect(before?.encryptedCredentials).toBeTruthy();

      actAs(tenant.clerkUserId);
      const res = await request(app).delete("/api/social-credentials/facebook");

      // Response is the "Not connected" status with nothing left behind.
      expect(res.status).toBe(200);
      expect(res.body.saved).toBe(false);
      expect(res.body.verifyStatus).toBeNull();
      expect(res.body.pageId).toBeNull();
      expect(res.body.pageAccessTokenMasked).toBeNull();
      expect(res.body.accountName).toBeNull();
      expect(JSON.stringify(res.body)).not.toContain("FB_TOKEN_TO_DELETE");

      // The row is gone — no stale encrypted credentials remain.
      const after = await getConnectedAccount(tenant.tenantId, "facebook");
      expect(after).toBeUndefined();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("hard-deletes the Instagram row and reports not connected", async () => {
    const tenant = await createTenant();
    try {
      await insertConnectedAccount(
        tenant.tenantId,
        "instagram",
        { igUserId: "IG_DEL_123" },
        "verified",
      );
      const before = await getConnectedAccount(tenant.tenantId, "instagram");
      expect(before?.encryptedCredentials).toBeTruthy();

      actAs(tenant.clerkUserId);
      const res = await request(app).delete(
        "/api/social-credentials/instagram",
      );

      expect(res.status).toBe(200);
      expect(res.body.saved).toBe(false);
      expect(res.body.verifyStatus).toBeNull();
      expect(res.body.igUserId).toBeNull();
      expect(res.body.accountName).toBeNull();

      const after = await getConnectedAccount(tenant.tenantId, "instagram");
      expect(after).toBeUndefined();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("Facebook disconnect is a safe no-op when nothing is saved", async () => {
    const tenant = await createTenant();
    try {
      expect(
        await getConnectedAccount(tenant.tenantId, "facebook"),
      ).toBeUndefined();

      actAs(tenant.clerkUserId);
      const res = await request(app).delete("/api/social-credentials/facebook");

      expect(res.status).toBe(200);
      expect(res.body.saved).toBe(false);
      expect(res.body.verifyStatus).toBeNull();

      // Still no row afterwards — the no-op didn't create anything.
      expect(
        await getConnectedAccount(tenant.tenantId, "facebook"),
      ).toBeUndefined();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("Instagram disconnect is a safe no-op when nothing is saved", async () => {
    const tenant = await createTenant();
    try {
      expect(
        await getConnectedAccount(tenant.tenantId, "instagram"),
      ).toBeUndefined();

      actAs(tenant.clerkUserId);
      const res = await request(app).delete(
        "/api/social-credentials/instagram",
      );

      expect(res.status).toBe(200);
      expect(res.body.saved).toBe(false);
      expect(res.body.verifyStatus).toBeNull();

      expect(
        await getConnectedAccount(tenant.tenantId, "instagram"),
      ).toBeUndefined();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("disconnects only the caller's own Meta rows (tenant isolation)", async () => {
    const owner = await createTenant();
    const other = await createTenant();
    try {
      await insertConnectedAccount(
        owner.tenantId,
        "facebook",
        { pageId: "PAGE_OWNER", pageAccessToken: "owner_fb_tok" },
        "verified",
      );
      await insertConnectedAccount(
        other.tenantId,
        "facebook",
        { pageId: "PAGE_OTHER", pageAccessToken: "other_fb_tok" },
        "verified",
      );
      await insertConnectedAccount(
        other.tenantId,
        "instagram",
        { igUserId: "IG_OTHER" },
        "verified",
      );

      actAs(owner.clerkUserId);
      const fbRes = await request(app).delete(
        "/api/social-credentials/facebook",
      );
      expect(fbRes.status).toBe(200);
      expect(fbRes.body.saved).toBe(false);
      const igRes = await request(app).delete(
        "/api/social-credentials/instagram",
      );
      expect(igRes.status).toBe(200);

      // The owner's Facebook row is gone...
      expect(
        await getConnectedAccount(owner.tenantId, "facebook"),
      ).toBeUndefined();

      // ...but the other tenant's Facebook and Instagram rows are untouched.
      const otherFb = await getConnectedAccount(other.tenantId, "facebook");
      expect(otherFb?.encryptedCredentials).toBeTruthy();
      expect(otherFb?.verifyStatus).toBe("verified");
      const otherIg = await getConnectedAccount(other.tenantId, "instagram");
      expect(otherIg?.encryptedCredentials).toBeTruthy();
      expect(otherIg?.verifyStatus).toBe("verified");
    } finally {
      await deleteTenant(owner.tenantId);
      await deleteTenant(other.tenantId);
    }
  });
});

// ---------------------------------------------------------------------------
// X (Twitter) disconnect
//
// The X disconnect endpoint is DELETE /twitter (operationId `disconnectTwitter`
// in openapi.yaml — the API source of truth). Its OpenAPI summary is
// "Disconnect X (Twitter), clearing the stored OAuth token and account" and it
// returns the TwitterStatus contract ({ connected, accountName, configured,
// redirectUri, expired }). Unlike the Meta DELETE routes, which hard-delete the
// connected_accounts row, X performs an intentional SOFT disconnect: it keeps
// the row but scrubs every credential field and marks it disconnected. These
// tests guard that a "Disconnect" reliably wipes the stored X tokens (never
// leaving stale encrypted credentials behind) and reports the connection as
// gone — and that it stays a safe no-op when nothing is connected.
// ---------------------------------------------------------------------------

describe("X (Twitter) disconnect endpoint", () => {
  it("scrubs stored X credentials and reports not connected", async () => {
    const tenant = await createTenant();
    try {
      // Seed a fully connected OAuth 2.0 X account with token/expiry/user id so
      // we can prove every credential field is scrubbed by the disconnect.
      await insertConnectedAccount(
        tenant.tenantId,
        "twitter",
        { accessToken: "x_access_token", refreshToken: "x_refresh_secret" },
        "verified",
        "@testhandle",
      );
      await setAccountState(tenant.tenantId, "twitter", {
        accessToken: "x_access_token",
        providerUserId: "x_user_123",
        tokenExpiresAt: new Date(Date.now() + 3600 * 1000),
      });

      // Sanity check: the tenant really is connected before we disconnect.
      const before = await getConnectedAccount(tenant.tenantId, "twitter");
      expect(before.encryptedCredentials).toBeTruthy();
      expect(before.verifyStatus).toBe("verified");

      actAs(tenant.clerkUserId);
      const res = await request(app).delete("/api/twitter");

      // Response reports the connection as gone (the "Not connected" state).
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(false);
      expect(res.body.accountName).toBeNull();
      expect(res.body.expired).toBe(false);

      // Every stored credential field is scrubbed so nothing usable is left.
      const after = await getConnectedAccount(tenant.tenantId, "twitter");
      expect(after.status).toBe("disconnected");
      expect(after.encryptedCredentials).toBeNull();
      expect(after.accessToken).toBeNull();
      expect(after.verifyStatus).toBeNull();
      expect(after.verifyError).toBeNull();
      expect(after.tokenExpiresAt).toBeNull();
      expect(after.providerUserId).toBeNull();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("is a safe no-op when no X account is connected", async () => {
    const tenant = await createTenant();
    try {
      // No X row exists for this tenant.
      expect(
        await getConnectedAccount(tenant.tenantId, "twitter"),
      ).toBeUndefined();

      actAs(tenant.clerkUserId);
      const res = await request(app).delete("/api/twitter");

      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(false);
      expect(res.body.accountName).toBeNull();
      expect(res.body.expired).toBe(false);

      // Still no row was created by the no-op disconnect.
      expect(
        await getConnectedAccount(tenant.tenantId, "twitter"),
      ).toBeUndefined();
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("disconnects only the caller's own X account (tenant isolation)", async () => {
    const owner = await createTenant();
    const other = await createTenant();
    try {
      await insertConnectedAccount(
        owner.tenantId,
        "twitter",
        { accessToken: "owner_tok", refreshToken: "owner_refresh" },
        "verified",
      );
      await insertConnectedAccount(
        other.tenantId,
        "twitter",
        { accessToken: "other_tok", refreshToken: "other_refresh" },
        "verified",
      );

      actAs(owner.clerkUserId);
      const res = await request(app).delete("/api/twitter");
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(false);

      // The other tenant's connection is untouched.
      const otherRow = await getConnectedAccount(other.tenantId, "twitter");
      expect(otherRow.status).not.toBe("disconnected");
      expect(otherRow.encryptedCredentials).toBeTruthy();
      expect(otherRow.verifyStatus).toBe("verified");
    } finally {
      await deleteTenant(owner.tenantId);
      await deleteTenant(other.tenantId);
    }
  });
});
