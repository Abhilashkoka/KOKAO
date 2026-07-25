/**
 * Hook writer + platform pack: response parsing, platform filtering, and the
 * caption-style funding contract (quota → credit → 402; refund on failure).
 */
import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

const planState = { captions: 5 };
vi.mock("../lib/plans", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/plans")>();
  return {
    ...actual,
    getPlanLimits: vi.fn(async () => ({
      captions: planState.captions,
      images: 0,
      videos: 0,
      teamSeats: 0,
    })),
  };
});

const modelState: { reply: unknown; fail: boolean } = { reply: {}, fail: false };
vi.mock("../lib/textGen", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/textGen")>();
  return {
    ...actual,
    getTextGenClient: vi.fn(async () => ({
      provider: "builtin",
      model: "test-model",
      client: {
        chat: {
          completions: {
            create: vi.fn(async () => {
              if (modelState.fail) throw new Error("upstream exploded");
              return {
                choices: [{ message: { content: JSON.stringify(modelState.reply) } }],
              };
            }),
          },
        },
      },
    })),
  };
});

import { db, pool, usageEventsTable, creditLedgerTable, creditBalancesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import aiRouter from "./ai";
import { grantCredits, getCreditBalances } from "../lib/credits";
import { createTenant, deleteTenant, type TestTenant } from "../test/dbHelpers";

let app: Express;
let tenant: TestTenant;

beforeEach(async () => {
  tenant = await createTenant();
  planState.captions = 5;
  modelState.fail = false;
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { tenantId: number }).tenantId = tenant.tenantId;
    (req as unknown as { log: unknown }).log = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };
    next();
  });
  app.use(aiRouter);
});

afterEach(async () => {
  await db.delete(usageEventsTable).where(eq(usageEventsTable.tenantId, tenant.tenantId));
  await db.delete(creditLedgerTable).where(eq(creditLedgerTable.tenantId, tenant.tenantId));
  await db.delete(creditBalancesTable).where(eq(creditBalancesTable.tenantId, tenant.tenantId));
  await deleteTenant(tenant.tenantId);
});

afterAll(async () => {
  await pool.end();
});

describe("POST /ai/generate-hooks", () => {
  it("returns the parsed hook variants", async () => {
    modelState.reply = {
      hooks: [
        { style: "question", text: "Still doing chai the slow way?" },
        { style: "stat", text: "83% of founders skip this one habit." },
      ],
    };
    const res = await request(app)
      .post("/ai/generate-hooks")
      .send({ topic: "morning habits for founders" });
    expect(res.status).toBe(200);
    expect(res.body.hooks).toHaveLength(2);
    expect(res.body.hooks[0]).toEqual({
      style: "question",
      text: "Still doing chai the slow way?",
    });
  });

  it("rejects a too-short topic", async () => {
    const res = await request(app).post("/ai/generate-hooks").send({ topic: "x" });
    expect(res.status).toBe(400);
  });
});

describe("POST /ai/platform-pack", () => {
  const reply = {
    title: "Slow Morning Chai",
    items: [
      { platform: "instagram", caption: "IG caption", hashtags: ["chai", "slowliving"], cta: "Save this." },
      { platform: "twitter", caption: "X caption", hashtags: ["chai"], cta: "Repost if you agree." },
      { platform: "myspace", caption: "should be filtered out", hashtags: [], cta: "" },
    ],
  };

  it("returns captions only for requested platforms and records usage", async () => {
    modelState.reply = reply;
    const res = await request(app)
      .post("/ai/platform-pack")
      .send({ brief: "A cozy chai brand launching a slow-morning ritual kit", platforms: ["instagram", "twitter"] });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Slow Morning Chai");
    expect(res.body.items.map((i: { platform: string }) => i.platform)).toEqual([
      "instagram",
      "twitter",
    ]);
    const usage = await db
      .select()
      .from(usageEventsTable)
      .where(eq(usageEventsTable.tenantId, tenant.tenantId));
    expect(usage).toHaveLength(1);
    expect(usage[0]!.kind).toBe("caption");
  });

  it("402s when quota and credits are both gone", async () => {
    planState.captions = 0;
    const res = await request(app)
      .post("/ai/platform-pack")
      .send({ brief: "A cozy chai brand launching a slow-morning ritual kit" });
    expect(res.status).toBe(402);
  });

  it("refunds a reserved credit when the model fails", async () => {
    planState.captions = 0;
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 1,
      imageCredits: 0,
      kind: "admin_grant",
      note: "test grant",
    });
    modelState.fail = true;
    const res = await request(app)
      .post("/ai/platform-pack")
      .send({ brief: "A cozy chai brand launching a slow-morning ritual kit" });
    expect(res.status).toBe(500);
    const balances = await getCreditBalances(tenant.tenantId);
    expect(balances.captionCredits).toBe(1);
  });
});
