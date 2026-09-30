import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ApiError, getPromoterMeQueryKey, getPromoterCommissionsQueryKey,
  usePromoterMe, usePromoterApply, usePromoterCommissions,
} from "@workspace/api-client-react";
import type { PromoterMe200, PromoterCommission, CreatorApplicationBody } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { PromoterPayoutDetails } from "@/components/promoter-payout-details";

const money = (n: number) => n.toLocaleString("en-IN", { style: "currency", currency: "INR" });
const percent = (bps: number) => `${bps / 100}%`;
function apiMessage(error: unknown, fallback: string) {
  const data: unknown = error instanceof ApiError ? error.data : null;
  if (data && typeof data === "object" && "error" in data && typeof data.error === "string") return data.error;
  return error instanceof Error ? error.message : fallback;
}
function State({ title, body }: { title: string; body: string }) {
  return <div className="mx-auto max-w-xl p-6"><Card><CardContent className="space-y-2 py-10 text-center"><h1 className="text-xl font-semibold">{title}</h1><p className="text-sm text-muted-foreground">{body}</p></CardContent></Card></div>;
}

export default function PromoterPage() {
  const me = usePromoterMe({ query: { queryKey: getPromoterMeQueryKey(), retry: false } });
  if (me.isLoading) return <div className="mx-auto max-w-4xl space-y-4 p-6"><Skeleton className="h-10 w-48" /><Skeleton className="h-40" /><Skeleton className="h-64" /></div>;
  if (me.isError) {
    const errorData: unknown = me.error instanceof ApiError ? me.error.data : null;
    const code = errorData && typeof errorData === "object" && "code" in errorData ? errorData.code : undefined;
    if (me.error.status === 404 && code === "not_a_promoter") return <ApplyState />;
    if (me.error.status === 403 && code === "feature_disabled") return <State title="Promoter programme is closed" body="We're not accepting new promoters right now. Please check back later." />;
    return <div className="mx-auto max-w-xl space-y-4 p-6"><State title="Couldn't load your promoter account" body={apiMessage(me.error, "Please try again.")} /><Button onClick={() => void me.refetch()}>Try again</Button></div>;
  }
  const data = me.data;
  if (!data) return <State title="Couldn't load your promoter account" body="Please try again." />;
  if (data.status === "applied") return <State title="Application under review" body={`Submitted ${data.appliedAt ? new Date(data.appliedAt).toLocaleDateString("en-IN") : "recently"}. We'll email you when it's reviewed.`} />;
  if (data.status === "rejected") return <State title="Application not approved" body={data.statusReason || "Your application wasn't approved this time."} />;
  if (data.status !== "approved" && data.status !== "suspended") return <State title="Promoter account unavailable" body="Please contact support." />;
  return <PromoterDashboard data={data} />;
}

