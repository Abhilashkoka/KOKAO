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

import { pool } from "@workspace/db";
import { createAdminTestApp } from "../test/testApp";
import { resetAuthState, actAs } from "../test/authState";
import {
  createTenant,
  deleteTenant,
  snapshotEmailSettings,
  clearEmailSettings,
  restoreEmailSettings,
  getEmailSettingsRow,
  setTenantSuperadmin,
  getAuditLogsForActor,
} from "../test/dbHelpers";

const app = createAdminTestApp();

// Capture outbound network calls so no test ever hits the SendGrid API or the
// Replit connectors proxy for real. The connector is reported unavailable so
// only the admin-entered manual credentials can satisfy the send path.
const realFetch = globalThis.fetch;
const sendgridCalls: Array<{ url: string; init?: RequestInit }> = [];
let sendgridResponse: { status: number; body: string } = {
  status: 202,
  body: "",
};

beforeAll(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("api.sendgrid.com")) {
        sendgridCalls.push({ url, init });
        return new Response(sendgridResponse.body, {
          status: sendgridResponse.status,
        });
      }
      if (url.includes("/api/v2/connection")) {
        // Connector proxy: report no SendGrid connection configured.
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      return realFetch(input, init);
    }),
  );
});

let settingsSnapshot: Awaited<ReturnType<typeof snapshotEmailSettings>>;

beforeAll(async () => {
  settingsSnapshot = await snapshotEmailSettings();
});

afterAll(async () => {
  await restoreEmailSettings(settingsSnapshot);
  vi.unstubAllGlobals();
  await pool.end();
});

beforeEach(async () => {
  resetAuthState();
  sendgridCalls.length = 0;
  sendgridResponse = { status: 202, body: "" };
  await clearEmailSettings();
});

