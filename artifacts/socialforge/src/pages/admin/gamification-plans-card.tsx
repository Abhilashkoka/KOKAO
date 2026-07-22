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

  const onSave = (planId: string) => {
    const draft = drafts[planId];
    if (!draft) return;
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
          Tune quests, streaks, referral credits, and the upgrade meter for each
          plan — new plans automatically appear here with the defaults. The
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

                <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
                  <NumberField
                    id={`mult-${plan.planId}`}
                    label="Reward multiplier %"
                    value={draft.rewardMultiplierPercent}
                    min={0}
                    max={1000}
                    onChange={(v) => setDraft(plan.planId, { rewardMultiplierPercent: v })}
                  />
                  <NumberField
                    id={`referrer-cap-${plan.planId}`}
                    label="Referrer: captions"
                    value={draft.referrerCaptionCredits}
                    min={0}
                    max={1000}
                    onChange={(v) => setDraft(plan.planId, { referrerCaptionCredits: v })}
                  />
                  <NumberField
                    id={`referrer-img-${plan.planId}`}
                    label="Referrer: images"
                    value={draft.referrerImageCredits}
                    min={0}
                    max={1000}
                    onChange={(v) => setDraft(plan.planId, { referrerImageCredits: v })}
                  />
                  <NumberField
                    id={`referee-cap-${plan.planId}`}
                    label="Friend: captions"
                    value={draft.refereeCaptionCredits}
                    min={0}
                    max={1000}
                    onChange={(v) => setDraft(plan.planId, { refereeCaptionCredits: v })}
                  />
                  <NumberField
                    id={`referee-img-${plan.planId}`}
                    label="Friend: images"
                    value={draft.refereeImageCredits}
                    min={0}
                    max={1000}
                    onChange={(v) => setDraft(plan.planId, { refereeImageCredits: v })}
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
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
