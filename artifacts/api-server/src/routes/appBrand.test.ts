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
  snapshotAppBrand,
  clearAppBrand,
  restoreAppBrand,
  getAuditLogsForActor,
} from "../test/dbHelpers";

import { ObjectStorageService } from "../lib/objectStorage";

const app = createAdminTestApp();

const deleteBrandObjectSpy = vi
  .spyOn(ObjectStorageService.prototype, "deletePublicBrandObject")
  .mockResolvedValue(undefined);

let brandSnapshot: Awaited<ReturnType<typeof snapshotAppBrand>>;

beforeAll(async () => {
  brandSnapshot = await snapshotAppBrand();
});

afterAll(async () => {
  await restoreAppBrand(brandSnapshot);
  await pool.end();
});

beforeEach(async () => {
  resetAuthState();
  await clearAppBrand();
  deleteBrandObjectSpy.mockClear();
  deleteBrandObjectSpy.mockResolvedValue(undefined);
});

const BRAND_BODY = {
  appName: "Acme Social",
  logoUrl: "/api/storage/public-objects/brand/logo-1",
  iconUrl: null,
  primaryColor: "#112233",
  backgroundColor: null,
};

describe("PUT /app-brand audit trail", () => {
  it("rejects non-superadmins and writes nothing", async () => {
    const tenant = await createTenant();
    try {
      actAs(tenant.clerkUserId, "regular@example.com");
      const res = await request(app).put("/api/app-brand").send(BRAND_BODY);
      expect(res.status).toBe(403);
      expect((await getAuditLogsForActor(tenant.tenantId)).length).toBe(0);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("records exactly one audit row per real change, with old and new values", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    try {
      actAs(admin.clerkUserId, "admin@example.com");

      const res = await request(app).put("/api/app-brand").send(BRAND_BODY);
      expect(res.status).toBe(200);
      expect(res.body.appName).toBe("Acme Social");

      const logs = await getAuditLogsForActor(admin.tenantId);
      expect(logs.length).toBe(1);
      const log = logs[0];
      expect(log.action).toBe("app_brand_change");
      expect(log.actorTenantId).toBe(admin.tenantId);
      expect(log.targetTenantId).toBeNull();
      // Old side reflects the unconfigured defaults (no row yet).
      expect(JSON.parse(log.oldValue!)).toEqual({
        appName: null,
        logoUrl: null,
        iconUrl: null,
        primaryColor: null,
        backgroundColor: null,
        loaderAnimationUrl: null,
      });
      expect(JSON.parse(log.newValue!)).toEqual({ ...BRAND_BODY, loaderAnimationUrl: null });
    } finally {
      await deleteTenant(admin.tenantId);
    }
  });

  it("writes NO audit row for a no-op save, then one for the next real change", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    try {
      actAs(admin.clerkUserId, "admin@example.com");

      await request(app).put("/api/app-brand").send(BRAND_BODY);
      expect((await getAuditLogsForActor(admin.tenantId)).length).toBe(1);

      // Identical re-save: no additional row.
      const noop = await request(app).put("/api/app-brand").send(BRAND_BODY);
      expect(noop.status).toBe(200);
      expect((await getAuditLogsForActor(admin.tenantId)).length).toBe(1);

      // A real change adds a second row with the correct old/new pair.
      await request(app)
        .put("/api/app-brand")
        .send({ ...BRAND_BODY, primaryColor: "#445566" });
      const logs = await getAuditLogsForActor(admin.tenantId);
      expect(logs.length).toBe(2);
      expect(JSON.parse(logs[1].oldValue!).primaryColor).toBe("#112233");
      expect(JSON.parse(logs[1].newValue!).primaryColor).toBe("#445566");
    } finally {
      await deleteTenant(admin.tenantId);
    }
  });

  it("resetting everything back to defaults is still an audited change", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    try {
      actAs(admin.clerkUserId, "admin@example.com");

      await request(app).put("/api/app-brand").send(BRAND_BODY);
      await request(app).put("/api/app-brand").send({
        appName: null,
        logoUrl: null,
        iconUrl: null,
        primaryColor: null,
        backgroundColor: null,
      });

      const logs = await getAuditLogsForActor(admin.tenantId);
      expect(logs.length).toBe(2);
      expect(JSON.parse(logs[1].newValue!).appName).toBeNull();
    } finally {
      await deleteTenant(admin.tenantId);
    }
  });
});

describe("PUT /app-brand replaced-asset cleanup", () => {
  it("deletes the old logo object when a new logo replaces it", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    try {
      actAs(admin.clerkUserId, "admin@example.com");

      await request(app).put("/api/app-brand").send(BRAND_BODY);
      // First save: nothing to clean up (no previous logo).
      expect(deleteBrandObjectSpy).not.toHaveBeenCalled();

      const res = await request(app)
        .put("/api/app-brand")
        .send({ ...BRAND_BODY, logoUrl: "/api/storage/public-objects/brand/logo-2" });
      expect(res.status).toBe(200);
      expect(deleteBrandObjectSpy).toHaveBeenCalledTimes(1);
      expect(deleteBrandObjectSpy).toHaveBeenCalledWith(
        "/api/storage/public-objects/brand/logo-1",
      );
    } finally {
      await deleteTenant(admin.tenantId);
    }
  });

  it("deletes the old object when an asset is removed (set to null)", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    try {
      actAs(admin.clerkUserId, "admin@example.com");

      await request(app).put("/api/app-brand").send(BRAND_BODY);
      deleteBrandObjectSpy.mockClear();

      const res = await request(app)
        .put("/api/app-brand")
        .send({ ...BRAND_BODY, logoUrl: null });
      expect(res.status).toBe(200);
      expect(deleteBrandObjectSpy).toHaveBeenCalledWith(
        "/api/storage/public-objects/brand/logo-1",
      );
    } finally {
      await deleteTenant(admin.tenantId);
    }
  });

  it("does not delete anything on a no-op save, and never fails the save on storage errors", async () => {
    const admin = await createTenant({ isSuperadmin: true });
    try {
      actAs(admin.clerkUserId, "admin@example.com");

      await request(app).put("/api/app-brand").send(BRAND_BODY);
      deleteBrandObjectSpy.mockClear();

      // No-op: same logo path, no cleanup.
      await request(app).put("/api/app-brand").send(BRAND_BODY);
      expect(deleteBrandObjectSpy).not.toHaveBeenCalled();

      // Storage failure during cleanup must not fail the save itself.
      deleteBrandObjectSpy.mockRejectedValueOnce(new Error("gcs down"));
      const res = await request(app)
        .put("/api/app-brand")
        .send({ ...BRAND_BODY, logoUrl: "/api/storage/public-objects/brand/logo-3" });
      expect(res.status).toBe(200);
      expect(res.body.logoUrl).toBe("/api/storage/public-objects/brand/logo-3");
    } finally {
      await deleteTenant(admin.tenantId);
    }
  });
});
