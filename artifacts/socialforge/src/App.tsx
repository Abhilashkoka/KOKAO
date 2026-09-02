import { AppLayout } from "@/components/layout";
import { BrandProvider } from "@/lib/brand";
import { readPlanIntent } from "@/lib/planIntent";
import { FeatureGate, type FeatureId } from "@/lib/features";

import { Switch, Route, Redirect, useLocation, Router as WouterRouter } from "wouter";
import {
  QueryCache,
  MutationCache,
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import {
  handleAdminForbidden,
  handleAdminQuerySuccess,
  resetAdminAccessRevoked,
} from "@/lib/admin-guard";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AnalyticsTracker } from "@/components/analytics-tracker";
import {
  ClerkBootstrapReady,
  ClerkBootstrapRecovery,
} from "@/components/clerk-bootstrap-recovery";

import {
  ClerkLoaded,
  ClerkLoading,
  ClerkProvider,
  Show,
  useClerk,
} from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { lazy, Suspense, useEffect, useRef } from "react";
import { navigate } from "wouter/use-browser-location";

// Video Studio now lives inside AI Studio as a tab; keep old links working.
const LandingPage = lazy(() => import("@/pages/landing").then((m) => ({ default: m.LandingPage })));
const PrivacyPage = lazy(() => import("@/pages/privacy").then((m) => ({ default: m.PrivacyPage })));
const DashboardPage = lazy(() => import("@/pages/dashboard").then((m) => ({ default: m.DashboardPage })));
const SignInPage = lazy(() => import("@/pages/auth").then((m) => ({ default: m.SignInPage })));
const SignUpPage = lazy(() => import("@/pages/auth").then((m) => ({ default: m.SignUpPage })));
const StudioPage = lazy(() => import("@/pages/studio").then((m) => ({ default: m.StudioPage })));
const LibraryPage = lazy(() => import("@/pages/library").then((m) => ({ default: m.LibraryPage })));
const EditorPage = lazy(() => import("@/pages/editor").then((m) => ({ default: m.EditorPage })));
const SchedulePage = lazy(() => import("@/pages/schedule").then((m) => ({ default: m.SchedulePage })));
const BrandKitsPage = lazy(() => import("@/pages/brand-kits").then((m) => ({ default: m.BrandKitsPage })));
const AccountsPage = lazy(() => import("@/pages/accounts").then((m) => ({ default: m.AccountsPage })));
const SettingsPage = lazy(() => import("@/pages/settings").then((m) => ({ default: m.SettingsPage })));
const HelpPage = lazy(() => import("@/pages/help").then((m) => ({ default: m.HelpPage })));
const AdminPage = lazy(() => import("@/pages/admin").then((m) => ({ default: m.AdminPage })));
const AnalyticsPage = lazy(() => import("@/pages/analytics").then((m) => ({ default: m.AnalyticsPage })));
const HealthPage = lazy(() => import("@/pages/health").then((m) => ({ default: m.HealthPage })));
const VideoPricingPage = lazy(() => import("@/pages/video-pricing").then((m) => ({ default: m.VideoPricingPage })));
const AdsPage = lazy(() => import("@/pages/ads").then((m) => ({ default: m.AdsPage })));
const CalendarPage = lazy(() => import("@/pages/calendar").then((m) => ({ default: m.CalendarPage })));
const CampaignsPage = lazy(() => import("@/pages/campaigns").then((m) => ({ default: m.CampaignsPage })));
const PromptCustomizationsPage = lazy(() => import("@/pages/prompt-customizations").then((m) => ({ default: m.PromptCustomizationsPage })));
const PricingPage = lazy(() => import("@/pages/pricing").then((m) => ({ default: m.PricingPage })));
const NotFound = lazy(() => import("@/pages/not-found"));

function RouteLoader() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
      <p className="text-sm text-muted-foreground">Loading KOKAO…</p>
    </main>
  );
}

function VideoStudioRedirect() {
  useEffect(() => {
    const extra = window.location.search ? "&" + window.location.search.slice(1) : "";
    navigate(`/studio?tab=video${extra}`, { replace: true });
  }, []);
  return (
    <main
      className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground"
      data-testid="video-studio-redirect"
    >
      <div className="max-w-sm space-y-2 text-center">
        <p className="text-base font-medium">Opening Video Studio…</p>
        <p className="text-sm text-muted-foreground">
          If this page does not continue,{" "}
          <a className="font-medium text-primary underline" href="/studio?tab=video">
            open Video Studio
          </a>
          .
        </p>
      </div>
    </main>
  );
}

// Global 403 handling: when any /admin request is rejected (live superadmin
// revocation), immediately purge cached admin data and flip role-gated UI —
// don't wait for the open tab to be manually refreshed.
const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => handleAdminForbidden(queryClient, error),
    onSuccess: (_data, query) => handleAdminQuerySuccess(query.queryKey),
  }),
  mutationCache: new MutationCache({
    onError: (error) => handleAdminForbidden(queryClient, error),
  }),
});

// Resolve the key from window.location.hostname so the same build serves multiple custom domains
const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

// Empty in dev (hits dev FAPI), auto-set in prod
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

