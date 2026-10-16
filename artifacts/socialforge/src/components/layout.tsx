import { Link, useLocation } from "wouter";
import { UserButton, useAuth } from "@clerk/react";
import { 
  LayoutDashboard,
  Wand2,
  PlusCircle,
  Clapperboard,
  MoreHorizontal,
  ChevronDown,
  Library,
  Calendar, 
  Palette, 
  Share2, 
  Megaphone,
  CalendarDays,
  Target,
  Sparkles,
  Settings,
  Shield,
  BarChart3,
  HeartPulse,
  CircleDollarSign,
  Menu,
  LogOut
, LifeBuoy } from "lucide-react";
import { useState } from "react";
import { getGetMeQueryKey, useGetMe } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { NotificationsBanner } from "@/components/notifications-banner";
import { LogoLoader } from "@/components/logo-loader";
import { PendingInviteBanner } from "@/components/pending-invite-banner";
import { OnboardingWizard } from "@/components/onboarding-wizard";
import { TeamWelcomeDialog } from "@/components/team-welcome-dialog";
import { WalletBalancePill } from "@/components/wallet-balance";
import { CreditBalancePill } from "@/components/credit-balance";
import { GenerationIndicator } from "@/components/generation-indicator";
import { IdleLogoutWarning } from "@/hooks/use-idle-logout";
import { useBrand } from "@/lib/brand";
import { useFeatureFlags, type FeatureId } from "@/lib/features";
import { SessionRecovery } from "@/components/session-recovery";

const NAV_ITEMS: {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  feature?: FeatureId;
}[] = [
  { href: "/dashboard", label: "Home", icon: LayoutDashboard },
  { href: "/create", label: "Create", icon: PlusCircle, feature: "aiStudio" },
  { href: "/results", label: "Results", icon: Clapperboard, feature: "aiStudio" },
  { href: "/brand-kits", label: "Brand Kits", icon: Palette, feature: "brandKits" },
];

/** Everything else lives one click away under "More", so the sidebar stays short. */
const MORE_NAV_ITEMS: {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  feature?: FeatureId;
}[] = [
  { href: "/studio", label: "AI Studio", icon: Wand2, feature: "aiStudio" },
  { href: "/library", label: "Content Library", icon: Library, feature: "contentLibrary" },
  { href: "/schedule", label: "Schedule", icon: Calendar, feature: "scheduling" },
  { href: "/calendar", label: "Calendar", icon: CalendarDays, feature: "calendar" },
  { href: "/campaigns", label: "Campaigns", icon: Target, feature: "campaigns" },
  { href: "/accounts", label: "Accounts", icon: Share2, feature: "connectedAccounts" },
  { href: "/ads", label: "Ads", icon: Megaphone },
  { href: "/ai-styles", label: "AI Styles", icon: Sparkles },
  { href: "/promoter", label: "Promoter", icon: Megaphone, feature: "creatorProgram" },
  { href: "/help", label: "Help", icon: LifeBuoy },
  { href: "/settings", label: "Settings", icon: Settings },
];

const ANALYTICS_NAV_ITEM = { href: "/analytics", label: "Analytics", icon: BarChart3 };
const HEALTH_NAV_ITEM = { href: "/health", label: "Health", icon: HeartPulse };

