import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { pool, db, videoGenerationsTable, type VideoStoryboard } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  sweepGuidedAtlasBackdropAssets,
  sweepExpiredStoryboards,
  sweepStuckVideoJobs,
  sweepStrandedGuidedStoryCreations,
  sweepStrandedRetryCreations,
  retryCreatingInterruptedError,
  guidedStoryCreatingInterruptedError,
  GUIDED_STORY_CREATING_TIMEOUT_MS,
  STORYBOARD_EXPIRED_ERROR,
  VIDEO_JOB_INTERRUPTED_ERROR,
  VIDEO_JOB_STUCK_TIMEOUT_MS,
} from "./videoJobSweep";
import { getCreditBalances, grantCredits } from "../credits";
import { createTenant, deleteTenant } from "../../test/dbHelpers";
import { VIDEO_PROCESS_INSTANCE_ID } from "./processInstance";

let tenantId: number;

const atlasSweepState = vi.hoisted(() => ({
  deleted: [] as number[],
  terminalTaskIds: new Set<string>(),
}));

vi.mock("../atlascloud/assets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../atlascloud/assets")>();
  return {
    ...actual,
    resolveAtlasAssetsKey: vi.fn(async () => "atlas-test-key"),
    isAtlasPredictionTerminal: vi.fn(async (taskId: string) =>
      atlasSweepState.terminalTaskIds.has(taskId)),
    deleteAtlasAsset: vi.fn(async (libraryRecordId: number) => {
      atlasSweepState.deleted.push(libraryRecordId);
    }),
  };
});

/** A one-paragraph character plan: four scenes, so four reserved video units. */
function plan(): VideoStoryboard {
  return {
    version: 1,
    visualsSource: "character",
    timelineLocked: true,
    model: "kwaivgi/kling-v1.6-standard",
    provider: "replicate",
    regenerations: 0,
    narration: {
      audioPath: `/objects/${tenantId}/uploads/narration.wav`,
      totalDurationSec: 24,
      cues: [{ text: "Line", startSec: 0, endSec: 24 }],
    },
    scenes: Array.from({ length: 4 }, (_, i) => ({
      id: `s${i + 1}`,
      text: "Line",
      visual: `shot ${i + 1}`,
      durationSec: 6,
      previewPath: null,
      outfitId: null,
    })),
  };
}

async function insertPaused(
  funding: "quota" | "credit" | null,
  expiresInMs: number,
  paragraphCount = 1,
): Promise<number> {
  const row = (
    await db
      .insert(videoGenerationsTable)
      .values({
        tenantId,
        engine: "topic_to_video",
        status: "awaiting_review",
        funding,
        options: { aspectRatio: "9:16", visualsSource: "character", paragraphCount },
        storyboard: plan(),
        storyboardExpiresAt: new Date(Date.now() + expiresInMs),
      })
      .returning({ id: videoGenerationsTable.id })
  )[0]!;
  return row.id;
}

async function insertRunning(
  status: string,
  funding: "quota" | "credit" | null,
  ageMs: number,
): Promise<number> {
  const row = (
    await db
      .insert(videoGenerationsTable)
      .values({ tenantId, engine: "text_to_video", status, funding, prompt: "sweep test" })
      .returning({ id: videoGenerationsTable.id })
  )[0]!;
  // Backdate updatedAt explicitly (an explicit set wins over $onUpdate).
  await db
    .update(videoGenerationsTable)
    .set({ updatedAt: new Date(Date.now() - ageMs) })
    .where(eq(videoGenerationsTable.id, row.id));
  return row.id;
}

async function getJob(id: number) {
  return (
    await db.select().from(videoGenerationsTable).where(eq(videoGenerationsTable.id, id)).limit(1)
  )[0]!;
}

beforeAll(async () => {
  const t = await createTenant();
  tenantId = t.tenantId;
});

beforeEach(() => {
  atlasSweepState.deleted.length = 0;
  atlasSweepState.terminalTaskIds.clear();
});

afterAll(async () => {
  await db.delete(videoGenerationsTable).where(eq(videoGenerationsTable.tenantId, tenantId));
  await deleteTenant(tenantId);
  await pool.end();
});

