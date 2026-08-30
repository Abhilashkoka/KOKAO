import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
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

vi.mock("../lib/connectionSweep", () => ({
  triggerSweepNow: vi.fn(() => true),
  isSweepRunning: vi.fn(() => false),
  checkSweepStaleness: vi.fn(async () => undefined),
  SWEEP_FAIL_RATIO_ALERT_THRESHOLD: 0.5,
}));

// Stub the scraper so tests never hit replicate.com; the scraper itself is
// covered by replicateCatalog.test.ts.
vi.mock("../lib/replicateCatalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/replicateCatalog")>();
  return {
    ...actual,
    lookupReplicatePricing: vi.fn(async (models: string[]) =>
      models.map((model) => ({
        model,
        price: model === "google/veo-3" ? "$0.20–$0.40 per second of output video" : null,
        entries: [],
      })),
    ),
    lookupReplicateTokenPricing: vi.fn(async (models: string[]) =>
      models.map((model) => ({ model, inputPerMTokens: null, outputPerMTokens: null })),
    ),
    lookupReplicateUnitPricing: vi.fn(async (models: string[]) =>
      models.map((model) => ({
        model,
        usdPerImage: null,
        usdPerSecond: model === "google/veo-3" ? 0.4 : null,
        usdPerVideo: null,
        entries:
          model === "google/veo-3"
            ? [
                {
                  price: "$0.20",
                  title: "per second of output video",
                  criteria: { condition: "without_audio" },
                },
                {
                  price: "$0.40",
                  title: "per second of output video",
                  criteria: { condition: "with_audio" },
                },
              ]
            : [],
      })),
    ),
  };
});

vi.mock("../lib/replicateVideoPricing", () => ({
  listReplicateVideoPricingTargets: vi.fn(() => [
    { model: "google/veo-3", label: "Veo 3", uses: ["Text to Video"] },
    { model: "sync/lipsync-2", label: "Sync Lipsync 2", uses: ["Lip Sync"] },
  ]),
  syncReplicateVideoPricing: vi.fn(async () => ({
    synced: ["google/veo-3"],
    manual: ["bytedance/latentsync"],
    unavailable: ["kwaivgi/kling-v2.1-standard"],
  })),
}));

import { pool } from "@workspace/db";
import { createAdminTestApp } from "../test/testApp";
import { resetAuthState, actAs } from "../test/authState";
import { createTenant, deleteTenant, type TestTenant } from "../test/dbHelpers";

const app = createAdminTestApp();

let admin: TestTenant;

beforeAll(async () => {
  admin = await createTenant({ isSuperadmin: true });
});

afterAll(async () => {
  await deleteTenant(admin.tenantId);
  await pool.end();
});

beforeEach(() => {
  resetAuthState();
  actAs(admin.clerkUserId, admin.email);
});

describe("GET /admin/video-model-pricing", () => {
  it("returns an entry for every submitted slug, deduped, order preserved", async () => {
    const res = await request(app).get(
      "/api/admin/video-model-pricing?models=google/veo-3, wan-video/wan-2.5-t2v ,google/veo-3",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        model: "google/veo-3",
        price: "$0.20–$0.40 per second of output video",
        variants: [
          {
            price: "$0.20",
            title: "per second of output video",
            criteria: { condition: "without_audio" },
            usdPerSecond: 0.2,
            usdPerVideo: null,
          },
          {
            price: "$0.40",
            title: "per second of output video",
            criteria: { condition: "with_audio" },
            usdPerSecond: 0.4,
            usdPerVideo: null,
          },
        ],
      },
      { model: "wan-video/wan-2.5-t2v", price: null, variants: [] },
    ]);
  });

  it("null-fills slugs past the 50-id cap instead of dropping them", async () => {
    const models = Array.from({ length: 52 }, (_, i) => `owner/model-${i}`).join(",");
    const res = await request(app).get(`/api/admin/video-model-pricing?models=${models}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(52);
    expect(res.body[51]).toEqual({ model: "owner/model-51", price: null, variants: [] });
  });

  it("400s when the models query is missing or empty", async () => {
    expect((await request(app).get("/api/admin/video-model-pricing")).status).toBe(400);
    expect(
      (await request(app).get("/api/admin/video-model-pricing?models=, ,")).status,
    ).toBe(400);
  });

  it("is superadmin-only", async () => {
    const plain = await createTenant();
    try {
      actAs(plain.clerkUserId, plain.email);
      const res = await request(app).get(
        "/api/admin/video-model-pricing?models=google/veo-3",
      );
      expect(res.status).toBe(403);
    } finally {
      await deleteTenant(plain.tenantId);
    }
  });
});

describe("POST /admin/video-model-pricing", () => {
  it("syncs the complete server-owned inventory and reports each status", async () => {
    const res = await request(app).post("/api/admin/video-model-pricing");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      synced: ["google/veo-3"],
      manual: ["bytedance/latentsync"],
      unavailable: ["kwaivgi/kling-v2.1-standard"],
    });
  });

  it("is superadmin-only", async () => {
    const plain = await createTenant();
    try {
      actAs(plain.clerkUserId, plain.email);
      expect((await request(app).post("/api/admin/video-model-pricing")).status).toBe(403);
    } finally {
      await deleteTenant(plain.tenantId);
    }
  });
});
