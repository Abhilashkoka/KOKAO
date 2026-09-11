import { useGetCredits } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Coins } from "lucide-react";
import { Link } from "wouter";

/**
 * Is this workspace actually spending credits right now?
 *
 * Two things have to be true, and keeping both in one place is the point:
 * the workspace is on the credits rail, AND the meter is enforcing. A plan
 * can be moved onto credits during shadow mode without anything changing for
 * the people on it, so the UI must not start showing a credit balance as the
 * thing that governs their work until it actually does. It also means the
 * whole user-facing switch — credit meters instead of quota meters — flips
 * back with the same dropdown that rolls the billing back.
 */
export function useCreditFunding() {
  const { data: credits, isLoading } = useGetCredits();
  return {
    creditFunded: Boolean(credits?.funded),
    credits,
    isLoading,
  };
}

/**
 * The credit balance as a usage panel, for the places that used to show one
 * progress bar per quota.
 *
 * A quota meter answers "how many captions are left", which is the wrong
 * question once one balance funds everything — the honest answer is a single
 * number plus what is about to expire. Showing three bars that all move
 * together would be theatre.
 */
export function CreditUsageCard() {
  const { credits } = useCreditFunding();
  const total = credits?.total ?? 0;
  const granted = credits?.granted ?? 0;
  const purchased = credits?.purchased ?? 0;
  const expiring = granted > 0 && credits?.grantedExpiresAt;
  const legacy = credits?.legacyConversion;
  const legacyTotal =
    (legacy?.captionCredits ?? 0) +
    (legacy?.imageCredits ?? 0) +
    (legacy?.videoCredits ?? 0);

  return (
    <Card className="border-border shadow-sm" data-testid="card-credit-usage">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Coins className="h-5 w-5 text-primary" /> Credits
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {legacy?.pending && legacyTotal > 0 && (
          <p
            className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-muted-foreground"
            data-testid="text-legacy-conversion-pending"
          >
            Your legacy balance ({legacy.captionCredits} caption,{" "}
            {legacy.imageCredits} image, {legacy.videoCredits} video) is still
            intact and awaiting administrator-approved conversion.
          </p>
        )}
        <div>
          <div className="text-4xl font-bold tracking-tight tabular-nums">
            {total.toFixed(total < 10 ? 1 : 0)}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Spent on whatever you generate — video, images, captions, voice.
          </p>
        </div>
        {total > 0 && granted > 0 ? (
          <div className="space-y-2">
            <Progress value={(granted / total) * 100} className="h-2" />
            <p className="text-xs text-muted-foreground">
              {granted.toFixed(granted < 10 ? 1 : 0)} from your plan
              {expiring
                ? `, expiring ${new Date(credits!.grantedExpiresAt!).toLocaleDateString()}`
                : ""}
              {purchased > 0
                ? ` · ${purchased.toFixed(purchased < 10 ? 1 : 0)} purchased, never expire`
                : ""}
            </p>
          </div>
        ) : purchased > 0 ? (
          <p className="text-xs text-muted-foreground">
            Purchased credits never expire.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            You have no credits left. Top up to keep generating.
          </p>
        )}
        <Link href="/billing">
          <span className="text-xs font-medium text-primary cursor-pointer">
            Top up credits →
          </span>
        </Link>
      </CardContent>
    </Card>
  );
}

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
        <span className="tabular-nums">
          {total.toFixed(total < 10 ? 1 : 0)}
        </span>
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
        <span
          className="tabular-nums font-semibold"
          data-testid="text-quote-credits"
        >
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
