import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const state: {
    mode: string;
    creditPricePaise: number;
    rates: Map<string, Record<string, unknown>>;
    failDelete: boolean;
  } = {
    mode: "shadow",
    creditPricePaise: 4500,
    rates: new Map(),
    failDelete: false,
  };

  const creditRatesTable = {
    id: "credit_rates.id",
    key: "credit_rates.key",
    sortOrder: "credit_rates.sort_order",
  };
  const creditMeterSettingsTable = {
    id: "credit_meter_settings.id",
    mode: "credit_meter_settings.mode",
  };

  function rowsFor(table: unknown): Record<string, unknown>[] {
    if (table === creditRatesTable) return [...state.rates.values()];
    return [{ id: 1, mode: state.mode, creditPricePaise: state.creditPricePaise }];
  }

  function executor() {
    return {
      select: () => ({
        from: (table: unknown) => ({
          limit: async () => rowsFor(table),
          orderBy: () => ({
            then: (resolve: (value: Record<string, unknown>[]) => unknown) =>
              Promise.resolve(rowsFor(table)).then(resolve),
            limit: async () => rowsFor(table),
          }),
        }),
      }),
      insert: (table: unknown) => ({
        values: (values: Record<string, unknown>) => ({
          onConflictDoUpdate: async ({ set }: { set: Record<string, unknown> }) => {
            if (table === creditMeterSettingsTable) {
              state.mode = String(set.mode ?? values.mode);
              state.creditPricePaise = Number(
                set.creditPricePaise ?? values.creditPricePaise,
              );
              return;
            }
            const key = String(values.key);
            const old = state.rates.get(key);
            state.rates.set(key, {
              ...(old ?? { id: state.rates.size + 1 }),
              ...values,
              ...set,
              key,
            });
          },
        }),
      }),
      delete: (table: unknown) => {
        const builder = {
          where: async (condition?: { keep?: string[] }) => {
            if (table !== creditRatesTable) return;
            for (const [key] of state.rates) {
              if (!condition?.keep?.includes(key)) state.rates.delete(key);
            }
            if (state.failDelete) throw new Error("forced delete failure");
          },
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve().then(() => {
              if (table === creditRatesTable) state.rates.clear();
              return resolve(undefined);
            }),
        };
        return builder;
      },
    };
  }

  const db = {
    ...executor(),
    transaction: async (callback: (tx: ReturnType<typeof executor>) => Promise<unknown>) => {
      const snapshot = {
        mode: state.mode,
        creditPricePaise: state.creditPricePaise,
        rates: new Map([...state.rates].map(([key, value]) => [key, { ...value }])),
      };
      try {
        return await callback(executor());
      } catch (error) {
        state.mode = snapshot.mode;
        state.creditPricePaise = snapshot.creditPricePaise;
        state.rates = snapshot.rates;
        throw error;
      }
    },
  };

  return { state, db, creditRatesTable, creditMeterSettingsTable };
});

vi.mock("@workspace/db", () => ({
  db: mocks.db,
  creditRatesTable: mocks.creditRatesTable,
  creditMeterSettingsTable: mocks.creditMeterSettingsTable,
}));

vi.mock("drizzle-orm", () => ({
  asc: vi.fn((column: unknown) => column),
  eq: vi.fn(),
  inArray: vi.fn((_column: unknown, keys: string[]) => ({ keys })),
  not: vi.fn((condition: { keys: string[] }) => ({ keep: condition.keys })),
}));

import {
  CREDIT_RATE_CACHE_TTL_MS,
  DEFAULT_CREDIT_RATES,
  getMeterMode,
  invalidateCreditRateCache,
  listCreditRates,
  replaceCreditRateCard,
} from "./creditRates";

function completeCard(captionCredits = 0) {
  return DEFAULT_CREDIT_RATES.map((rate) => ({
    ...rate,
    credits: rate.key === "caption" ? captionCredits : rate.credits,
  }));
}

