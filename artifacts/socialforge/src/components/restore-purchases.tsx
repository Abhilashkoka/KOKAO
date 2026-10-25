import { useState } from "react";
import {
  useBillingVerifyPurchase,
  useBillingVerifySubscription,
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
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import {
  forgetPendingPayment,
  listPendingPayments,
  type PendingPayment,
} from "@/lib/pending-payments";
import { History } from "lucide-react";

/**
 * Restore purchases: paid but nothing showed up.
 *
 * Re-runs the server's own verify for a payment. The server re-fetches the
 * order from the gateway, checks it belongs to this workspace, requires it to
 * be PAID, and credits it exactly once — so pressing this twice, or after the
 * webhook already landed, can never add credits twice.
 */
export function RestorePurchasesCard({ onRestored }: { onRestored: () => void }) {
  const verifyPurchase = useBillingVerifyPurchase();
  const verifySubscription = useBillingVerifySubscription();
  const { toast } = useToast();
  const [pending, setPending] = useState<PendingPayment[]>(() => listPendingPayments());
  const [orderId, setOrderId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const outcome = (payment: { kind: PendingPayment["kind"]; id: string }) => ({
    onSuccess: () => {
      forgetPendingPayment(payment.kind, payment.id);
      setPending(listPendingPayments());
      toast({
        title: payment.kind === "pack" ? "Purchase restored" : "Subscription restored",
        description:
          payment.kind === "pack"
            ? "Your credits are up to date. A payment is never applied twice."
            : "Your plan is up to date.",
      });
      onRestored();
    },
    onError: (error: unknown) => {
      const status = (error as { status?: number } | null)?.status;
      toast({
        title: status === 409 ? "Payment not confirmed yet" : "Could not restore",
        description:
          status === 409
            ? "The gateway has not marked this payment as paid. Try again in a few minutes."
            : apiErrorMessage(
                error,
                "We could not verify this payment. If you were charged, contact support with the order ID.",
              ),
        variant: status === 409 ? undefined : "destructive",
      });
    },
    onSettled: () => setBusy(null),
  });

  const restore = (payment: { kind: PendingPayment["kind"]; id: string }) => {
    if (busy) return;
    setBusy(payment.id);
    if (payment.kind === "pack") {
      verifyPurchase.mutate({ data: { cashfreeOrderId: payment.id } }, outcome(payment));
    } else {
      verifySubscription.mutate(
        { data: { cashfreeSubscriptionId: payment.id } },
        outcome(payment),
      );
    }
  };

  const manualId = orderId.trim();

  return (
    <Card className="border-border shadow-sm" data-testid="card-restore-purchases">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="h-5 w-5 text-primary" /> Restore purchases
        </CardTitle>
        <CardDescription>
          Paid but your credits or plan didn&apos;t update? Check the payment
          again here. A payment is only ever applied once.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {pending.length > 0 && (
          <ul className="space-y-2" data-testid="list-pending-payments">
            {pending.map((payment) => (
              <li
                key={`${payment.kind}:${payment.id}`}
                className="flex items-center justify-between gap-3 rounded-md border border-border p-3 text-sm"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{payment.label}</p>
                  <p className="text-xs text-muted-foreground">
                    Started {new Date(payment.startedAt).toLocaleString()}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => restore(payment)}
                  data-testid={`button-restore-${payment.id}`}
                >
                  {busy === payment.id ? "Checking…" : "Check payment"}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="restore-order-id">Credit pack order ID</Label>
          <div className="flex gap-2">
            <Input
              id="restore-order-id"
              value={orderId}
              onChange={(e) => setOrderId(e.target.value)}
              placeholder="From your payment receipt"
              data-testid="input-restore-order-id"
            />
            <Button
              disabled={!manualId || busy !== null}
              onClick={() => restore({ kind: "pack", id: manualId })}
              data-testid="button-restore-order"
            >
              {busy === manualId ? "Checking…" : "Restore"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Same email on a different sign-in method? Sign in with the method
            you paid with, or contact support to link them.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
