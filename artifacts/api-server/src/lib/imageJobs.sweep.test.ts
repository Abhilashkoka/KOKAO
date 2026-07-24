import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool, db, imageGenerationsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  sweepStuckImageJobs,
  IMAGE_JOB_STUCK_TIMEOUT_MS,
  IMAGE_JOB_INTERRUPTED_ERROR,
} from "./imageJobs";
import { getCreditBalances, grantCredits } from "./credits";
import { createTenant, deleteTenant } from "../test/dbHelpers";

let tenantId: number;

async function insertJob(
  status: string,
  funding: "quota" | "credit" | null,
  ageMs: number,
): Promise<number> {
  const row = (
    await db
      .insert(imageGenerationsTable)
      .values({
        tenantId,
        status,
        funding,
        prompt: "sweep test",
      })
      .returning({ id: imageGenerationsTable.id })
  )[0]!;
  // Backdate updatedAt explicitly (explicit set wins over $onUpdate).
  await db
    .update(imageGenerationsTable)
    .set({ updatedAt: new Date(Date.now() - ageMs) })
    .where(eq(imageGenerationsTable.id, row.id));
  return row.id;
}

async function getJob(id: number) {
  return (
    await db
      .select()
      .from(imageGenerationsTable)
      .where(eq(imageGenerationsTable.id, id))
      .limit(1)
  )[0]!;
}

beforeAll(async () => {
  const t = await createTenant();
  tenantId = t.tenantId;
});

afterAll(async () => {
  await db
    .delete(imageGenerationsTable)
    .where(eq(imageGenerationsTable.tenantId, tenantId));
  await deleteTenant(tenantId);
  await pool.end();
});

describe("sweepStuckImageJobs", () => {
  it("fails stale queued/processing rows, refunds credit funding once, leaves fresh rows alone", async () => {
    await grantCredits({
      tenantId,
      captionCredits: 0,
      imageCredits: 1,
      kind: "admin_grant",
      note: "sweep test",
    });
    // Simulate the route having spent the credit before the crash.
    const balancesBefore = await getCreditBalances(tenantId);
    expect(balancesBefore.imageCredits).toBe(1);

    const staleCredit = await insertJob(
      "processing",
      "credit",
      IMAGE_JOB_STUCK_TIMEOUT_MS + 60_000,
    );
    const staleQuota = await insertJob(
      "queued",
      "quota",
      IMAGE_JOB_STUCK_TIMEOUT_MS + 60_000,
    );
    const fresh = await insertJob("processing", "credit", 1000);
    const done = await insertJob(
      "succeeded",
      "quota",
      IMAGE_JOB_STUCK_TIMEOUT_MS + 60_000,
    );

    const swept = await sweepStuckImageJobs();
    expect(swept).toBeGreaterThanOrEqual(2);

    const creditRow = await getJob(staleCredit);
    expect(creditRow.status).toBe("failed");
    expect(creditRow.error).toBe(IMAGE_JOB_INTERRUPTED_ERROR);

    const quotaRow = await getJob(staleQuota);
    expect(quotaRow.status).toBe("failed");
    expect(quotaRow.error).toBe(IMAGE_JOB_INTERRUPTED_ERROR);

    expect((await getJob(fresh)).status).toBe("processing");
    expect((await getJob(done)).status).toBe("succeeded");

    // Credit-funded stale row refunded exactly one image credit.
    const balancesAfter = await getCreditBalances(tenantId);
    expect(balancesAfter.imageCredits).toBe(2);

    // Second sweep is a no-op for already-failed rows: no double refund.
    await sweepStuckImageJobs();
    expect((await getCreditBalances(tenantId)).imageCredits).toBe(2);
  });
});
