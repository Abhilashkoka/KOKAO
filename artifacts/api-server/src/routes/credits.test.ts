import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("./../lib/creditReconciliationGate", () => ({
  CREDIT_RECONCILIATION_GATE: {
    verdict: "go",
    reason: "credit grant safety test override",
  },
  isCreditEnforcementAllowed: () => true,
  creditEnforcementLockReason: () => "credit grant safety test override",
}));

// The route's own requireTenant import is mocked so this test can focus on the
// side effect boundary of GET /credits rather than Clerk session setup.
vi.mock("../middlewares/requireTenant", () => ({
  requireTenant: (req: { header: (name: string) => string | undefined; tenantId?: number }, _res: unknown, next: () => void) => {
    req.tenantId = Number(req.header("x-test-tenant"));
    next();
  },
}));

import {
  pool,
  db,
  creditAccountsTable,
  creditAccountLedgerTable,
  planSettingsTable,
  subscriptionsTable,
  tenantsTable,
  walletBalancesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import creditsRouter from "./credits";
import { grantMonthlyCredits, grantUnbilledPlanCredits } from "../lib/monthlyCreditGrant";
import {
  planCreditMigration,
  planCreditMigrationPreview,
  DEFAULT_CREDIT_PRICE_PAISE,
} from "../lib/creditMigration";
import { setMeterMode, invalidateCreditRateCache } from "../lib/creditRates";
import { createTenant, deleteTenant } from "../test/dbHelpers";

const PLAN_ID = "credits-route-safety-plan";

const app = express();
app.use(express.json());
app.use("/api", creditsRouter);

let tenantId: number;

beforeAll(async () => {
  tenantId = (await createTenant()).tenantId;
  await db.insert(planSettingsTable).values({
    id: PLAN_ID,
    name: PLAN_ID,
    priceLabel: "test",
    captions: 0,
    images: 0,
    videos: 0,
    monthlyCredits: 120,
    brandKits: 1,
    scheduledPosts: 1,
    features: [],
  });
  await setMeterMode("enforce");
});

beforeEach(async () => {
  await db.delete(creditAccountLedgerTable).where(eq(creditAccountLedgerTable.tenantId, tenantId));
  await db.delete(creditAccountsTable).where(eq(creditAccountsTable.tenantId, tenantId));
  await db.delete(subscriptionsTable).where(eq(subscriptionsTable.tenantId, tenantId));
  await db.delete(walletBalancesTable).where(eq(walletBalancesTable.tenantId, tenantId));
  await db
    .update(tenantsTable)
    .set({ plan: PLAN_ID, billingMode: "quota" })
    .where(eq(tenantsTable.id, tenantId));
  invalidateCreditRateCache();
  await setMeterMode("enforce");
});

afterAll(async () => {
  await setMeterMode("shadow");
  await db.delete(creditAccountLedgerTable).where(eq(creditAccountLedgerTable.tenantId, tenantId));
  await db.delete(creditAccountsTable).where(eq(creditAccountsTable.tenantId, tenantId));
  await db.delete(subscriptionsTable).where(eq(subscriptionsTable.tenantId, tenantId));
  await db.delete(walletBalancesTable).where(eq(walletBalancesTable.tenantId, tenantId));
  await deleteTenant(tenantId);
  await db.delete(planSettingsTable).where(eq(planSettingsTable.id, PLAN_ID));
  await pool.end();
});

describe("GET /credits grant safety", () => {
  it("does not create an account on legacy quota or wallet reads", async () => {
    const quotaRead = await request(app)
      .get("/api/credits")
      .set("x-test-tenant", String(tenantId));
    expect(quotaRead.status).toBe(200);
    expect(quotaRead.body.total).toBe(0);
    expect(await grantUnbilledPlanCredits(tenantId)).toBe(0);
    expect(
      (await db
        .select()
        .from(creditAccountsTable)
        .where(eq(creditAccountsTable.tenantId, tenantId))),
    ).toHaveLength(0);
    expect(await planCreditMigration()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tenantId, source: "quota", credits: 120 }),
      ]),
    );

    await db
      .update(tenantsTable)
      .set({ billingMode: "wallet" })
      .where(eq(tenantsTable.id, tenantId));
    await db
      .insert(walletBalancesTable)
      .values({ tenantId, balancePaise: DEFAULT_CREDIT_PRICE_PAISE * 2 });

    const walletRead = await request(app)
      .get("/api/credits")
      .set("x-test-tenant", String(tenantId));
    expect(walletRead.status).toBe(200);
    expect(walletRead.body.total).toBe(0);
    expect(await grantUnbilledPlanCredits(tenantId)).toBe(0);
    expect(
      (await db
        .select()
        .from(creditAccountsTable)
        .where(eq(creditAccountsTable.tenantId, tenantId))),
    ).toHaveLength(0);
    expect((await planCreditMigration()).find((row) => row.tenantId === tenantId)).toBeUndefined();
    expect((await planCreditMigrationPreview()).skippedWallets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tenantId,
          reason: expect.stringContaining("wallet Adjust conversion"),
        }),
      ]),
    );
  });

  it("does not duplicate a paid-period allowance for an active subscription", async () => {
    await db
      .update(tenantsTable)
      .set({ billingMode: "credits" })
      .where(eq(tenantsTable.id, tenantId));
    await db.insert(creditAccountsTable).values({ tenantId });
    await db.insert(subscriptionsTable).values({
      tenantId,
      planId: PLAN_ID,
      gateway: "razorpay",
      status: "active",
      currentPeriodEnd: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    await grantMonthlyCredits({
      tenantId,
      planId: PLAN_ID,
      periodEnd: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    const response = await request(app)
      .get("/api/credits")
      .set("x-test-tenant", String(tenantId));
    expect(response.status).toBe(200);
    expect(response.body.total).toBe(120);
    expect(response.body.history.filter((row: { kind: string }) => row.kind === "grant_plan")).toHaveLength(1);
  });
});