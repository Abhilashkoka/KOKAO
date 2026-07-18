import { useGetDataConsumptionAnalytics } from "@workspace/api-client-react";
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
  TabLoading,
  TabError,
  TwoColumn,
  formatNumber,
  formatBytes,
} from "./shared";

const KIND_LABELS: Record<string, string> = {
  caption: "Captions",
  image: "Images",
  campaign: "Campaigns",
  transcription: "Voice notes",
};

export function DataConsumptionTab() {
  const params = useAnalyticsParams();
  const { data, isLoading, isError } = useGetDataConsumptionAnalytics(params);

  if (isLoading) return <TabLoading />;
  if (isError || !data) return <TabError />;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">AI data usage by type</CardTitle>
        </CardHeader>
        <CardContent>
          {data.totals.length === 0 ? (
            <p className="text-sm text-muted-foreground">No AI usage in this period.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                  <TableHead className="text-right">Sent</TableHead>
                  <TableHead className="text-right">Received</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.totals.map((t) => (
                  <TableRow key={t.kind}>
                    <TableCell>{KIND_LABELS[t.kind] ?? t.kind}</TableCell>
                    <TableCell className="text-right">{formatNumber(t.count)}</TableCell>
                    <TableCell className="text-right">{formatBytes(t.requestBytes)}</TableCell>
                    <TableCell className="text-right">{formatBytes(t.responseBytes)}</TableCell>
                    <TableCell className="text-right">{formatBytes(t.totalBytes)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <TwoColumn>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Monthly usage</CardTitle>
          </CardHeader>
          <CardContent>
            {data.monthly.length === 0 ? (
              <p className="text-sm text-muted-foreground">No monthly data yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Month</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Requests</TableHead>
                    <TableHead className="text-right">Data</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.monthly.map((m, i) => (
                    <TableRow key={i}>
                      <TableCell>{m.month}</TableCell>
                      <TableCell>{KIND_LABELS[m.kind] ?? m.kind}</TableCell>
                      <TableCell className="text-right">{formatNumber(m.count)}</TableCell>
                      <TableCell className="text-right">{formatBytes(m.totalBytes)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
        {data.byTenant.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Usage by workspace</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Workspace</TableHead>
                    <TableHead className="text-right">Requests</TableHead>
                    <TableHead className="text-right">Data</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.byTenant.map((t) => (
                    <TableRow key={t.tenantId}>
                      <TableCell>{t.tenantName ?? `Workspace ${t.tenantId}`}</TableCell>
                      <TableCell className="text-right">{formatNumber(t.count)}</TableCell>
                      <TableCell className="text-right">{formatBytes(t.totalBytes)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent campaigns</CardTitle>
          </CardHeader>
          <CardContent>
            {data.recentCampaigns.length === 0 ? (
              <p className="text-sm text-muted-foreground">No campaigns in this period.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Platforms</TableHead>
                    <TableHead className="text-right">Data</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.recentCampaigns.map((c) => (
                    <TableRow key={c.campaignId}>
                      <TableCell>{new Date(c.createdAt).toLocaleDateString()}</TableCell>
                      <TableCell className="max-w-[220px] truncate">
                        {c.platforms.map((p) => p.platform).join(", ") || "-"}
                      </TableCell>
                      <TableCell className="text-right">{formatBytes(c.totalBytes)}</TableCell>
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
