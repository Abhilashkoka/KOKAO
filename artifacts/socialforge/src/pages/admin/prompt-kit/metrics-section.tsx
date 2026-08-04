import { useGetPromptKitMetrics } from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

export function MetricsSection() {
  const { data: metrics, isLoading } = useGetPromptKitMetrics();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Metrics</CardTitle>
        <CardDescription>
          Per-version usage, success rate, and average latency from recent
          generations.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading || !metrics ? (
          <Skeleton className="h-40 w-full" />
        ) : metrics.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            No usage metrics yet.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Template</TableHead>
                <TableHead>Case</TableHead>
                <TableHead>v#</TableHead>
                <TableHead>Lifecycle</TableHead>
                <TableHead className="text-right">Requests</TableHead>
                <TableHead className="text-right">Success rate</TableHead>
                <TableHead className="text-right">Avg latency</TableHead>
                <TableHead className="text-right">Workspaces</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {metrics.map((m) => {
                const successRate =
                  m.requests > 0
                    ? ((m.requests - m.failures) / m.requests) * 100
                    : null;
                return (
                  <TableRow
                    key={m.versionId}
                    data-testid={`row-metrics-${m.versionId}`}
                  >
                    <TableCell className="font-medium">
                      {m.templateTitle ?? `Template #${m.templateId}`}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {m.caseName ?? "—"}
                    </TableCell>
                    <TableCell>{m.versionNo}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{m.lifecycleState}</Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {m.requests}
                    </TableCell>
                    <TableCell
                      className="text-right tabular-nums"
                      data-testid={`text-success-rate-${m.versionId}`}
                    >
                      {successRate === null ? "—" : `${successRate.toFixed(0)}%`}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {typeof m.avgLatencyMs === "number"
                        ? `${Math.round(m.avgLatencyMs)} ms`
                        : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {m.distinctTenants ?? 0}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
