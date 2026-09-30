import { useEffect, useState } from "react";
import { SignIn, SignUp, useAuth } from "@clerk/react";
import { ArrowRight, Check, Clapperboard, LayoutDashboard } from "lucide-react";
import { Link, useLocation, useSearch } from "wouter";
import { useBrand } from "@/lib/brand";
import { usePageMeta } from "@/lib/seo";
import { savePlanIntent } from "@/lib/planIntent";
import { authFlowTarget, authSwitchUrl, updateAuthFlowTarget } from "@/lib/creator-entry";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function AuthHeader({ subtitle }: { subtitle: string }) {
  const { logoUrl, appName } = useBrand();
  const [failedLogoUrl, setFailedLogoUrl] = useState<string | null>(null);
  return (
    <div className="text-center mb-7 flex flex-col items-center">
      {logoUrl && failedLogoUrl !== logoUrl ? (
        <img src={logoUrl} alt={appName} onError={() => setFailedLogoUrl(logoUrl)} className="h-10 w-auto mb-3" data-testid="img-auth-logo" />
      ) : (
        <span className="text-2xl font-black tracking-tight text-violet-600 dark:text-violet-400" data-testid="text-auth-brand">{appName || "KOKAO"}</span>
      )}
      <p className="text-muted-foreground mt-2" data-testid="text-auth-subtitle">{subtitle}</p>
    </div>
  );
}

