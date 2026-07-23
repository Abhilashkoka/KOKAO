import { useState } from "react";
import {
  useGetGamification,
  useClaimGamificationReward,
  useGetReferralInfo,
  useGetMe,
  getGetGamificationQueryKey,
  getGetMeQueryKey,
  getGetReferralInfoQueryKey,
  type RewardAmounts,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  Flame,
  Gift,
  CheckCircle2,
  Circle,
  Copy,
  Sparkles,
  TrendingUp,
  Users,
  ChevronDown,
} from "lucide-react";
import { navigate } from "wouter/use-browser-location";

/**
 * The AI Studio gamification strip: getting-started quests, the daily
 * creation streak, an upgrade progress meter, and the referral dialog.
 * Renders nothing while loading or when every mechanic is switched off
 * (globally or for this tenant's plan) — the page looks exactly as before.
 */

function fmtReward(reward: RewardAmounts): string {
  const parts: string[] = [];
  if (reward.captionCredits > 0) parts.push(`+${reward.captionCredits} caption`);
  if (reward.imageCredits > 0) parts.push(`+${reward.imageCredits} image`);
  if (reward.videoCredits > 0) parts.push(`+${reward.videoCredits} video`);
  return parts.length ? `${parts.join(" · ")} credits` : "";
}

export function GamificationCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: state } = useGetGamification({
    query: { queryKey: getGetGamificationQueryKey(), staleTime: 30_000 },
  });
  const { data: me } = useGetMe();
  const claim = useClaimGamificationReward();
  const [referralOpen, setReferralOpen] = useState(false);
  // Collapsed by default to keep the card slim; auto-opens when a reward is
  // ready to claim. `expanded === null` means the user hasn't toggled yet.
  const [expanded, setExpanded] = useState<boolean | null>(null);

  if (
    !state ||
    (!state.questsEnabled &&
      !state.streaksEnabled &&
      !state.referralsEnabled &&
      !state.progressMeterEnabled)
  ) {
    return null;
  }

  const onClaim = (key: string) => {
    claim.mutate(
      { data: { key } },
      {
        onSuccess: (result) => {
          void queryClient.invalidateQueries({ queryKey: getGetGamificationQueryKey() });
          void queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
          toast({
            title: "Reward claimed!",
            description: `${fmtReward(result.granted)} added to your balance.`,
          });
        },
        onError: (error: any) =>
          toast({
            title: "Could not claim",
            description: error?.message || "Please try again.",
            variant: "destructive",
          }),
      },
    );
  };

  const unclaimedQuests = state.quests.filter((q) => !q.claimed);
  const claimableCount =
    state.quests.filter((q) => q.completed && !q.claimed).length +
    state.streak.milestones.filter((m) => m.reached && !m.claimed && m.claimKey).length;
  const showDetails = expanded ?? claimableCount > 0;

  // Progress meter only makes sense on finite plans; -1 means unlimited.
  const limits = me?.limits;
  const usage = me?.usage;
  const meterRows =
    state.progressMeterEnabled && limits && usage
      ? (
          [
            { label: "Captions", used: usage.captions, limit: limits.captions },
            { label: "Images", used: usage.images, limit: limits.images },
            { label: "Videos", used: usage.videos ?? 0, limit: limits.videos ?? 0 },
          ] as const
        ).filter((row) => row.limit > 0)
      : [];
  const meterMax = meterRows.length
    ? Math.max(...meterRows.map((r) => Math.min(1, r.used / r.limit)))
    : 0;

  return (
    <Card className="border-primary/20 bg-gradient-to-r from-primary/5 via-card to-card shadow-sm">
      <CardContent className="py-3 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <span className="font-semibold">Level up</span>
            {claimableCount > 0 && (
              <span
                className="rounded-full bg-primary/15 text-primary text-xs font-medium px-2 py-0.5"
                data-testid="claimable-count"
              >
                {claimableCount} reward{claimableCount === 1 ? "" : "s"} to claim
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {state.streaksEnabled && (
              <span
                className={`inline-flex items-center gap-1.5 text-sm font-medium ${
                  state.streak.currentDays > 0 ? "text-orange-500" : "text-muted-foreground"
                }`}
                data-testid="streak-days"
              >
                <Flame className="h-4 w-4" />
                {state.streak.currentDays}-day streak
                {state.streaksEnabled && state.streak.currentDays > 0 && !state.streak.activeToday && (
                  <span className="text-xs text-muted-foreground font-normal">
                    · create today to keep it
                  </span>
                )}
              </span>
            )}
            {state.referralsEnabled && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setReferralOpen(true)}
                data-testid="button-open-referral"
              >
                <Users className="h-4 w-4 mr-1.5" /> Invite &amp; earn
              </Button>
            )}
            <button
              type="button"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setExpanded(!showDetails)}
              aria-expanded={showDetails}
              data-testid="button-toggle-gamification"
            >
              {showDetails ? "Hide" : "Details"}
              <ChevronDown
                className={`h-3.5 w-3.5 transition-transform ${showDetails ? "rotate-180" : ""}`}
              />
            </button>
          </div>
        </div>

        {showDetails && state.streaksEnabled && state.streak.milestones.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {state.streak.milestones.map((m) => (
              <div
                key={m.days}
                className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
                  m.claimed
                    ? "border-primary/30 bg-primary/10 text-primary"
                    : m.reached
                      ? "border-orange-300 bg-orange-50 dark:bg-orange-950/30 text-orange-600"
                      : "border-border text-muted-foreground"
                }`}
              >
                <Flame className="h-3 w-3" />
                {m.days}d
                {m.claimed ? (
                  <CheckCircle2 className="h-3 w-3" />
                ) : m.reached && m.claimKey ? (
                  <button
                    type="button"
                    className="font-semibold underline underline-offset-2"
                    disabled={claim.isPending}
                    onClick={() => onClaim(m.claimKey!)}
                    data-testid={`claim-streak-${m.days}`}
                  >
                    Claim {fmtReward(m.reward)}
                  </button>
                ) : (
                  <span>{fmtReward(m.reward)}</span>
                )}
              </div>
            ))}
          </div>
        )}

        {showDetails && state.questsEnabled && unclaimedQuests.length > 0 && (
          <div className="grid gap-1.5 sm:grid-cols-2">
            {unclaimedQuests.map((quest) => (
              <div
                key={quest.id}
                className="flex items-center gap-2.5 rounded-lg border border-border/60 bg-background/60 px-3 py-2"
                data-testid={`quest-${quest.id}`}
              >
                {quest.completed ? (
                  <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />
                ) : (
                  <Circle className="h-4 w-4 text-muted-foreground/50 shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{quest.title}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {quest.completed ? fmtReward(quest.reward) : quest.description}
                  </p>
                </div>
                {quest.completed && (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="shrink-0"
                    disabled={claim.isPending}
                    onClick={() => onClaim(quest.claimKey)}
                    data-testid={`claim-quest-${quest.id}`}
                  >
                    <Gift className="h-3.5 w-3.5 mr-1" /> Claim
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}

        {showDetails && meterRows.length > 0 && (
          <div className="rounded-lg border border-border/60 bg-background/60 px-3 py-2.5 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium inline-flex items-center gap-1.5">
                <TrendingUp className="h-4 w-4 text-primary" />
                {meterMax >= 1
                  ? "You've hit this month's limit — you're clearly on a roll"
                  : meterMax >= 0.7
                    ? "You're creating faster than your plan"
                    : "Your plan this month"}
              </span>
              <Button
                size="sm"
                variant={meterMax >= 0.7 ? "default" : "outline"}
                onClick={() => navigate("/settings")}
                data-testid="button-upgrade-meter"
              >
                Upgrade
              </Button>
            </div>
            <div className="grid gap-1.5 sm:grid-cols-3">
              {meterRows.map((row) => (
                <div key={row.label} className="space-y-1">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>{row.label}</span>
                    <span>
                      {Math.min(row.used, row.limit)}/{row.limit}
                    </span>
                  </div>
                  <Progress value={Math.min(100, (row.used / row.limit) * 100)} />
                </div>
              ))}
            </div>
          </div>
        )}

        <ReferralDialog open={referralOpen} onOpenChange={setReferralOpen} />
      </CardContent>
    </Card>
  );
}

function ReferralDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const { data: referral, isLoading } = useGetReferralInfo({
    query: { queryKey: getGetReferralInfoQueryKey(), enabled: open },
  });

  const copy = async () => {
    if (!referral) return;
    try {
      await navigator.clipboard.writeText(referral.code);
      toast({ title: "Copied!", description: "Share the code with a friend." });
    } catch {
      toast({ title: "Copy failed", description: referral.code });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" /> Invite friends, earn credits
          </DialogTitle>
          <DialogDescription>
            {referral
              ? `Friends redeem your code on their Billing page within 30 days of signing up. They get ${referral.refereeCaptionCredits} caption + ${referral.refereeImageCredits} image credits — you earn ${referral.referrerCaptionCredits} caption + ${referral.referrerImageCredits} image credits per signup.`
              : "Loading your personal code…"}
          </DialogDescription>
        </DialogHeader>
        {!isLoading && referral && (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <code
                className="flex-1 rounded-lg border border-border bg-muted px-3 py-2 text-center text-lg font-semibold tracking-widest"
                data-testid="referral-code"
              >
                {referral.code}
              </code>
              <Button variant="outline" size="icon" onClick={copy} aria-label="Copy code">
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg bg-muted/60 py-2">
                <p className="text-lg font-semibold">{referral.redemptions}</p>
                <p className="text-xs text-muted-foreground">signups</p>
              </div>
              <div className="rounded-lg bg-muted/60 py-2">
                <p className="text-lg font-semibold">{referral.captionCreditsEarned}</p>
                <p className="text-xs text-muted-foreground">captions earned</p>
              </div>
              <div className="rounded-lg bg-muted/60 py-2">
                <p className="text-lg font-semibold">{referral.imageCreditsEarned}</p>
                <p className="text-xs text-muted-foreground">images earned</p>
              </div>
            </div>
            {referral.maxRedemptions !== null && (
              <p className="text-xs text-muted-foreground text-center">
                Up to {referral.maxRedemptions} redemptions on this code.
              </p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