if (!clerkPubKey) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in .env file');
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (
        prevUserIdRef.current !== undefined &&
        prevUserIdRef.current !== userId
      ) {
        qc.clear();
        resetAdminAccessRevoked();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, qc]);

  return null;
}

function ProtectedRoute({
  component: Component,
  feature,
  featureLabel,
}: {
  component: any;
  feature?: FeatureId;
  featureLabel?: string;
}) {
  return (
    <>
      <Show when="signed-in">
        <AppLayout>
          {feature ? (
            <FeatureGate feature={feature} label={featureLabel ?? "This feature"}>
              <Component />
            </FeatureGate>
          ) : (
            <Component />
          )}
        </AppLayout>
      </Show>
      <Show when="signed-out">
        <Redirect
          to={`/sign-in?redirect_url=${encodeURIComponent(
            `${window.location.pathname}${window.location.search}`,
          )}`}
          replace
        />
      </Show>
    </>
  );
}

/**
 * Signed-in landing: if the user picked a plan on the public pricing page
 * right before signing up, honor it — send them straight to the billing tab,
 * which preselects that plan and cycle (and clears the stored intent).
 */
function SignedInHome() {
  if (readPlanIntent()) {
    return <Redirect to="/settings?tab=billing" replace />;
  }
  return (
    <AppLayout>
      <DashboardPage />
    </AppLayout>
  );
}

function HomeRoute() {
  return (
    <>
      <Show when="signed-in">
        <SignedInHome />
      </Show>
      <Show when="signed-out">
        <LandingPage />
      </Show>
    </>
  );
}

const clerkAppearance = {
  variables: { colorPrimary: 'hsl(255, 85%, 55%)' },
  elements: { card: 'shadow-2xl shadow-primary/10 rounded-2xl border border-border' },
};

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkLoading>
          <ClerkBootstrapRecovery />
        </ClerkLoading>
        <ClerkLoaded>
          <ClerkBootstrapReady />
          <ClerkQueryClientCacheInvalidator />
          <AnalyticsTracker />
          <BrandProvider>
            <TooltipProvider>
              <Suspense fallback={<RouteLoader />}>
                <Switch>
                  <Route path="/" component={HomeRoute} />
                  <Route path="/dashboard" component={() => <ProtectedRoute component={DashboardPage} />} />
                  <Route path="/sign-in/*?" component={SignInPage} />
                  <Route path="/sign-up/*?" component={SignUpPage} />
                  {/* Public marketing page: plans are served by the unauthenticated
                      GET /plans endpoint, so crawlers and signed-out buyers see prices. */}
                  <Route path="/pricing" component={PricingPage} />
                  {/* Public CMS-managed privacy policy. */}
                  <Route path="/privacy" component={PrivacyPage} />

                  <Route path="/studio" component={() => <ProtectedRoute component={StudioPage} feature="aiStudio" featureLabel="AI Studio" />} />
                  {/* Video Studio now lives inside AI Studio as a tab; keep old links working. */}
                  <Route path="/video-studio" component={VideoStudioRedirect} />
                  <Route path="/library" component={() => <ProtectedRoute component={LibraryPage} feature="contentLibrary" featureLabel="Content Library" />} />
                  {/* Full-page image editor for one library item. The quick dialog stays
                      for small tweaks; this is where masks, adjustments and the AI tools live. */}
                  <Route path="/editor/:id" component={() => <ProtectedRoute component={EditorPage} feature="contentLibrary" featureLabel="Content Library" />} />
                  <Route path="/schedule" component={() => <ProtectedRoute component={SchedulePage} feature="scheduling" featureLabel="Scheduling" />} />
                  <Route path="/calendar" component={() => <ProtectedRoute component={CalendarPage} feature="calendar" featureLabel="Calendar" />} />
                  <Route path="/campaigns" component={() => <ProtectedRoute component={CampaignsPage} feature="campaigns" featureLabel="Campaigns" />} />
                  <Route path="/brand-kits" component={() => <ProtectedRoute component={BrandKitsPage} feature="brandKits" featureLabel="Brand Kits" />} />
                  <Route path="/accounts" component={() => <ProtectedRoute component={AccountsPage} feature="connectedAccounts" featureLabel="Connected Accounts" />} />
                  <Route path="/ads" component={() => <ProtectedRoute component={AdsPage} />} />
                  <Route path="/ai-styles" component={() => <ProtectedRoute component={PromptCustomizationsPage} />} />
                  <Route path="/settings" component={() => <ProtectedRoute component={SettingsPage} />} />
                  <Route path="/help" component={() => <ProtectedRoute component={HelpPage} />} />
                  <Route path="/admin" component={() => <ProtectedRoute component={AdminPage} />} />
                  <Route path="/analytics" component={() => <ProtectedRoute component={AnalyticsPage} feature="analytics" featureLabel="Analytics" />} />
                  <Route path="/health" component={() => <ProtectedRoute component={HealthPage} />} />
                  <Route path="/video-pricing" component={() => <ProtectedRoute component={VideoPricingPage} />} />
                  {/* Branding moved into Settings; keep old links working. */}
                  <Route path="/app-brand" component={() => <Redirect to="/settings" />} />

                  <Route component={NotFound} />
                </Switch>
              </Suspense>
              <Toaster />
            </TooltipProvider>
          </BrandProvider>
        </ClerkLoaded>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}

export default App;