describe("superadmin gate on /admin/email-settings", () => {
  it("rejects an ordinary tenant with 403 on every email-settings endpoint", async () => {
    const tenant = await createTenant();
    try {
      actAs(tenant.clerkUserId, "regular@example.com");

      const get = await request(app).get("/api/admin/email-settings");
      expect(get.status).toBe(403);

      const put = await request(app)
        .put("/api/admin/email-settings")
        .send({ sendingEnabled: true });
      expect(put.status).toBe(403);

      const test = await request(app)
        .post("/api/admin/email-settings/test")
        .send({ to: "someone@example.com" });
      expect(test.status).toBe(403);

      // Nothing must have been written and no email sent.
      expect(await getEmailSettingsRow()).toBeUndefined();
      expect(sendgridCalls.length).toBe(0);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("revoking the superadmin flag locks the tenant out on the very next request", async () => {
    const tenant = await createTenant();
    try {
      actAs(tenant.clerkUserId, "revoked@example.com");

      // Not yet a superadmin: denied.
      const before = await request(app).get("/api/admin/email-settings");
      expect(before.status).toBe(403);

      // Grant the DB flag; access works immediately — including writes.
      await setTenantSuperadmin(tenant.tenantId, true);
      const granted = await request(app).get("/api/admin/email-settings");
      expect(granted.status).toBe(200);
      const grantedPut = await request(app)
        .put("/api/admin/email-settings")
        .send({ sendingEnabled: true });
      expect(grantedPut.status).toBe(200);
      expect((await getEmailSettingsRow())?.sendingEnabled).toBe(true);

      // Revoke: the gate reads the flag fresh each request, so the very
      // next request must be rejected — no caching window.
      await setTenantSuperadmin(tenant.tenantId, false);
      const revoked = await request(app).get("/api/admin/email-settings");
      expect(revoked.status).toBe(403);

      // A demoted admin cannot flip the pause switch: the write is rejected
      // and the stored setting is untouched.
      const put = await request(app)
        .put("/api/admin/email-settings")
        .send({ sendingEnabled: false });
      expect(put.status).toBe(403);
      expect((await getEmailSettingsRow())?.sendingEnabled).toBe(true);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("rejects unauthenticated requests with 401", async () => {
    const res = await request(app).get("/api/admin/email-settings");
    expect(res.status).toBe(401);
  });
});

describe("GET /admin/email-settings", () => {
  it("returns fail-closed defaults (paused, unconfigured) when no row exists", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    try {
      actAs(admin.clerkUserId, "admin@example.com");

      const res = await request(app).get("/api/admin/email-settings");
      expect(res.status).toBe(200);
      expect(res.body.sendingEnabled).toBe(false);
      expect(res.body.fromEmail).toBeNull();
      expect(res.body.apiKeyMasked).toBeNull();
      expect(res.body.connectorAvailable).toBe(false);
      expect(res.body.configured).toBe(false);
      expect(res.body.testStatus).toBeNull();
    } finally {
      await deleteTenant(admin.tenantId);
    }
  });
});

describe("PUT /admin/email-settings", () => {
  it("saves pause switch, sender, and API key; the key is returned masked, never raw", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    try {
      actAs(admin.clerkUserId, "admin@example.com");

      const res = await request(app).put("/api/admin/email-settings").send({
        sendingEnabled: true,
        fromEmail: "alerts@socialforge.test",
        apiKey: "SG.super-secret-key-9876",
      });
      expect(res.status).toBe(200);
      expect(res.body.sendingEnabled).toBe(true);
      expect(res.body.fromEmail).toBe("alerts@socialforge.test");
      expect(res.body.configured).toBe(true);
      // Write-only: the raw key must never come back in any response field.
      expect(JSON.stringify(res.body)).not.toContain(
        "SG.super-secret-key-9876",
      );
      expect(res.body.apiKeyMasked).toMatch(/9876$/);
      expect(res.body.apiKeyMasked).toContain("•");

      // Stored encrypted, not in plaintext.
      const row = await getEmailSettingsRow();
      expect(row?.sendingEnabled).toBe(true);
      expect(row?.fromEmail).toBe("alerts@socialforge.test");
      expect(row?.encryptedApiKey).toBeTruthy();
      expect(row?.encryptedApiKey).not.toContain("SG.super-secret-key-9876");
    } finally {
      await deleteTenant(admin.tenantId);
    }
  });

  it("keeps the stored API key when a later save omits it (write-only semantics)", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    try {
      actAs(admin.clerkUserId, "admin@example.com");

      await request(app).put("/api/admin/email-settings").send({
        sendingEnabled: true,
        fromEmail: "alerts@socialforge.test",
        apiKey: "SG.original-key-4321",
      });

      // Toggle the pause switch without re-entering the key.
      const res = await request(app)
        .put("/api/admin/email-settings")
        .send({ sendingEnabled: false, fromEmail: "alerts@socialforge.test" });
      expect(res.status).toBe(200);
      expect(res.body.sendingEnabled).toBe(false);
      // Key survived the update.
      expect(res.body.apiKeyMasked).toMatch(/4321$/);
      expect(res.body.configured).toBe(true);
    } finally {
      await deleteTenant(admin.tenantId);
    }
  });

  it("rejects a malformed body with 400", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    try {
      actAs(admin.clerkUserId, "admin@example.com");

      const res = await request(app)
        .put("/api/admin/email-settings")
        .send({ sendingEnabled: "yes-please" });
      expect(res.status).toBe(400);
      expect(await getEmailSettingsRow()).toBeUndefined();
    } finally {
      await deleteTenant(admin.tenantId);
    }
  });
});

describe("PUT /admin/email-settings audit trail", () => {
  it("records exactly one audit row per real change, with the API key masked", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    try {
      actAs(admin.clerkUserId, "admin@example.com");

      const res = await request(app).put("/api/admin/email-settings").send({
        sendingEnabled: true,
        fromEmail: "alerts@socialforge.test",
        apiKey: "SG.audit-secret-key-5555",
      });
      expect(res.status).toBe(200);

      const logs = await getAuditLogsForActor(admin.tenantId);
      expect(logs.length).toBe(1);
      const log = logs[0];
      expect(log.action).toBe("email_settings_change");
      expect(log.actorTenantId).toBe(admin.tenantId);
      expect(log.targetTenantId).toBeNull();
      // Old side reflects the fail-closed defaults (no row yet).
      expect(JSON.parse(log.oldValue!)).toEqual({
        sendingEnabled: false,
        fromEmail: null,
        apiKeyMasked: null,
      });
      const newVal = JSON.parse(log.newValue!);
      expect(newVal.sendingEnabled).toBe(true);
      expect(newVal.fromEmail).toBe("alerts@socialforge.test");
      // The key must appear only MASKED — never the raw secret.
      expect(newVal.apiKeyMasked).toMatch(/5555$/);
      expect(log.newValue!).not.toContain("SG.audit-secret-key-5555");
      expect(log.oldValue!).not.toContain("SG.audit-secret-key-5555");
    } finally {
      await deleteTenant(admin.tenantId);
    }
  });

  it("writes NO audit row for a no-op save", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    try {
      actAs(admin.clerkUserId, "admin@example.com");

      await request(app).put("/api/admin/email-settings").send({
        sendingEnabled: true,
        fromEmail: "alerts@socialforge.test",
        apiKey: "SG.noop-key-2222",
      });
      expect((await getAuditLogsForActor(admin.tenantId)).length).toBe(1);

      // Re-save identical values (key omitted keeps the stored one).
      const res = await request(app)
        .put("/api/admin/email-settings")
        .send({ sendingEnabled: true, fromEmail: "alerts@socialforge.test" });
      expect(res.status).toBe(200);

      // Still exactly one row: the no-op produced nothing.
      expect((await getAuditLogsForActor(admin.tenantId)).length).toBe(1);

      // A real toggle then adds a second row.
      await request(app)
        .put("/api/admin/email-settings")
        .send({ sendingEnabled: false, fromEmail: "alerts@socialforge.test" });
      const logs = await getAuditLogsForActor(admin.tenantId);
      expect(logs.length).toBe(2);
      expect(JSON.parse(logs[1].newValue!).sendingEnabled).toBe(false);
    } finally {
      await deleteTenant(admin.tenantId);
    }
  });
});

