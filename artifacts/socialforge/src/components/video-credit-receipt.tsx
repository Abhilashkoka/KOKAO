import {
  getGetVideoJobCreditReceiptQueryKey,
  useGetVideoJobCreditReceipt,
} from "@workspace/api-client-react";
import { creditRateLabel, useCreditFunding } from "@/components/credit-balance";

function fmt(credits: number): string {
  return credits.toFixed(credits < 10 ? 1 : 0);
}

/**
 * Quoted vs charged, for one finished video.
 *
 * The quote shown before Generate is a promise; this is where it is kept or
 * visibly not kept. A retried scene or a longer final clip shows up as its own
 * line, so "why did this cost more?" has an answer on the same screen.
 */
export function VideoCreditReceipt({ jobId }: { jobId: number }) {
  const { creditFunded } = useCreditFunding();
  const { data: receipt } = useGetVideoJobCreditReceipt(jobId, {
    query: {
      queryKey: getGetVideoJobCreditReceiptQueryKey(jobId),
      enabled: creditFunded && jobId > 0,
      staleTime: 30_000,
    },
  });
  if (!creditFunded || !receipt || (receipt.quoted === null && receipt.charged === 0)) {
    return null;
  }
  const over =
    receipt.variancePercent !== null && receipt.variancePercent > 0
      ? receipt.variancePercent
      : null;
  return (
    <details
      className="rounded-md border border-border p-3 text-xs text-muted-foreground"
      data-testid="video-credit-receipt"
    >
      <summary className="cursor-pointer select-none">
        {receipt.quoted !== null && (
          <>
            Quoted{" "}
            <span className="tabular-nums" data-testid="text-receipt-quoted">
              {fmt(receipt.quoted)}
            </span>
            {" · "}
          </>
        )}
        Charged{" "}
        <span className="tabular-nums font-medium text-foreground" data-testid="text-receipt-net">
          {fmt(receipt.net)}
        </span>{" "}
        credits
        {receipt.refunded > 0 && (
          <span data-testid="text-receipt-refunded">
            {" "}(after {fmt(receipt.refunded)} refunded)
          </span>
        )}
        {over !== null && over >= 15 && (
          <span className="text-amber-700 dark:text-amber-300">
            {" "}· {over}% above quote
          </span>
        )}
      </summary>
      {receipt.lines.length > 0 && (
        <ul className="mt-2 space-y-1 border-t border-border pt-2">
          {receipt.lines.map((line) => (
            <li key={line.rateKey} className="flex justify-between gap-3">
              <span>{creditRateLabel(line.rateKey)}</span>
              <span className="tabular-nums">
                {fmt(line.charged)}
                {line.refunded > 0 ? ` − ${fmt(line.refunded)} refunded` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2">
        Failed steps are refunded automatically. Retries the system needed are
        listed on their own lines.
      </p>
    </details>
  );
}
