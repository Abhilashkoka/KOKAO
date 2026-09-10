import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { pool, db, creditAccountsTable, creditAccountLedgerTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  getCreditBalance,
  peekCreditBalance,
  grantCredits,
  spendCredits,
  refundCredits,
  listCreditHistory,
  hasCreditAccount,
  totalOutstandingCredits,
  InsufficientCreditsError,
} from "./creditAccounts";
import { MILLI } from "./creditRates";
import { createTenant, deleteTenant } from "../test/dbHelpers";

let tenantId: number;

beforeAll(async () => {
  tenantId = (await createTenant()).tenantId;
});

afterAll(async () => {
  await db.delete(creditAccountLedgerTable).where(eq(creditAccountLedgerTable.tenantId, tenantId));
  await db.delete(creditAccountsTable).where(eq(creditAccountsTable.tenantId, tenantId));
  await deleteTenant(tenantId);
  await pool.end();
});

beforeEach(async () => {
  await db.delete(creditAccountLedgerTable).where(eq(creditAccountLedgerTable.tenantId, tenantId));
  await db.delete(creditAccountsTable).where(eq(creditAccountsTable.tenantId, tenantId));
});

describe("credit accounts", () => {
  it("starts empty and refuses to spend from an empty balance", async () => {
    expect(await getCreditBalance(tenantId)).toMatchObject({
      purchased: 0,
      granted: 0,
      total: 0,
    });
    await expect(spendCredits({ tenantId, creditsMilli: 1000 })).rejects.toBeInstanceOf(
      InsufficientCreditsError,
    );
  });

  it("keeps purchased and granted in separate buckets", async () => {
    await grantCredits({ tenantId, credits: 10, kind: "purchase" });
    await grantCredits({ tenantId, credits: 5, kind: "grant_plan", expiresInDays: 90 });
    expect(await getCreditBalance(tenantId)).toMatchObject({
      purchased: 10,
      granted: 5,
      total: 15,
    });
  });

  it("spends GRANTED credits first so an allowance is used before it lapses", async () => {
    await grantCredits({ tenantId, credits: 10, kind: "purchase" });
    await grantCredits({ tenantId, credits: 4, kind: "grant_plan", expiresInDays: 90 });

    const after = await spendCredits({ tenantId, creditsMilli: 6 * MILLI, rateKey: "video" });
    // 4 from granted, 2 from purchased — not 6 from purchased.
    expect(after).toMatchObject({ granted: 0, purchased: 8, total: 8 });
  });

  it("expires granted credits lazily and leaves purchased untouched", async () => {
    await grantCredits({ tenantId, credits: 7, kind: "purchase" });
    await grantCredits({ tenantId, credits: 3, kind: "grant_promo", expiresInDays: 1 });
    // Backdate the expiry rather than waiting a day.
    await db
      .update(creditAccountsTable)
      .set({ grantedExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(creditAccountsTable.tenantId, tenantId));

    expect(await getCreditBalance(tenantId)).toMatchObject({
      granted: 0,
      purchased: 7,
      total: 7,
    });
    const history = await listCreditHistory(tenantId);
    expect(history.some((h) => h.kind === "expire")).toBe(true);
  });

  it("never shortens the life of credits already in the granted bucket", async () => {
    await grantCredits({ tenantId, credits: 5, kind: "grant_plan", expiresInDays: 90 });
    const first = await peekCreditBalance(tenantId);
    await grantCredits({ tenantId, credits: 5, kind: "grant_promo", expiresInDays: 7 });
    const second = await peekCreditBalance(tenantId);
    expect(new Date(second.grantedExpiresAt!).getTime()).toBe(
      new Date(first.grantedExpiresAt!).getTime(),
    );
  });

  it("refunds into the purchased bucket so a refund never carries a deadline", async () => {
    await grantCredits({ tenantId, credits: 6, kind: "grant_plan", expiresInDays: 30 });
    await spendCredits({ tenantId, creditsMilli: 6 * MILLI, rateKey: "image" });
    await refundCredits({ tenantId, creditsMilli: 6 * MILLI, rateKey: "image" });
    expect(await getCreditBalance(tenantId)).toMatchObject({
      purchased: 6,
      granted: 0,
      total: 6,
    });
  });

  it("is idempotent per key, so a redelivered webhook grants exactly once", async () => {
    const key = "plan:test:2026-01-01T00:00:00.000Z";
    await grantCredits({ tenantId, credits: 15, kind: "grant_plan", idempotencyKey: key });
    await grantCredits({ tenantId, credits: 15, kind: "grant_plan", idempotencyKey: key });
    await grantCredits({ tenantId, credits: 15, kind: "grant_plan", idempotencyKey: key });
    expect((await getCreditBalance(tenantId)).total).toBe(15);
  });

  it("never drives a bucket below zero on a negative admin adjustment", async () => {
    await grantCredits({ tenantId, credits: 3, kind: "grant_admin" });
    await grantCredits({ tenantId, credits: -100, kind: "grant_admin" });
    expect((await getCreditBalance(tenantId)).total).toBe(0);
  });

  it("refuses to remove credits through any kind but an admin adjustment", async () => {
    await expect(
      grantCredits({ tenantId, credits: -5, kind: "grant_plan" }),
    ).rejects.toThrow(/admin adjustment/i);
  });

  it("keeps the ledger summing to the balance", async () => {
    await grantCredits({ tenantId, credits: 20, kind: "purchase" });
    await spendCredits({ tenantId, creditsMilli: 7 * MILLI });
    await refundCredits({ tenantId, creditsMilli: 2 * MILLI });

    const rows = await db
      .select()
      .from(creditAccountLedgerTable)
      .where(eq(creditAccountLedgerTable.tenantId, tenantId));
    const summed = rows.reduce(
      (total, r) => total + r.purchasedDeltaMilli + r.grantedDeltaMilli,
      0,
    );
    expect(summed / MILLI).toBe((await getCreditBalance(tenantId)).total);
  });

  it("does not let two concurrent spends overdraw the balance", async () => {
    await grantCredits({ tenantId, credits: 10, kind: "purchase" });
    const results = await Promise.allSettled([
      spendCredits({ tenantId, creditsMilli: 7 * MILLI }),
      spendCredits({ tenantId, creditsMilli: 7 * MILLI }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok).toHaveLength(1);
    expect((await getCreditBalance(tenantId)).total).toBe(3);
  });

  it("reports account existence and platform liability", async () => {
    expect(await hasCreditAccount(tenantId)).toBe(false);
    await grantCredits({ tenantId, credits: 4, kind: "purchase" });
    expect(await hasCreditAccount(tenantId)).toBe(true);
    expect(await totalOutstandingCredits()).toBeGreaterThanOrEqual(4);
  });
});
