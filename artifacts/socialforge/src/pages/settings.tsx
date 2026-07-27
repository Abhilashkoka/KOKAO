import { useState, useEffect } from "react";
import { 
  useGetMe,
  useListPlans,
  useUpdateSettings,
  useListAiModels,
  getGetMeQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { CheckCircle2, Settings as SettingsIcon, Package, Sparkles } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { NotificationSettings } from "@/components/notification-settings";
import { TeamSettings } from "@/components/team-settings";
import { AppBrandingSettings } from "@/components/app-branding-settings";
import { TasteMemorySettings } from "@/components/taste-memory-settings";
import { BillingSettings } from "@/components/billing-settings";
import { ConsentSettings } from "@/components/consent-settings";
import { useFeatureFlags } from "@/lib/features";
import { useSearch } from "wouter";

/** Friendly display names for the built-in provider's models. */
const BUILTIN_MODEL_LABELS: Record<string, string> = {
  "gpt-5.6-terra": "GPT-5.6 Terra (Best Quality)",
  "gpt-5.4": "GPT-5.4 (Balanced)",
  "gpt-5.6-luna": "GPT-5.6 Luna (Fast)",
};

/** "In $0.15 / Out $0.60 per 1M tokens" from live provider pricing. */
export function formatModelPrice(p: {
  inputPerMTokens?: number | null;
  outputPerMTokens?: number | null;
}): string {
  const fmt = (v: number | null | undefined) => (v == null ? "—" : `$${v}`);
  if (p.inputPerMTokens == null && p.outputPerMTokens == null) return "Pricing unavailable";
  return `In ${fmt(p.inputPerMTokens)} / Out ${fmt(p.outputPerMTokens)} per 1M tokens`;
}

export function SettingsPage() {
  const search = useSearch();
  const requestedTab = new URLSearchParams(search).get("tab");
  const { data: me, isLoading: meLoading } = useGetMe();
  const { data: modelChoices } = useListAiModels();
  const { data: plans, isLoading: plansLoading } = useListPlans();
  const updateSettings = useUpdateSettings();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { flags: featureFlags } = useFeatureFlags();

  const [name, setName] = useState("");
  const [aiModel, setAiModel] = useState("");

  useEffect(() => {
    if (me) {
      setName(me.tenant.name);
      setAiModel(me.tenant.aiModel);
    }
  }, [me]);

  const handleSave = () => {
    updateSettings.mutate({
      data: { name, aiModel }
    }, {
      onSuccess: () => {
        toast({ title: "Settings updated" });
        queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
      }
    });
  };

  const handleUpgrade = (planId: string) => {
    updateSettings.mutate({
      data: { plan: planId }
    }, {
      onSuccess: () => {
        toast({ title: "Plan updated successfully!" });
        queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
      }
    });
  };

  if (meLoading || plansLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-[400px] w-full rounded-xl" />
      </div>
    );
  }

  const allowedTabs = [
    "general",
    ...(me?.team?.enabled && featureFlags.team ? ["team"] : []),
    ...(featureFlags.billing ? ["billing"] : []),
    "notifications",
    "style-memory",
    "privacy",
    ...(me?.isSuperadmin ? ["branding"] : []),
  ];
  const initialTab =
    requestedTab && allowedTabs.includes(requestedTab) ? requestedTab : "general";

  return (
    <div className="space-y-10 animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-5xl mx-auto">
      <div>
        <h1 className="text-3xl font-extrabold tracking-tight">Settings</h1>
        <p className="text-muted-foreground text-lg mt-1">Manage your workspace preferences and billing.</p>
      </div>

      <Tabs defaultValue={initialTab} className="space-y-8">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          {me?.team?.enabled && featureFlags.team && (
            <TabsTrigger value="team">Team</TabsTrigger>
          )}
          {featureFlags.billing && (
            <TabsTrigger value="billing">Billing</TabsTrigger>
          )}
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
          <TabsTrigger value="style-memory">Style memory</TabsTrigger>
          <TabsTrigger value="privacy">Privacy &amp; Data</TabsTrigger>
          {me?.isSuperadmin && (
            <TabsTrigger value="branding">Branding</TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="general">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        <div className="lg:col-span-5 space-y-6">
          <Card className="border-border shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><SettingsIcon className="h-5 w-5 text-primary" /> General</CardTitle>
              <CardDescription>Workspace and model configuration.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Workspace Name</label>
                <Input value={name} onChange={e => setName(e.target.value)} />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">AI Model Preference</label>
                <Select value={aiModel} onValueChange={setAiModel}>
                  <SelectTrigger data-testid="select-ai-model"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(modelChoices?.models ?? []).map((m) => {
                      const price = modelChoices?.pricing?.find((p) => p.model === m);
                      return (
                        <SelectItem key={m} value={m}>
                          <span className="flex flex-col items-start">
                            <span>{BUILTIN_MODEL_LABELS[m] ?? m}</span>
                            {price && (
                              <span className="text-xs text-muted-foreground">
                                {formatModelPrice(price)}
                              </span>
                            )}
                          </span>
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
            <CardFooter className="bg-muted/30 border-t border-border px-6 py-4">
              <Button onClick={handleSave} disabled={updateSettings.isPending}>Save Changes</Button>
            </CardFooter>
          </Card>

          <Card className="border-border shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Sparkles className="h-5 w-5 text-primary" /> Usage Limits</CardTitle>
              <CardDescription>Your current billing period usage.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <div className="flex justify-between text-sm font-medium">
                  <span>Captions</span>
                  <span>{me?.usage.captions} / {me?.limits.captions === -1 ? '∞' : me?.limits.captions}</span>
                </div>
                {me && me.limits.captions !== -1 && (
                  <Progress value={(me.usage.captions / me.limits.captions) * 100} className="h-2" />
                )}
              </div>
              <div className="space-y-2">
                <div className="flex justify-between text-sm font-medium">
                  <span>Images</span>
                  <span>{me?.usage.images} / {me?.limits.images === -1 ? '∞' : me?.limits.images}</span>
                </div>
                {me && me.limits.images !== -1 && (
                  <Progress value={(me.usage.images / me.limits.images) * 100} className="h-2" />
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {featureFlags.billing && (
        <div className="lg:col-span-7">
          <Card className="border-border shadow-sm h-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Package className="h-5 w-5 text-primary" /> Subscription Plans</CardTitle>
              <CardDescription>Upgrade to unlock more AI generation and features.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {plans?.map(plan => {
                const isActive = me?.tenant.plan === plan.id;
                
                return (
                  <div key={plan.id} className={`p-5 rounded-xl border-2 transition-all ${isActive ? 'border-primary bg-primary/5 shadow-md shadow-primary/10' : 'border-border hover:border-primary/30 hover:bg-muted/30'}`}>
                    <div className="flex justify-between items-center mb-4">
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="font-bold text-xl capitalize">{plan.name}</h3>
                          {isActive && <span className="bg-primary text-primary-foreground text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full">Current Plan</span>}
                        </div>
                        <p className="text-2xl font-extrabold mt-1">{plan.priceLabel}</p>
                      </div>
                      <Button 
                        variant={isActive ? "outline" : "default"} 
                        disabled={isActive || updateSettings.isPending}
                        onClick={() => handleUpgrade(plan.id)}
                      >
                        {isActive ? "Active" : "Upgrade"}
                      </Button>
                    </div>
                    <ul className="space-y-2.5">
                      {plan.features.map((feature, i) => (
                        <li key={i} className="flex items-center gap-2 text-sm text-muted-foreground">
                          <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" /> {feature}
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </div>
        )}
      </div>
        </TabsContent>

        {me?.team?.enabled && featureFlags.team && (
          <TabsContent value="team">
            <div className="max-w-2xl">
              <TeamSettings />
            </div>
          </TabsContent>
        )}

        {featureFlags.billing && (
          <TabsContent value="billing">
            <BillingSettings />
          </TabsContent>
        )}

        <TabsContent value="notifications">
          <div className="max-w-2xl">
            <NotificationSettings />
          </div>
        </TabsContent>

        <TabsContent value="style-memory">
          <div className="max-w-2xl">
            <TasteMemorySettings />
          </div>
        </TabsContent>

        <TabsContent value="privacy">
          <ConsentSettings />
        </TabsContent>

        {me?.isSuperadmin && (
          <TabsContent value="branding">
            <AppBrandingSettings />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}