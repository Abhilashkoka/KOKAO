import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  type Table = Record<string, { table: Table; name: string }>;

  const makeTable = (fields: string[]): Table => {
    const table = {} as Table;
    for (const field of fields) {
      table[field] = { table, name: field };
    }
    return table;
  };

  const tables = {
    creditAccountsTable: makeTable([
      "tenantId",
      "purchasedMilli",
      "grantedMilli",
      "updatedAt",
    ]),
    creditAccountLedgerTable: makeTable([
      "id",
      "tenantId",
      "kind",
      "purchasedDeltaMilli",
      "grantedDeltaMilli",
      "balanceAfterMilli",
      "rateKey",
      "refKind",
      "refId",
      "idempotencyKey",
      "note",
    ]),
    creditMeterSettingsTable: makeTable([
      "id",
      "creditPricePaise",
    ]),
    tenantsTable: makeTable(["id"]),
    walletBalancesTable: makeTable(["tenantId", "balancePaise", "updatedAt"]),
    walletLedgerTable: makeTable([
      "id",
      "tenantId",
      "kind",
      "amountPaise",
      "reservationId",
      "estimated",
      "trueUpAt",
      "refKind",
      "refId",
      "note",
    ]),
    walletProviderOperationsTable: makeTable([
      "id",
      "tenantId",
      "status",
    ]),
    walletSettlementRetriesTable: makeTable([
      "id",
      "tenantId",
      "status",
      "reservationId",
      "reservedPaise",
      "targetChargePaise",
    ]),
  };

  const state = {
    walletRows: [] as Row[],
    walletLedgerRows: [] as Row[],
    creditAccountsRows: [] as Row[],
    creditLedgerRows: [] as Row[],
    creditSettingsRows: [] as Row[],
    tenantRows: [] as Row[],
    providerRows: [] as Row[],
    outboxRows: [] as Row[],
    failCreditInsert: false,
    nextWalletLedgerId: 1,
    nextCreditLedgerId: 1,
  };

  const reset = () => {
    state.walletRows = [{ tenantId: 7, balancePaise: 250, updatedAt: new Date() }];
    state.walletLedgerRows = [];
    state.creditAccountsRows = [];
    state.creditLedgerRows = [];
    state.creditSettingsRows = [{ id: 1, creditPricePaise: 300 }];
    state.tenantRows = [{ id: 7 }];
    state.providerRows = [];
    state.outboxRows = [];
    state.failCreditInsert = false;
    state.nextWalletLedgerId = 1;
    state.nextCreditLedgerId = 1;
  };

  const rowsForTable = (table: Table): Row[] => {
    if (table === tables.walletBalancesTable) return state.walletRows;
    if (table === tables.walletLedgerTable) return state.walletLedgerRows;
    if (table === tables.creditAccountsTable) return state.creditAccountsRows;
    if (table === tables.creditAccountLedgerTable) return state.creditLedgerRows;
    if (table === tables.creditMeterSettingsTable) return state.creditSettingsRows;
    if (table === tables.tenantsTable) return state.tenantRows;
    if (table === tables.walletProviderOperationsTable) return state.providerRows;
    if (table === tables.walletSettlementRetriesTable) return state.outboxRows;
    return [];
  };

  const conditionMatches = (condition: unknown, row: Row): boolean => {
    if (!condition || typeof condition !== "object") return true;
    const candidate = condition as {
      kind?: string;
      conditions?: unknown[];
      column?: { name: string };
      value?: unknown;
    };
    if (candidate.kind === "and") {
      return (candidate.conditions ?? []).every((item) =>
        conditionMatches(item, row),
      );
    }
    if (candidate.kind === "eq" && candidate.column) {
      return row[candidate.column.name] === candidate.value;
    }
    if (candidate.kind === "isNull" && candidate.column) {
      return row[candidate.column.name] == null;
    }
    // Raw SQL blockers are applied in readRows because they intentionally
    // inspect sibling rows (e.g. an unresolved reserve).
    return true;
  };

  const hasRawSql = (condition: unknown, marker: string): boolean => {
    if (!condition || typeof condition !== "object") return false;
    const candidate = condition as { kind?: string; text?: string; conditions?: unknown[] };
    if (candidate.kind === "sql") return candidate.text?.includes(marker) ?? false;
    return (candidate.conditions ?? []).some((item) => hasRawSql(item, marker));
  };

  const readRows = (
    table: Table,
    condition: unknown,
    projection?: Record<string, { table: Table; name: string }>,
    limit?: number,
  ): Row[] => {
    let rows = rowsForTable(table).filter((row) =>
      conditionMatches(condition, row),
    );
    if (table === tables.walletLedgerTable && hasRawSql(condition, "NOT EXISTS")) {
      rows = rows.filter(
        (row) =>
          row.kind === "reserve" &&
          (!hasRawSql(condition, "< 0") || Number(row.amountPaise) < 0) &&
          !state.walletLedgerRows.some(
            (resolved) =>
              resolved.tenantId === row.tenantId &&
              resolved.reservationId === row.id &&
              (resolved.kind === "settle" || resolved.kind === "refund"),
          ),
      );
    }
    if (
      table === tables.walletProviderOperationsTable &&
      hasRawSql(condition, "NOT IN")
    ) {
      rows = rows.filter(
        (row) =>
          row.status !== "failed" &&
          row.status !== "refunded" &&
          row.status !== "settled",
      );
    }
    if (
      table === tables.walletSettlementRetriesTable &&
      hasRawSql(condition, "<> 'settled'")
    ) {
      rows = rows.filter((row) => row.status !== "settled");
    }
    const selected = typeof limit === "number" ? rows.slice(0, limit) : rows;
    if (!projection) return selected.map((row) => ({ ...row }));
    return selected.map((row) => {
      const result: Row = {};
      for (const [key, column] of Object.entries(projection)) {
        result[key] = row[column.name];
      }
      return result;
    });
  };

  const makeSelect = (projection?: Record<string, unknown>) => {
    let table: Table | null = null;
    let condition: unknown;
    let limit: number | undefined;
    const chain: Record<string, unknown> = {};
    chain.from = (next: Table) => {
      table = next;
      return chain;
    };
    chain.where = (next: unknown) => {
      condition = next;
      return chain;
    };
    chain.orderBy = () => chain;
    chain.for = () => chain;
    chain.limit = (next: number) => {
      limit = next;
      return chain;
    };
    chain.then = (
      resolve: (value: Row[]) => unknown,
      reject: (error: unknown) => unknown,
    ) =>
      Promise.resolve(
        readRows(
          table!,
          condition,
          projection as Record<string, { table: Table; name: string }> | undefined,
          limit,
        ),
      ).then(resolve, reject);
    return chain;
  };

  const applyWhere = (table: Table, condition: unknown, values: Row) => {
    for (const row of rowsForTable(table)) {
      if (conditionMatches(condition, row)) Object.assign(row, values);
    }
  };

  const makeInsert = (table: Table) => {
    let values: Row = {};
    const chain: Record<string, unknown> = {};
    chain.values = (next: Row) => {
      values = next;
      return chain;
    };
    chain.onConflictDoNothing = async () => {
      if (table === tables.creditAccountsTable) {
        if (
          !state.creditAccountsRows.some(
            (row) => row.tenantId === values.tenantId,
          )
        ) {
          state.creditAccountsRows.push({
            tenantId: values.tenantId,
            purchasedMilli: 0,
            grantedMilli: 0,
            updatedAt: new Date(),
          });
        }
      }
    };
    chain.returning = async (
      projection: Record<string, { table: Table; name: string }>,
    ) => {
      if (
        table === tables.creditAccountLedgerTable &&
        state.failCreditInsert
      ) {
        throw new Error("controlled credit-ledger failure");
      }
      const row = { ...values };
      if (table === tables.walletLedgerTable) {
        row.id = state.nextWalletLedgerId++;
        state.walletLedgerRows.push(row);
      } else if (table === tables.creditAccountLedgerTable) {
        row.id = state.nextCreditLedgerId++;
        state.creditLedgerRows.push(row);
      }
      return [
        Object.fromEntries(
          Object.entries(projection).map(([key, column]) => [
            key,
            row[column.name],
          ]),
        ),
      ];
    };
    return chain;
  };

  const makeUpdate = (table: Table) => {
    let values: Row = {};
    const chain: Record<string, unknown> = {};
    chain.set = (next: Row) => {
      values = next;
      return chain;
    };
    chain.where = async (condition: unknown) => {
      applyWhere(table, condition, values);
    };
    return chain;
  };

  const executor = {
    select: (projection?: Record<string, unknown>) => makeSelect(projection),
    insert: (table: Table) => makeInsert(table),
    update: (table: Table) => makeUpdate(table),
  };

  let transactionTail = Promise.resolve();
  const db = {
    select: executor.select,
    transaction: (callback: (tx: typeof executor) => Promise<unknown>) => {
      const run = transactionTail.then(async () => {
        const snapshot = {
          walletRows: structuredClone(state.walletRows),
          walletLedgerRows: structuredClone(state.walletLedgerRows),
          creditAccountsRows: structuredClone(state.creditAccountsRows),
          creditLedgerRows: structuredClone(state.creditLedgerRows),
          nextWalletLedgerId: state.nextWalletLedgerId,
          nextCreditLedgerId: state.nextCreditLedgerId,
        };
        try {
          return await callback(executor);
        } catch (error) {
          state.walletRows = snapshot.walletRows;
          state.walletLedgerRows = snapshot.walletLedgerRows;
          state.creditAccountsRows = snapshot.creditAccountsRows;
          state.creditLedgerRows = snapshot.creditLedgerRows;
          state.nextWalletLedgerId = snapshot.nextWalletLedgerId;
          state.nextCreditLedgerId = snapshot.nextCreditLedgerId;
          throw error;
        }
      });
      transactionTail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };

  reset();
  return { db, state, tables, reset };
});

