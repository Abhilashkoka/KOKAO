import { describe, expect, it, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const state: {
    rows: Array<{ id: number; mode: string }>;
    insertedModes: string[];
  } = {
    rows: [],
    insertedModes: [],
  };

  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        orderBy: vi.fn(() => ({
          limit: vi.fn(async () => state.rows),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((values: { mode: string }) => ({
        onConflictDoUpdate: vi.fn(async ({ set }: { set: { mode: string } }) => {
          state.insertedModes.push(values.mode);
          state.rows = [{ id: 1, mode: set.mode }];
        }),
      })),
    })),
  };

  return { db, state };
});

vi.mock("@workspace/db", () => ({
  db: mocks.db,
  creditRatesTable: { key: {}, id: {} },
  creditMeterSettingsTable: { id: {}, mode: {} },
}));

vi.mock("drizzle-orm", () => ({
  asc: vi.fn((column: unknown) => column),
  eq: vi.fn(),
}));

import {
  CREDIT_RECONCILIATION_GATE,
} from "./creditReconciliationGate";
import {
  getMeterMode,
  invalidateCreditRateCache,
  setMeterMode,
} from "./creditRates";

beforeEach(() => {
  mocks.state.rows = [];
  mocks.state.insertedModes = [];
  mocks.db.select.mockClear();
  mocks.db.insert.mockClear();
  invalidateCreditRateCache();
});

describe("credit reconciliation release gate", () => {
  it("defaults to no-go and keeps an unset meter in shadow mode", async () => {
    expect(CREDIT_RECONCILIATION_GATE.verdict).toBe("no-go");
    expect(CREDIT_RECONCILIATION_GATE.reason).toContain("production shadow window");
    expect(await getMeterMode()).toBe("shadow");
  });

  it("downgrades a stored enforce setting to shadow", async () => {
    mocks.state.rows = [{ id: 1, mode: "enforce" }];

    expect(await getMeterMode()).toBe("shadow");
  });

  it("rejects enforce without writing the settings row", async () => {
    await expect(setMeterMode("enforce")).rejects.toMatchObject({
      code: "CREDIT_ENFORCEMENT_LOCKED",
    });

    expect(mocks.db.insert).not.toHaveBeenCalled();
    expect(mocks.state.insertedModes).toEqual([]);
  });

  it("continues to permit off and shadow modes", async () => {
    await expect(setMeterMode("off")).resolves.toBe("off");
    expect(await getMeterMode()).toBe("off");

    await expect(setMeterMode("shadow")).resolves.toBe("shadow");
    expect(await getMeterMode()).toBe("shadow");
    expect(mocks.state.insertedModes).toEqual(["off", "shadow"]);
  });
});