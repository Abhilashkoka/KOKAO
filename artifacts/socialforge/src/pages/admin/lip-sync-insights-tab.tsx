import { useState } from "react";
import { useGetStudioLipSyncAnalytics } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
type RangePreset = "7d" | "30d" | "90d" | "custom";

const DAY_MS = 86_400_000;
const MAX_CUSTOM_DAYS = 366;

function dateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dayBoundary(value: string, endOfDay: boolean): string {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(
    year!,
    month! - 1,
    day!,
    endOfDay ? 23 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 999 : 0,
  ).toISOString();
}

function presetWindow(days: number): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - days * DAY_MS);
  return { from: from.toISOString(), to: to.toISOString() };
}

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
  const [rangePreset, setRangePreset] = useState<RangePreset>("30d");
  const [range, setRange] = useState(() => presetWindow(30));
  const [customFrom, setCustomFrom] = useState(() =>
    dateInputValue(new Date(Date.now() - 30 * DAY_MS)),
  );
  const [customTo, setCustomTo] = useState(() => dateInputValue(new Date()));
  const today = dateInputValue(new Date());
  const customFromTime = new Date(`${customFrom}T00:00:00`).getTime();
  const customToTime = new Date(`${customTo}T00:00:00`).getTime();
  const customRangeValid =
    customFrom !== "" &&
    customTo !== "" &&
    Number.isFinite(customFromTime) &&
    Number.isFinite(customToTime) &&
    customFromTime <= customToTime &&
    customTo <= today &&
    customToTime - customFromTime <= MAX_CUSTOM_DAYS * DAY_MS;
  const { data, isLoading, isError } = useGetStudioLipSyncAnalytics({
    groupBy,
    from: range.from,
    to: range.to,
  });

  const selectPreset = (preset: Exclude<RangePreset, "custom">, days: number) => {
    setRangePreset(preset);
    setRange(presetWindow(days));
  };

  const applyCustomRange = () => {
    if (!customRangeValid) return;
    setRangePreset("custom");
    setRange({
      from: dayBoundary(customFrom, false),
      to: dayBoundary(customTo, true),
    });
  };

  return (
    <Card data-testid="studio-lipsync-insights">
      <CardHeader>
        <CardTitle>Optional Studio lip-sync outcomes</CardTitle>
        <CardDescription>
          Compares privacy-safe funnel events in the selected period. Small groups are hidden.
        </CardDescription>
        <div className="space-y-3 pt-2">
          <div className="flex flex-wrap gap-2" aria-label="Reporting period">
            {([
              ["7d", 7, "Last 7 days"],
              ["30d", 30, "Last 30 days"],
              ["90d", 90, "Last 90 days"],
            ] as const).map(([preset, days, text]) => (
              <Button
                key={preset}
                type="button"
                size="sm"
                variant={rangePreset === preset ? "default" : "outline"}
                onClick={() => selectPreset(preset, days)}
              >
                {text}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="lipsync-range-from">From</Label>
              <Input
                id="lipsync-range-from"
                type="date"
                className="w-[150px]"
                max={today}
                value={customFrom}
                onChange={(event) => setCustomFrom(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="lipsync-range-to">To</Label>
              <Input
                id="lipsync-range-to"
                type="date"
                className="w-[150px]"
                max={today}
                value={customTo}
                onChange={(event) => setCustomTo(event.target.value)}
              />
            </div>
            <Button
              type="button"
              size="sm"
              variant={rangePreset === "custom" ? "default" : "outline"}
              disabled={!customRangeValid}
              onClick={applyCustomRange}
            >
              Apply custom range
            </Button>
          </div>
          {!customRangeValid && (
            <p className="text-xs text-destructive">
              Choose dates in order, ending today or earlier, and no more than {MAX_CUSTOM_DAYS} days apart.
            </p>
          )}
        </div>
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