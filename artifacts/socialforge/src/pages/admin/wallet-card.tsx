import { useState } from "react";
import {
  useAdminGetWalletSettings,
  useAdminUpdateWalletSettings,
  useAdminListWalletPendingPrices,
  useAdminReconcileWalletPendingPrices,
  getAdminGetWalletSettingsQueryKey,
  getAdminListWalletPendingPricesQueryKey,
  getAdminListAuditLogsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  ModelPriceImportDialog,
  type ModelPriceKind,
} from "./model-price-import-dialog";

const rupees = (paise: number) =>
  `₹${(paise / 100).toLocaleString("en-IN", {
    minimumFractionDigits: paise % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;

type PendingPriceRow = {
  usageKind: string;
  provider: string | null;
  model: string | null;
  reason: string;
};

/**
 * Keep the admin queue focused on actions an AI model price can actually fix.
 * The ledger remains the source of truth; this only removes legacy or
 * misclassified rows from the display.
 */
const isActionablePendingPrice = (p: PendingPriceRow) => {
  if (p.reason === "missing_usage") return false;
  if (!p.model) return false;
  if (p.provider === "stock-tts") return false;
  if (
    p.provider === "elevenlabs" &&
    (p.model === "voice-clone" || p.model === "voice-preview")
  ) {
    return false;
  }
  if (p.usageKind === "video" && p.model === "gpt-5.4") return false;
  return true;
};

/**
 * Wallet settings + the "models still need a price" to-do list.
 *
 * Deliberately NOT a second place to set the platform fee or the per-caption /
 * per-image rates: those live in AI Spend Display above, and the wallet
 * charges exactly what that card shows.
 */
export function WalletCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useAdminGetWalletSettings();
  const { data: pending } = useAdminListWalletPendingPrices();
  const actionablePending = (pending ?? []).filter(isActionablePendingPrice);
  const update = useAdminUpdateWalletSettings();
  const reconcile = useAdminReconcileWalletPendingPrices();
  const [reconciling, setReconciling] = useState<string | null>(null);
  const [importTarget, setImportTarget] = useState<{
    kind: ModelPriceKind;
    provider: string | null;
    model: string;
  } | null>(null);

  const pendingKey = (p: {
    usageKind: string;
    provider: string | null;
    model: string | null;
  }) => `${p.usageKind}:${p.provider ?? "-"}:${p.model ?? "-"}`;

  const handleReconcile = (p: {
    usageKind: string;
    provider: string | null;
    model: string | null;
  }) => {
    if (!p.model) return;
    const key = pendingKey(p);
    setReconciling(key);
    reconcile.mutate(
      {
        data: {
          usageKind: p.usageKind as "caption" | "image" | "video",
          provider: p.provider,
          model: p.model,
        },
      },
      {
        onSuccess: (result) => {
          queryClient.invalidateQueries({
            queryKey: getAdminListWalletPendingPricesQueryKey(),
          });
          const remaining = result.remaining;
          toast({
            title:
              result.settledRows > 0
                ? `${result.settledRows} charge${result.settledRows === 1 ? "" : "s"} reconciled`
                : "Nothing could be reconciled",
            description: remaining
              ? `${remaining.chargeCount} charge${remaining.chargeCount === 1 ? "" : "s"} still pending: ${remaining.detail}`
              : `All charges for ${p.model} are settled.`,
            variant: result.settledRows === 0 && remaining ? "destructive" : undefined,
          });
        },
        onError: () => {
          toast({
            variant: "destructive",
            title: "Reconcile failed",
            description: "Could not run the true-up for this model.",
          });
        },
        onSettled: () => setReconciling(null),
      },
    );
  };

  const [gst, setGst] = useState<string | null>(null);
  const [minTopup, setMinTopup] = useState<string | null>(null);
  const [lowBalance, setLowBalance] = useState<string | null>(null);
  const [videoCost, setVideoCost] = useState<string | null>(null);

  const paiseToRupees = (paise: number) => (paise / 100).toString();
  const gstValue = gst ?? (settings ? String(settings.gstPercent) : "");
  const minTopupValue =
    minTopup ?? (settings ? paiseToRupees(settings.minTopupPaise) : "");
  const lowBalanceValue =
    lowBalance ?? (settings ? paiseToRupees(settings.lowBalanceThresholdPaise) : "");
  const videoCostValue =
    videoCost ?? (settings ? paiseToRupees(settings.videoCostPaise) : "");

  const gstNow = Number(gstValue || "0");
  const minTopupPaiseNow = Math.round(Number(minTopupValue || "0") * 100);
  const previewValid =
    Number.isFinite(gstNow) && gstNow >= 0 && gstNow <= 100 && minTopupPaiseNow >= 0;

  const handleSave = () => {
    const gstPercent = Math.round(Number(gstValue));
    const minTopupPaise = Math.round(Number(minTopupValue) * 100);
    const lowBalanceThresholdPaise = Math.round(Number(lowBalanceValue) * 100);
    const videoCostPaise = Math.round(Number(videoCostValue) * 100);
    if (
      ![gstPercent, minTopupPaise, lowBalanceThresholdPaise, videoCostPaise].every(
        (n) => Number.isFinite(n) && n >= 0,
      ) ||
      gstPercent > 100 ||
      minTopupPaise < 100
    ) {
      toast({
        variant: "destructive",
        title: "Invalid values",
        description:
          "GST must be 0-100%, and the minimum top-up must be at least ₹1.",
      });
      return;
    }
    update.mutate(
      {
        data: {
          gstPercent,
          minTopupPaise,
          lowBalanceThresholdPaise,
          videoCostPaise,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getAdminGetWalletSettingsQueryKey(),
          });
          queryClient.invalidateQueries({
            queryKey: getAdminListAuditLogsQueryKey(),
          });
          setGst(null);
          setMinTopup(null);
          setLowBalance(null);
          setVideoCost(null);
          toast({
            title: "Wallet settings saved",
            description: `Top-ups are now charged with ${gstPercent}% GST added at checkout.`,
          });
        },
        onError: () => {
          toast({
            variant: "destructive",
            title: "Save failed",
            description: "Could not save the wallet settings.",
          });
        },
      },
    );
  };

  return (
    <Card data-testid="card-wallet">
      <CardHeader>
        <CardTitle>Prepaid Wallet (₹)</CardTitle>
        <CardDescription>
          Tenants recharge a rupee balance and every generation is deducted from
          it at the real provider cost plus your platform fee. Amounts shown to
          tenants are GST-exclusive; GST is added only at the payment step.
          Per-caption and per-image rates come from AI Spend Display above — set
          them there once and both the display and the wallet use them. Turn the
          whole module on or off from Feature Controls, and move individual
          workspaces onto it from the Tenants tab.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="wallet-gst">
                  GST (%)
                </label>
                <Input
                  id="wallet-gst"
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  value={gstValue}
                  onChange={(e) => setGst(e.target.value)}
                  data-testid="input-wallet-gst"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="wallet-min-topup">
                  Minimum top-up (₹)
                </label>
                <Input
                  id="wallet-min-topup"
                  type="number"
                  min="1"
                  step="1"
                  value={minTopupValue}
                  onChange={(e) => setMinTopup(e.target.value)}
                  data-testid="input-wallet-min-topup"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="wallet-low-balance">
                  Low-balance warning (₹)
                </label>
                <Input
                  id="wallet-low-balance"
                  type="number"
                  min="0"
                  step="1"
                  value={lowBalanceValue}
                  onChange={(e) => setLowBalance(e.target.value)}
                  data-testid="input-wallet-low-balance"
                />
                <p className="text-xs text-muted-foreground">0 = no warning</p>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="wallet-video-cost">
                  Video fallback rate (₹)
                </label>
                <Input
                  id="wallet-video-cost"
                  type="number"
                  min="0"
                  step="0.01"
                  value={videoCostValue}
                  onChange={(e) => setVideoCost(e.target.value)}
                  data-testid="input-wallet-video-cost"
                />
                <p className="text-xs text-muted-foreground">
                  Video providers report no cost, so this is what a video charges.
                </p>
              </div>
            </div>

            {previewValid && minTopupPaiseNow > 0 && (
              <div className="rounded-lg border bg-muted/40 p-3 text-sm">
                A {rupees(minTopupPaiseNow)} recharge charges{" "}
                <span className="font-medium">
                  {rupees(minTopupPaiseNow + Math.round((minTopupPaiseNow * gstNow) / 100))}
                </span>{" "}
                at checkout ({gstNow}% GST) and credits{" "}
                <span className="font-medium">{rupees(minTopupPaiseNow)}</span> to
                the wallet.
              </div>
            )}

            <Button
              onClick={handleSave}
              disabled={update.isPending}
              data-testid="button-save-wallet-settings"
            >
              {update.isPending ? "Saving..." : "Save wallet settings"}
            </Button>

            {actionablePending.length > 0 && (
              <div className="space-y-2 rounded-lg border border-amber-300/60 bg-amber-50/60 p-3 dark:border-amber-900/40 dark:bg-amber-950/20">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">Needs pricing</Badge>
                  <span className="text-sm font-medium">
                    {actionablePending.length} model
                    {actionablePending.length === 1 ? "" : "s"} charged at the
                    display rate
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">
                  These wallets were charged your display rate instead of the
                  real cost. Each entry shows why it is still pending: models
                  with no catalog price need one added in AI Cost Tracking
                  below; models whose price exists can be reconciled here.
                </p>
                <ul className="space-y-2 text-sm">
                  {actionablePending.map((p) => (
                    <li
                      key={pendingKey(p)}
                      className="space-y-1"
                      data-testid={`pending-price-${p.model ?? "unknown"}`}
                    >
                      <div className="flex items-center justify-between gap-4">
                        <span className="text-xs">
                          <span className="text-muted-foreground">Type:</span>{" "}
                          <span className="capitalize">{p.usageKind}</span>
                          {" · provider: "}
                          <span className="font-mono">{p.provider ?? "unknown"}</span>
                          {" · model: "}
                          <span className="font-mono">{p.model ?? "unknown"}</span>
                        </span>
                        <span className="flex items-center gap-2">
                          <span className="tabular-nums text-muted-foreground">
                            {p.chargeCount} charge{p.chargeCount === 1 ? "" : "s"}
                          </span>
                          {p.model && p.reason === "no_price" ? (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 px-2 text-xs"
                              onClick={() =>
                                setImportTarget({
                                  kind:
                                    p.usageKind === "caption"
                                      ? "text"
                                      : (p.usageKind as ModelPriceKind),
                                  provider: p.provider,
                                  model: p.model!,
                                })
                              }
                              data-testid={`button-import-price-${p.model}`}
                            >
                              Import from URL
                            </Button>
                          ) : p.model ? (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 px-2 text-xs"
                              onClick={() => handleReconcile(p)}
                              disabled={reconcile.isPending}
                              data-testid={`button-reconcile-${p.model}`}
                            >
                              {reconciling === pendingKey(p)
                                ? "Reconciling..."
                                : "Reconcile now"}
                            </Button>
                          ) : null}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        <Badge
                          variant={p.reason === "no_price" ? "destructive" : "outline"}
                          className="mr-1.5 align-middle text-[10px]"
                        >
                          {p.reason === "no_price"
                            ? "No catalog price"
                            : p.reason === "price_incomplete"
                              ? "Price incomplete"
                              : p.reason === "no_fx_rate"
                                ? "No USD→INR rate"
                                : p.reason === "missing_usage"
                                  ? "No usage recorded"
                                  : "Not reconciled yet"}
                        </Badge>
                        {p.detail}
                        {p.reason === "no_price" &&
                          " Add a price in AI Cost Tracking below and the difference is collected (or refunded) automatically."}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <ModelPriceImportDialog
              open={importTarget !== null}
              onOpenChange={(nextOpen) => {
                if (!nextOpen) setImportTarget(null);
              }}
              initialKind={importTarget?.kind}
              initialProvider={importTarget?.provider}
              initialModel={importTarget?.model}
              enforceTarget
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}
