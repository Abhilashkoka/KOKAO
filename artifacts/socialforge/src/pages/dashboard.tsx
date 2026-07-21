import { useGetMe, useListContent, useListSchedules } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Sparkles, Image as ImageIcon, Calendar as CalendarIcon, Clock, Layers, Wand2 } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { useFeatureFlags } from "@/lib/features";

export function DashboardPage() {
  const { data: me, isLoading: meLoading } = useGetMe();
  const { data: content, isLoading: contentLoading } = useListContent();
  const { data: schedules, isLoading: schedulesLoading } = useListSchedules();
  const { flags: featureFlags } = useFeatureFlags();

  if (meLoading || contentLoading || schedulesLoading) {
    return (
      <div className="space-y-8 animate-in fade-in duration-500">
        <Skeleton className="h-12 w-64" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Skeleton className="h-40 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <Skeleton className="h-96 rounded-xl" />
          <Skeleton className="h-96 rounded-xl" />
        </div>
      </div>
    );
  }

  const recentContent = content?.slice(0, 5) || [];
  const upcomingSchedules = schedules?.filter(s => new Date(s.scheduledAt) > new Date()).sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime()).slice(0, 5) || [];

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight">Welcome back, {me?.tenant.name}</h1>
          <p className="text-muted-foreground text-lg mt-1">Here's what's happening in your workspace today.</p>
        </div>
        <Link href="/studio">
          <Button size="lg" className="shrink-0" data-testid="button-open-studio">
            <Wand2 className="h-4 w-4 mr-2" /> Open AI Studio
          </Button>
        </Link>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="shadow-sm border-border overflow-hidden relative">
          <div className="absolute top-0 right-0 w-32 h-32 bg-primary/5 rounded-full -mr-10 -mt-10 blur-2xl pointer-events-none" />
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" /> Captions Generated
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-bold tracking-tight mb-2">{me?.usage.captions}</div>
            {me?.limits.captions !== -1 ? (
              <div className="space-y-2">
                <Progress value={(me?.usage.captions || 0) / (me?.limits.captions || 1) * 100} className="h-2" />
                <p className="text-xs text-muted-foreground">{(me?.limits.captions ?? 0) - (me?.usage.captions || 0)} remaining this month</p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Unlimited usage</p>
            )}
          </CardContent>
        </Card>

        <Card className="shadow-sm border-border overflow-hidden relative">
          <div className="absolute top-0 right-0 w-32 h-32 bg-primary/5 rounded-full -mr-10 -mt-10 blur-2xl pointer-events-none" />
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <ImageIcon className="h-4 w-4 text-primary" /> Images Generated
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-bold tracking-tight mb-2">{me?.usage.images}</div>
            {me?.limits.images !== -1 ? (
              <div className="space-y-2">
                <Progress value={(me?.usage.images || 0) / (me?.limits.images || 1) * 100} className="h-2" />
                <p className="text-xs text-muted-foreground">{(me?.limits.images ?? 0) - (me?.usage.images || 0)} remaining this month</p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Unlimited usage</p>
            )}
          </CardContent>
        </Card>

        <Card className="shadow-sm border-border overflow-hidden relative bg-primary text-primary-foreground">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-primary-foreground/80 flex items-center gap-2">
              <Layers className="h-4 w-4" /> Current Plan
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-bold tracking-tight mb-2 capitalize">{me?.tenant.plan}</div>
            <p className="text-sm text-primary-foreground/80">Using {me?.tenant.aiModel} model</p>
            {featureFlags.billing && (
              <Link href="/settings?tab=billing">
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-4"
                  data-testid="button-change-plan"
                >
                  Upgrade / change plan
                </Button>
              </Link>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <Card className="shadow-sm border-border flex flex-col">
          <CardHeader className="flex flex-row items-center justify-between border-b pb-4">
            <div>
              <CardTitle className="text-xl">Recent Content</CardTitle>
              <CardDescription>Your latest drafts and generated ideas</CardDescription>
            </div>
            <Link href="/library">
              <Button variant="outline" size="sm">View All</Button>
            </Link>
          </CardHeader>
          <CardContent className="p-0 flex-1">
            {recentContent.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground flex flex-col items-center justify-center h-full">
                <Layers className="h-12 w-12 text-muted mb-4" />
                <p>No content yet.</p>
                <Link href="/studio">
                  <Button variant="link" className="mt-2 text-primary">Go to Studio</Button>
                </Link>
              </div>
            ) : (
              <div className="divide-y">
                {recentContent.map(item => (
                  <div key={item.id} className="p-4 hover:bg-muted/50 transition-colors flex justify-between items-center group">
                    <div>
                      <h4 className="font-semibold truncate max-w-[200px] sm:max-w-xs">{item.title}</h4>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <span className="text-xs px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground uppercase font-medium">{item.status}</span>
                        {Object.keys(item.publishedPlatforms ?? {}).length > 0 ? (
                          Object.keys(item.publishedPlatforms ?? {}).map(p => (
                            <span key={p} className="text-xs text-muted-foreground capitalize">{p === "twitter" ? "X" : p}</span>
                          ))
                        ) : (
                          <span className="text-xs text-muted-foreground capitalize">{item.platform}</span>
                        )}
                      </div>
                    </div>
                    <Link href={`/library`}>
                      <Button variant="ghost" size="icon" className="opacity-0 group-hover:opacity-100 transition-opacity">
                        <ArrowRight className="h-4 w-4" />
                      </Button>
                    </Link>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="shadow-sm border-border flex flex-col">
          <CardHeader className="flex flex-row items-center justify-between border-b pb-4">
            <div>
              <CardTitle className="text-xl">Upcoming Posts</CardTitle>
              <CardDescription>Scheduled for publishing</CardDescription>
            </div>
            <Link href="/schedule">
              <Button variant="outline" size="sm">Calendar</Button>
            </Link>
          </CardHeader>
          <CardContent className="p-0 flex-1">
            {upcomingSchedules.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground flex flex-col items-center justify-center h-full">
                <CalendarIcon className="h-12 w-12 text-muted mb-4" />
                <p>No upcoming scheduled posts.</p>
              </div>
            ) : (
              <div className="divide-y">
                {upcomingSchedules.map(post => {
                  const item = content?.find(c => c.id === post.contentItemId);
                  return (
                    <div key={post.id} className="p-4 hover:bg-muted/50 transition-colors flex items-start gap-4">
                      <div className="h-12 w-12 rounded-xl bg-primary/10 flex flex-col items-center justify-center shrink-0 border border-primary/20">
                        <span className="text-xs font-bold text-primary">{new Date(post.scheduledAt).getDate()}</span>
                        <span className="text-[10px] uppercase font-semibold text-primary/70">{new Date(post.scheduledAt).toLocaleString('default', { month: 'short' })}</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <h4 className="font-semibold truncate">{item?.title || 'Unknown Post'}</h4>
                        <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground">
                          <span className="flex items-center gap-1 capitalize"><Clock className="h-3 w-3" /> {new Date(post.scheduledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                          <span className="capitalize">{post.platform}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ArrowRight icon imported for the list items
import { ArrowRight } from "lucide-react";
