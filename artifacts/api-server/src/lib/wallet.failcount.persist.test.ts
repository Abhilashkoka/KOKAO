/**
 * Integration-style unit tests for the DB-persistence layer of the wallet
 * true-up fail-count tracking:
 *
 *   initTrueUpFailCounts  — loads counts from wallet_settings on boot
 *   saveTrueUpFailCounts  — persists counts to DB after each sweep tick
 *
 * These tests verify the three concrete guarantees added by task-887:
 *   1. initTrueUpFailCounts populates the in-memory map from a DB row.
 *   2. Counts are written to the DB *before* sweepStuckPendingTrueUps returns
 *      (await, not fire-and-forget), so a restart right after a failing sweep
 *      does not silently reset the counter.
 *   3. After a simulated restart (resetTrueUpFailCounts + initTrueUpFailCounts)
 *      the alert fires on the Nth total failure, not the Nth since last boot.
 *   4. initTrueUpFailCounts never overwrites in-memory counts that are already
 *      present (no double-counting when called more than once per process).
 *
 * Heavy dependencies (notifications, aiCost, aiSpend, featureFlags) are stubbed
 * the same way as wallet.trueupAlert.test.ts.  The @workspace/db mock is built
 * here with distinct table objects so from() calls can be routed by reference.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── mutable state shared with the mock factories ──────────────────────────

/** Row returned by db.select().from(walletSettingsTable).limit(1). */
let mockWalletSettingsRow: null | {
  id: number;
  trueUpFailCounts: Record<string, { count: number; lastError: string | null }>;
} = null;

/**
 * The trueUpFailCounts payload most recently passed to
 * db.update(walletSettingsTable).set({...}).
 * Reset to null in beforeEach.
 */
let capturedSavePayload: Record<
  string,
  { count: number; lastError: string | null }
> | null = null;

/**
 * The trueUpFailCounts payload most recently written via
 * db.insert(walletSettingsTable).values({...}).
 * Reset to null in beforeEach.
 */
let capturedInsertPayload: Record<
  string,
  { count: number; lastError: string | null }
> | null = null;

/** Raw rows returned by listPendingPricedModels' groupBy query. */
let mockLedgerGroups: unknown[] = [];

/**
 * When true, the second db.select() call (inside trueUpModel's initial
 * pending-rows query) throws, simulating a broken true-up.
 */
let dbThrowOnTrueUpSelect = false;

/** Counts ledger table selects within a single sweep tick. */
let ledgerSelectCount = 0;

// ── mocks ─────────────────────────────────────────────────────────────────

vi.mock("./notifications", () => ({
  notifyWalletTrueUpFailing: vi.fn().mockResolvedValue(undefined),
  resolveWalletTrueUpFailingNotifications: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./aiCost", () => ({
  findModelPrice: vi.fn(),
  getAiCostConfig: vi.fn().mockResolvedValue({ usdToInrPaise: 8600 }),
  computeTextCostPaise: vi.fn().mockResolvedValue(null),
  computeImageCostPaise: vi.fn().mockResolvedValue(null),
  computeVideoCostPaise: vi.fn().mockResolvedValue(null),
}));

vi.mock("./aiSpend", () => ({
  getAiSpendConfig: vi.fn().mockResolvedValue({
    captionCostPaise: 200,
    imageCostPaise: 500,
    feePercent: 20,
  }),
  withFee: (p: number, pct: number) => Math.round(p * (1 + pct / 100)),
}));

vi.mock("./featureFlags", () => ({
  isFeatureEnabled: vi.fn().mockResolvedValue(true),
}));

