import { createContext, useContext } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import type { NameCount } from "@workspace/api-client-react";

export interface AnalyticsScope {
  from?: string;
  to?: string;
  tenantId?: number;
}

const ScopeContext = createContext<AnalyticsScope>({});

export const ScopeProvider = ScopeContext.Provider;

export function useAnalyticsParams(): AnalyticsScope {
  return useContext(ScopeContext);
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat("en-IN").format(n);
}

export function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

export function formatPaise(paise: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(paise / 100);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold" data-testid={`stat-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}>
          {value}
        </div>
        {hint && <p className="text-xs text-muted-foreground mt-1">{hint}</p>}
      </CardContent>
    </Card>
  );
}

export function StatGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{children}</div>
  );
}

export function TabLoading() {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-28 w-full" />
        ))}
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

export function TabError({ message }: { message?: string }) {
  return (
    <Card>
      <CardContent className="py-10 text-center text-muted-foreground">
        {message ?? "Could not load analytics data. Try again in a moment."}
      </CardContent>
    </Card>
  );
}

export function NameCountTable({
  title,
  rows,
  nameHeader = "Name",
  emptyText = "No data in this period.",
  formatCount = formatNumber,
}: {
  title: string;
  rows: NameCount[];
  nameHeader?: string;
  emptyText?: string;
  formatCount?: (n: number) => string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{emptyText}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{nameHeader}</TableHead>
                <TableHead className="text-right">Count</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.name}>
                  <TableCell className="max-w-[280px] truncate">{row.name || "(unknown)"}</TableCell>
                  <TableCell className="text-right">{formatCount(row.count)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export function TwoColumn({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-4 lg:grid-cols-2">{children}</div>;
}

export function TrendBars({
  title,
  points,
}: {
  title: string;
  points: { date: string; count: number }[];
}) {
  const max = Math.max(1, ...points.map((p) => p.count));
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {points.length === 0 ? (
          <p className="text-sm text-muted-foreground">No data in this period.</p>
        ) : (
          <div className="flex items-end gap-1 h-32">
            {points.map((p) => (
              <div
                key={p.date}
                className="flex-1 bg-primary/70 rounded-t-sm min-w-[2px]"
                style={{ height: `${Math.max(3, (p.count / max) * 100)}%` }}
                title={`${p.date}: ${formatNumber(p.count)}`}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
