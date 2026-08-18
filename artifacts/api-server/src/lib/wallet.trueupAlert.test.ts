/**
 * Unit tests for the wallet true-up fail-streak alerting in
 * sweepStuckPendingTrueUps: alert after N consecutive per-group errors,
 * refresh the unread banner on subsequent failures, and auto-resolve when the
 * group settles or disappears from the pending list.
 *
 * Heavy dependencies (db, aiCost, aiSpend) are stubbed so these tests run
 * without a real database and complete in milliseconds.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── module-level state shared with the mocks ──────────────────────────────
// All vars are read at call-time (not factory-evaluation-time), so vi.mock
// factories can safely capture them by reference.

/** Controls what listPendingPricedModels returns. */
let mockPendingGroups: unknown[] = [];

/**
 * When non-null the NEXT db.select() call (idx === 0) returns this as the
 * wallet_settings row instead of mockPendingGroups. Used to drive
 * initTrueUpFailCounts without a real DB.
 */
let mockWalletSettingsForInit: { trueUpFailCounts: Record<string, { count: number; lastError: string | null }> } | null = null;

/**
 * When true the second db.select() call (inside trueUpModel's initial
 * pending-rows query) throws a DB error, simulating a broken true-up.
 */
let dbSelectShouldThrow = false;

/** Call counter reset by runFailingSweep / runEmptySweep before each tick. */
let selectCallIndex = 0;

// ── mocks ──────────────────────────────────────────────────────────────────

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
    videoCostPaise: 1000,
    feePercent: 20,
  }),
  withFee: (paise: number, pct: number) => Math.round(paise * (1 + pct / 100)),
}));

vi.mock("./featureFlags", () => ({
  isFeatureEnabled: vi.fn().mockResolvedValue(true),
}));

vi.mock("@workspace/db", () => {
  const table = {};

  /**
   * Build a fluent chain where every chainable call returns `this` (no-op)
   * and the terminal call (`groupBy` or `limit`) returns `terminal()`.
   */
  function makeChain(terminal: () => Promise<unknown>) {
    const chain: Record<string, unknown> = {};
    const noop = () => chain;
    chain.from = noop;
    chain.where = noop;
    chain.for = noop;
    chain.orderBy = noop;
    chain.groupBy = terminal;
    chain.limit = terminal;
    chain.returning = terminal;
    return chain;
  }

  return {
    db: {
      select: () => {
        const idx = selectCallIndex++;
        if (idx === 0) {
          // initTrueUpFailCounts stages a wallet_settings row; consume it
          // first so the subsequent listPendingPricedModels call is unaffected.
          if (mockWalletSettingsForInit !== null) {
            const row = mockWalletSettingsForInit;
            mockWalletSettingsForInit = null;
            return makeChain(async () => [row]);
          }
          // listPendingPricedModels: the grouped wallet-ledger query
          return makeChain(async () => mockPendingGroups);
        }
        // trueUpModel's initial `db.select().from().where().limit(1000)`:
        // throw here to simulate a DB error inside the true-up path.
        if (dbSelectShouldThrow) {
          return makeChain(async () => {
            throw new Error("DB error in trueUpModel");
          });
        }
        // No pending rows → trueUpModel returns 0 rowsTruedUp cleanly.
        // saveTrueUpFailCounts also calls select (idx >= 2); returning []
        // makes it exit early before calling db.update (which is not mocked).
        return makeChain(async () => []);
      },
      transaction: vi.fn().mockResolvedValue(false),
    },
    and: (...args: unknown[]) => args,
    eq: () => true,
    isNull: () => true,
    sql: Object.assign(() => "", { raw: () => "" }),
    walletLedgerTable: table,
    walletBalancesTable: table,
    walletSettingsTable: table,
    tenantsTable: table,
    videoGenerationsTable: table,
    aiModelPricesTable: table,
    aiSpendSettingsTable: table,
    featureFlagsTable: table,
  };
});

// ── imports (after mocks so vi.mock hoisting resolves first) ───────────────

import { findModelPrice } from "./aiCost";
import {
  notifyWalletTrueUpFailing,
  resolveWalletTrueUpFailingNotifications,
} from "./notifications";
import {
  sweepStuckPendingTrueUps,
  resetTrueUpFailCounts,
  setTrueUpFailCountForTest,
  initTrueUpFailCounts,
  WALLET_TRUEUP_FAIL_ALERT_THRESHOLD,
} from "./wallet";

const mockFindModelPrice = vi.mocked(findModelPrice);
const mockNotify = vi.mocked(notifyWalletTrueUpFailing);
const mockResolve = vi.mocked(resolveWalletTrueUpFailingNotifications);

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

/** The pending-group shape that listPendingPricedModels produces. */
const GROUP = {
  usageKind: "image",
  provider: "openai",
  model: "dall-e-3",
  chargeCount: 1,
  chargedPaise: 500,
  missingUsageCount: 0,
  reason: "not_reconciled",
  detail: "",
  priceProvider: "openai",
};

// ── helpers ────────────────────────────────────────────────────────────────

