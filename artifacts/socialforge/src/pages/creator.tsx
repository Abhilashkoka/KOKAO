import { ApiError, getPromoterMeQueryKey, usePromoterMe } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CreatorLayout } from "@/components/creator-layout";
import { CreatorLegalGate } from "@/components/creator-legal-gate";
import { PromoterApplyForm, PromoterDashboard } from "@/pages/promoter";

function Panel({ testId, eyebrow, title, body, children }: { testId: string; eyebrow: string; title: string; body: string; children?: React.ReactNode }) {
  return <section data-testid={testId} className="mx-auto max-w-xl rounded-2xl border border-border bg-card p-8">
    <p className="text-xs font-semibold uppercase tracking-wider text-primary">{eyebrow}</p>
    <h1 className="mt-2 text-2xl font-semibold tracking-tight">{title}</h1>
    <p className="mt-2 text-sm text-muted-foreground">{body}</p>
    {children}
  </section>;
}

function errorCode(error: unknown) {
  const data: unknown = error instanceof ApiError ? error.data : null;
  return data && typeof data === "object" && "code" in data ? data.code : undefined;
}

function CreatorLifecycle() {
  const me = usePromoterMe({ query: { queryKey: getPromoterMeQueryKey(), retry: false } });
  if (me.isLoading) return <div data-testid="creator-loading" className="space-y-4"><Skeleton className="h-10 w-48" /><Skeleton className="h-40" /><Skeleton className="h-64" /></div>;
  if (me.isError) {
    const code = errorCode(me.error);
    if (me.error?.status === 404 && code === "not_a_promoter") return <div data-testid="creator-apply"><div className="mx-auto mb-2 max-w-xl"><p className="text-xs font-semibold uppercase tracking-wider text-primary">Step 1 of 2: Apply</p><p className="mt-1 text-sm text-muted-foreground">Submit your details to join the creator programme.</p></div><PromoterApplyForm /></div>;
    if (me.error?.status === 403 && code === "feature_disabled") return <Panel testId="creator-closed" eyebrow="Programme closed" title="The creator programme is closed" body="We're not accepting creators right now." />;
    return <Panel testId="creator-error" eyebrow="Something went wrong" title="Couldn't load your creator account" body="Please try again in a moment."><Button className="mt-5" variant="outline" data-testid="button-creator-retry" onClick={() => void me.refetch()}>Try again</Button></Panel>;
  }
  const data = me.data;
  if (!data) return <Panel testId="creator-error" eyebrow="Something went wrong" title="Couldn't load your creator account" body="Please try again."><Button className="mt-5" variant="outline" data-testid="button-creator-retry" onClick={() => void me.refetch()}>Try again</Button></Panel>;
  if (data.status === "applied") return <Panel testId="creator-pending" eyebrow="Step 2 of 2: Review" title="Application under review" body="Your application is awaiting review. Check back here for updates." />;
  if (data.status === "rejected") return <Panel testId="creator-rejected" eyebrow="Decision" title="Application not approved" body={data.statusReason || "Your application wasn't approved this time."} />;
  if (data.status !== "approved" && data.status !== "suspended") return <Panel testId="creator-unavailable" eyebrow="Account" title="Creator account unavailable" body="Please contact support." />;
  return <div data-testid="creator-dashboard" className="-mx-4 sm:-mx-6"><PromoterDashboard data={data} title="Creator dashboard" /></div>;
}

export default function CreatorPortalPage() {
  return <CreatorLayout><CreatorLegalGate><CreatorLifecycle /></CreatorLegalGate></CreatorLayout>;
}
