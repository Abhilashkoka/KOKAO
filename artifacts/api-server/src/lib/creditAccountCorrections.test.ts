import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  tenant: true, account: true, purchased: 1135000, granted: 7000,
  ledger: [] as any[], audits: [] as any[], failAudit: false,
  grantedExpiresAt: null as Date | null,
}));
vi.mock("@workspace/db", () => {
  const tenantsTable = { id: "tenant" };
  const creditAccountsTable = { tenantId: "account" };
  const creditAccountLedgerTable = { tenantId: "ledger", idempotencyKey: "key" };
  const adminAuditLogsTable = { id: "audit" };
  const tx = {
    select: () => ({ from: (table: unknown) => ({ where: () => {
      const rows = table === tenantsTable ? (state.tenant ? [{ email: "target@example.test" }] : [])
        : table === creditAccountsTable ? (state.account ? [{ purchasedMilli: state.purchased, grantedMilli: state.granted, grantedExpiresAt: state.grantedExpiresAt }] : [])
        : state.ledger;
      return Object.assign(Promise.resolve(rows), { for: () => Promise.resolve(rows) });
    } }) }),
    update: () => ({ set: (values: any) => ({ where: async () => { state.purchased = values.purchasedMilli; } }) }),
    insert: (table: unknown) => ({ values: async (values: any) => {
      if (table === adminAuditLogsTable) {
        if (state.failAudit) throw new Error("audit unavailable");
        state.audits.push(values);
      } else state.ledger.push(values);
    } }),
  };
  return { tenantsTable, creditAccountsTable, creditAccountLedgerTable, adminAuditLogsTable,
    db: { transaction: async (fn: any) => {
      const snapshot = structuredClone(state);
      try { return await fn(tx); } catch (e) { Object.assign(state, snapshot); throw e; }
    } },
  };
});
vi.mock("drizzle-orm", () => ({ eq: vi.fn(), and: vi.fn() }));

import { correctPurchasedCredits, creditCorrectionInput } from "./creditAccountCorrections";
const input = { amountMilli: 92724, expectedPurchasedMilli: 1135000, reference: "video:13:rate-card-correction", reason: "Approved total 97.724 less 5 already charged" };
const actor = { tenantId: 1, email: "admin@example.test" };
beforeEach(() => Object.assign(state, { tenant: true, account: true, purchased: 1135000, granted: 7000, grantedExpiresAt: null, ledger: [], audits: [], failAudit: false }));

describe("purchased-credit corrections (isolated transaction mock)", () => {
  it("excludes expired grants from spendable ledger balance without changing the bucket", async () => {
    state.grantedExpiresAt = new Date(0);
    await correctPurchasedCredits(10, input, actor);
    expect(state.ledger[0].balanceAfterMilli).toBe(1042276);
    expect(state.granted).toBe(7000);
  });
  it("debits exact milli, preserves grants and atomically records actor/target", async () => {
    const receipt = await correctPurchasedCredits(10, input, actor);
    expect(receipt.afterPurchasedMilli).toBe(1042276);
    expect(state.granted).toBe(7000);
    expect(state.ledger[0]).toMatchObject({ purchasedDeltaMilli: -92724, grantedDeltaMilli: 0, refId: input.reference });
    expect(state.audits[0]).toMatchObject({ actorTenantId: 1, targetTenantId: 10 });
  });
  it("replays original receipt despite stale expected balance or later spending", async () => {
    const original = await correctPurchasedCredits(10, input, actor);
    state.purchased = 1000000;
    expect(await correctPurchasedCredits(10, { ...input, expectedPurchasedMilli: 0, reason: "retry" }, actor)).toEqual(original);
    expect(state.ledger).toHaveLength(1);
    expect(state.audits).toHaveLength(1);
    expect(state.purchased).toBe(1000000);
  });
  it("rejects different amount on reused reference", async () => {
    await correctPurchasedCredits(10, input, actor);
    await expect(correctPurchasedCredits(10, { ...input, amountMilli: 1 }, actor)).rejects.toMatchObject({ status: 409 });
    expect(state.ledger).toHaveLength(1);
  });
  it.each([
    { expectedPurchasedMilli: 12 },
    { amountMilli: 1135001 },
  ])("rejects stale or insufficient balance without writes", async (change) => {
    await expect(correctPurchasedCredits(10, { ...input, ...change }, actor)).rejects.toMatchObject({ status: 409 });
    expect(state.purchased).toBe(1135000);
    expect(state.ledger).toHaveLength(0);
    expect(state.audits).toHaveLength(0);
  });
  it.each(["tenant", "account"] as const)("rejects missing %s", async (field) => {
    state[field] = false;
    await expect(correctPurchasedCredits(10, input, actor)).rejects.toMatchObject({ status: 404 });
  });
  it("rolls back debit and ledger if privileged audit fails", async () => {
    state.failAudit = true;
    await expect(correctPurchasedCredits(10, input, actor)).rejects.toThrow("audit unavailable");
    expect(state.purchased).toBe(1135000);
    expect(state.ledger).toHaveLength(0);
  });
  it.each([0, -1, 1.2, NaN, Infinity, 2147483648])("rejects invalid amount %s", (amountMilli) => {
    expect(creditCorrectionInput.safeParse({ ...input, amountMilli }).success).toBe(false);
  });
});