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
  lookupOpenRouterPricing: vi.fn(async (models: string[]) => {
    // Slugs OpenRouter "publishes" token prices for. both-text/both-image are
    // priced by BOTH catalogs (ordering tests); throw-* are priced here so a
    // throwing Replicate catalog can still fall through to this one.
    const textPriced = new Set([
      "kokaotest/priced-text",
      "kokaotest/both-text",
      "kokaotest/throw-text",
    ]);
    const imagePriced = new Set([
      "kokaotest/xcat-image",
      "kokaotest/both-image",
      "kokaotest/throw-image",
    ]);
    return models.map((model) => ({
      model,
      inputPerMTokens: textPriced.has(model) ? 0.15 : null,
      outputPerMTokens: textPriced.has(model) || imagePriced.has(model) ? 0.6 : null,
    }));
  }),
}));

vi.mock("../lib/replicateCatalog", () => ({
  lookupReplicatePricing: vi.fn(async (models: string[]) =>
    models.map((model) => ({ model, price: null })),
  ),
  lookupReplicateTokenPricing: vi.fn(async (models: string[]) => {
    if (models.includes("kokaotest/throw-text")) throw new Error("catalog down");
    return models.map((model) => ({
      model,
      inputPerMTokens: model === "kokaotest/both-text" ? 2.5 : null,
      outputPerMTokens: model === "kokaotest/both-text" ? 7 : null,
    }));
  }),
  lookupReplicateUnitPricing: vi.fn(async (models: string[]) => {
    if (models.includes("kokaotest/throw-image") || models.includes("kokaotest/throw-video")) {
      throw new Error("catalog down");
    }
    return models.map((model) => ({
      model,
      usdPerImage:
        model === "kokaotest/priced-image" || model === "kokaotest/both-image" ? 0.02 : null,
      usdPerSecond: model === "kokaotest/priced-video" ? 0.4 : null,
      usdPerVideo: null,
    }));
  }),
}));

import { pool, db, aiModelPricesTable } from "@workspace/db";
import { like, and, eq, sql } from "drizzle-orm";

/** Remove every kokaotest/* price row, including legacy untrimmed spellings. */
async function cleanTestPriceRows() {
  await db
    .delete(aiModelPricesTable)
    .where(sql`lower(trim(${aiModelPricesTable.model})) like 'kokaotest/%'`);
}
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
  await cleanTestPriceRows();
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
  await cleanTestPriceRows();
});

