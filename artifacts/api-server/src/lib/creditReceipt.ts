import {
  db,
  creditAccountLedgerTable,
  videoGenerationsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { MILLI } from "./creditRates";

/**
 * What a video job was quoted, and what it actually charged.
 *
 * The quote is frozen on the job at enqueue (`options.creditQuote`). The
 * charge is read from the credit ledger, which the meter writes for every
 * provider call tagged with this job — retries and failed calls included —
 * and the refunds the failure paths write back. Showing both side by side is
 * the promise the quote makes: if a job costs more than it said, the user can
 * see exactly which line moved, instead of finding out from the balance.
 */

export interface CreditReceiptLine {
  rateKey: string;
  /** Credits spent on this rate, before refunds. */
  charged: number;
  /** Credits returned on this rate. */
  refunded: number;
}

export interface VideoJobCreditReceipt {
  jobId: number;
  /** Null for jobs enqueued before quotes were frozen on the job. */
  quoted: number | null;
  quotedLines: Array<{ rateKey: string; quantity: number; credits: number }>;
  /** Spent minus refunded. */
  net: number;
  charged: number;
  refunded: number;
  lines: CreditReceiptLine[];
  /**
   * (net - quoted) / quoted as a percentage, rounded to one decimal.
   * Null when there is no quote or nothing has been charged yet.
   */
  variancePercent: number | null;
}

function credits(milli: number): number {
  return Math.round(milli) / MILLI;
}

export class ReceiptNotFoundError extends Error {
  constructor() {
    super("Video job not found.");
    this.name = "ReceiptNotFoundError";
  }
}

export async function getVideoJobCreditReceipt(
  tenantId: number,
  jobId: number,
): Promise<VideoJobCreditReceipt> {
  if (!Number.isSafeInteger(jobId) || jobId <= 0) throw new ReceiptNotFoundError();
  const [job] = await db
    .select({ id: videoGenerationsTable.id, options: videoGenerationsTable.options })
    .from(videoGenerationsTable)
    .where(
      and(
        eq(videoGenerationsTable.id, jobId),
        eq(videoGenerationsTable.tenantId, tenantId),
      ),
    )
    .limit(1);
  if (!job) throw new ReceiptNotFoundError();

  const rows = await db
    .select({
      kind: creditAccountLedgerTable.kind,
      rateKey: creditAccountLedgerTable.rateKey,
      purchasedDeltaMilli: creditAccountLedgerTable.purchasedDeltaMilli,
      grantedDeltaMilli: creditAccountLedgerTable.grantedDeltaMilli,
    })
    .from(creditAccountLedgerTable)
    .where(
      and(
        eq(creditAccountLedgerTable.tenantId, tenantId),
        eq(creditAccountLedgerTable.refKind, "videoJob"),
        eq(creditAccountLedgerTable.refId, String(job.id)),
        inArray(creditAccountLedgerTable.kind, ["spend", "refund"]),
      ),
    );

  return buildVideoJobCreditReceipt(job.id, job.options?.creditQuote ?? null, rows);
}

/** Pure part, so the arithmetic is testable without a database. */
export function buildVideoJobCreditReceipt(
  jobId: number,
  quote: { credits: number; lines: Array<{ rateKey: string; quantity: number; credits: number }> } | null,
  rows: Array<{
    kind: string;
    rateKey: string | null;
    purchasedDeltaMilli: number;
    grantedDeltaMilli: number;
  }>,
): VideoJobCreditReceipt {
  const byKey = new Map<string, { chargedMilli: number; refundedMilli: number }>();
  for (const row of rows) {
    const key = row.rateKey ?? "other";
    const entry = byKey.get(key) ?? { chargedMilli: 0, refundedMilli: 0 };
    const delta = row.purchasedDeltaMilli + row.grantedDeltaMilli;
    if (row.kind === "spend") entry.chargedMilli += Math.max(0, -delta);
    else if (row.kind === "refund") entry.refundedMilli += Math.max(0, delta);
    byKey.set(key, entry);
  }
  const lines = [...byKey.entries()]
    .map(([rateKey, v]) => ({
      rateKey,
      charged: credits(v.chargedMilli),
      refunded: credits(v.refundedMilli),
    }))
    .sort((a, b) => b.charged - a.charged || a.rateKey.localeCompare(b.rateKey));
  const chargedMilli = [...byKey.values()].reduce((t, v) => t + v.chargedMilli, 0);
  const refundedMilli = [...byKey.values()].reduce((t, v) => t + v.refundedMilli, 0);
  const net = credits(chargedMilli - refundedMilli);
  const quoted = quote && Number.isFinite(quote.credits) ? quote.credits : null;
  const variancePercent =
    quoted !== null && quoted > 0 && chargedMilli > 0
      ? Math.round(((net - quoted) / quoted) * 1000) / 10
      : null;
  return {
    jobId,
    quoted,
    quotedLines: quote?.lines ?? [],
    net,
    charged: credits(chargedMilli),
    refunded: credits(refundedMilli),
    lines,
    variancePercent,
  };
}
