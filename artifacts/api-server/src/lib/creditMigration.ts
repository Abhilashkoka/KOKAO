import {
  db,
  tenantsTable,
  creditBalancesTable,
  walletBalancesTable,
  planSettingsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { grantCredits, hasCreditAccount } from "./creditAccounts";
import { creditsMilliFor, MILLI } from "./creditRates";

/**
 * One-time conversion of every existing workspace onto the credit balance.
 *
 * Three legacy rails have to land in one place:
 *
 *   quota   — a monthly allowance that was COUNTED, never held. There is no
 *             stored balance to convert, so the workspace is granted its
 *             plan's allowance for the current period.
 *   credit  — three separate buckets of whole generations (caption / image /
 *             video). Each bucket is converted at what that generation costs
 *             on the new rate card, so someone holding 5 video credits gets
 *             the credits 5 videos would now cost.
 *   wallet  — a rupee balance. Converted at the platform credit price.
 *
 * Two rules throughout, both in the customer's favour:
 *
 *   - Conversion ROUNDS UP. A rounding decision against someone who already
 *     paid is not a rounding decision, it is a small theft repeated across
 *     the whole customer base.
 *   - Converted credits land in the PURCHASED bucket and never expire. These
 *     people bought something under different terms; attaching a new deadline
 *     to it after the fact would be changing the deal.
 *
 * Idempotent by construction: a workspace that already has a credit account
 * is skipped, so a partial run can simply be run again.
 */

export interface MigrationPlanRow {
  tenantId: number;
  plan: string;
  source: "quota" | "credit" | "wallet";
  /** What the workspace held before, for the audit trail. */
  detail: string;
  credits: number;
}

export interface MigrationResult {
  migrated: MigrationPlanRow[];
  skipped: number;
  totalCreditsGranted: number;
}

/** The default credit price in paise, for converting a rupee wallet. */
export const DEFAULT_CREDIT_PRICE_PAISE = Number(
  process.env.CREDIT_PRICE_PAISE ?? 4500,
);

function roundUpCredits(milli: number): number {
  return Math.ceil(milli / MILLI);
}

/**
 * Work out what each workspace should receive WITHOUT writing anything.
 *
 * Always run this first. A migration that grants the wrong amount is far
 * harder to unwind than one that was checked on paper, and the totals here are
 * exactly what will be granted.
 */
export async function planCreditMigration(): Promise<MigrationPlanRow[]> {
  const tenants = await db
    .select({ id: tenantsTable.id, plan: tenantsTable.plan, billingMode: tenantsTable.billingMode })
    .from(tenantsTable);

  const [captionMilli, imageMilli, videoMilli] = await Promise.all([
    creditsMilliFor("caption", 1),
    creditsMilliFor("image", 1),
    // A video "credit" was one generation; price it as one short clip.
    creditsMilliFor("video", 10),
  ]);

  const rows: MigrationPlanRow[] = [];
  for (const tenant of tenants) {
    if (await hasCreditAccount(tenant.id)) continue;

    if (tenant.billingMode === "wallet") {
      const [wallet] = await db
        .select()
        .from(walletBalancesTable)
        .where(eq(walletBalancesTable.tenantId, tenant.id))
        .limit(1);
      const paise = wallet?.balancePaise ?? 0;
      if (paise <= 0) continue;
      rows.push({
        tenantId: tenant.id,
        plan: tenant.plan,
        source: "wallet",
        detail: `₹${(paise / 100).toFixed(2)} wallet balance`,
        credits: Math.ceil(paise / DEFAULT_CREDIT_PRICE_PAISE),
      });
      continue;
    }

    const [legacy] = await db
      .select()
      .from(creditBalancesTable)
      .where(eq(creditBalancesTable.tenantId, tenant.id))
      .limit(1);
    const held =
      (legacy?.captionCredits ?? 0) +
      (legacy?.imageCredits ?? 0) +
      (legacy?.videoCredits ?? 0);

    if (held > 0) {
      const milli =
        (legacy?.captionCredits ?? 0) * (captionMilli ?? 0) +
        (legacy?.imageCredits ?? 0) * (imageMilli ?? 0) +
        (legacy?.videoCredits ?? 0) * (videoMilli ?? 0);
      rows.push({
        tenantId: tenant.id,
        plan: tenant.plan,
        source: "credit",
        detail: `${legacy?.captionCredits ?? 0} caption / ${legacy?.imageCredits ?? 0} image / ${legacy?.videoCredits ?? 0} video credits`,
        credits: Math.max(1, roundUpCredits(milli)),
      });
      continue;
    }

    // Quota workspaces hold nothing; they receive this period's allowance so
    // a plan they already paid for keeps working the moment the switch flips.
    const [planRow] = await db
      .select({ monthlyCredits: planSettingsTable.monthlyCredits })
      .from(planSettingsTable)
      .where(eq(planSettingsTable.id, tenant.plan))
      .limit(1);
    const allowance = Math.max(0, planRow?.monthlyCredits ?? 0);
    if (allowance <= 0) continue;
    rows.push({
      tenantId: tenant.id,
      plan: tenant.plan,
      source: "quota",
      detail: `${tenant.plan} plan allowance`,
      credits: allowance,
    });
  }
  return rows;
}

/**
 * Apply the plan. Each grant carries an idempotency key, so re-running after a
 * partial failure grants nobody twice.
 */
export async function runCreditMigration(
  plan?: MigrationPlanRow[],
): Promise<MigrationResult> {
  const rows = plan ?? (await planCreditMigration());
  let granted = 0;
  const migrated: MigrationPlanRow[] = [];

  for (const row of rows) {
    try {
      await grantCredits({
        tenantId: row.tenantId,
        credits: row.credits,
        kind: "migrate",
        idempotencyKey: `migrate:${row.tenantId}`,
        note: `Converted from ${row.detail}`,
      });
      granted += row.credits;
      migrated.push(row);
    } catch (err) {
      logger.error(
        { err, tenantId: row.tenantId },
        "Credit migration failed for one workspace; others continue",
      );
    }
  }

  return {
    migrated,
    skipped: rows.length - migrated.length,
    totalCreditsGranted: granted,
  };
}
