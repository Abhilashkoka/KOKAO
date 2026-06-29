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

import { Switch, Route, useLocation, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";

import { ClerkProvider, Show, useClerk } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { useEffect, useRef } from "react";

const queryClient = new QueryClient();

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
  options: {
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  }
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
            <Route path="/settings" component={() => <ProtectedRoute component={SettingsPage} />} />
            
            <Route component={NotFound} />
          </Switch>
          <Toaster />
        </TooltipProvider>
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