/** One sweep tick where the group is present AND trueUpModel throws. */
async function runFailingSweep() {
  selectCallIndex = 0;
  mockPendingGroups = [GROUP];
  dbSelectShouldThrow = true;
  await sweepStuckPendingTrueUps();
}

/** One sweep tick with no pending groups (everything cleared). */
async function runEmptySweep() {
  selectCallIndex = 0;
  mockPendingGroups = [];
  dbSelectShouldThrow = false;
  await sweepStuckPendingTrueUps();
}

/**
 * Simulate loading persisted fail counts from the DB by staging a fake
 * wallet_settings row and calling initTrueUpFailCounts. The staged row is
 * consumed by the very first db.select() call (idx === 0), which keeps the
 * subsequent listPendingPricedModels call (also idx === 0, after a reset)
 * unaffected. selectCallIndex is reset to 0 after the init so callers can
 * immediately follow with runFailingSweep / runEmptySweep.
 */
async function runInitFromMockedDB(
  counts: Record<string, { count: number; lastError: string | null }>,
): Promise<void> {
  selectCallIndex = 0;
  mockWalletSettingsForInit = { trueUpFailCounts: counts };
  await initTrueUpFailCounts();
  // Reset the index so the next runFailingSweep / runEmptySweep starts at 0.
  selectCallIndex = 0;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetTrueUpFailCounts();
  mockFindModelPrice.mockResolvedValue(FAKE_PRICE as never);
  dbSelectShouldThrow = false;
  mockPendingGroups = [];
  selectCallIndex = 0;
});

// ── tests ──────────────────────────────────────────────────────────────────

describe("WALLET_TRUEUP_FAIL_ALERT_THRESHOLD", () => {
  it("is a positive integer", () => {
    expect(WALLET_TRUEUP_FAIL_ALERT_THRESHOLD).toBeGreaterThan(0);
    expect(Number.isInteger(WALLET_TRUEUP_FAIL_ALERT_THRESHOLD)).toBe(true);
  });
});

