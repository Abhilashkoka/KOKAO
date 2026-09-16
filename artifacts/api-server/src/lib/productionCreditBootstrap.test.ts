import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tables = {
    adminAuditLogsTable: {
      action: "admin_audit_logs.action",
      newValue: "admin_audit_logs.new_value",
    },
    creditMeterSettingsTable: {
      id: "credit_meter_settings.id",
    },
    creditRatesTable: {
      id: "credit_rates.id",
    },
    planSettingsTable: {
      id: "plan_settings.id",
    },
    tenantsTable: {
      id: "tenants.id",
      plan: "tenants.plan",
    },
  };
  type State = {
    settings: Array<Record<string, unknown>>;
    rates: Array<Record<string, unknown>>;
    plans: Array<Record<string, unknown>>;
    tenants: Array<Record<string, unknown>>;
    audit: Array<Record<string, unknown>>;
    oldJobs: Array<{ id: number; funding: string }>;
    lockCount: number;
    failAudit: boolean;
  };
  const state: State = {
    settings: [],
    rates: [],
    plans: [
      { id: "business", billingMode: "quota", monthlyCredits: 0 },
      { id: "free", billingMode: "quota", monthlyCredits: 0 },
      { id: "payg", billingMode: "wallet", monthlyCredits: 0 },
      { id: "pro", billingMode: "wallet", monthlyCredits: 0 },
    ],
    tenants: [
      { id: 101, plan: "free", billingMode: "quota" },
      { id: 102, plan: "payg", billingMode: "wallet" },
    ],
    audit: [],
    oldJobs: [
      { id: 201, funding: "quota" },
      { id: 202, funding: "wallet" },
    ],
    lockCount: 0,
    failAudit: false,
  };
  let serializedTransactions: Promise<unknown> = Promise.resolve();

  const reset = () => {
    serializedTransactions = Promise.resolve();
    state.settings = [];
    state.rates = [];
    state.plans = [
      { id: "business", billingMode: "quota", monthlyCredits: 0 },
      { id: "free", billingMode: "quota", monthlyCredits: 0 },
      { id: "payg", billingMode: "wallet", monthlyCredits: 0 },
      { id: "pro", billingMode: "wallet", monthlyCredits: 0 },
    ];
    state.tenants = [
      { id: 101, plan: "free", billingMode: "quota" },
      { id: 102, plan: "payg", billingMode: "wallet" },
    ];
    state.audit = [];
    state.oldJobs = [
      { id: 201, funding: "quota" },
      { id: 202, funding: "wallet" },
    ];
    state.lockCount = 0;
    state.failAudit = false;
  };

  function matches(
    table: unknown,
    condition: unknown,
    row: Record<string, unknown>,
  ): boolean {
    if (!condition || typeof condition !== "object") return true;
    const candidate = condition as {
      kind?: string;
      column?: unknown;
      value?: unknown;
      values?: unknown[];
      conditions?: unknown[];
    };
    if (candidate.kind === "eq") {
      if (candidate.column === tables.adminAuditLogsTable.action) {
        return row.action === candidate.value;
      }
      if (candidate.column === tables.planSettingsTable.id) {
        return row.id === candidate.value;
      }
    }
    if (candidate.kind === "inArray") {
      if (candidate.column === tables.tenantsTable.plan) {
        return candidate.values?.includes(row.plan) ?? false;
      }
      if (candidate.column === tables.planSettingsTable.id) {
        return candidate.values?.includes(row.id) ?? false;
      }
    }
    if (candidate.kind === "and") {
      return (candidate.conditions ?? []).every((child) => matches(table, child, row));
    }
    return true;
  }

  function selectRows(table: unknown, condition?: unknown) {
    const source =
      table === tables.adminAuditLogsTable
        ? state.audit
        : table === tables.creditMeterSettingsTable
          ? state.settings
          : table === tables.creditRatesTable
            ? state.rates
            : table === tables.planSettingsTable
              ? state.plans
              : state.tenants;
    return source.filter((row) => matches(table, condition, row));
  }

  function executor() {
    return {
      execute: vi.fn(async () => {
        state.lockCount += 1;
      }),
      select: vi.fn(() => ({
        from: (table: unknown) => {
          const chain = {
            where: async (condition: unknown) => selectRows(table, condition),
            then: (
              resolve: (rows: Record<string, unknown>[]) => unknown,
              reject?: (error: unknown) => unknown,
            ) => Promise.resolve(selectRows(table)).then(resolve, reject),
          };
          return chain;
        },
      })),
      insert: vi.fn((table: unknown) => ({
        values: async (values: Record<string, unknown> | Array<Record<string, unknown>>) => {
          if (table === tables.creditMeterSettingsTable) {
            state.settings.push(values as Record<string, unknown>);
          } else if (table === tables.creditRatesTable) {
            state.rates.push(...(Array.isArray(values) ? values : [values]));
          } else if (table === tables.adminAuditLogsTable) {
            if (state.failAudit) throw new Error("forced audit failure");
            state.audit.push(values as Record<string, unknown>);
          }
        },
      })),
      update: vi.fn((table: unknown) => ({
        set: (values: Record<string, unknown>) => ({
          where: (condition: unknown) => {
            const source = table === tables.planSettingsTable ? state.plans : state.tenants;
            const updated = source.filter((row) => matches(table, condition, row));
            for (const row of updated) Object.assign(row, values);
            return {
              returning: async () => updated.map((row) => ({ id: row.id })),
              then: (
                resolve: (rows: Record<string, unknown>[]) => unknown,
                reject?: (error: unknown) => unknown,
              ) => Promise.resolve(updated).then(resolve, reject),
            };
          },
        }),
      })),
    };
  }

  const database = {
    transaction: (callback: (tx: ReturnType<typeof executor>) => Promise<unknown>) => {
      const run = serializedTransactions.then(async () => {
        const snapshot = JSON.parse(JSON.stringify(state));
        try {
          return await callback(executor());
        } catch (error) {
          state.settings = snapshot.settings;
          state.rates = snapshot.rates;
          state.plans = snapshot.plans;
          state.tenants = snapshot.tenants;
          state.audit = snapshot.audit;
          state.oldJobs = snapshot.oldJobs;
          throw error;
        }
      });
      serializedTransactions = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };

  return { tables, state, reset, database };
});