function AuthEntry({ page }: { page: "sign-in" | "sign-up" }) {
  // The URL owns the choice; tab storage bridges only Clerk's query-less
  // internal callback/factor paths and is cleared on a fresh entry or sign-in.
  const [location, setLocation] = useLocation();
  const search = useSearch();
  const { isLoaded, isSignedIn } = useAuth();
  const [showRecovery, setShowRecovery] = useState(false);
  const pathname = location;
  const target = authFlowTarget(search, pathname, basePath);
  useEffect(() => {
    if (!isLoaded) return;
    updateAuthFlowTarget(search, pathname, Boolean(isSignedIn), basePath);
    // Clerk may finish on its nested callback URL without performing its
    // final navigation. Do not strand an authenticated user there.
    if (isSignedIn && /\/(?:sign-in|sign-up)\/.+/.test(pathname)) {
      setLocation(target, { replace: true });
    }
  }, [search, pathname, isLoaded, isSignedIn, setLocation, target]);
  useEffect(() => {
    if (isLoaded) {
      setShowRecovery(false);
      return;
    }
    const timer = window.setTimeout(() => setShowRecovery(true), 8000);
    return () => window.clearTimeout(timer);
  }, [isLoaded]);
  const isCreator = target === "/creator";
  const workspaceTarget = isCreator ? "/dashboard" : target;
  const selectedTarget = isCreator ? "/creator" : workspaceTarget;
  const otherPage = page === "sign-in" ? "sign-up" : "sign-in";
  const clerkReturnUrl = `${basePath}${selectedTarget}`;
  const creatorUrl = authSwitchUrl(page, "/creator");
  const workspaceUrl = authSwitchUrl(page, workspaceTarget);

  return (
    <div className="min-h-screen w-full bg-gray-50 px-4 py-10 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100 sm:py-16">
      <div className="mx-auto w-full max-w-md">
        <AuthHeader subtitle={page === "sign-in" ? "Welcome back. Choose where to continue." : "One account, two ways to create."} />
        <fieldset className="mb-6 space-y-3">
          <legend className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-200">
            Continue to
          </legend>
          <Link
            href={isSignedIn ? workspaceTarget : workspaceUrl}
            aria-current={!isCreator ? "page" : undefined}
            data-testid="link-auth-workspace"
            className={`flex items-center gap-4 rounded-2xl border p-4 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600 ${!isCreator ? "border-violet-500 bg-violet-50 shadow-sm dark:bg-violet-950/40" : "border-zinc-200 bg-white hover:border-violet-300 dark:border-zinc-800 dark:bg-zinc-900"}`}
          >
            <span className="rounded-xl bg-violet-100 p-2.5 text-violet-700 dark:bg-violet-900 dark:text-violet-200"><LayoutDashboard size={21} aria-hidden="true" /></span>
            <span className="min-w-0 flex-1"><span className="block font-semibold">KOKAO workspace</span><span className="block text-sm text-zinc-600 dark:text-zinc-400">Create, schedule and publish content</span></span>
            {!isCreator && <Check size={18} className="text-violet-600" aria-hidden="true" />}
          </Link>
          <Link
            href={isSignedIn ? "/creator" : creatorUrl}
            aria-current={isCreator ? "page" : undefined}
            data-testid="link-auth-creator"
            className={`flex items-center gap-4 rounded-2xl border p-4 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600 ${isCreator ? "border-violet-500 bg-violet-50 shadow-sm dark:bg-violet-950/40" : "border-zinc-200 bg-white hover:border-violet-300 dark:border-zinc-800 dark:bg-zinc-900"}`}
          >
            <span className="rounded-xl bg-fuchsia-100 p-2.5 text-fuchsia-700 dark:bg-fuchsia-900 dark:text-fuchsia-200"><Clapperboard size={21} aria-hidden="true" /></span>
            <span className="min-w-0 flex-1"><span className="block font-semibold">Creator Program</span><span className="block text-sm text-zinc-600 dark:text-zinc-400">Your dedicated creator portal</span></span>
            {isCreator && <Check size={18} className="text-violet-600" aria-hidden="true" />}
          </Link>
        </fieldset>
        {!isLoaded ? (
          <div className="rounded-2xl border border-zinc-200 bg-white p-6 text-center shadow-sm dark:border-zinc-800 dark:bg-zinc-900" role="status" data-testid="status-auth-loading">
            <p className="font-medium">Connecting to KOKAO…</p>
            {showRecovery && (
              <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-300" data-testid="text-auth-recovery">
                Taking longer than expected?{" "}
                <a
                  href={`${basePath}${authSwitchUrl(page, selectedTarget)}&retry=${Date.now()}`}
                  className="font-medium text-violet-600 underline dark:text-violet-400"
                  data-testid="link-auth-retry"
                >
                  Try again
                </a>
              </p>
            )}
          </div>
        ) : isSignedIn ? (
          <div className="rounded-2xl border border-zinc-200 bg-white p-5 text-center shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-300" data-testid="text-auth-signed-in">You're already signed in. Continue with your KOKAO account.</p>
            <Link href={selectedTarget} data-testid="link-auth-continue" className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-5 py-3 font-semibold text-white hover:bg-violet-700">
              Continue to {isCreator ? "Creator Program" : "workspace"} <ArrowRight size={17} aria-hidden="true" />
            </Link>
          </div>
        ) : (
          <>
            {page === "sign-in" ? (
              <SignIn
                key={selectedTarget}
                routing="path"
                path={`${basePath}/sign-in`}
                signUpUrl={`${basePath}${authSwitchUrl(otherPage, selectedTarget)}`}
                forceRedirectUrl={clerkReturnUrl}
                fallbackRedirectUrl={clerkReturnUrl}
              />
            ) : (
              <SignUp
                key={selectedTarget}
                routing="path"
                path={`${basePath}/sign-up`}
                signInUrl={`${basePath}${authSwitchUrl(otherPage, selectedTarget)}`}
                forceRedirectUrl={clerkReturnUrl}
                fallbackRedirectUrl={clerkReturnUrl}
              />
            )}
          </>
        )}
        <p className="mt-6 text-center text-xs text-zinc-500 dark:text-zinc-400" data-testid="text-auth-account-note">
          Both destinations use the same KOKAO account.
        </p>
      </div>
    </div>
  );
}

export function SignInPage() {
  usePageMeta(
    "Sign In — KOKAO",
    "Sign in to KOKAO, the AI social media content studio, to create, schedule and publish on-brand content.",
  );
  return <AuthEntry page="sign-in" />;
}

export function SignUpPage() {
  // Capture the plan + cycle chosen on the public pricing page. Clerk's
  // multi-step sign-up flow drops query params across redirects, so stash the
  // intent in localStorage; the billing flow consumes it after sign-up.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const planId = params.get("plan");
    const cycle = params.get("cycle");
    if (planId) {
      savePlanIntent(planId, cycle === "yearly" ? "yearly" : "monthly");
    }
  }, []);
  usePageMeta(
    "Sign Up Free — KOKAO",
    "Create a free KOKAO account and start generating on-brand captions, images and videos with auto-publishing to your social accounts.",
  );
  return <AuthEntry page="sign-up" />;
}
