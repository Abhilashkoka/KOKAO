import { useState } from "react";
import { RippleSpinner } from "@/components/ui/ripple-spinner";
import {
  useAdminListTenants,
  useAdminUpdateTenantPlan,
  useAdminUpdateTenantSuperadmin,
  useAdminUpdateTenantDesignSkill,
  useAdminGrantCredits,
  useAdminListSeatRequests,
  useAdminDecideSeatRequest,
  getAdminListSeatRequestsQueryKey,
  getAdminListTenantsQueryKey,
  getAdminGetStatsQueryKey,
  getAdminListAuditLogsQueryKey,
  useListPlans,
  useGetMe,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { ConfirmDialog } from "@/components/confirm-dialog";
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

import { PLAN_LABELS } from "./shared";

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
            description: err?.response?.data?.error || "Please try again.",
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
  const [grantTarget, setGrantTarget] = useState<{ id: number; name: string } | null>(null);
  const [planOverrideConfirm, setPlanOverrideConfirm] = useState<{
    tenantId: number;
    plan: string;
  } | null>(null);
  const [grantCaptions, setGrantCaptions] = useState("0");
  const [grantImages, setGrantImages] = useState("0");
  const [grantNote, setGrantNote] = useState("");
  const updateSuperadmin = useAdminUpdateTenantSuperadmin();
  const updateTenantDesignSkill = useAdminUpdateTenantDesignSkill();

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
        onError: () => {
          toast({
            title: "Update failed",
            description: "Could not change the design skill override.",
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
              err?.response?.data?.error || "Could not update the tenant plan.",
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
        onError: () => {
          toast({
            title: "Update failed",
            description: "Could not change superadmin access.",
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
        <CardHeader>
          <CardTitle>Tenants</CardTitle>
          <CardDescription>
            Every workspace on the platform. Change a plan to override quotas.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {tenantsLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Workspace</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead className="text-right">Captions</TableHead>
                    <TableHead className="text-right">Images</TableHead>
                    <TableHead className="text-right">Content</TableHead>
                    <TableHead className="text-right">Brand Kits</TableHead>
                    <TableHead className="text-right">Accounts</TableHead>
                    <TableHead>Plan</TableHead>
                    <TableHead>Design Skill</TableHead>
                    <TableHead>Credits</TableHead>
                    <TableHead>Superadmin</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(tenants ?? []).map((t) => (
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
                        {t.usage?.captions ?? 0}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {t.usage?.images ?? 0}
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
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setGrantTarget({ id: t.id, name: t.name })
                          }
                        >
                          Grant
                        </Button>
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
          )}
        </CardContent>
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

      <Dialog
        open={grantTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setGrantTarget(null);
            setGrantCaptions("0");
            setGrantImages("0");
            setGrantNote("");
          }
        }}
      >
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>
              Adjust credits{grantTarget ? ` for ${grantTarget.name}` : ""}
            </DialogTitle>
            <DialogDescription>
              Adds or deducts caption and image credits for this workspace
              (use negative numbers to deduct; balances never go below zero).
              Credits are used after the monthly plan quota runs out.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <label className="text-sm font-medium">Caption credits</label>
              <Input
                value={grantCaptions}
                onChange={(e) => setGrantCaptions(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Image credits</label>
              <Input
                value={grantImages}
                onChange={(e) => setGrantImages(e.target.value)}
              />
            </div>
          </div>
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
              disabled={grantCredits.isPending}
              onClick={() => {
                if (!grantTarget) return;
                const captions = Number(grantCaptions);
                const images = Number(grantImages);
                if (
                  !Number.isInteger(captions) ||
                  !Number.isInteger(images) ||
                  (captions === 0 && images === 0)
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
                      note: grantNote.trim() || undefined,
                    },
                  },
                  {
                    onSuccess: () => {
                      queryClient.invalidateQueries({
                        queryKey: getAdminListAuditLogsQueryKey(),
                      });
                      toast({
                        title: "Credits updated",
                        description: `Balance adjusted for ${grantTarget.name}.`,
                      });
                      setGrantTarget(null);
                      setGrantCaptions("0");
                      setGrantImages("0");
                      setGrantNote("");
                    },
                    onError: (err: any) => {
                      toast({
                        variant: "destructive",
                        title: "Could not adjust credits",
                        description:
                          err?.response?.data?.error || "Please try again.",
                      });
                    },
                  },
                );
              }}
            >
              {grantCredits.isPending ? (
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
    </div>
  );
}
