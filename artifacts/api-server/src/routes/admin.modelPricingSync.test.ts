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

// Stub the live provider catalogs so tests never hit openrouter.ai or
// replicate.com. Catalog parsing itself is covered by the catalog tests.
vi.mock("../lib/openrouterCatalog", () => ({
  lookupOpenRouterPricing: vi.fn(async (models: string[]) =>
    models.map((model) => ({
      model,
      inputPerMTokens: model === "kokaotest/priced-text" ? 0.15 : null,
      outputPerMTokens: model === "kokaotest/priced-text" ? 0.6 : null,
    })),
  ),
}));

vi.mock("../lib/replicateCatalog", () => ({
  lookupReplicatePricing: vi.fn(async (models: string[]) =>
    models.map((model) => ({ model, price: null })),
  ),
  lookupReplicateTokenPricing: vi.fn(async (models: string[]) =>
    models.map((model) => ({ model, inputPerMTokens: null, outputPerMTokens: null })),
  ),
  lookupReplicateUnitPricing: vi.fn(async (models: string[]) =>
    models.map((model) => ({
      model,
      usdPerImage: null,
      usdPerSecond: model === "kokaotest/priced-video" ? 0.4 : null,
      usdPerVideo: null,
    })),
  ),
}));

import { pool, db, aiModelPricesTable } from "@workspace/db";
import { like, and, eq } from "drizzle-orm";
import { createAdminTestApp } from "../test/testApp";
import { resetAuthState, actAs } from "../test/authState";
import { createTenant, deleteTenant, type TestTenant } from "../test/dbHelpers";
import { getTextGenSelection, setTextGenSelection } from "../lib/textGen";
import { getVideoGenSelection, setVideoGenSelection } from "../lib/videoGen";
import { getImageGenSelection, setImageGenSelection } from "../lib/imageGen";
import { upsertModelPrice } from "../lib/aiCost";

const app = createAdminTestApp();

let admin: TestTenant;
let savedText: Awaited<ReturnType<typeof getTextGenSelection>>;
let savedVideo: Awaited<ReturnType<typeof getVideoGenSelection>>;
let savedImage: Awaited<ReturnType<typeof getImageGenSelection>>;
const savedOpenRouterEnv = process.env.OPENROUTER_API_KEY;
const savedReplicateEnv = process.env.REPLICATE_API_TOKEN;

beforeAll(async () => {
  admin = await createTenant({ isSuperadmin: true });
  savedText = await getTextGenSelection();
  savedVideo = await getVideoGenSelection();
  savedImage = await getImageGenSelection();
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.REPLICATE_API_TOKEN = "test-key";
});