describe("sweepGuidedAtlasBackdropAssets", () => {
  it("spares a live pre-submit asset and removes it after the job terminalizes", async () => {
    const [row] = await db.insert(videoGenerationsTable).values({
      tenantId,
      engine: "topic_to_video",
      status: "processing",
      funding: "quota",
      options: {
        aspectRatio: "9:16",
        guidedAtlasBackdropAssets: {
          shared: {
            version: 1,
            libraryRecordId: 3101,
            generationReferenceId: "asset-backdrop-3101",
            sourcePath: `/objects/${tenantId}/backdrop.png`,
            sourceSha256: "a".repeat(64),
            dependentOperationKeys: ["topic_animation:0"],
            createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
          },
        },
      },
      updatedAt: new Date(Date.now() - 60 * 60_000),
    }).returning({ id: videoGenerationsTable.id });

    await expect(sweepGuidedAtlasBackdropAssets()).resolves.toBe(0);
    expect(atlasSweepState.deleted).toEqual([]);

    await db.update(videoGenerationsTable).set({
      status: "failed",
      updatedAt: new Date(Date.now() - 10 * 60_000),
    }).where(eq(videoGenerationsTable.id, row!.id));
    await expect(sweepGuidedAtlasBackdropAssets()).resolves.toBe(1);
    expect(atlasSweepState.deleted).toEqual([3101]);
    expect((await getJob(row!.id)).options!.guidedAtlasBackdropAssets).toBeNull();
  });

  it("waits for every accepted prediction sharing a backdrop to become terminal", async () => {
    const [row] = await db.insert(videoGenerationsTable).values({
      tenantId,
      engine: "topic_to_video",
      status: "failed",
      funding: "quota",
      options: {
        aspectRatio: "9:16",
        providerTasks: {
          "topic_animation:0": {
            provider: "atlascloud",
            model: "bytedance/seedance-2.5/reference-to-video",
            taskId: "prediction-terminal",
            requestId: null,
            acceptedAt: new Date().toISOString(),
          },
          "topic_animation:1": {
            provider: "atlascloud",
            model: "bytedance/seedance-2.5/reference-to-video",
            taskId: "prediction-running",
            requestId: null,
            acceptedAt: new Date().toISOString(),
          },
        },
        guidedAtlasBackdropAssets: {
          shared: {
            version: 1,
            libraryRecordId: 3102,
            generationReferenceId: "asset-backdrop-3102",
            sourcePath: `/objects/${tenantId}/shared.png`,
            sourceSha256: "b".repeat(64),
            dependentOperationKeys: ["topic_animation:0", "topic_animation:1"],
            createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
          },
        },
      },
      updatedAt: new Date(Date.now() - 10 * 60_000),
    }).returning({ id: videoGenerationsTable.id });

    atlasSweepState.terminalTaskIds.add("prediction-terminal");
    await expect(sweepGuidedAtlasBackdropAssets()).resolves.toBe(0);
    expect(atlasSweepState.deleted).toEqual([]);

    atlasSweepState.terminalTaskIds.add("prediction-running");
    await expect(sweepGuidedAtlasBackdropAssets()).resolves.toBe(1);
    expect(atlasSweepState.deleted).toEqual([3102]);
    expect((await getJob(row!.id)).options!.guidedAtlasBackdropAssets).toBeNull();
  });
});

describe("sweepExpiredStoryboards", () => {
  it("fails plans past their window, refunds credit funding once, spares fresh ones", async () => {
    await grantCredits({
      tenantId,
      captionCredits: 0,
      imageCredits: 0,
      videoCredits: 0,
      kind: "admin_grant",
      note: "sweep test",
    });

    const staleCredit = await insertPaused("credit", -60_000);
    // Two paragraphs, so eight units — a refund here would be visible.
    const staleQuota = await insertPaused("quota", -60_000, 2);
    const fresh = await insertPaused("credit", 60_000);

    const swept = await sweepExpiredStoryboards();
    expect(swept).toBeGreaterThanOrEqual(2);

    const creditRow = await getJob(staleCredit);
    expect(creditRow.status).toBe("failed");
    expect(creditRow.error).toBe(STORYBOARD_EXPIRED_ERROR);
    expect(creditRow.storyboardExpiresAt).toBeNull();
    expect((await getJob(staleQuota)).status).toBe("failed");
    expect((await getJob(fresh)).status).toBe("awaiting_review");

    // Four scenes reserved, four scenes back — and only for the credit row.
    expect((await getCreditBalances(tenantId)).videoCredits).toBe(4);

    // A second pass finds nothing to flip, so it cannot refund again.
    await sweepExpiredStoryboards();
    expect((await getCreditBalances(tenantId)).videoCredits).toBe(4);
    expect((await getJob(fresh)).status).toBe("awaiting_review");
  });
});

