import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getGetConsentQueryKey, useGetConsent, useUpdateConsent } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { setConsentState } from "@/lib/analytics";
import { ShieldCheck } from "lucide-react";

const OPTIONS = [
  { key: "analytics", label: "Usage analytics", description: "Pages visited, features used, and errors." },
  { key: "deviceDetails", label: "Device details", description: "Browser, operating system, and network type." },
  { key: "locationCoarse", label: "Approximate location", description: "City-level location from your network. No GPS." },
  { key: "locationPrecise", label: "Precise location", description: "Exact coordinates, only with browser permission." },
] as const;
type Key = (typeof OPTIONS)[number]["key"];

/** Required data-choice disclosure, same policy as the main onboarding consent step. */
export function CreatorLegalGate({ children }: { children: React.ReactNode }) {
  const consent = useGetConsent({ query: { queryKey: getGetConsentQueryKey(), retry: false } });
  const update = useUpdateConsent();
  const client = useQueryClient();
  const [flags, setFlags] = useState<Record<Key, boolean>>({ analytics: false, deviceDetails: false, locationCoarse: false, locationPrecise: false });
  const [saveError, setSaveError] = useState(false);
  const [done, setDone] = useState(false);

  if (consent.isLoading) return <Skeleton data-testid="creator-consent-loading" className="h-64" />;
  if (consent.isError && !done) return <div role="alert" data-testid="creator-consent-error" className="rounded-2xl border border-border bg-card p-8 text-center"><p className="font-medium">Couldn't load your privacy choices</p><Button className="mt-4" variant="outline" data-testid="button-creator-consent-retry" onClick={() => void consent.refetch()}>Try again</Button><Button className="mt-4 ml-2" variant="ghost" data-testid="button-creator-consent-skip-load" onClick={() => setDone(true)}>Continue</Button></div>;
  if (done || consent.data?.responded) return <>{children}</>;

  const save = () => {
    setSaveError(false);
    update.mutate({ data: flags }, {
      onSuccess: () => {
        setConsentState({ ...flags, carrier: false, responded: true }, true);
        void client.invalidateQueries({ queryKey: getGetConsentQueryKey() });
        setDone(true);
      },
      onError: () => setSaveError(true),
    });
  };

  return (
    <section data-testid="creator-consent-gate" className="mx-auto max-w-xl rounded-2xl border border-border bg-card p-6 sm:p-8">
      <ShieldCheck className="h-8 w-8 text-primary" />
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">Your data, your choice</h1>
      <p className="mt-2 text-sm text-muted-foreground">Before you continue, tell us what usage data KOKAO may collect. Everything is optional and off by default; saying no never limits the creator programme.</p>
      <div className="mt-5 space-y-2">
        {OPTIONS.map(o => <label key={o.key} className="flex items-start justify-between gap-4 rounded-xl border border-border p-3">
          <span><span className="block text-sm font-medium">{o.label}</span><span className="block text-xs text-muted-foreground">{o.description}</span></span>
          <Switch aria-label={o.label} data-testid={`switch-consent-${o.key}`} checked={flags[o.key]} onCheckedChange={v => setFlags(p => ({ ...p, [o.key]: v }))} />
        </label>)}
      </div>
      {saveError && <p role="alert" className="mt-4 text-sm text-destructive" data-testid="text-consent-save-error">Couldn't save your choices. Please try again, or continue now and change them later in Settings.</p>}
      {saveError && <Button className="mt-3 w-full" variant="ghost" data-testid="button-creator-consent-skip" onClick={() => setDone(true)}>Continue without saving</Button>}
      <Button className="mt-5 w-full" data-testid="button-creator-consent-continue" disabled={update.isPending} onClick={save}>{update.isPending ? "Saving..." : "Save and continue"}</Button>
    </section>
  );
}
