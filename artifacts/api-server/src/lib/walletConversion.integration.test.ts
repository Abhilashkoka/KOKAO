import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("@clerk/express", async () => {
  const { authState } = await import("../test/authState");
  return {
    getAuth: () =>
      authState.userId
        ? {
            userId: authState.userId,
            sessionClaims: { userId: authState.userId },
          }
        : {},
    clerkClient: {
      users: {
        getUser: async (id: string) => {
          const user = authState.users[id];
          if (!user) throw new Error("user not found");
          return user;
        },
      },
    },
    clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) =>
      next(),
  };
});

vi.mock("./connectionSweep", () => ({
  triggerSweepNow: vi.fn(() => true),
  isSweepRunning: vi.fn(() => false),
  checkSweepStaleness: vi.fn(async () => undefined),
  SWEEP_FAIL_RATIO_ALERT_THRESHOLD: 0.5,
}));

import {
  pool,
  db,
  creditAccountsTable,
  creditAccountLedgerTable,
  creditMeterSettingsTable,
  tenantsTable,
  walletBalancesTable,
  walletLedgerTable,
  walletProviderOperationsTable,
  walletSettlementRetriesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  convertWalletToCredits,
  WalletConversionConflictError,
} from "./walletConversion";
import {
  planCreditMigration,
  planCreditMigrationPreview,
  runCreditMigration,
} from "./creditMigration";
import { reserveWallet } from "./wallet";
import { createAdminTestApp } from "../test/testApp";
import {
  actAs,
  resetAuthState,
} from "../test/authState";
import { createTenant, deleteTenant } from "../test/dbHelpers";
import type { TestTenant } from "../test/dbHelpers";

const app = createAdminTestApp();
const RATE_PAISE = 300;

let actor: TestTenant;
let tenant: TestTenant;
let previousRate: number | null;
let hadRateRow = false;

async function clearTenantRows(): Promise<void> {
  await db
    .delete(walletProviderOperationsTable)
    .where(eq(walletProviderOperationsTable.tenantId, tenant.tenantId));
  await db
    .delete(walletSettlementRetriesTable)
    .where(eq(walletSettlementRetriesTable.tenantId, tenant.tenantId));
  await db
    .delete(walletLedgerTable)
    .where(eq(walletLedgerTable.tenantId, tenant.tenantId));
  await db
    .delete(creditAccountLedgerTable)
    .where(eq(creditAccountLedgerTable.tenantId, tenant.tenantId));
  await db
    .delete(creditAccountsTable)
    .where(eq(creditAccountsTable.tenantId, tenant.tenantId));
  await db
    .delete(walletBalancesTable)
    .where(eq(walletBalancesTable.tenantId, tenant.tenantId));
}

async function setRate(): Promise<void> {
  await db
    .insert(creditMeterSettingsTable)
    .values({ id: 1, creditPricePaise: RATE_PAISE })
    .onConflictDoUpdate({
      target: creditMeterSettingsTable.id,
      set: { creditPricePaise: RATE_PAISE, updatedAt: new Date() },
    });
}

function conversionParams(idempotencyKey: string) {
  return {
    tenantId: tenant.tenantId,
    expectedWalletPaise: 250,
    expectedCreditPricePaise: RATE_PAISE,
    idempotencyKey,
  };
}

beforeAll(async () => {
  actor = await createTenant({
    isSuperadmin: true,
    email: `wallet-conversion-admin-${Date.now()}@example.com`,
  });
  tenant = await createTenant({
    email: `wallet-conversion-target-${Date.now()}@example.com`,
  });
  const [settings] = await db
    .select({ creditPricePaise: creditMeterSettingsTable.creditPricePaise })
    .from(creditMeterSettingsTable)
    .where(eq(creditMeterSettingsTable.id, 1))
    .limit(1);
  hadRateRow = Boolean(settings);
  previousRate = settings?.creditPricePaise ?? null;
  await setRate();
});