export function PromoterDashboard({ data, title = "Promoter" }: { data: PromoterMe200; title?: string }) {
  const { toast } = useToast();
  const suspended = data.status === "suspended";
  const { earnings, commission, terms } = data;
  const code = suspended ? undefined : data.codes[0];
  const next = commission.nextSlabAt;
  return <div className="mx-auto max-w-4xl space-y-5 p-4 sm:p-6">
    <header><h1 className="text-2xl font-semibold">{title}</h1><p className="text-sm text-muted-foreground">Your current commission rate is {percent(commission.currentBps)} on qualifying purchases.</p></header>
    {suspended && <Card data-testid="promoter-suspended"><CardContent className="py-4">Your account is suspended{data.statusReason ? `: ${data.statusReason}` : "."} Your existing earnings remain visible.</CardContent></Card>}
    {code && <Card className="border-primary/20 bg-primary/[0.03]"><CardContent className="flex items-center gap-3 py-4"><code data-testid="promoter-code" className="flex-1 rounded border border-border bg-background px-4 py-2 text-center text-lg font-semibold tracking-widest">{code.code}</code><Button variant="outline" onClick={() => void navigator.clipboard.writeText(code.code).then(() => toast({ title: "Copied" })).catch(() => toast({ title: "Copy failed", description: code.code }))}>Copy code</Button></CardContent></Card>}
    <div className="grid gap-3 sm:grid-cols-4">{([["Ready to pay", earnings.payable], ["Pending", earnings.pending], ["Paid out", earnings.paid], ["Sales driven", earnings.grossDriven]] as const).map(([label, value]) => <Card key={label}><CardContent className="py-4"><p className="text-xs text-muted-foreground">{label}</p><p className="text-lg font-semibold" data-testid={`promoter-stat-${label.toLowerCase().replaceAll(" ", "-")}`}>{money(value)}</p></CardContent></Card>)}</div>
    <p className="text-xs text-muted-foreground">Commissions marked “Ready to pay” have accrued. Payouts require manual review and verification; no transfer date is available.</p>
    {(earnings.pending > 0 || earnings.held > 0) && <Card><CardContent className="space-y-2 py-4"><h2 className="font-medium">{money(earnings.pending)} pending</h2><ul className="space-y-1 text-sm text-muted-foreground">
      {earnings.inHoldWindow > 0 && <li>{earnings.inHoldWindow} in the {terms.holdDays}-day refund window</li>}
      {earnings.awaitingActivation > 0 && <li>{earnings.awaitingActivation} waiting on activation — the workspace needs to use {percent(terms.consumptionThresholdBps)} of the credits it bought</li>}
      {earnings.held > 0 && <li>{money(earnings.held)} under review</li>}
    </ul></CardContent></Card>}
    <PromoterPayoutDetails suspended={suspended} />
    {next !== null && !commission.isNegotiatedRate && <Card><CardContent className="space-y-2 py-4"><p className="text-sm">{Math.max(0, next - commission.qualifyingPurchases)} more qualifying purchases to {percent(commission.nextSlabBps ?? commission.currentBps)}</p><Progress value={next > 0 ? Math.min(100, commission.qualifyingPurchases / next * 100) : 100} /></CardContent></Card>}
    {commission.isNegotiatedRate && <p className="text-sm text-muted-foreground">Your negotiated rate is {percent(commission.currentBps)}.</p>}
    <CommissionTable />
  </div>;
}

function CommissionTable() {
  const rows = usePromoterCommissions(undefined, { query: { queryKey: getPromoterCommissionsQueryKey(), retry: false } });
  if (rows.isLoading) return <Skeleton className="h-40" />;
  if (rows.isError) return <p role="alert" className="text-sm text-destructive">Couldn't load your commissions. <Button variant="outline" onClick={() => void rows.refetch()}>Try again</Button></p>;
  return <Card><CardHeader><CardTitle className="text-base">Earnings</CardTitle></CardHeader><CardContent>{!rows.data?.length ? <p className="text-sm text-muted-foreground">No earnings yet. Share your code to get started.</p> : <div className="divide-y divide-border">{rows.data.map((row: PromoterCommission) => <div key={row.id} data-testid={`commission-${row.id}`} className="flex justify-between gap-3 py-3"><div><p className="text-sm">{row.workspace}</p><p className="text-xs text-muted-foreground">{new Date(row.purchasedOn).toLocaleDateString("en-IN")} · {money(row.gross)} purchase</p></div><div className="text-right text-sm"><p>{money(row.commission)}</p><p className="text-xs text-muted-foreground">{row.state === "held" ? "Under review" : row.state === "payable" ? "Ready to pay" : row.state.replaceAll("_", " ")}</p></div></div>)}</div>}</CardContent></Card>;
}

export function PromoterApplyForm() {
  return <ApplyState />;
}

