import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
vi.mock("./creditReconciliationGate", () => ({
  CREDIT_RECONCILIATION_GATE: {
    verdict: "go",
    reason: "enforcement algorithm test override",
  },
  isCreditEnforcementAllowed: () => true,
  creditEnforcementLockReason: () => "enforcement algorithm test override",
}));
import {
  pool,
  db,
  creditAccountsTable,
  creditAccountLedgerTable,
  creditBalancesTable,
  creditLedgerTable,
  subscriptionsTable,
  planSettingsTable,
  tenantsTable,
  walletBalancesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  getCreditBalance,
  grantCredits,
  isCreditFunded,
} from "./creditAccounts";
import { setMeterMode, invalidateCreditRateCache } from "./creditRates";
import {
  monthlyCreditsForPlan,
  grantMonthlyCredits,
  grantUnbilledPlanCredits,
} from "./monthlyCreditGrant";
import {
  getLegacyConversionStatus,
  planCreditMigration,
  planCreditMigrationPreview,
  runCreditMigration,
} from "./creditMigration";
import { creditsMilliFor, MILLI } from "./creditRates";
import { invalidatePlanCache } from "./plans";
import { createTenant, deleteTenant } from "../test/dbHelpers";

/**
 * The plan -> credits mapping.
 *
 * Everything here exists because the allowance chain had a cut in the middle:
 * the column existed and the grant read it, but nothing could ever write it,
 * so every plan was permanently worth zero credits. These tests pin the two
 * halves that close it — a plan row that actually carries an allowance, and a
 * rail that only collects when the meter is really enforcing.
 */

let tenantId: number;

const FREE_PLAN = "test_free_plan";
const PAID_PLAN = "test_paid_plan";

function planRow(id: string, extra: Record<string, unknown>) {
  return {
    id,
    name: id,
    priceLabel: "test",
    captions: 0,
    images: 0,
    videos: 0,
    brandKits: 1,
    scheduledPosts: 1,
    features: [] as string[],
    ...extra,
  };
}

beforeAll(async () => {
  tenantId = (await createTenant()).tenantId;
  await db
    .insert(planSettingsTable)
    .values([
      planRow(FREE_PLAN, { monthlyCredits: 120, priceInr: null }),
      planRow(PAID_PLAN, { monthlyCredits: 900, priceInr: 99900 }),
    ]);
  invalidatePlanCache();
});

afterAll(async () => {
  await setMeterMode("shadow");
  await db
    .delete(creditAccountLedgerTable)
    .where(eq(creditAccountLedgerTable.tenantId, tenantId));
  await db
    .delete(creditAccountsTable)
    .where(eq(creditAccountsTable.tenantId, tenantId));
  await db
    .delete(creditLedgerTable)
    .where(eq(creditLedgerTable.tenantId, tenantId));
  await db
    .delete(creditBalancesTable)
    .where(eq(creditBalancesTable.tenantId, tenantId));
  await db
    .delete(subscriptionsTable)
    .where(eq(subscriptionsTable.tenantId, tenantId));
  await db
    .delete(walletBalancesTable)
    .where(eq(walletBalancesTable.tenantId, tenantId));
  await deleteTenant(tenantId);
  await db.delete(planSettingsTable).where(eq(planSettingsTable.id, FREE_PLAN));
  await db.delete(planSettingsTable).where(eq(planSettingsTable.id, PAID_PLAN));
  invalidatePlanCache();
  await pool.end();
});

beforeEach(async () => {
  await db
    .delete(creditAccountLedgerTable)
    .where(eq(creditAccountLedgerTable.tenantId, tenantId));
  await db
    .delete(creditAccountsTable)
    .where(eq(creditAccountsTable.tenantId, tenantId));
  await db
    .delete(subscriptionsTable)
    .where(eq(subscriptionsTable.tenantId, tenantId));
  await db
    .delete(walletBalancesTable)
    .where(eq(walletBalancesTable.tenantId, tenantId));
  await db
    .delete(creditLedgerTable)
    .where(eq(creditLedgerTable.tenantId, tenantId));
  await db
    .delete(creditBalancesTable)
    .where(eq(creditBalancesTable.tenantId, tenantId));
  invalidateCreditRateCache();
  invalidatePlanCache();
});

async function setTenant(plan: string, billingMode: string) {
  await db
    .update(tenantsTable)
    .set({ plan, billingMode })
    .where(eq(tenantsTable.id, tenantId));
}

