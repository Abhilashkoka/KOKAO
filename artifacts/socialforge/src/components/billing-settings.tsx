import { useState } from "react";
import {
  useGetMe,
  useListPlans,
  useBillingGetOverview,
  useBillingSubscribe,
  useBillingVerifySubscription,
  useBillingCancelSubscription,
  useBillingSwitchPayg,
  useBillingPurchaseCredits,
  useBillingVerifyPurchase,
  getBillingGetOverviewQueryKey,
  getGetMeQueryKey,
} from "@workspace/api-client-react";
import type { Plan } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CreditCard, Coins, ReceiptText } from "lucide-react";

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void };
  }
}

let checkoutScriptPromise: Promise<void> | null = null;

/** Load the Razorpay Checkout script once, on demand. */
function loadCheckoutScript(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  if (!checkoutScriptPromise) {
    checkoutScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://checkout.razorpay.com/v1/checkout.js";
      script.onload = () => resolve();
      script.onerror = () => {
        checkoutScriptPromise = null;
        reject(new Error("Could not load the payment window. Check your connection."));
      };
      document.body.appendChild(script);
    });
  }
  return checkoutScriptPromise;
}

function formatInr(paise: number): string {
  return `₹${(paise / 100).toLocaleString("en-IN", {
    minimumFractionDigits: paise % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

function errorMessage(error: unknown, fallback: string): string {
  const data = (error as { response?: { data?: { error?: string } } })?.response?.data;
  return data?.error ?? fallback;
}

export function BillingSettings() {
  const { data: me } = useGetMe();
  const { data: plans } = useListPlans();
  const { data: billing, isLoading } = useBillingGetOverview();
  const subscribe = useBillingSubscribe();
  const verifySubscription = useBillingVerifySubscription();
  const cancelSubscription = useBillingCancelSubscription();
  const switchPayg = useBillingSwitchPayg();
  const purchaseCredits = useBillingPurchaseCredits();
  const verifyPurchase = useBillingVerifyPurchase();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const isOwner = me?.team ? me.team.role === "owner" : true;

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: getBillingGetOverviewQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
  };

  if (isLoading || !billing) {
    return <Skeleton className="h-[400px] w-full rounded-xl" />;
  }

  const paidPlans = (plans ?? []).filter(
    (p): p is Plan & { priceInr: number } =>
      typeof p.priceInr === "number" && p.priceInr > 0,
  );
  const sub = billing.subscription;
  const hasActiveSub =
    !!sub && (sub.status === "active" || sub.status === "authenticated");

  const openCheckout = async (options: Record<string, unknown>) => {
    await loadCheckoutScript();
    if (!window.Razorpay) throw new Error("Payment window unavailable");
    new window.Razorpay(options).open();
  };

  const handleSubscribe = async (planId: string) => {
    setBusyId(planId);
    try {
      const started = await subscribe.mutateAsync({ data: { planId } });
      await openCheckout({
        key: started.keyId,
        subscription_id: started.razorpaySubscriptionId,
        name: "Subscription",
        description: plans?.find((p) => p.id === planId)?.name ?? planId,
        handler: (response: {
          razorpay_payment_id: string;
          razorpay_subscription_id: string;
          razorpay_signature: string;
        }) => {
          verifySubscription.mutate(
            {
              data: {
                razorpaySubscriptionId: response.razorpay_subscription_id,
                razorpayPaymentId: response.razorpay_payment_id,
                razorpaySignature: response.razorpay_signature,
              },
            },
            {
              onSuccess: () => {
                toast({ title: "Subscription active", description: "Your plan has been upgraded." });
                refresh();
              },
              onError: (error) => {
                toast({
                  title: "Verification pending",
                  description: errorMessage(
                    error,
                    "Payment received; your plan will activate shortly.",
                  ),
                });
                refresh();
              },
            },
          );
        },
      });
    } catch (error) {
      toast({
        title: "Could not start checkout",
        description: errorMessage(error, "Please try again."),
        variant: "destructive",
      });
    } finally {
      setBusyId(null);
    }
  };

  const handleBuyPack = async (packId: number, packName: string) => {
    setBusyId(`pack-${packId}`);
    try {
      const order = await purchaseCredits.mutateAsync({ data: { creditPackId: packId } });
      await openCheckout({
        key: order.keyId,
        order_id: order.razorpayOrderId,
        amount: order.amountPaise,
        currency: "INR",
        name: "Credit pack",
        description: packName,
        handler: (response: {
          razorpay_payment_id: string;
          razorpay_order_id: string;
          razorpay_signature: string;
        }) => {
          verifyPurchase.mutate(
            {
              data: {
                razorpayOrderId: response.razorpay_order_id,
                razorpayPaymentId: response.razorpay_payment_id,
                razorpaySignature: response.razorpay_signature,
              },
            },
            {
              onSuccess: () => {
                toast({ title: "Credits added", description: `${packName} has been applied.` });
                refresh();
              },
              onError: (error) => {
                toast({
                  title: "Verification pending",
                  description: errorMessage(
                    error,
                    "Payment received; credits will appear shortly.",
                  ),
                });
                refresh();
              },
            },
          );
        },
      });
    } catch (error) {
      toast({
        title: "Could not start checkout",
        description: errorMessage(error, "Please try again."),
        variant: "destructive",
      });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      {!billing.configured && (
        <Card className="border-border shadow-sm">
          <CardContent className="pt-6 text-sm text-muted-foreground">
            Online payments are not set up yet. Plan upgrades and credit packs will be
            available once the platform administrator adds payment keys.
          </CardContent>
        </Card>
      )}

      {!isOwner && (
        <Card className="border-border shadow-sm">
          <CardContent className="pt-6 text-sm text-muted-foreground">
            Only the workspace owner can change billing. You can view the current plan
            and credit balance below.
          </CardContent>
        </Card>
      )}

      <Card className="border-border shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CreditCard className="h-5 w-5 text-primary" /> Plan
          </CardTitle>
          <CardDescription>
            Current plan: <span className="font-medium text-foreground">{billing.plan}</span>
            {sub && (
              <>
                {" "}— subscription {sub.status}
                {sub.cancelAtPeriodEnd && " (ends after the paid period)"}
                {sub.currentPeriodEnd &&
                  ` — renews/ends ${new Date(sub.currentPeriodEnd).toLocaleDateString()}`}
              </>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {billing.configured && paidPlans.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No plans are available for online purchase yet.
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            {paidPlans.map((plan) => (
              <div key={plan.id} className="rounded-lg border p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{plan.name}</span>
                  {billing.plan === plan.id && <Badge>Current</Badge>}
                </div>
                <p className="text-sm text-muted-foreground">
                  {formatInr(plan.priceInr)} / month
                </p>
                <Button
                  size="sm"
                  disabled={
                    !isOwner ||
                    !billing.configured ||
                    billing.plan === plan.id ||
                    hasActiveSub ||
                    busyId === plan.id
                  }
                  onClick={() => handleSubscribe(plan.id)}
                >
                  {busyId === plan.id ? "Opening checkout..." : "Subscribe"}
                </Button>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            {hasActiveSub && !sub?.cancelAtPeriodEnd && (
              <Button
                variant="outline"
                size="sm"
                disabled={!isOwner || cancelSubscription.isPending}
                onClick={() => setConfirmCancel(true)}
              >
                Cancel subscription
              </Button>
            )}
            {billing.plan !== "payg" && !hasActiveSub && (
              <Button
                variant="outline"
                size="sm"
                disabled={!isOwner || switchPayg.isPending}
                onClick={() =>
                  switchPayg.mutate(undefined, {
                    onSuccess: () => {
                      toast({ title: "Switched to Pay As You Go" });
                      refresh();
                    },
                    onError: (error) =>
                      toast({
                        title: "Could not switch",
                        description: errorMessage(error, "Please try again."),
                        variant: "destructive",
                      }),
                  })
                }
              >
                Switch to Pay As You Go
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Pay As You Go has no monthly quota — generations use prepaid credits instead.
          </p>
        </CardContent>
      </Card>

      <Card className="border-border shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Coins className="h-5 w-5 text-primary" /> Credits
          </CardTitle>
          <CardDescription>
            Credits are used automatically once your monthly plan quota runs out.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-6 text-sm">
            <div>
              <span className="text-2xl font-bold">{billing.credits.captionCredits}</span>{" "}
              caption credits
            </div>
            <div>
              <span className="text-2xl font-bold">{billing.credits.imageCredits}</span>{" "}
              image credits
            </div>
          </div>
          {billing.creditPacks.length === 0 ? (
            <p className="text-sm text-muted-foreground">No credit packs are on sale yet.</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {billing.creditPacks.map((pack) => (
                <div key={pack.id} className="rounded-lg border p-4 space-y-2">
                  <div className="font-semibold">{pack.name}</div>
                  <p className="text-sm text-muted-foreground">
                    {pack.captionCredits > 0 && `${pack.captionCredits} captions`}
                    {pack.captionCredits > 0 && pack.imageCredits > 0 && " + "}
                    {pack.imageCredits > 0 && `${pack.imageCredits} images`}
                    {" — "}
                    {formatInr(pack.pricePaise)}
                  </p>
                  <Button
                    size="sm"
                    disabled={!isOwner || !billing.configured || busyId === `pack-${pack.id}`}
                    onClick={() => handleBuyPack(pack.id, pack.name)}
                  >
                    {busyId === `pack-${pack.id}` ? "Opening checkout..." : "Buy"}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-border shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ReceiptText className="h-5 w-5 text-primary" /> Credit history
          </CardTitle>
        </CardHeader>
        <CardContent>
          {billing.history.length === 0 ? (
            <p className="text-sm text-muted-foreground">No credit activity yet.</p>
          ) : (
            <div className="space-y-2 text-sm">
              {billing.history.map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-center justify-between border-b last:border-b-0 pb-2 last:pb-0"
                >
                  <div>
                    <span className="font-medium">
                      {entry.kind === "purchase"
                        ? "Credit pack"
                        : entry.kind === "admin_grant"
                          ? "Granted by admin"
                          : entry.kind === "refund"
                            ? "Refunded"
                            : "Used"}
                    </span>
                    {entry.note && (
                      <span className="text-muted-foreground"> — {entry.note}</span>
                    )}
                  </div>
                  <div className="text-right text-muted-foreground">
                    <span>
                      {entry.captionDelta !== 0 &&
                        `${entry.captionDelta > 0 ? "+" : ""}${entry.captionDelta} captions `}
                      {entry.imageDelta !== 0 &&
                        `${entry.imageDelta > 0 ? "+" : ""}${entry.imageDelta} images `}
                    </span>
                    <span className="text-xs">
                      {new Date(entry.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="Cancel subscription?"
        description="Your plan stays active until the end of the paid period, then your workspace moves to the Free plan. You can switch to Pay As You Go afterwards if you prefer."
        confirmLabel="Cancel subscription"
        onConfirm={() =>
          cancelSubscription.mutate(undefined, {
            onSuccess: () => {
              toast({ title: "Cancellation scheduled" });
              refresh();
            },
            onError: (error) =>
              toast({
                title: "Could not cancel",
                description: errorMessage(error, "Please try again."),
                variant: "destructive",
              }),
          })
        }
      />
    </div>
  );
}