describe("POST /admin/email-settings/test", () => {
  it("sends through SendGrid even while sending is PAUSED and records the verified outcome", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    try {
      actAs(admin.clerkUserId, "admin@example.com");

      // Configure creds but leave the global pause switch OFF.
      await request(app).put("/api/admin/email-settings").send({
        sendingEnabled: false,
        fromEmail: "alerts@socialforge.test",
        apiKey: "SG.test-key-1111",
      });

      const res = await request(app)
        .post("/api/admin/email-settings/test")
        .send({ to: "admin@example.com" });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.error).toBeNull();

      // The pause switch was bypassed: SendGrid actually got the POST.
      expect(sendgridCalls.length).toBe(1);
      const body = JSON.parse(String(sendgridCalls[0].init?.body));
      expect(body.personalizations[0].to[0].email).toBe("admin@example.com");
      expect(body.from.email).toBe("alerts@socialforge.test");

      // Outcome recorded on the row for the admin card.
      const row = await getEmailSettingsRow();
      expect(row?.lastTestStatus).toBe("verified");
      expect(row?.lastTestError).toBeNull();
      expect(row?.lastTestedAt).toBeTruthy();
      // Pause switch itself is untouched.
      expect(row?.sendingEnabled).toBe(false);
    } finally {
      await deleteTenant(admin.tenantId);
    }
  });

  it("returns ok:false and records the failure when nothing is configured", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    try {
      actAs(admin.clerkUserId, "admin@example.com");

      const res = await request(app)
        .post("/api/admin/email-settings/test")
        .send({ to: "admin@example.com" });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toMatch(/no sendgrid credentials/i);
      expect(sendgridCalls.length).toBe(0);

      const row = await getEmailSettingsRow();
      expect(row?.lastTestStatus).toBe("failed");
      expect(row?.lastTestError).toBeTruthy();
    } finally {
      await deleteTenant(admin.tenantId);
    }
  });

  it("surfaces a SendGrid rejection as ok:false with the failure recorded", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    try {
      actAs(admin.clerkUserId, "admin@example.com");

      await request(app).put("/api/admin/email-settings").send({
        sendingEnabled: true,
        fromEmail: "alerts@socialforge.test",
        apiKey: "SG.bad-key-0000",
      });
      sendgridResponse = { status: 401, body: "unauthorized" };

      const res = await request(app)
        .post("/api/admin/email-settings/test")
        .send({ to: "admin@example.com" });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toMatch(/401/);

      const row = await getEmailSettingsRow();
      expect(row?.lastTestStatus).toBe("failed");
      expect(row?.lastTestError).toMatch(/401/);
    } finally {
      await deleteTenant(admin.tenantId);
    }
  });

  it("locks a revoked superadmin out of test sends on the very next request, with NO email sent", async () => {
    const tenant = await createTenant();
    try {
      actAs(tenant.clerkUserId, "revoked-test@example.com");

      // Not yet a superadmin: denied, nothing sent.
      const before = await request(app)
        .post("/api/admin/email-settings/test")
        .send({ to: "someone@example.com" });
      expect(before.status).toBe(403);
      expect(sendgridCalls.length).toBe(0);

      // Grant the DB flag and configure credentials: the test send works.
      await setTenantSuperadmin(tenant.tenantId, true);
      const save = await request(app).put("/api/admin/email-settings").send({
        sendingEnabled: false,
        fromEmail: "alerts@socialforge.test",
        apiKey: "SG.revoke-test-key-7777",
      });
      expect(save.status).toBe(200);
      const granted = await request(app)
        .post("/api/admin/email-settings/test")
        .send({ to: "someone@example.com" });
      expect(granted.status).toBe(200);
      expect(granted.body.ok).toBe(true);
      expect(sendgridCalls.length).toBe(1);
      const rowAfterGrant = await getEmailSettingsRow();
      expect(rowAfterGrant?.lastTestStatus).toBe("verified");
      const testedAtAfterGrant = rowAfterGrant?.lastTestedAt?.toISOString();

      // Revoke: the gate reads the flag fresh each request, so the very next
      // test-send attempt is rejected — no outbound email, and the stored
      // test outcome is untouched.
      await setTenantSuperadmin(tenant.tenantId, false);
      const revoked = await request(app)
        .post("/api/admin/email-settings/test")
        .send({ to: "someone@example.com" });
      expect(revoked.status).toBe(403);
      expect(sendgridCalls.length).toBe(1);
      const rowAfterRevoke = await getEmailSettingsRow();
      expect(rowAfterRevoke?.lastTestStatus).toBe("verified");
      expect(rowAfterRevoke?.lastTestedAt?.toISOString()).toBe(
        testedAtAfterGrant,
      );
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("rejects a missing/invalid recipient with 400 and sends nothing", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    try {
      actAs(admin.clerkUserId, "admin@example.com");

      const res = await request(app)
        .post("/api/admin/email-settings/test")
        .send({});
      expect(res.status).toBe(400);
      expect(sendgridCalls.length).toBe(0);
    } finally {
      await deleteTenant(admin.tenantId);
    }
  });
});
