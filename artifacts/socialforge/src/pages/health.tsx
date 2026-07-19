import {
  useGetMe,
  useGetHealthReport,
  useRunHealthReport,
  getGetHealthReportQueryKey,
  type HealthCheckFinding,
  type HealthCategorySummary,
  type HealthReportOverview,
} from "@workspace/api-client-react";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  ShieldAlert,
  RefreshCw,
  CheckCircle2,
  XCircle,
  HelpCircle,
  MinusCircle,
  ArrowRight,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";

function scoreColor(score: number | null | undefined): string {
  if (score === null || score === undefined) return "hsl(var(--muted-foreground))";
  if (score >= 80) return "hsl(142, 71%, 40%)";
  if (score >= 60) return "hsl(38, 92%, 45%)";
  return "hsl(0, 72%, 51%)";
}

function ScoreDial({ score }: { score: number | null | undefined }) {
  const value = score ?? 0;
  const radius = 70;
  const circumference = 2 * Math.PI * radius;
  const filled = (value / 100) * circumference;
  const color = scoreColor(score);
  return (
    <div className="relative h-44 w-44" data-testid="health-score-dial">
      <svg viewBox="0 0 180 180" className="h-full w-full -rotate-90">
        <circle
          cx="90"
          cy="90"
          r={radius}
          fill="none"
          stroke="hsl(var(--muted))"
          strokeWidth="14"
        />
        <circle
          cx="90"
          cy="90"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="14"
          strokeLinecap="round"
          strokeDasharray={`${filled} ${circumference - filled}`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-4xl font-extrabold" style={{ color }} data-testid="text-health-score">
          {score === null || score === undefined ? "—" : score}
        </span>
        <span className="text-xs text-muted-foreground">out of 100</span>
      </div>
    </div>
  );
}

function CoverageBadge({
  coverage,
  grade,
}: {
  coverage: number;
  grade: string;
}) {
  const label =
    grade === "graded"
      ? "Full score"
      : grade === "provisional"
        ? "Provisional score"
        : "Not enough data";
  const variant =
    grade === "graded" ? "default" : grade === "provisional" ? "secondary" : "destructive";
  return (
    <Badge variant={variant as "default" | "secondary" | "destructive"} data-testid="badge-coverage">
      {label} · {coverage}% of checks had data
    </Badge>
  );
}

const STATUS_META: Record<
  string,
  { icon: typeof CheckCircle2; className: string; label: string }
> = {
  pass: { icon: CheckCircle2, className: "text-green-600", label: "Pass" },
  fail: { icon: XCircle, className: "text-red-600", label: "Needs attention" },
  unknown: { icon: HelpCircle, className: "text-muted-foreground", label: "No data" },
  not_applicable: {
    icon: MinusCircle,
    className: "text-muted-foreground",
    label: "Not applicable",
  },
};

function FindingRow({ finding }: { finding: HealthCheckFinding }) {
  const meta = STATUS_META[finding.status] ?? STATUS_META.unknown;
  const Icon = meta.icon;
  // Findings that need attention start open; everything else starts collapsed.
  const [open, setOpen] = useState(finding.status === "fail");
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div
      className="py-3 border-b border-border last:border-b-0"
      data-testid={`finding-${finding.id}`}
    >
      <button
        type="button"
        className="flex w-full items-start gap-3 text-left"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid={`finding-toggle-${finding.id}`}
      >
        <Icon className={`h-5 w-5 mt-0.5 shrink-0 ${meta.className}`} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{finding.title}</span>
            <span className="text-xs text-muted-foreground">{meta.label}</span>
          </span>
        </span>
        <Chevron className="h-4 w-4 mt-1 shrink-0 text-muted-foreground" />
      </button>
      {open && (
      <div className="min-w-0 flex-1 pl-8">
        <p className="text-sm text-muted-foreground mt-0.5">{finding.explanation}</p>
        {finding.evidence.length > 0 && (
          <ul className="text-xs text-muted-foreground mt-1 list-disc pl-4 space-y-0.5">
            {finding.evidence.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        )}
        {finding.recommendation && finding.status === "fail" && (
          <p className="text-sm mt-1.5">
            {finding.recommendation}
            {finding.actionPath && (
              <Link href={finding.actionPath}>
                <span className="inline-flex items-center gap-1 ml-2 text-primary cursor-pointer hover:underline">
                  Go there <ArrowRight className="h-3.5 w-3.5" />
                </span>
              </Link>
            )}
          </p>
        )}
      </div>
      )}
    </div>
  );
}

function CategoryCard({
  category,
  findings,
}: {
  category: HealthCategorySummary;
  findings: HealthCheckFinding[];
}) {
  return (
    <Card data-testid={`category-${category.category}`}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-lg">{category.label}</CardTitle>
          <span
            className="text-lg font-bold"
            style={{ color: scoreColor(category.score ?? null) }}
          >
            {category.score === null || category.score === undefined
              ? "No data"
              : `${category.score}/100`}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          {category.passed} passed · {category.failed} need attention
          {category.unknown > 0 ? ` · ${category.unknown} without data` : ""}
          {category.notApplicable > 0 ? ` · ${category.notApplicable} not applicable` : ""}
        </p>
      </CardHeader>
      <CardContent>
        {findings.map((f) => (
          <FindingRow key={f.id} finding={f} />
        ))}
      </CardContent>
    </Card>
  );
}

function TrendChart({ history }: { history: HealthReportOverview["history"] }) {
  const points = history
    .filter((h) => h.score !== null && h.score !== undefined)
    .map((h) => ({
      date: new Date(h.createdAt).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      }),
      score: h.score as number,
    }));
  if (points.length < 2) {
    return (
      <p className="text-sm text-muted-foreground">
        Run the audit a few more times to see how your score changes over time.
      </p>
    );
  }
  return (
    <div className="h-56 w-full" data-testid="health-trend-chart">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 8, right: 16, bottom: 0, left: -16 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
          <XAxis dataKey="date" tick={{ fontSize: 12 }} />
          <YAxis domain={[0, 100]} tick={{ fontSize: 12 }} />
          <Tooltip />
          <Line
            type="monotone"
            dataKey="score"
            stroke="hsl(var(--primary))"
            strokeWidth={2}
            dot={{ r: 3 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function HealthPage() {
  const { data: me } = useGetMe();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const role = me?.team?.role;
  const isWorkspaceAdmin = !me?.team || role === "owner" || role === "admin";
  const accessDenied = me && !me.isSuperadmin && !isWorkspaceAdmin;

  const { data, isLoading } = useGetHealthReport({
    query: { queryKey: getGetHealthReportQueryKey(), enabled: !accessDenied },
  });

  const runMutation = useRunHealthReport({
    mutation: {
      onSuccess: (fresh) => {
        queryClient.setQueryData(getGetHealthReportQueryKey(), fresh);
        toast({ title: "Health audit finished" });
      },
      onError: () => {
        toast({
          title: "Audit failed",
          description: "Could not run the health audit. Please try again.",
          variant: "destructive",
        });
      },
    },
  });

  if (accessDenied) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <ShieldAlert className="h-12 w-12 text-muted-foreground mb-4" />
        <h1 className="text-2xl font-bold">Access denied</h1>
        <p className="text-muted-foreground mt-2">
          Health reports are available to workspace owners and admins only.
        </p>
      </div>
    );
  }

  const latest = data?.latest ?? null;
  const history = data?.history ?? [];

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight">Account Health</h1>
          <p className="text-muted-foreground text-lg mt-1">
            A checkup of your social connections, publishing habits, and setup.
          </p>
        </div>
        <Button
          onClick={() => runMutation.mutate()}
          disabled={runMutation.isPending}
          data-testid="button-run-audit"
        >
          <RefreshCw
            className={`h-4 w-4 mr-2 ${runMutation.isPending ? "animate-spin" : ""}`}
          />
          {runMutation.isPending
            ? "Running checkup..."
            : latest
              ? "Run new checkup"
              : "Run first checkup"}
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-44 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : !latest ? (
        <Card>
          <CardContent className="py-16 text-center">
            <p className="text-lg font-medium">No checkup yet</p>
            <p className="text-muted-foreground mt-1">
              Run your first checkup to get a health score and a list of things
              worth fixing.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardContent className="flex flex-col md:flex-row items-center gap-8 py-6">
              <ScoreDial score={latest.score} />
              <div className="flex-1 space-y-3 text-center md:text-left">
                <CoverageBadge coverage={latest.coverage} grade={latest.coverageGrade} />
                <p className="text-sm text-muted-foreground">
                  {latest.coverageGrade === "insufficient"
                    ? "Too many checks had no data to give a reliable score. Connect accounts and publish some content, then run the checkup again."
                    : latest.coverageGrade === "provisional"
                      ? "Some checks had no data, so treat this score as an estimate."
                      : "This score is based on checks where we had real data — nothing is guessed."}
                </p>
                <p className="text-xs text-muted-foreground">
                  Last run {new Date(latest.createdAt).toLocaleString()}
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-lg">Score over time</CardTitle>
            </CardHeader>
            <CardContent>
              <TrendChart history={history} />
            </CardContent>
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            {latest.categories.map((cat) => (
              <CategoryCard
                key={cat.category}
                category={cat}
                findings={latest.checks.filter((c) => c.category === cat.category)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
