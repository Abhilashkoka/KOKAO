import { useState } from "react";
import { useGetStudioLipSyncAnalytics } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";

type GroupBy = "workflow" | "funding_rail" | "scene_count_bucket";

const GROUP_LABELS: Record<GroupBy, string> = {
  workflow: "Workflow",
  funding_rail: "Funding rail",
  scene_count_bucket: "Scene count",
};

function label(value: string): string {
  return value
    .replace("2_3", "2–3")
    .replace("4_6", "4–6")
    .replace("7_plus", "7+")
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function LipSyncInsightsTab() {
  const [groupBy, setGroupBy] = useState<GroupBy>("workflow");
  const { data, isLoading, isError } = useGetStudioLipSyncAnalytics({ groupBy });

  return (
    <Card data-testid="studio-lipsync-insights">
      <CardHeader>
        <CardTitle>Optional Studio lip-sync outcomes</CardTitle>
        <CardDescription>
          Compares privacy-safe funnel events from the last 30 days. Small groups are hidden.
        </CardDescription>
        <Tabs value={groupBy} onValueChange={(value) => setGroupBy(value as GroupBy)}>
          <TabsList>
            {(Object.keys(GROUP_LABELS) as GroupBy[]).map((value) => (
              <TabsTrigger key={value} value={value}>
                {GROUP_LABELS[value]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3" data-testid="studio-lipsync-loading">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : isError || !data ? (
          <p className="text-sm text-destructive">
            Could not load lip-sync insights. Try again in a moment.
          </p>
        ) : data.status === "empty" ? (
          <p className="text-sm text-muted-foreground">
            No optional lip-sync usage was recorded in this period. This view will populate after people use the control.
          </p>
        ) : data.status === "insufficient" ? (
          <p className="text-sm text-muted-foreground">
            More usage is needed before results can be shown. Each group needs at least {data.minimumGroupSize} accepted submissions.
          </p>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Ranked by finished videos, including successful finishes and recoveries. Toggle selection is only available by workflow. Skipped-job counts are unavailable by scene count because that event uses a different scene bucket.
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{GROUP_LABELS[groupBy]}</TableHead>
                  <TableHead className="text-right">Toggle on</TableHead>
                  <TableHead className="text-right">Accepted</TableHead>
                  <TableHead className="text-right">Eligible jobs</TableHead>
                  <TableHead className="text-right">Skipped jobs</TableHead>
                  <TableHead className="text-right">Succeeded</TableHead>
                  <TableHead className="text-right">Recovered</TableHead>
                  <TableHead className="text-right">Finished</TableHead>
                  <TableHead className="text-right">Failed</TableHead>
                  <TableHead className="text-right">Finish rate</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.groups.map((group) => (
                  <TableRow key={group.group}>
                    <TableCell className="font-medium">{label(group.group)}</TableCell>
                    {group.status === "suppressed" ? (
                      <TableCell colSpan={9} className="text-right text-muted-foreground">
                        Hidden — fewer than {data.minimumGroupSize} accepted submissions
                      </TableCell>
                    ) : (
                      <>
                        <TableCell className="text-right">{group.toggleEnabled ?? "—"}</TableCell>
                        <TableCell className="text-right">{group.accepted}</TableCell>
                        <TableCell className="text-right">{group.eligible}</TableCell>
                        <TableCell className="text-right">{group.skipped ?? "—"}</TableCell>
                        <TableCell className="text-right">{group.succeeded}</TableCell>
                        <TableCell className="text-right">{group.recovered}</TableCell>
                        <TableCell className="text-right font-semibold">{group.finished}</TableCell>
                        <TableCell className="text-right">{group.failed}</TableCell>
                        <TableCell className="text-right">{(group.finishRate * 100).toFixed(1)}%</TableCell>
                      </>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}