describe("PUT /admin/text-gen-settings pricing gate", () => {
  it("rejects OpenRouter batch-only models before activation", async () => {
    const res = await request(app)
      .put("/api/admin/text-gen-settings")
      .send({
        provider: "openrouter",
        models: ["google/gemini-3.7-flash:batch"],
        defaultModel: "google/gemini-3.7-flash:batch",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Batch-only OpenRouter models");
  });

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

  it("falls back to another provider's catalog and warns the admin", async () => {
    // Replicate's own lookup returns nothing (mock), but OpenRouter prices
    // the same slug — activation must succeed, store the price under the
    // model's OWN provider, and warn the admin to verify the rate.
    const res = await request(app)
      .put("/api/admin/text-gen-settings")
      .send({ provider: "replicate", models: ["kokaotest/priced-text"] });
    expect(res.status).toBe(200);
    expect(res.body.pricingWarning).toContain("kokaotest/priced-text");
    expect(res.body.pricingWarning).toContain("openrouter");
    const [row] = await db
      .select()
      .from(aiModelPricesTable)
      .where(
        and(
          eq(aiModelPricesTable.kind, "text"),
          eq(aiModelPricesTable.provider, "replicate"),
          eq(aiModelPricesTable.model, "kokaotest/priced-text"),
        ),
      );
    expect(row).toBeTruthy();
    expect(row.inputUsdPerMtok).toBe(0.15);
  });

  it("returns no pricing warning when the model's own catalog prices it", async () => {
    const res = await request(app)
      .put("/api/admin/text-gen-settings")
      .send({ provider: "openrouter", models: ["kokaotest/priced-text"] });
    expect(res.status).toBe(200);
    expect(res.body.pricingWarning ?? null).toBeNull();
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

  it("names the kind in the rejection message", async () => {
    const res = await request(app)
      .put("/api/admin/text-gen-settings")
      .send({ provider: "openrouter", models: ["kokaotest/unpriced-text"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('"kokaotest/unpriced-text" (text)');
  });

  it("accepts a manual row that differs only in letter case and whitespace", async () => {
    // Raw insert: simulates a legacy row saved before the cost card trimmed
    // input (upsertModelPrice itself now trims).
    await db.insert(aiModelPricesTable).values({
      kind: "text",
      provider: "openrouter",
      model: "  kokaotest/UNPRICED-Text ",
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

  it("accepts a manual row saved under a different provider label (fallback)", async () => {
    await upsertModelPrice({
      kind: "text",
      provider: "Manual",
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

  it("refuses an unpriced video model, naming the engine that lacks pricing", async () => {
    const res = await request(app).put("/api/admin/video-gen-settings").send({
      provider: "replicate",
      textToVideoModel: "kokaotest/unpriced-video",
      imageToVideoModel: "kokaotest/priced-video",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('"kokaotest/unpriced-video" (video, text-to-video engine)');
    expect(res.body.error).not.toContain("image-to-video");
  });

  it("names the image-to-video engine when only that engine is unpriced", async () => {
    const res = await request(app).put("/api/admin/video-gen-settings").send({
      provider: "replicate",
      textToVideoModel: "kokaotest/priced-video",
      imageToVideoModel: "kokaotest/unpriced-video",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('"kokaotest/unpriced-video" (video, image-to-video engine)');
    expect(res.body.error).not.toContain("text-to-video engine");
  });

  it("accepts a case-differing manual video row and updates it in place", async () => {
    await upsertModelPrice({
      kind: "video",
      provider: "replicate",
      model: "kokaotest/UNPRICED-video",
      inputUsdPerMtok: null,
      outputUsdPerMtok: null,
      usdPerImage: null,
      usdPerSecond: null,
      usdPerVideo: 3,
    });
    const res = await request(app).put("/api/admin/video-gen-settings").send({
      provider: "replicate",
      textToVideoModel: "kokaotest/unpriced-video",
      imageToVideoModel: "kokaotest/unpriced-video",
    });
    expect(res.status).toBe(200);
    // No duplicate row was created under the lower-cased key.
    const rows = await db
      .select()
      .from(aiModelPricesTable)
      .where(and(eq(aiModelPricesTable.kind, "video"), like(aiModelPricesTable.model, "kokaotest/%")));
    expect(rows.filter((r) => r.model.toLowerCase() === "kokaotest/unpriced-video")).toHaveLength(1);
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

describe("cross-catalog pricing fallback for images", () => {
  it("prices from the model's own catalog with no warning", async () => {
    const res = await request(app)
      .put("/api/admin/image-gen-settings")
      .send({ provider: "replicate", model: "kokaotest/priced-image" });
    expect(res.status).toBe(200);
    expect(res.body.pricingWarning ?? null).toBeNull();
    const [row] = await db
      .select()
      .from(aiModelPricesTable)
      .where(
        and(
          eq(aiModelPricesTable.kind, "image"),
          eq(aiModelPricesTable.model, "kokaotest/priced-image"),
        ),
      );
    expect(row).toBeTruthy();
    expect(row.provider).toBe("replicate");
    expect(row.usdPerImage).toBe(0.02);
  });

  it("falls back to another provider's catalog and warns the admin", async () => {
    // Replicate publishes nothing for this slug; OpenRouter prices it by
    // tokens. Activation succeeds, stores the row under the model's OWN
    // provider, and warns so the admin verifies the rate.
    const res = await request(app)
      .put("/api/admin/image-gen-settings")
      .send({ provider: "replicate", model: "kokaotest/xcat-image" });
    expect(res.status).toBe(200);
    expect(res.body.pricingWarning).toContain("kokaotest/xcat-image");
    expect(res.body.pricingWarning).toContain("openrouter");
    const [row] = await db
      .select()
      .from(aiModelPricesTable)
      .where(
        and(
          eq(aiModelPricesTable.kind, "image"),
          eq(aiModelPricesTable.model, "kokaotest/xcat-image"),
        ),
      );
    expect(row).toBeTruthy();
    expect(row.provider).toBe("replicate");
    expect(row.outputUsdPerMtok).toBe(0.6);
    expect(row.usdPerImage).toBeNull();
  });

  it("prefers the model's own catalog when BOTH catalogs price the slug", async () => {
    // kokaotest/both-image is priced per-image on Replicate AND per-token on
    // OpenRouter. Activating on Replicate must use Replicate's price and
    // must NOT warn.
    const res = await request(app)
      .put("/api/admin/image-gen-settings")
      .send({ provider: "replicate", model: "kokaotest/both-image" });
    expect(res.status).toBe(200);
    expect(res.body.pricingWarning ?? null).toBeNull();
    const [row] = await db
      .select()
      .from(aiModelPricesTable)
      .where(
        and(
          eq(aiModelPricesTable.kind, "image"),
          eq(aiModelPricesTable.model, "kokaotest/both-image"),
        ),
      );
    expect(row).toBeTruthy();
    expect(row.usdPerImage).toBe(0.02);
    expect(row.outputUsdPerMtok).toBeNull();
  });

  it("still falls through to the next catalog when the own catalog THROWS", async () => {
    // Replicate's lookup throws for this slug (site down) — the fallback
    // catalog must still price it and the admin must still be warned.
    const res = await request(app)
      .put("/api/admin/image-gen-settings")
      .send({ provider: "replicate", model: "kokaotest/throw-image" });
    expect(res.status).toBe(200);
    expect(res.body.pricingWarning).toContain("kokaotest/throw-image");
    expect(res.body.pricingWarning).toContain("openrouter");
    const [row] = await db
      .select()
      .from(aiModelPricesTable)
      .where(
        and(
          eq(aiModelPricesTable.kind, "image"),
          eq(aiModelPricesTable.model, "kokaotest/throw-image"),
        ),
      );
    expect(row).toBeTruthy();
    expect(row.outputUsdPerMtok).toBe(0.6);
  });
});

describe("cross-catalog pricing fallback for text ordering", () => {
  it("prefers the model's own catalog when BOTH catalogs price the slug", async () => {
    // kokaotest/both-text is priced by Replicate (2.5/7) and OpenRouter
    // (0.15/0.6). Activating on Replicate must store Replicate's rates.
    const res = await request(app)
      .put("/api/admin/text-gen-settings")
      .send({ provider: "replicate", models: ["kokaotest/both-text"] });
    expect(res.status).toBe(200);
    expect(res.body.pricingWarning ?? null).toBeNull();
    const [row] = await db
      .select()
      .from(aiModelPricesTable)
      .where(
        and(
          eq(aiModelPricesTable.kind, "text"),
          eq(aiModelPricesTable.model, "kokaotest/both-text"),
        ),
      );
    expect(row).toBeTruthy();
    expect(row.inputUsdPerMtok).toBe(2.5);
    expect(row.outputUsdPerMtok).toBe(7);
  });

  it("falls through to the other catalog when the own catalog THROWS", async () => {
    const res = await request(app)
      .put("/api/admin/text-gen-settings")
      .send({ provider: "replicate", models: ["kokaotest/throw-text"] });
    expect(res.status).toBe(200);
    expect(res.body.pricingWarning).toContain("kokaotest/throw-text");
    expect(res.body.pricingWarning).toContain("openrouter");
    const [row] = await db
      .select()
      .from(aiModelPricesTable)
      .where(
        and(
          eq(aiModelPricesTable.kind, "text"),
          eq(aiModelPricesTable.model, "kokaotest/throw-text"),
        ),
      );
    expect(row).toBeTruthy();
    expect(row.provider).toBe("replicate");
    expect(row.inputUsdPerMtok).toBe(0.15);
  });
});

describe("cross-catalog pricing fallback for videos", () => {
  it("never warns when the own (only) video catalog prices the model", async () => {
    // OpenRouter publishes no video prices, so a Replicate-priced video can
    // never be cross-sourced — the warning must stay null.
    const res = await request(app).put("/api/admin/video-gen-settings").send({
      provider: "replicate",
      textToVideoModel: "kokaotest/priced-video",
      imageToVideoModel: "kokaotest/priced-video",
    });
    expect(res.status).toBe(200);
    expect(res.body.pricingWarning ?? null).toBeNull();
  });

  it("falls through to a manual row when the video catalog THROWS", async () => {
    await upsertModelPrice({
      kind: "video",
      provider: "replicate",
      model: "kokaotest/throw-video",
      inputUsdPerMtok: null,
      outputUsdPerMtok: null,
      usdPerImage: null,
      usdPerSecond: null,
      usdPerVideo: 2,
    });
    const res = await request(app).put("/api/admin/video-gen-settings").send({
      provider: "replicate",
      textToVideoModel: "kokaotest/throw-video",
      imageToVideoModel: "kokaotest/throw-video",
    });
    expect(res.status).toBe(200);
    expect(res.body.pricingWarning ?? null).toBeNull();
  });

  it("refuses when the video catalog throws and no manual row exists", async () => {
    const res = await request(app).put("/api/admin/video-gen-settings").send({
      provider: "replicate",
      textToVideoModel: "kokaotest/throw-video",
      imageToVideoModel: "kokaotest/priced-video",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("kokaotest/throw-video");
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
