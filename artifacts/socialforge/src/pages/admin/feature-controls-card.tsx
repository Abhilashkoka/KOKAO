import {
  useAdminListFeatureFlags,
  getAdminListFeatureFlagsQueryKey,
  getListFeatureFlagsQueryKey,
} from "@workspace/api-client-react";
import { useAdminUpdateFeatureFlag } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";

/**
 * Platform-wide feature kill switches. Turning one off hides the module for
 * every tenant and blocks its API routes; the admin area is never affected.
 */
export function FeatureControlsCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: features, isLoading } = useAdminListFeatureFlags();
  const updateFlag = useAdminUpdateFeatureFlag();

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
      <CardHeader>
        <CardTitle>Feature controls</CardTitle>
        <CardDescription>
          Turn app modules on or off for every tenant on the platform. Disabled
          modules disappear from tenants' navigation and their API routes are
          blocked. The admin area is never affected.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
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
          </div>
        )}
      </CardContent>
    </Card>
  );
}
