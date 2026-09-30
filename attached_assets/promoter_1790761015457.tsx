import { useState } from "react";
import {
  useGetPromoterMe,
  useApplyAsPromoter,
  useGetPromoterCommissions,
  getGetPromoterMeQueryKey,
  getGetPromoterCommissionsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  Copy,
  Clock,
  Hourglass,
  IndianRupee,
  Megaphone,
  ShieldCheck,
  TrendingUp,
  Wallet,
} from "lucide-react";

/**
 * The promoter dashboard.
 *
 * One endpoint drives every state: GET /promoter/me answers 404 when this
 * workspace hasn't applied, and otherwise carries the status. So this page
 * needs no routing logic of its own — it renders whichever of six states the
 * response describes.
 *
 * Requires the OpenAPI contract to be updated and codegen to have run; the
 * hooks above do not exist before that.
 */

const inr = (value: number) =>
  value.toLocaleString("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  });

const pct = (bps: number) => `${(bps / 100).toLocaleString()}%`;

export default function PromoterPage() {
  const { data, isLoading, isError, error } = useGetPromoterMe({
    query: { queryKey: getGetPromoterMeQueryKey(), retry: false },
  });

  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-4xl space-y-4 p-4 sm:p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  // 404 is the signal that this workspace is not a promoter yet.
  const status = (error as { status?: number } | undefined)?.status;
  if (isError && status === 404) return <ApplyState />;
  if (isError && status === 403) {
    return (
      <EmptyState
        title="Promoter program is closed"
        body="We're not accepting new promoters right now. Check back soon."
      />
    );
  }
  if (isError || !data) {
    return (
      <EmptyState
        title="Couldn't load your promoter account"
        body="Something went wrong on our side. Try refreshing."
      />
    );
  }

  if (data.status === "applied") return <PendingState appliedAt={data.appliedAt} />;
  if (data.status === "rejected")
    return (
      <EmptyState
        title="Application not approved"
        body={data.statusReason || "Your application wasn't approved this time."}
      />
    );

  return <Dashboard data={data} suspended={data.status === "suspended"} />;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function Dashboard({
  data,
  suspended,
}: {
  data: any;
  suspended: boolean;
}) {
  const { toast } = useToast();
  const { earnings, commission, terms, codes } = data;
  const code = codes?.[0];

  const copy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.code);
      toast({ title: "Copied", description: "Share it with your audience." });
    } catch {
      toast({ title: "Copy failed", description: code.code });
    }
  };

  const toNext =
    commission.nextSlabAt !== null
      ? Math.max(0, commission.nextSlabAt - commission.qualifyingPurchases)
      : null;
  const slabProgress =
    commission.nextSlabAt !== null && commission.nextSlabAt > 0
      ? Math.min(
          100,
          (commission.qualifyingPurchases / commission.nextSlabAt) * 100,
        )
      : 100;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Promoter</h1>
          <p className="text-sm text-muted-foreground">
            Earn {pct(commission.currentBps)} of every credit purchase made with
            your code.
          </p>
        </div>
        {suspended && (
          <span
            className="rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground"
            data-testid="promoter-suspended"
          >
            Suspended — {data.statusReason || "contact support"}
          </span>
        )}
      </header>

      {code && !suspended && (
        <Card className="border-primary/20 bg-primary/[0.03]">
          <CardContent className="flex flex-wrap items-center gap-3 py-4">
            <code
              className="flex-1 rounded-lg border border-border bg-background px-4 py-2.5 text-center text-lg font-semibold tracking-[0.2em]"
              data-testid="promoter-code"
            >
              {code.code}
            </code>
            <Button variant="outline" size="icon" onClick={copy} aria-label="Copy code">
              <Copy className="h-4 w-4" />
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-3 sm:grid-cols-4">
        <Stat
          icon={<Wallet className="h-4 w-4" />}
          label="Ready to pay"
          value={inr(earnings.payable)}
          tone="positive"
        />
        <Stat
          icon={<Hourglass className="h-4 w-4" />}
          label="Pending"
          value={inr(earnings.pending)}
        />
        <Stat
          icon={<IndianRupee className="h-4 w-4" />}
          label="Paid out"
          value={inr(earnings.paid)}
        />
        <Stat
          icon={<TrendingUp className="h-4 w-4" />}
          label="Sales driven"
          value={inr(earnings.grossDriven)}
        />
      </div>

      {/* The explainer. Promoters tolerate delay they can see and churn from
          delay they can't — so never show a pending number without its why. */}
      {earnings.pending > 0 && (
        <Card>
          <CardContent className="space-y-2.5 py-4">
            <p className="text-sm font-medium">
              {inr(earnings.pending)} pending
            </p>
            <ul className="space-y-1.5 text-sm text-muted-foreground">
              {earnings.inHoldWindow > 0 && (
                <li className="flex items-start gap-2">
                  <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    <strong className="font-medium text-foreground">
                      {earnings.inHoldWindow}
                    </strong>{" "}
                    in the {terms.holdDays}-day refund window
                  </span>
                </li>
              )}
              {earnings.awaitingActivation > 0 && (
                <li className="flex items-start gap-2">
                  <Hourglass className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    <strong className="font-medium text-foreground">
                      {earnings.awaitingActivation}
                    </strong>{" "}
                    waiting on activation — the workspace needs to use{" "}
                    {pct(terms.consumptionThresholdBps)} of the credits it bought
                  </span>
                </li>
              )}
              {earnings.held > 0 && (
                <li className="flex items-start gap-2">
                  <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{inr(earnings.held)} under review</span>
                </li>
              )}
            </ul>
            <p className="pt-1 text-xs text-muted-foreground">
              Payouts run {terms.payoutCadence} once you're past{" "}
              {inr(terms.minPayout)}.
            </p>
          </CardContent>
        </Card>
      )}

      {commission.nextSlabAt !== null && (
        <Card>
          <CardContent className="space-y-2.5 py-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">
                {toNext === 0
                  ? `You're on ${pct(commission.nextSlabBps)}`
                  : `${toNext} more ${toNext === 1 ? "sale" : "sales"} to ${pct(commission.nextSlabBps)}`}
              </span>
              <span className="text-xs text-muted-foreground">
                {commission.qualifyingPurchases}/{commission.nextSlabAt}
              </span>
            </div>
            <Progress value={slabProgress} />
            {commission.isNegotiatedRate && (
              <p className="text-xs text-muted-foreground">
                You're on a custom rate of {pct(commission.currentBps)}.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <CommissionTable />
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: "positive";
}) {
  return (
    <Card>
      <CardContent className="space-y-1 py-4">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {icon}
          {label}
        </div>
        <p
          className={`text-lg font-semibold tabular-nums ${
            tone === "positive" ? "text-primary" : ""
          }`}
          data-testid={`promoter-stat-${label.toLowerCase().replace(/\s+/g, "-")}`}
        >
          {value}
        </p>
      </CardContent>
    </Card>
  );
}

const STATE_LABEL: Record<string, string> = {
  pending: "Pending",
  payable: "Ready",
  held: "Under review",
  in_payout: "Paying out",
  paid: "Paid",
  reversed: "Reversed",
  expired: "Expired",
};

function CommissionTable() {
  const { data: rows, isLoading } = useGetPromoterCommissions(undefined, {
    query: { queryKey: getGetPromoterCommissionsQueryKey(), staleTime: 30_000 },
  });

  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (!rows?.length) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <Megaphone className="mx-auto mb-2 h-6 w-6 text-muted-foreground/60" />
          <p className="text-sm text-muted-foreground">
            No earnings yet. Share your code to get started.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Earnings</CardTitle>
      </CardHeader>
      <CardContent className="px-0 pb-2">
        <div className="divide-y divide-border">
          {rows.map((r: any) => (
            <div
              key={r.id}
              className="flex items-center justify-between gap-3 px-6 py-2.5"
              data-testid={`commission-${r.id}`}
            >
              <div className="min-w-0">
                <p className="truncate text-sm">{r.workspace}</p>
                <p className="text-xs text-muted-foreground">
                  {new Date(r.purchasedOn).toLocaleDateString("en-IN", {
                    day: "numeric",
                    month: "short",
                  })}{" "}
                  · {inr(r.gross)} purchase
                  {r.reason ? ` · ${r.reason}` : ""}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-sm font-medium tabular-nums">
                  {inr(r.commission)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {STATE_LABEL[r.state] ?? r.state}
                </p>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Pre-approval states
// ---------------------------------------------------------------------------

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto w-full max-w-lg p-4 sm:p-6">
      <Card>
        <CardContent className="space-y-1.5 py-10 text-center">
          <p className="font-medium">{title}</p>
          <p className="text-sm text-muted-foreground">{body}</p>
        </CardContent>
      </Card>
    </div>
  );
}

function PendingState({ appliedAt }: { appliedAt: string }) {
  return (
    <EmptyState
      title="Application under review"
      body={`Submitted ${new Date(appliedAt).toLocaleDateString("en-IN", {
        day: "numeric",
        month: "long",
      })}. We'll email you once it's been looked at.`}
    />
  );
}

const VERTICALS = [
  "general",
  "healthcare",
  "finance",
  "legal",
  "fitness",
  "education",
  "real-estate",
];

function ApplyState() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const apply = useApplyAsPromoter();

  const [displayName, setDisplayName] = useState("");
  const [vertical, setVertical] = useState("general");
  const [channelsRaw, setChannelsRaw] = useState("");
  const [isPractitioner, setIsPractitioner] = useState(false);
  const [accepted, setAccepted] = useState(false);

  const channels = channelsRaw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 10)
    .map((line) => {
      const [platform, handle] = line.split(/[\s,]+/);
      return { platform: platform ?? "other", handle: handle ?? platform ?? "" };
    })
    .filter((c) => c.handle);

  const canSubmit =
    displayName.trim().length >= 2 && channels.length > 0 && accepted;

  const submit = () => {
    apply.mutate(
      {
        data: {
          displayName: displayName.trim(),
          vertical,
          channels,
          isRegisteredPractitioner: isPractitioner,
          agreementAccepted: true,
        },
      },
      {
        onSuccess: (result: any) => {
          void queryClient.invalidateQueries({
            queryKey: getGetPromoterMeQueryKey(),
          });
          toast({ title: "Application sent", description: result.message });
        },
        onError: (err: any) =>
          toast({
            title: "Could not apply",
            description: err?.message || "Please try again.",
            variant: "destructive",
          }),
      },
    );
  };

  return (
    <div className="mx-auto w-full max-w-lg space-y-4 p-4 sm:p-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">
          Become a promoter
        </h1>
        <p className="text-sm text-muted-foreground">
          Share your code. Earn a percentage of every credit purchase made with
          it, paid in cash.
        </p>
      </div>

      <Card>
        <CardContent className="space-y-4 py-5">
          <div className="space-y-1.5">
            <Label htmlFor="displayName">Your name or brand</Label>
            <Input
              id="displayName"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="How your audience knows you"
              data-testid="input-promoter-name"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="vertical">What do you mostly talk about?</Label>
            <Select value={vertical} onValueChange={setVertical}>
              <SelectTrigger id="vertical" data-testid="select-promoter-vertical">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VERTICALS.map((v) => (
                  <SelectItem key={v} value={v}>
                    {v.replace("-", " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="channels">Where you'll share it</Label>
            <Textarea
              id="channels"
              rows={4}
              value={channelsRaw}
              onChange={(e) => setChannelsRaw(e.target.value)}
              placeholder={"instagram @yourhandle\nyoutube @yourchannel"}
              data-testid="input-promoter-channels"
            />
            <p className="text-xs text-muted-foreground">
              One per line — platform then handle.
            </p>
          </div>

          <label className="flex items-start gap-2.5 text-sm">
            <Checkbox
              checked={isPractitioner}
              onCheckedChange={(v) => setIsPractitioner(v === true)}
              data-testid="checkbox-promoter-practitioner"
            />
            <span className="text-muted-foreground">
              I'm a registered medical practitioner
            </span>
          </label>
          {isPractitioner && (
            <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
              You'll get content guidelines that keep your posts clear of
              NMC advertising rules — promote the tool, never patient outcomes
              or clinical claims.
            </p>
          )}

          <label className="flex items-start gap-2.5 text-sm">
            <Checkbox
              checked={accepted}
              onCheckedChange={(v) => setAccepted(v === true)}
              data-testid="checkbox-promoter-agreement"
            />
            <span className="text-muted-foreground">
              I accept the promoter agreement, and I'll disclose paid promotion
              as required.
            </span>
          </label>

          <Button
            className="w-full"
            disabled={!canSubmit || apply.isPending}
            onClick={submit}
            data-testid="button-promoter-apply"
          >
            {apply.isPending ? "Sending…" : "Apply"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