const ADMIN_NAV_ITEMS = [
  // Pricing data comes from superadmin-only endpoints, so it lives with Admin.
  { href: "/video-pricing", label: "Video Pricing", icon: CircleDollarSign },
  { href: "/admin", label: "Admin", icon: Shield },
];

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { isLoaded, isSignedIn, signOut } = useAuth();
  const { data: me, error: meError, refetch: refetchMe } = useGetMe({
    query: { queryKey: getGetMeQueryKey(), enabled: Boolean(isLoaded && isSignedIn) },
  });
  const { logoUrl, appName, sidebarLogoHeight } = useBrand();

  // Analytics is superadmin-only (the server also rejects everyone else
  // with 403). Health stays visible to workspace owners/admins.
  const role = me?.team?.role;
  const canSeeHealth = Boolean(
    me && (me.isSuperadmin || !me.team || role === "owner" || role === "admin"),
  );
  const { flags: featureFlags } = useFeatureFlags();
  // Superadmin tools stay in view; everything else secondary goes under More.
  const navItems = [
    ...NAV_ITEMS.filter((item) => !item.feature || featureFlags[item.feature]),
    ...(me?.isSuperadmin ? ADMIN_NAV_ITEMS : []),
  ];
  const moreItems = [
    ...MORE_NAV_ITEMS.filter((item) => !item.feature || featureFlags[item.feature]),
    ...(me?.isSuperadmin && featureFlags.analytics
      ? [ANALYTICS_NAV_ITEM]
      : []),
    ...(canSeeHealth ? [HEALTH_NAV_ITEM] : []),
  ];
  const isActiveHref = (href: string) =>
    location === href || (href !== "/" && location.startsWith(href));
  const moreHasActive = moreItems.some((item) => isActiveHref(item.href));
  const [moreOpenState, setMoreOpen] = useState(false);
  const moreOpen = moreOpenState || moreHasActive;
  
  if (!isLoaded) {
    return <div className="min-h-screen flex items-center justify-center"><LogoLoader label="Loading workspace..." /></div>;
  }

  if (isSignedIn && meError?.status === 401) {
    return (
      <SessionRecovery
        onRetry={async () => {
          const result = await refetchMe();
          if (result.isError) throw new Error("Session verification failed");
        }}
        onSignOut={() => signOut()}
      />
    );
  }

  const NavItem = ({ item }: { item: (typeof NAV_ITEMS)[number] }) => {
    const isActive = isActiveHref(item.href);
    return (
      <Link href={item.href}>
        <div className={`flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-all duration-200 ${isActive ? "bg-primary text-primary-foreground shadow-md shadow-primary/20" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}>
          <item.icon className="h-5 w-5" />
          <span className="font-medium">{item.label}</span>
        </div>
      </Link>
    );
  };

  const NavLinks = () => (
    <div className="flex flex-col gap-2">
      {navItems.map((item) => (
        <NavItem key={item.href} item={item} />
      ))}
      {moreItems.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setMoreOpen((open) => !open)}
            aria-expanded={moreOpen}
            disabled={moreHasActive}
            data-testid="nav-more-toggle"
            className="mt-2 flex items-center gap-3 rounded-lg px-3 py-2.5 text-left text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-default disabled:hover:bg-transparent"
          >
            <MoreHorizontal className="h-5 w-5" />
            <span className="flex-1 font-medium">More</span>
            <ChevronDown className={`h-4 w-4 transition-transform ${moreOpen ? "rotate-180" : ""}`} />
          </button>
          {moreOpen && (
            <div className="flex flex-col gap-2" data-testid="nav-more-items">
              {moreItems.map((item) => (
                <NavItem key={item.href} item={item} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );

  return (
    <div className="min-h-screen w-full bg-background flex flex-col md:flex-row">
      {/* App-wide inactivity auto-logout (no-op unless a superadmin enables it). */}
      <IdleLogoutWarning />
      {/* Mobile Header */}
      <div className="md:hidden flex items-center justify-between p-4 border-b border-border bg-card sticky top-0 z-50">
        {logoUrl ? (
          <img src={logoUrl} alt={appName} className="h-7 w-auto" />
        ) : (
          <div className="h-7" aria-hidden="true" />
        )}
        <div className="flex items-center gap-3">
          <GenerationIndicator />
          <WalletBalancePill />
          <CreditBalancePill />
          <UserButton />
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon">
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-64 p-6 flex flex-col gap-8 overflow-y-auto">
              {logoUrl ? (
                <img src={logoUrl} alt={appName} className="h-7 w-auto" />
              ) : (
                <div className="h-7" aria-hidden="true" />
              )}
              <NavLinks />
            </SheetContent>
          </Sheet>
        </div>
      </div>

      {/* Desktop Sidebar */}
      <aside className="sticky top-0 hidden h-dvh max-h-dvh w-64 shrink-0 self-start flex-col overflow-hidden border-r border-border bg-card p-6 md:flex">
        <div className="flex items-center mb-10 px-2">
          {logoUrl ? (
            <img src={logoUrl} alt={appName} style={{ height: sidebarLogoHeight }} className="w-auto max-w-full object-contain object-left" />
          ) : (
            <div className="h-9" aria-hidden="true" />
          )}
        </div>
        
        <nav
          aria-label="Workspace navigation"
          className="h-0 min-h-0 flex-1 overflow-y-scroll overscroll-contain pr-2 -mr-2 [scrollbar-gutter:stable]"
        >
          <NavLinks />
        </nav>
        
        <div className="mt-auto shrink-0 space-y-3 border-t border-border px-2 pt-6">
          <GenerationIndicator />
          <WalletBalancePill />
          <CreditBalancePill />
          <div className="flex items-center gap-3">
            <UserButton showName />
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 p-4 md:p-8 max-w-7xl mx-auto w-full">
        <OnboardingWizard />
        <TeamWelcomeDialog />
        <NotificationsBanner />
        <PendingInviteBanner />
        {children}
      </main>
    </div>
  );
}
