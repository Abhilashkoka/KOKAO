import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useAdminGetAiErrorGuarantee,
  useAdminUpdateAiErrorGuarantee,
  useAdminListAiErrorClaims,
  useAdminApproveAiErrorClaim,
  useAdminRejectAiErrorClaim,
  getAdminGetAiErrorGuaranteeQueryKey,
  getAdminListAiErrorClaimsQueryKey,
  type AdminAiErrorClaim,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { ShieldAlert } from "lucide-react";
import { CLAIM_CATEGORY_LABELS } from "@/components/report-ai-error";

const storage = (path: string) => `/api/storage${path}`;

function fmt(n: number): string {
  return n.toLocaleString("en-IN", { maximumFractionDigits: 1 });
}

function categoryLabel(category: string): string {
  return (CLAIM_CATEGORY_LABELS as Record<string, string>)[category] ?? category;
}

/**
 * Superadmin: AI Error Guarantee switch, limits, this month's claims by
 * category (what to fix in prompts and models), and the pending queue.
 */
export function AiErrorClaimsCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: settings } = useAdminGetAiErrorGuarantee();
  const updateSettings = useAdminUpdateAiErrorGuarantee();
  const params = { status: "pending" as const };
  const { data: list } = useAdminListAiErrorClaims(params, {
    query: { queryKey: getAdminListAiErrorClaimsQueryKey(params), refetchInterval: 60_000 },
  });
  const [enabled, setEnabled] = useState(false);
  const [windowDays, setWindowDays] = useState("7");
  const [perMonth, setPerMonth] = useState("2");
  const [maxPercent, setMaxPercent] = useState("50");

  useEffect(() => {
    if (!settings) return;
    setEnabled(settings.enabled);
    setWindowDays(String(settings.claimWindowDays));
    setPerMonth(String(settings.autoApprovePerMonth));
    setMaxPercent(String(settings.autoApproveMaxPercent));
  }, [settings]);

  const saveSettings = () => {
    updateSettings.mutate(
      {
        data: {
          enabled,
          claimWindowDays: Math.trunc(Number(windowDays)),
          autoApprovePerMonth: Math.trunc(Number(perMonth)),
          autoApproveMaxPercent: Math.trunc(Number(maxPercent)),
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Guarantee settings saved" });
          queryClient.invalidateQueries({ queryKey: getAdminGetAiErrorGuaranteeQueryKey() });
        },
        onError: (error) =>
          toast({
            title: "Could not save",
            description: apiErrorMessage(error, "Check the numbers and try again."),
            variant: "destructive",
          }),
      },
    );
  };

  const report = list?.report;
  return (
    <Card className="border-border shadow-sm" data-testid="card-ai-error-claims">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldAlert className="h-5 w-5 text-primary" /> AI Error Guarantee
        </CardTitle>
        <CardDescription>
          Users claim credits back for the part of a finished video the AI got wrong.
          Switch on only once the matching terms clause is live.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <Switch checked={enabled} onCheckedChange={setEnabled} data-testid="switch-ai-error-guarantee" />
            <span className="text-sm">{enabled ? "Guarantee on" : "Off — no Report AI error button"}</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="guarantee-window">Claim window (days)</Label>
              <Input id="guarantee-window" type="number" min={1} max={90} value={windowDays} onChange={(e) => setWindowDays(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="guarantee-per-month">Auto-approve per workspace / month</Label>
              <Input id="guarantee-per-month" type="number" min={0} max={100} value={perMonth} onChange={(e) => setPerMonth(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="guarantee-max">Auto-approve up to (% of video)</Label>
              <Input id="guarantee-max" type="number" min={0} max={100} value={maxPercent} onChange={(e) => setMaxPercent(e.target.value)} />
            </div>
          </div>
          <Button onClick={saveSettings} disabled={updateSettings.isPending} data-testid="button-save-ai-error-guarantee">
            {updateSettings.isPending ? "Saving..." : "Save"}
          </Button>
        </div>

        {report && (
          <div className="space-y-2 border-t border-border pt-4" data-testid="ai-error-report">
            <p className="text-sm">
              This month: <strong>{report.monthClaims}</strong> claims,{" "}
              <strong>{fmt(report.monthRefundedCredits)}</strong> credits refunded,{" "}
              <strong>{report.pending}</strong> waiting.
            </p>
            {report.byCategory.length > 0 && (
              <ul className="space-y-1 text-xs text-muted-foreground">
                {report.byCategory.map((row) => (
                  <li key={row.category} className="flex justify-between gap-3">
                    <span>{categoryLabel(row.category)}</span>
                    <span className="tabular-nums">{row.claims}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="space-y-3 border-t border-border pt-4">
          <p className="text-sm font-medium">Waiting for a decision</p>
          {list && list.claims.length === 0 && (
            <p className="text-xs text-muted-foreground">No claims waiting.</p>
          )}
          {list?.claims.map((claim) => <PendingClaim key={claim.id} claim={claim} />)}
        </div>
      </CardContent>
    </Card>
  );
}

function PendingClaim({ claim }: { claim: AdminAiErrorClaim }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const approve = useAdminApproveAiErrorClaim();
  const reject = useAdminRejectAiErrorClaim();
  const [credits, setCredits] = useState(String(claim.suggestedCredits));
  const [note, setNote] = useState("");
  const done = (title: string) => () => {
    toast({ title });
    void queryClient.invalidateQueries({ queryKey: getAdminListAiErrorClaimsQueryKey({ status: "pending" }) });
  };
  const failed = (error: unknown) =>
    toast({ title: "Could not save the decision", description: apiErrorMessage(error, "Please try again."), variant: "destructive" });
  const busy = approve.isPending || reject.isPending;
  const share = claim.videoDurationSec > 0
    ? Math.round(((claim.endSec - claim.startSec) / claim.videoDurationSec) * 100)
    : 0;

  return (
    <div className="space-y-2 rounded-md border border-border p-3 text-sm" data-testid={`ai-error-claim-${claim.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">{categoryLabel(claim.category)}</Badge>
        <span className="text-xs text-muted-foreground">
          Workspace {claim.tenantId} · video #{claim.jobId} · {fmt(claim.startSec)}s–{fmt(claim.endSec)}s of{" "}
          {fmt(claim.videoDurationSec)}s ({share}%) · {new Date(claim.createdAt).toLocaleString()}
        </span>
      </div>
      {claim.note && <p className="text-sm">“{claim.note}”</p>}
      {claim.videoPath && (
        <video
          src={`${storage(claim.videoPath)}#t=${claim.startSec},${claim.endSec}`}
          controls
          preload="metadata"
          className="max-h-48 rounded-md bg-black"
        />
      )}
      <div className="grid gap-2 sm:grid-cols-[8rem_1fr]">
        <div className="space-y-1">
          <Label htmlFor={`claim-credits-${claim.id}`} className="text-xs">Refund (credits)</Label>
          <Input
            id={`claim-credits-${claim.id}`}
            type="number"
            min={0}
            value={credits}
            onChange={(e) => setCredits(e.target.value)}
            data-testid={`input-claim-credits-${claim.id}`}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`claim-note-${claim.id}`} className="text-xs">Note to the user (required to reject)</Label>
          <Input
            id={`claim-note-${claim.id}`}
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
            data-testid={`input-claim-note-${claim.id}`}
          />
        </div>
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            approve.mutate(
              { id: claim.id, data: { credits: Number(credits), note: note.trim() || null } },
              { onSuccess: done("Claim approved and refunded"), onError: failed },
            )
          }
          data-testid={`button-approve-claim-${claim.id}`}
        >
          Approve · refund {fmt(Number(credits) || 0)}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || note.trim().length === 0}
          onClick={() =>
            reject.mutate(
              { id: claim.id, data: { note: note.trim() } },
              { onSuccess: done("Claim rejected"), onError: failed },
            )
          }
          data-testid={`button-reject-claim-${claim.id}`}
        >
          Reject
        </Button>
      </div>
    </div>
  );
}