vi.mock("@workspace/db", () => {
  // Distinct objects so from() routing works by reference identity.
  const settingsTable = { _table: "wallet_settings" };
  const ledgerTable = { _table: "wallet_ledger" };
  const otherTable = {};

  /**
   * Chain for the ledger table: both .groupBy() and .limit() are terminal
   * so listPendingPricedModels (groupBy) and trueUpModel (limit) both work.
   */
  function makeLedgerChain(terminalFn: () => Promise<unknown>) {
    const c: Record<string, unknown> = {};
    const noop = () => c;
    c.where = noop;
    c.for = noop;
    c.orderBy = noop;
    c.groupBy = terminalFn;
    c.limit = terminalFn;
    c.returning = terminalFn;
    return c;
  }

  return {
    db: {
      /**
       * Route selects by which table .from() receives:
       *  - settingsTable → return mockWalletSettingsRow (for init + save)
       *  - ledgerTable   → call 0 returns mockLedgerGroups (listPendingPricedModels);
       *                     call 1+ returns [] or throws (trueUpModel)
       */
      select: (_projection?: unknown) => ({
        from: (table: unknown) => {
          if (table === settingsTable) {
            // initTrueUpFailCounts and saveTrueUpFailCounts both need .limit(n)
            return {
              limit: async (_n: number) =>
                mockWalletSettingsRow ? [mockWalletSettingsRow] : [],
            };
          }
          // walletLedgerTable
          const thisCall = ledgerSelectCount++;
          if (thisCall === 0) {
            // First select in the sweep: listPendingPricedModels groupBy query.
            return makeLedgerChain(async () => mockLedgerGroups);
          }
          // Subsequent selects: inside trueUpModel.
          if (dbThrowOnTrueUpSelect) {
            return makeLedgerChain(async () => {
              throw new Error("DB error in trueUpModel");
            });
          }
          return makeLedgerChain(async () => []);
        },
      }),

      /**
       * Capture the trueUpFailCounts flushed by setWalletConfig when it creates
       * the first wallet_settings row (fresh-install path).
       */
      insert: (_table: unknown) => ({
        values: (data: Record<string, unknown>) => {
          capturedInsertPayload =
            (
              data as {
                trueUpFailCounts?: Record<
                  string,
                  { count: number; lastError: string | null }
                >;
              }
            ).trueUpFailCounts ?? null;
          return Promise.resolve();
        },
      }),

      /** Capture the trueUpFailCounts payload written by saveTrueUpFailCounts. */
      update: (_table: unknown) => ({
        set: (data: Record<string, unknown>) => {
          capturedSavePayload =
            (
              data as {
                trueUpFailCounts: Record<
                  string,
                  { count: number; lastError: string | null }
                >;
              }
            ).trueUpFailCounts ?? null;
          return { where: async () => {} };
        },
      }),

      transaction: vi.fn().mockResolvedValue(false),
    },

    // Operator stubs
    eq: () => true,
    and: (...args: unknown[]) => args,
    isNull: () => true,
    sql: Object.assign(() => "", { raw: () => "" }),

    // Table references — must match the identities used in from() routing above
    walletSettingsTable: settingsTable,
    walletLedgerTable: ledgerTable,
    walletBalancesTable: otherTable,
    tenantsTable: otherTable,
    videoGenerationsTable: otherTable,
    aiModelPricesTable: otherTable,
    aiSpendSettingsTable: otherTable,
    featureFlagsTable: otherTable,
  };
});

// ── imports (after mocks so vi.mock hoisting resolves first) ───────────────

import { findModelPrice } from "./aiCost";
import { notifyWalletTrueUpFailing } from "./notifications";
import {
  initTrueUpFailCounts,
  resetTrueUpFailCounts,
  setWalletConfig,
  sweepStuckPendingTrueUps,
  WALLET_TRUEUP_FAIL_ALERT_THRESHOLD,
} from "./wallet";

const mockFindModelPrice = vi.mocked(findModelPrice);
const mockNotify = vi.mocked(notifyWalletTrueUpFailing);

const FAKE_PRICE = {
  id: 1,
  kind: "image" as const,
  provider: "openai",
  model: "dall-e-3",
  usdPerImage: 0.04,
  inputUsdPerMtok: null,
  outputUsdPerMtok: null,
  usdPerSecond: null,
  usdPerVideo: null,
};

/** Raw row shape returned by listPendingPricedModels' groupBy query. */
const RAW_GROUP = {
  usageKind: "image",
  provider: "openai",
  model: "dall-e-3",
  chargeCount: 1,
  chargedPaise: 500,
  missingUsageCount: 0,
};

// ── helpers ────────────────────────────────────────────────────────────────

/** One sweep where the trueUpModel select throws (simulates a broken true-up). */
async function runFailingSweep() {
  ledgerSelectCount = 0;
  mockLedgerGroups = [RAW_GROUP];
  dbThrowOnTrueUpSelect = true;
  await sweepStuckPendingTrueUps();
}

/** One sweep with no pending groups (everything cleared / no work to do). */
async function runEmptySweep() {
  ledgerSelectCount = 0;
  mockLedgerGroups = [];
  dbThrowOnTrueUpSelect = false;
  await sweepStuckPendingTrueUps();
}

