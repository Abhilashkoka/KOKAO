import { useState } from "react";
import {
  useAdminPreviewWalletConversion,
  useAdminConvertWalletToCredits,
  getAdminPreviewWalletConversionQueryKey,
  getAdminListTenantsQueryKey,
  getAdminListAuditLogsQueryKey,
  getAdminGetStatsQueryKey,
  getGetCreditsQueryKey,
  getGetMeQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/apiErrorMessage";

const money = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const credits = (value: number) => value.toLocaleString("en-IN", { maximumFractionDigits: 3 });

/** Preview first; clicking Adjust must never irreversibly move money. */
export function WalletConversionDialog({ tenant, onClose }: {
  tenant: { id: number; name: string };
  onClose: () => void;
}) {
  const client = useQueryClient();
  const { toast } = useToast();
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [retrySnapshot, setRetrySnapshot] = useState<{ expectedWalletPaise: number; expectedCreditPricePaise: number } | null>(null);
  const preview = useAdminPreviewWalletConversion(tenant.id, {
    query: { queryKey: getAdminPreviewWalletConversionQueryKey(tenant.id), staleTime: 0, refetchOnMount: "always" },
    request: { cache: "no-store" },
  });
  const conversion = useAdminConvertWalletToCredits();
  const data = preview.data;

  async function confirm() {
    if ((!retrySnapshot && (!data?.canConvert || preview.isFetching)) || conversion.isPending) return;
    const snapshot = retrySnapshot ?? {
      expectedWalletPaise: data!.walletPaise,
      expectedCreditPricePaise: data!.creditPricePaise,
    };
    setError(null);
    try {
      const result = await conversion.mutateAsync({
        id: tenant.id,
        data: {
          ...snapshot,
          idempotencyKey,
        },
      });
      // Refresh all mounted balance views without remounting their screens.
      for (const queryKey of [
        getAdminListTenantsQueryKey(), getAdminListAuditLogsQueryKey(),
        getAdminGetStatsQueryKey(), getGetCreditsQueryKey(), getGetMeQueryKey(),
        ["/api/wallet"], ["/api/billing"],
      ]) void client.invalidateQueries({ queryKey });
      toast({
        title: "Wallet converted",
        description: `${money(result.walletPaiseConverted)} converted to ${credits(result.creditsAdded)} purchased credits for ${tenant.name}.`,
      });
      onClose();
    } catch (err) {
      // A lost response may already have committed the transfer. Retry that
      // exact receipt even if the refreshed preview now shows a zero wallet.
      const status = err && typeof err === "object" && "status" in err ? err.status : undefined;
      setRetrySnapshot(typeof status === "number" && status >= 400 && status < 500 ? null : snapshot);
      setError(apiErrorMessage(err, "Conversion failed. Your balances have not been changed unless a previous request completed. You can safely retry."));
      // Keep the same request key on retry, including after a lost response.
      void preview.refetch();
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !conversion.isPending) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Convert wallet to credits — {tenant.name}</DialogTitle>
          <DialogDescription>
            Calculated automatically using the saved ₹ per credit rate in Plans → Credit usage pricing.
            Confirming exchanges the wallet balance for non-expiring purchased credits.
          </DialogDescription>
        </DialogHeader>
        {preview.isLoading ? <p role="status">Calculating conversion…</p> :
          preview.isError ? <div role="alert">
            <p>{apiErrorMessage(preview.error, "Could not load the saved conversion rate and wallet balance.")}</p>
            <Button variant="outline" onClick={() => void preview.refetch()}>Retry preview</Button>
          </div> : data ? (
            <div className="space-y-3">
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <dt>Wallet balance</dt><dd className="text-right tabular-nums">{money(data.walletPaise)}</dd>
                <dt>Saved Plans rate</dt><dd className="text-right tabular-nums">{data.creditPricePaise > 0 ? `${money(data.creditPricePaise)} per credit` : "Not configured"}</dd>
                <dt className="font-medium">Purchased credits to add</dt>
                <dd className="text-right font-semibold tabular-nums" data-testid="text-wallet-conversion-credits">{credits(data.credits)}</dd>
              </dl>
              <p className="text-xs text-muted-foreground">
                Fractions are rounded up to the nearest 0.001 credit so no wallet value is lost.
                Existing credits and legacy allowances stay unchanged. This does not switch billing mode or enable credit charging.
              </p>
              {!data.canConvert && <p role="alert" className="text-sm text-destructive">{data.reason || "This wallet cannot be converted right now."}</p>}
              {data.canConvert && <p className="text-sm">After confirmation, this wallet balance will be ₹0.00. The same money cannot be spent twice.</p>}
            </div>
          ) : null}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={conversion.isPending} onClick={onClose}>Cancel</Button>
          <Button disabled={conversion.isPending || (!retrySnapshot && (!data?.canConvert || preview.isError || preview.isFetching))} onClick={() => void confirm()}>
            {conversion.isPending ? "Converting…" : "Confirm conversion"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}