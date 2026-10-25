import {
  getGetCreditsQueryKey,
  getQuoteCreditsQueryKey,
  useGetCredits,
  useQuoteCredits,
} from "@workspace/api-client-react";
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
  const { data: credits, isLoading, isError } = useGetCredits({
    request: { cache: "no-store" },
    query: {
      queryKey: getGetCreditsQueryKey(),
      staleTime: 0,
      refetchOnMount: "always",
      refetchOnWindowFocus: "always",
      refetchOnReconnect: "always",
      refetchInterval: 30_000,
      refetchIntervalInBackground: false,
    },
  });
  return {
    creditFunded: Boolean(credits?.funded),
    credits,
    isLoading,
    isError,
  };
}

/**
 * The yardstick for "what do my credits buy": a typical 30-second, 4-scene,
 * narrated video, priced live from the rate card. Changing a rate in admin
 * changes every "≈ N videos" line with no deploy.
 */
export const REFERENCE_VIDEO = {
  action: "video",
  durationSec: 30,
  sceneCount: 4,
  narrated: true,
} as const;

/** Credits for one reference video and one image, from the live rate card. */
export function useCreditValue(enabled = true): {
  videoCredits: number | null;
  imageCredits: number | null;
} {
  const imageParams = { action: "image" };
  const { data: video } = useQuoteCredits(REFERENCE_VIDEO, {
    query: {
      queryKey: getQuoteCreditsQueryKey(REFERENCE_VIDEO),
      enabled,
      staleTime: 60_000,
    },
  });
  const { data: image } = useQuoteCredits(imageParams, {
    query: {
      queryKey: getQuoteCreditsQueryKey(imageParams),
      enabled,
      staleTime: 60_000,
    },
  });
  return {
    videoCredits: video && video.credits > 0 ? video.credits : null,
    imageCredits: image && image.credits > 0 ? image.credits : null,
  };
}

/**
 * "≈ 12 videos of 30s, or ≈ 600 images" for a credit amount. Null when the
 * rate card cannot price it yet.
 */
export function describeCreditValue(
  credits: number,
  value: { videoCredits: number | null; imageCredits: number | null },
): string | null {
  if (!(credits > 0)) return null;
  const parts: string[] = [];
  if (value.videoCredits) {
    const videos = Math.floor(credits / value.videoCredits);
    parts.push(`≈ ${videos.toLocaleString("en-IN")} video${videos === 1 ? "" : "s"} of 30s`);
  }
  if (value.imageCredits) {
    const images = Math.floor(credits / value.imageCredits);
    parts.push(`≈ ${images.toLocaleString("en-IN")} image${images === 1 ? "" : "s"}`);
  }
  return parts.length ? parts.join(", or ") : null;
}

/** One quiet line under a balance or a plan: what that many credits buys. */
export function CreditValueLine({
  credits,
  suffix,
  testId = "text-credit-value",
}: {
  credits: number;
  suffix?: string;
  testId?: string;
}) {
  const value = useCreditValue(credits > 0);
  const text = describeCreditValue(credits, value);
  if (!text) return null;
  return (
    <p className="text-xs text-muted-foreground" data-testid={testId}>
      {text}
      {suffix ? ` ${suffix}` : ""}. A 30s video here means 4 scenes with
      narration; longer or HD videos use more.
    </p>
  );
}

function creditHistoryLabel(kind: string): string {
  switch (kind) {
    case "purchase":
      return "Credit pack";
    case "grant_plan":
      return "Plan allowance";
    case "grant_signup":
      return "Welcome credits";
    case "grant_promo":
      return "Promo credits";
    case "grant_admin":
      return "Granted by admin";
    case "refund":
      return "Refunded";
    case "goodwill":
      return "Free fix (on us)";
    case "expire":
      return "Expired";
    case "spend":
      return "Generation";
    default:
      return "Credit activity";
  }
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
  const { credits, creditFunded, isLoading, isError } = useCreditFunding();
  if (isLoading || !credits) {
    return <p role="status">{isError ? "Credit balance unavailable. Please try again." : "Loading credit balance…"}</p>;
  }
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
        {isError && (
          <p className="text-xs text-muted-foreground" role="status">
            Showing your last known balance. Reconnecting automatically…
          </p>
        )}
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
          {creditFunded && total > 0 && <div className="mt-1"><CreditValueLine credits={total} /></div>}
          <p className="text-xs text-muted-foreground mt-1">
            {creditFunded
              ? "Spent on whatever you generate — video, images, captions, voice."
              : "Credits are saved to your balance. Generation still uses your current wallet or quota until credit billing is enabled."}
          </p>
        </div>
        {total > 0 && granted > 0 ? (
          <div className="space-y-2">
            <Progress value={(granted / total) * 100} className="h-2" />
            <p className="text-xs text-muted-foreground">
              {granted.toFixed(granted < 10 ? 1 : 0)} granted (plan or rewards)
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
            {creditFunded ? "You have no credits left. Top up to keep generating." : "No unified credits yet. Your existing wallet or quota is separate."}
          </p>
        )}
        {credits.history?.length > 0 && (
          <div className="space-y-2 border-t border-border pt-3" data-testid="credit-history">
            <div className="text-sm font-medium">Recent credit activity</div>
            <ul className="space-y-1.5 text-xs">
              {credits.history.slice(0, 8).map((entry) => (
                <li
                  key={entry.id}
                  className="flex items-center justify-between gap-3"
                  data-testid={`credit-history-entry-${entry.id}`}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{creditHistoryLabel(entry.kind)}</span>
                    {entry.settlementStatus === "pending" && (
                      <Badge variant="outline" className="shrink-0 text-[10px]">
                        Pending
                      </Badge>
                    )}
                    {entry.settlementStatus === "ambiguous" && (
                      <Badge variant="outline" className="shrink-0 text-[10px]">
                        Ambiguous
                      </Badge>
                    )}
                  </div>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {entry.credits > 0 ? "+" : ""}
                    {entry.credits} credits
                  </span>
                </li>
              ))}
            </ul>
          </div>
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
  const { credits: data, isLoading, isError } = useCreditFunding();

  if (!data && isError) {
    return (
      <Link href="/billing">
        <span className="text-xs text-muted-foreground" role="status">
          Credit balance unavailable
        </span>
      </Link>
    );
  }
  if (isLoading || !data || (data.mode === "off" && data.total <= 0)) return null;

  const total = data.total ?? 0;
  const low = data.funded && total < 20;

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

/** Plain-language names for rate-card keys, so a quote reads like a bill. */
export function creditRateLabel(rateKey: string): string {
  switch (rateKey) {
    case "video":
      return "Video (per second)";
    case "video_hd":
      return "HD video (per second)";
    case "image":
      return "Scene images";
    case "image_edit":
      return "Image edits";
    case "caption":
      return "Script & writing";
    case "voice":
      return "Voice (per second)";
    case "lipsync":
      return "Lip sync (per second)";
    case "transcription":
      return "Transcription";
    default:
      return rateKey.replace(/_/g, " ");
  }
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
              <span>
                {creditRateLabel(line.rateKey)}
                <span className="tabular-nums">
                  {" "}× {line.quantity.toFixed(line.quantity < 10 ? 1 : 0)}
                </span>
              </span>
              <span className="tabular-nums">
                {line.credits.toFixed(line.credits < 10 ? 1 : 0)}
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