vi.mock("@workspace/db", () => ({
  ...mocks.tables,
  db: mocks.database,
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...conditions: unknown[]) => ({ kind: "and", conditions })),
  asc: vi.fn((column: unknown) => column),
  eq: vi.fn((column: unknown, value: unknown) => ({ kind: "eq", column, value })),
  inArray: vi.fn((column: unknown, values: unknown[]) => ({
    kind: "inArray",
    column,
    values,
  })),
  not: vi.fn(),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  })),
}));

import {
  CREDIT_PRODUCTION_ROLLOUT_JSON,
  initializeProductionCreditBootstrap,
  parseProductionCreditRolloutManifest,
  type ProductionCreditRolloutManifest,
} from "./productionCreditBootstrap";

const rates = [
  ["video", "second", 1],
  ["video_hd", "second", 1.5],
  ["image", "item", 0],
  ["image_edit", "item", 3],
  ["caption", "item", 0],
  ["voice", "second", 0.1],
  ["lipsync", "second", 2],
  ["transcription", "second", 0.05],
] as const;

function manifest(): ProductionCreditRolloutManifest {
  return {
    rolloutVersion: "saved-rates-v1",
    mode: "enforce",
    creditPricePaise: 2000,
    rates: rates.map(([key, unit, credits], index) => ({
      key,
      label: `Reviewed ${key}`,
      unit,
      credits,
      active: true,
      sortOrder: (index + 1) * 10,
      notes: "Reviewed test fixture",
    })),
    plans: [
      { id: "business", billingMode: "credits", monthlyCredits: 900 },
      { id: "free", billingMode: "credits", monthlyCredits: 100 },
      { id: "payg", billingMode: "credits", monthlyCredits: 0 },
      { id: "pro", billingMode: "credits", monthlyCredits: 500 },
    ],
  };
}

