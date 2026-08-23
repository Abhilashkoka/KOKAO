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

const billingState = vi.hoisted(() => ({
  walletEnabled: false,
  settleFails: false,
  recordFails: false,
  reserveCalls: [] as unknown[],
  settleCalls: [] as unknown[],
  refundCalls: [] as unknown[],
}));

vi.mock("../lib/wallet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/wallet")>();
  return {
    ...actual,
    isWalletFunded: vi.fn(async () => billingState.walletEnabled),
    reserveWallet: vi.fn(async (tenantId: number, kind: string) => {
      billingState.reserveCalls.push({ tenantId, kind });
      return { id: 97402, amountPaise: 1000, units: 1 };
    }),
    settleWallet: vi.fn(async (tenantId: number, reservation: unknown, meta: unknown) => {
      billingState.settleCalls.push({ tenantId, reservation, meta });
      if (billingState.settleFails) throw new Error("settle exploded");
      return { chargedPaise: 1000, estimated: false, balancePaise: 0 };
    }),
    refundWallet: vi.fn(async (tenantId: number, reservation: unknown, note?: string) => {
      billingState.refundCalls.push({ tenantId, reservation, note });
    }),
  };
});

vi.mock("../lib/usage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/usage")>();
  return {
    ...actual,
    recordUsage: vi.fn(async (...args: Parameters<typeof actual.recordUsage>) => {
      if (billingState.recordFails) throw new Error("usage write exploded");
      return actual.recordUsage(...args);
    }),
  };
});

// ffmpeg, ASR, and the vision call are covered by referenceAnalyzer.test.ts.
// Here the analyzer is captured so route behavior (tenancy, funding, caps) is
// deterministic.
const analyzerState = vi.hoisted(() => ({
  calls: [] as { bytes: number; model: string }[],
  failNext: null as null | { kind: "analysis" | "notConfigured" | "unknown" },
}));
vi.mock("../lib/videoGen/referenceAnalyzer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/videoGen/referenceAnalyzer")>();
  const { TextGenNotConfiguredError } = await import("../lib/textGen");
  return {
    ...actual,
    analyzeReferenceVideo: vi.fn(
      async (params: { videoBytes: Buffer; tenantAiModel: string }) => {
        const failure = analyzerState.failNext;
        analyzerState.failNext = null;
        if (failure?.kind === "analysis") {
          throw new actual.ReferenceAnalysisError("That file could not be read as a video.");
        }
        if (failure?.kind === "notConfigured") {
          throw new TextGenNotConfiguredError("no provider");
        }
        if (failure?.kind === "unknown") throw new Error("socket hang up");
        analyzerState.calls.push({
          bytes: params.videoBytes.length,
          model: params.tenantAiModel,
        });
        return {
          version: 1 as const,
          hookShape: "question straight to camera",
          pacing: { sceneCount: 5, avgSceneSec: 6, wordsPerMinute: 160 },
          captionStyle: "dynamic" as const,
          energy: "punchy",
          visualNotes: ["handheld framing"],
          scriptGuidance: "Short sentences. End on a question.",
          sourceDurationSec: 30,
          transcriptExcerpt: "Here is the thing nobody tells you.",
        };
      },
    ),
  };
});

// Storage: a fake bucket whose behavior is keyed off the requested path, so the
// route's "load before funding" ordering is testable without a real bucket.
const storageState = vi.hoisted(() => ({ downloads: [] as string[] }));
vi.mock("../lib/objectStorage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/objectStorage")>();
  class FakeObjectStorageService {
    async getObjectEntityFile(objectPath: string, _tenantId: number) {
      if (objectPath.includes("missing")) {
        throw new actual.ObjectNotFoundError();
      }
      return {
        async getMetadata() {
          return [{ size: objectPath.includes("huge") ? 300 * 1024 * 1024 : 2048 }];
        },
        async download() {
          storageState.downloads.push(objectPath);
          return [Buffer.alloc(2048, 7)];
        },
      };
    }
  }
  return { ...actual, ObjectStorageService: FakeObjectStorageService };
});