beforeEach(async () => {
  await clearTenantRows();
  await db
    .update(tenantsTable)
    .set({ billingMode: "wallet" })
    .where(eq(tenantsTable.id, tenant.tenantId));
  await setRate();
});

afterAll(async () => {
  resetAuthState();
  await clearTenantRows();
  if (hadRateRow) {
    await db
      .update(creditMeterSettingsTable)
      .set({ creditPricePaise: previousRate, updatedAt: new Date() })
      .where(eq(creditMeterSettingsTable.id, 1));
  } else {
    await db
      .delete(creditMeterSettingsTable)
      .where(eq(creditMeterSettingsTable.id, 1));
  }
  await deleteTenant(tenant.tenantId);
  await deleteTenant(actor.tenantId);
  await pool.end();
});

describe("wallet conversion against PostgreSQL", () => {
  it("ignores a zero-value historical reservation without deleting its audit row", async () => {
    await db.insert(walletBalancesTable).values({ tenantId: tenant.tenantId, balancePaise: 250 });
    const [zero] = await db.insert(walletLedgerTable).values({
      tenantId: tenant.tenantId, kind: "reserve", amountPaise: 0, usageKind: "video",
    }).returning();
    const result = await convertWalletToCredits(conversionParams("pg-zero-reserve"));
    expect(result.walletPaiseConverted).toBe(250);
    const kept = await db.select().from(walletLedgerTable).where(eq(walletLedgerTable.id, zero.id));
    expect(kept).toHaveLength(1);
    expect(kept[0].amountPaise).toBe(0);
  });

  it("serializes same-key replay and rejects a different-key race", async () => {
    await db.insert(walletBalancesTable).values({
      tenantId: tenant.tenantId,
      balancePaise: 250,
    });

    const sameKey = await Promise.all([
      convertWalletToCredits(conversionParams("pg-replay")),
      convertWalletToCredits(conversionParams("pg-replay")),
    ]);
    expect(sameKey[0]).toEqual(sameKey[1]);
    expect(
      await db
        .select()
        .from(creditAccountLedgerTable)
        .where(eq(creditAccountLedgerTable.tenantId, tenant.tenantId)),
    ).toHaveLength(1);

    await clearTenantRows();
    await db.insert(walletBalancesTable).values({
      tenantId: tenant.tenantId,
      balancePaise: 250,
    });
    const differentKey = await Promise.allSettled([
      convertWalletToCredits(conversionParams("pg-different-a")),
      convertWalletToCredits(conversionParams("pg-different-b")),
    ]);
    expect(
      differentKey.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      differentKey.filter(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof WalletConversionConflictError,
      ),
    ).toHaveLength(1);
  });

  it("serializes conversion against a real wallet reservation race", async () => {
    await db.insert(walletBalancesTable).values({
      tenantId: tenant.tenantId,
      balancePaise: 250,
    });
    const [conversion, reservation] = await Promise.allSettled([
      convertWalletToCredits(conversionParams("pg-reserve-race")),
      reserveWallet(
        tenant.tenantId,
        "caption",
        { model: "wallet-conversion-test" },
        1,
        100,
      ),
    ]);
    const conversionSucceeded = conversion.status === "fulfilled";
    const reservationSucceeded =
      reservation.status === "fulfilled" && reservation.value !== null;
    expect(Number(conversionSucceeded) + Number(reservationSucceeded)).toBe(1);

    const [wallet] = await db
      .select()
      .from(walletBalancesTable)
      .where(eq(walletBalancesTable.tenantId, tenant.tenantId));
    expect(wallet).toBeDefined();
    if (conversionSucceeded) {
      expect(wallet.balancePaise).toBe(0);
    } else {
      expect(wallet.balancePaise).toBeGreaterThan(0);
    }
  });

  it("rejects prior wallet migration receipts and disables broad wallet grants", async () => {
    await db.insert(walletBalancesTable).values({
      tenantId: tenant.tenantId,
      balancePaise: 250,
    });
    await db.insert(creditAccountsTable).values({ tenantId: tenant.tenantId });
    await db.insert(creditAccountLedgerTable).values({
      tenantId: tenant.tenantId,
      kind: "migrate",
      purchasedDeltaMilli: 834,
      grantedDeltaMilli: 0,
      balanceAfterMilli: 834,
      idempotencyKey: `migrate:${tenant.tenantId}`,
      note: "Converted from ₹2.50 wallet balance",
    });

    await expect(
      convertWalletToCredits(conversionParams("pg-prior-wallet-migration")),
    ).rejects.toThrow(/prior broad wallet migration receipt/i);
    expect(
      await db
        .select()
        .from(walletBalancesTable)
        .where(eq(walletBalancesTable.tenantId, tenant.tenantId)),
    ).toMatchObject([{ balancePaise: 250 }]);

    const plan = await planCreditMigration();
    expect(plan.find((row) => row.tenantId === tenant.tenantId)).toBeUndefined();
    const preview = await planCreditMigrationPreview();
    // A prior migrate receipt already marks this tenant reviewed; it is not
    // presented as fresh wallet work, but conversion still requires manual
    // review and refuses to touch the balance.
    expect(
      preview.skippedWallets.find((row) => row.tenantId === tenant.tenantId),
    ).toBeUndefined();

    const result = await runCreditMigration([
      {
        tenantId: tenant.tenantId,
        plan: "free",
        source: "wallet",
        detail: "₹2.50 wallet balance",
        credits: 1,
      },
    ]);
    expect(result).toMatchObject({
      migrated: [],
      skipped: 1,
      totalCreditsGranted: 0,
    });
  });

  it("does not grant a wallet migration while conversion commits", async () => {
    await db.insert(walletBalancesTable).values({
      tenantId: tenant.tenantId,
      balancePaise: 250,
    });
    const [conversion, migration] = await Promise.all([
      convertWalletToCredits(conversionParams("pg-broad-race")),
      runCreditMigration([
        {
          tenantId: tenant.tenantId,
          plan: "free",
          source: "wallet",
          detail: "₹2.50 wallet balance",
          credits: 1,
        },
      ]),
    ]);
    expect(conversion.creditsAdded).toBeCloseTo(0.834);
    expect(migration.migrated).toEqual([]);
    expect(migration.skipped).toBe(1);
    expect(
      await db
        .select({ kind: creditAccountLedgerTable.kind })
        .from(creditAccountLedgerTable)
        .where(eq(creditAccountLedgerTable.tenantId, tenant.tenantId)),
    ).toEqual([expect.objectContaining({ kind: "purchase" })]);
  });
});

describe("wallet conversion route authorization and snapshots", () => {
  beforeEach(() => {
    resetAuthState();
  });

  it("rejects stale snapshots and protects the route with admin auth", async () => {
    await db.insert(walletBalancesTable).values({
      tenantId: tenant.tenantId,
      balancePaise: 250,
    });
    actAs(actor.clerkUserId, actor.email);
    const stale = await request(app)
      .post(`/api/admin/tenants/${tenant.tenantId}/wallet-conversion`)
      .send({
        expectedWalletPaise: 249,
        expectedCreditPricePaise: RATE_PAISE,
        idempotencyKey: "pg-route-stale",
      });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatch(/changed|refresh/i);

    resetAuthState();
    const unauthenticated = await request(app).get(
      `/api/admin/tenants/${tenant.tenantId}/wallet-conversion`,
    );
    expect(unauthenticated.status).toBe(401);

    actAs(tenant.clerkUserId, tenant.email);
    const forbidden = await request(app).get(
      `/api/admin/tenants/${tenant.tenantId}/wallet-conversion`,
    );
    expect(forbidden.status).toBe(403);
  });
});