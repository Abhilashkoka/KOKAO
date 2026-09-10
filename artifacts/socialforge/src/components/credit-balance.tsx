import { useGetCredits } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Coins } from "lucide-react";
import { Link } from "wouter";

/**
 * The credit balance, where people can see it.
 *
 * A prepaid balance nobody can see is a balance nobody spends confidently.
 * This sits in the header for the same reason a fuel gauge sits on a
 * dashboard: the number matters most in the moment just before you commit to
 * something, not on a settings page you have to go looking for.
 *
 * It renders nothing while the meter is off, so the chrome does not advertise
 * a currency the platform is not yet using.
 */
export function CreditBalancePill() {
  const { data, isLoading } = useGetCredits();

  if (isLoading || !data || data.mode === "off") return null;

  const total = data.total ?? 0;
  const low = total < 20;

  return (
    <Link href="/billing">
      <Badge
        variant={low ? "destructive" : "secondary"}
        className="cursor-pointer gap-1.5 font-normal"
        data-testid="badge-credit-balance"
        title={
          data.granted > 0 && data.grantedExpiresAt
            ? `${data.granted.toFixed(2)} of these expire on ${new Date(data.grantedExpiresAt).toLocaleDateString()}`
            : undefined
        }
      >
        <Coins className="h-3.5 w-3.5" />
        <span className="tabular-nums">{total.toFixed(total < 10 ? 1 : 0)}</span>
        <span className="text-xs opacity-80">credits</span>
      </Badge>
    </Link>
  );
}

export interface CreditQuoteLineView {
  rateKey: string;
  quantity: number;
  credits: number;
}

/**
 * The price of a generation, shown BEFORE the button that spends it.
 *
 * This is the piece that decides whether a prepaid model works at all. Without
 * it people ration: they stop generating because they cannot tell what
 * anything costs, and a workspace that stops generating churns within two
 * months. The itemised lines matter too — a four-scene video costs more in
 * keyframes than in clip seconds, and someone who can see that will pick
 * shorter jobs rather than quietly resenting the bill.
 */
export function CreditQuoteSummary({
  credits,
  balanceAfter,
  sufficient,
  lines,
}: {
  credits: number;
  balanceAfter: number;
  sufficient: boolean;
  lines?: CreditQuoteLineView[];
}) {
  return (
    <div
      className="space-y-2 rounded-md border border-border p-3 text-sm"
      data-testid="credit-quote-summary"
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium">This will cost</span>
        <span className="tabular-nums font-semibold" data-testid="text-quote-credits">
          {credits.toFixed(credits < 10 ? 1 : 0)} credits
        </span>
      </div>
      {lines && lines.length > 1 ? (
        <ul className="space-y-1 border-t border-border pt-2 text-xs text-muted-foreground">
          {lines.map((line) => (
            <li key={line.rateKey} className="flex justify-between gap-3">
              <span className="font-mono">{line.rateKey}</span>
              <span className="tabular-nums">
                {line.quantity.toFixed(line.quantity < 10 ? 1 : 0)} × ={" "}
                {line.credits.toFixed(2)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <p
        className={
          sufficient
            ? "border-t border-border pt-2 text-xs text-muted-foreground"
            : "border-t border-border pt-2 text-xs font-medium text-destructive"
        }
        data-testid="text-quote-balance-after"
      >
        {sufficient
          ? `You'll have ${balanceAfter.toFixed(balanceAfter < 10 ? 1 : 0)} credits left.`
          : "Not enough credits. Top up to continue."}
      </p>
    </div>
  );
}
