import { useState } from "react";
import {
  useAdminGetVideoGenSettings,
  useAdminListVideoModelPricing,
  getAdminListVideoModelPricingQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";

/**
 * Superadmin page: live Replicate pricing for every curated video model, plus
 * an estimated cost for a chosen clip length. Prices are scraped server-side
 * from replicate.com model pages (cached ~1h); "per second" prices multiply by
 * the duration, flat "per output video" prices don't.
 */

interface PriceRange {
  min: number;
  max: number;
  perSecond: boolean;
}

/** Parse "$0.20–$0.40 per second of output video" into numbers for the calculator. */
export function parsePriceLine(price: string): PriceRange | null {
  const nums = [...price.matchAll(/\$([0-9]+(?:\.[0-9]+)?)/g)].map((m) => Number(m[1]));
  if (nums.length === 0) return null;
  return {
    min: Math.min(...nums),
    max: Math.max(...nums),
    perSecond: /per second/i.test(price),
  };
}

function estimate(range: PriceRange, seconds: number): string {
  const factor = range.perSecond ? seconds : 1;
  const lo = range.min * factor;
  const hi = range.max * factor;
  const fmt = (v: number) => `$${v.toFixed(2)}`;
  return lo === hi ? fmt(lo) : `${fmt(lo)}–${fmt(hi)}`;
}

export function VideoPricingPage() {
  const { data: settings, isLoading } = useAdminGetVideoGenSettings();
  const [seconds, setSeconds] = useState(8);

  const provider = settings?.providers.find((p) => p.id === (settings?.provider ?? "replicate"));
  const textOptions = provider?.textModelOptions ?? [];
  const imageOptions = provider?.imageModelOptions ?? [];
  const slugs = [...new Set([...textOptions, ...imageOptions].map((o) => o.value))];
  const params = { models: slugs.join(",") };
  const { data: pricing, isLoading: pricingLoading } = useAdminListVideoModelPricing(params, {
    query: {
      queryKey: getAdminListVideoModelPricingQueryKey(params),
      enabled: slugs.length > 0,
      staleTime: 60 * 60 * 1000,
    },
  });
  const priceFor = (model: string) => pricing?.find((p) => p.model === model)?.price ?? null;

  const engineFor = (model: string): string[] => {
    const engines: string[] = [];
    if (textOptions.some((o) => o.value === model)) engines.push("Text to Video");
    if (imageOptions.some((o) => o.value === model)) engines.push("Animate Photo");
    return engines;
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Video Model Pricing</h1>
        <p className="text-muted-foreground">
          Live prices from replicate.com for every selectable video model, with an
          estimated cost per clip.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Cost calculator</CardTitle>
          <CardDescription>
            Clip length used for the estimates below. "Per second" models scale with
            length; flat "per output video" models don't.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-3">
          <Input
            type="number"
            min={1}
            max={60}
            value={seconds}
            onChange={(e) => setSeconds(Math.max(1, Math.min(60, Number(e.target.value) || 1)))}
            className="w-24"
            data-testid="input-video-pricing-seconds"
          />
          <span className="text-sm text-muted-foreground">seconds of output video</span>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Models</CardTitle>
          <CardDescription>
            Prices are refreshed about once an hour. Models without a public price
            page show "Pricing unavailable".
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading || pricingLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : slugs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No video models configured.</p>
          ) : (
            <div className="divide-y" data-testid="list-video-model-pricing">
              {slugs.map((slug) => {
                const price = priceFor(slug);
                const range = price ? parsePriceLine(price) : null;
                return (
                  <div key={slug} className="flex flex-wrap items-center gap-3 py-3">
                    <div className="min-w-64 flex-1">
                      <p className="font-mono text-sm">{slug}</p>
                      <p className="text-xs text-muted-foreground">
                        {price ?? "Pricing unavailable"}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {engineFor(slug).map((e) => (
                        <Badge key={e} variant="secondary">
                          {e}
                        </Badge>
                      ))}
                    </div>
                    <div className="w-40 text-right">
                      {range ? (
                        <>
                          <p className="text-sm font-medium">{estimate(range, seconds)}</p>
                          <p className="text-xs text-muted-foreground">
                            est. for {range.perSecond ? `${seconds}s clip` : "one video"}
                          </p>
                        </>
                      ) : (
                        <p className="text-sm text-muted-foreground">—</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
