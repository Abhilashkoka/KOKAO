import { useState, useEffect } from "react";
import { RippleSpinner } from "@/components/ui/ripple-spinner";
import { GamificationPlansCard } from "./gamification-plans-card";
import {
  useListPlans,
  useAdminUpdatePlan,
  useAdminCreatePlan,
  useAdminDeletePlan,
  getListPlansQueryKey,
  getAdminGetStatsQueryKey,
  getAdminListAuditLogsQueryKey,
  useAdminGetAiSpendSettings,
  useAdminListCreditPacks,
  useAdminCreateCreditPack,
  useAdminUpdateCreditPack,
  useAdminDeleteCreditPack,
  getAdminListCreditPacksQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Plus, Trash2 } from "lucide-react";

interface PlanDraft {
  name: string;
  priceLabel: string;
  priceRupees: string;
  priceRupeesYearly: string;
  captions: string;
  images: string;
  videos: string;
  brandKits: string;
  scheduledPosts: string;
  teamSeats: string;
  features: string;
  watermark: boolean;
  billingMode: "quota" | "wallet";
}

function parseLimit(value: string): number | null {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "" ) return null;
  if (trimmed === "unlimited" || trimmed === "-1") return -1;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function limitToInput(n: number): string {
  return n === -1 ? "unlimited" : String(n);
}

const LIMIT_FIELDS: { key: keyof Pick<PlanDraft, "captions" | "images" | "videos" | "brandKits" | "scheduledPosts">; label: string }[] = [
  { key: "captions", label: "AI captions / month" },
  { key: "images", label: "AI images / month" },
  { key: "videos", label: "AI videos / month" },
  { key: "brandKits", label: "Brand kits" },
  { key: "scheduledPosts", label: "Scheduled posts" },
];

const EMPTY_NEW_PLAN: PlanDraft = {
  name: "",
  priceLabel: "",
  priceRupees: "",
  priceRupeesYearly: "",
  captions: "",
  images: "",
  videos: "",
  brandKits: "",
  scheduledPosts: "",
  teamSeats: "0",
  features: "",
  watermark: false,
  billingMode: "quota",
};
interface SpendRates {
  captionCostPaise: number;
  imageCostPaise: number;
  videoCostPaise: number;
  feePercent: number;
}

function parseRatio(text: string): [number, number, number] | null {
  const tokens = text.split(":").map((v) => v.trim());
  // Every segment must be an explicit number — Number("") coerces to 0,
  // which would silently accept junk like "4::3".
  if (tokens.length !== 3 || tokens.some((t) => !/^\d+(\.\d+)?$/.test(t))) return null;
  const parts = tokens.map(Number);
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  if (parts[0]! + parts[1]! + parts[2]! <= 0) return null;
  return [parts[0]!, parts[1]!, parts[2]!];
}

/** Split a monthly price across captions/images/videos by ratio and convert
 *  each share into a unit count using the AI spend per-unit costs (incl. the
 *  platform fee). Types with no configured cost are skipped (null). */
function suggestLimits(
  priceRupees: string,
  ratioText: string,
  rates: SpendRates | undefined,
): { captions: number | null; images: number | null; videos: number | null } | null {
  const rupees = Number(priceRupees.trim());
  const ratio = parseRatio(ratioText);
  if (!rates || !ratio || !Number.isFinite(rupees) || rupees <= 0) return null;
  const pricePaise = Math.round(rupees * 100);
  const total = ratio[0] + ratio[1] + ratio[2];
  const fee = 1 + rates.feePercent / 100;
  const unit = [
    rates.captionCostPaise * fee,
    rates.imageCostPaise * fee,
    rates.videoCostPaise * fee,
  ];
  const counts = ratio.map((w, i) => {
    if (w === 0) return 0;
    if (unit[i]! <= 0) return null;
    return Math.floor((pricePaise * w) / total / unit[i]!);
  });
  return { captions: counts[0]!, images: counts[1]!, videos: counts[2]! };
}

