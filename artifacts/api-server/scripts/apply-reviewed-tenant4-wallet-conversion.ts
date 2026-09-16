/**
 * Guarded, one-time tenant-4 conversion. The reviewed estimated-charge rows
 * remain pending and are retained as auditable liabilities; this exception
 * only permits conversion of the already reviewed wallet balance.
 *
 * Do not run without main-agent review:
 *
 *   pnpm exec tsx scripts/apply-reviewed-tenant4-wallet-conversion.ts \
 *     --confirm-reviewed-tenant4-trueups
 */

import {
  db,
  creditMeterSettingsTable,
  pool,
  walletBalancesTable,
  walletLedgerTable,
} from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { convertWalletToCreditsForReviewedInternalUse } from "../src/lib/walletConversion";

const TENANT_ID = 4;
const APPROVED_WALLET_PAISE = 252_227;
const APPROVED_CREDIT_PRICE_PAISE = 2_000;
const APPROVAL_AUTHORIZATION = "tenant4-wallet-conversion-reviewed-trueups-v1";
const IDEMPOTENCY_KEY = "tenant4-wallet-conversion-reviewed-trueups-v1";
const APPROVED_TRUE_UP_LEDGER_IDS = [
  4_251, 4_253, 4_254, 4_256, 4_258, 4_362, 4_474, 5_334, 5_660, 5_662,
  5_664, 5_666, 5_668, 5_672, 5_674, 7_056, 7_057, 7_058, 9_076, 9_824,
  9_826, 9_828, 9_830, 9_832, 9_834, 9_836, 9_838, 9_840, 14_183, 16_131,
].sort((a, b) => a - b);

function sameIds(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

async function main(): Promise<void> {
  if (
    process.argv.length !== 3 ||
    process.argv[2] !== "--confirm-reviewed-tenant4-trueups"
  ) {
    throw new Error(
      "Refusing reviewed tenant-4 wallet conversion; exact confirmation flag required",
    );
  }

  const [wallet, rateRow, pendingRows] = await Promise.all([
    db
      .select({ balancePaise: walletBalancesTable.balancePaise })
      .from(walletBalancesTable)
      .where(eq(walletBalancesTable.tenantId, TENANT_ID))
      .limit(1),
    db
      .select({ creditPricePaise: creditMeterSettingsTable.creditPricePaise })
      .from(creditMeterSettingsTable)
      .where(eq(creditMeterSettingsTable.id, 1))
      .limit(1),
    db
      .select({
        id: walletLedgerTable.id,
        kind: walletLedgerTable.kind,
        estimated: walletLedgerTable.estimated,
        trueUpAt: walletLedgerTable.trueUpAt,
      })
      .from(walletLedgerTable)
      .where(
        and(
          eq(walletLedgerTable.tenantId, TENANT_ID),
          eq(walletLedgerTable.estimated, true),
          isNull(walletLedgerTable.trueUpAt),
        ),
      ),
  ]);
  const walletPaise = Number(wallet[0]?.balancePaise ?? 0);
  const creditPricePaise = Number(rateRow[0]?.creditPricePaise ?? 0);
  const pendingIds = pendingRows.map((row) => row.id).sort((a, b) => a - b);
  if (
    walletPaise !== APPROVED_WALLET_PAISE ||
    creditPricePaise !== APPROVED_CREDIT_PRICE_PAISE ||
    !sameIds(pendingIds, APPROVED_TRUE_UP_LEDGER_IDS) ||
    pendingRows.some(
      (row) => row.kind !== "settle" || row.estimated !== true || row.trueUpAt !== null,
    )
  ) {
    throw new Error(
      "Read-only tenant-4 review snapshot changed; refusing conversion",
    );
  }

  const result = await convertWalletToCreditsForReviewedInternalUse(
    {
      tenantId: TENANT_ID,
      expectedWalletPaise: walletPaise,
      expectedCreditPricePaise: creditPricePaise,
      idempotencyKey: IDEMPOTENCY_KEY,
    },
    {
      estimatedTrueUpLedgerIds: APPROVED_TRUE_UP_LEDGER_IDS,
      authorization: APPROVAL_AUTHORIZATION,
    },
  );
  console.log(JSON.stringify({ readOnly: false, ...result }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => pool.end());