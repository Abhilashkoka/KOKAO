import { AppLayout } from "@/components/layout";
import { LandingPage } from "@/pages/landing";
import { PrivacyPage } from "@/pages/privacy";
import { DashboardPage } from "@/pages/dashboard";
import { SignInPage, SignUpPage } from "@/pages/auth";
import { StudioPage } from "@/pages/studio";
import { LibraryPage } from "@/pages/library";
import { EditorPage } from "@/pages/editor";
import { SchedulePage } from "@/pages/schedule";
import { BrandKitsPage } from "@/pages/brand-kits";
import { AccountsPage } from "@/pages/accounts";
import { SettingsPage } from "@/pages/settings";
import { HelpPage } from "@/pages/help";
import { AdminPage } from "@/pages/admin";
import { AnalyticsPage } from "@/pages/analytics";
import { HealthPage } from "@/pages/health";
import { VideoPricingPage } from "@/pages/video-pricing";
import { AdsPage } from "@/pages/ads";
import { CalendarPage } from "@/pages/calendar";
import { CampaignsPage } from "@/pages/campaigns";
import { PromptCustomizationsPage } from "@/pages/prompt-customizations";
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
import NotFound from "@/pages/not-found";
import { AnalyticsTracker } from "@/components/analytics-tracker";
import { LogoLoader } from "@/components/logo-loader";

import {
  ClerkLoaded,
  ClerkLoading,
  ClerkProvider,
  Show,
  useClerk,
} from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { useEffect, useRef } from "react";
import { navigate } from "wouter/use-browser-location";

// Video Studio now lives inside AI Studio as a tab; keep old links working.
import { PricingPage } from "@/pages/pricing";
function VideoStudioRedirect() {
  useEffect(() => {
    const extra = window.location.search ? "&" + window.location.search.slice(1) : "";
    navigate(`/studio?tab=video${extra}`, { replace: true });
  }, []);
  return null;
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
        <LandingPage />
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
          <div className="min-h-screen flex items-center justify-center bg-background">
            <LogoLoader label="Loading workspace..." />
          </div>
        </ClerkLoading>
        <ClerkLoaded>
          <ClerkQueryClientCacheInvalidator />
          <AnalyticsTracker />
          <BrandProvider>
            <TooltipProvider>
              <Switch>
                <Route path="/" component={HomeRoute} />
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