import { db, videoStyleProfilesTable, tenantsTable, creditBalancesTable, creditLedgerTable } from "@workspace/db";
import type { VideoStyleProfilePayload } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireTenant } from "../middlewares/requireTenant";
import videoStylesRouter, { MAX_STYLE_PROFILES } from "./videoStyles";
import { actAs, resetAuthState } from "../test/authState";
import { createTenant, deleteTenant, type TestTenant } from "../test/dbHelpers";
import { grantCredits, getCreditBalances } from "../lib/credits";

const logMock = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

function createStylesTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: typeof logMock }).log = logMock;
    next();
  });
  app.use("/api", requireTenant, videoStylesRouter);
  return app;
}

const app = createStylesTestApp();
const createdTenants: TestTenant[] = [];

async function newTenant(plan = "free"): Promise<TestTenant> {
  const tenant = await createTenant();
  if (plan !== "free") {
    await db.update(tenantsTable).set({ plan }).where(eq(tenantsTable.id, tenant.tenantId));
  }
  createdTenants.push(tenant);
  actAs(tenant.clerkUserId);
  return tenant;
}

const samplePayload: VideoStyleProfilePayload = {
  version: 1,
  hookShape: "bold claim over a fast pan",
  pacing: { sceneCount: 4, avgSceneSec: 7.5, wordsPerMinute: 140 },
  captionStyle: "classic",
  energy: "calm",
  visualNotes: [],
  scriptGuidance: "Two short sentences per shot.",
  sourceDurationSec: 30,
  transcriptExcerpt: "",
};

async function seedProfiles(tenantId: number, count: number): Promise<void> {
  await db.insert(videoStyleProfilesTable).values(
    Array.from({ length: count }, (_, i) => ({
      tenantId,
      name: `Seeded ${i}`,
      sourceVideoPath: `/objects/${tenantId}/uploads/seed-${i}.mp4`,
      payload: samplePayload,
    })),
  );
}

beforeEach(() => {
  resetAuthState();
  billingState.walletEnabled = false;
  billingState.settleFails = false;
  billingState.recordFails = false;
  billingState.reserveCalls.length = 0;
  billingState.settleCalls.length = 0;
  billingState.refundCalls.length = 0;
  logMock.info.mockClear();
  logMock.error.mockClear();
  logMock.warn.mockClear();
  logMock.debug.mockClear();
  analyzerState.calls.length = 0;
  analyzerState.failNext = null;
  storageState.downloads.length = 0;
});

function errorLogged(substring: string): boolean {
  return (logMock.error.mock.calls as unknown[][]).some(
    (args) => typeof args[1] === "string" && args[1].includes(substring),
  );
}

afterAll(async () => {
  for (const tenant of createdTenants) {
    await db
      .delete(videoStyleProfilesTable)
      .where(eq(videoStyleProfilesTable.tenantId, tenant.tenantId));
    await db
      .delete(creditBalancesTable)
      .where(eq(creditBalancesTable.tenantId, tenant.tenantId));
    await db
      .delete(creditLedgerTable)
      .where(eq(creditLedgerTable.tenantId, tenant.tenantId));
    await deleteTenant(tenant.tenantId);
  }
});