describe("sweepStuckVideoJobs", () => {
  it("fails rows orphaned in queued/processing and leaves settled ones alone", async () => {
    const before = (await getCreditBalances(tenantId)).videoCredits;
    const staleCredit = await insertRunning(
      "processing",
      "credit",
      VIDEO_JOB_STUCK_TIMEOUT_MS + 60_000,
    );
    const staleQueued = await insertRunning(
      "queued",
      "quota",
      VIDEO_JOB_STUCK_TIMEOUT_MS + 60_000,
    );
    const staleFreshRestart = await insertRunning(
      "queued",
      "quota",
      VIDEO_JOB_STUCK_TIMEOUT_MS + 60_000,
    );
    const staleProcessingFreshRestart = await insertRunning(
      "processing",
      "quota",
      VIDEO_JOB_STUCK_TIMEOUT_MS + 60_000,
    );
    await db
      .update(videoGenerationsTable)
      .set({
        options: {
          aspectRatio: "9:16",
          freshRestart: { version: 1, sourceJobId: 12345, childJobId: null },
        },
      })
      .where(eq(videoGenerationsTable.id, staleFreshRestart));
    await db
      .update(videoGenerationsTable)
      .set({
        options: {
          aspectRatio: "9:16",
          freshRestart: { version: 1, sourceJobId: 12345, childJobId: null },
        },
        updatedAt: new Date(
          Date.now() - VIDEO_JOB_STUCK_TIMEOUT_MS - 60_000,
        ),
      })
      .where(eq(videoGenerationsTable.id, staleProcessingFreshRestart));
    const fresh = await insertRunning("processing", "credit", 1000);
    const done = await insertRunning("succeeded", "quota", VIDEO_JOB_STUCK_TIMEOUT_MS + 60_000);

    const swept = await sweepStuckVideoJobs();
    expect(swept).toBeGreaterThanOrEqual(2);

    expect((await getJob(staleCredit)).error).toBe(VIDEO_JOB_INTERRUPTED_ERROR);
    expect((await getJob(staleQueued)).status).toBe("failed");
    expect((await getJob(staleFreshRestart)).status).toBe("queued");
    expect((await getJob(staleProcessingFreshRestart)).status).toBe("failed");
    expect((await getJob(fresh)).status).toBe("processing");
    expect((await getJob(done)).status).toBe("succeeded");

    // text_to_video is one unit, refunded only for the credit-funded row.
    expect((await getCreditBalances(tenantId)).videoCredits).toBe(before + 1);
  });

  it("does not touch a storyboard that is still waiting for review", async () => {
    const paused = await insertPaused("credit", 60_000);
    await db
      .update(videoGenerationsTable)
      .set({ updatedAt: new Date(Date.now() - VIDEO_JOB_STUCK_TIMEOUT_MS - 60_000) })
      .where(eq(videoGenerationsTable.id, paused));

    await sweepStuckVideoJobs();
    expect((await getJob(paused)).status).toBe("awaiting_review");
  });
});

