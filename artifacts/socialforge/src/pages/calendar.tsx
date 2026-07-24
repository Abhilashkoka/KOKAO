import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  useListSchedules,
  useListContent,
  useListPostMetrics,
  getListPostMetricsQueryKey,
} from "@workspace/api-client-react";
import { useFeatureFlags } from "@/lib/features";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LogoLoader } from "@/components/logo-loader";
import { cn } from "@/lib/utils";
import {
  format,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  addMonths,
  isSameMonth,
  isSameDay,
} from "date-fns";
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  CheckCircle2,
  XCircle,
  Heart,
  MessageCircle,
} from "lucide-react";

const PLATFORM_LABELS: Record<string, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  linkedin: "LinkedIn",
  twitter: "X",
  threads: "Threads",
  youtube: "YouTube",
};

interface CalendarEntry {
  key: string;
  date: Date;
  kind: "scheduled" | "published";
  status: string;
  platform: string;
  title: string;
  contentItemId: number;
  likes?: number;
  comments?: number;
}

export function CalendarPage() {
  const [, navigate] = useLocation();
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const { flags } = useFeatureFlags();
  const { data: schedules, isLoading: sLoading } = useListSchedules();
  const { data: content, isLoading: cLoading } = useListContent();
  const { data: metrics } = useListPostMetrics({
    query: { queryKey: getListPostMetricsQueryKey(), enabled: flags.postMetrics },
  });

  const contentById = useMemo(() => {
    const map = new Map<number, NonNullable<typeof content>[number]>();
    for (const c of content ?? []) map.set(c.id, c);
    return map;
  }, [content]);

  const metricsByKey = useMemo(() => {
    const map = new Map<string, { likes: number; comments: number }>();
    for (const m of metrics ?? []) {
      map.set(`${m.contentItemId}:${m.platform}`, {
        likes: m.likes,
        comments: m.comments,
      });
    }
    return map;
  }, [metrics]);

  const entries = useMemo(() => {
    const list: CalendarEntry[] = [];
    for (const s of schedules ?? []) {
      // Published schedules also appear via the content item's
      // publishedPlatforms map; skip them here to avoid duplicates.
      if (s.status === "published") continue;
      const item = contentById.get(s.contentItemId);
      list.push({
        key: `s-${s.id}`,
        date: new Date(s.scheduledAt),
        kind: "scheduled",
        status: s.status,
        platform: s.platform,
        title: item?.title || "Untitled",
        contentItemId: s.contentItemId,
      });
    }
    for (const c of content ?? []) {
      const published = c.publishedPlatforms ?? {};
      for (const [platform, info] of Object.entries(published)) {
        if (!info?.publishedAt) continue;
        const m = metricsByKey.get(`${c.id}:${platform}`);
        list.push({
          key: `p-${c.id}-${platform}`,
          date: new Date(info.publishedAt),
          kind: "published",
          status: "published",
          platform,
          title: c.title || "Untitled",
          contentItemId: c.id,
          likes: m?.likes,
          comments: m?.comments,
        });
      }
    }
    return list;
  }, [schedules, content, contentById, metricsByKey]);

  const days = useMemo(() => {
    const gridStart = startOfWeek(startOfMonth(month), { weekStartsOn: 1 });
    const gridEnd = endOfWeek(endOfMonth(month), { weekStartsOn: 1 });
    return eachDayOfInterval({ start: gridStart, end: gridEnd });
  }, [month]);

  if (sLoading || cLoading) {
    return (
      <div className="flex justify-center py-24">
        <LogoLoader />
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="page-calendar">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Content Calendar</h1>
          <p className="text-sm text-muted-foreground">
            Scheduled and published posts, by day.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={() => setMonth((m) => addMonths(m, -1))}
            data-testid="button-prev-month"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="w-40 text-center font-medium" data-testid="text-month">
            {format(month, "MMMM yyyy")}
          </div>
          <Button
            variant="outline"
            size="icon"
            onClick={() => setMonth((m) => addMonths(m, 1))}
            data-testid="button-next-month"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            onClick={() => setMonth(startOfMonth(new Date()))}
            data-testid="button-today"
          >
            Today
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-2 sm:p-4">
          <div className="grid grid-cols-7 gap-px text-center text-xs font-medium text-muted-foreground mb-1">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
              <div key={d} className="py-1">
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-px bg-border rounded-md overflow-hidden">
            {days.map((day) => {
              const dayEntries = entries
                .filter((e) => isSameDay(e.date, day))
                .sort((a, b) => a.date.getTime() - b.date.getTime());
              const isToday = isSameDay(day, new Date());
              return (
                <div
                  key={day.toISOString()}
                  className={cn(
                    "bg-background min-h-24 p-1.5 space-y-1",
                    !isSameMonth(day, month) && "opacity-40",
                  )}
                >
                  <div
                    className={cn(
                      "text-xs font-medium inline-flex h-5 w-5 items-center justify-center rounded-full",
                      isToday && "bg-primary text-primary-foreground",
                    )}
                  >
                    {format(day, "d")}
                  </div>
                  {dayEntries.map((e) => (
                    <button
                      key={e.key}
                      type="button"
                      onClick={() => navigate("/library")}
                      className={cn(
                        "w-full text-left rounded px-1.5 py-1 text-[11px] leading-tight border transition-colors hover:bg-accent",
                        e.kind === "published"
                          ? "border-green-500/30 bg-green-500/10"
                          : e.status === "failed"
                            ? "border-destructive/30 bg-destructive/10"
                            : "border-primary/20 bg-primary/5",
                      )}
                      data-testid={`calendar-entry-${e.key}`}
                    >
                      <div className="flex items-center gap-1">
                        {e.kind === "published" ? (
                          <CheckCircle2 className="h-3 w-3 shrink-0 text-green-600" />
                        ) : e.status === "failed" ? (
                          <XCircle className="h-3 w-3 shrink-0 text-destructive" />
                        ) : (
                          <Clock className="h-3 w-3 shrink-0 text-primary" />
                        )}
                        <span className="truncate font-medium">{e.title}</span>
                      </div>
                      <div className="flex items-center gap-2 text-muted-foreground mt-0.5">
                        <span>{PLATFORM_LABELS[e.platform] ?? e.platform}</span>
                        {e.likes !== undefined && (
                          <span className="inline-flex items-center gap-0.5">
                            <Heart className="h-2.5 w-2.5" />
                            {e.likes}
                          </span>
                        )}
                        {e.comments !== undefined && (
                          <span className="inline-flex items-center gap-0.5">
                            <MessageCircle className="h-2.5 w-2.5" />
                            {e.comments}
                          </span>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
        <Badge variant="outline" className="gap-1">
          <Clock className="h-3 w-3 text-primary" /> Scheduled
        </Badge>
        <Badge variant="outline" className="gap-1">
          <CheckCircle2 className="h-3 w-3 text-green-600" /> Published
        </Badge>
        <Badge variant="outline" className="gap-1">
          <XCircle className="h-3 w-3 text-destructive" /> Failed
        </Badge>
      </div>
    </div>
  );
}