describe("plan allowances", () => {
  it("reads the allowance off the plan row", async () => {
    expect(await monthlyCreditsForPlan(FREE_PLAN)).toBe(120);
    expect(await monthlyCreditsForPlan(PAID_PLAN)).toBe(900);
  });

  it("is zero for a plan nobody has set an allowance on", async () => {
    // The built-in catalog carries no allowance on purpose: what a plan should
    // be worth depends on the rate card, so it is a superadmin's decision.
    expect(await monthlyCreditsForPlan("free")).toBe(0);
  });
});

describe("the credits rail", () => {
  it("does not fund anything while the meter is only recording", async () => {
    // The hazard this pins: a plan moved onto credits during shadow mode would
    // reserve nothing at the route AND be charged nothing at the provider.
    // Two settings that each look harmless, adding up to free generation.
    await setTenant(FREE_PLAN, "credits");
    await setMeterMode("shadow");
    expect(await isCreditFunded(tenantId)).toBe(false);
  });

  it("funds a credits workspace once the meter enforces", async () => {
    await setTenant(FREE_PLAN, "credits");
    await setMeterMode("enforce");
    expect(await isCreditFunded(tenantId)).toBe(true);
  });

  it("leaves quota and wallet workspaces on their own rail", async () => {
    await setMeterMode("enforce");
    await setTenant(FREE_PLAN, "quota");
    expect(await isCreditFunded(tenantId)).toBe(false);
    await setTenant(FREE_PLAN, "wallet");
    expect(await isCreditFunded(tenantId)).toBe(false);
  });
});

