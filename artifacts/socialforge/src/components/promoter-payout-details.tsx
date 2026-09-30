import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ApiError, getGetPromoterPayoutDetailsQueryKey, getGetPromoterPayoutsQueryKey,
  useGetPromoterPayoutDetails, useGetPromoterPayouts, useSavePromoterPayoutDetails,
} from "@workspace/api-client-react";
import type { PromoterPayoutDetails } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Banknote, Lock, ShieldCheck } from "lucide-react";

const inr = (value: number) => value.toLocaleString("en-IN", { style: "currency", currency: "INR" });
const statusText: Record<string, string> = { draft: "Awaiting manual review", exported: "Under manual review", paid: "Paid", failed: "Failed — awaiting retry" };
function message(error: unknown) {
  const data: unknown = error instanceof ApiError ? error.data : null;
  if (data && typeof data === "object" && "error" in data && typeof data.error === "string")
    return data.error;
  return "Please try again, or contact support if this continues.";
}
export function PromoterPayoutDetails({ suspended = false }: { suspended?: boolean }) {
  const details = useGetPromoterPayoutDetails({ query: { queryKey: getGetPromoterPayoutDetailsQueryKey(), retry: false } });
  const history = useGetPromoterPayouts({ query: { queryKey: getGetPromoterPayoutsQueryKey(), retry: false, staleTime: 30_000 } });
  if (details.isLoading || history.isLoading) return <Skeleton className="h-48 w-full" />;
  return <section className="space-y-4" aria-label="Payout details and history">
    <p className="text-xs text-muted-foreground">Payouts require manual verification and processing. No automatic transfer or payment date is guaranteed.</p>
    {details.isError
      ? <p role="alert" className="text-sm text-destructive">Could not load payout details. <Button variant="outline" onClick={() => void details.refetch()}>Try again</Button></p>
      : suspended
        ? <p className="text-sm text-muted-foreground">Your account is suspended. Payout details cannot be changed, but your history remains visible.</p>
        : details.data?.onFile
          ? <OnFile details={details.data} />
          : <PayoutForm />}
    {history.isError && <p role="alert" className="text-sm text-destructive">Could not load payout history. <Button variant="outline" onClick={() => void history.refetch()}>Try again</Button></p>}
    {!!history.data?.payouts.length && <Card><CardHeader><CardTitle className="text-sm">Payout history</CardTitle></CardHeader><CardContent className="divide-y divide-border">
      {history.data.payouts.map(p => <div key={p.id} data-testid={`payout-${p.id}`} className="flex justify-between gap-3 py-3 text-sm"><div><p>{inr(p.net)}</p><p className="text-xs text-muted-foreground">{inr(p.gross)} gross · {inr(p.tds)} withheld · {inr(p.reserveHeld)} reserve{p.reserveReleasedAt ? " (released)" : ""}</p></div><div className="text-right text-xs text-muted-foreground"><p>{statusText[p.status] ?? "Under review"}</p>{p.paidAt && <p>{new Date(p.paidAt).toLocaleDateString("en-IN")}</p>}</div></div>)}
    </CardContent></Card>}
    {!!history.data?.balance.owedBack && <Card><CardContent className="py-4 text-sm"><p className="font-medium">{inr(history.data.balance.owedBack)} adjustment carried forward</p><p className="text-muted-foreground">A previously paid commission was reversed. This is offset against future earnings; no direct repayment is requested.</p></CardContent></Card>}
  </section>;
}
function OnFile({ details }: { details: PromoterPayoutDetails }) {
  const [editing, setEditing] = useState(false);
  if (editing) return <PayoutForm onDone={() => setEditing(false)} />;
  return <Card><CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
    <div className="flex items-start gap-2"><Banknote className="mt-0.5 h-4 w-4 text-muted-foreground" /><div className="text-sm">
      <p className="font-medium" data-testid="payout-details-on-file">{details.beneficiaryName}</p>
      <p className="text-muted-foreground">••••{details.bankLast4} · {details.ifsc} · PAN ••••{details.panLast4}</p>
    </div></div>
    <div className="flex items-center gap-2">{details.verified && <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><ShieldCheck className="h-4 w-4" /> Verified</span>}<Button size="sm" variant="outline" onClick={() => setEditing(true)}>Change</Button></div>
  </CardContent></Card>;
}
function PayoutForm({ onDone }: { onDone?: () => void }) {
  const { toast } = useToast();
  const client = useQueryClient();
  const save = useSavePromoterPayoutDetails();
  const [name, setName] = useState("");
  const [pan, setPan] = useState("");
  const [account, setAccount] = useState("");
  const [ifsc, setIfsc] = useState("");
  const valid = name.trim().length >= 2 && name.trim().length <= 120 && !/[\r\n\u0000-\u001f]/.test(name) &&
    /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan) && /^[0-9]{6,20}$/.test(account) && /^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc);
  return <Card><CardHeader><CardTitle className="flex items-center gap-2 text-sm"><Banknote className="h-4 w-4" /> Where to send your earnings</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      <div><Label htmlFor="beneficiaryName">Name on the account</Label><Input id="beneficiaryName" value={name} maxLength={120} autoComplete="off" onChange={e => setName(e.target.value)} data-testid="input-beneficiary-name" /></div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div><Label htmlFor="accountNumber">Account number</Label><Input id="accountNumber" type="password" value={account} maxLength={20} inputMode="numeric" autoComplete="off" onChange={e => setAccount(e.target.value.replace(/\s/g, ""))} data-testid="input-account-number" /></div>
        <div><Label htmlFor="ifsc">IFSC</Label><Input id="ifsc" value={ifsc} maxLength={11} className="font-mono" autoComplete="off" onChange={e => setIfsc(e.target.value.toUpperCase())} data-testid="input-ifsc" /></div>
      </div>
      <div><Label htmlFor="pan">PAN</Label><Input id="pan" type="password" value={pan} maxLength={10} className="font-mono" autoComplete="off" onChange={e => setPan(e.target.value.toUpperCase())} data-testid="input-pan" /><p className="text-xs text-muted-foreground">Collected for applicable tax processing. Ask your tax adviser about your circumstances.</p></div>
      <p className="flex gap-2 rounded-lg bg-muted p-3 text-xs text-muted-foreground"><Lock className="h-4 w-4 shrink-0" />Only keyed hashes and the last four characters are saved; full numbers cannot be shown again. Verification is required before a manual payout.</p>
      <div className="flex gap-2"><Button className="flex-1" disabled={!valid || save.isPending} data-testid="button-save-payout-details" onClick={() => save.mutate({ data: { beneficiaryName: name.trim(), pan, accountNumber: account, ifsc } }, {
        onSuccess: () => {
          setName(""); setPan(""); setAccount(""); setIfsc("");
          void client.invalidateQueries({ queryKey: getGetPromoterPayoutDetailsQueryKey() });
          void client.invalidateQueries({ queryKey: getGetPromoterPayoutsQueryKey() });
          toast({ title: "Saved", description: "Details submitted for manual verification." }); onDone?.();
        },
        onError: error => toast({ title: "Couldn't save", description: message(error), variant: "destructive" }),
      })}>{save.isPending ? "Saving…" : "Save"}</Button>{onDone && <Button variant="ghost" onClick={onDone}>Cancel</Button>}</div>
    </CardContent>
  </Card>;
}