function productionEnv(value = manifest()) {
  return {
    NODE_ENV: "production",
    REPLIT_DEPLOYMENT: "1",
    CREDIT_ENFORCEMENT_PROD: "saved-rates-v1",
    [CREDIT_PRODUCTION_ROLLOUT_JSON]: JSON.stringify(value),
  };
}

function snapshotData() {
  return JSON.parse(
    JSON.stringify({
      settings: mocks.state.settings,
      rates: mocks.state.rates,
      plans: mocks.state.plans,
      tenants: mocks.state.tenants,
      audit: mocks.state.audit,
      oldJobs: mocks.state.oldJobs,
    }),
  );
}

beforeEach(() => {
  mocks.reset();
});

describe("production saved-rate bootstrap", () => {
  it("validates exact manifests with an explicit reviewed credit price", () => {
    const parsed = parseProductionCreditRolloutManifest(
      JSON.stringify(manifest()),
    );
    expect(parsed.creditPricePaise).toBe(2000);
    expect(() =>
      parseProductionCreditRolloutManifest(
        JSON.stringify({ ...manifest(), rates: manifest().rates.slice(0, 1) }),
      ),
    ).toThrow(/exactly these reviewed keys/);
    expect(() =>
      parseProductionCreditRolloutManifest(
        JSON.stringify({ ...manifest(), unexpected: true }),
      ),
    ).toThrow(/exactly the reviewed fields/);
    const withoutPrice = { ...manifest() } as Partial<ProductionCreditRolloutManifest>;
    delete withoutPrice.creditPricePaise;
    expect(() =>
      parseProductionCreditRolloutManifest(JSON.stringify(withoutPrice)),
    ).toThrow(/creditPricePaise/);
  });

  it("is a development no-op and does not touch seeded customer rows or old jobs", async () => {
    const before = snapshotData();
    const result = await initializeProductionCreditBootstrap({
      env: {
        NODE_ENV: "development",
        REPLIT_DEPLOYMENT: "1",
        CREDIT_ENFORCEMENT_PROD: "saved-rates-v1",
        [CREDIT_PRODUCTION_ROLLOUT_JSON]: JSON.stringify(manifest()),
      },
      database: mocks.database as never,
    });
    expect(result).toEqual({ status: "skipped" });
    expect(snapshotData()).toEqual(before);
  });

  it("fails before opening a transaction for a missing or invalid production manifest", async () => {
    await expect(
      initializeProductionCreditBootstrap({
        env: {
          NODE_ENV: "production",
          REPLIT_DEPLOYMENT: "1",
          CREDIT_ENFORCEMENT_PROD: "saved-rates-v1",
        },
        database: mocks.database as never,
      }),
    ).rejects.toMatchObject({ code: "PRODUCTION_CREDIT_ROLLOUT_INVALID" });
    expect(mocks.state.lockCount).toBe(0);

    await expect(
      initializeProductionCreditBootstrap({
        env: {
          ...productionEnv(),
          [CREDIT_PRODUCTION_ROLLOUT_JSON]: "{not-json",
        },
        database: mocks.database as never,
      }),
    ).rejects.toMatchObject({ code: "PRODUCTION_CREDIT_ROLLOUT_INVALID" });
    expect(mocks.state.lockCount).toBe(0);
  });

  it("applies atomically, switches only named tenants, and preserves old funding", async () => {
    const beforeJobs = [...mocks.state.oldJobs];
    const result = await initializeProductionCreditBootstrap({
      env: productionEnv(),
      database: mocks.database as never,
    });
    expect(result).toMatchObject({
      status: "applied",
      rolloutVersion: "saved-rates-v1",
      updatedTenantCount: 2,
    });
    expect(mocks.state.lockCount).toBe(1);
    expect(mocks.state.settings).toEqual([
      { id: 1, mode: "enforce", creditPricePaise: 2000 },
    ]);
    expect(mocks.state.rates).toHaveLength(8);
    expect(mocks.state.plans.every((plan) => plan.billingMode === "credits")).toBe(true);
    expect(mocks.state.tenants.every((tenant) => tenant.billingMode === "credits")).toBe(true);
    expect(mocks.state.oldJobs).toEqual(beforeJobs);
    expect(mocks.state.audit).toHaveLength(1);
    expect(mocks.state.audit[0]?.action).toBe("credit_rates_change");
    expect(JSON.parse(String(mocks.state.audit[0]?.newValue))).toMatchObject({
      rolloutVersion: "saved-rates-v1",
      manifestDigest: expect.any(String),
      principal: "deployment-owner",
      invoicesVerified: false,
    });
    expect(mocks.state.audit[0]?.actorTenantId).toBe(0);
  });

  it("rolls back every mutation when the marker cannot be written", async () => {
    const before = snapshotData();
    mocks.state.failAudit = true;
    await expect(
      initializeProductionCreditBootstrap({
        env: productionEnv(),
        database: mocks.database as never,
      }),
    ).rejects.toThrow("forced audit failure");
    expect(snapshotData()).toEqual(before);
  });

  it("is restart-idempotent and never resets admin changes after the marker", async () => {
    await initializeProductionCreditBootstrap({
      env: productionEnv(),
      database: mocks.database as never,
    });
    mocks.state.settings[0]!.mode = "off";
    mocks.state.rates[0]!.creditsMilli = 777;
    mocks.state.tenants[0]!.billingMode = "quota";
    const auditCount = mocks.state.audit.length;

    const result = await initializeProductionCreditBootstrap({
      env: productionEnv(),
      database: mocks.database as never,
    });
    expect(result).toEqual({
      status: "already-applied",
      rolloutVersion: "saved-rates-v1",
    });
    expect(mocks.state.settings[0]?.mode).toBe("off");
    expect(mocks.state.rates[0]?.creditsMilli).toBe(777);
    expect(mocks.state.tenants[0]?.billingMode).toBe("quota");
    expect(mocks.state.audit).toHaveLength(auditCount);
  });

  it("rejects an omitted production plan before writing any settings, rates, or tenants", async () => {
    const incomplete = manifest();
    incomplete.plans = incomplete.plans.slice(0, -1);
    const before = snapshotData();
    await expect(
      initializeProductionCreditBootstrap({
        env: productionEnv(incomplete),
        database: mocks.database as never,
      }),
    ).rejects.toThrow(/omitted/);
    expect(snapshotData()).toEqual(before);
  });

  it("rejects a changed manifest digest for the same rollout version", async () => {
    await initializeProductionCreditBootstrap({
      env: productionEnv(),
      database: mocks.database as never,
    });
    const changed = manifest();
    changed.rates = changed.rates.map((rate) =>
      rate.key === "image" ? { ...rate, credits: 1 } : rate,
    );
    const before = snapshotData();
    await expect(
      initializeProductionCreditBootstrap({
        env: productionEnv(changed),
        database: mocks.database as never,
      }),
    ).rejects.toThrow(/manifest digest/);
    expect(snapshotData()).toEqual(before);
  });

  it("serializes concurrent boots so only one transaction applies the rollout", async () => {
    const results = await Promise.all([
      initializeProductionCreditBootstrap({
        env: productionEnv(),
        database: mocks.database as never,
      }),
      initializeProductionCreditBootstrap({
        env: productionEnv(),
        database: mocks.database as never,
      }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "already-applied",
      "applied",
    ]);
    expect(mocks.state.rates).toHaveLength(8);
    expect(mocks.state.audit).toHaveLength(1);
  });
});