function ApplyState() {
  const { toast } = useToast();
  const client = useQueryClient();
  const apply = usePromoterApply();
  const [displayName, setDisplayName] = useState("");
  const [vertical, setVertical] = useState("general");
  const [channelsRaw, setChannelsRaw] = useState("");
  const [practitioner, setPractitioner] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const channels: CreatorApplicationBody["channels"] = channelsRaw.split("\n").map(line => line.trim()).filter(Boolean).map(line => {
    const match = line.match(/^(\S+)\s+(.+)$/);
    return match ? { platform: match[1], handle: match[2].trim() } : { platform: "", handle: "" };
  });
  const errors = [
    ...(displayName.trim().length < 2 || displayName.trim().length > 120 ? ["Enter your name or brand (2–120 characters)."] : []),
    ...(channels.length < 1 || channels.length > 20 ? ["Add between 1 and 20 channels where you will share your code."] : []),
    ...(!channels.every(c => c.platform.length >= 1 && c.platform.length <= 60 && c.handle.length >= 1 && c.handle.length <= 160) ? ["Enter each channel as platform then handle, for example: instagram @yourhandle."] : []),
    ...(!accepted ? ["Accept the promoter agreement before applying."] : []),
  ];
  if (sent) return <State title="Application under review" body="Your application has been submitted successfully. We'll notify you when it's reviewed." />;
  return <div className="mx-auto max-w-xl space-y-4 p-4 sm:p-6"><h1 className="text-2xl font-semibold">Become a promoter</h1><p className="text-sm text-muted-foreground">Share your code to accrue commissions on qualifying purchases. Payouts require manual review and identity verification; availability and timing are not guaranteed.</p><Card><CardContent className="space-y-4 py-5">
    <div className="space-y-1"><Label htmlFor="promoter-name">Your name or brand</Label><Input id="promoter-name" data-testid="input-promoter-name" value={displayName} onChange={e => setDisplayName(e.target.value)} /></div>
    <div className="space-y-1"><Label htmlFor="promoter-vertical">What do you mostly talk about?</Label><Input id="promoter-vertical" value={vertical} onChange={e => setVertical(e.target.value)} maxLength={80} /></div>
    <div className="space-y-1"><Label htmlFor="promoter-channels">Where you'll share it</Label><Textarea id="promoter-channels" data-testid="input-promoter-channels" value={channelsRaw} onChange={e => setChannelsRaw(e.target.value)} placeholder={"instagram @yourhandle\nyoutube @yourchannel"} /><p className="text-xs text-muted-foreground">One per line: platform then handle (up to 20).</p></div>
    <label className="flex items-center gap-2 text-sm"><Checkbox data-testid="checkbox-promoter-practitioner" checked={practitioner} onCheckedChange={v => setPractitioner(v === true)} />I'm a registered medical practitioner</label>
    {practitioner && <p className="rounded bg-muted p-3 text-xs text-muted-foreground">Follow applicable NMC advertising guidance. Promote the tool, not patient outcomes or clinical claims; this is not legal advice.</p>}
    <label className="flex items-start gap-2 text-sm"><Checkbox data-testid="checkbox-promoter-agreement" checked={accepted} onCheckedChange={v => setAccepted(v === true)} />I accept the promoter agreement and will disclose paid promotions as required.</label>
    {attempted && errors.length > 0 && <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"><ul className="list-disc space-y-1 pl-4">{errors.map(error => <li key={error}>{error}</li>)}</ul></div>}
    {submitError && <p role="alert" className="text-sm text-destructive">{submitError}</p>}
    <Button data-testid="button-promoter-apply" className="w-full" disabled={apply.isPending} onClick={() => {
      setAttempted(true);
      setSubmitError(null);
      if (errors.length > 0 || apply.isPending) return;
      apply.mutate({ data: { displayName: displayName.trim(), vertical: vertical.trim(), channels, isRegisteredPractitioner: practitioner, agreementAccepted: true } }, {
        onSuccess: result => { setSent(true); void client.invalidateQueries({ queryKey: getPromoterMeQueryKey() }); toast({ title: "Application sent", description: result.message }); },
        onError: error => { const message = apiMessage(error, "Please try again."); setSubmitError(message); toast({ title: "Could not apply", description: message, variant: "destructive" }); },
      });
    }}>{apply.isPending ? "Sending…" : "Apply"}</Button>
  </CardContent></Card></div>;
}