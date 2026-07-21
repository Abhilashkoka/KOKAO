import { useEffect, useRef, useState } from "react";
import { track } from "@/lib/analytics";
import { useLocation } from "wouter";
import {
  useGetMe,
  useGetConsent,
  useUpdateConsent,
  useDraftBrandKit,
  useCreateBrandKit,
  useCompleteOnboarding,
  getGetMeQueryKey,
  getGetConsentQueryKey,
  getListBrandKitsQueryKey,
  type BrandKitPayload,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useFeatureFlags } from "@/lib/features";
import {
  Sparkles,
  Loader2,
  Palette,
  Wand2,
  ArrowRight,
  ShieldCheck,
} from "lucide-react";

const CONSENT_OPTIONS = [
  {
    key: "analytics" as const,
    label: "Usage analytics",
    description: "Pages visited, features used, and errors — helps us improve.",
  },
  {
    key: "deviceDetails" as const,
    label: "Device details",
    description: "Browser, operating system, and network type.",
  },
  {
    key: "locationCoarse" as const,
    label: "Approximate location",
    description: "City-level location from your network. No GPS.",
  },
  {
    key: "locationPrecise" as const,
    label: "Precise location",
    description: "Exact coordinates, only with your browser's permission.",
  },
];

export function OnboardingWizard() {
  const [location, setLocation] = useLocation();
  const { data: me } = useGetMe();
  const { flags: featureFlags } = useFeatureFlags();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const draftBrandKit = useDraftBrandKit();
  const createBrandKit = useCreateBrandKit();
  const completeOnboarding = useCompleteOnboarding();
  const updateConsent = useUpdateConsent();

  const [step, setStep] = useState<"consent" | "welcome" | "brand">("consent");
  const [consentFlags, setConsentFlags] = useState<Record<string, boolean>>({
    analytics: false,
    deviceDetails: false,
    locationCoarse: false,
    locationPrecise: false,
  });
  const [consentBusy, setConsentBusy] = useState(false);
  const startedAtRef = useRef(Date.now());
  const startedTrackedRef = useRef(false);
  const [name, setName] = useState("");
  const [industry, setIndustry] = useState("");
  const [url, setUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const onAdminPage = location === "/admin" || location.startsWith("/admin/");
  const shouldShow = !!me && !me.brandOnboardingComplete && !onAdminPage;
  const { data: storedConsent } = useGetConsent({
    query: { queryKey: getGetConsentQueryKey(), enabled: shouldShow },
  });

  useEffect(() => {
    if (shouldShow && !startedTrackedRef.current) {
      startedTrackedRef.current = true;
      startedAtRef.current = Date.now();
      track("onboarding_started", { entry_point: "first_login" });
    }
  }, [shouldShow]);

  if (!shouldShow) return null;

  // Users who already answered the consent question skip straight to setup.
  const effectiveStep =
    step === "consent" && storedConsent?.responded ? "welcome" : step;

  const handleConsentContinue = () => {
    setConsentBusy(true);
    updateConsent.mutate(
      { data: consentFlags },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getGetConsentQueryKey(),
          });
          setConsentBusy(false);
          setStep("welcome");
        },
        onError: () => {
          setConsentBusy(false);
          toast({
            title: "Could not save your choices",
            description: "You can change them anytime in Settings.",
            variant: "destructive",
          });
          setStep("welcome");
        },
      },
    );
  };

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListBrandKitsQueryKey() });
  };

  const finish = (skipped: boolean) => {
    completeOnboarding.mutate(
      { data: { skipped, industry: industry.trim() || undefined } },
      {
        onSuccess: () => {
          if (!skipped) {
            track("onboarding_completed", {
              completion_time_sec: Math.round(
                (Date.now() - startedAtRef.current) / 1000,
              ),
            });
          }
          refresh();
          // First-time users land in the AI Studio so they can create their
          // first piece of content right away (unless the feature is off).
          if (featureFlags.aiStudio) {
            setLocation("/studio");
          }
        },
        onError: () =>
          toast({ title: "Could not finish setup", variant: "destructive" }),
      },
    );
  };

  const handleSkip = () => finish(true);

  const handleCreate = async () => {
    if (!name.trim()) {
      toast({ title: "Name your brand first", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      let payload: BrandKitPayload | null = null;
      const hasDraftInput = url.trim().length > 0 || notes.trim().length > 0;
      if (hasDraftInput) {
        try {
          const draft = await draftBrandKit.mutateAsync({
            data: {
              url: url.trim() || undefined,
              notes: notes.trim() || undefined,
              brandName: name.trim(),
              industry: industry.trim() || undefined,
            },
          });
          payload = draft.payload;
        } catch {
          toast({
            title: "AI draft unavailable",
            description: "Creating a blank brand you can fill in later.",
          });
        }
      }

      await createBrandKit.mutateAsync({
        data: {
          name: name.trim(),
          brandType: "primary",
          isDefault: true,
          payload,
        },
      });

      toast({ title: "Brand created", description: "You're all set." });
      finish(false);
    } catch (err) {
      const status = (err as { status?: number })?.status;
      toast({
        title: status === 402 ? "Plan limit reached" : "Could not create brand",
        description:
          status === 402
            ? "Upgrade your plan to add more brands, or skip for now."
            : undefined,
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent
        className="sm:max-w-[520px]"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        {effectiveStep === "consent" ? (
          <div className="py-2 space-y-5">
            <div className="space-y-2 text-center">
              <div className="mx-auto h-12 w-12 rounded-2xl bg-primary/10 flex items-center justify-center">
                <ShieldCheck className="h-6 w-6 text-primary" />
              </div>
              <h2 className="text-xl font-bold tracking-tight">
                Your data, your choice
              </h2>
              <p className="text-sm text-muted-foreground">
                KOKAO can collect some usage data to improve the product.
                Everything is optional and off by default. You can change these
                anytime under Settings, and saying no never limits what you can
                do.
              </p>
            </div>
            <div className="space-y-3 max-h-[45vh] overflow-y-auto px-1">
              {CONSENT_OPTIONS.map((opt) => (
                <div
                  key={opt.key}
                  className="flex items-start justify-between gap-4 rounded-lg border border-border p-3"
                >
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">{opt.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {opt.description}
                    </p>
                  </div>
                  <Switch
                    checked={consentFlags[opt.key] ?? false}
                    onCheckedChange={(v) =>
                      setConsentFlags((prev) => ({ ...prev, [opt.key]: v }))
                    }
                    aria-label={opt.label}
                  />
                </div>
              ))}
            </div>
            <div className="flex justify-end pt-1">
              <Button onClick={handleConsentContinue} disabled={consentBusy}>
                {consentBusy ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <ArrowRight className="mr-2 h-4 w-4" />
                )}
                Continue
              </Button>
            </div>
          </div>
        ) : effectiveStep === "welcome" ? (
          <div className="text-center py-4 space-y-5">
            <div className="mx-auto h-14 w-14 rounded-2xl bg-primary/10 flex items-center justify-center">
              <Sparkles className="h-7 w-7 text-primary" />
            </div>
            <div className="space-y-2">
              <h2 className="text-2xl font-extrabold tracking-tight">
                Welcome to KOKAO
              </h2>
              <p className="text-muted-foreground">
                Set up a brand kit so every caption and image stays on-brand.
                It only takes a minute, and you can refine it anytime.
              </p>
            </div>
            <div className="flex flex-col gap-2 pt-2">
              <Button size="lg" onClick={() => setStep("brand")}>
                <Palette className="mr-2 h-4 w-4" /> Create my first brand
              </Button>
              <Button
                variant="ghost"
                onClick={handleSkip}
                disabled={completeOnboarding.isPending}
              >
                {completeOnboarding.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                Skip for now
              </Button>
            </div>
          </div>
        ) : (
          <div className="py-2 space-y-5">
            <div className="space-y-1">
              <h2 className="text-xl font-bold tracking-tight">
                Tell us about your brand
              </h2>
              <p className="text-sm text-muted-foreground">
                Add a link or a few notes and we'll draft a starting kit with AI.
              </p>
            </div>

            <div className="space-y-4 max-h-[55vh] overflow-y-auto px-1">
              <div className="space-y-2">
                <label className="text-sm font-medium">Brand name</label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Acme Coffee"
                  autoFocus
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Industry</label>
                <Input
                  value={industry}
                  onChange={(e) => setIndustry(e.target.value)}
                  placeholder="e.g. Food & beverage"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">
                  Website URL <span className="text-muted-foreground">(optional)</span>
                </label>
                <Input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://yourbrand.com"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">
                  Notes <span className="text-muted-foreground">(optional)</span>
                </label>
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Describe your voice, audience, colors, or anything else."
                  className="resize-none"
                />
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 pt-2">
              <Button variant="ghost" onClick={handleSkip} disabled={busy}>
                Skip for now
              </Button>
              <Button onClick={handleCreate} disabled={busy || !name.trim()}>
                {busy ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : url.trim() || notes.trim() ? (
                  <Wand2 className="mr-2 h-4 w-4" />
                ) : (
                  <ArrowRight className="mr-2 h-4 w-4" />
                )}
                {url.trim() || notes.trim() ? "Draft with AI" : "Create brand"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