beforeEach(() => {
  mocks.state.mode = "shadow";
  mocks.state.creditPricePaise = 4500;
  mocks.state.rates = new Map(
    DEFAULT_CREDIT_RATES.map((rate, index) => [
      rate.key,
      {
        id: index + 1,
        key: rate.key,
        label: rate.label,
        unit: rate.unit,
        creditsMilli: Math.round(rate.credits * 1000),
        active: rate.active,
        sortOrder: rate.sortOrder,
        notes: rate.notes,
      },
    ]),
  );
  mocks.state.failDelete = false;
  invalidateCreditRateCache();
});

describe("credit rate card transaction", () => {
  it("validates a later invalid price before writing earlier rows", async () => {
    const before = await listCreditRates();

    await expect(
      replaceCreditRateCard({
        mode: "shadow",
        creditPricePaise: 5000,
        rates: [
          { ...completeCard()[0], credits: 2 },
          { ...completeCard()[1], credits: 0.0001 },
          ...completeCard().slice(2),
        ],
      }),
    ).rejects.toThrow(/0 or at least 0.001/);

    expect(mocks.state.mode).toBe("shadow");
    expect(mocks.state.creditPricePaise).toBe(4500);
    invalidateCreditRateCache();
    expect(await listCreditRates()).toEqual(before);
  });

  it("rolls back mode, price, updates and deletion when the transaction fails", async () => {
    const before = await listCreditRates();
    mocks.state.failDelete = true;

    await expect(
      replaceCreditRateCard({
        mode: "shadow",
        creditPricePaise: 5000,
        rates: completeCard().slice(0, -1),
      }),
    ).rejects.toThrow("forced delete failure");

    expect(mocks.state.mode).toBe("shadow");
    expect(mocks.state.creditPricePaise).toBe(4500);
    expect(await listCreditRates()).toEqual(before);
  });

  it("allows scoped development activation only with a complete active card", async () => {
    const saved = {
      nodeEnv: process.env.NODE_ENV,
      deployment: process.env.REPLIT_DEPLOYMENT,
      setting: process.env.CREDIT_ENFORCEMENT_DEV,
    };
    try {
      process.env.NODE_ENV = "development";
      delete process.env.REPLIT_DEPLOYMENT;
      process.env.CREDIT_ENFORCEMENT_DEV = "1";

      await expect(
        replaceCreditRateCard({
          mode: "enforce",
          creditPricePaise: 5000,
          rates: completeCard(0).map((rate) =>
            rate.key === "caption" ? { ...rate, active: false } : rate,
          ),
        }),
      ).rejects.toThrow(/inactive: caption/);

      await replaceCreditRateCard({
        mode: "enforce",
        creditPricePaise: 5000,
        rates: completeCard(0),
      });

      expect(mocks.state.mode).toBe("enforce");
      expect(mocks.state.creditPricePaise).toBe(5000);
      expect(mocks.state.rates.get("caption")?.active).toBe(true);
      expect(mocks.state.rates.get("caption")?.creditsMilli).toBe(0);
      expect(await getMeterMode()).toBe("enforce");
    } finally {
      if (saved.nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = saved.nodeEnv;
      if (saved.deployment === undefined) delete process.env.REPLIT_DEPLOYMENT;
      else process.env.REPLIT_DEPLOYMENT = saved.deployment;
      if (saved.setting === undefined) delete process.env.CREDIT_ENFORCEMENT_DEV;
      else process.env.CREDIT_ENFORCEMENT_DEV = saved.setting;
      invalidateCreditRateCache();
    }
  });

  it("keeps cache staleness bounded", () => {
    expect(CREDIT_RATE_CACHE_TTL_MS).toBeGreaterThan(0);
    expect(CREDIT_RATE_CACHE_TTL_MS).toBeLessThanOrEqual(10_000);
  });
});