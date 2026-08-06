import {
  useAdminGetProviderHealth,
  getAdminGetProviderHealthQueryKey,
} from "@workspace/api-client-react";
import type { ProviderHealthEntryView } from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Activity } from "lucide-react";

/** Breaker state is in-memory and moves fast; keep the card live. */
const REFRESH_MS = 15_000;

const FAMILY_LABELS: Record<string, string> = {
  textgen: "Text",
  imagegen: "Image",
  videogen: "Video",
};

const FAMILY_ORDER = ["textgen", "imagegen", "videogen"] as const;

function successRate(entry: ProviderHealthEntryView): string {
  if (entry.samples === 0) return "—";
  return `${Math.round((entry.successes / entry.samples) * 100)}%`;
}

function ProviderRow({
  entry,
  diverted,
}: {
  entry: ProviderHealthEntryView;
  diverted: boolean;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm"
      data-testid={`row-provider-health-${entry.key}`}
    >
      <span className="font-medium">{entry.label}</span>
      <span className="font-mono text-xs text-muted-foreground">
        {entry.key}
      </span>
      {entry.selected && (
        <Badge variant="outline" data-testid={`badge-provider-selected-${entry.key}`}>
          Selected
        </Badge>
      )}
      {entry.healthy ? (
        <Badge variant="secondary" data-testid={`badge-provider-healthy-${entry.key}`}>
          Healthy
        </Badge>
      ) : (
        <Badge variant="destructive" data-testid={`badge-provider-open-${entry.key}`}>
          Breaker open
          {entry.breakerOpenUntil
            ? ` — retries ${new Date(entry.breakerOpenUntil).toLocaleTimeString()}`
            : ""}
        </Badge>
      )}
      {diverted && (
        <Badge variant="destructive" data-testid={`badge-provider-diverted-${entry.key}`}>
          Text diverted
        </Badge>
      )}
      <span className="ml-auto flex flex-wrap items-center gap-x-4 text-xs text-muted-foreground">
        <span data-testid={`text-provider-success-rate-${entry.key}`}>
          Success: {successRate(entry)}
          {entry.samples > 0 ? ` (${entry.successes}/${entry.samples})` : ""}
        </span>
        <span>
          Latency:{" "}
          {entry.typicalLatencyMs === null
            ? "—"
            : entry.typicalLatencyMs >= 1000
              ? `${(entry.typicalLatencyMs / 1000).toFixed(1)} s`
              : `${entry.typicalLatencyMs} ms`}
        </span>
      </span>
      {entry.lastFailureMessage && !entry.healthy && (
        <div className="w-full font-mono text-xs break-all text-muted-foreground">
          {entry.lastFailureMessage}
        </div>
      )}
    </div>
  );
}

/**
 * Live provider health: every breaker key (text/image/video generation) with
 * its healthy/open status, recent success rate and typical latency, plus a
 * prominent banner when text requests are actively being diverted to the
 * failover provider.
 */
export function ProviderHealthCard() {
  const { data, isLoading } = useAdminGetProviderHealth({
    query: {
      queryKey: getAdminGetProviderHealthQueryKey(),
      refetchInterval: REFRESH_MS,
      refetchIntervalInBackground: false,
    },
  });

  const failover = data?.textFailover;

  return (
    <Card data-testid="card-provider-health">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-muted-foreground" />
          AI Provider Health
        </CardTitle>
        <CardDescription>
          Live circuit-breaker state for every text, image and video
          generation provider, and whether text requests are currently being
          diverted to the failover provider.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading || !data ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <>
            {failover?.active ? (
              <div
                className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm"
                data-testid="banner-text-failover-active"
              >
                <span className="font-medium text-destructive">
                  Text failover active:
                </span>{" "}
                requests to <span className="font-mono">{failover.selectedProvider}</span>{" "}
                are being diverted to{" "}
                <span className="font-mono">{failover.divertedTo}</span> while its
                breaker is open.
              </div>
            ) : (
              <div
                className="text-sm text-muted-foreground"
                data-testid="text-no-failover"
              >
                No active failover — text requests are served by{" "}
                <span className="font-mono">{failover?.selectedProvider}</span>.
              </div>
            )}
            {FAMILY_ORDER.map((family) => {
              const entries = data.providers.filter((p) => p.family === family);
              if (entries.length === 0) return null;
              return (
                <div key={family} className="space-y-1">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {FAMILY_LABELS[family]} generation
                  </div>
                  {entries.map((entry) => (
                    <ProviderRow
                      key={entry.key}
                      entry={entry}
                      diverted={
                        family === "textgen" &&
                        entry.selected &&
                        failover?.active === true
                      }
                    />
                  ))}
                </div>
              );
            })}
            <div className="text-xs text-muted-foreground">
              Success rate and latency cover each provider's last 20 calls
              since the server started. Auto-refreshes every{" "}
              {REFRESH_MS / 1000} seconds.
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