describe("POST /api/ai/video-styles", () => {
  it("analyzes an uploaded reference and saves the profile", async () => {
    const tenant = await newTenant();
    const sourceVideoPath = `/objects/${tenant.tenantId}/uploads/reference.mp4`;
    const res = await request(app)
      .post("/api/ai/video-styles")
      .send({ name: "  Fast-cut explainer  ", sourceVideoPath });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Fast-cut explainer");
    expect(res.body.sourceVideoPath).toBe(sourceVideoPath);
    expect(res.body.payload.pacing.wordsPerMinute).toBe(160);
    expect(res.body.payload.captionStyle).toBe("dynamic");
    expect(analyzerState.calls).toEqual([{ bytes: 2048, model: expect.any(String) }]);
    expect(storageState.downloads).toEqual([sourceVideoPath]);
  });

  it("rejects a reference outside the caller's workspace before spending anything", async () => {
    const tenant = await newTenant();
    const res = await request(app)
      .post("/api/ai/video-styles")
      .send({
        name: "Stolen",
        sourceVideoPath: `/objects/${tenant.tenantId + 1}/uploads/theirs.mp4`,
      });
    expect(res.status).toBe(400);
    expect(analyzerState.calls).toHaveLength(0);
    expect(storageState.downloads).toHaveLength(0);
  });

  it("requires a name that is more than whitespace", async () => {
    const tenant = await newTenant();
    const res = await request(app)
      .post("/api/ai/video-styles")
      .send({ name: "   ", sourceVideoPath: `/objects/${tenant.tenantId}/uploads/r.mp4` });
    expect(res.status).toBe(400);
    expect(analyzerState.calls).toHaveLength(0);
  });

  it("rejects a missing upload without burning a unit", async () => {
    const tenant = await newTenant();
    const res = await request(app)
      .post("/api/ai/video-styles")
      .send({ name: "Gone", sourceVideoPath: `/objects/${tenant.tenantId}/uploads/missing.mp4` });
    expect(res.status).toBe(400);
    expect(analyzerState.calls).toHaveLength(0);
  });

  it("rejects an oversized reference before analysis", async () => {
    const tenant = await newTenant();
    const res = await request(app)
      .post("/api/ai/video-styles")
      .send({ name: "Feature film", sourceVideoPath: `/objects/${tenant.tenantId}/uploads/huge.mp4` });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too large/i);
    expect(analyzerState.calls).toHaveLength(0);
    expect(storageState.downloads).toHaveLength(0);
  });

  it("402s when the caption quota is spent and no caption credits remain", async () => {
    const tenant = await newTenant("payg"); // 0 captions/month, credit-funded only
    const res = await request(app)
      .post("/api/ai/video-styles")
      .send({ name: "No funding", sourceVideoPath: `/objects/${tenant.tenantId}/uploads/r.mp4` });
    expect(res.status).toBe(402);
    expect(analyzerState.calls).toHaveLength(0);
  });

  it("refunds the reserved caption credit when the video is unusable", async () => {
    const tenant = await newTenant("payg");
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 1,
      imageCredits: 0,
      videoCredits: 0,
      kind: "admin_grant",
      note: "test",
    });
    analyzerState.failNext = { kind: "analysis" };
    const res = await request(app)
      .post("/api/ai/video-styles")
      .send({ name: "Broken", sourceVideoPath: `/objects/${tenant.tenantId}/uploads/r.mov` });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/could not be read as a video/);
    expect((await getCreditBalances(tenant.tenantId)).captionCredits).toBe(1);
    // Nothing was saved, so the user can retry with a different file.
    const saved = await db
      .select()
      .from(videoStyleProfilesTable)
      .where(eq(videoStyleProfilesTable.tenantId, tenant.tenantId));
    expect(saved).toHaveLength(0);
  });

  it("503s when the tenant has no text model configured", async () => {
    const tenant = await newTenant();
    analyzerState.failNext = { kind: "notConfigured" };
    const res = await request(app)
      .post("/api/ai/video-styles")
      .send({ name: "No model", sourceVideoPath: `/objects/${tenant.tenantId}/uploads/r.mp4` });
    expect(res.status).toBe(503);
  });

  it("502s on an unexpected analyzer failure", async () => {
    const tenant = await newTenant();
    analyzerState.failNext = { kind: "unknown" };
    const res = await request(app)
      .post("/api/ai/video-styles")
      .send({ name: "Flaky", sourceVideoPath: `/objects/${tenant.tenantId}/uploads/r.mp4` });
    expect(res.status).toBe(502);
  });

  it("caps saved styles per workspace", async () => {
    const tenant = await newTenant();
    await seedProfiles(tenant.tenantId, MAX_STYLE_PROFILES);
    const res = await request(app)
      .post("/api/ai/video-styles")
      .send({ name: "One too many", sourceVideoPath: `/objects/${tenant.tenantId}/uploads/r.mp4` });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(new RegExp(`${MAX_STYLE_PROFILES} styles`));
    expect(analyzerState.calls).toHaveLength(0);
  });

  it("returns success without refunding when wallet settlement fails after analysis", async () => {
    billingState.walletEnabled = true;
    billingState.settleFails = true;
    const tenant = await newTenant();

    const res = await request(app)
      .post("/api/ai/video-styles")
      .send({
        name: "Fast cuts",
        sourceVideoPath: `/objects/${tenant.tenantId}/uploads/reference.mp4`,
      });

    expect(res.status).toBe(201);
    expect(billingState.settleCalls).toHaveLength(1);
    expect(billingState.refundCalls).toHaveLength(0);
    expect(errorLogged("Failed to settle style analysis wallet charge")).toBe(true);
  });

  it("never refunds when usage recording fails after wallet settlement", async () => {
    billingState.walletEnabled = true;
    billingState.recordFails = true;
    const tenant = await newTenant();

    const res = await request(app)
      .post("/api/ai/video-styles")
      .send({
        name: "Fast cuts",
        sourceVideoPath: `/objects/${tenant.tenantId}/uploads/reference.mp4`,
      });

    expect(res.status).toBe(201);
    expect(billingState.settleCalls).toHaveLength(1);
    expect(billingState.refundCalls).toHaveLength(0);
    expect(errorLogged("Failed to record style analysis usage after successful work")).toBe(true);
  });
});

