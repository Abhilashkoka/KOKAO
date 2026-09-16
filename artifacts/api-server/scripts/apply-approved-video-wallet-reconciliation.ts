/**
 * Guarded development-tenant execution path. Do not run without main-agent
 * review of the read-only provenance report and explicit authorization.
 *
 *   pnpm exec tsx scripts/apply-approved-video-wallet-reconciliation.ts \
 *     --confirm-tenant4-reviewed-targets
 */

import { pool } from "@workspace/db";
import { reconcileApprovedVideoWalletBatch } from "../src/lib/wallet";

const APPROVED_ARGS = {
  tenantId: 4,
  expectedFeePercent: 20,
  expectedAdditionalDebitPaise: 257334,
  approvalContext: "tenant4-jobs69717-69772-saved-costs-fee20",
  targets: [
    {
      jobId: 69717,
      expectedTargetChargePaise: 213049,
      expectedCurrentlyChargedPaise: 0,
      expectedCurrentJobSpendPaise: 213049,
    },
    {
      jobId: 69772,
      expectedTargetChargePaise: 254285,
      expectedCurrentlyChargedPaise: 0,
      expectedCurrentJobSpendPaise: 54980,
    },
  ],
} as const;

async function main(): Promise<void> {
  if (
    process.argv.length !== 3 ||
    process.argv[2] !== "--confirm-tenant4-reviewed-targets"
  ) {
    throw new Error(
      "Refusing targeted wallet writes; main review and the exact confirmation flag are required",
    );
  }
  const result = await reconcileApprovedVideoWalletBatch(APPROVED_ARGS);
  console.log(JSON.stringify({ readOnly: false, ...result }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => pool.end());