describe("the allowance for plans no gateway bills", () => {
  beforeEach(async () => {
    await setMeterMode("enforce");
  });

  it("grants a free plan its allowance", async () => {
    await setTenant(FREE_PLAN, "credits");
    // A migrated credit account is the explicit safety marker that permits a
    // read to issue a lazy allowance. The read must never create this row.
    await db.insert(creditAccountsTable).values({ tenantId });
    expect(await grantUnbilledPlanCredits(tenantId)).toBe(120);
    expect((await getCreditBalance(tenantId)).total).toBe(120);
  });

  it("grants it once per calendar month, however often it is called", async () => {
    await setTenant(FREE_PLAN, "credits");
    await db.insert(creditAccountsTable).values({ tenantId });
    await grantUnbilledPlanCredits(tenantId);
    expect(await grantUnbilledPlanCredits(tenantId)).toBe(0);
    expect(await grantUnbilledPlanCredits(tenantId)).toBe(0);
    expect((await getCreditBalance(tenantId)).total).toBe(120);
  });

  it("never grants a priced plan, which the payment webhook already covers", async () => {
    // Otherwise a subscriber collects twice a month: once on the charge and
    // once on whichever page load happened to hit the balance endpoint.
    await setTenant(PAID_PLAN, "credits");
    expect(await grantUnbilledPlanCredits(tenantId)).toBe(0);
    expect((await getCreditBalance(tenantId)).total).toBe(0);
  });

  it("does nothing for a plan with no allowance set", async () => {
    await setTenant("free", "credits");
    expect(await grantUnbilledPlanCredits(tenantId)).toBe(0);
  });

  it("lands in the expiring bucket, like every other plan grant", async () => {
    await setTenant(FREE_PLAN, "credits");
    await db.insert(creditAccountsTable).values({ tenantId });
    await grantUnbilledPlanCredits(tenantId);
    const balance = await getCreditBalance(tenantId);
    expect(balance.granted).toBe(120);
    expect(balance.purchased).toBe(0);
    expect(balance.grantedExpiresAt).not.toBeNull();
  });

  it("does not let a quota or wallet read create an account or hide migration work", async () => {
    await setTenant(FREE_PLAN, "quota");
    expect(await grantUnbilledPlanCredits(tenantId)).toBe(0);
    expect(await planCreditMigration()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tenantId, source: "quota", credits: 120 }),
      ]),
    );
    expect(
      await db
        .select()
        .from(creditAccountsTable)
        .where(eq(creditAccountsTable.tenantId, tenantId)),
    ).toHaveLength(0);

    await setTenant(FREE_PLAN, "wallet");
    await db
      .insert(walletBalancesTable)
      .values({ tenantId, balancePaise: 9000 });
    expect(await grantUnbilledPlanCredits(tenantId)).toBe(0);
    expect(
      (await planCreditMigration()).find((row) => row.tenantId === tenantId),
    ).toBeUndefined();
    expect(
      (await planCreditMigrationPreview()).skippedWallets,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tenantId,
          reason: expect.stringContaining("wallet Adjust conversion"),
        }),
      ]),
    );
    expect(
      await db
        .select()
        .from(creditAccountsTable)
        .where(eq(creditAccountsTable.tenantId, tenantId)),
    ).toHaveLength(0);
  });

  it("does not treat a reward-created account as legacy migration approval", async () => {
    await setTenant(FREE_PLAN, "quota");
    // A reward claim can create the canonical account before an admin reviews
    // the old rail. The account itself is not an approval receipt.
    await db.insert(creditAccountsTable).values({ tenantId });
    expect(await planCreditMigration()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tenantId, source: "quota", credits: 120 }),
      ]),
    );
  });

  it("does not add a lazy allowance to an active gateway subscription", async () => {
    await setTenant(FREE_PLAN, "credits");
    await db.insert(creditAccountsTable).values({ tenantId });
    await db.insert(subscriptionsTable).values({
      tenantId,
      planId: FREE_PLAN,
      gateway: "razorpay",
      status: "active",
      currentPeriodEnd: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    // Simulate the paid-period webhook having already issued this cycle. The
    // read must not add a second allowance merely because the catalog price is
    // null (a valid manual-only plan).
    const periodEnd = new Date(Date.now() + 24 * 60 * 60 * 1000);
    expect(
      await grantMonthlyCredits({
        tenantId,
        planId: FREE_PLAN,
        periodEnd,
      }),
    ).toBe(120);
    expect(await grantUnbilledPlanCredits(tenantId)).toBe(0);
    expect((await getCreditBalance(tenantId)).total).toBe(120);
  });

  it("does not overlap a migration allowance in the same calendar period", async () => {
    await setTenant(FREE_PLAN, "credits");
    await db.insert(creditAccountsTable).values({ tenantId });
    await grantCredits({
      tenantId,
      credits: 120,
      kind: "migrate",
      idempotencyKey: `migrate:${tenantId}`,
      note: "Converted from test quota allowance",
    });

    expect(await grantUnbilledPlanCredits(tenantId)).toBe(0);
    expect((await getCreditBalance(tenantId)).total).toBe(120);
  });

  it("converts legacy generation balances once without mutating the old rail", async () => {
    await setTenant(FREE_PLAN, "quota");
    const legacy = {
      tenantId,
      captionCredits: 5,
      imageCredits: 1,
      videoCredits: 2,
    };
    await db.insert(creditBalancesTable).values(legacy);

    const expectedMilli = Math.ceil(
      ((await creditsMilliFor("caption", 5))! +
        (await creditsMilliFor("image", 1))! +
        (await creditsMilliFor("video", 10 * 2))!) /
        MILLI,
    ) * MILLI;
    const plan = (await planCreditMigration()).filter(
      (row) => row.tenantId === tenantId,
    );
    expect(plan).toEqual([
      expect.objectContaining({
        tenantId,
        source: "credit",
        credits: expectedMilli / MILLI,
      }),
    ]);
    expect(await getLegacyConversionStatus(tenantId)).toMatchObject({
      pending: true,
      captionCredits: 5,
      imageCredits: 1,
      videoCredits: 2,
    });

    const first = await runCreditMigration(plan);
    expect(first).toMatchObject({
      migrated: plan,
      skipped: 0,
      totalCreditsGranted: expectedMilli / MILLI,
    });
    expect(await getCreditBalance(tenantId)).toMatchObject({
      purchased: expectedMilli / MILLI,
      granted: 0,
      total: expectedMilli / MILLI,
    });
    expect(
      await db
        .select({
          tenantId: creditBalancesTable.tenantId,
          captionCredits: creditBalancesTable.captionCredits,
          imageCredits: creditBalancesTable.imageCredits,
          videoCredits: creditBalancesTable.videoCredits,
        })
        .from(creditBalancesTable)
        .where(eq(creditBalancesTable.tenantId, tenantId)),
    ).toEqual([legacy]);
    expect(await getLegacyConversionStatus(tenantId)).toMatchObject({
      pending: false,
    });

    // Replaying the same explicit plan is safe even if an operator retries a
    // partially completed batch: the stable migration key prevents a second
    // account grant.
    const second = await runCreditMigration(plan);
    expect(second.migrated).toEqual(plan);
    expect(second.totalCreditsGranted).toBe(expectedMilli / MILLI);
    expect((await getCreditBalance(tenantId)).total).toBe(
      expectedMilli / MILLI,
    );
    expect(
      (await db
        .select()
        .from(creditAccountLedgerTable)
        .where(eq(creditAccountLedgerTable.tenantId, tenantId)))
        .filter((row) => row.kind === "migrate"),
    ).toHaveLength(1);
  });
});
