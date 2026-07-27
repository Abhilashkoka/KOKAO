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

// The route decorates with live catalog pricing; stub the catalog so tests
// never hit openrouter.ai. Catalog behavior itself is covered by
// openrouterCatalog.test.ts.
vi.mock("../lib/openrouterCatalog", () => ({
  lookupOpenRouterPricing: vi.fn(async (models: string[]) =>
    models.map((model) => ({
      model,
      inputPerMTokens: model === "known/model" ? 0.15 : null,
      outputPerMTokens: model === "known/model" ? 0.6 : null,
    })),
  ),
}));

vi.mock("../lib/replicateCatalog", () => ({
  lookupReplicatePricing: vi.fn(async (models: string[]) =>
    models.map((model) => ({ model, price: null })),
  ),
  lookupReplicateTokenPricing: vi.fn(async (models: string[]) =>
    models.map((model) => ({
      model,
      inputPerMTokens: model === "openai/gpt-oss-20b" ? 0.09 : null,
      outputPerMTokens: model === "openai/gpt-oss-20b" ? 0.36 : null,
    })),
  ),
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

describe("GET /admin/text-gen-model-pricing", () => {
  it("returns an entry for every submitted model id, deduped", async () => {
    const res = await request(app).get(
      "/api/admin/text-gen-model-pricing?models=known/model, unknown/model ,known/model",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { model: "known/model", inputPerMTokens: 0.15, outputPerMTokens: 0.6 },
      { model: "unknown/model", inputPerMTokens: null, outputPerMTokens: null },
    ]);
  });

  it("uses the Replicate catalog when provider=replicate", async () => {
    const res = await request(app).get(
      "/api/admin/text-gen-model-pricing?provider=replicate&models=openai/gpt-oss-20b,unknown/model",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { model: "openai/gpt-oss-20b", inputPerMTokens: 0.09, outputPerMTokens: 0.36 },
      { model: "unknown/model", inputPerMTokens: null, outputPerMTokens: null },
    ]);
  });

  it("400s when the models query is missing or empty", async () => {
    const missing = await request(app).get("/api/admin/text-gen-model-pricing");
    expect(missing.status).toBe(400);
    const empty = await request(app).get("/api/admin/text-gen-model-pricing?models=, ,");
    expect(empty.status).toBe(400);
  });

  it("is superadmin-only", async () => {
    const plain = await createTenant();
    try {
      actAs(plain.clerkUserId, plain.email);
      const res = await request(app).get(
        "/api/admin/text-gen-model-pricing?models=known/model",
      );
      expect(res.status).toBe(403);
    } finally {
      await deleteTenant(plain.tenantId);
    }
  });
});