describe("GET /api/ai/video-styles", () => {
  it("lists only the caller's styles, oldest first", async () => {
    const other = await newTenant();
    await seedProfiles(other.tenantId, 1);
    const tenant = await newTenant();
    await seedProfiles(tenant.tenantId, 2);
    const res = await request(app).get("/api/ai/video-styles");
    expect(res.status).toBe(200);
    expect(res.body.map((p: { name: string }) => p.name)).toEqual(["Seeded 0", "Seeded 1"]);
    expect(res.body[0].payload.hookShape).toBe(samplePayload.hookShape);
  });
});

describe("DELETE /api/ai/video-styles/:styleId", () => {
  it("deletes the caller's style", async () => {
    const tenant = await newTenant();
    await seedProfiles(tenant.tenantId, 1);
    const [profile] = await db
      .select()
      .from(videoStyleProfilesTable)
      .where(eq(videoStyleProfilesTable.tenantId, tenant.tenantId));
    const res = await request(app).delete(`/api/ai/video-styles/${profile!.id}`);
    expect(res.status).toBe(204);
    const remaining = await db
      .select()
      .from(videoStyleProfilesTable)
      .where(eq(videoStyleProfilesTable.tenantId, tenant.tenantId));
    expect(remaining).toHaveLength(0);
  });

  it("404s for another workspace's style and for a bad id", async () => {
    const other = await newTenant();
    await seedProfiles(other.tenantId, 1);
    const [theirs] = await db
      .select()
      .from(videoStyleProfilesTable)
      .where(eq(videoStyleProfilesTable.tenantId, other.tenantId));
    await newTenant();
    expect((await request(app).delete(`/api/ai/video-styles/${theirs!.id}`)).status).toBe(404);
    expect((await request(app).delete("/api/ai/video-styles/abc")).status).toBe(400);
    // The other workspace still has it.
    const still = await db
      .select()
      .from(videoStyleProfilesTable)
      .where(eq(videoStyleProfilesTable.tenantId, other.tenantId));
    expect(still).toHaveLength(1);
  });
});