vi.mock("@workspace/db", () => ({
  db: harness.db,
  ...harness.tables,
}));

vi.mock("drizzle-orm", () => ({
  and: (...conditions: unknown[]) => ({ kind: "and", conditions }),
  eq: (column: unknown, value: unknown) => ({
    kind: "eq",
    column,
    value,
  }),
  isNull: (column: unknown) => ({ kind: "isNull", column }),
  sql: (strings: TemplateStringsArray) => ({
    kind: "sql",
    text: Array.from(strings).join(""),
  }),
}));

import {
  calculateWalletConversion,
  convertWalletToCredits,
  previewWalletConversion,
  WalletConversionConflictError,
} from "./walletConversion";

describe("wallet conversion (isolated transaction harness)", () => {
  beforeEach(() => {
    harness.reset();
  });

  it("previews and applies a fractional ceil conversion with linked receipts", async () => {
    const preview = await previewWalletConversion(7);
    expect(preview).toMatchObject({
      walletPaise: 250,
      creditPricePaise: 300,
      credits: 0.834,
      canConvert: true,
      reason: null,
    });

    const result = await convertWalletToCredits({
      tenantId: 7,
      expectedWalletPaise: 250,
      expectedCreditPricePaise: 300,
      idempotencyKey: "conversion-fraction-1",
    });
    expect(result).toMatchObject({
      walletPaiseConverted: 250,
      creditsAdded: 0.834,
      remainingWalletPaise: 0,
      creditPricePaise: 300,
    });
    expect(harness.state.walletRows[0]).toMatchObject({ balancePaise: 0 });
    expect(harness.state.creditAccountsRows[0]).toMatchObject({
      purchasedMilli: 834,
      grantedMilli: 0,
    });
    expect(harness.state.walletLedgerRows).toHaveLength(1);
    expect(harness.state.walletLedgerRows[0]).toMatchObject({
      kind: "admin_debit",
      amountPaise: -250,
      refKind: "walletConversion",
      refId: "conversion-fraction-1",
    });
    expect(harness.state.creditLedgerRows).toHaveLength(1);
    expect(harness.state.creditLedgerRows[0]).toMatchObject({
      kind: "purchase",
      purchasedDeltaMilli: 834,
      rateKey: "wallet_conversion:300",
      refKind: "walletConversion",
      refId: "conversion-fraction-1",
      idempotencyKey: "conversion-fraction-1",
    });
    expect(harness.state.walletLedgerRows[0].note).toContain(
      `"creditLedgerId":1`,
    );
    expect(harness.state.creditLedgerRows[0].note).toContain(
      `"walletLedgerId":1`,
    );
  });

  it("serializes two same-key requests and replays one receipt", async () => {
    const params = {
      tenantId: 7,
      expectedWalletPaise: 250,
      expectedCreditPricePaise: 300,
      idempotencyKey: "conversion-replay-1",
    };
    const [first, second] = await Promise.all([
      convertWalletToCredits(params),
      convertWalletToCredits(params),
    ]);
    expect(second).toEqual(first);
    expect(harness.state.walletLedgerRows).toHaveLength(1);
    expect(harness.state.creditLedgerRows).toHaveLength(1);
    expect(harness.state.creditAccountsRows[0]).toMatchObject({
      purchasedMilli: 834,
    });
  });

  it("rejects stale balance or price snapshots before changing anything", async () => {
    await expect(
      convertWalletToCredits({
        tenantId: 7,
        expectedWalletPaise: 249,
        expectedCreditPricePaise: 300,
        idempotencyKey: "conversion-stale-balance",
      }),
    ).rejects.toThrow(WalletConversionConflictError);
    await expect(
      convertWalletToCredits({
        tenantId: 7,
        expectedWalletPaise: 250,
        expectedCreditPricePaise: 301,
        idempotencyKey: "conversion-stale-price",
      }),
    ).rejects.toThrow(WalletConversionConflictError);
    expect(harness.state.walletRows[0]).toMatchObject({ balancePaise: 250 });
    expect(harness.state.walletLedgerRows).toHaveLength(0);
    expect(harness.state.creditLedgerRows).toHaveLength(0);
  });

  it("rejects pending settlement blockers without a silent no-op", async () => {
    harness.state.walletLedgerRows.push({
      id: 9,
      tenantId: 7,
      kind: "reserve",
      amountPaise: -100,
      reservationId: null,
      estimated: false,
      trueUpAt: null,
    });
    await expect(
      convertWalletToCredits({
        tenantId: 7,
        expectedWalletPaise: 250,
        expectedCreditPricePaise: 300,
        idempotencyKey: "conversion-blocked",
      }),
    ).rejects.toThrow(/outstanding generation reservation/i);
    expect(harness.state.walletRows[0]).toMatchObject({ balancePaise: 250 });
    expect(harness.state.creditLedgerRows).toHaveLength(0);
  });

  it("rejects pending provider, outbox, and true-up blockers", async () => {
    const blockers = [
      () => harness.state.providerRows.push({ id: 1, tenantId: 7, status: "succeeded" }),
      () => harness.state.outboxRows.push({ id: 1, tenantId: 7, status: "pending" }),
      () =>
        harness.state.walletLedgerRows.push({
          id: 1,
          tenantId: 7,
          kind: "settle",
          amountPaise: -100,
          reservationId: 1,
          estimated: true,
          trueUpAt: null,
        }),
    ];
    for (const addBlocker of blockers) {
      harness.reset();
      addBlocker();
      await expect(
        convertWalletToCredits({
          tenantId: 7,
          expectedWalletPaise: 250,
          expectedCreditPricePaise: 300,
          idempotencyKey: `conversion-blocked-${harness.state.providerRows.length}-${harness.state.outboxRows.length}-${harness.state.walletLedgerRows.length}`,
        }),
      ).rejects.toThrow(WalletConversionConflictError);
      expect(harness.state.walletRows[0]).toMatchObject({ balancePaise: 250 });
      expect(harness.state.creditLedgerRows).toHaveLength(0);
    }
  });

  it("rolls back the wallet debit and account insert when credit append fails", async () => {
    harness.state.failCreditInsert = true;
    await expect(
      convertWalletToCredits({
        tenantId: 7,
        expectedWalletPaise: 250,
        expectedCreditPricePaise: 300,
        idempotencyKey: "conversion-rollback",
      }),
    ).rejects.toThrow("controlled credit-ledger failure");
    expect(harness.state.walletRows[0]).toMatchObject({ balancePaise: 250 });
    expect(harness.state.walletLedgerRows).toHaveLength(0);
    expect(harness.state.creditAccountsRows).toHaveLength(0);
    expect(harness.state.creditLedgerRows).toHaveLength(0);
  });

  it("keeps the arithmetic bounded to the database integer range", () => {
    expect(calculateWalletConversion(2_147_483_647, 1)).toBeNull();
    expect(calculateWalletConversion(2_147_483, 1)).toEqual({
      walletPaise: 2_147_483,
      creditPricePaise: 1,
      creditsMilli: 2_147_483_000,
    });
  });
});