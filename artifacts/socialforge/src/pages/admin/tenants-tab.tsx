import { useRef, useState } from "react";
import { RippleSpinner } from "@/components/ui/ripple-spinner";
import {
  useAdminListTenants,
  useAdminUpdateTenantPlan,
  useAdminUpdateTenantSuperadmin,
  useAdminUpdateTenantDesignSkill,
  useAdminGrantCredits,
  useAdminGrantCreditAccount,
  useAdminCorrectPurchasedCredits,
  useAdminUpdateTenantBillingMode,
  useAdminAdjustTenantWallet,
  useAdminListSeatRequests,
  useAdminDecideSeatRequest,
  getAdminListSeatRequestsQueryKey,
  getAdminListTenantsQueryKey,
  getAdminGetStatsQueryKey,
  getAdminListAuditLogsQueryKey,
  useListPlans,
  useGetMe,
  useAdminGetAiSpendSettings,
  useAdminGetAiCostConfig,
  type AdminTenant,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CollapsibleCardHeader } from "@/components/ui/collapsible-card-header";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useFeatureFlags } from "@/lib/features";

import { PLAN_LABELS } from "./shared";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { WalletConversionDialog } from "./wallet-conversion-dialog";

/** Paise → a compact rupee string for the admin table. */
function formatInr(paise: number): string {
  return `₹${(paise / 100).toLocaleString("en-IN", {
    minimumFractionDigits: paise % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatCredits(credits: number): string {
  return credits.toLocaleString("en-IN", {
    maximumFractionDigits: 3,
  });
}

function billingModeLabel(mode: "quota" | "wallet" | "credits"): string {
  if (mode === "credits") return "Credits";
  if (mode === "wallet") return "Legacy wallet";
  return "Legacy quota";
}

function hasLegacyCreditBalance(
  conversion:
    | {
        captionCredits: number;
        imageCredits: number;
        videoCredits: number;
      }
    | null
    | undefined,
): boolean {
  return (
    (conversion?.captionCredits ?? 0) +
      (conversion?.imageCredits ?? 0) +
      (conversion?.videoCredits ?? 0) >
    0
  );
}

function SeatRequestsCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: requests, isLoading } = useAdminListSeatRequests();
  const decide = useAdminDecideSeatRequest();

  const [seatEdits, setSeatEdits] = useState<Record<number, string>>({});
  const [decidingId, setDecidingId] = useState<number | null>(null);

  const refresh = () => {
    queryClient.invalidateQueries({
      queryKey: getAdminListSeatRequestsQueryKey(),
    });
    queryClient.invalidateQueries({ queryKey: getAdminListTenantsQueryKey() });
    queryClient.invalidateQueries({
      queryKey: getAdminListAuditLogsQueryKey(),
    });
  };

  const handleDecide = (
    id: number,
    action: "approve" | "deny",
    requestedSeats: number,
  ) => {
    let seats: number | undefined;
    if (action === "approve") {
      const raw = (seatEdits[id] ?? "").trim();
      if (raw !== "") {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1) {
          toast({
            variant: "destructive",
            title: "Invalid seat count",
            description: "Seats must be a whole number of at least 1.",
          });
          return;
        }
        seats = n;
      } else {
        seats = requestedSeats;
      }
    }
    setDecidingId(id);
    decide.mutate(
      { id, data: action === "approve" ? { action, seats } : { action } },
      {
        onSuccess: () => {
          refresh();
          toast({
            title: action === "approve" ? "Request approved" : "Request denied",
            description:
              action === "approve"
                ? `The workspace now has ${seats} team seats.`
                : "The workspace has been notified.",
          });
          setDecidingId(null);
        },
        onError: (err: any) => {
          toast({
            variant: "destructive",
            title: "Could not save decision",
            description: apiErrorMessage(err, "Please try again."),
          });
          setDecidingId(null);
        },
      },
    );
  };

  const pending = (requests ?? []).filter((r) => r.status === "pending");
  const decided = (requests ?? []).filter((r) => r.status !== "pending");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Seat requests</CardTitle>
        <CardDescription>
          Workspaces asking for more team seats. Approving writes a
          per-workspace seat override on top of the plan default. You can
          adjust the number before approving.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : pending.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No pending seat requests.
          </p>
        ) : (
          <div className="rounded-lg border border-border divide-y divide-border">
            {pending.map((r) => (
              <div
                key={r.id}
                className="flex flex-col md:flex-row md:items-center gap-3 px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">
                    {r.tenantName}
                    {r.tenantEmail ? ` — ${r.tenantEmail}` : ""}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Requests {r.requestedSeats} seats · plan: {r.tenantPlan} ·
                    current limit: {r.currentSeatLimit} · in use: {r.seatsUsed}
                  </p>
                  {r.note && (
                    <p className="text-xs text-muted-foreground mt-1 italic">
                      "{r.note}"
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    className="w-24"
                    placeholder={String(r.requestedSeats)}
                    value={seatEdits[r.id] ?? ""}
                    onChange={(e) =>
                      setSeatEdits((prev) => ({
                        ...prev,
                        [r.id]: e.target.value,
                      }))
                    }
                    aria-label="Seats to grant"
                  />
                  <Button
                    size="sm"
                    onClick={() =>
                      handleDecide(r.id, "approve", r.requestedSeats)
                    }
                    disabled={decide.isPending && decidingId === r.id}
                  >
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleDecide(r.id, "deny", r.requestedSeats)}
                    disabled={decide.isPending && decidingId === r.id}
                  >
                    Deny
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {decided.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-semibold">Recent decisions</h4>
            <div className="rounded-lg border border-border divide-y divide-border">
              {decided.slice(0, 8).map((r) => (
                <div
                  key={r.id}
                  className="flex items-center justify-between px-4 py-2.5"
                >
                  <p className="text-sm truncate">
                    {r.tenantName} — {r.requestedSeats} requested
                    {r.status === "approved" &&
                      r.grantedSeats !== null &&
                      `, ${r.grantedSeats} granted`}
                  </p>
                  <Badge
                    variant={r.status === "approved" ? "secondary" : "outline"}
                    className="capitalize"
                  >
                    {r.status}
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function TenantsTab() {
  const { data: me } = useGetMe();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: tenants, isLoading: tenantsLoading } = useAdminListTenants();
  const { data: planCatalog } = useListPlans();
  const updatePlan = useAdminUpdateTenantPlan();
  const grantCredits = useAdminGrantCredits();
  const grantCreditAccount = useAdminGrantCreditAccount();
  const correction = useAdminCorrectPurchasedCredits();
  const correctionInFlight = useRef(false);
  const [correctionAmount, setCorrectionAmount] = useState("");
  const [correctionReference, setCorrectionReference] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [confirmCorrection, setConfirmCorrection] = useState(false);
  const [tenantsOpen, setTenantsOpen] = useState(true);
  const [grantTarget, setGrantTarget] = useState<{
    id: number;
    name: string;
    canonical: boolean;
    purchasedMilli?: number;
  } | null>(null);
  const [detailsTarget, setDetailsTarget] = useState<AdminTenant | null>(null);
  const [conversionTarget, setConversionTarget] = useState<{ id: number; name: string } | null>(null);
  const [planOverrideConfirm, setPlanOverrideConfirm] = useState<{
    tenantId: number;
    plan: string;
  } | null>(null);
  const [grantCaptions, setGrantCaptions] = useState("0");
  const [grantImages, setGrantImages] = useState("0");
  const [grantVideos, setGrantVideos] = useState("0");
  const [grantUnified, setGrantUnified] = useState("0");
  const [grantNote, setGrantNote] = useState("");
  // Money → video credits converter. The admin types an amount in ₹ or $ and
  // it converts to whole videos at the per-video display rate; USD uses the
  // same USD→INR rate the cost tracker uses.
  const [convertAmount, setConvertAmount] = useState("");
  const [convertCurrency, setConvertCurrency] = useState<"INR" | "USD">("INR");
  const { data: aiSpendSettings } = useAdminGetAiSpendSettings();
  const { data: aiCostConfig } = useAdminGetAiCostConfig();
  const videoRatePaise = aiSpendSettings?.videoCostPaise ?? 0;
  const usdToInrPaise = aiCostConfig?.usdToInrPaise ?? 0;
  const convertPaise = (() => {
    const n = Number(convertAmount);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return convertCurrency === "USD"
      ? Math.round(n * usdToInrPaise)
      : Math.round(n * 100);
  })();
  const convertedVideos =
    videoRatePaise > 0 ? Math.floor(convertPaise / videoRatePaise) : 0;
  const updateSuperadmin = useAdminUpdateTenantSuperadmin();
  const updateTenantDesignSkill = useAdminUpdateTenantDesignSkill();
  // Wallet adjustments stay disabled unless the platform switch is on, while
  // the table still shows the selected and actual rail explicitly.
  const { flags } = useFeatureFlags();
  const walletEnabled = flags.wallet;
  const updateBillingMode = useAdminUpdateTenantBillingMode();
  const adjustWallet = useAdminAdjustTenantWallet();
  const [walletTarget, setWalletTarget] = useState<{
    id: number;
    name: string;
    balancePaise: number;
  } | null>(null);
  const [walletAmount, setWalletAmount] = useState("");
  const [walletCurrency, setWalletCurrency] = useState<"INR" | "USD">("INR");
  const [walletNote, setWalletNote] = useState("");
  // Client-side name/email filter so a specific workspace is easy to find in
  // the full list. Empty search shows every tenant.
  const [tenantSearch, setTenantSearch] = useState("");
  const visibleTenants = (tenants ?? []).filter((t) => {
    const q = tenantSearch.trim().toLowerCase();
    if (!q) return true;
    return (
      t.name.toLowerCase().includes(q) || (t.email ?? "").toLowerCase().includes(q)
    );
  });

  const handleBillingModeChange = (tenantId: number, mode: string) => {
    updateBillingMode.mutate(
      {
        id: tenantId,
        data: { billingMode: mode as "quota" | "wallet" | "credits" },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getAdminListTenantsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getAdminListAuditLogsQueryKey() });
          toast({
            title:
              mode === "wallet"
                ? "Moved to legacy wallet billing"
                : mode === "credits"
                  ? "Credits mode selected"
                  : "Moved to legacy quota billing",
            description:
              mode === "wallet"
                ? "Generations for this workspace are now charged to its ₹ wallet."
                : mode === "credits"
                  ? "The workspace is marked for unified credits; enforcement remains controlled by the platform credit meter."
                : "This workspace is back on plan quotas and unit credits.",
          });
        },
        onError: (err: any) => {
          toast({
            title: "Update failed",
            description: apiErrorMessage(err, "Could not change the billing mode."),
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleDesignSkillChange = (tenantId: number, value: string) => {
    const enabled = value === "default" ? null : value === "on";
    updateTenantDesignSkill.mutate(
      { id: tenantId, data: { enabled } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getAdminListTenantsQueryKey(),
          });
          queryClient.invalidateQueries({
            queryKey: getAdminListAuditLogsQueryKey(),
          });
          toast({
            title: "Design skill updated",
            description:
              enabled === null
                ? "This workspace now follows the global setting."
                : enabled
                  ? "Design skill forced on for this workspace."
                  : "Design skill forced off for this workspace.",
          });
        },
        onError: (err: any) => {
          toast({
            title: "Update failed",
            description: apiErrorMessage(err, "Could not change the design skill override."),
            variant: "destructive",
          });
        },
      },
    );
  };

  const handlePlanChange = (
    tenantId: number,
    plan: string,
    confirmActiveSubscription = false,
  ) => {
    updatePlan.mutate(
      {
        id: tenantId,
        data: confirmActiveSubscription
          ? { plan, confirmActiveSubscription: true }
          : { plan },
      },
      {
        onSuccess: () => {
          setPlanOverrideConfirm(null);
          queryClient.invalidateQueries({
            queryKey: getAdminListTenantsQueryKey(),
          });
          queryClient.invalidateQueries({
            queryKey: getAdminGetStatsQueryKey(),
          });
          queryClient.invalidateQueries({
            queryKey: getAdminListAuditLogsQueryKey(),
          });
          toast({ title: "Plan updated", description: "Tenant plan changed successfully." });
        },
        onError: (err: any) => {
          if (err?.response?.status === 409) {
            // Active paid subscription: warn and ask the admin to confirm.
            setPlanOverrideConfirm({ tenantId, plan });
            return;
          }
          toast({
            title: "Update failed",
            description:
              apiErrorMessage(err, "Could not update the tenant plan."),
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleSuperadminChange = (tenantId: number, isSuperadmin: boolean) => {
    updateSuperadmin.mutate(
      { id: tenantId, data: { isSuperadmin } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getAdminListTenantsQueryKey(),
          });
          queryClient.invalidateQueries({
            queryKey: getAdminListAuditLogsQueryKey(),
          });
          toast({
            title: isSuperadmin ? "Superadmin granted" : "Superadmin revoked",
            description: isSuperadmin
              ? "This workspace now has admin access."
              : "Admin access removed from this workspace.",
          });
        },
        onError: (err: any) => {
          toast({
            title: "Update failed",
            description: apiErrorMessage(err, "Could not change superadmin access."),
            variant: "destructive",
          });
        },
      },
    );
  };

  const planNameById: Record<string, string> = {};
  for (const p of planCatalog ?? []) planNameById[p.id] = p.name;

  return (
    <div className="space-y-8">
      <Card>
        <CollapsibleCardHeader
          title="Tenants"
          description="Every workspace on the platform. Unified credits are shown first; legacy quota details remain available per workspace."
          open={tenantsOpen}
          onToggle={() => setTenantsOpen((o) => !o)}
          testId="toggle-tenants-card"
        />
        {tenantsOpen && (
        <CardContent>
          {tenantsLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Input
                  placeholder="Search by workspace or email…"
                  value={tenantSearch}
                  onChange={(e) => setTenantSearch(e.target.value)}
                  className="max-w-xs"
                  data-testid="input-tenant-search"
                />
                <span
                  className="text-sm text-muted-foreground tabular-nums"
                  data-testid="text-tenant-count"
                >
                  {tenantSearch.trim()
                    ? `${visibleTenants.length} of ${(tenants ?? []).length} workspaces`
                    : `${(tenants ?? []).length} workspaces`}
                </span>
              </div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Workspace</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead className="text-right">Content</TableHead>
                    <TableHead className="text-right">Brand Kits</TableHead>
                    <TableHead className="text-right">Accounts</TableHead>
                    <TableHead>Plan</TableHead>
                    <TableHead>Design Skill</TableHead>
                    <TableHead>Unified Credits</TableHead>
                    <TableHead>Billing mode</TableHead>
                    <TableHead className="text-right">Wallet</TableHead>
                    <TableHead>Superadmin</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleTenants.map((t) => (
                    <TableRow key={t.id}>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          {t.name}
                          {t.isSuperadmin && (
                            <Badge variant="default" className="text-xs">
                              Admin
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {t.email ?? "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {t.counts?.content ?? 0}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {t.counts?.brandKits ?? 0}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {t.counts?.connectedAccounts ?? 0}
                      </TableCell>
                      <TableCell>
                        <Select
                          value={t.plan}
                          onValueChange={(value) => handlePlanChange(t.id, value)}
                          disabled={updatePlan.isPending}
                        >
                          <SelectTrigger className="w-32">
                            <SelectValue>
                              {planNameById[t.plan] ??
                                PLAN_LABELS[t.plan] ??
                                t.plan}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            {(planCatalog ?? []).map((p) => (
                              <SelectItem key={p.id} value={p.id}>
                                {p.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Select
                          value={
                            t.designSkillEnabled === true
                              ? "on"
                              : t.designSkillEnabled === false
                                ? "off"
                                : "default"
                          }
                          onValueChange={(value) =>
                            handleDesignSkillChange(t.id, value)
                          }
                          disabled={updateTenantDesignSkill.isPending}
                        >
                          <SelectTrigger
                            className="w-28"
                            data-testid={`select-design-skill-${t.id}`}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="default">Default</SelectItem>
                            <SelectItem value="on">On</SelectItem>
                            <SelectItem value="off">Off</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <div className="flex min-w-[210px] items-center gap-3">
                          <button
                            type="button"
                            className="text-left underline-offset-4 hover:underline"
                            onClick={() => setDetailsTarget(t)}
                            data-testid={`button-credit-details-${t.id}`}
                            aria-label={`View credit details for ${t.name}`}
                          >
                            <span
                              className="block text-base font-semibold tabular-nums"
                              data-testid={`text-unified-credits-${t.id}`}
                            >
                              {formatCredits(t.balance?.total ?? 0)} credits
                            </span>
                            <span className="block text-xs text-muted-foreground tabular-nums">
                              {formatCredits(t.balance?.purchased ?? 0)} purchased ·{" "}
                              {formatCredits(t.balance?.granted ?? 0)} granted
                            </span>
                          </button>
                          {t.legacyConversion?.pending &&
                            hasLegacyCreditBalance(t.legacyConversion) && (
                            <Badge variant="outline" className="text-xs whitespace-nowrap">
                              Migration pending
                            </Badge>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setConversionTarget({ id: t.id, name: t.name })}
                          >
                            Adjust
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              setGrantTarget({
                                id: t.id,
                                name: t.name,
                                canonical: t.creditAccountExists === true,
                                purchasedMilli: Math.round((t.balance?.purchased ?? 0) * 1000),
                              })
                            }
                          >
                            Manual adjustment
                          </Button>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="space-y-1">
                          <Select
                            value={t.billingMode}
                            onValueChange={(value) =>
                              handleBillingModeChange(t.id, value)
                            }
                            disabled={updateBillingMode.isPending}
                          >
                            <SelectTrigger
                              className="w-36"
                              data-testid={`select-billing-mode-${t.id}`}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="quota">Legacy quota</SelectItem>
                              <SelectItem value="wallet">Legacy wallet</SelectItem>
                              <SelectItem value="credits" disabled>
                                Credits (meter-controlled)
                              </SelectItem>
                            </SelectContent>
                          </Select>
                          <span
                            className="block text-xs text-muted-foreground"
                            data-testid={`text-effective-billing-mode-${t.id}`}
                          >
                            Actual: {billingModeLabel(t.effectiveBillingMode ?? t.billingMode)}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <button
                          type="button"
                          className="tabular-nums underline-offset-4 hover:underline"
                          disabled={!walletEnabled}
                          onClick={() => {
                            if (walletEnabled) {
                              setWalletTarget({
                                id: t.id,
                                name: t.name,
                                balancePaise: t.walletBalancePaise ?? 0,
                              });
                            }
                          }}
                          data-testid={`button-wallet-${t.id}`}
                          aria-label={
                            walletEnabled
                              ? `Adjust wallet for ${t.name}`
                              : `Wallet balance for ${t.name}`
                          }
                          title={
                            walletEnabled
                              ? "Adjust legacy wallet"
                              : "Legacy wallet adjustments are disabled"
                          }
                        >
                          {formatInr(t.walletBalancePaise ?? 0)}
                        </button>
                        {!walletEnabled && (
                          <span className="block text-xs text-muted-foreground">
                            Legacy balance
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={t.isSuperadmin}
                            disabled={
                              !me?.isOwner ||
                              t.isAllowlisted ||
                              updateSuperadmin.isPending
                            }
                            onCheckedChange={(checked) =>
                              handleSuperadminChange(t.id, checked)
                            }
                            aria-label={`Toggle superadmin for ${t.name}`}
                          />
                          {t.isAllowlisted && (
                            <span
                              className="text-xs text-muted-foreground"
                              title="Built-in superadmin set via the allowlist; cannot be changed here."
                            >
                              Owner
                            </span>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            </div>
          )}
        </CardContent>
        )}
      </Card>

      <SeatRequestsCard />

      <ConfirmDialog
        open={planOverrideConfirm !== null}
        onOpenChange={(open) => !open && setPlanOverrideConfirm(null)}
        title="Override an active subscription?"
        description="This workspace is currently paying for a subscription. Changing the plan here will not cancel or refund it, and future renewals will no longer change the plan — your choice stays in effect until the workspace makes a billing change itself."
        confirmLabel="Override plan"
        destructive
        onConfirm={() => {
          if (!planOverrideConfirm) return;
          handlePlanChange(
            planOverrideConfirm.tenantId,
            planOverrideConfirm.plan,
            true,
          );
        }}
      />

      {conversionTarget && <WalletConversionDialog tenant={conversionTarget} onClose={() => setConversionTarget(null)} />}
      <Dialog
        open={grantTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setGrantTarget(null);
            setGrantCaptions("0");
            setGrantImages("0");
            setGrantVideos("0");
            setGrantUnified("0");
            setGrantNote("");
            setConvertAmount("");
            setConvertCurrency("INR");
          }
        }}
      >
        <DialogContent className="sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>
              {grantTarget?.canonical ? "Adjust unified credits" : "Adjust legacy credits"}
              {grantTarget ? ` for ${grantTarget.name}` : ""}
            </DialogTitle>
            <DialogDescription>
              {grantTarget?.canonical
                ? "Standard adjustments affect granted credits only. Purchased-credit historical corrections use the separate reviewed action below."
                : "This workspace has no canonical credit account yet. These are legacy unit-credit controls, kept separate from unified credits; use negative numbers to deduct."}
            </DialogDescription>
          </DialogHeader>
          {grantTarget?.canonical ? (
            <div className="space-y-2">
              <label className="text-sm font-medium">Unified credits</label>
              <Input
                type="number"
                step="0.001"
                value={grantUnified}
                onChange={(e) => setGrantUnified(e.target.value)}
                data-testid="input-grant-unified"
              />
              <section className="space-y-2 border-t pt-3">
                <p className="text-sm font-medium">Purchased-credit correction</p>
                <p className="text-sm">Purchased balance: {((grantTarget.purchasedMilli ?? 0) / 1000).toFixed(3)}</p>
                <p className="text-xs text-muted-foreground">Debit only the approved remaining amount, after subtracting prior charges. Reuse the same operation reference after a network error; never create a new reference to retry.</p>
                <label htmlFor="correction-amount" className="block text-sm font-medium">Credits to deduct (required)</label>
                <Input id="correction-amount" aria-label="Purchased credits to deduct" type="number" min="0.001" step="0.001" placeholder="Enter a positive amount" value={correctionAmount} onChange={(e) => setCorrectionAmount(e.target.value)} />
                <p className="text-xs text-muted-foreground">Enter the positive amount to subtract, not a negative adjustment.</p>
                <label htmlFor="correction-reference" className="block text-sm font-medium">Operation reference (required)</label>
                <Input id="correction-reference" aria-label="Correction operation reference" placeholder="Example only: video:13:rate-card-correction" maxLength={160} value={correctionReference} onChange={(e) => setCorrectionReference(e.target.value)} />
                <p className="text-xs text-muted-foreground">Type a unique reference using letters, numbers, colons, dots, underscores or hyphens. Spaces are not allowed.</p>
                <label htmlFor="correction-reason" className="block text-sm font-medium">Reason and authorization (required)</label>
                <Input id="correction-reason" aria-label="Correction reason" placeholder="Explain the approved correction and any prior charge" maxLength={1000} value={correctionReason} onChange={(e) => setCorrectionReason(e.target.value)} />
                <Button variant="destructive" disabled={correction.isPending} onClick={() => {
                  const amount = correctionAmount.trim();
                  const milli = Math.round(Number(amount) * 1000);
                  const reference = correctionReference.trim();
                  const reason = correctionReason.trim();
                  let error: string | null = null;
                  if (!amount || Number(amount) <= 0) {
                    error = "Enter a positive amount to deduct, such as 92.724. Do not enter a minus sign.";
                  } else if (!/^\d+(\.\d{1,3})?$/.test(amount) || !Number.isSafeInteger(milli) || milli > 2147483647) {
                    error = "Use a number with at most 3 decimal places, no commas, and no more than 2147483.647 credits.";
                  } else if (milli > (grantTarget.purchasedMilli ?? 0)) {
                    error = `The deduction exceeds the purchased balance of ${((grantTarget.purchasedMilli ?? 0) / 1000).toFixed(3)} credits. Granted credits cannot fund this correction.`;
                  } else if (!reference) {
                    error = "Enter an operation reference. The grey example is a placeholder, not a saved value.";
                  } else if (reference.length > 160 || !/^[a-zA-Z0-9][a-zA-Z0-9:._-]*$/.test(reference)) {
                    error = "The operation reference must start with a letter or number and contain only letters, numbers, colons, dots, underscores or hyphens (maximum 160 characters). Remove spaces.";
                  } else if (!reason || reason.length > 1000) {
                    error = "Enter the reason and authorization for this correction (maximum 1000 characters).";
                  }
                  if (error) {
                    toast({ variant: "destructive", title: "Check correction", description: error });
                    return;
                  }
                  setConfirmCorrection(true);
                }}>Review purchased debit</Button>
                <ConfirmDialog open={confirmCorrection} onOpenChange={setConfirmCorrection} destructive title="Confirm exact purchased-credit debit"
                  description={`${grantTarget.name}: purchased ${((grantTarget.purchasedMilli ?? 0) / 1000).toFixed(3)} → ${(((grantTarget.purchasedMilli ?? 0) - Math.round(Number(correctionAmount) * 1000)) / 1000).toFixed(3)} credits. Debit ${Number(correctionAmount).toFixed(3)}. Reference: ${correctionReference.trim()}. Reason: ${correctionReason.trim()}. Granted credits are unchanged.`}
                  confirmLabel="Debit purchased credits"
                  onConfirm={() => {
                    if (correctionInFlight.current) return;
                    correctionInFlight.current = true;
                    correction.mutate({ id: grantTarget.id, data: {
                    amountMilli: Math.round(Number(correctionAmount) * 1000),
                    expectedPurchasedMilli: grantTarget.purchasedMilli ?? 0,
                    reference: correctionReference.trim(), reason: correctionReason.trim(),
                  } }, {
                    onSuccess: (receipt) => {
                      correctionInFlight.current = false;
                      // Includes tenant list, account/history, current-user credit
                      // balance and audit queries rather than a local-only update.
                      queryClient.invalidateQueries();
                      toast({ title: "Purchased correction recorded", description: `${(receipt.beforePurchasedMilli / 1000).toFixed(3)} → ${(receipt.afterPurchasedMilli / 1000).toFixed(3)} purchased credits. Reference: ${receipt.reference}` });
                      setGrantTarget(null);
                      setCorrectionAmount(""); setCorrectionReference(""); setCorrectionReason("");
                    },
                    onError: (err: unknown) => {
                      correctionInFlight.current = false;
                      queryClient.invalidateQueries({ queryKey: getAdminListTenantsQueryKey() });
                      toast({ variant: "destructive", title: "Correction not confirmed", description: apiErrorMessage(err, "Retry with the same reference and amount. Refresh the balance if it changed.") });
                    },
                  }); }} />
              </section>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Legacy captions</label>
                  <Input
                    value={grantCaptions}
                    onChange={(e) => setGrantCaptions(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Legacy images</label>
                  <Input
                    value={grantImages}
                    onChange={(e) => setGrantImages(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Legacy videos</label>
                  <Input
                    value={grantVideos}
                    onChange={(e) => setGrantVideos(e.target.value)}
                    data-testid="input-grant-videos"
                  />
                </div>
              </div>
              <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
                <label className="text-sm font-medium">
                  Convert money into legacy video credits
                </label>
                <div className="flex items-center gap-2">
                  <Select
                    value={convertCurrency}
                    onValueChange={(v) => setConvertCurrency(v as "INR" | "USD")}
                  >
                    <SelectTrigger className="w-20" data-testid="select-convert-currency">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="INR">₹</SelectItem>
                      <SelectItem value="USD">$</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input
                    type="number"
                    min="0"
                    placeholder="Amount"
                    value={convertAmount}
                    onChange={(e) => setConvertAmount(e.target.value)}
                    data-testid="input-convert-amount"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={convertedVideos <= 0}
                    onClick={() => setGrantVideos(String(convertedVideos))}
                    data-testid="button-apply-conversion"
                  >
                    Apply
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {videoRatePaise <= 0
                    ? "Set a per-video rate in the AI tab's spend display card first."
                    : convertCurrency === "USD" && usdToInrPaise <= 0
                      ? "Set the USD→INR rate in the AI tab first to convert dollars."
                      : convertPaise > 0
                        ? `= ${convertedVideos} legacy video credit${convertedVideos === 1 ? "" : "s"} at ₹${(videoRatePaise / 100).toFixed(2)} per video${
                            convertCurrency === "USD"
                              ? ` (₹${(convertPaise / 100).toFixed(2)})`
                              : ""
                          }`
                        : `Rate: ₹${(videoRatePaise / 100).toFixed(2)} per video. Enter an amount to see the conversion.`}
                </p>
              </div>
            </>
          )}
          <div className="space-y-2">
            <label className="text-sm font-medium">Note (optional)</label>
            <Input
              value={grantNote}
              onChange={(e) => setGrantNote(e.target.value)}
              placeholder="e.g. goodwill top-up"
            />
          </div>
          <DialogFooter>
            <Button
              disabled={grantCredits.isPending || grantCreditAccount.isPending}
              onClick={() => {
                if (!grantTarget) return;
                if (grantTarget.canonical) {
                  const credits = Number(grantUnified);
                  if (!Number.isFinite(credits) || credits === 0) {
                    toast({
                      variant: "destructive",
                      title: "Check the amount",
                      description:
                        "Enter a non-zero number of unified credits (negative to deduct).",
                    });
                    return;
                  }
                  grantCreditAccount.mutate(
                    {
                      id: grantTarget.id,
                      data: {
                        credits,
                        note: grantNote.trim() || undefined,
                      },
                    },
                    {
                      onSuccess: () => {
                        queryClient.invalidateQueries({
                          queryKey: getAdminListTenantsQueryKey(),
                        });
                        queryClient.invalidateQueries({
                          queryKey: getAdminListAuditLogsQueryKey(),
                        });
                        toast({
                          title: "Unified credits updated",
                          description: `Balance adjusted for ${grantTarget.name}.`,
                        });
                        setGrantTarget(null);
                        setGrantCaptions("0");
                        setGrantImages("0");
                        setGrantVideos("0");
                        setGrantUnified("0");
                        setGrantNote("");
                        setConvertAmount("");
                        setConvertCurrency("INR");
                      },
                      onError: (err: any) => {
                        toast({
                          variant: "destructive",
                          title: "Could not adjust unified credits",
                          description: apiErrorMessage(err, "Please try again."),
                        });
                      },
                    },
                  );
                  return;
                }
                const captions = Number(grantCaptions);
                const images = Number(grantImages);
                const videos = Number(grantVideos);
                if (
                  !Number.isInteger(captions) ||
                  !Number.isInteger(images) ||
                  !Number.isInteger(videos) ||
                  (captions === 0 && images === 0 && videos === 0)
                ) {
                  toast({
                    variant: "destructive",
                    title: "Check the amounts",
                    description:
                      "Enter whole numbers (negative to deduct); at least one amount must be non-zero.",
                  });
                  return;
                }
                grantCredits.mutate(
                  {
                    id: grantTarget.id,
                    data: {
                      captionCredits: captions,
                      imageCredits: images,
                      videoCredits: videos,
                      note: grantNote.trim() || undefined,
                    },
                  },
                  {
                    onSuccess: () => {
                      queryClient.invalidateQueries({
                        queryKey: getAdminListTenantsQueryKey(),
                      });
                      queryClient.invalidateQueries({
                        queryKey: getAdminListAuditLogsQueryKey(),
                      });
                      toast({
                        title: "Legacy credits updated",
                        description: `Balance adjusted for ${grantTarget.name}.`,
                      });
                      setGrantTarget(null);
                      setGrantCaptions("0");
                      setGrantImages("0");
                      setGrantVideos("0");
                      setGrantUnified("0");
                      setGrantNote("");
                      setConvertAmount("");
                      setConvertCurrency("INR");
                    },
                    onError: (err: any) => {
                      toast({
                        variant: "destructive",
                        title: "Could not adjust credits",
                        description:
                          apiErrorMessage(err, "Please try again."),
                      });
                    },
                  },
                );
              }}
            >
              {grantCredits.isPending || grantCreditAccount.isPending ? (
                <>
                  <RippleSpinner className="h-4 w-4 mr-2" /> Granting...
                </>
              ) : (
                "Apply adjustment"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={detailsTarget !== null}
        onOpenChange={(open) => !open && setDetailsTarget(null)}
      >
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>
              Credit details{detailsTarget ? ` — ${detailsTarget.name}` : ""}
            </DialogTitle>
            <DialogDescription>
              Unified balances are the canonical purchased/granted account.
              Legacy unit quotas and credit buckets are shown separately and
              are not silently converted here.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-lg border border-border p-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-medium">Unified credits</span>
                <span
                  className="text-lg font-semibold tabular-nums"
                  data-testid="text-details-unified-total"
                >
                  {formatCredits(detailsTarget?.balance?.total ?? 0)}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                {formatCredits(detailsTarget?.balance?.purchased ?? 0)} purchased
                {" · "}
                {formatCredits(detailsTarget?.balance?.granted ?? 0)} granted
                {detailsTarget?.balance?.grantedExpiresAt
                  ? ` · expires ${new Date(detailsTarget.balance.grantedExpiresAt).toLocaleDateString()}`
                  : ""}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                {detailsTarget?.creditAccountExists
                  ? "Canonical account"
                  : "No canonical account; adjustments use legacy buckets"}
              </p>
            </div>
            <div className="rounded-lg border border-border p-3">
              <p className="text-sm font-medium">Legacy balance (not unified)</p>
              <p className="mt-1 text-sm text-muted-foreground tabular-nums">
                {detailsTarget?.legacyConversion?.captionCredits ?? 0} captions ·{" "}
                {detailsTarget?.legacyConversion?.imageCredits ?? 0} images ·{" "}
                {detailsTarget?.legacyConversion?.videoCredits ?? 0} videos
              </p>
              <p className="mt-2 text-xs text-muted-foreground tabular-nums">
                Quota usage: {detailsTarget?.usage?.captions ?? 0} captions ·{" "}
                {detailsTarget?.usage?.images ?? 0} images
                {" · "}
                Wallet: {formatInr(detailsTarget?.walletBalancePaise ?? 0)}
              </p>
              {detailsTarget?.legacyConversion?.pending &&
                hasLegacyCreditBalance(detailsTarget.legacyConversion) && (
                <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                  Migration pending. No customer migration was run by this view.
                </p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-muted-foreground">Selected mode</p>
                <p className="font-medium">{billingModeLabel(detailsTarget?.billingMode ?? "quota")}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Actual funding</p>
                <p className="font-medium">
                  {billingModeLabel(
                    detailsTarget?.effectiveBillingMode ??
                      detailsTarget?.billingMode ??
                      "quota",
                  )}
                </p>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetailsTarget(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={walletTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setWalletTarget(null);
            setWalletAmount("");
            setWalletCurrency("INR");
            setWalletNote("");
          }
        }}
      >
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Adjust legacy wallet — {walletTarget?.name}</DialogTitle>
            <DialogDescription>
              Legacy wallet balance: {formatInr(walletTarget?.balancePaise ?? 0)}.
              Enter a positive amount in ₹ to add, or a negative one to deduct.
              No GST is applied — an admin adjustment is not a sale.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="wallet-amount">
                Amount (₹)
              </label>
              <div className="flex items-center gap-2">
                <Select
                  value={walletCurrency}
                  onValueChange={(v) => setWalletCurrency(v as "INR" | "USD")}
                >
                  <SelectTrigger className="w-20" data-testid="select-wallet-currency">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="INR">₹</SelectItem>
                    <SelectItem value="USD">$</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  id="wallet-amount"
                  type="number"
                  step="0.01"
                  placeholder="500"
                  value={walletAmount}
                  onChange={(e) => setWalletAmount(e.target.value)}
                  data-testid="input-wallet-amount"
                />
              </div>
              {walletCurrency === "USD" && (
                <p className="text-xs text-muted-foreground">
                  {usdToInrPaise > 0
                    ? Number(walletAmount) !== 0 && Number.isFinite(Number(walletAmount))
                      ? `Credited as ₹${((Number(walletAmount) * usdToInrPaise) / 100).toFixed(2)} at the AI tab's USD→INR rate.`
                      : "Dollars convert to rupees at the AI tab's USD→INR rate."
                    : "Set the USD→INR rate in the AI tab first to use dollars."}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="wallet-note">
                Note (optional)
              </label>
              <Input
                id="wallet-note"
                placeholder="Goodwill credit"
                value={walletNote}
                onChange={(e) => setWalletNote(e.target.value)}
                data-testid="input-wallet-note"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={adjustWallet.isPending}
              onClick={() => setWalletTarget(null)}
            >
              Cancel
            </Button>
            <Button
              disabled={adjustWallet.isPending}
              data-testid="button-apply-wallet-adjust"
              onClick={() => {
                if (!walletTarget) return;
                const entered = Number(walletAmount);
                if (!Number.isFinite(entered) || entered === 0) {
                  toast({
                    variant: "destructive",
                    title: "Enter an amount",
                    description: "Use a positive number to add, negative to deduct.",
                  });
                  return;
                }
                if (walletCurrency === "USD" && usdToInrPaise <= 0) {
                  toast({
                    variant: "destructive",
                    title: "USD rate not set",
                    description:
                      "Set the USD→INR rate in the AI tab first, or enter the amount in rupees.",
                  });
                  return;
                }
                const amountPaise =
                  walletCurrency === "USD"
                    ? Math.round(entered * usdToInrPaise)
                    : Math.round(entered * 100);
                adjustWallet.mutate(
                  {
                    id: walletTarget.id,
                    data: {
                      amountPaise,
                      ...(walletNote.trim() ? { note: walletNote.trim() } : {}),
                    },
                  },
                  {
                    onSuccess: (result) => {
                      queryClient.invalidateQueries({
                        queryKey: getAdminListTenantsQueryKey(),
                      });
                      queryClient.invalidateQueries({
                        queryKey: getAdminListAuditLogsQueryKey(),
                      });
                      setWalletTarget(null);
                      setWalletAmount("");
                      setWalletCurrency("INR");
                      setWalletNote("");
                      toast({
                        title: "Legacy wallet updated",
                        description: `New balance ${formatInr(result.balancePaise)}.`,
                      });
                    },
                    onError: (err: any) => {
                      toast({
                        variant: "destructive",
                        title: "Adjustment failed",
                        description: apiErrorMessage(err, "Could not change the wallet balance."),
                      });
                    },
                  },
                );
              }}
            >
              {adjustWallet.isPending ? (
                <RippleSpinner className="h-4 w-4" />
              ) : (
                "Apply"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
