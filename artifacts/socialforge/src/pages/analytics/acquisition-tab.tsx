import { useGetAcquisitionAnalytics } from "@workspace/api-client-react";
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
} from "./shared";

export function AcquisitionTab() {
  const params = useAnalyticsParams();
  const { data, isLoading, isError } = useGetAcquisitionAnalytics(params);

  if (isLoading) return <TabLoading />;
  if (isError || !data) return <TabError />;

  return (
    <div className="space-y-4">
      <StatGrid>
        <StatCard label="First opens" value={formatNumber(data.firstOpens)} />
        <StatCard label="Sign-ups" value={formatNumber(data.signUps)} />
        <StatCard label="Logins" value={formatNumber(data.logins)} />
      </StatGrid>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Traffic sources (UTM)</CardTitle>
        </CardHeader>
        <CardContent>
          {data.sources.length === 0 ? (
            <p className="text-sm text-muted-foreground">No tagged traffic in this period.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Source</TableHead>
                  <TableHead>Medium</TableHead>
                  <TableHead>Campaign</TableHead>
                  <TableHead className="text-right">Visits</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.sources.map((s, i) => (
                  <TableRow key={i}>
                    <TableCell>{s.source || "(direct)"}</TableCell>
                    <TableCell>{s.medium || "-"}</TableCell>
                    <TableCell>{s.campaign || "-"}</TableCell>
                    <TableCell className="text-right">{formatNumber(s.count)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <TwoColumn>
        <NameCountTable title="Sign-up methods" rows={data.signUpMethods} nameHeader="Method" />
        <NameCountTable title="Landing pages" rows={data.landingPages} nameHeader="Page" />
      </TwoColumn>
    </div>
  );
}
