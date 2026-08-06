import { RippleSpinner } from "@/components/ui/ripple-spinner";
import {
  useAdminGetStats,
  getAdminGetStatsQueryKey,
  useListPlans,
  useAdminRunSweep,
  useAdminListAuditLogs,
  getAdminListAuditLogsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Users, Layers, Calendar, Share2, RadioTower } from "lucide-react";
import { PLAN_LABELS } from "./shared";
import { FeatureControlsCard } from "./feature-controls-card";
import { ProviderHealthCard } from "./provider-health-card";

/** The sweep runs every 15 minutes; call it stale after two missed cycles. */
const SWEEP_STALE_MS = 35 * 60 * 1000;

function isSweepStale(lastRunAt: string): boolean {
  return Date.now() - new Date(lastRunAt).getTime() > SWEEP_STALE_MS;
}

/**
 * Ad-platform sweep checks use "<platform>-ads" pseudo-keys in the failure
 * history; map them to readable names. Organic platforms pass through
 * unchanged (the badge's `capitalize` class handles their casing).
 */
const SWEEP_PLATFORM_LABELS: Record<string, string> = {
  "meta-ads": "Meta Ads",
  "google-ads": "Google Ads",
  "linkedin-ads": "LinkedIn Ads",
  "tiktok-ads": "TikTok Ads",
};

function sweepPlatformLabel(platform: string): string {
  return SWEEP_PLATFORM_LABELS[platform] ?? platform;
}

function formatSweepDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/**
 * Human duration since a streak's first failure, e.g. "45 minutes",
 * "2 hours", "3 days". Returns null for future or unparsable timestamps.
 */
