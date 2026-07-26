import {
  useAdminListFeatureFlags,
  getAdminListFeatureFlagsQueryKey,
  getListFeatureFlagsQueryKey,
  useAdminGetAdsSettings,
  useAdminUpdateAdsSettings,
  getAdminGetAdsSettingsQueryKey,
} from "@workspace/api-client-react";
import { useAdminUpdateFeatureFlag } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { CollapsibleCardHeader } from "@/components/ui/collapsible-card-header";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useState } from "react";

/**
 * Platform-wide feature kill switches. Turning one off hides the module for
 * every tenant and blocks its API routes; the admin area is never affected.
 */
export function FeatureControlsCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: features, isLoading } = useAdminListFeatureFlags();
  const updateFlag = useAdminUpdateFeatureFlag();
  // The ads module predates the feature-flag system and keeps its own
  // dedicated setting; it is surfaced here so all switches live together.
  const { data: adsSettings, isLoading: adsLoading } = useAdminGetAdsSettings();
  const updateAds = useAdminUpdateAdsSettings();
  const [open, setOpen] = useState(false);

  const handleAdsToggle = (enabled: boolean) => {
    updateAds.mutate(
      { data: { enabled } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getAdminGetAdsSettingsQueryKey(),
          });
          toast({
            title: enabled ? "Paid media (Ads) enabled" : "Paid media (Ads) disabled",
            description: enabled
              ? "Tenants can now connect ad accounts and manage campaigns."
              : "All ads features are hidden and ads endpoints are blocked for all tenants.",
          });
        },
        onError: () => {
          toast({
            variant: "destructive",
            title: "Could not update the ads switch",
            description: "Please try again.",
          });
        },
      },
    );
  };

  const handleToggle = (feature: string, label: string, enabled: boolean) => {
    updateFlag.mutate(
      { feature, data: { enabled } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getAdminListFeatureFlagsQueryKey(),
          });
          queryClient.invalidateQueries({
            queryKey: getListFeatureFlagsQueryKey(),
          });
          toast({
            title: enabled ? `${label} enabled` : `${label} disabled`,
            description: enabled
              ? `${label} is available to all tenants again.`
              : `${label} is now hidden and blocked for all tenants.`,
          });
        },
        onError: () => {
          toast({
            variant: "destructive",
            title: "Could not update the feature switch",
            description: "Please try again.",
          });
        },
      },
    );
  };

  return (
    <Card>
      <CollapsibleCardHeader
        title="Feature controls"
        description="Turn app modules on or off for every tenant on the platform. Disabled modules disappear from tenants' navigation and their API routes are blocked. The admin area is never affected."
        open={open}
        onToggle={() => setOpen((o) => !o)}
        testId="toggle-feature-controls-card"
      />
      {open && (
      <CardContent>
        {isLoading || adsLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (
          <div className="divide-y">
            {(features ?? []).map((f) => (
              <div
                key={f.feature}
                className="flex items-center justify-between gap-4 py-3"
              >
                <div>
                  <div className="font-medium">{f.label}</div>
                  <div className="text-sm text-muted-foreground">
                    {f.description}
                  </div>
                </div>
                <Switch
                  checked={f.enabled}
                  disabled={updateFlag.isPending}
                  onCheckedChange={(checked) =>
                    handleToggle(f.feature, f.label, checked)
                  }
                  aria-label={`Toggle ${f.label}`}
                  data-testid={`switch-feature-${f.feature}`}
                />
              </div>
            ))}
            <div className="flex items-center justify-between gap-4 py-3">
              <div>
                <div className="font-medium">Paid media (Ads)</div>
                <div className="text-sm text-muted-foreground">
                  Ad account connections and paid campaign management.
                </div>
              </div>
              <Switch
                checked={adsSettings?.enabled ?? false}
                disabled={updateAds.isPending}
                onCheckedChange={handleAdsToggle}
                aria-label="Toggle Paid media (Ads)"
                data-testid="switch-ads-module"
              />
            </div>
          </div>
        )}
      </CardContent>
      )}
    </Card>
  );
}
