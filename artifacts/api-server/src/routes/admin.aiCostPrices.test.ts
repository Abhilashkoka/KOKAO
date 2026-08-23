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

const modelPriceImport = vi.hoisted(() => ({
  parseOfficialModelPriceUrl: vi.fn((sourceUrl: string) => {
    if (sourceUrl.includes("evil")) throw new Error("Only official Replicate and OpenRouter model-page URLs are supported.");
    return {
      provider: sourceUrl.includes("replicate") ? "replicate" : "openrouter",
      model: "owner/imported-model",
    };
  }),
  previewModelPriceImport: vi.fn(async (sourceUrl: string, kind: string) => ({
    sourceUrl,
    provider: "replicate",
    model: "owner/imported-model",
    kind,
    inputUsdPerMtok: kind === "text" ? 1 : null,
    outputUsdPerMtok: kind === "text" ? 2 : null,
    usdPerImage: null,
    usdPerSecond: kind === "video" ? 0.4 : null,
    usdPerVideo: null,
    warnings: [],
  })),
}));
vi.mock("../lib/modelPriceUrlImport", () => modelPriceImport);

import { pool, db, aiModelPricesTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createAdminTestApp } from "../test/testApp";
import { resetAuthState, actAs } from "../test/authState";
import { createTenant, deleteTenant, type TestTenant } from "../test/dbHelpers";

const app = createAdminTestApp();

const RUN = `vidprice-${Date.now()}`;
let admin: TestTenant;
const createdPriceIds: number[] = [];

interface PriceRow {
  id: number;
  kind: string;
  provider: string;
  model: string;
  usdPerSecond: number | null;
  usdPerVideo: number | null;
}

async function putPrice(body: Record<string, unknown>) {
  const res = await request(app).put("/api/admin/ai-cost/prices").send(body);
  if (res.status === 200) {
    const row = (res.body.prices as PriceRow[]).find(
      (p) => p.model === body.model && p.kind === body.kind,
    );
    if (row) createdPriceIds.push(row.id);
    return { status: res.status, row };
  }
  return { status: res.status, row: undefined, error: res.body.error as string };
}

beforeAll(async () => {
  admin = await createTenant({ isSuperadmin: true });
});

afterAll(async () => {
  if (createdPriceIds.length > 0) {
    await db
      .delete(aiModelPricesTable)
      .where(inArray(aiModelPricesTable.id, createdPriceIds));
  }
  await deleteTenant(admin.tenantId);
  await pool.end();
});

beforeEach(() => {
  resetAuthState();
  actAs(admin.clerkUserId, admin.email);
  modelPriceImport.parseOfficialModelPriceUrl.mockClear();
  modelPriceImport.previewModelPriceImport.mockClear();
});

describe("PUT /admin/ai-cost/prices — video kind", () => {
  it("rejects a video row with neither per-second nor per-video price", async () => {
    const { status, error } = await putPrice({
      kind: "video",
      provider: "replicate",
      model: `${RUN}/none`,
    });
    expect(status).toBe(400);
    expect(error).toMatch(/per second|per video/i);
  });

  it("accepts a per-second-only video row", async () => {
    const { status, row } = await putPrice({
      kind: "video",
      provider: "replicate",
      model: `${RUN}/per-second`,
      usdPerSecond: 0.4,
    });
    expect(status).toBe(200);
    expect(row).toMatchObject({ usdPerSecond: 0.4, usdPerVideo: null });
  });

  it("accepts a per-video-only video row", async () => {
    const { status, row } = await putPrice({
      kind: "video",
      provider: "replicate",
      model: `${RUN}/per-video`,
      usdPerVideo: 1.25,
    });
    expect(status).toBe(200);
    expect(row).toMatchObject({ usdPerSecond: null, usdPerVideo: 1.25 });
  });

  it("accepts both prices and ignores token/image fields on video rows", async () => {
    const { status, row } = await putPrice({
      kind: "video",
      provider: "replicate",
      model: `${RUN}/both`,
      usdPerSecond: 0.2,
      usdPerVideo: 3,
      inputUsdPerMtok: 5,
      outputUsdPerMtok: 10,
      usdPerImage: 0.04,
    });
    expect(status).toBe(200);
    expect(row).toMatchObject({
      usdPerSecond: 0.2,
      usdPerVideo: 3,
      inputUsdPerMtok: null,
      outputUsdPerMtok: null,
      usdPerImage: null,
    });
  });

  it("never stores video prices on text rows", async () => {
    const { status, row } = await putPrice({
      kind: "text",
      provider: "builtin",
      model: `${RUN}-text`,
      inputUsdPerMtok: 2,
      outputUsdPerMtok: 8,
      usdPerSecond: 9,
      usdPerVideo: 9,
    });
    expect(status).toBe(200);
    expect(row).toMatchObject({ usdPerSecond: null, usdPerVideo: null });
  });
});

describe("POST /admin/ai-cost/prices/import", () => {
  const sourceUrl = "https://replicate.com/owner/imported-model";
  const reviewedVideoPrice = {
    inputUsdPerMtok: null,
    outputUsdPerMtok: null,
    usdPerImage: null,
    usdPerSecond: 0.9,
    usdPerVideo: null,
  };

  it("previews without writing a price row", async () => {
    const before = createdPriceIds.length;
    const res = await request(app)
      .post("/api/admin/ai-cost/prices/import/preview")
      .send({ sourceUrl, kind: "video" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      sourceUrl,
      provider: "replicate",
      model: "owner/imported-model",
      kind: "video",
      usdPerSecond: 0.4,
    });
    expect(createdPriceIds).toHaveLength(before);
  });

  it("rejects a provider/model mismatch before price lookup", async () => {
    const mismatchedModel = `${RUN}/mismatch`;
    const res = await request(app)
      .post("/api/admin/ai-cost/prices/import/confirm")
      .send({
        sourceUrl,
        provider: "openrouter",
        model: mismatchedModel,
        kind: "video",
        ...reviewedVideoPrice,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not match/i);
    expect(modelPriceImport.previewModelPriceImport).not.toHaveBeenCalled();
    await expect(
      db
        .select()
        .from(aiModelPricesTable)
        .where(eq(aiModelPricesTable.model, mismatchedModel)),
    ).resolves.toEqual([]);
  });

  it("persists the reviewed amount rather than overwriting it from the preview", async () => {
    const res = await request(app)
      .post("/api/admin/ai-cost/prices/import/confirm")
      .send({
        sourceUrl,
        provider: "replicate",
        model: "owner/imported-model",
        kind: "video",
        ...reviewedVideoPrice,
      });
    expect(res.status).toBe(200);
    const row = (res.body.prices as PriceRow[]).find(
      (price) => price.kind === "video" && price.model === "owner/imported-model",
    );
    expect(row).toMatchObject({ provider: "replicate", usdPerSecond: 0.9 });
    if (row) createdPriceIds.push(row.id);
  });

  it("rejects an unsafe confirmation URL before writing", async () => {
    const unsafeModel = `${RUN}/unsafe-model`;
    const res = await request(app)
      .post("/api/admin/ai-cost/prices/import/confirm")
      .send({
        sourceUrl: "https://evil.example/owner/imported-model",
        provider: "replicate",
        model: unsafeModel,
        kind: "video",
        ...reviewedVideoPrice,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/official Replicate and OpenRouter/i);
    await expect(
      db
        .select()
        .from(aiModelPricesTable)
        .where(eq(aiModelPricesTable.model, unsafeModel)),
    ).resolves.toEqual([]);
  });
});
