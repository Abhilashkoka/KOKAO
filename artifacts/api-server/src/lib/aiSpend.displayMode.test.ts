import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { db, pool, usageEventsTable, type AiSpendSettings } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import {
  getAiSpendConfig,
  setAiSpendConfig,
  computeDisplayPaise,
  flatDisplayPaise,
  withFee,
} from "./aiSpend";
import { recordUsage } from "./usage";
import {
  createTenant,
  deleteTenant,
  snapshotAiSpendSettings,
  restoreAiSpendSettings,
  type TestTenant,
} from "../test/dbHelpers";

let tenant: TestTenant;
let snapshot: AiSpendSettings | null = null;

const FLAT = {
  captionCostPaise: 500,
  imageCostPaise: 1000,
  videoCostPaise: 10000,
  feePercent: 10,
};

async function latestDisplayPaise(): Promise<number | null> {
  const [row] = await db
    .select({ displayPaise: usageEventsTable.displayPaise })
    .from(usageEventsTable)
    .where(eq(usageEventsTable.tenantId, tenant.tenantId))
    .orderBy(desc(usageEventsTable.id))
    .limit(1);
  return row?.displayPaise ?? null;
}

beforeAll(async () => {
  snapshot = await snapshotAiSpendSettings();
  tenant = await createTenant();
});

afterAll(async () => {
  await db.delete(usageEventsTable).where(eq(usageEventsTable.tenantId, tenant.tenantId));
  await deleteTenant(tenant.tenantId);
  await restoreAiSpendSettings(snapshot);
  await pool.end();
});

beforeEach(async () => {
  // Shared dev DB: re-seed the singleton settings row before every test.
  await restoreAiSpendSettings(null);
});

describe("computeDisplayPaise", () => {
  const config = {
    ...FLAT,
    displayMode: "cost_plus" as const,
    marginPercent: 25,
  };

  it("flat mode ignores actual cost", () => {
    const flatConfig = { ...config, displayMode: "flat" as const };
    expect(computeDisplayPaise("video", 137000, flatConfig)).toBe(
      withFee(FLAT.videoCostPaise, FLAT.feePercent),
    );
  });

  it("cost_plus mode applies the margin to the actual cost", () => {
    expect(computeDisplayPaise("video", 137000, config)).toBe(Math.round(137000 * 1.25));
    expect(computeDisplayPaise("caption", 3, config)).toBe(4); // rounds
  });

  it("cost_plus mode falls back to the flat rate when cost is unknown", () => {
    expect(computeDisplayPaise("image", null, config)).toBe(
      withFee(FLAT.imageCostPaise, FLAT.feePercent),
    );
    expect(flatDisplayPaise("image", config)).toBe(withFee(1000, 10));
  });
});

describe("settings persistence", () => {
  it("defaults to flat mode with zero margin", async () => {
    const config = await getAiSpendConfig();
    expect(config.displayMode).toBe("flat");
    expect(config.marginPercent).toBe(0);
  });

  it("round-trips displayMode and marginPercent", async () => {
    const saved = await setAiSpendConfig({
      ...FLAT,
      displayMode: "cost_plus",
      marginPercent: 30,
    });
    expect(saved.displayMode).toBe("cost_plus");
    expect(saved.marginPercent).toBe(30);
    const reloaded = await getAiSpendConfig();
    expect(reloaded.displayMode).toBe("cost_plus");
    expect(reloaded.marginPercent).toBe(30);
  });
});

describe("recordUsage display snapshots", () => {
  it("flat mode snapshots the per-kind rate regardless of cost", async () => {
    await setAiSpendConfig({ ...FLAT, displayMode: "flat", marginPercent: 0 });
    await recordUsage(tenant.tenantId, "video", { costPaise: 137000 });
    expect(await latestDisplayPaise()).toBe(withFee(FLAT.videoCostPaise, FLAT.feePercent));
  });

  it("cost_plus mode snapshots cost x (1 + margin%)", async () => {
    await setAiSpendConfig({ ...FLAT, displayMode: "cost_plus", marginPercent: 20 });
    await recordUsage(tenant.tenantId, "video", { costPaise: 137000 });
    expect(await latestDisplayPaise()).toBe(Math.round(137000 * 1.2));
  });

  it("cost_plus mode falls back to the flat rate when cost is unknown", async () => {
    await setAiSpendConfig({ ...FLAT, displayMode: "cost_plus", marginPercent: 20 });
    await recordUsage(tenant.tenantId, "image", {});
    expect(await latestDisplayPaise()).toBe(withFee(FLAT.imageCostPaise, FLAT.feePercent));
  });

  it("honors a precomputed override so job rows and events can never disagree", async () => {
    // Job runners persist the spend on the row BEFORE the terminal status
    // flip and pass the same figure here; the event must store it verbatim,
    // never recompute (a config edit in between would desync the two).
    await setAiSpendConfig({ ...FLAT, displayMode: "cost_plus", marginPercent: 90 });
    await recordUsage(tenant.tenantId, "video", {
      costPaise: 1000,
      displayPaiseOverride: 1200,
    });
    expect(await latestDisplayPaise()).toBe(1200);
    // A genuine zero is a valid snapshot (cost_plus supplemental units).
    await recordUsage(tenant.tenantId, "video", { costPaise: 0, displayPaiseOverride: 0 });
    expect(await latestDisplayPaise()).toBe(0);
  });

  it("past snapshots never shift when the margin later changes", async () => {
    await setAiSpendConfig({ ...FLAT, displayMode: "cost_plus", marginPercent: 20 });
    await recordUsage(tenant.tenantId, "caption", { costPaise: 1000 });
    const before = await latestDisplayPaise();
    expect(before).toBe(1200);
    await setAiSpendConfig({ ...FLAT, displayMode: "cost_plus", marginPercent: 90 });
    expect(await latestDisplayPaise()).toBe(1200);
  });
});
