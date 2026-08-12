import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { db, pool, imageGenerationsTable, usageEventsTable, type AiSpendSettings } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { setAiSpendConfig } from "./aiSpend";
import { runImageGenerationJob } from "./imageJobs";
import {
  createTenant,
  deleteTenant,
  snapshotAiSpendSettings,
  restoreAiSpendSettings,
  type TestTenant,
} from "../test/dbHelpers";

// The provider call is the only external dependency of the runner; everything
// else (status flips, spend snapshot, usage rows) runs against the real DB.
vi.mock("./imageGeneration", () => ({
  performImageGeneration: vi.fn(async () => ({
    imagePath: "/objects/test/spend-snapshot.png",
    b64Json: null,
    meta: {
      provider: "test-provider",
      model: "test-model",
      durationMs: 42,
      costPaise: 1000,
    },
  })),
}));

let tenant: TestTenant;
let snapshot: AiSpendSettings | null = null;

const FLAT = {
  captionCostPaise: 500,
  imageCostPaise: 1000,
  videoCostPaise: 10000,
  feePercent: 0,
};

beforeAll(async () => {
  snapshot = await snapshotAiSpendSettings();
  tenant = await createTenant();
});

afterAll(async () => {
  await db.delete(usageEventsTable).where(eq(usageEventsTable.tenantId, tenant.tenantId));
  await db
    .delete(imageGenerationsTable)
    .where(eq(imageGenerationsTable.tenantId, tenant.tenantId));
  await deleteTenant(tenant.tenantId);
  await restoreAiSpendSettings(snapshot);
  await pool.end();
});

describe("image job spend snapshot", () => {
  it("persists the cost_plus spend in the SAME write that flips the job to succeeded", async () => {
    await setAiSpendConfig({ ...FLAT, displayMode: "cost_plus", marginPercent: 20 });

    const [job] = await db
      .insert(imageGenerationsTable)
      .values({
        tenantId: tenant.tenantId,
        status: "queued",
        prompt: "spend snapshot test",
        size: "1024x1024",
        funding: "quota",
      })
      .returning();

    await runImageGenerationJob(job.id, "quota");

    const [row] = await db
      .select()
      .from(imageGenerationsTable)
      .where(eq(imageGenerationsTable.id, job.id))
      .limit(1);
    // Clients stop polling the instant they see "succeeded", so a succeeded
    // row without its snapshot would lose the real figure forever. 1000
    // paise cost x 1.2 margin = 1200.
    expect(row.status).toBe("succeeded");
    expect(row.spendPaise).toBe(1200);

    // The usage event must carry the exact same snapshot as the row.
    const [event] = await db
      .select({ displayPaise: usageEventsTable.displayPaise })
      .from(usageEventsTable)
      .where(eq(usageEventsTable.tenantId, tenant.tenantId))
      .orderBy(desc(usageEventsTable.id))
      .limit(1);
    expect(event?.displayPaise).toBe(1200);
  });
});
