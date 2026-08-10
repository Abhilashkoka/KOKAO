import { useGetFunnelAnalytics } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useAnalyticsParams,
  StatCard,
  StatGrid,
  TabLoading,
  TabError,
  formatNumber,
  formatPercent,
  formatDuration,
} from "./shared";

export function FunnelsTab() {
  const params = useAnalyticsParams();
  const { data, isLoading, isError } = useGetFunnelAnalytics(params);

  if (isLoading) return <TabLoading />;
  if (isError || !data) return <TabError />;

  return (
    <div className="space-y-4">
      <StatGrid>
        <StatCard label="Onboarding started" value={formatNumber(data.onboarding.started)} />
        <StatCard label="Onboarding completed" value={formatNumber(data.onboarding.completed)} />
        <StatCard
          label="Completion rate"
          value={formatPercent(data.onboarding.completionRate)}
          hint={`Average time to complete: ${formatDuration(data.onboarding.avgCompletionTimeSec)}`}
        />
        <StatCard
          label="Activation rate"
          value={formatPercent(data.activationRate)}
          hint="Signed-up users with at least one key action"
        />
        <StatCard
          label="Connected an account"
          value={formatNumber(data.accountsConnected)}
          hint="Users who linked a social account (can happen at any point)"
        />
        <StatCard
          label="Time to first publish"
          value={
            data.avgTimeToFirstPublishSec > 0
              ? formatDuration(data.avgTimeToFirstPublishSec)
              : "—"
          }
          hint="Average from sign-up to first published post"
        />
      </StatGrid>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">First-post nudge effectiveness</CardTitle>
        </CardHeader>
        <CardContent>
          <StatGrid>
            <StatCard
              label="Saw the checklist"
              value={formatNumber(data.firstPostNudge.shown)}
              hint="Users shown the get-your-first-post-live nudge"
            />
            <StatCard
              label="Clicked a step"
              value={formatNumber(data.firstPostNudge.clicked)}
              hint={`Click rate: ${formatPercent(data.firstPostNudge.clickRate)}`}
            />
            <StatCard
              label="Published after seeing it"
              value={formatNumber(data.firstPostNudge.publishedAfterShown)}
              hint={`Conversion rate: ${formatPercent(data.firstPostNudge.conversionRate)}`}
            />
            <StatCard
              label="Dismissed"
              value={formatNumber(data.firstPostNudge.dismissed)}
              hint={`Dismiss rate: ${formatPercent(data.firstPostNudge.dismissRate)}`}
            />
          </StatGrid>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sign-up to first key action funnel</CardTitle>
        </CardHeader>
        <CardContent>
          {data.funnel.length === 0 ? (
            <p className="text-sm text-muted-foreground">No funnel data in this period.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Step</TableHead>
                  <TableHead className="text-right">Users</TableHead>
                  <TableHead className="text-right">Drop-off</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.funnel.map((step) => (
                  <TableRow key={step.step}>
                    <TableCell>{step.step}</TableCell>
                    <TableCell className="text-right">{formatNumber(step.count)}</TableCell>
                    <TableCell className="text-right">{step.dropOffPct.toFixed(1)}%</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
