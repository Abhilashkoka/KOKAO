/**
 * Read-only targeted reconciliation report for the two legacy reserve-only
 * development jobs. This script intentionally has no apply mode: financial
 * writes require a separately reviewed and authorized operation.
 *
 * Run from the api-server package:
 *   pnpm exec tsx scripts/inspect-targeted-video-wallet-reconciliation.ts
 *
 * The output contains provider-event metadata and wallet amounts only. It
 * deliberately omits prompts, narration, object paths, and provider media
 * URLs.
 */

import { db, pool, walletBalancesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  inspectVideoJobWalletReconciliation,
  type VideoJobWalletReconciliationPlan,
} from "../src/lib/wallet";

const TARGET_JOB_IDS = [69717, 69772] as const;

function rupees(paise: number | null): string | null {
  return paise === null ? null : (paise / 100).toFixed(2);
}

function summarize(plan: VideoJobWalletReconciliationPlan) {
  return {
    jobId: plan.jobId,
    tenantId: plan.tenantId,
    chainId: plan.chainId,
    chainJobIds: plan.jobIds,
    jobLifecycle: plan.jobLifecycle,
    feePercent: plan.feePercent,
    feeSource: plan.feeSource,
    eventCount: plan.eventCount,
    eventProof: plan.eventProofs.map((event) => ({
      identity: event.identity,
      provider: event.provider,
      model: event.model,
      label: event.label,
      durationSec: event.durationSec,
      savedRawCostPaise: event.savedRawCostPaise,
      savedRawCostInr: rupees(event.savedRawCostPaise),
      catalogRepricedCostPaise: event.catalogRepricedCostPaise,
      catalogRepricedCostInr: rupees(event.catalogRepricedCostPaise),
      costSource: event.costSource,
      accountedCheckpoint: event.accounted,
    })),
    rawProviderCostPaise: plan.rawProviderCostPaise,
    rawProviderCostInr: rupees(plan.rawProviderCostPaise),
    repricedProviderCostPaise: plan.repricedProviderCostPaise,
    repricedProviderCostInr: rupees(plan.repricedProviderCostPaise),
    targetChargePaise: plan.targetChargePaise,
    targetChargeInr: rupees(plan.targetChargePaise),
    currentlyChargedPaise: plan.currentlyChargedPaise,
    currentlyChargedInr: rupees(plan.currentlyChargedPaise),
    currentJobSpendPaise: plan.currentJobSpendPaise,
    currentJobSpendInr: rupees(plan.currentJobSpendPaise),
    proposedJobSpendPaise: plan.proposedJobSpendPaise,
    proposedJobSpendInr: rupees(plan.proposedJobSpendPaise),
    proposedJobSpendDeltaPaise: plan.proposedJobSpendDeltaPaise,
    proposedJobSpendDeltaInr: rupees(plan.proposedJobSpendDeltaPaise),
    reservations: plan.reservationPlans.map((reservation) => ({
      reservationId: reservation.reservationId,
      reserveAmountPaise: reservation.reserveAmountPaise,
      reserveAmountInr: rupees(-reservation.reserveAmountPaise),
      currentNetPaise: reservation.currentNetPaise,
      currentNetInr: rupees(reservation.currentNetPaise),
      openHold: reservation.openHold,
      lifecycle: reservation.lifecycle.map((row) => ({
        id: row.id,
        kind: row.kind,
        amountPaise: row.amountPaise,
        reservationId: row.reservationId,
        usageKind: row.usageKind,
        refKind: row.refKind,
        refId: row.refId,
        provider: row.provider,
        model: row.model,
        providerCostPaise: row.providerCostPaise,
        estimated: row.estimated,
      })),
      proposedTargetChargePaise: reservation.proposedTargetChargePaise,
      proposedSettleDeltaPaise: reservation.proposedSettleDeltaPaise,
      proposedSettleDeltaInr: rupees(reservation.proposedSettleDeltaPaise),
    })),
    proposedLedgerChanges: plan.proposedLedgerChanges.map((change) => ({
      ...change,
      amountInr: rupees(change.amountPaise),
      targetChargeInr: rupees(change.targetChargePaise),
    })),
    readyForExplicitApproval: plan.readyForExplicitApproval,
    blockers: plan.blockers,
    warnings: plan.warnings,
  };
}

async function main(): Promise<void> {
  if (process.argv.slice(2).length > 0) {
    throw new Error(
      "This report is fixed to jobs 69717 and 69772 and accepts no write or override flags",
    );
  }
  const plans = [];
  for (const jobId of TARGET_JOB_IDS) {
    plans.push(summarize(await inspectVideoJobWalletReconciliation(jobId)));
  }
  const [balance] = await db
    .select({ balancePaise: walletBalancesTable.balancePaise })
    .from(walletBalancesTable)
    .where(eq(walletBalancesTable.tenantId, 4))
    .limit(1);
  const proposedNetDeltaPaise = plans
    .flatMap((plan) => plan.proposedLedgerChanges)
    .reduce((sum, change) => sum + change.amountPaise, 0);
  console.log(JSON.stringify({
    readOnly: true,
    tenantId: 4,
    targetJobIds: TARGET_JOB_IDS,
    projectionStatus: "NON_ACTIONABLE_INFERRED_FEE_REQUIRES_APPROVAL",
    walletBalanceBeforePaise: balance?.balancePaise ?? null,
    walletBalanceBeforeInr: rupees(balance?.balancePaise ?? null),
    proposedNetDeltaPaise,
    proposedNetDeltaInr: rupees(proposedNetDeltaPaise),
    projectedWalletBalanceAfterPaise:
      balance?.balancePaise == null ? null : balance.balancePaise + proposedNetDeltaPaise,
    projectedWalletBalanceAfterInr:
      balance?.balancePaise == null
        ? null
        : rupees(balance.balancePaise + proposedNetDeltaPaise),
    plans,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => pool.end());