beforeEach(() => {
  vi.clearAllMocks();
  resetTrueUpFailCounts();

  // Default: a settings row already exists so saveTrueUpFailCounts can write.
  mockWalletSettingsRow = { id: 1, trueUpFailCounts: {} };
  capturedSavePayload = null;
  capturedInsertPayload = null;
  mockLedgerGroups = [];
  dbThrowOnTrueUpSelect = false;
  ledgerSelectCount = 0;

  // Default: findModelPrice returns a valid price so the true-up is attempted.
  mockFindModelPrice.mockResolvedValue(FAKE_PRICE as never);
});

// ── tests ──────────────────────────────────────────────────────────────────

describe("initTrueUpFailCounts — loading persisted counts from DB", () => {
  it("populates the in-memory map from a persisted DB row", async () => {
    mockWalletSettingsRow = {
      id: 1,
      trueUpFailCounts: {
        "image:dall-e-3": {
          count: WALLET_TRUEUP_FAIL_ALERT_THRESHOLD - 1,
          lastError: "prior error",
        },
      },
    };

    await initTrueUpFailCounts();

    // One more failure should push us past the threshold and trigger the alert.
    await runFailingSweep();
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "dall-e-3",
        failCount: WALLET_TRUEUP_FAIL_ALERT_THRESHOLD,
      }),
    );
  });

  it("does not overwrite an in-memory count already present (no double-counting)", async () => {
    // In-memory count = THRESHOLD - 1 (one failure away from alerting).
    // DB has a HIGHER stale count from a previous process run.
    // initTrueUpFailCounts must NOT overwrite the live in-memory value.

    // Seed the map BEFORE init (simulates count accumulated in this process
    // before init was called, or a test-helper injection).
    mockWalletSettingsRow = {
      id: 1,
      trueUpFailCounts: {
        "image:dall-e-3": {
          count: WALLET_TRUEUP_FAIL_ALERT_THRESHOLD + 99,
          lastError: "stale",
        },
      },
    };

    // Pre-populate in-memory with a lower count.
    for (let i = 0; i < WALLET_TRUEUP_FAIL_ALERT_THRESHOLD - 1; i++) {
      await runFailingSweep();
    }
    vi.clearAllMocks();
    mockFindModelPrice.mockResolvedValue(FAKE_PRICE as never);

    // Now call init — must not overwrite the existing key.
    await initTrueUpFailCounts();

    // One more failure: should alert at THRESHOLD (not THRESHOLD + 100).
    await runFailingSweep();
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify.mock.calls[0][0].failCount).toBe(WALLET_TRUEUP_FAIL_ALERT_THRESHOLD);
  });

  it("handles a missing wallet_settings row without throwing", async () => {
    mockWalletSettingsRow = null;
    await expect(initTrueUpFailCounts()).resolves.toBeUndefined();
  });

  it("handles a settings row with an empty trueUpFailCounts map without throwing", async () => {
    mockWalletSettingsRow = { id: 1, trueUpFailCounts: {} };
    await expect(initTrueUpFailCounts()).resolves.toBeUndefined();
  });
});

describe("sweepStuckPendingTrueUps — DB persistence is awaited before sweep resolves", () => {
  it("writes incremented fail counts to the DB before the sweep promise resolves", async () => {
    // capturedSavePayload starts null; after the sweep it must be non-null.
    await runFailingSweep();

    expect(capturedSavePayload).not.toBeNull();
    expect(capturedSavePayload?.["image:dall-e-3"]).toEqual(
      expect.objectContaining({ count: 1 }),
    );
  });

  it("accumulates counts across multiple failing sweeps and persists each tick", async () => {
    const n = WALLET_TRUEUP_FAIL_ALERT_THRESHOLD;
    for (let i = 1; i <= n; i++) {
      await runFailingSweep();
      expect(capturedSavePayload?.["image:dall-e-3"]?.count).toBe(i);
    }
  });

  it("writes cleared counts after a group disappears from the pending list", async () => {
    // Build up a streak first.
    await runFailingSweep();
    expect(capturedSavePayload?.["image:dall-e-3"]?.count).toBeGreaterThan(0);

    // Group resolves — empty sweep removes it from the map and saves {}.
    await runEmptySweep();
    expect(capturedSavePayload).toEqual({});
  });

  it("skips the DB write when no wallet_settings row exists yet (no crash)", async () => {
    mockWalletSettingsRow = null;
    await expect(runFailingSweep()).resolves.toBeUndefined();
    // capturedSavePayload stays null because saveTrueUpFailCounts returned early.
    expect(capturedSavePayload).toBeNull();
  });
});

