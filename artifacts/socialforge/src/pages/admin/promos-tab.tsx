import { useState } from "react";
import {
  useAdminListPromoCodes,
  useAdminCreatePromoCodes,
  useAdminUpdatePromoCode,
  useAdminDeactivatePromoCode,
  useAdminGetPromoMetrics,
  useAdminListPromoFailures,
  useListPlans,
  getAdminListPromoCodesQueryKey,
  getAdminGetPromoMetricsQueryKey,
} from "@workspace/api-client-react";
import type { PromoCode, PromoCodeAudience } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { TicketPercent, BarChart3, AlertTriangle } from "lucide-react";
import { SignupCreditsCard } from "./signup-credits-card";

function errorMessage(error: unknown, fallback: string): string {
  const data = (error as { response?: { data?: { error?: string } } })?.response
    ?.data;
  return data?.error ?? fallback;
}

const AUDIENCE_LABELS: Record<PromoCodeAudience, string> = {
  all: "Everyone",
  new: "New users",
  existing: "Existing users",
};

interface FormState {
  mode: "single" | "bulk";
  code: string;
  generateCount: string;
  prefix: string;
  campaign: string;
  captionCredits: string;
  imageCredits: string;
  videoCredits: string;
  audience: PromoCodeAudience;
  newTenantDays: string;
  allowedPlans: string[];
  maxRedemptions: string;
  perTenantLimit: string;
  startsAt: string;
  expiresAt: string;
  note: string;
}

const EMPTY_FORM: FormState = {
  mode: "single",
  code: "",
  generateCount: "10",
  prefix: "",
  campaign: "",
  captionCredits: "0",
  imageCredits: "0",
  videoCredits: "0",
  audience: "all",
  newTenantDays: "30",
  allowedPlans: [],
  maxRedemptions: "",
  perTenantLimit: "1",
  startsAt: "",
  expiresAt: "",
  note: "",
};

