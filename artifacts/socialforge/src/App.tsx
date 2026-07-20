import { AppLayout } from "@/components/layout";
import { LandingPage } from "@/pages/landing";
import { DashboardPage } from "@/pages/dashboard";
import { SignInPage, SignUpPage } from "@/pages/auth";
import { StudioPage } from "@/pages/studio";
import { LibraryPage } from "@/pages/library";
import { SchedulePage } from "@/pages/schedule";
import { BrandKitsPage } from "@/pages/brand-kits";
import { AccountsPage } from "@/pages/accounts";
import { SettingsPage } from "@/pages/settings";
import { AdminPage } from "@/pages/admin";
import { AnalyticsPage } from "@/pages/analytics";
import { HealthPage } from "@/pages/health";
import { AdsPage } from "@/pages/ads";
import { BrandProvider } from "@/lib/brand";

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

import { ClerkProvider, Show, useClerk } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { useEffect, useRef } from "react";

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

function ProtectedRoute({ component: Component }: { component: any }) {
  return (
    <>
      <Show when="signed-in">
        <AppLayout>
          <Component />
        </AppLayout>
      </Show>
      <Show when="signed-out">
        <LandingPage />
      </Show>
    </>
  );
}

function HomeRoute() {
  return (
    <>
      <Show when="signed-in">
        <AppLayout>
          <DashboardPage />
        </AppLayout>
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
        <ClerkQueryClientCacheInvalidator />
        <AnalyticsTracker />
        <BrandProvider>
        <TooltipProvider>
          <Switch>
            <Route path="/" component={HomeRoute} />
            <Route path="/sign-in/*?" component={SignInPage} />
            <Route path="/sign-up/*?" component={SignUpPage} />
            
            <Route path="/studio" component={() => <ProtectedRoute component={StudioPage} />} />
            <Route path="/library" component={() => <ProtectedRoute component={LibraryPage} />} />
            <Route path="/schedule" component={() => <ProtectedRoute component={SchedulePage} />} />
            <Route path="/brand-kits" component={() => <ProtectedRoute component={BrandKitsPage} />} />
            <Route path="/accounts" component={() => <ProtectedRoute component={AccountsPage} />} />
            <Route path="/ads" component={() => <ProtectedRoute component={AdsPage} />} />
            <Route path="/settings" component={() => <ProtectedRoute component={SettingsPage} />} />
            <Route path="/admin" component={() => <ProtectedRoute component={AdminPage} />} />
            <Route path="/analytics" component={() => <ProtectedRoute component={AnalyticsPage} />} />
            <Route path="/health" component={() => <ProtectedRoute component={HealthPage} />} />
            {/* Branding moved into Settings; keep old links working. */}
            <Route path="/app-brand" component={() => <Redirect to="/settings" />} />
            
            <Route component={NotFound} />
          </Switch>
          <Toaster />
        </TooltipProvider>
        </BrandProvider>
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