describe("setWalletConfig — fresh-install fail-count flush", () => {
  it("flushes in-memory fail counts into the new settings row when none existed", async () => {
    // Simulate a fresh install: no settings row yet.
    mockWalletSettingsRow = null;

    // Accumulate fail counts BEFORE an admin ever saves wallet config.
    // saveTrueUpFailCounts silently skips (no row), so the counts live only
    // in-memory.
    await runFailingSweep();

    // Now the admin saves config for the first time (inserts the first row).
    await setWalletConfig({
      gstPercent: 18,
      minTopupPaise: 10_000,
      lowBalanceThresholdPaise: 0,
      videoCostPaise: 0,
    });

    // The insert must have included the accumulated fail counts.
    expect(capturedInsertPayload).not.toBeNull();
    expect(capturedInsertPayload?.["image:dall-e-3"]).toEqual(
      expect.objectContaining({ count: 1 }),
    );
  });

  it("counts flushed at first config-save are readable after initTrueUpFailCounts on next boot", async () => {
    mockWalletSettingsRow = null;

    // Accumulate THRESHOLD - 1 failures before config is ever saved.
    const failsBefore = WALLET_TRUEUP_FAIL_ALERT_THRESHOLD - 1;
    for (let i = 0; i < failsBefore; i++) {
      await runFailingSweep();
    }
    expect(mockNotify).not.toHaveBeenCalled();

    // Admin saves config; the insert captures the in-memory counts.
    await setWalletConfig({
      gstPercent: 18,
      minTopupPaise: 10_000,
      lowBalanceThresholdPaise: 0,
      videoCostPaise: 0,
    });
    expect(capturedInsertPayload?.["image:dall-e-3"]?.count).toBe(failsBefore);

    // Simulate a server restart: DB now has the flushed counts.
    mockWalletSettingsRow = {
      id: 1,
      trueUpFailCounts: capturedInsertPayload!,
    };
    resetTrueUpFailCounts();
    await initTrueUpFailCounts();

    // One more failure in the "restarted" process must cross the threshold.
    vi.clearAllMocks();
    mockFindModelPrice.mockResolvedValue(FAKE_PRICE as never);
    await runFailingSweep();

    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "dall-e-3",
        failCount: WALLET_TRUEUP_FAIL_ALERT_THRESHOLD,
      }),
    );
  });

  it("does not include trueUpFailCounts in the insert when the map is empty", async () => {
    mockWalletSettingsRow = null;

    // No sweep failures — in-memory map is empty.
    await setWalletConfig({
      gstPercent: 18,
      minTopupPaise: 10_000,
      lowBalanceThresholdPaise: 0,
      videoCostPaise: 0,
    });

    // capturedInsertPayload is null because no trueUpFailCounts key was spread.
    expect(capturedInsertPayload).toBeNull();
  });

  it("does not flush counts when the settings row already exists (update path is unchanged)", async () => {
    // Row already exists — setWalletConfig should take the update path.
    mockWalletSettingsRow = { id: 1, trueUpFailCounts: {} };

    await runFailingSweep();
    capturedInsertPayload = null; // reset after the sweep's own insert attempts

    await setWalletConfig({
      gstPercent: 18,
      minTopupPaise: 10_000,
      lowBalanceThresholdPaise: 0,
      videoCostPaise: 0,
    });

    // The insert path must not have been taken.
    expect(capturedInsertPayload).toBeNull();
  });
});

describe("simulated restart — end-to-end persistence guarantee", () => {
  it("alert fires on the Nth total failure across restarts, not the Nth since last boot", async () => {
    // Phase 1: run THRESHOLD - 1 failures in the current process.
    const failsBefore = WALLET_TRUEUP_FAIL_ALERT_THRESHOLD - 1;
    for (let i = 0; i < failsBefore; i++) {
      await runFailingSweep();
    }
    // The alert must NOT have fired yet.
    expect(mockNotify).not.toHaveBeenCalled();

    // Phase 2: simulate a server restart.
    //   - The DB now holds the saved counts (what capturedSavePayload had).
    const savedCounts = { ...capturedSavePayload };
    mockWalletSettingsRow = { id: 1, trueUpFailCounts: savedCounts };
    resetTrueUpFailCounts(); // clears the in-memory map
    await initTrueUpFailCounts(); // restores from DB

    // Phase 3: one more failure in the "restarted" process must cross the threshold.
    vi.clearAllMocks();
    mockFindModelPrice.mockResolvedValue(FAKE_PRICE as never);
    await runFailingSweep();

    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "dall-e-3",
        failCount: WALLET_TRUEUP_FAIL_ALERT_THRESHOLD,
      }),
    );
  });
});