function toIsoOrNull(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function PromosTab() {
  const { data: codes, isLoading } = useAdminListPromoCodes();
  const { data: metrics } = useAdminGetPromoMetrics();
  const { data: failures } = useAdminListPromoFailures();
  const { data: plans } = useListPlans();
  const createCodes = useAdminCreatePromoCodes();
  const updateCode = useAdminUpdatePromoCode();
  const deactivateCode = useAdminDeactivatePromoCode();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [confirmDeactivate, setConfirmDeactivate] = useState<PromoCode | null>(
    null,
  );
  const [lastBatch, setLastBatch] = useState<PromoCode[] | null>(null);

  const set = (patch: Partial<FormState>) =>
    setForm((prev) => ({ ...prev, ...patch }));

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: getAdminListPromoCodesQueryKey() });
    queryClient.invalidateQueries({ queryKey: getAdminGetPromoMetricsQueryKey() });
  };

  const handleCreate = () => {
    const captionCredits = Number(form.captionCredits) || 0;
    const imageCredits = Number(form.imageCredits) || 0;
    const videoCredits = Number(form.videoCredits) || 0;
    if (captionCredits <= 0 && imageCredits <= 0 && videoCredits <= 0) {
      toast({
        title: "Add some credits",
        description:
          "A promo code must grant at least one caption, image, or video credit.",
        variant: "destructive",
      });
      return;
    }
    createCodes.mutate(
      {
        data: {
          ...(form.mode === "single"
            ? { code: form.code.trim() }
            : {
                generateCount: Math.max(1, Number(form.generateCount) || 1),
                ...(form.prefix.trim() ? { prefix: form.prefix.trim() } : {}),
              }),
          ...(form.campaign.trim() ? { campaign: form.campaign.trim() } : {}),
          captionCredits,
          imageCredits,
          videoCredits,
          ...(form.allowedPlans.length > 0
            ? { allowedPlans: form.allowedPlans }
            : {}),
          audience: form.audience,
          ...(form.audience === "new"
            ? { newTenantDays: Math.max(1, Number(form.newTenantDays) || 30) }
            : {}),
          maxRedemptions: form.maxRedemptions
            ? Math.max(1, Number(form.maxRedemptions))
            : null,
          perTenantLimit: Math.max(1, Number(form.perTenantLimit) || 1),
          startsAt: toIsoOrNull(form.startsAt),
          expiresAt: toIsoOrNull(form.expiresAt),
          ...(form.note.trim() ? { note: form.note.trim() } : {}),
        },
      },
      {
        onSuccess: (created) => {
          toast({
            title:
              created.length === 1
                ? `Code ${created[0].code} created`
                : `${created.length} codes generated`,
          });
          setLastBatch(created.length > 1 ? created : null);
          setForm(EMPTY_FORM);
          refresh();
        },
        onError: (error) =>
          toast({
            title: "Could not create the code",
            description: errorMessage(error, "Please check the values and try again."),
            variant: "destructive",
          }),
      },
    );
  };

  const toggleActive = (promo: PromoCode) => {
    if (promo.active) {
      setConfirmDeactivate(promo);
      return;
    }
    updateCode.mutate(
      { id: promo.id, data: { active: true } },
      {
        onSuccess: () => {
          toast({ title: `Code ${promo.code} reactivated` });
          refresh();
        },
        onError: (error) =>
          toast({
            title: "Could not reactivate",
            description: errorMessage(error, "Please try again."),
            variant: "destructive",
          }),
      },
    );
  };

  const planName = (id: string) => plans?.find((p) => p.id === id)?.name ?? id;

  return (
    <div className="space-y-6">
      <SignupCreditsCard />

      <Card className="border-border shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TicketPercent className="h-5 w-5 text-primary" /> Create promo codes
          </CardTitle>
          <CardDescription>
            Give away free caption and image credits. Create one named code or
            generate a batch of unique codes for a campaign.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="inline-flex items-center rounded-full border bg-muted p-1">
            {(["single", "bulk"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => set({ mode })}
                data-testid={`promo-mode-${mode}`}
                className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                  form.mode === mode
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {mode === "single" ? "Single code" : "Generate batch"}
              </button>
            ))}
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {form.mode === "single" ? (
              <div className="space-y-1.5">
                <Label htmlFor="promo-code">Code</Label>
                <Input
                  id="promo-code"
                  value={form.code}
                  onChange={(e) => set({ code: e.target.value.toUpperCase() })}
                  placeholder="WELCOME25"
                  maxLength={64}
                  data-testid="input-new-promo-code"
                />
              </div>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="promo-count">How many codes</Label>
                  <Input
                    id="promo-count"
                    type="number"
                    min={1}
                    max={500}
                    value={form.generateCount}
                    onChange={(e) => set({ generateCount: e.target.value })}
                    data-testid="input-promo-count"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="promo-prefix">Prefix (optional)</Label>
                  <Input
                    id="promo-prefix"
                    value={form.prefix}
                    onChange={(e) => set({ prefix: e.target.value.toUpperCase() })}
                    placeholder="LAUNCH"
                    maxLength={20}
                    data-testid="input-promo-prefix"
                  />
                </div>
              </>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="promo-campaign">Campaign (optional)</Label>
              <Input
                id="promo-campaign"
                value={form.campaign}
                onChange={(e) => set({ campaign: e.target.value })}
                placeholder="Summer launch"
                maxLength={80}
                data-testid="input-promo-campaign"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="promo-captions">Caption credits</Label>
              <Input
                id="promo-captions"
                type="number"
                min={0}
                value={form.captionCredits}
                onChange={(e) => set({ captionCredits: e.target.value })}
                data-testid="input-promo-captions"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="promo-images">Image credits</Label>
              <Input
                id="promo-images"
                type="number"
                min={0}
                value={form.imageCredits}
                onChange={(e) => set({ imageCredits: e.target.value })}
                data-testid="input-promo-images"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="promo-videos">Video credits</Label>
              <Input
                id="promo-videos"
                type="number"
                min={0}
                value={form.videoCredits}
                onChange={(e) => set({ videoCredits: e.target.value })}
                data-testid="input-promo-videos"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Who can redeem</Label>
              <Select
                value={form.audience}
                onValueChange={(v) => set({ audience: v as PromoCodeAudience })}
              >
                <SelectTrigger data-testid="select-promo-audience">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Everyone</SelectItem>
                  <SelectItem value="new">New users only</SelectItem>
                  <SelectItem value="existing">Existing users only</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.audience === "new" && (
              <div className="space-y-1.5">
                <Label htmlFor="promo-newdays">"New" means signed up within (days)</Label>
                <Input
                  id="promo-newdays"
                  type="number"
                  min={1}
                  max={365}
                  value={form.newTenantDays}
                  onChange={(e) => set({ newTenantDays: e.target.value })}
                  data-testid="input-promo-newdays"
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="promo-max">Total redemption limit (blank = unlimited)</Label>
              <Input
                id="promo-max"
                type="number"
                min={1}
                value={form.maxRedemptions}
                onChange={(e) => set({ maxRedemptions: e.target.value })}
                placeholder="Unlimited"
                data-testid="input-promo-max"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="promo-pertenant">Uses per workspace</Label>
              <Input
                id="promo-pertenant"
                type="number"
                min={1}
                value={form.perTenantLimit}
                onChange={(e) => set({ perTenantLimit: e.target.value })}
                data-testid="input-promo-pertenant"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="promo-starts">Starts (optional)</Label>
              <Input
                id="promo-starts"
                type="datetime-local"
                value={form.startsAt}
                onChange={(e) => set({ startsAt: e.target.value })}
                data-testid="input-promo-starts"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="promo-expires">Expires (optional)</Label>
              <Input
                id="promo-expires"
                type="datetime-local"
                value={form.expiresAt}
                onChange={(e) => set({ expiresAt: e.target.value })}
                data-testid="input-promo-expires"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="promo-note">Internal note (optional)</Label>
              <Input
                id="promo-note"
                value={form.note}
                onChange={(e) => set({ note: e.target.value })}
                maxLength={200}
                data-testid="input-promo-note"
              />
            </div>
          </div>

          {(plans?.length ?? 0) > 0 && (
            <div className="space-y-1.5">
              <Label>Limit to plans (none selected = every plan)</Label>
              <div className="flex flex-wrap gap-2">
                {plans!.map((plan) => {
                  const selected = form.allowedPlans.includes(plan.id);
                  return (
                    <button
                      key={plan.id}
                      type="button"
                      onClick={() =>
                        set({
                          allowedPlans: selected
                            ? form.allowedPlans.filter((id) => id !== plan.id)
                            : [...form.allowedPlans, plan.id],
                        })
                      }
                      data-testid={`promo-plan-${plan.id}`}
                      className={`rounded-full border px-3 py-1 text-sm transition-colors ${
                        selected
                          ? "border-primary bg-primary/10 text-primary"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {plan.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <Button
            onClick={handleCreate}
            disabled={
              createCodes.isPending ||
              (form.mode === "single" && form.code.trim().length < 3)
            }
            data-testid="button-create-promo"
          >
            {createCodes.isPending
              ? "Creating..."
              : form.mode === "single"
                ? "Create code"
                : "Generate codes"}
          </Button>

          {lastBatch && (
            <div className="rounded-lg border bg-muted/40 p-3 text-sm">
              <div className="mb-2 flex items-center justify-between">
                <span className="font-medium">
                  Generated batch ({lastBatch.length} codes)
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    navigator.clipboard
                      .writeText(lastBatch.map((c) => c.code).join("\n"))
                      .then(() => toast({ title: "Codes copied" }))
                      .catch(() =>
                        toast({ title: "Could not copy", variant: "destructive" }),
                      );
                  }}
                  data-testid="button-copy-batch"
                >
                  Copy all
                </Button>
              </div>
              <p className="break-all font-mono text-xs text-muted-foreground">
                {lastBatch.map((c) => c.code).join(", ")}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-border shadow-sm">
        <CardHeader>
          <CardTitle>All promo codes</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : (codes?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">No promo codes yet.</p>
          ) : (
            <div className="space-y-2">
              {codes!.map((promo) => (
                <div
                  key={promo.id}
                  className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
                  data-testid={`promo-row-${promo.code}`}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono font-semibold">{promo.code}</span>
                      <Badge variant={promo.active ? "default" : "secondary"}>
                        {promo.active ? "Active" : "Inactive"}
                      </Badge>
                      {promo.campaign && (
                        <Badge variant="outline">{promo.campaign}</Badge>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {[
                        promo.captionCredits > 0 &&
                          `${promo.captionCredits} captions`,
                        promo.imageCredits > 0 && `${promo.imageCredits} images`,
                        promo.videoCredits > 0 && `${promo.videoCredits} videos`,
                      ]
                        .filter(Boolean)
                        .join(" + ")}
                      {" · "}
                      {AUDIENCE_LABELS[promo.audience]}
                      {promo.allowedPlans &&
                        ` · plans: ${promo.allowedPlans.map(planName).join(", ")}`}
                      {" · "}
                      {promo.redemptionCount}
                      {promo.maxRedemptions ? ` / ${promo.maxRedemptions}` : ""} redeemed
                      {promo.expiresAt &&
                        ` · expires ${new Date(promo.expiresAt).toLocaleDateString()}`}
                    </p>
                  </div>
                  <Button
                    variant={promo.active ? "outline" : "default"}
                    size="sm"
                    className="shrink-0"
                    disabled={updateCode.isPending || deactivateCode.isPending}
                    onClick={() => toggleActive(promo)}
                    data-testid={`button-toggle-${promo.code}`}
                  >
                    {promo.active ? "Deactivate" : "Reactivate"}
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
            <BarChart3 className="h-5 w-5 text-primary" /> Redemption metrics
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-6 text-sm">
            <div>
              <span className="text-2xl font-bold">
                {metrics?.totalRedemptions ?? 0}
              </span>{" "}
              redemptions
            </div>
            <div>
              <span className="text-2xl font-bold">
                {metrics?.totalCaptionCredits ?? 0}
              </span>{" "}
              caption credits given
            </div>
            <div>
              <span className="text-2xl font-bold">
                {metrics?.totalImageCredits ?? 0}
              </span>{" "}
              image credits given
            </div>
            <div>
              <span className="text-2xl font-bold">
                {metrics?.totalVideoCredits ?? 0}
              </span>{" "}
              video credits given
            </div>
          </div>
          {(metrics?.byCampaign.length ?? 0) > 0 && (
            <div>
              <p className="mb-1 text-sm font-medium">By campaign</p>
              <div className="space-y-1 text-sm text-muted-foreground">
                {metrics!.byCampaign.map((row) => (
                  <div key={row.campaign} className="flex justify-between">
                    <span>{row.campaign}</span>
                    <span>
                      {row.redemptions} redemptions · {row.captionCredits} captions ·{" "}
                      {row.imageCredits} images · {row.videoCredits} videos
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {(metrics?.byPlan.length ?? 0) > 0 && (
            <div>
              <p className="mb-1 text-sm font-medium">By plan at redemption</p>
              <div className="space-y-1 text-sm text-muted-foreground">
                {metrics!.byPlan.map((row) => (
                  <div key={row.plan} className="flex justify-between">
                    <span>{planName(row.plan)}</span>
                    <span>{row.redemptions} redemptions</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-border shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-primary" /> Recent failed attempts
          </CardTitle>
          <CardDescription>
            Rejected redemptions — useful for spotting expired campaigns or abuse.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {(failures?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">No failed attempts.</p>
          ) : (
            <div className="space-y-1 text-sm">
              {failures!.map((f) => (
                <div
                  key={f.id}
                  className="flex flex-wrap items-center justify-between gap-2 border-b py-1.5 last:border-b-0"
                >
                  <span className="font-mono">{f.code}</span>
                  <span className="text-muted-foreground">
                    {f.tenantEmail ?? `workspace #${f.tenantId}`}
                  </span>
                  <Badge variant="secondary">{f.reason}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {new Date(f.createdAt).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={!!confirmDeactivate}
        onOpenChange={(open) => !open && setConfirmDeactivate(null)}
        title={`Deactivate ${confirmDeactivate?.code ?? ""}?`}
        description="The code stops working immediately. You can reactivate it later; past redemptions are unaffected."
        confirmLabel="Deactivate"
        onConfirm={() => {
          const promo = confirmDeactivate;
          setConfirmDeactivate(null);
          if (!promo) return;
          deactivateCode.mutate(
            { id: promo.id },
            {
              onSuccess: () => {
                toast({ title: `Code ${promo.code} deactivated` });
                refresh();
              },
              onError: (error) =>
                toast({
                  title: "Could not deactivate",
                  description: errorMessage(error, "Please try again."),
                  variant: "destructive",
                }),
            },
          );
        }}
      />
    </div>
  );
}
