import { useGetRevenueAnalytics } from "@workspace/api-client-react";
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
  formatPaise,
} from "./shared";

function MoneyTable({
  title,
  rows,
}: {
  title: string;
  rows: { name: string; count: number; totalPaise: number }[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No purchases in this period.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="text-right">Purchases</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.name}>
                  <TableCell>{r.name}</TableCell>
                  <TableCell className="text-right">{formatNumber(r.count)}</TableCell>
                  <TableCell className="text-right">{formatPaise(r.totalPaise)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export function RevenueTab() {
  const params = useAnalyticsParams();
  const { data, isLoading, isError } = useGetRevenueAnalytics(params);

  if (isLoading) return <TabLoading />;
  if (isError || !data) return <TabError />;

  return (
    <div className="space-y-4">
      <StatGrid>
        <StatCard
          label="Revenue"
          value={formatPaise(data.purchaseTotalPaise)}
          hint={`${formatNumber(data.purchaseCount)} purchases`}
        />
        <StatCard
          label="Refunds"
          value={formatPaise(data.refundTotalPaise)}
          hint={`${formatNumber(data.refundCount)} refunds`}
        />
        <StatCard label="ARPU" value={formatPaise(data.arpuPaise)} hint="Average revenue per active user" />
      </StatGrid>
      <StatGrid>
        <StatCard label="Subscriptions started" value={formatNumber(data.subscriptionsStarted)} />
        <StatCard label="Subscriptions renewed" value={formatNumber(data.subscriptionsRenewed)} />
        <StatCard label="Subscriptions cancelled" value={formatNumber(data.subscriptionsCancelled)} />
      </StatGrid>
      <TwoColumn>
        <MoneyTable title="Revenue by plan" rows={data.byPlan} />
        <MoneyTable title="Revenue by credit pack" rows={data.byCreditPack} />
        <NameCountTable title="Cancellation reasons" rows={data.cancelReasons} nameHeader="Reason" />
      </TwoColumn>
    </div>
  );
}
