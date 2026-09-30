import { useEffect, useRef } from "react";
import { UserButton, useAuth } from "@clerk/react";
import { useGetMe } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { LogOut, RotateCw } from "lucide-react";

const CREATOR_RETURN = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/creator`;

/** Dedicated creator shell: no workspace sidebar, brand kit or onboarding wizard. */
export function CreatorLayout({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn, signOut } = useAuth();
  const me = useGetMe();
  const pending = useRef(false);

  // Same 401 session safety as the main app: a dead server session signs out once.
  useEffect(() => {
    if (isLoaded && isSignedIn && me.error?.status === 401) {
      if (!pending.current) { pending.current = true; void signOut({ redirectUrl: CREATOR_RETURN }); }
      return;
    }
    pending.current = false;
  }, [isLoaded, isSignedIn, me.error, signOut]);

  let body: React.ReactNode = children;
  if (!isLoaded || me.isLoading) body = <div data-testid="creator-shell-loading" className="space-y-4"><Skeleton className="h-10 w-56" /><Skeleton className="h-48" /></div>;
  else if (me.isError && me.error?.status !== 401) body = (
    <div role="alert" data-testid="creator-shell-error" className="mx-auto max-w-md rounded-2xl border border-border bg-card p-8 text-center">
      <h1 className="text-lg font-semibold">We couldn't reach your account</h1>
      <p className="mt-2 text-sm text-muted-foreground">Your creator account is still being set up or the service is briefly unavailable.</p>
      <Button className="mt-5" variant="outline" data-testid="button-creator-shell-retry" onClick={() => void me.refetch()}><RotateCw className="mr-2 h-4 w-4" />Try again</Button>
    </div>
  );
  else if (me.isError) body = <div data-testid="creator-shell-signing-out" className="text-center text-sm text-muted-foreground">Your session expired. Signing you out...</div>;

  return (
    <div className="min-h-[100dvh] w-full bg-[radial-gradient(ellipse_at_top,hsl(var(--primary)/0.08),transparent_60%)] bg-background">
      <header data-testid="creator-header" className="sticky top-0 z-40 border-b border-border/70 bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-3 px-4 sm:px-6">
          <div className="flex items-baseline gap-2">
            <span className="text-base font-bold tracking-[0.2em]">KOKAO</span>
            <span className="rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-primary" data-testid="text-creator-portal">Creator Portal</span>
          </div>
          <div className="flex items-center gap-3">
            <UserButton />
            <Button size="sm" variant="ghost" data-testid="button-creator-signout" onClick={() => void signOut({ redirectUrl: CREATOR_RETURN })}><LogOut className="mr-2 h-4 w-4" />Sign out</Button>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-10">{body}</main>
      <footer className="mx-auto max-w-5xl px-4 pb-8 text-xs text-muted-foreground sm:px-6">KOKAO Creator Programme. Payouts are manually reviewed.</footer>
    </div>
  );
}
