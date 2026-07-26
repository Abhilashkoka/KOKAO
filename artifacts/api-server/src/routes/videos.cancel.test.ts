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

// The runner is exercised elsewhere; these tests only need the row states.
vi.mock("../lib/videoGen/jobRunner", () => ({
  runVideoGenerationJob: vi.fn(async () => {}),
  resumeVideoGenerationJob: vi.fn(async () => {}),
  refreshStoryboardScenePreview: vi.fn(async () => {}),
  STORYBOARD_REGENERATIONS_PER_SCENE: 3,
}));

import { db, videoGenerationsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireTenant } from "../middlewares/requireTenant";
import videosRouter from "./videos";
import { actAs, resetAuthState } from "../test/authState";
import { createTenant, deleteTenant, type TestTenant } from "../test/dbHelpers";
import { getCreditBalances } from "../lib/credits";

function createApp(): Express {
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
  app.use("/api", requireTenant, videosRouter);
  return app;
}

const app = createApp();
const createdTenants: TestTenant[] = [];
const createdJobIds: number[] = [];

async function newTenant(): Promise<TestTenant> {
  const tenant = await createTenant();
  createdTenants.push(tenant);
  return tenant;
}

async function seedJob(
  tenantId: number,
  status: string,
  funding: "quota" | "credit" = "quota",
  engine = "slideshow",
  options: Record<string, unknown> | null = null,
): Promise<number> {
  const [row] = await db
    .insert(videoGenerationsTable)
    .values({
      tenantId,
      status,
      funding,
      engine,
      prompt: "test prompt",
      options: options as never,
    })
    .returning();
  createdJobIds.push(row.id);
  return row.id;
}

beforeEach(() => {
  resetAuthState();
});

afterAll(async () => {
  for (const id of createdJobIds) {
    await db.delete(videoGenerationsTable).where(eq(videoGenerationsTable.id, id));
  }
  for (const t of createdTenants) {
    await deleteTenant(t.tenantId);
  }
});

describe("POST /ai/video-jobs/:jobId/cancel", () => {
  it("cancels a queued quota-funded job without touching credits", async () => {
    const tenant = await newTenant();
    actAs(tenant.clerkUserId);
    const jobId = await seedJob(tenant.tenantId, "queued", "quota");

    const res = await request(app).post(`/api/ai/video-jobs/${jobId}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");

    const row = (
      await db
        .select()
        .from(videoGenerationsTable)
        .where(eq(videoGenerationsTable.id, jobId))
    )[0];
    expect(row.status).toBe("cancelled");
    const balances = await getCreditBalances(tenant.tenantId);
    expect(balances.videoCredits ?? 0).toBe(0);
  });

  it("refunds the credit when a credit-funded queued job is cancelled", async () => {
    const tenant = await newTenant();
    actAs(tenant.clerkUserId);
    const jobId = await seedJob(tenant.tenantId, "queued", "credit");

    const res = await request(app).post(`/api/ai/video-jobs/${jobId}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");

    const balances = await getCreditBalances(tenant.tenantId);
    expect(balances.videoCredits).toBe(1);
  });

  it("refunds the per-scene unit price for multi-unit jobs", async () => {
    // A 2-paragraph character story is 8 units — the same amount the route
    // reserved when it priced the job at enqueue.
    const tenant = await newTenant();
    actAs(tenant.clerkUserId);
    const jobId = await seedJob(tenant.tenantId, "queued", "credit", "topic_to_video", {
      visualsSource: "character",
      paragraphCount: 2,
    });

    const res = await request(app).post(`/api/ai/video-jobs/${jobId}/cancel`);
    expect(res.status).toBe(200);

    const balances = await getCreditBalances(tenant.tenantId);
    expect(balances.videoCredits).toBe(8);
  });

  it("rejects cancelling a processing job with 409 and no refund", async () => {
    const tenant = await newTenant();
    actAs(tenant.clerkUserId);
    const jobId = await seedJob(tenant.tenantId, "processing", "credit");

    const res = await request(app).post(`/api/ai/video-jobs/${jobId}/cancel`);
    expect(res.status).toBe(409);

    const row = (
      await db
        .select()
        .from(videoGenerationsTable)
        .where(eq(videoGenerationsTable.id, jobId))
    )[0];
    expect(row.status).toBe("processing");
    const balances = await getCreditBalances(tenant.tenantId);
    expect(balances.videoCredits ?? 0).toBe(0);
  });

  it("rejects cancelling an awaiting_review job with 409 pointing at discard", async () => {
    const tenant = await newTenant();
    actAs(tenant.clerkUserId);
    const jobId = await seedJob(tenant.tenantId, "awaiting_review", "credit");

    const res = await request(app).post(`/api/ai/video-jobs/${jobId}/cancel`);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("storyboard");
    const balances = await getCreditBalances(tenant.tenantId);
    expect(balances.videoCredits ?? 0).toBe(0);
  });

  it("rejects cancelling a finished job with 409", async () => {
    const tenant = await newTenant();
    actAs(tenant.clerkUserId);
    const jobId = await seedJob(tenant.tenantId, "succeeded");

    const res = await request(app).post(`/api/ai/video-jobs/${jobId}/cancel`);
    expect(res.status).toBe(409);
  });

  it("404s on another tenant's job", async () => {
    const owner = await newTenant();
    const stranger = await newTenant();
    const jobId = await seedJob(owner.tenantId, "queued");

    actAs(stranger.clerkUserId);
    const res = await request(app).post(`/api/ai/video-jobs/${jobId}/cancel`);
    expect(res.status).toBe(404);

    const row = (
      await db
        .select()
        .from(videoGenerationsTable)
        .where(eq(videoGenerationsTable.id, jobId))
    )[0];
    expect(row.status).toBe("queued");
  });
});
