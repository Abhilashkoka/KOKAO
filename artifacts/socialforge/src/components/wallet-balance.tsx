import { useState } from "react";
import {
  useWalletGetOverview,
  useWalletRecharge,
  useWalletVerifyRecharge,
  getWalletGetOverviewQueryKey,
  useGetMe,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { RippleSpinner } from "@/components/ui/ripple-spinner";
import { useToast } from "@/hooks/use-toast";
import { useFeatureFlags } from "@/lib/features";
import { openCheckout, formatInr } from "@/lib/razorpay-checkout";
import { openCashfreeCheckout } from "@/lib/cashfree-checkout";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { Wallet } from "lucide-react";

/** Preset top-up amounts, GST-exclusive rupees. */
const PRESETS = [500, 1000, 2500, 5000];

/**
 * Is this workspace actually on wallet billing? The query is only run when the
 * platform switch is on, and a quota workspace gets `walletBilling: false` and
 * renders nothing at all — so nothing about the app changes for it.
 */
function useWallet() {
  const { flags } = useFeatureFlags();
  const query = useWalletGetOverview({
    query: {
      queryKey: getWalletGetOverviewQueryKey(),
      enabled: flags.wallet,
      refetchInterval: 30_000,
      refetchOnWindowFocus: true,
    },
  });
  return { wallet: query.data, isLoading: query.isLoading, enabled: flags.wallet };
}

/**
 * Compact balance chip for the app chrome. Goes amber below the admin's
 * low-balance threshold so the nudge arrives before a generation is refused.
 */
export function WalletBalancePill() {
  const { wallet } = useWallet();
  if (!wallet?.walletBilling) return null;
  return (
    <Link
      href="/settings?tab=billing"
      className={[
          "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors",
          wallet.lowBalance
            ? "bg-amber-100 text-amber-900 hover:bg-amber-200 dark:bg-amber-950/50 dark:text-amber-200"
            : "bg-muted text-foreground hover:bg-muted/70",
        ].join(" ")}
        title={
          wallet.lowBalance
            ? "Your wallet is running low — tap to recharge"
            : "Wallet balance (excl. GST)"
        }
        data-testid="pill-wallet-balance"
      >
        <Wallet className="h-3.5 w-3.5" />
        <span className="tabular-nums">{formatInr(wallet.balancePaise)}</span>
    </Link>
  );
}

/**
 * The recharge panel on the Billing page.
 *
 * Every rupee shown here is GST-exclusive: the amount entered is what lands in
 * the wallet, and GST is added on top at the payment step. The line under the
 * amount spells that out rather than surprising anyone at checkout.
 */
export function WalletCard() {
  const { wallet, isLoading, enabled } = useWallet();
  const { data: me } = useGetMe();
  const recharge = useWalletRecharge();
  const verify = useWalletVerifyRecharge();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);

  if (!enabled) return null;
  if (isLoading) return <Skeleton className="h-64 w-full rounded-xl" />;
  if (!wallet?.walletBilling) return null;

  const isOwner = me?.team ? me.team.role === "owner" : true;
  const basePaise = Math.round(Number(amount || "0") * 100);
  const gstPaise = Math.round((basePaise * wallet.gstPercent) / 100);
  const amountValid =
    Number.isFinite(basePaise) && basePaise >= wallet.minTopupPaise;

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: getWalletGetOverviewQueryKey() });

  const startRecharge = async (rechargePaise: number) => {
    if (!Number.isFinite(rechargePaise) || rechargePaise < wallet.minTopupPaise) {
      toast({
        variant: "destructive",
        title: "Enter a larger amount",
        description: `The minimum top-up is ${formatInr(wallet.minTopupPaise)}.`,
      });
      return;
    }
    setBusy(true);
    try {
      const order = await recharge.mutateAsync({ data: { amountPaise: rechargePaise } });

      if (order.gateway === "cashfree") {
        // Cashfree's modal resolves when it closes — that is not proof of
        // payment, so we always verify with the server, which re-checks status
        // with Cashfree and is the source of truth.
        try {
          await openCashfreeCheckout({
            paymentSessionId: order.paymentSessionId ?? "",
            mode: order.cashfreeMode,
          });
        } finally {
          setBusy(false);
        }
        verify.mutate(
          { data: { cashfreeOrderId: order.cashfreeOrderId ?? "" } },
          {
            onSuccess: (result) => {
              refresh();
              setAmount("");
              toast({
                title: "Wallet topped up",
                description: `New balance ${formatInr(result.balancePaise)}.`,
              });
            },
            onError: (error) => {
              refresh();
              const status = (error as { status?: number } | null)?.status;
              if (status === 409) {
                toast({
                  title: "Payment still processing",
                  description:
                    "It will be credited to your wallet automatically once confirmed.",
                });
                return;
              }
              toast({
                variant: "destructive",
                title: "Could not confirm the payment",
                description: apiErrorMessage(
                  error,
                  "If money left your account, it will be credited shortly.",
                ),
              });
            },
          },
        );
        return;
      }

      await openCheckout({
        key: order.keyId,
        order_id: order.razorpayOrderId,
        amount: order.totalPaise,
        currency: "INR",
        name: "Wallet top-up",
        description: `${formatInr(order.basePaise)} + ${order.gstPercent}% GST`,
        handler: (response: {
          razorpay_payment_id: string;
          razorpay_order_id: string;
          razorpay_signature: string;
        }) => {
          verify.mutate(
            {
              data: {
                razorpayOrderId: response.razorpay_order_id,
                razorpayPaymentId: response.razorpay_payment_id,
                razorpaySignature: response.razorpay_signature,
              },
            },
            {
              onSuccess: (result) => {
                refresh();
                setAmount("");
                toast({
                  title: "Wallet topped up",
                  description: `New balance ${formatInr(result.balancePaise)}.`,
                });
              },
              onError: (error) => {
                toast({
                  variant: "destructive",
                  title: "Could not confirm the payment",
                  description: apiErrorMessage(
                    error,
                    "If money left your account, it will be credited shortly.",
                  ),
                });
              },
              onSettled: () => setBusy(false),
            },
          );
        },
        modal: { ondismiss: () => setBusy(false) },
      });
    } catch (error) {
      setBusy(false);
      toast({
        variant: "destructive",
        title: "Could not start the top-up",
        description: apiErrorMessage(error, "Please try again."),
      });
    }
  };

  return (
    <Card className="border-border shadow-sm" data-testid="card-wallet">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2">
              <Wallet className="h-5 w-5 text-primary" /> Wallet
            </CardTitle>
            <CardDescription>
              Generations are charged to this balance as you use them. All amounts
              are shown excluding GST — GST is added at the payment step.
            </CardDescription>
          </div>
          {/* Always-visible top-up entry point. Uses the typed amount when one
              is entered, otherwise the minimum top-up, and goes straight to
              Razorpay checkout. */}
          <Button
            onClick={() => {
              if (!wallet.configured) {
                toast({
                  variant: "destructive",
                  title: "Payments not set up",
                  description:
                    "Ask your administrator to add payment keys, or to top your wallet up manually.",
                });
                return;
              }
              if (!isOwner) {
                toast({
                  variant: "destructive",
                  title: "Owner only",
                  description: "Only the workspace owner can recharge the wallet.",
                });
                return;
              }
              void startRecharge(basePaise > 0 ? basePaise : wallet.minTopupPaise);
            }}
            disabled={busy}
            data-testid="button-wallet-add-credit"
          >
            {busy ? <RippleSpinner className="h-4 w-4" /> : "Add credit"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div
          className={[
            "rounded-xl p-4",
            wallet.lowBalance
              ? "bg-amber-50 dark:bg-amber-950/20"
              : "bg-muted/50",
          ].join(" ")}
        >
          <div className="text-sm text-muted-foreground">Available balance</div>
          <div className="text-3xl font-bold tabular-nums">
            {formatInr(wallet.balancePaise)}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            excl. GST · about {formatInr(wallet.rates.captionPaise)} per caption
            {wallet.rates.imagePaise > 0
              ? ` · ${formatInr(wallet.rates.imagePaise)} per image`
              : ""}
          </div>
          {wallet.lowBalance && (
            <p className="mt-2 text-sm font-medium text-amber-800 dark:text-amber-200">
              Running low — top up to keep generating.
            </p>
          )}
        </div>

        {!wallet.configured ? (
          <p className="text-sm text-muted-foreground">
            Online payments are not set up yet. Ask your administrator to add
            payment keys, or to top your wallet up manually.
          </p>
        ) : !isOwner ? (
          <p className="text-sm text-muted-foreground">
            Only the workspace owner can recharge the wallet.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((rupees) => (
                <Button
                  key={rupees}
                  type="button"
                  variant={Number(amount) === rupees ? "default" : "outline"}
                  size="sm"
                  onClick={() => setAmount(String(rupees))}
                  data-testid={`button-topup-${rupees}`}
                >
                  {formatInr(rupees * 100)}
                </Button>
              ))}
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="flex-1 space-y-1.5">
                <label className="text-sm font-medium" htmlFor="wallet-topup">
                  Amount to add (₹, excl. GST)
                </label>
                <Input
                  id="wallet-topup"
                  type="number"
                  min={wallet.minTopupPaise / 100}
                  step="1"
                  placeholder={String(wallet.minTopupPaise / 100)}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  data-testid="input-wallet-topup"
                />
              </div>
              <Button
                onClick={() => void startRecharge(basePaise)}
                disabled={busy || !amountValid}
                data-testid="button-wallet-recharge"
              >
                {busy ? <RippleSpinner className="h-4 w-4" /> : "Recharge"}
              </Button>
            </div>
            {basePaise > 0 && (
              <p className="text-sm text-muted-foreground">
                {formatInr(basePaise)} lands in your wallet. You'll pay{" "}
                <span className="font-medium text-foreground">
                  {formatInr(basePaise + gstPaise)}
                </span>{" "}
                at checkout ({wallet.gstPercent}% GST).
              </p>
            )}
          </div>
        )}

        {wallet.history.length > 0 && (
          <div className="space-y-1">
            <div className="text-sm font-medium">Recent activity</div>
            <ul className="divide-y text-sm">
              {wallet.history.slice(0, 8).map((h) => {
                const label =
                  h.kind === "topup"
                    ? "Top-up"
                    : h.kind === "admin_credit"
                      ? "Added by admin"
                      : h.kind === "admin_debit"
                        ? "Adjusted by admin"
                        : h.kind === "refund"
                          ? "Refund"
                          : h.kind === "true_up"
                            ? "Price correction"
                            : h.usageKind
                              ? `${h.usageKind.charAt(0).toUpperCase()}${h.usageKind.slice(1)}`
                              : "Usage";
                // Where this charge's item lives, when the ledger knows it.
                const href =
                  h.refKind === "content"
                    ? `/library?item=${h.refId}`
                    : h.refKind === "campaign"
                      ? "/campaigns"
                      : null;
                return (
                  <li
                    key={h.id}
                    className="flex items-center justify-between gap-4 py-2"
                    data-testid={`wallet-entry-${h.id}`}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-muted-foreground">{label}</span>
                        {href && (
                          <Link
                            href={href}
                            className="text-xs text-primary hover:underline"
                            data-testid={`wallet-entry-link-${h.id}`}
                          >
                            {h.refKind === "campaign" ? "View campaigns" : "View item"}
                          </Link>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground/70">
                        {new Date(h.createdAt).toLocaleDateString("en-IN", {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })}{" "}
                        · entry #{h.id}
                        {h.refKind === "content" && ` · item #${h.refId}`}
                        {h.refKind === "imageJob" && ` · image job #${h.refId}`}
                        {h.refKind === "videoJob" && ` · video job #${h.refId}`}
                      </div>
                    </div>
                    <span
                      className={[
                        "tabular-nums",
                        h.amountPaise >= 0 ? "text-emerald-600 dark:text-emerald-400" : "",
                      ].join(" ")}
                    >
                      {h.amountPaise >= 0 ? "+" : "−"}
                      {formatInr(Math.abs(h.amountPaise))}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