function formatFailingFor(firstFailedAt: string): string | null {
  const start = new Date(firstFailedAt).getTime();
  if (!Number.isFinite(start)) return null;
  const ms = Date.now() - start;
  if (ms < 0) return null;
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

export function OverviewTab() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: stats, isLoading: statsLoading } = useAdminGetStats({
    query: {
      queryKey: getAdminGetStatsQueryKey(),
      // While a sweep is in flight the server reports sweepRunning=true;
      // poll so the Connection Sweep card refreshes as soon as it finishes.
      refetchInterval: (query) =>
        query.state.data?.sweepRunning ? 3000 : false,
    },
  });
  const { data: planCatalog } = useListPlans();
  const runSweep = useAdminRunSweep();

  // Most recent manual sweep trigger (who clicked "Run now" and whether the
  // sweep actually started or was skipped because one was already in flight).
  const lastManualRunParams = { action: "sweep_run" as const, limit: 1 };
  const { data: lastManualRunPage } = useAdminListAuditLogs(
    lastManualRunParams,
    {
      query: {
        queryKey: getAdminListAuditLogsQueryKey(lastManualRunParams),
        // Keep the "Last manual run" strip live even when ANOTHER admin
        // triggers a sweep: poll while the card is visible so this page
        // picks up runs it didn't initiate within a few seconds.
        refetchInterval: 5000,
        refetchIntervalInBackground: false,
      },
    },
  );
  const lastManualRun = lastManualRunPage?.items?.[0];
  let lastManualRunStarted: boolean | null = null;
  if (lastManualRun?.newValue) {
    try {
      const parsed = JSON.parse(lastManualRun.newValue) as {
        started?: boolean;
      };
      if (typeof parsed.started === "boolean") {
        lastManualRunStarted = parsed.started;
      }
    } catch {
      // Leave outcome unknown for unparseable legacy rows.
    }
  }

  const handleRunSweep = () => {
    runSweep.mutate(undefined, {
      onSuccess: (result) => {
        queryClient.invalidateQueries({
          queryKey: getAdminGetStatsQueryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: getAdminListAuditLogsQueryKey(),
        });
        if (result.started) {
          toast({
            title: "Sweep started",
            description:
              "Re-checking all social connections in the background. Results will refresh here when it finishes.",
          });
        } else {
          toast({
            title: "Sweep already running",
            description:
              "A sweep is already in progress. Its results will appear shortly.",
          });
        }
      },
      onError: () => {
        toast({
          title: "Sweep failed",
          description: "Could not run the connection sweep.",
          variant: "destructive",
        });
      },
    });
  };

  const planNameById: Record<string, string> = {};
  for (const p of planCatalog ?? []) planNameById[p.id] = p.name;

  const statCards = [
    { label: "Total Tenants", value: stats?.totalTenants, icon: Users },
    { label: "Total Content", value: stats?.totalContent, icon: Layers },
    {
      label: "Scheduled Posts",
      value: stats?.totalScheduledPosts,
      icon: Calendar,
    },
    {
      label: "Connected Accounts",
      value: stats?.totalConnectedAccounts,
      icon: Share2,
    },
  ];

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        {statCards.map((card) => (
          <Card key={card.label}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {card.label}
              </CardTitle>
              <card.icon className="h-5 w-5 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {statsLoading ? (
                <Skeleton className="h-9 w-16" />
              ) : (
                <div className="text-3xl font-bold">{card.value ?? 0}</div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {stats && !statsLoading && (
        <div className="flex flex-wrap gap-3">
          {Object.entries(stats.tenantsByPlan ?? {}).map(([planId, count]) => (
            <Badge key={planId} variant="secondary">
              {planNameById[planId] ?? PLAN_LABELS[planId] ?? planId}: {count}
            </Badge>
          ))}
        </div>
      )}

      <Card data-testid="card-connection-sweep">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2">
              <RadioTower className="h-5 w-5 text-muted-foreground" />
              Connection Sweep
            </CardTitle>
            <CardDescription>
              Background job that re-checks every workspace's social
              connections and alerts users when one breaks.
            </CardDescription>
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={handleRunSweep}
              disabled={runSweep.isPending || stats?.sweepRunning === true}
              data-testid="button-run-sweep"
            >
              {runSweep.isPending || stats?.sweepRunning ? (
                <>
                  <RippleSpinner className="mr-2 h-4 w-4" />
                  Running...
                </>
              ) : (
                "Run now"
              )}
            </Button>
          {!statsLoading &&
            (stats?.sweepRunning ? (
              <Badge variant="secondary" data-testid="badge-sweep-running">
                Running
              </Badge>
            ) : stats?.connectionSweep ? (
              isSweepStale(stats.connectionSweep.lastRunAt) ? (
                <Badge
                  variant="destructive"
                  data-testid="badge-sweep-stale"
                >
                  Stale
                </Badge>
              ) : (
                <Badge variant="secondary" data-testid="badge-sweep-healthy">
                  Healthy
                </Badge>
              )
            ) : (
              <Badge variant="outline" data-testid="badge-sweep-never">
                Never ran
              </Badge>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          {lastManualRun && (
            <div
              className="mb-4 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm"
              data-testid="section-sweep-last-manual-run"
            >
              <span className="text-muted-foreground">Last manual run:</span>
              <span className="font-medium" data-testid="text-sweep-manual-actor">
                {lastManualRun.actorEmail ??
                  `Tenant #${lastManualRun.actorTenantId}`}
              </span>
              <span
                className="text-muted-foreground"
                data-testid="text-sweep-manual-time"
              >
                {new Date(lastManualRun.createdAt).toLocaleString()}
              </span>
              {lastManualRunStarted !== null &&
                (lastManualRunStarted ? (
                  <Badge
                    variant="secondary"
                    data-testid="badge-sweep-manual-started"
                  >
                    Started
                  </Badge>
                ) : (
                  <Badge
                    variant="outline"
                    data-testid="badge-sweep-manual-skipped"
                  >
                    Skipped (already running)
                  </Badge>
                ))}
            </div>
          )}
          {statsLoading ? (
            <Skeleton className="h-8 w-64" />
          ) : stats?.connectionSweep ? (
            <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
              <div>
                <div className="text-muted-foreground">Last run</div>
                <div className="font-medium" data-testid="text-sweep-last-run">
                  {new Date(stats.connectionSweep.lastRunAt).toLocaleString()}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Duration</div>
                <div className="font-medium">
                  {formatSweepDuration(stats.connectionSweep.durationMs)}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Accounts checked</div>
                <div className="font-medium">
                  {stats.connectionSweep.accountsChecked}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Errors</div>
                <div
                  className={
                    stats.connectionSweep.errorCount > 0
                      ? "font-medium text-destructive"
                      : "font-medium"
                  }
                  data-testid="text-sweep-errors"
                >
                  {stats.connectionSweep.errorCount}
                </div>
              </div>
              {stats.connectionSweep.accountsChecked > 0 && (
                <div className="w-full" data-testid="text-sweep-fail-ratio">
                  <div className="text-muted-foreground">Failure ratio</div>
                  <div
                    className={
                      stats.connectionSweep.errorCount /
                        stats.connectionSweep.accountsChecked >=
                      (stats.connectionSweep.failRatioAlertThreshold ?? 1)
                        ? "font-medium text-destructive"
                        : "font-medium"
                    }
                  >
                    {stats.connectionSweep.errorCount} of{" "}
                    {stats.connectionSweep.accountsChecked} checks failed (
                    {Math.round(
                      (stats.connectionSweep.errorCount /
                        stats.connectionSweep.accountsChecked) *
                        100,
                    )}
                    %)
                    {stats.connectionSweep.errorCount /
                      stats.connectionSweep.accountsChecked >=
                      (stats.connectionSweep.failRatioAlertThreshold ?? 1) && (
                      <Badge
                        variant="destructive"
                        className="ml-2"
                        data-testid="badge-sweep-fail-ratio-alert"
                      >
                        Above alert threshold
                      </Badge>
                    )}
                  </div>
                </div>
              )}
              {stats.connectionSweep.errorCount > 0 &&
                stats.connectionSweep.lastError && (
                  <div className="w-full">
                    <div className="text-muted-foreground">Last error</div>
                    <div className="font-mono text-xs break-all">
                      {stats.connectionSweep.lastError}
                    </div>
                  </div>
                )}
              {(stats.connectionSweep.droppedStreaks ?? 0) > 0 && (
                <div className="w-full" data-testid="text-sweep-dropped-streaks">
                  <div className="text-destructive text-xs font-medium">
                    {stats.connectionSweep.droppedStreaks} additional failing
                    check
                    {stats.connectionSweep.droppedStreaks === 1 ? "" : "s"} not
                    shown — more connections are failing than the failure
                    history keeps.
                  </div>
                </div>
              )}
              {(stats.connectionSweep.recentFailures?.length ?? 0) > 0 && (
                <div className="w-full" data-testid="section-sweep-failures">
                  <div className="text-muted-foreground mb-1">
                    Recent failed checks
                  </div>
                  <div className="space-y-1">
                    {stats.connectionSweep.recentFailures!.map((f, i) => (
                      <div
                        key={`${f.tenantId}-${f.platform}-${f.at}-${i}`}
                        className="rounded-md border px-3 py-2 text-xs"
                        data-testid={`row-sweep-failure-${i}`}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">
                            {f.tenantName ?? `Tenant #${f.tenantId}`}
                          </span>
                          <Badge variant="outline" className="capitalize">
                            {sweepPlatformLabel(f.platform)}
                          </Badge>
                          {(f.consecutiveFailures ?? 1) > 1 && (
                            <Badge
                              variant="destructive"
                              data-testid={`badge-sweep-streak-${i}`}
                            >
                              Failed {f.consecutiveFailures} sweeps in a row
                              {f.firstFailedAt &&
                              formatFailingFor(f.firstFailedAt)
                                ? ` — failing for ${formatFailingFor(f.firstFailedAt)}`
                                : ""}
                            </Badge>
                          )}
                          <span className="text-muted-foreground">
                            {new Date(f.at).toLocaleString()}
                          </span>
                        </div>
                        <div className="font-mono break-all text-muted-foreground mt-1">
                          {f.error}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              The sweep has not completed a run yet. It runs about a minute
              after the server starts and every 15 minutes after that.
            </p>
          )}
        </CardContent>
      </Card>

      <ProviderHealthCard />

      <FeatureControlsCard />
    </div>
  );
}
