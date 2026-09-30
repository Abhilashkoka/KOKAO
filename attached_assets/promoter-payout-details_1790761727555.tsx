import { useState } from "react";
import {
  useGetPromoterPayoutDetails,
  useSavePromoterPayoutDetails,
  useGetPromoterPayouts,
  getGetPromoterPayoutDetailsQueryKey,
  getGetPromoterPayoutsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Banknote, Lock, ShieldCheck } from "lucide-react";

/**
 * Payout details and history, for the promoter dashboard.
 *
 * Bank details are asked for HERE — at the point money is about to move — not
 * at application. Nobody hands over a PAN to get a link, and asking early
 * reads as a data grab.
 */

const inr = (v: number) =>
  v.toLocaleString("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  });

const STATUS_LABEL: Record<string, string> = {
  draft: "Queued",
  exported: "Processing",
  paid: "Paid",
  failed: "Failed — we'll retry",
};

export function PromoterPayoutDetails() {
  const { data: details, isLoading } = useGetPromoterPayoutDetails({
    query: { queryKey: getGetPromoterPayoutDetailsQueryKey() },
  });
  const { data: history } = useGetPromoterPayouts({
    query: { queryKey: getGetPromoterPayoutsQueryKey(), staleTime: 30_000 },
  });

  if (isLoading) return <Skeleton className="h-48 w-full" />;

  return (
    <div className="space-y-4">
      {details?.onFile ? (
        <OnFile details={details} />
      ) : (
        <PayoutForm />
      )}

      {!!history?.payouts?.length && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Payouts</CardTitle>
          </CardHeader>
          <CardContent className="px-0 pb-2">
            <div className="divide-y divide-border">
              {history.payouts.map((p: any) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between gap-3 px-6 py-2.5"
                  data-testid={`payout-${p.id}`}
                >
                  <div className="min-w-0">
                    <p className="text-sm">{inr(p.net)}</p>
                    <p className="text-xs text-muted-foreground">
                      {inr(p.gross)} earned · {inr(p.tds)} TDS ·{" "}
                      {inr(p.reserveHeld)} held
                      {p.reserveReleasedAt ? " (released)" : ""}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-xs text-muted-foreground">
                      {STATUS_LABEL[p.status] ?? p.status}
                    </p>
                    {p.paidAt && (
                      <p className="text-xs text-muted-foreground">
                        {new Date(p.paidAt).toLocaleDateString("en-IN", {
                          day: "numeric",
                          month: "short",
                        })}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {history?.balance?.owedBack > 0 && (
        <Card className="border-muted-foreground/20">
          <CardContent className="py-3.5 text-sm">
            <p className="font-medium">
              {inr(history.balance.owedBack)} adjustment carried forward
            </p>
            <p className="text-muted-foreground">
              A referred purchase was refunded after payout. This comes off your
              next payout — nothing is owed directly.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function OnFile({ details }: { details: any }) {
  const [editing, setEditing] = useState(false);
  if (editing) return <PayoutForm onDone={() => setEditing(false)} />;
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
        <div className="flex items-start gap-2.5">
          <Banknote className="mt-0.5 h-4 w-4 text-muted-foreground" />
          <div className="space-y-0.5 text-sm">
            <p className="font-medium" data-testid="payout-details-on-file">
              {details.beneficiaryName}
            </p>
            <p className="text-muted-foreground">
              ••••{details.bankLast4} · {details.ifsc} · PAN ••••
              {details.panLast4}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {details.verified && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5" /> Verified
            </span>
          )}
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            Change
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function PayoutForm({ onDone }: { onDone?: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const save = useSavePromoterPayoutDetails();

  const [beneficiaryName, setBeneficiaryName] = useState("");
  const [pan, setPan] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [ifsc, setIfsc] = useState("");

  const canSubmit =
    beneficiaryName.trim().length >= 2 &&
    /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan) &&
    accountNumber.replace(/\D/g, "").length >= 6 &&
    /^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc);

  const submit = () => {
    save.mutate(
      { data: { beneficiaryName: beneficiaryName.trim(), pan, accountNumber, ifsc } },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({
            queryKey: getGetPromoterPayoutDetailsQueryKey(),
          });
          toast({
            title: "Saved",
            description: "We'll use these for your next payout.",
          });
          onDone?.();
        },
        onError: (err: any) =>
          toast({
            title: "Couldn't save",
            description: err?.message || "Check the details and try again.",
            variant: "destructive",
          }),
      },
    );
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Banknote className="h-4 w-4" /> Where to send your earnings
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 py-4">
        <div className="space-y-1.5">
          <Label htmlFor="beneficiaryName">Name on the account</Label>
          <Input
            id="beneficiaryName"
            value={beneficiaryName}
            onChange={(e) => setBeneficiaryName(e.target.value)}
            autoComplete="off"
            data-testid="input-beneficiary-name"
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="accountNumber">Account number</Label>
            <Input
              id="accountNumber"
              value={accountNumber}
              onChange={(e) => setAccountNumber(e.target.value.replace(/\s/g, ""))}
              inputMode="numeric"
              autoComplete="off"
              data-testid="input-account-number"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ifsc">IFSC</Label>
            <Input
              id="ifsc"
              value={ifsc}
              onChange={(e) => setIfsc(e.target.value.toUpperCase())}
              className="font-mono"
              autoComplete="off"
              data-testid="input-ifsc"
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pan">PAN</Label>
          <Input
            id="pan"
            value={pan}
            onChange={(e) => setPan(e.target.value.toUpperCase())}
            className="font-mono tracking-wider"
            maxLength={10}
            autoComplete="off"
            data-testid="input-pan"
          />
          <p className="text-xs text-muted-foreground">
            Required for TDS on commission. One PAN per promoter account.
          </p>
        </div>

        <p className="flex items-start gap-2 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          We store these encrypted and only ever show the last four digits.
        </p>

        <div className="flex gap-2">
          <Button
            className="flex-1"
            disabled={!canSubmit || save.isPending}
            onClick={submit}
            data-testid="button-save-payout-details"
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
          {onDone && (
            <Button variant="ghost" onClick={onDone}>
              Cancel
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
