import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool, db, videoGenerationsTable, type VideoStoryboard } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  sweepExpiredStoryboards,
  sweepStuckVideoJobs,
  STORYBOARD_EXPIRED_ERROR,
  VIDEO_JOB_INTERRUPTED_ERROR,
  VIDEO_JOB_STUCK_TIMEOUT_MS,
} from "./videoJobSweep";
import { getCreditBalances, grantCredits } from "../credits";
import { createTenant, deleteTenant } from "../../test/dbHelpers";

let tenantId: number;

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

afterAll(async () => {
  await db.delete(videoGenerationsTable).where(eq(videoGenerationsTable.tenantId, tenantId));
  await deleteTenant(tenantId);
  await pool.end();
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
    await db
      .update(videoGenerationsTable)
      .set({
        options: {
          aspectRatio: "9:16",
          freshRestart: { version: 1, sourceJobId: 12345, childJobId: null },
        },
      })
      .where(eq(videoGenerationsTable.id, staleFreshRestart));
    const fresh = await insertRunning("processing", "credit", 1000);
    const done = await insertRunning("succeeded", "quota", VIDEO_JOB_STUCK_TIMEOUT_MS + 60_000);

    const swept = await sweepStuckVideoJobs();
    expect(swept).toBeGreaterThanOrEqual(2);

    expect((await getJob(staleCredit)).error).toBe(VIDEO_JOB_INTERRUPTED_ERROR);
    expect((await getJob(staleQueued)).status).toBe("failed");
    expect((await getJob(staleFreshRestart)).status).toBe("queued");
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
