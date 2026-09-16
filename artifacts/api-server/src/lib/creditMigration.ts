import {
  db,
  tenantsTable,
  creditBalancesTable,
  creditAccountLedgerTable,
  walletBalancesTable,
  planSettingsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { grantCredits, hasMigrationReceipt } from "./creditAccounts";
import {
  creditsMilliFor,
  getCreditPricePaise,
  DEFAULT_CREDIT_PRICE_PAISE,
  MILLI,
} from "./creditRates";

// Preserve the migration module's historical public constant for callers and
// tests; the actual conversion now reads the persisted setting above.
export { DEFAULT_CREDIT_PRICE_PAISE };

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
 *   wallet  — intentionally excluded here. A rupee balance must use the
 *              per-workspace wallet-conversion transaction so retirement and
 *              purchased-credit issuance cannot diverge.
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
 * Idempotent by construction: only a workspace with an explicit migration
 * receipt is skipped. Merely opening the new wallet or earning a reward does
 * not waive a customer's untouched legacy balance.
 */

export interface MigrationPlanRow {
  tenantId: number;
  plan: string;
  source: "quota" | "credit" | "wallet";
  /** What the workspace held before, for the audit trail. */
  detail: string;
  credits: number;
}

export interface WalletMigrationSkip {
  tenantId: number;
  plan: string;
  detail: string;
  reason: string;
}

export interface MigrationResult {
  migrated: MigrationPlanRow[];
  skipped: number;
  totalCreditsGranted: number;
}

export interface LegacyConversionStatus {
  /** True until an administrator explicitly approves and runs migration. */
  pending: boolean;
  captionCredits: number;
  imageCredits: number;
  videoCredits: number;
}

/**
 * Read-only disclosure for customers and admins. This deliberately never
 * creates an account and never changes the legacy row: earning a new reward
 * must not hide or waive value held on the old rail.
 */
export async function getLegacyConversionStatus(
  tenantId: number,
): Promise<LegacyConversionStatus> {
  const [legacy] = await db
    .select()
    .from(creditBalancesTable)
    .where(eq(creditBalancesTable.tenantId, tenantId))
    .limit(1);
  return {
    pending: !(await hasMigrationReceipt(tenantId)),
    captionCredits: legacy?.captionCredits ?? 0,
    imageCredits: legacy?.imageCredits ?? 0,
    videoCredits: legacy?.videoCredits ?? 0,
  };
}

/**
 * Batched read-only conversion disclosure for the admin workspace table.
 * Unlike the detail endpoint, this must not perform one legacy/migration query
 * per workspace.
 */
export async function getLegacyConversionStatusesByTenant(): Promise<
  Map<number, LegacyConversionStatus>
> {
  const [legacyRows, migrationRows] = await Promise.all([
    db.select().from(creditBalancesTable),
    db
      .select({ tenantId: creditAccountLedgerTable.tenantId })
      .from(creditAccountLedgerTable)
      .where(eq(creditAccountLedgerTable.kind, "migrate")),
  ]);
  const migrated = new Set(migrationRows.map((row) => row.tenantId));
  const statuses = new Map<number, LegacyConversionStatus>();
  for (const legacy of legacyRows) {
    statuses.set(legacy.tenantId, {
      pending: !migrated.has(legacy.tenantId),
      captionCredits: legacy.captionCredits ?? 0,
      imageCredits: legacy.imageCredits ?? 0,
      videoCredits: legacy.videoCredits ?? 0,
    });
  }
  for (const tenantId of migrated) {
    if (!statuses.has(tenantId)) {
      statuses.set(tenantId, {
        pending: false,
        captionCredits: 0,
        imageCredits: 0,
        videoCredits: 0,
      });
    }
  }
  return statuses;
}

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
    .select({
      id: tenantsTable.id,
      plan: tenantsTable.plan,
      billingMode: tenantsTable.billingMode,
    })
    .from(tenantsTable);

  const [captionMilli, imageMilli, videoMilli, creditPricePaise] = await Promise.all([
    creditsMilliFor("caption", 1),
    creditsMilliFor("image", 1),
    // A video "credit" was one generation; price it as one short clip.
    creditsMilliFor("video", 10),
    getCreditPricePaise(),
  ]);

  const rows: MigrationPlanRow[] = [];
  for (const tenant of tenants) {
    if (await hasMigrationReceipt(tenant.id)) continue;

    // A broad migration cannot safely retire a live wallet balance. Wallet
    // value must go through the per-workspace wallet-conversion transaction,
    // which records both sides atomically. Keep this preview free of wallet
    // rows so the batch POST can never grant wallet value without debiting it.
    if (tenant.billingMode === "wallet") continue;

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
 * Wallet balances are intentionally surfaced separately from the broad
 * migration rows. This makes the admin preview explicit about skipped work
 * and points the operator at the only safe per-workspace action.
 */
export async function listWalletMigrationSkips(): Promise<WalletMigrationSkip[]> {
  const tenants = await db
    .select({
      id: tenantsTable.id,
      plan: tenantsTable.plan,
      billingMode: tenantsTable.billingMode,
    })
    .from(tenantsTable);
  const skipped: WalletMigrationSkip[] = [];
  for (const tenant of tenants) {
    if (tenant.billingMode !== "wallet" || await hasMigrationReceipt(tenant.id)) {
      continue;
    }
    const [wallet] = await db
      .select()
      .from(walletBalancesTable)
      .where(eq(walletBalancesTable.tenantId, tenant.id))
      .limit(1);
    const paise = wallet?.balancePaise ?? 0;
    if (paise <= 0) continue;
    skipped.push({
      tenantId: tenant.id,
      plan: tenant.plan,
      detail: `₹${(paise / 100).toFixed(2)} wallet balance`,
      reason:
        "Skipped: broad wallet migration is disabled. Use this workspace's wallet Adjust conversion after review.",
    });
  }
  return skipped;
}

export async function planCreditMigrationPreview(): Promise<{
  rows: MigrationPlanRow[];
  skippedWallets: WalletMigrationSkip[];
}> {
  const [rows, skippedWallets] = await Promise.all([
    planCreditMigration(),
    listWalletMigrationSkips(),
  ]);
  return { rows, skippedWallets };
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
    // Reject manually supplied legacy wallet rows too. Older callers could
    // pass an explicit plan even after the read-only planner stopped emitting
    // wallet work; neither path may grant wallet value without retirement.
    if (row.source === "wallet") {
      logger.warn(
        { tenantId: row.tenantId },
        "Skipping unsafe broad wallet migration; use per-workspace wallet conversion",
      );
      continue;
    }
    try {
      await db.transaction(async (tx) => {
        // The tenant row is the broad-migration gate. Wallet conversion takes
        // this same lock after locking its wallet, then rechecks migration
        // receipts before granting or converting anything.
        const [tenant] = await tx
          .select({ id: tenantsTable.id })
          .from(tenantsTable)
          .where(eq(tenantsTable.id, row.tenantId))
          .for("update")
          .limit(1);
        if (!tenant) throw new Error("Tenant disappeared during credit migration");
        await grantCredits(
          {
            tenantId: row.tenantId,
            credits: row.credits,
            kind: "migrate",
            idempotencyKey: `migrate:${row.tenantId}`,
            note: `Converted from ${row.detail}`,
          },
          tx,
        );
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