describe("sweepStuckPendingTrueUps — fail-streak alerting", () => {
  it("does not alert before reaching the consecutive-failure threshold", async () => {
    for (let i = 0; i < WALLET_TRUEUP_FAIL_ALERT_THRESHOLD - 1; i++) {
      await runFailingSweep();
    }
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("alerts superadmins once the threshold is crossed", async () => {
    for (let i = 0; i < WALLET_TRUEUP_FAIL_ALERT_THRESHOLD; i++) {
      await runFailingSweep();
    }
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        usageKind: GROUP.usageKind,
        model: GROUP.model,
        failCount: WALLET_TRUEUP_FAIL_ALERT_THRESHOLD,
      }),
    );
  });

  it("calls notify again on every subsequent failure so the banner refreshes", async () => {
    const extra = 2;
    for (let i = 0; i < WALLET_TRUEUP_FAIL_ALERT_THRESHOLD + extra; i++) {
      await runFailingSweep();
    }
    // notify is called once per tick past the threshold so that the
    // notifyProviderFailover dedup logic can update the unread row in place.
    expect(mockNotify).toHaveBeenCalledTimes(extra + 1);
    const lastCall = mockNotify.mock.calls[mockNotify.mock.calls.length - 1][0];
    expect(lastCall.failCount).toBe(WALLET_TRUEUP_FAIL_ALERT_THRESHOLD + extra);
  });

  it("includes the last error message in the alert payload", async () => {
    for (let i = 0; i < WALLET_TRUEUP_FAIL_ALERT_THRESHOLD; i++) {
      await runFailingSweep();
    }
    const call = mockNotify.mock.calls[0][0];
    expect(typeof call.lastError).toBe("string");
    expect((call.lastError as string).length).toBeGreaterThan(0);
  });

  it("does not alert when findModelPrice returns null (group is skipped)", async () => {
    mockFindModelPrice.mockResolvedValue(null as never);
    for (let i = 0; i < WALLET_TRUEUP_FAIL_ALERT_THRESHOLD + 5; i++) {
      selectCallIndex = 0;
      mockPendingGroups = [GROUP];
      await sweepStuckPendingTrueUps();
    }
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("never throws even when the whole top-level listPendingPricedModels fails", async () => {
    // The outer try/catch in sweepStuckPendingTrueUps must absorb this.
    mockPendingGroups = null as never; // .length will throw
    await expect(sweepStuckPendingTrueUps()).resolves.toBeUndefined();
  });
});

describe("sweepStuckPendingTrueUps — auto-resolve", () => {
  it("resolves an open alert when a failing group disappears from the pending list", async () => {
    setTrueUpFailCountForTest(
      GROUP.usageKind,
      GROUP.model,
      WALLET_TRUEUP_FAIL_ALERT_THRESHOLD,
      "prior DB error",
    );
    await runEmptySweep();
    expect(mockResolve).toHaveBeenCalledWith(GROUP.usageKind, GROUP.model);
  });

  it("does not resolve when no fail streak was tracked for the disappeared group", async () => {
    // A group that was never failing must not trigger resolve on disappear.
    setTrueUpFailCountForTest(GROUP.usageKind, GROUP.model, 0);
    await runEmptySweep();
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("resets the fail count on disappear so a new streak re-alerts from scratch", async () => {
    setTrueUpFailCountForTest(
      GROUP.usageKind,
      GROUP.model,
      WALLET_TRUEUP_FAIL_ALERT_THRESHOLD,
      "prior error",
    );
    await runEmptySweep(); // clears tracked count
    vi.clearAllMocks();
    mockFindModelPrice.mockResolvedValue(FAKE_PRICE as never);

    for (let i = 0; i < WALLET_TRUEUP_FAIL_ALERT_THRESHOLD; i++) {
      await runFailingSweep();
    }
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  it("never throws when the resolve call itself rejects", async () => {
    mockResolve.mockRejectedValueOnce(new Error("notify service down"));
    setTrueUpFailCountForTest(
      GROUP.usageKind,
      GROUP.model,
      WALLET_TRUEUP_FAIL_ALERT_THRESHOLD,
      "error",
    );
    await expect(runEmptySweep()).resolves.toBeUndefined();
  });
});

describe("initTrueUpFailCounts — restart persistence simulation", () => {
  /**
   * These tests simulate a server restart by calling resetTrueUpFailCounts()
   * (wipes in-memory state) then initTrueUpFailCounts() (reloads from DB).
   * The DB read is satisfied by the runInitFromMockedDB helper which stages a
   * fake wallet_settings row in the mock. All remaining DB calls use the same
   * mocked db.select that the alert tests rely on.
   */

  it("restores a persisted fail count so the alert fires on the very next sweep failure", async () => {
    // Before the restart N-1 failures were persisted. After loading them, one
    // more failing sweep tick must cross WALLET_TRUEUP_FAIL_ALERT_THRESHOLD.
    await runInitFromMockedDB({
      [`${GROUP.usageKind}:${GROUP.model}`]: {
        count: WALLET_TRUEUP_FAIL_ALERT_THRESHOLD - 1,
        lastError: "pre-restart error",
      },
    });

    await runFailingSweep();

    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify.mock.calls[0][0]).toMatchObject({
      usageKind: GROUP.usageKind,
      model: GROUP.model,
      failCount: WALLET_TRUEUP_FAIL_ALERT_THRESHOLD,
    });
  });

  it("does not fire N more failures from scratch after a restart — streak is cumulative", async () => {
    // Load THRESHOLD - 1 failures.  The (THRESHOLD - 1)th fresh tick must NOT
    // alert; only the Nth (which crosses the boundary) should.
    await runInitFromMockedDB({
      [`${GROUP.usageKind}:${GROUP.model}`]: {
        count: WALLET_TRUEUP_FAIL_ALERT_THRESHOLD - 1,
        lastError: "saved",
      },
    });

    // One tick short of alerting has already been absorbed by the persisted
    // count, so zero additional pre-threshold ticks are needed here — only
    // the single threshold-crossing tick below.
    expect(mockNotify).not.toHaveBeenCalled();

    await runFailingSweep();
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  it("calling initTrueUpFailCounts twice on the same process does not double the count", async () => {
    // A process that calls init twice at startup (e.g. re-entrant boot code)
    // must not accumulate the count twice.
    const counts = {
      [`${GROUP.usageKind}:${GROUP.model}`]: {
        count: WALLET_TRUEUP_FAIL_ALERT_THRESHOLD - 1,
        lastError: "saved",
      },
    };
    await runInitFromMockedDB(counts);
    // Second init on the same live process — map already has the key, so the
    // guard `!trueUpFailCounts.has(key)` must prevent a second write.
    await runInitFromMockedDB(counts);

    // Still exactly one more failure needed, not zero.
    await runFailingSweep();
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify.mock.calls[0][0].failCount).toBe(WALLET_TRUEUP_FAIL_ALERT_THRESHOLD);
  });

  it("ignores DB entries with a zero count (fully resolved or fresh install)", async () => {
    // A zero stored in the DB means the group was resolved before the restart;
    // it must not prime the in-memory counter.
    await runInitFromMockedDB({
      [`${GROUP.usageKind}:${GROUP.model}`]: { count: 0, lastError: null },
    });

    // All THRESHOLD failures must still be fresh to trigger an alert.
    for (let i = 0; i < WALLET_TRUEUP_FAIL_ALERT_THRESHOLD - 1; i++) {
      await runFailingSweep();
    }
    expect(mockNotify).not.toHaveBeenCalled();

    await runFailingSweep();
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  it("does not alert when initTrueUpFailCounts is called but no wallet_settings row exists", async () => {
    // No row staged → initTrueUpFailCounts gets an empty result and is a no-op.
    selectCallIndex = 0;
    mockWalletSettingsForInit = null;
    await initTrueUpFailCounts();
    selectCallIndex = 0;

    for (let i = 0; i < WALLET_TRUEUP_FAIL_ALERT_THRESHOLD - 1; i++) {
      await runFailingSweep();
    }
    expect(mockNotify).not.toHaveBeenCalled();
  });
});
