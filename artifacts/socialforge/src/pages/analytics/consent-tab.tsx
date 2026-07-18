import { useGetConsentAnalytics } from "@workspace/api-client-react";
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
} from "./shared";

const CONSENT_LABELS = {
  analytics: "Usage analytics",
  deviceDetails: "Device details",
  locationCoarse: "Approximate location",
  locationPrecise: "Precise location",
  carrier: "Mobile carrier",
} as const;

export function ConsentTab() {
  const params = useAnalyticsParams();
  const { data, isLoading, isError } = useGetConsentAnalytics(params);

  if (isLoading) return <TabLoading />;
  if (isError || !data) return <TabError />;

  const responseRate = data.totalUsers > 0 ? data.respondedUsers / data.totalUsers : 0;

  return (
    <div className="space-y-4">
      <StatGrid>
        <StatCard label="Total users" value={formatNumber(data.totalUsers)} />
        <StatCard label="Responded to consent" value={formatNumber(data.respondedUsers)} />
        <StatCard label="Response rate" value={formatPercent(responseRate)} />
      </StatGrid>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Opt-ins by category</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-right">Opted in</TableHead>
                  <TableHead className="text-right">Share of responders</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(Object.keys(CONSENT_LABELS) as (keyof typeof CONSENT_LABELS)[]).map((key) => (
                  <TableRow key={key}>
                    <TableCell>{CONSENT_LABELS[key]}</TableCell>
                    <TableCell className="text-right">{formatNumber(data.optIns[key])}</TableCell>
                    <TableCell className="text-right">
                      {data.respondedUsers > 0
                        ? formatPercent(data.optIns[key] / data.respondedUsers)
                        : "-"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Consent changes over time</CardTitle>
          </CardHeader>
          <CardContent>
            {data.trends.length === 0 ? (
              <p className="text-sm text-muted-foreground">No consent changes in this period.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Opt-ins</TableHead>
                    <TableHead className="text-right">Opt-outs</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.trends.map((t) => (
                    <TableRow key={t.date}>
                      <TableCell>{t.date}</TableCell>
                      <TableCell className="text-right">{formatNumber(t.optIns)}</TableCell>
                      <TableCell className="text-right">{formatNumber(t.optOuts)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
