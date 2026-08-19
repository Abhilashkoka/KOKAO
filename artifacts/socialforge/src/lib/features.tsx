import {
  useListFeatureFlags,
  getListFeatureFlagsQueryKey,
} from "@workspace/api-client-react";
import type { FeatureFlags } from "@workspace/api-client-react";
import { Ban } from "lucide-react";

export type FeatureId = keyof FeatureFlags;

const ALL_ON: FeatureFlags = {
  aiStudio: true,
  contentLibrary: true,
  scheduling: true,
  brandKits: true,
  connectedAccounts: true,
  analytics: true,
  team: true,
  billing: true,
  pushNotifications: true,
  upgradeRequests: true,
  promoCodes: true,
  referenceImages: true,
  assetLibrary: true,
  carousel: true,
  wallet: true,
  aiSpend: true,
  aiCostTracking: true,
  videoGen: true,
  videoTextToVideo: true,
  videoAnimatePhoto: true,
  videoSlideshow: true,
  videoTopicToVideo: true,
  signupCredits: true,
  quests: true,
  streaks: true,
  referrals: true,
  progressMeter: true,
  calendar: true,
  postMetrics: true,
  campaigns: true,
  imageJobs: true,
  layeredImages: true,
  studioQuickPublish: true,
  campaignStreaming: true,
  composer: true,
  viralToolkit: true,
  brandVideo: true,
  referenceStyles: true,
  planGate: true,
  providerResilience: true,
  archivalFootage: true,
  imageLooks: true,
  providerScoring: true,
  lipSync: true,
};

/**
 * Platform-wide feature switches set by the superadmin. Defaults to
 * everything-on while loading or on error so a hiccup never hides the app;
 * the server still enforces disabled features with 403s.
 */
export function useFeatureFlags(): { flags: FeatureFlags; isLoading: boolean } {
  const { data, isLoading } = useListFeatureFlags({
    // Feature controls are operational kill switches. Refetch whenever a new
    // surface mounts so a second admin's change (or a route transition after a
    // toggle) cannot leave the tenant UI on a stale one-minute snapshot.
    query: {
      queryKey: getListFeatureFlagsQueryKey(),
      staleTime: 0,
      refetchOnMount: "always",
    },
  });
  return { flags: data ?? ALL_ON, isLoading };
}

export function FeatureDisabledNotice({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div className="rounded-full bg-muted p-4 mb-4">
        <Ban className="h-8 w-8 text-muted-foreground" />
      </div>
      <h2 className="text-lg font-semibold">{label} is currently unavailable</h2>
      <p className="text-sm text-muted-foreground mt-1 max-w-sm">
        This feature has been turned off by the platform administrator. Please
        check back later.
      </p>
    </div>
  );
}

/** Wraps a page; shows the disabled notice when the feature switch is off. */
export function FeatureGate({
  feature,
  label,
  children,
}: {
  feature: FeatureId;
  label: string;
  children: React.ReactNode;
}) {
  const { flags } = useFeatureFlags();
  if (!flags[feature]) return <FeatureDisabledNotice label={label} />;
  return <>{children}</>;
}
