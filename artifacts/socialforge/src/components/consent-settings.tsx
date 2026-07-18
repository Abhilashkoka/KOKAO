import { useEffect, useState } from "react";
import {
  useGetConsent,
  useUpdateConsent,
  getGetConsentQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { ShieldCheck } from "lucide-react";

const CATEGORIES = [
  {
    key: "analytics" as const,
    label: "Usage analytics",
    description:
      "Anonymous-style usage events: pages you visit, features you use, and errors you hit. Helps us improve the product.",
  },
  {
    key: "deviceDetails" as const,
    label: "Device details",
    description:
      "Browser, operating system, device model, and network type attached to usage events.",
  },
  {
    key: "locationCoarse" as const,
    label: "Approximate location",
    description:
      "City-level location derived from your network connection. No GPS access.",
  },
  {
    key: "locationPrecise" as const,
    label: "Precise location",
    description:
      "Exact coordinates via your browser or device location permission. Only used when you also grant that permission.",
  },
  {
    key: "carrier" as const,
    label: "Mobile carrier",
    description: "Your mobile network operator name (mobile app only).",
  },
];

type ConsentKey = (typeof CATEGORIES)[number]["key"];

export function ConsentSettings() {
  const { data: consent, isLoading } = useGetConsent();
  const updateConsent = useUpdateConsent();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [flags, setFlags] = useState<Record<ConsentKey, boolean>>({
    analytics: false,
    deviceDetails: false,
    locationCoarse: false,
    locationPrecise: false,
    carrier: false,
  });

  useEffect(() => {
    if (consent) {
      setFlags({
        analytics: consent.analytics,
        deviceDetails: consent.deviceDetails,
        locationCoarse: consent.locationCoarse,
        locationPrecise: consent.locationPrecise,
        carrier: consent.carrier,
      });
    }
  }, [consent]);

  const handleToggle = (key: ConsentKey, value: boolean) => {
    const next = { ...flags, [key]: value };
    setFlags(next);
    updateConsent.mutate(
      { data: { [key]: value } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetConsentQueryKey() });
        },
        onError: () => {
          setFlags(flags);
          toast({
            title: "Could not save your choice",
            variant: "destructive",
          });
        },
      },
    );
  };

  if (isLoading) {
    return <Skeleton className="h-[360px] w-full rounded-xl" />;
  }

  return (
    <Card className="border-border shadow-sm max-w-2xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" /> Privacy &amp; Data
        </CardTitle>
        <CardDescription>
          Choose what usage data KOKAO may collect. Everything is off by
          default, changes apply immediately, and declining never limits what
          you can do in the app. Billing records and the data needed to run
          your account (like AI usage counts) are kept regardless, as part of
          operating the service.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {CATEGORIES.map((cat) => (
          <div
            key={cat.key}
            className="flex items-start justify-between gap-4 border-b border-border pb-4 last:border-b-0 last:pb-0"
          >
            <div className="space-y-0.5">
              <p className="font-medium">{cat.label}</p>
              <p className="text-sm text-muted-foreground">{cat.description}</p>
            </div>
            <Switch
              checked={flags[cat.key]}
              onCheckedChange={(v) => handleToggle(cat.key, v)}
              disabled={updateConsent.isPending}
              aria-label={cat.label}
            />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