afterAll(async () => {
  // Restore selections through the libs (the routes would re-run the gate).
  await setTextGenSelection(savedText);
  await setVideoGenSelection(savedVideo);
  await setImageGenSelection(savedImage);
  await db.delete(aiModelPricesTable).where(like(aiModelPricesTable.model, "kokaotest/%"));
  if (savedOpenRouterEnv === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = savedOpenRouterEnv;
  if (savedReplicateEnv === undefined) delete process.env.REPLICATE_API_TOKEN;
  else process.env.REPLICATE_API_TOKEN = savedReplicateEnv;
  await deleteTenant(admin.tenantId);
  await pool.end();
});

beforeEach(async () => {
  resetAuthState();
  actAs(admin.clerkUserId, admin.email);
  await db.delete(aiModelPricesTable).where(like(aiModelPricesTable.model, "kokaotest/%"));
});

describe("PUT /admin/text-gen-settings pricing gate", () => {
  it("activates a catalog-priced model and syncs its price row", async () => {
    const res = await request(app)
      .put("/api/admin/text-gen-settings")
      .send({ provider: "openrouter", models: ["kokaotest/priced-text"] });
    expect(res.status).toBe(200);
    const [row] = await db
      .select()
      .from(aiModelPricesTable)
      .where(
        and(
          eq(aiModelPricesTable.kind, "text"),
          eq(aiModelPricesTable.model, "kokaotest/priced-text"),
        ),
      );
    expect(row).toBeTruthy();
    expect(row.inputUsdPerMtok).toBe(0.15);
    expect(row.outputUsdPerMtok).toBe(0.6);
  });

  it("refuses a model with no catalog price and no manual row", async () => {
    const res = await request(app)
      .put("/api/admin/text-gen-settings")
      .send({
        provider: "openrouter",
        models: ["kokaotest/priced-text", "kokaotest/unpriced-text"],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("kokaotest/unpriced-text");
    expect(res.body.error).toContain("Actual AI cost tracking");
  });

  it("accepts an unpriced-in-catalog model once a manual price row exists", async () => {
    await upsertModelPrice({
      kind: "text",
      provider: "openrouter",
      model: "kokaotest/unpriced-text",
      inputUsdPerMtok: 1,
      outputUsdPerMtok: 2,
      usdPerImage: null,
      usdPerSecond: null,
      usdPerVideo: null,
    });
    const res = await request(app)
      .put("/api/admin/text-gen-settings")
      .send({ provider: "openrouter", models: ["kokaotest/unpriced-text"] });
    expect(res.status).toBe(200);
  });
});

describe("PUT /admin/video-gen-settings pricing gate", () => {
  it("activates scrape-priced models and syncs their price rows", async () => {
    const res = await request(app).put("/api/admin/video-gen-settings").send({
      provider: "replicate",
      textToVideoModel: "kokaotest/priced-video",
      imageToVideoModel: "kokaotest/priced-video",
    });
    expect(res.status).toBe(200);
    const [row] = await db
      .select()
      .from(aiModelPricesTable)
      .where(
        and(
          eq(aiModelPricesTable.kind, "video"),
          eq(aiModelPricesTable.model, "kokaotest/priced-video"),
        ),
      );
    expect(row).toBeTruthy();
    expect(row.usdPerSecond).toBe(0.4);
  });

  it("refuses an unpriced video model", async () => {
    const res = await request(app).put("/api/admin/video-gen-settings").send({
      provider: "replicate",
      textToVideoModel: "kokaotest/unpriced-video",
      imageToVideoModel: "kokaotest/priced-video",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("kokaotest/unpriced-video");
  });

  it("does not let a live refresh erase a manual flat price", async () => {
    await upsertModelPrice({
      kind: "video",
      provider: "replicate",
      model: "kokaotest/priced-video",
      inputUsdPerMtok: null,
      outputUsdPerMtok: null,
      usdPerImage: null,
      usdPerSecond: 9.99,
      usdPerVideo: 5,
    });
    const res = await request(app).put("/api/admin/video-gen-settings").send({
      provider: "replicate",
      textToVideoModel: "kokaotest/priced-video",
      imageToVideoModel: "kokaotest/priced-video",
    });
    expect(res.status).toBe(200);
    const [row] = await db
      .select()
      .from(aiModelPricesTable)
      .where(
        and(
          eq(aiModelPricesTable.kind, "video"),
          eq(aiModelPricesTable.model, "kokaotest/priced-video"),
        ),
      );
    // Scraped $/second refreshes; the manual flat $/video survives.
    expect(row.usdPerSecond).toBe(0.4);
    expect(row.usdPerVideo).toBe(5);
  });
});

describe("PUT /admin/image-gen-settings pricing gate", () => {
  it("refuses a provider whose model has no manual price (no catalog exists)", async () => {
    await db
      .delete(aiModelPricesTable)
      .where(and(eq(aiModelPricesTable.kind, "image"), eq(aiModelPricesTable.model, "gemini-2.5-flash-image")));
    const res = await request(app)
      .put("/api/admin/image-gen-settings")
      .send({ provider: "gemini", model: "gemini-2.5-flash-image" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("gemini-2.5-flash-image");
  });

  it("activates once a manual price row exists", async () => {
    await upsertModelPrice({
      kind: "image",
      provider: "gemini",
      model: "gemini-2.5-flash-image",
      inputUsdPerMtok: null,
      outputUsdPerMtok: null,
      usdPerImage: 0.03,
      usdPerSecond: null,
      usdPerVideo: null,
    });
    try {
      const res = await request(app)
        .put("/api/admin/image-gen-settings")
        .send({ provider: "gemini", model: "gemini-2.5-flash-image" });
      expect(res.status).toBe(200);
    } finally {
      await db
        .delete(aiModelPricesTable)
        .where(
          and(
            eq(aiModelPricesTable.kind, "image"),
            eq(aiModelPricesTable.provider, "gemini"),
            eq(aiModelPricesTable.model, "gemini-2.5-flash-image"),
          ),
        );
    }
  });
});
