import { Link, useLocation } from "wouter";
import { UserButton, useAuth } from "@clerk/react";
import { 
  LayoutDashboard, 
  Wand2, 
  Library, 
  Calendar, 
  Palette, 
  Share2, 
  Settings,
  Shield,
  SwatchBook,
  Menu,
  LogOut
} from "lucide-react";
import { useState } from "react";
import { useGetMe } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { NotificationsBanner } from "@/components/notifications-banner";
import { OnboardingWizard } from "@/components/onboarding-wizard";
import kokaoLockup from "@assets/kokao-lockup_1783325983377.svg";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/studio", label: "AI Studio", icon: Wand2 },
  { href: "/library", label: "Content Library", icon: Library },
  { href: "/schedule", label: "Schedule", icon: Calendar },
  { href: "/brand-kits", label: "Brand Kits", icon: Palette },
  { href: "/accounts", label: "Accounts", icon: Share2 },
  { href: "/settings", label: "Settings", icon: Settings },
];

const ADMIN_NAV_ITEMS = [
  { href: "/app-brand-kit", label: "App Brand Kit", icon: SwatchBook },
  { href: "/admin", label: "Admin", icon: Shield },
];

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { isLoaded } = useAuth();
  const { data: me } = useGetMe();
  const navItems = me?.isSuperadmin
    ? [...NAV_ITEMS, ...ADMIN_NAV_ITEMS]
    : NAV_ITEMS;
  
  if (!isLoaded) {
    return <div className="min-h-screen flex items-center justify-center"><div className="animate-pulse flex flex-col items-center gap-4"><div className="h-8 w-8 bg-primary/20 rounded-full"></div><div className="text-muted-foreground">Loading workspace...</div></div></div>;
  }

  const NavLinks = () => (
    <div className="flex flex-col gap-2">
      {navItems.map((item) => {
        const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
        return (
          <Link key={item.href} href={item.href}>
            <div className={`flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-all duration-200 ${isActive ? "bg-primary text-primary-foreground shadow-md shadow-primary/20" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}>
              <item.icon className="h-5 w-5" />
              <span className="font-medium">{item.label}</span>
            </div>
          </Link>
        );
      })}
    </div>
  );

  return (
    <div className="min-h-screen w-full bg-background flex flex-col md:flex-row">
      {/* Mobile Header */}
      <div className="md:hidden flex items-center justify-between p-4 border-b border-border bg-card sticky top-0 z-50">
        <img src={kokaoLockup} alt="KOKAO" className="h-7 w-auto" />
        <div className="flex items-center gap-3">
          <UserButton />
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon">
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-64 p-6 flex flex-col gap-8">
              <img src={kokaoLockup} alt="KOKAO" className="h-7 w-auto" />
              <NavLinks />
            </SheetContent>
          </Sheet>
        </div>
      </div>

      {/* Desktop Sidebar */}
      <div className="hidden md:flex w-64 flex-col border-r border-border bg-card p-6 h-screen sticky top-0">
        <div className="flex items-center mb-10 px-2">
          <img src={kokaoLockup} alt="KOKAO" className="h-9 w-auto" />
        </div>
        
        <div className="flex-1">
          <NavLinks />
        </div>
        
        <div className="mt-auto pt-6 border-t border-border flex items-center gap-3 px-2">
          <UserButton showName />
        </div>
      </div>

      {/* Main Content */}
      <main className="flex-1 p-4 md:p-8 max-w-7xl mx-auto w-full">
        <OnboardingWizard />
        <NotificationsBanner />
        {children}
      </main>
    </div>
  );
}
