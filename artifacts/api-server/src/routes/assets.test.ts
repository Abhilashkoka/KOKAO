import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
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

vi.mock("../lib/characters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/characters")>();
  return {
    ...actual,
    loadReferenceImage: vi.fn(async () => ({
      buffer: Buffer.from("img"),
      mimeType: "image/png",
    })),
  };
});

import { db, visualAssetsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireTenant } from "../middlewares/requireTenant";
import assetsRouter, { MAX_VISUAL_ASSETS } from "./assets";
import { actAs, resetAuthState } from "../test/authState";
import { createTenant, deleteTenant, type TestTenant } from "../test/dbHelpers";

function createAssetsTestApp(): Express {
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
  app.use("/api", requireTenant, assetsRouter);
  return app;
}

const app = createAssetsTestApp();
const createdTenants: TestTenant[] = [];

async function newTenant(): Promise<TestTenant> {
  const tenant = await createTenant();
  createdTenants.push(tenant);
  actAs(tenant.clerkUserId);
  return tenant;
}

beforeEach(() => {
  resetAuthState();
});

afterAll(async () => {
  for (const tenant of createdTenants) {
    await db
      .delete(visualAssetsTable)
      .where(eq(visualAssetsTable.tenantId, tenant.tenantId));
    await deleteTenant(tenant.tenantId);
  }
});

function createAsset(tenantId: number, n: number) {
  return request(app)
    .post("/api/visual-assets")
    .send({ name: `Asset ${n}`, imagePath: `/objects/${tenantId}/uploads/a${n}.png` });
}

describe("POST /api/visual-assets", () => {
  it("saves an asset within the caller's workspace", async () => {
    const tenant = await newTenant();
    const res = await createAsset(tenant.tenantId, 1);
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Asset 1");
  });

  it("rejects an image path outside the caller's workspace", async () => {
    const tenant = await newTenant();
    const res = await request(app)
      .post("/api/visual-assets")
      .send({
        name: "Stolen",
        imagePath: `/objects/${tenant.tenantId + 1}/uploads/stolen.png`,
      });
    expect(res.status).toBe(400);
  });

  it("never exceeds the cap even under concurrent creates", async () => {
    const tenant = await newTenant();
    // Fire more parallel creates than the cap allows.
    const attempts = MAX_VISUAL_ASSETS + 4;
    const results = await Promise.all(
      Array.from({ length: attempts }, (_, i) => createAsset(tenant.tenantId, i)),
    );
    const created = results.filter((r) => r.status === 201).length;
    const rejected = results.filter((r) => r.status === 400).length;
    expect(created).toBe(MAX_VISUAL_ASSETS);
    expect(rejected).toBe(attempts - MAX_VISUAL_ASSETS);
    const rows = await db
      .select({ id: visualAssetsTable.id })
      .from(visualAssetsTable)
      .where(eq(visualAssetsTable.tenantId, tenant.tenantId));
    expect(rows.length).toBe(MAX_VISUAL_ASSETS);
  });
});

describe("DELETE /api/visual-assets/:assetId", () => {
  it("only deletes assets in the caller's workspace", async () => {
    const tenantA = await newTenant();
    const created = await createAsset(tenantA.tenantId, 1);
    expect(created.status).toBe(201);
    const tenantB = await newTenant();
    actAs(tenantB.clerkUserId);
    const res = await request(app).delete(`/api/visual-assets/${created.body.id}`);
    expect(res.status).toBe(404);
    actAs(tenantA.clerkUserId);
    const ok = await request(app).delete(`/api/visual-assets/${created.body.id}`);
    expect(ok.status).toBe(204);
  });
});
