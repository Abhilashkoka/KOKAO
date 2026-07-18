import { useGetEngagementAnalytics } from "@workspace/api-client-react";
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
} from "./shared";

export function EngagementTab() {
  const params = useAnalyticsParams();
  const { data, isLoading, isError } = useGetEngagementAnalytics(params);

  if (isLoading) return <TabLoading />;
  if (isError || !data) return <TabError />;

  return (
    <div className="space-y-4">
      <StatGrid>
        <StatCard label="Page views" value={formatNumber(data.pageViews)} />
        <StatCard label="Searches" value={formatNumber(data.search.total)} />
        <StatCard
          label="Zero-result searches"
          value={formatPercent(data.search.zeroResultRate)}
        />
      </StatGrid>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Feature adoption</CardTitle>
        </CardHeader>
        <CardContent>
          {data.features.length === 0 ? (
            <p className="text-sm text-muted-foreground">No feature usage in this period.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Feature</TableHead>
                  <TableHead className="text-right">Uses</TableHead>
                  <TableHead className="text-right">Unique users</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.features.map((f) => (
                  <TableRow key={f.feature}>
                    <TableCell>{f.feature}</TableCell>
                    <TableCell className="text-right">{formatNumber(f.uses)}</TableCell>
                    <TableCell className="text-right">{formatNumber(f.uniqueUsers)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <TwoColumn>
        <NameCountTable title="Key actions" rows={data.keyActions} nameHeader="Action" />
        <NameCountTable title="Top pages" rows={data.topPages} nameHeader="Page" />
        <NameCountTable title="Top search terms" rows={data.search.topTerms} nameHeader="Term" />
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Navigation paths</CardTitle>
          </CardHeader>
          <CardContent>
            {data.navigationPaths.length === 0 ? (
              <p className="text-sm text-muted-foreground">No navigation data in this period.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>From</TableHead>
                    <TableHead>To</TableHead>
                    <TableHead className="text-right">Count</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.navigationPaths.map((p, i) => (
                    <TableRow key={i}>
                      <TableCell className="max-w-[160px] truncate">{p.from}</TableCell>
                      <TableCell className="max-w-[160px] truncate">{p.to}</TableCell>
                      <TableCell className="text-right">{formatNumber(p.count)}</TableCell>
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
