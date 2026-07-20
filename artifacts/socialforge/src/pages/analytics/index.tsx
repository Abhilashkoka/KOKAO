import { useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import {
  useGetMe,
  useAdminListTenants,
  getAdminListTenantsQueryKey,
} from "@workspace/api-client-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ShieldAlert } from "lucide-react";
import { ScopeProvider, type AnalyticsScope } from "./shared";
import { AudienceTab } from "./audience-tab";
import { AcquisitionTab } from "./acquisition-tab";
import { FunnelsTab } from "./funnels-tab";
import { EngagementTab } from "./engagement-tab";
import { RevenueTab } from "./revenue-tab";
import { DataConsumptionTab } from "./data-consumption-tab";
import { ReliabilityTab } from "./reliability-tab";
import { ConsentTab } from "./consent-tab";

const TAB_IDS = [
  "audience",
  "acquisition",
  "funnels",
  "engagement",
  "revenue",
  "data",
  "reliability",
  "consent",
] as const;

type TabId = (typeof TAB_IDS)[number];

function isTabId(value: string | null): value is TabId {
  return value !== null && (TAB_IDS as readonly string[]).includes(value);
}

const RANGE_OPTIONS = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
] as const;

export function AnalyticsPage() {
  const { data: me } = useGetMe();
  const search = useSearch();
  const [, setLocation] = useLocation();
  const [rangeDays, setRangeDays] = useState("30");
  const [tenantFilter, setTenantFilter] = useState("all");

  const isSuperadmin = Boolean(me?.isSuperadmin);
  // Fail closed: until /me resolves we don't know the caller's role, so
  // never render the dashboard shell (the server 403s the data anyway).
  const meResolved = Boolean(me);
  const accessDenied = meResolved && !isSuperadmin;

  const { data: tenants } = useAdminListTenants({
    query: { queryKey: getAdminListTenantsQueryKey(), enabled: isSuperadmin },
  });

  const tabParam = new URLSearchParams(search).get("tab");
  const activeTab: TabId = isTabId(tabParam) ? tabParam : "audience";

  const handleTabChange = (value: string) => {
    setLocation(
      value === "audience" ? "/analytics" : `/analytics?tab=${value}`,
      { replace: true },
    );
  };

  const scope: AnalyticsScope = useMemo(() => {
    const from = new Date(
      Date.now() - Number(rangeDays) * 24 * 60 * 60 * 1000,
    ).toISOString();
    const tenantId =
      isSuperadmin && tenantFilter !== "all" ? Number(tenantFilter) : undefined;
    return tenantId !== undefined ? { from, tenantId } : { from };
  }, [rangeDays, tenantFilter, isSuperadmin]);

  if (!meResolved) {
    return (
      <div
        className="flex items-center justify-center py-24"
        data-testid="analytics-loading"
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
          Analytics are available to platform administrators only.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight">Analytics</h1>
          <p className="text-muted-foreground text-lg mt-1">
            Platform-wide usage, revenue, and reliability metrics.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isSuperadmin && (
            <Select value={tenantFilter} onValueChange={setTenantFilter}>
              <SelectTrigger className="w-[200px]" data-testid="select-analytics-tenant">
                <SelectValue placeholder="All workspaces" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All workspaces</SelectItem>
                {(tenants ?? []).map((t) => (
                  <SelectItem key={t.id} value={String(t.id)}>
                    {t.name || t.email || `Workspace ${t.id}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select value={rangeDays} onValueChange={setRangeDays}>
            <SelectTrigger className="w-[150px]" data-testid="select-analytics-range">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RANGE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <ScopeProvider value={scope}>
        <Tabs value={activeTab} onValueChange={handleTabChange}>
          <div className="overflow-x-auto">
            <TabsList>
              <TabsTrigger value="audience" data-testid="tab-audience">
                Audience
              </TabsTrigger>
              <TabsTrigger value="acquisition" data-testid="tab-acquisition">
                Acquisition
              </TabsTrigger>
              <TabsTrigger value="funnels" data-testid="tab-funnels">
                Activation &amp; Funnels
              </TabsTrigger>
              <TabsTrigger value="engagement" data-testid="tab-engagement">
                Engagement &amp; Features
              </TabsTrigger>
              <TabsTrigger value="revenue" data-testid="tab-revenue">
                Revenue
              </TabsTrigger>
              <TabsTrigger value="data" data-testid="tab-data">
                Data Consumption
              </TabsTrigger>
              <TabsTrigger value="reliability" data-testid="tab-reliability">
                Reliability &amp; Performance
              </TabsTrigger>
              <TabsTrigger value="consent" data-testid="tab-consent">
                Consent &amp; Privacy
              </TabsTrigger>
            </TabsList>
          </div>
          {/* Inactive tabs are unmounted by Radix (no forceMount), so only the
              active tab's queries run. */}
          <TabsContent value="audience" className="mt-6">
            <AudienceTab />
          </TabsContent>
          <TabsContent value="acquisition" className="mt-6">
            <AcquisitionTab />
          </TabsContent>
          <TabsContent value="funnels" className="mt-6">
            <FunnelsTab />
          </TabsContent>
          <TabsContent value="engagement" className="mt-6">
            <EngagementTab />
          </TabsContent>
          <TabsContent value="revenue" className="mt-6">
            <RevenueTab />
          </TabsContent>
          <TabsContent value="data" className="mt-6">
            <DataConsumptionTab />
          </TabsContent>
          <TabsContent value="reliability" className="mt-6">
            <ReliabilityTab />
          </TabsContent>
          <TabsContent value="consent" className="mt-6">
            <ConsentTab />
          </TabsContent>
        </Tabs>
      </ScopeProvider>
    </div>
  );
}