function LimitSuggestion({
  priceRupees,
  rates,
  ratesLoaded,
  onApply,
  testIdSuffix,
}: {
  priceRupees: string;
  rates: SpendRates | undefined;
  ratesLoaded: boolean;
  onApply: (v: { captions: number; images: number; videos: number }) => void;
  testIdSuffix: string;
}) {
  const [ratioText, setRatioText] = useState("4:3:3");
  const suggestion = suggestLimits(priceRupees, ratioText, rates);
  const noRates =
    ratesLoaded &&
    rates &&
    rates.captionCostPaise <= 0 &&
    rates.imageCostPaise <= 0 &&
    rates.videoCostPaise <= 0;
  return (
    <div className="rounded-lg border border-dashed border-border p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <label className="text-sm font-medium">Suggest limits from price</label>
        <Input
          value={ratioText}
          onChange={(e) => setRatioText(e.target.value)}
          className="h-8 w-24 text-center"
          aria-label="Caption : image : video budget ratio"
          data-testid={`input-ratio-${testIdSuffix}`}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Splits the monthly price across captions : images : videos by this
        ratio, using the per-unit costs from AI Spend settings.
      </p>
      {noRates ? (
        <p className="text-xs text-destructive">
          Set per-unit AI costs in the AI tab (AI amount spent) first.
        </p>
      ) : suggestion ? (
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm" data-testid={`text-suggestion-${testIdSuffix}`}>
            {suggestion.captions ?? "—"} captions · {suggestion.images ?? "—"}{" "}
            images · {suggestion.videos ?? "—"} videos
          </p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() =>
              onApply({
                captions: suggestion.captions ?? 0,
                images: suggestion.images ?? 0,
                videos: suggestion.videos ?? 0,
              })
            }
            data-testid={`button-apply-suggestion-${testIdSuffix}`}
          >
            Apply
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Enter a monthly price in INR above to see a suggestion.
        </p>
      )}
    </div>
  );
}

interface CreditPackDraft {
  name: string;
  priceRupees: string;
  captionCredits: string;
  imageCredits: string;
  active: boolean;
}

const EMPTY_PACK: CreditPackDraft = {
  name: "",
  priceRupees: "",
  captionCredits: "0",
  imageCredits: "0",
  active: true,
};

function CreditPacksCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: packs, isLoading } = useAdminListCreditPacks();
  const createPack = useAdminCreateCreditPack();
  const updatePack = useAdminUpdateCreditPack();
  const deletePack = useAdminDeleteCreditPack();

  const [drafts, setDrafts] = useState<Record<number, CreditPackDraft>>({});
  const [newPack, setNewPack] = useState<CreditPackDraft>(EMPTY_PACK);
  const [showNewForm, setShowNewForm] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: number; name: string } | null>(null);

  useEffect(() => {
    if (!packs) return;
    setDrafts((prev) => {
      const next = { ...prev };
      for (const p of packs) {
        if (!next[p.id]) {
          next[p.id] = {
            name: p.name,
            priceRupees: String(p.pricePaise / 100),
            captionCredits: String(p.captionCredits),
            imageCredits: String(p.imageCredits),
            active: p.active,
          };
        }
      }
      return next;
    });
  }, [packs]);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: getAdminListCreditPacksQueryKey() });
    queryClient.invalidateQueries({ queryKey: getAdminListAuditLogsQueryKey() });
  };

  const parsePack = (draft: CreditPackDraft) => {
    const price = Number(draft.priceRupees);
    const captions = Number(draft.captionCredits);
    const images = Number(draft.imageCredits);
    if (
      !draft.name.trim() ||
      !Number.isFinite(price) ||
      price <= 0 ||
      !Number.isInteger(captions) ||
      captions < 0 ||
      !Number.isInteger(images) ||
      images < 0 ||
      (captions === 0 && images === 0)
    ) {
      toast({
        variant: "destructive",
        title: "Check the fields",
        description:
          "A pack needs a name, a positive price in rupees, and at least one caption or image credit.",
      });
      return null;
    }
    return {
      name: draft.name.trim(),
      pricePaise: Math.round(price * 100),
      captionCredits: captions,
      imageCredits: images,
      active: draft.active,
    };
  };

  const onError = (err: any) =>
    toast({
      variant: "destructive",
      title: "Could not save credit pack",
      description: err?.response?.data?.error || "Please try again.",
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Credit packs</CardTitle>
        <CardDescription>
          One-time purchases that top up a workspace's caption and image
          credits. Credits are spent automatically after the monthly plan quota
          runs out, and are the only way to generate on the Pay As You Go plan.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading || !packs ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {packs.map((p) => {
              const draft = drafts[p.id];
              if (!draft) return null;
              const setField = (field: keyof CreditPackDraft, value: string | boolean) =>
                setDrafts((prev) => ({
                  ...prev,
                  [p.id]: { ...prev[p.id]!, [field]: value },
                }));
              return (
                <div key={p.id} className="rounded-xl border border-border p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <Badge variant={p.active ? "secondary" : "outline"}>
                      {p.active ? "On sale" : "Hidden"}
                    </Badge>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setDeleteTarget({ id: p.id, name: p.name })}
                      disabled={deletePack.isPending}
                      aria-label={`Delete ${p.name} pack`}
                    >
                      <Trash2 className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Name</label>
                    <Input
                      value={draft.name}
                      onChange={(e) => setField("name", e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Price (INR)</label>
                    <Input
                      value={draft.priceRupees}
                      onChange={(e) => setField("priceRupees", e.target.value)}
                      placeholder="e.g. 499"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Caption credits</label>
                      <Input
                        value={draft.captionCredits}
                        onChange={(e) => setField("captionCredits", e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Image credits</label>
                      <Input
                        value={draft.imageCredits}
                        onChange={(e) => setField("imageCredits", e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium">On sale</label>
                    <Switch
                      checked={draft.active}
                      onCheckedChange={(on) => setField("active", on)}
                      aria-label={`Toggle ${p.name} on sale`}
                    />
                  </div>
                  <Button
                    className="w-full"
                    disabled={updatePack.isPending}
                    onClick={() => {
                      const data = parsePack(draft);
                      if (!data) return;
                      updatePack.mutate(
                        { id: p.id, data },
                        {
                          onSuccess: () => {
                            refresh();
                            toast({ title: "Credit pack saved" });
                          },
                          onError,
                        },
                      );
                    }}
                  >
                    Save
                  </Button>
                </div>
              );
            })}
            <div className="rounded-xl border border-dashed border-border p-4 space-y-3">
              {!showNewForm ? (
                <button
                  type="button"
                  onClick={() => setShowNewForm(true)}
                  className="flex h-full min-h-40 w-full flex-col items-center justify-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Plus className="h-6 w-6" />
                  <span className="text-sm font-medium">Add credit pack</span>
                </button>
              ) : (
                <>
                  <Badge variant="outline">New pack</Badge>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Name</label>
                    <Input
                      value={newPack.name}
                      onChange={(e) =>
                        setNewPack((prev) => ({ ...prev, name: e.target.value }))
                      }
                      placeholder="e.g. Starter pack"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Price (INR)</label>
                    <Input
                      value={newPack.priceRupees}
                      onChange={(e) =>
                        setNewPack((prev) => ({ ...prev, priceRupees: e.target.value }))
                      }
                      placeholder="e.g. 499"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Caption credits</label>
                      <Input
                        value={newPack.captionCredits}
                        onChange={(e) =>
                          setNewPack((prev) => ({
                            ...prev,
                            captionCredits: e.target.value,
                          }))
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Image credits</label>
                      <Input
                        value={newPack.imageCredits}
                        onChange={(e) =>
                          setNewPack((prev) => ({
                            ...prev,
                            imageCredits: e.target.value,
                          }))
                        }
                      />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      className="flex-1"
                      disabled={createPack.isPending}
                      onClick={() => {
                        const data = parsePack(newPack);
                        if (!data) return;
                        createPack.mutate(
                          { data },
                          {
                            onSuccess: () => {
                              refresh();
                              setNewPack(EMPTY_PACK);
                              setShowNewForm(false);
                              toast({ title: "Credit pack created" });
                            },
                            onError,
                          },
                        );
                      }}
                    >
                      {createPack.isPending ? (
                        <>
                          <RippleSpinner className="h-4 w-4 mr-2" /> Creating...
                        </>
                      ) : (
                        "Create pack"
                      )}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setShowNewForm(false);
                        setNewPack(EMPTY_PACK);
                      }}
                      disabled={createPack.isPending}
                    >
                      Cancel
                    </Button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </CardContent>
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={deleteTarget ? `Remove "${deleteTarget.name}"?` : "Remove this pack?"}
        description="The pack disappears from the store. Credits already purchased are kept."
        confirmLabel="Remove pack"
        destructive
        onConfirm={() => {
          if (!deleteTarget) return;
          deletePack.mutate(
            { id: deleteTarget.id },
            {
              onSuccess: () => {
                refresh();
                setDrafts((prev) => {
                  const next = { ...prev };
                  delete next[deleteTarget.id];
                  return next;
                });
                toast({ title: "Credit pack removed" });
              },
              onError,
            },
          );
        }}
      />
    </Card>
  );
}
function PlansCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: plans, isLoading } = useListPlans();
  const { data: spendRates, isFetched: spendRatesLoaded } =
    useAdminGetAiSpendSettings();
  const updatePlan = useAdminUpdatePlan();
  const createPlan = useAdminCreatePlan();
  const deletePlan = useAdminDeletePlan();

  const [drafts, setDrafts] = useState<Record<string, PlanDraft>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newPlan, setNewPlan] = useState<PlanDraft>(EMPTY_NEW_PLAN);

  const invalidatePlanQueries = () => {
    queryClient.invalidateQueries({ queryKey: getListPlansQueryKey() });
    queryClient.invalidateQueries({
      queryKey: getAdminListAuditLogsQueryKey(),
    });
    queryClient.invalidateQueries({ queryKey: getAdminGetStatsQueryKey() });
  };

  const parseDraft = (draft: PlanDraft) => {
    const limits = {
      captions: parseLimit(draft.captions),
      images: parseLimit(draft.images),
      videos: parseLimit(draft.videos),
      brandKits: parseLimit(draft.brandKits),
      scheduledPosts: parseLimit(draft.scheduledPosts),
    };
    const teamSeatsTrimmed = draft.teamSeats.trim();
    const teamSeats = teamSeatsTrimmed === "" ? 0 : Number(teamSeatsTrimmed);
    const priceRupeesTrimmed = draft.priceRupees.trim();
    const priceRupees = priceRupeesTrimmed === "" ? null : Number(priceRupeesTrimmed);
    const yearlyTrimmed = draft.priceRupeesYearly.trim();
    const priceRupeesYearly = yearlyTrimmed === "" ? null : Number(yearlyTrimmed);
    if (
      !draft.name.trim() ||
      !draft.priceLabel.trim() ||
      Object.values(limits).some((v) => v === null) ||
      !Number.isInteger(teamSeats) ||
      teamSeats < 0 ||
      (priceRupees !== null && (!Number.isFinite(priceRupees) || priceRupees <= 0)) ||
      (priceRupeesYearly !== null &&
        (!Number.isFinite(priceRupeesYearly) || priceRupeesYearly <= 0))
    ) {
      toast({
        variant: "destructive",
        title: "Check the fields",
        description:
          'Limits must be whole numbers, or "unlimited". Team seats must be 0 or more. Name and price are required. The chargeable price must be a positive number (or blank for not sold online).',
      });
      return null;
    }
    if (priceRupeesYearly !== null && priceRupees === null) {
      toast({
        variant: "destructive",
        title: "Check the fields",
        description: "Set a monthly price before adding a yearly price.",
      });
      return null;
    }
    return {
      name: draft.name.trim(),
      priceLabel: draft.priceLabel.trim(),
      priceInr: priceRupees === null ? null : Math.round(priceRupees * 100),
      priceInrYearly:
        priceRupeesYearly === null ? null : Math.round(priceRupeesYearly * 100),
      teamSeats,
      watermark: draft.watermark,
      billingMode: draft.billingMode,
      limits: {
        captions: limits.captions!,
        images: limits.images!,
        videos: limits.videos!,
        brandKits: limits.brandKits!,
        scheduledPosts: limits.scheduledPosts!,
      },
      features: draft.features
        .split("\n")
        .map((f) => f.trim())
        .filter(Boolean)
        .slice(0, 12),
    };
  };

  const handleCreate = () => {
    const data = parseDraft(newPlan);
    if (!data) return;
    createPlan.mutate(
      { data },
      {
        onSuccess: () => {
          invalidatePlanQueries();
          setNewPlan(EMPTY_NEW_PLAN);
          setShowNewForm(false);
          toast({
            title: "Plan created",
            description: "The new plan is now available to assign.",
          });
        },
        onError: (err: any) => {
          toast({
            variant: "destructive",
            title: "Could not create plan",
            description: err?.response?.data?.error || "Please try again.",
          });
        },
      },
    );
  };

  const handleDelete = (planId: string) => {
    deletePlan.mutate(
      { planId },
      {
        onSuccess: () => {
          invalidatePlanQueries();
          setDrafts((prev) => {
            const next = { ...prev };
            delete next[planId];
            return next;
          });
          toast({ title: "Plan deleted" });
        },
        onError: (err: any) => {
          toast({
            variant: "destructive",
            title: "Could not delete plan",
            description: err?.response?.data?.error || "Please try again.",
          });
        },
      },
    );
  };

  useEffect(() => {
    if (!plans) return;
    setDrafts((prev) => {
      const next = { ...prev };
      for (const p of plans) {
        if (!next[p.id]) {
          next[p.id] = {
            name: p.name,
            priceLabel: p.priceLabel,
            priceRupees:
              typeof p.priceInr === "number" && p.priceInr > 0
                ? String(p.priceInr / 100)
                : "",
            priceRupeesYearly:
              typeof p.priceInrYearly === "number" && p.priceInrYearly > 0
                ? String(p.priceInrYearly / 100)
                : "",
            captions: limitToInput(p.limits.captions),
            images: limitToInput(p.limits.images),
            videos: limitToInput(p.limits.videos ?? 0),
            brandKits: limitToInput(p.limits.brandKits),
            scheduledPosts: limitToInput(p.limits.scheduledPosts),
            teamSeats: String(p.teamSeats ?? 0),
            features: p.features.join("\n"),
            watermark: p.watermark ?? false,
            billingMode: p.billingMode === "wallet" ? "wallet" : "quota",
          };
        }
      }
      return next;
    });
  }, [plans]);

  const setField = (planId: string, field: keyof PlanDraft, value: string) => {
    setDrafts((prev) => ({
      ...prev,
      [planId]: { ...prev[planId]!, [field]: value },
    }));
  };

  const handleSave = (planId: string) => {
    const draft = drafts[planId];
    if (!draft) return;

    const data = parseDraft(draft);
    if (!data) return;

    setSavingId(planId);
    updatePlan.mutate(
      { planId, data },
      {
        onSuccess: () => {
          invalidatePlanQueries();
          toast({
            title: "Plan saved",
            description:
              "New limits apply to everyone on this plan within about 30 seconds.",
          });
          setSavingId(null);
        },
        onError: (err: any) => {
          toast({
            variant: "destructive",
            title: "Could not save plan",
            description: err?.response?.data?.error || "Please try again.",
          });
          setSavingId(null);
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Subscription plans</CardTitle>
        <CardDescription>
          Edit the monthly quotas, display price, and feature list of each plan.
          Changes apply to every workspace on that plan. Type "unlimited" (or
          -1) for no limit. The price shown here is a label only — it does not
          charge anyone.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading || !plans ? (
          <div className="space-y-3">
            <Skeleton className="h-40 w-full" />
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {plans.map((p) => {
              const draft = drafts[p.id];
              if (!draft) return null;
              return (
                <div
                  key={p.id}
                  className="rounded-xl border border-border p-4 space-y-4"
                >
                  <div className="flex items-center justify-between">
                    <Badge variant="secondary" className="uppercase">
                      {p.id}
                    </Badge>
                    {p.id !== "free" && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setDeleteTarget({ id: p.id, name: p.name })}
                        disabled={deletePlan.isPending}
                        aria-label={`Delete ${p.name} plan`}
                        title="Delete this plan"
                      >
                        <Trash2 className="h-4 w-4 text-muted-foreground" />
                      </Button>
                    )}
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Plan name</label>
                    <Input
                      value={draft.name}
                      onChange={(e) => setField(p.id, "name", e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">
                      Price label (display only)
                    </label>
                    <Input
                      value={draft.priceLabel}
                      onChange={(e) =>
                        setField(p.id, "priceLabel", e.target.value)
                      }
                      placeholder="$29 / mo"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">
                      Monthly price in INR (chargeable)
                    </label>
                    <Input
                      value={draft.priceRupees}
                      onChange={(e) =>
                        setField(p.id, "priceRupees", e.target.value)
                      }
                      placeholder="e.g. 999 — blank = not sold online"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">
                      Yearly price in INR (chargeable, total for 12 months)
                    </label>
                    <Input
                      value={draft.priceRupeesYearly}
                      onChange={(e) =>
                        setField(p.id, "priceRupeesYearly", e.target.value)
                      }
                      placeholder="e.g. 9990 — blank = no yearly option"
                    />
                  </div>
                  <LimitSuggestion
                    priceRupees={draft.priceRupees}
                    rates={spendRates}
                    ratesLoaded={spendRatesLoaded}
                    testIdSuffix={p.id}
                    onApply={(v) =>
                      setDrafts((prev) => ({
                        ...prev,
                        [p.id]: {
                          ...prev[p.id]!,
                          captions: limitToInput(v.captions),
                          images: limitToInput(v.images),
                          videos: limitToInput(v.videos),
                        },
                      }))
                    }
                  />
                  {LIMIT_FIELDS.map((f) => (
                    <div key={f.key} className="space-y-2">
                      <label className="text-sm font-medium">{f.label}</label>
                      <Input
                        value={draft[f.key]}
                        onChange={(e) => setField(p.id, f.key, e.target.value)}
                        placeholder='e.g. 100 or "unlimited"'
                      />
                    </div>
                  ))}
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5 pr-3">
                      <label className="text-sm font-medium">
                        KOKAO watermark
                      </label>
                      <p className="text-xs text-muted-foreground">
                        Stamp "Made with KOKAO.in" on AI images and videos.
                      </p>
                    </div>
                    <Switch
                      checked={draft.watermark}
                      onCheckedChange={(on) =>
                        setDrafts((prev) => ({
                          ...prev,
                          [p.id]: { ...prev[p.id]!, watermark: on },
                        }))
                      }
                      aria-label="Toggle KOKAO watermark"
                      data-testid={`switch-watermark-${p.id}`}
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5 pr-3">
                      <label className="text-sm font-medium">
                        Wallet billing
                      </label>
                      <p className="text-xs text-muted-foreground">
                        Workspaces landing on this plan pay per generation from
                        a prepaid wallet instead of monthly quotas + credits. A
                        manual choice on the Tenants tab still wins.
                      </p>
                    </div>
                    <Switch
                      checked={draft.billingMode === "wallet"}
                      onCheckedChange={(on) =>
                        setDrafts((prev) => ({
                          ...prev,
                          [p.id]: {
                            ...prev[p.id]!,
                            billingMode: on ? "wallet" : "quota",
                          },
                        }))
                      }
                      aria-label="Toggle wallet billing"
                      data-testid={`switch-wallet-billing-${p.id}`}
                    />
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-sm font-medium">
                        Team members add-on
                      </label>
                      <Switch
                        checked={Number(draft.teamSeats) > 0}
                        onCheckedChange={(on) =>
                          setField(p.id, "teamSeats", on ? "5" : "0")
                        }
                        aria-label="Toggle team members add-on"
                      />
                    </div>
                    {Number(draft.teamSeats) > 0 && (
                      <div className="space-y-1">
                        <label className="text-xs text-muted-foreground">
                          Seats included
                        </label>
                        <Input
                          value={draft.teamSeats}
                          onChange={(e) =>
                            setField(p.id, "teamSeats", e.target.value)
                          }
                          placeholder="e.g. 5"
                        />
                      </div>
                    )}
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">
                      Features (one per line)
                    </label>
                    <Textarea
                      rows={5}
                      value={draft.features}
                      onChange={(e) =>
                        setField(p.id, "features", e.target.value)
                      }
                    />
                  </div>
                  <Button
                    onClick={() => handleSave(p.id)}
                    disabled={updatePlan.isPending}
                    className="w-full"
                  >
                    {savingId === p.id && updatePlan.isPending ? (
                      <>
                        <RippleSpinner className="h-4 w-4 mr-2" />{" "}
                        Saving...
                      </>
                    ) : (
                      `Save ${draft.name || p.name}`
                    )}
                  </Button>
                </div>
              );
            })}

            <div className="rounded-xl border border-dashed border-border p-4 space-y-4">
              {!showNewForm ? (
                <button
                  type="button"
                  onClick={() => setShowNewForm(true)}
                  className="flex h-full min-h-40 w-full flex-col items-center justify-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Plus className="h-6 w-6" />
                  <span className="text-sm font-medium">Add plan</span>
                </button>
              ) : (
                <>
                  <Badge variant="outline">New plan</Badge>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Plan name</label>
                    <Input
                      value={newPlan.name}
                      onChange={(e) =>
                        setNewPlan((prev) => ({ ...prev, name: e.target.value }))
                      }
                      placeholder="e.g. Agency"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">
                      Price label (display only)
                    </label>
                    <Input
                      value={newPlan.priceLabel}
                      onChange={(e) =>
                        setNewPlan((prev) => ({
                          ...prev,
                          priceLabel: e.target.value,
                        }))
                      }
                      placeholder="$199 / mo"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">
                      Monthly price in INR (chargeable)
                    </label>
                    <Input
                      value={newPlan.priceRupees}
                      onChange={(e) =>
                        setNewPlan((prev) => ({
                          ...prev,
                          priceRupees: e.target.value,
                        }))
                      }
                      placeholder="e.g. 999 — blank = not sold online"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">
                      Yearly price in INR (chargeable, total for 12 months)
                    </label>
                    <Input
                      value={newPlan.priceRupeesYearly}
                      onChange={(e) =>
                        setNewPlan((prev) => ({
                          ...prev,
                          priceRupeesYearly: e.target.value,
                        }))
                      }
                      placeholder="e.g. 9990 — blank = no yearly option"
                    />
                  </div>
                  <LimitSuggestion
                    priceRupees={newPlan.priceRupees}
                    rates={spendRates}
                    ratesLoaded={spendRatesLoaded}
                    testIdSuffix="new"
                    onApply={(v) =>
                      setNewPlan((prev) => ({
                        ...prev,
                        captions: limitToInput(v.captions),
                        images: limitToInput(v.images),
                        videos: limitToInput(v.videos),
                      }))
                    }
                  />
                  {LIMIT_FIELDS.map((f) => (
                    <div key={f.key} className="space-y-2">
                      <label className="text-sm font-medium">{f.label}</label>
                      <Input
                        value={newPlan[f.key]}
                        onChange={(e) =>
                          setNewPlan((prev) => ({
                            ...prev,
                            [f.key]: e.target.value,
                          }))
                        }
                        placeholder='e.g. 100 or "unlimited"'
                      />
                    </div>
                  ))}
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5 pr-3">
                      <label className="text-sm font-medium">
                        KOKAO watermark
                      </label>
                      <p className="text-xs text-muted-foreground">
                        Stamp "Made with KOKAO.in" on AI images and videos.
                      </p>
                    </div>
                    <Switch
                      checked={newPlan.watermark}
                      onCheckedChange={(on) =>
                        setNewPlan((prev) => ({ ...prev, watermark: on }))
                      }
                      aria-label="Toggle KOKAO watermark"
                      data-testid="switch-watermark-new"
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5 pr-3">
                      <label className="text-sm font-medium">
                        Wallet billing
                      </label>
                      <p className="text-xs text-muted-foreground">
                        Workspaces landing on this plan pay per generation from
                        a prepaid wallet instead of monthly quotas + credits.
                      </p>
                    </div>
                    <Switch
                      checked={newPlan.billingMode === "wallet"}
                      onCheckedChange={(on) =>
                        setNewPlan((prev) => ({
                          ...prev,
                          billingMode: on ? "wallet" : "quota",
                        }))
                      }
                      aria-label="Toggle wallet billing"
                      data-testid="switch-wallet-billing-new"
                    />
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-sm font-medium">
                        Team members add-on
                      </label>
                      <Switch
                        checked={Number(newPlan.teamSeats) > 0}
                        onCheckedChange={(on) =>
                          setNewPlan((prev) => ({
                            ...prev,
                            teamSeats: on ? "5" : "0",
                          }))
                        }
                        aria-label="Toggle team members add-on"
                      />
                    </div>
                    {Number(newPlan.teamSeats) > 0 && (
                      <div className="space-y-1">
                        <label className="text-xs text-muted-foreground">
                          Seats included
                        </label>
                        <Input
                          value={newPlan.teamSeats}
                          onChange={(e) =>
                            setNewPlan((prev) => ({
                              ...prev,
                              teamSeats: e.target.value,
                            }))
                          }
                          placeholder="e.g. 5"
                        />
                      </div>
                    )}
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">
                      Features (one per line)
                    </label>
                    <Textarea
                      rows={5}
                      value={newPlan.features}
                      onChange={(e) =>
                        setNewPlan((prev) => ({
                          ...prev,
                          features: e.target.value,
                        }))
                      }
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button
                      onClick={handleCreate}
                      disabled={createPlan.isPending}
                      className="flex-1"
                    >
                      {createPlan.isPending ? (
                        <>
                          <RippleSpinner className="h-4 w-4 mr-2" />{" "}
                          Creating...
                        </>
                      ) : (
                        "Create plan"
                      )}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setShowNewForm(false);
                        setNewPlan(EMPTY_NEW_PLAN);
                      }}
                      disabled={createPlan.isPending}
                    >
                      Cancel
                    </Button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </CardContent>
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={deleteTarget ? `Delete the "${deleteTarget.name}" plan?` : "Delete this plan?"}
        description="This cannot be undone. Plans still assigned to workspaces cannot be deleted."
        confirmLabel="Delete plan"
        destructive
        onConfirm={() => {
          if (deleteTarget) handleDelete(deleteTarget.id);
        }}
      />
    </Card>
  );
}

export function PlansTab() {
  return (
    <div className="space-y-8">
      <PlansCard />
      <CreditPacksCard />
      <GamificationPlansCard />
    </div>
  );
}
