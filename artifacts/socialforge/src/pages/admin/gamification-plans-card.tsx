import { useEffect, useState } from "react";
import {
  useAdminListGamificationPlans,
  useAdminUpdateGamificationPlan,
  useAdminResetGamificationPlan,
  getAdminListGamificationPlansQueryKey,
  type GamificationPlanSettingsView,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";

/**
 * Per-plan gamification tuning (superadmin). Every plan in the catalog is
 * listed — including custom plans created later — with the quest/streak/
 * referral/progress-meter toggles, the reward multiplier, and the referral
 * credit amounts. The four global switches on the Overview tab remain the
 * platform-wide kill switches; these rows refine per plan.
 */

type Draft = GamificationPlanSettingsView;
const DEFAULT_REFERRAL_SLABS = [
  { minReferrals: 0, referrerBps: 1000, refereeBps: 1000 },
  { minReferrals: 5, referrerBps: 1200, refereeBps: 1000 },
  { minReferrals: 15, referrerBps: 1500, refereeBps: 1000 },
];

export function validateReferralSettings(draft: Draft): string | null {
  const slabs = draft.referralSlabs;
  if (slabs !== null && slabs !== undefined &&
    (slabs.length < 1 || slabs.length > 20 || slabs[0]?.minReferrals !== 0 ||
      slabs.some((s, i) =>
        !Number.isInteger(s.minReferrals) || s.minReferrals < 0 || s.minReferrals > 1_000_000 ||
        (i > 0 && s.minReferrals <= slabs[i - 1]!.minReferrals) ||
        !Number.isInteger(s.referrerBps) || s.referrerBps < 0 || s.referrerBps > 10000 ||
        !Number.isInteger(s.refereeBps) || s.refereeBps < 0 || s.refereeBps > 10000))) {
    return "Referral tiers must start at 0, use strictly increasing purchase counts, and have rates between 0% and 100%.";
  }
  if (draft.referralTriggerMode !== "first_purchase" && draft.referralTriggerMode !== "every_purchase") {
    return "Choose a valid referral purchase trigger.";
  }
  if ([draft.referralAttributionDays, draft.referralBonusExpiryDays].some(
    (n) => !Number.isInteger(n) || n < 1 || n > 3650,
  )) return "Referral durations must be whole numbers between 1 and 3650 days.";
  return null;
}

const QUEST_REWARD_OVERRIDES = [
  ["quest:create_brand_kit", "Create a brand kit"],
  ["quest:first_caption", "Generate your first caption"],
  ["quest:first_image", "Generate your first image"],
  ["quest:first_video", "Make your first video"],
  ["quest:connect_account", "Connect a social account"],
  ["quest:schedule_post", "Schedule a post"],
] as const;

const STREAK_REWARD_OVERRIDES = [3, 7, 14, 30] as const;

function formatCredits(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

function overrideInputValue(
  overrides: Record<string, number> | undefined,
  key: string,
): string {
  const milli = overrides?.[key];
  return typeof milli === "number" ? String(milli / 1000) : "";
}

function NumberField({
  id,
  label,
  value,
  min,
  max,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-8"
      />
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
  testId,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  testId: string;
}) {
  return (
    <label className="flex items-center justify-between gap-2 rounded-md border border-border/60 px-2.5 py-1.5 text-sm">
      {label}
      <Switch checked={checked} onCheckedChange={onChange} data-testid={testId} />
    </label>
  );
}

export function GamificationPlansCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: plans, isLoading } = useAdminListGamificationPlans();
  const update = useAdminUpdateGamificationPlan();
  const reset = useAdminResetGamificationPlan();

  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  useEffect(() => {
    if (!plans) return;
    setDrafts(Object.fromEntries(plans.map((p) => [p.planId, { ...p.settings }])));
  }, [plans]);

  const refresh = () =>
    void queryClient.invalidateQueries({
      queryKey: getAdminListGamificationPlansQueryKey(),
    });

  const setDraft = (planId: string, patch: Partial<Draft>) =>
    setDrafts((prev) => ({ ...prev, [planId]: { ...prev[planId]!, ...patch } }));

  const setCreditOverride = (planId: string, key: string, raw: string) => {
    const draft = drafts[planId];
    if (!draft) return;
    const value = raw.trim();
    const overrides = { ...(draft.rewardCreditOverrides ?? {}) };
    if (!value) {
      delete overrides[key];
      setDraft(planId, { rewardCreditOverrides: overrides });
      return;
    }
    const credits = Number(value);
    if (!Number.isFinite(credits) || credits < 0 || credits > 1_000_000) {
      toast({
        title: "Invalid credit override",
        description: "Enter between 0 and 1,000,000 credits.",
        variant: "destructive",
      });
      return;
    }
    overrides[key] = Math.round(credits * 1000);
    setDraft(planId, { rewardCreditOverrides: overrides });
  };

  const onSave = (planId: string) => {
    const draft = drafts[planId];
    if (!draft) return;
    const validationError = validateReferralSettings(draft);
    if (validationError) {
      toast({ title: "Check referral settings", description: validationError, variant: "destructive" });
      return;
    }
    update.mutate(
      { planId, data: draft },
      {
        onSuccess: () => {
          refresh();
          toast({ title: "Saved", description: `Gamification settings updated for "${planId}".` });
        },
        onError: (error: any) =>
          toast({
            title: "Could not save",
            description: error?.message || "Please check the values and try again.",
            variant: "destructive",
          }),
      },
    );
  };

  const onReset = (planId: string) => {
    reset.mutate(
      { planId },
      {
        onSuccess: () => {
          refresh();
          toast({ title: "Reset", description: `"${planId}" is back on the defaults.` });
        },
        onError: () =>
          toast({ title: "Could not reset", description: "Please try again.", variant: "destructive" }),
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Gamification per plan</CardTitle>
        <CardDescription>
           Tune quests, streaks, purchase-based referral rates, and the upgrade meter for each
           plan — new plans automatically appear here with the defaults. Reward
           overrides use the single prepaid-credit balance; leave one blank to
           convert the legacy reward through the current rate card. The
           platform-wide switches live under Feature controls; a mechanic only
           shows for a tenant when both its global switch and its plan toggle are
           on.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading || !plans ? (
          <div className="space-y-3">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          plans.map((plan) => {
            const draft = drafts[plan.planId];
            if (!draft) return null;
            return (
              <div
                key={plan.planId}
                className="rounded-lg border border-border p-4 space-y-4"
                data-testid={`gamification-plan-${plan.planId}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{plan.planName}</span>
                    <span className="text-xs text-muted-foreground">({plan.planId})</span>
                    {plan.customized ? (
                      <Badge variant="secondary">customized</Badge>
                    ) : (
                      <Badge variant="outline">defaults</Badge>
                    )}
                  </div>
                  <div className="flex gap-2">
                    {plan.customized && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={reset.isPending}
                        onClick={() => onReset(plan.planId)}
                        data-testid={`reset-gamification-${plan.planId}`}
                      >
                        Reset to defaults
                      </Button>
                    )}
                    <Button
                      size="sm"
                      disabled={update.isPending}
                      onClick={() => onSave(plan.planId)}
                      data-testid={`save-gamification-${plan.planId}`}
                    >
                      Save
                    </Button>
                  </div>
                </div>

                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  <ToggleRow
                    label="Quests"
                    checked={draft.questsEnabled}
                    onChange={(v) => setDraft(plan.planId, { questsEnabled: v })}
                    testId={`toggle-quests-${plan.planId}`}
                  />
                  <ToggleRow
                    label="Streaks"
                    checked={draft.streaksEnabled}
                    onChange={(v) => setDraft(plan.planId, { streaksEnabled: v })}
                    testId={`toggle-streaks-${plan.planId}`}
                  />
                  <ToggleRow
                    label="Referrals"
                    checked={draft.referralsEnabled}
                    onChange={(v) => setDraft(plan.planId, { referralsEnabled: v })}
                    testId={`toggle-referrals-${plan.planId}`}
                  />
                  <ToggleRow
                    label="Upgrade meter"
                    checked={draft.progressMeterEnabled}
                    onChange={(v) => setDraft(plan.planId, { progressMeterEnabled: v })}
                    testId={`toggle-progress-${plan.planId}`}
                  />
                </div>

                 <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <NumberField
                    id={`mult-${plan.planId}`}
                    label="Reward multiplier %"
                    value={draft.rewardMultiplierPercent}
                    min={0}
                    max={1000}
                    onChange={(v) => setDraft(plan.planId, { rewardMultiplierPercent: v })}
                  />
                  <NumberField
                    id={`cap-${plan.planId}`}
                    label="Referral cap / code"
                    value={draft.referralMaxRedemptions}
                    min={1}
                    max={10000}
                    onChange={(v) => setDraft(plan.planId, { referralMaxRedemptions: v })}
                  />
                </div>

                <div className="space-y-3 rounded-md border border-primary/20 bg-primary/5 p-3">
                  <div>
                    <p className="text-sm font-medium">Purchase referral rewards</p>
                    <p className="text-xs text-muted-foreground">
                      Attaching an invite code awards nothing immediately. Rates apply to paid credit packs and wallet top-ups, not plan renewals. Each tier unlocks after the specified number of qualifying purchases; the next purchase uses the unlocked rate. Existing wallet balance rules may extend a bonus grant's effective expiry.
                    </p>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="space-y-1">
                      <Label htmlFor={`trigger-${plan.planId}`} className="text-xs text-muted-foreground">Reward trigger</Label>
                      <select
                        id={`trigger-${plan.planId}`}
                        data-testid={`referral-trigger-${plan.planId}`}
                        className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                        value={draft.referralTriggerMode}
                        onChange={(e) => setDraft(plan.planId, { referralTriggerMode: e.target.value as Draft["referralTriggerMode"] })}
                      >
                        <option value="every_purchase">Every qualifying purchase</option>
                        <option value="first_purchase">First qualifying purchase per workspace</option>
                      </select>
                    </div>
                    <NumberField id={`attribution-days-${plan.planId}`} label="Code attribution (days)" value={draft.referralAttributionDays} min={1} max={3650} onChange={(v) => setDraft(plan.planId, { referralAttributionDays: v })} />
                    <NumberField id={`bonus-expiry-days-${plan.planId}`} label="Requested bonus expiry (days)" value={draft.referralBonusExpiryDays} min={1} max={3650} onChange={(v) => setDraft(plan.planId, { referralBonusExpiryDays: v })} />
                  </div>
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      data-testid={`use-default-referral-slabs-${plan.planId}`}
                      checked={draft.referralSlabs === null}
                      onChange={(e) => setDraft(plan.planId, {
                        referralSlabs: e.target.checked ? null : DEFAULT_REFERRAL_SLABS.map((s) => ({ ...s })),
                      })}
                    />
                    Use default tiers (0 purchases: 10%; 5: 12%; 15: 15%)
                  </label>
                  {draft.referralSlabs !== null && (
                    <div className="space-y-2">
                      {draft.referralSlabs.map((slab, index) => {
                        const editSlab = (patch: Partial<typeof slab>) => setDraft(plan.planId, {
                          referralSlabs: draft.referralSlabs!.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row),
                        });
                        return (
                          <div key={index} className="grid gap-2 rounded-md border border-border/60 p-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
                            <NumberField id={`slab-threshold-${plan.planId}-${index}`} label="Purchases needed" value={slab.minReferrals} min={0} max={1_000_000} onChange={(v) => editSlab({ minReferrals: v })} />
                            <NumberField id={`slab-owner-${plan.planId}-${index}`} label="Referrer rate %" value={slab.referrerBps / 100} min={0} max={100} onChange={(v) => editSlab({ referrerBps: v * 100 })} />
                            <NumberField id={`slab-buyer-${plan.planId}-${index}`} label="Buyer bonus %" value={slab.refereeBps / 100} min={0} max={100} onChange={(v) => editSlab({ refereeBps: v * 100 })} />
                            <Button size="sm" variant="ghost" className="self-end" onClick={() => setDraft(plan.planId, { referralSlabs: draft.referralSlabs!.filter((_, i) => i !== index) })} disabled={draft.referralSlabs!.length <= 1} aria-label={`Remove tier ${index + 1}`}>Remove</Button>
                          </div>
                        );
                      })}
                      <Button size="sm" variant="outline" disabled={draft.referralSlabs.length >= 20} onClick={() => setDraft(plan.planId, { referralSlabs: [...draft.referralSlabs!, { minReferrals: draft.referralSlabs!.at(-1)!.minReferrals + 1, referrerBps: draft.referralSlabs!.at(-1)!.referrerBps, refereeBps: draft.referralSlabs!.at(-1)!.refereeBps }] })}>Add tier</Button>
                    </div>
                  )}
                </div>

                 <div className="space-y-3 rounded-md border border-primary/20 bg-primary/5 p-3">
                   <div>
                     <p className="text-sm font-medium">Unified reward credits</p>
                     <p className="text-xs text-muted-foreground">
                       Set an explicit prepaid-credit amount for any reward. Values
                       support up to three decimal places and the multiplier still
                       applies when the reward is claimed.
                     </p>
                   </div>
                   <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                     {QUEST_REWARD_OVERRIDES.map(([key, label]) => (
                       <div className="space-y-1" key={key}>
                         <Label
                           htmlFor={`override-${plan.planId}-${key}`}
                           className="text-xs text-muted-foreground"
                         >
                           {label} (credits)
                         </Label>
                         <Input
                           id={`override-${plan.planId}-${key}`}
                           type="number"
                           min={0}
                           max={1_000_000}
                           step="0.001"
                           value={overrideInputValue(draft.rewardCreditOverrides, key)}
                           placeholder="Auto-convert legacy reward"
                           onChange={(e) =>
                             setCreditOverride(plan.planId, key, e.target.value)
                           }
                           className="h-8"
                           data-testid={`input-reward-override-${plan.planId}-${key}`}
                         />
                       </div>
                     ))}
                     {STREAK_REWARD_OVERRIDES.map((days) => {
                       const key = `streak:${days}`;
                       return (
                         <div className="space-y-1" key={key}>
                           <Label
                             htmlFor={`override-${plan.planId}-${key}`}
                             className="text-xs text-muted-foreground"
                           >
                             {days}-day streak (credits)
                           </Label>
                           <Input
                             id={`override-${plan.planId}-${key}`}
                             type="number"
                             min={0}
                             max={1_000_000}
                             step="0.001"
                             value={overrideInputValue(
                               draft.rewardCreditOverrides,
                               key,
                             )}
                             placeholder="Auto-convert legacy reward"
                             onChange={(e) =>
                               setCreditOverride(plan.planId, key, e.target.value)
                             }
                             className="h-8"
                             data-testid={`input-reward-override-${plan.planId}-${key}`}
                           />
                         </div>
                       );
                     })}
                     {(["referrer", "referee"] as const).map((key) => (
                       <div className="space-y-1" key={key}>
                         <Label
                           htmlFor={`override-${plan.planId}-${key}`}
                           className="text-xs text-muted-foreground"
                         >
                           {key === "referrer" ? "Referrer" : "New friend"} reward (credits)
                         </Label>
                         <Input
                           id={`override-${plan.planId}-${key}`}
                           type="number"
                           min={0}
                           max={1_000_000}
                           step="0.001"
                           value={overrideInputValue(
                             draft.rewardCreditOverrides,
                             key,
                           )}
                           placeholder="Auto-convert legacy reward"
                           onChange={(e) =>
                             setCreditOverride(plan.planId, key, e.target.value)
                           }
                           className="h-8"
                           data-testid={`input-reward-override-${plan.planId}-${key}`}
                         />
                       </div>
                     ))}
                   </div>
                   <details className="text-xs text-muted-foreground">
                     <summary className="cursor-pointer font-medium">
                       Legacy reward buckets (kept for existing balances)
                     </summary>
                     <p className="mt-2">
                       Existing caption/image referral buckets are preserved and
                       still sent for API compatibility: referrer{" "}
                       {draft.referrerCaptionCredits} caption +{" "}
                       {draft.referrerImageCredits} image; friend{" "}
                       {draft.refereeCaptionCredits} caption +{" "}
                       {draft.refereeImageCredits} image. New claims use the
                       unified credit override above.
                     </p>
                   </details>
                 </div>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
