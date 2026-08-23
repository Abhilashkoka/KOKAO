import { useGetMe } from "@workspace/api-client-react";
import { useLocation, useSearch } from "wouter";
import { useAdminAccessRevoked } from "@/lib/admin-guard";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ShieldAlert } from "lucide-react";
import { OverviewTab } from "./overview-tab";
import { TenantsTab } from "./tenants-tab";
import { PlansTab } from "./plans-tab";
import { PromosTab } from "./promos-tab";
import { CredentialsTab } from "./credentials-tab";
import { AiTab } from "./ai-tab";
import { PromptKitTab } from "./prompt-kit-tab";
import { NotificationsTab } from "./notifications-tab";
import { AuditTab } from "./audit-tab";
import { LandingTab } from "./landing-tab";
import { SupportTab } from "./support-tab";
import { VideoTemplatesTab } from "./video-templates-tab";

export { AuditLogCard } from "./audit-tab";

const TAB_IDS = [
  "overview",
  "tenants",
  "plans",
  "promos",
  "credentials",
  "ai",
  "prompt-kit",
  "video-templates",
  "notifications",
  "support",
  "landing",
  "video-templates",
  "audit",
] as const;

type TabId = (typeof TAB_IDS)[number];

function isTabId(value: string | null): value is TabId {
  return value !== null && (TAB_IDS as readonly string[]).includes(value);
}

export function AdminPage() {
  const { data: me } = useGetMe();
  const adminAccessRevoked = useAdminAccessRevoked();
  const search = useSearch();
  const [, setLocation] = useLocation();

  const tabParam = new URLSearchParams(search).get("tab");
  const activeTab: TabId = isTabId(tabParam) ? tabParam : "overview";

  const handleTabChange = (value: string) => {
    setLocation(
      value === "overview" ? "/admin" : `/admin?tab=${value}`,
      { replace: true },
    );
  };

  // Fail closed: until /me resolves we don't know the caller's role, so
  // never render the admin shell (the server 403s the data anyway).
  const meResolved = Boolean(me);
  // Deny on the cached hint OR when the admin-guard store flags a live 403 —
  // any admin query from any tab that returns 403 flips the store via the
  // global query/mutation cache handlers, denying the whole page.
  const accessDenied = adminAccessRevoked || (meResolved && !me?.isSuperadmin);

  if (!accessDenied && !meResolved) {
    return (
      <div
        className="flex items-center justify-center py-24"
        data-testid="admin-loading"
      >
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (accessDenied) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <ShieldAlert className="h-12 w-12 text-muted-foreground mb-4" />
        <h1 className="text-2xl font-bold">Access denied</h1>
        <p className="text-muted-foreground mt-2">
          You do not have permission to view this page.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-extrabold tracking-tight">Admin</h1>
        <p className="text-muted-foreground text-lg mt-1">
          Platform-wide view of all workspaces and usage.
        </p>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <div className="overflow-x-auto">
          <TabsList>
            <TabsTrigger value="overview" data-testid="tab-overview">
              Overview
            </TabsTrigger>
            <TabsTrigger value="tenants" data-testid="tab-tenants">
              Tenants
            </TabsTrigger>
            <TabsTrigger value="plans" data-testid="tab-plans">
              Plans
            </TabsTrigger>
            <TabsTrigger value="promos" data-testid="tab-promos">
              Promos
            </TabsTrigger>
            <TabsTrigger value="credentials" data-testid="tab-credentials">
              Platform Credentials
            </TabsTrigger>
            <TabsTrigger value="ai" data-testid="tab-ai">
              AI
            </TabsTrigger>
            <TabsTrigger value="prompt-kit" data-testid="tab-prompt-kit">
              Prompt Kit
            </TabsTrigger>
            <TabsTrigger value="video-templates" data-testid="tab-video-templates">
              Video Templates
            </TabsTrigger>
            <TabsTrigger value="notifications" data-testid="tab-notifications">
              Notifications
            </TabsTrigger>
            <TabsTrigger value="support" data-testid="tab-support">
              Support
            </TabsTrigger>
            <TabsTrigger value="landing" data-testid="tab-landing">
              Landing
            </TabsTrigger>
            <TabsTrigger value="video-templates" data-testid="tab-video-templates">
              Video Templates
            </TabsTrigger>
            <TabsTrigger value="audit" data-testid="tab-audit">
              Audit Log
            </TabsTrigger>
          </TabsList>
        </div>
        {/* Inactive tabs are unmounted by Radix (no forceMount), so only the
            active tab's queries run. */}
        <TabsContent value="overview" className="mt-6">
          <OverviewTab />
        </TabsContent>
        <TabsContent value="tenants" className="mt-6">
          <TenantsTab />
        </TabsContent>
        <TabsContent value="plans" className="mt-6">
          <PlansTab />
        </TabsContent>
        <TabsContent value="promos" className="mt-6">
          <PromosTab />
        </TabsContent>
        <TabsContent value="credentials" className="mt-6">
          <CredentialsTab />
        </TabsContent>
        <TabsContent value="ai" className="mt-6">
          <AiTab />
        </TabsContent>
        <TabsContent value="prompt-kit" className="mt-6">
          <PromptKitTab />
        </TabsContent>
        <TabsContent value="video-templates" className="mt-6">
          <VideoTemplatesTab />
        </TabsContent>
        <TabsContent value="notifications" className="mt-6">
          <NotificationsTab />
        </TabsContent>
        <TabsContent value="support" className="mt-6">
          <SupportTab />
        </TabsContent>
        <TabsContent value="landing" className="mt-6">
          <LandingTab />
        </TabsContent>
        <TabsContent value="video-templates" className="mt-6">
          <VideoTemplatesTab />
        </TabsContent>
        <TabsContent value="audit" className="mt-6">
          <AuditTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