describe("sweepStrandedGuidedStoryCreations", () => {
  it("does not kill an active lease after ten minutes, then expires its exact owner", async () => {
    const owner = "active-registration-owner";
    const [created] = await db.insert(videoGenerationsTable).values({
      tenantId,
      engine: "topic_to_video",
      status: "creating",
      provider: "atlascloud",
      options: {
        aspectRatio: "9:16",
        guidedStory: { draftId: 987653 },
        guidedCreatingLease: {
          version: 1,
          owner,
          processInstanceId: VIDEO_PROCESS_INSTANCE_ID,
          heartbeatAt: new Date(Date.now() - 11 * 60_000).toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      } as unknown as typeof videoGenerationsTable.$inferInsert.options,
    }).returning();
    await db.update(videoGenerationsTable).set({
      updatedAt: new Date(Date.now() - 11 * 60_000),
    }).where(eq(videoGenerationsTable.id, created!.id));

    await sweepStrandedGuidedStoryCreations();
    expect((await getJob(created!.id)).status).toBe("creating");

    const options = (await getJob(created!.id)).options!;
    await db.update(videoGenerationsTable).set({
      options: {
        ...options,
        guidedCreatingLease: {
          ...options.guidedCreatingLease!,
          expiresAt: new Date(Date.now() - 1_000).toISOString(),
        },
      },
    }).where(eq(videoGenerationsTable.id, created!.id));
    expect(await sweepStrandedGuidedStoryCreations()).toBeGreaterThanOrEqual(1);
    expect((await getJob(created!.id)).status).toBe("failed");
  });

  it("immediately terminalizes an unexpired lease owned by a prior API process", async () => {
    const [created] = await db.insert(videoGenerationsTable).values({
      tenantId,
      engine: "topic_to_video",
      status: "creating",
      provider: "atlascloud",
      options: {
        aspectRatio: "9:16",
        guidedStory: { draftId: 987655 },
        guidedCreatingLease: {
          version: 1,
          owner: "dead-registration-owner",
          processInstanceId: "prior-api-process",
          heartbeatAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
        },
      } as unknown as typeof videoGenerationsTable.$inferInsert.options,
    }).returning();

    expect(await sweepStrandedGuidedStoryCreations()).toBeGreaterThanOrEqual(1);
    expect((await getJob(created!.id)).error).toBe(
      guidedStoryCreatingInterruptedError(created!.id),
    );
  });

  it("terminalizes a stale numbered Atlas Guided attempt exactly once", async () => {
    const [created] = await db.insert(videoGenerationsTable).values({
      tenantId,
      engine: "topic_to_video",
      status: "creating",
      provider: "atlascloud",
      options: {
        aspectRatio: "9:16",
        guidedStory: { draftId: 987654 },
      } as typeof videoGenerationsTable.$inferInsert.options,
    }).returning();
    await db.update(videoGenerationsTable).set({
      updatedAt: new Date(Date.now() - GUIDED_STORY_CREATING_TIMEOUT_MS - 1_000),
    }).where(eq(videoGenerationsTable.id, created!.id));

    expect(await sweepStrandedGuidedStoryCreations()).toBeGreaterThanOrEqual(1);
    const failed = await getJob(created!.id);
    expect(failed.status).toBe("failed");
    expect(failed.funding).toBeNull();
    expect(failed.error).toBe(guidedStoryCreatingInterruptedError(created!.id));
    expect(await sweepStrandedGuidedStoryCreations()).toBe(0);
  });
});

describe("sweepStrandedRetryCreations", () => {
  it("terminalizes an expired non-Atlas retry lease and retains its numbered row", async () => {
    const [created] = await db.insert(videoGenerationsTable).values({
      tenantId,
      engine: "text_to_video",
      status: "creating",
      provider: "replicate",
      options: {
        aspectRatio: "9:16",
        recovery: {
          version: 1,
          chainId: 999001,
          sourceJobId: 999001,
          fundedUnits: 1,
          mode: "saved_inputs",
          state: "creating",
          reusable: [],
          regenerated: ["video"],
          creatingLease: {
            version: 1,
            owner: "expired-non-atlas-retry",
            heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
            expiresAt: new Date(Date.now() - 1_000).toISOString(),
          },
        },
      },
    }).returning();
    expect(await sweepStrandedRetryCreations()).toBeGreaterThanOrEqual(1);
    const failed = await getJob(created!.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe(retryCreatingInterruptedError(created!.id));
    expect(await sweepStrandedRetryCreations()).toBe(0);
  });
});
