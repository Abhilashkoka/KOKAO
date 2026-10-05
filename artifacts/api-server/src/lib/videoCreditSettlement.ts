import { db, creditAccountLedgerTable, videoGenerationsTable, type CreditAccountLedgerEntry, type VideoGeneration } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { CREDIT_METER_REFUND_PENDING_KIND, lockVideoCreditSettlement, refundCredits, spendCreditsOnce, type SpendCreditsInput } from "./creditAccounts";
import { operationLedgerIdentities, rowMatchesIdentities, type DeliveryItem } from "./videoCreditSpend";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Movement = SpendCreditsInput & { action: "spend" | "refund" };
const delta = (row: CreditAccountLedgerEntry) => row.purchasedDeltaMilli + row.grantedDeltaMilli;

/**
 * Delivered checkpoints, not all ancestor work, determine retry liability.
 * Reuse the signed original debit (its saved rate), never today's rate card.
 * Delivery recharges have a source-receipt key shared by every descendant.
 */
export function planVideoCreditSettlement(
  job: VideoGeneration,
  items: readonly DeliveryItem[] | null,
  ledger: readonly CreditAccountLedgerEntry[],
): Movement[] {
  const rows = ledger.filter(row => row.tenantId === job.tenantId);
  const moves: Movement[] = [];
  const retained = new Set<number>();
  const spends = rows.filter(row => row.kind === "spend" && delta(row) <= 0 && row.idempotencyKey);
  const netFor = (spend: CreditAccountLedgerEntry) => {
    const refundKey = spend.idempotencyKey!.replace(/^spend/, "refund");
    const refunded = rows.filter(row =>
      row.kind === "refund" &&
      (row.idempotencyKey === refundKey || row.idempotencyKey === `${refundKey}:video-terminal`)
    ).reduce((sum, row) => sum + delta(row), 0);
    const pending = rows.filter(row =>
      row.kind === CREDIT_METER_REFUND_PENDING_KIND &&
      (row.idempotencyKey === `${refundKey}:pending` ||
        row.idempotencyKey === `${refundKey}:video-terminal:pending`) &&
      !rows.some(applied => applied.kind === "refund" &&
        applied.idempotencyKey === row.idempotencyKey!.slice(0, -":pending".length))
    );
    if (pending.length) throw new Error("Video credit refund is still pending; settle it before delivery reconciliation");
    return -delta(spend) - refunded;
  };
  for (const item of items ?? []) {
    if (item.independentlySettled || item.unmetered || item.providerReservationId != null) continue;
    const identities = operationLedgerIdentities(job, item.operationIdentity);
    const matches = spends.filter(row => rowMatchesIdentities(row, identities));
    // Other independently metered media retain their existing settlement path.
    const video = matches.filter(row => row.rateKey === "video" || row.rateKey === "video_hd");
    if (!video.length) {
      if (item.kind === "video_event" && item.operationIdentity.includes(":storyboard_scene:")) {
        throw new Error(`Delivered video scene has no saved credit debit: ${item.operationIdentity}`);
      }
      continue;
    }
    const original = video.filter(row => !row.idempotencyKey!.endsWith(":delivery"))
      .filter(row => !rows.some(marker =>
        marker.kind === "meter_dispatch_failed" &&
        marker.idempotencyKey === `${row.idempotencyKey}:dispatch:failed`))
      .sort((a, b) => b.id - a.id)[0]!;
    if (!original) throw new Error("Delivered scene only has failed provider debit receipts");
    retained.add(original.id);
    if (delta(original) === 0) continue;
    const deliveryKey = `${original.idempotencyKey}:delivery`;
    const delivery = rows.find(row => row.idempotencyKey === deliveryKey);
    if (delivery) retained.add(delivery.id);
    const charged = netFor(original) + (delivery ? netFor(delivery) : 0);
    if (delivery && charged <= 0) throw new Error("Delivered inherited receipt was already refunded; manual reconciliation required");
    if (charged > 0) continue;
    moves.push({
      action: "spend",
      tenantId: job.tenantId,
      creditsMilli: -delta(original),
      rateKey: original.rateKey,
      refKind: "videoJob",
      refId: String(job.id),
      idempotencyKey: deliveryKey,
      note: `Delivered inherited video receipt ${original.id}; original saved credit amount`,
    });
  }
  for (const spend of spends) {
    if (spend.refKind !== "videoJob" || spend.refId !== String(job.id) || retained.has(spend.id)) continue;
    // On success only discard unused video attempts. On failure refund all
    // job-owned work; accepted inputs have their own refs and stay untouched.
    if (items && spend.rateKey !== "video" && spend.rateKey !== "video_hd") continue;
    const amount = netFor(spend);
    if (amount <= 0) continue;
    moves.push({
      action: "refund", tenantId: job.tenantId, creditsMilli: amount,
      rateKey: spend.rateKey, refKind: "videoJob", refId: String(job.id),
      idempotencyKey: `${spend.idempotencyKey!.replace(/^spend/, "refund")}:video-terminal`,
      note: items ? "Video attempt not included in delivered checkpoints" : "Video failed without delivery",
    });
  }
  return moves;
}

export async function settleVideoCredits(
  tx: Transaction,
  job: VideoGeneration,
  items: readonly DeliveryItem[] | null,
): Promise<void> {
  if (job.funding !== "credits" || !job.options?.guidedStory) return;
  await lockVideoCreditSettlement(tx, job.tenantId);
  const ledger = await tx.select().from(creditAccountLedgerTable)
    .where(eq(creditAccountLedgerTable.tenantId, job.tenantId));
  const plan = planVideoCreditSettlement(job, items, ledger);
  // Refund discarded work before collecting a previously refunded artifact.
  for (const move of plan.filter(move => move.action === "refund")) await refundCredits(move, tx);
  for (const move of plan.filter(move => move.action === "spend")) await spendCreditsOnce(move, tx);
}

export async function refundFailedGuidedVideoCredits(jobId: number): Promise<void> {
  await db.transaction(async tx => {
    const [job] = await tx.select().from(videoGenerationsTable)
      .where(and(eq(videoGenerationsTable.id, jobId), eq(videoGenerationsTable.status, "failed")))
      .for("update");
    if (job) await settleVideoCredits(tx, job, null);
  });
}
