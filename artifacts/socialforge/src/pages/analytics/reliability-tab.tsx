import { useGetReliabilityAnalytics } from "@workspace/api-client-react";
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
  NameCountTable,
  TwoColumn,
  formatNumber,
  formatPercent,
  formatMs,
} from "./shared";

export function ReliabilityTab() {
  const params = useAnalyticsParams();
  const { data, isLoading, isError } = useGetReliabilityAnalytics(params);

  if (isLoading) return <TabLoading />;
  if (isError || !data) return <TabError />;

  return (
    <div className="space-y-4">
      <StatGrid>
        <StatCard label="Errors" value={formatNumber(data.errorCount)} />
        <StatCard label="Crashes" value={formatNumber(data.crashCount)} />
        <StatCard
          label="Crash-free sessions"
          value={formatPercent(data.crashFreeSessionRate)}
        />
        <StatCard label="App freezes (ANR)" value={formatNumber(data.anrCount)} />
      </StatGrid>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">API performance</CardTitle>
        </CardHeader>
        <CardContent>
          {data.apiLatency.length === 0 ? (
            <p className="text-sm text-muted-foreground">No API traffic in this period.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Endpoint group</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                  <TableHead className="text-right">Error rate</TableHead>
                  <TableHead className="text-right">Median</TableHead>
                  <TableHead className="text-right">p95</TableHead>
                  <TableHead className="text-right">p99</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.apiLatency.map((row) => (
                  <TableRow key={row.group}>
                    <TableCell>{row.group}</TableCell>
                    <TableCell className="text-right">{formatNumber(row.count)}</TableCell>
                    <TableCell className="text-right">{formatPercent(row.errorRate)}</TableCell>
                    <TableCell className="text-right">{formatMs(row.p50Ms)}</TableCell>
                    <TableCell className="text-right">{formatMs(row.p95Ms)}</TableCell>
                    <TableCell className="text-right">{formatMs(row.p99Ms)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <TwoColumn>
        <NameCountTable title="Errors by type" rows={data.errorsByType} nameHeader="Type" />
        <NameCountTable title="Errors by page" rows={data.errorsByScreen} nameHeader="Page" />
        <Card>
          <CardHeader>
            <CardTitle className="text-base">App start-up time</CardTitle>
          </CardHeader>
          <CardContent>
            {data.startup.length === 0 ? (
              <p className="text-sm text-muted-foreground">No start-up data in this period.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Platform</TableHead>
                    <TableHead className="text-right">Samples</TableHead>
                    <TableHead className="text-right">Average</TableHead>
                    <TableHead className="text-right">p95</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.startup.map((s) => (
                    <TableRow key={s.platform}>
                      <TableCell>{s.platform}</TableCell>
                      <TableCell className="text-right">{formatNumber(s.count)}</TableCell>
                      <TableCell className="text-right">{formatMs(s.avgMs)}</TableCell>
                      <TableCell className="text-right">{formatMs(s.p95Ms)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </TwoColumn>
    </div>
  );
}
