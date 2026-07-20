import { useEffect, useMemo, useState } from "react";
import {
  useGetMe,
  useGetAdsStatus,
  useListAdConnections,
  useDeleteAdConnection,
  useGetAdsMetaAuthUrl,
  getGetAdsMetaAuthUrlQueryKey,
  useGetAdsLinkedinAuthUrl,
  getGetAdsLinkedinAuthUrlQueryKey,
  useConnectMetaAdsFromFacebook,
  useListMetaAdAccountChoices,
  useSelectMetaAdAccount,
  useListLinkedinAdAccountChoices,
  useSelectLinkedinAdAccount,
  useListLinkedinCampaignGroups,
  getListLinkedinCampaignGroupsQueryKey,
  useGetAdsTiktokAuthUrl,
  getGetAdsTiktokAuthUrlQueryKey,
  useListTiktokAdvertiserChoices,
  useSelectTiktokAdvertiser,
  useGetAdsGoogleAuthUrl,
  getGetAdsGoogleAuthUrlQueryKey,
  useListGoogleAdCustomerChoices,
  useSelectGoogleAdAccount,
  useSearchLinkedinTargeting,
  getSearchLinkedinTargetingQueryKey,
  useGetLinkedinCampaignTargeting,
  getGetLinkedinCampaignTargetingQueryKey,
  useListContent,
  useListAdCampaigns,
  useGetAdCampaignDetail,
  useListAdDrafts,
  useCreateAdDraft,
  useApproveAdDraft,
  useRejectAdDraft,
  useListAdsChangeLog,
  useGetAdsBudgetCaps,
  useUpdateAdsBudgetCaps,
  getGetAdsBudgetCapsQueryKey,
  getListAdConnectionsQueryKey,
  getListNotificationsQueryKey,
  getListAdDraftsQueryKey,
  getListAdsChangeLogQueryKey,
  type AdsDraft,
  type AdAccountConnection,
  type AdsTargetingLocation,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { navigate } from "wouter/use-browser-location";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import {
  Megaphone,
  Loader2,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  ImagePlus,
  MapPin,
  Pencil,
  Plus,
  ShieldCheck,
  X,
  TrendingUp,
  Wallet,
  CalendarIcon,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import {
  MetaIcon,
  GoogleIcon,
  TiktokIcon,
  LinkedinIcon,
} from "@/components/brand-icons";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { format } from "date-fns";

/**
 * Date+time picker for draft schedule fields. Holds an ISO-8601 string with a
 * numeric UTC offset (e.g. "2026-08-01T00:00:00+0530") — the format the ad
 * platforms accept — or "" meaning "no change / not set". Prefills from any
 * parseable ISO value the server returns (including "+0000" offsets).
 */
function DateTimeField({
  label,
  value,
  onChange,
  testId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  testId: string;
}) {
  const parsed = value ? new Date(value) : null;
  const selected = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
  const emit = (d: Date) => onChange(format(d, "yyyy-MM-dd'T'HH:mm:ssxx"));
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="flex gap-2">
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              className="flex-1 justify-start font-normal"
              data-testid={testId}
            >
              <CalendarIcon className="h-4 w-4 mr-2" />
              {selected ? format(selected, "d MMM yyyy") : "Pick a date"}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar
              mode="single"
              selected={selected ?? undefined}
              onSelect={(d) => {
                if (!d) return;
                const next = new Date(d);
                next.setHours(
                  selected?.getHours() ?? 0,
                  selected?.getMinutes() ?? 0,
                  0,
                  0,
                );
                emit(next);
              }}
            />
          </PopoverContent>
        </Popover>
        <Input
          type="time"
          className="w-28"
          value={selected ? format(selected, "HH:mm") : ""}
          disabled={!selected}
          onChange={(e) => {
            if (!selected || !e.target.value) return;
            const [h, m] = e.target.value.split(":").map(Number);
            const next = new Date(selected);
            next.setHours(h, m, 0, 0);
            emit(next);
          }}
          data-testid={`${testId}-time`}
        />
        {selected && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onChange("")}
            aria-label={`Clear ${label}`}
            data-testid={`${testId}-clear`}
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Budget diff fields produced by the server ("Daily budget (minor units)" /
 * "Lifetime budget (minor units)"). A change counts as a LARGE increase when
 * the new budget is at least 2x the current one.
 */
const LARGE_INCREASE_FACTOR = 2;

/**
 * When a campaigns/detail fetch fails because the platform revoked our access,
 * the server marks the connection failed and flags the error payload with
 * `authLost`. Refetch the connections list so the "Access lost" reconnect
 * prompt appears immediately, without a manual page reload.
 */
export function useRefreshConnectionsOnAuthLoss(error: unknown) {
  const queryClient = useQueryClient();
  const err = error as
    | { data?: { authLost?: boolean } | null; payload?: { authLost?: boolean } | null }
    | null;
  const authLost = Boolean(err?.data?.authLost ?? err?.payload?.authLost);
  useEffect(() => {
    if (authLost) {
      queryClient.invalidateQueries({ queryKey: getListAdConnectionsQueryKey() });
    }
  }, [authLost, queryClient]);
}

/**
 * TikTok platform budget minimums in MAJOR currency units (the draft dialog
 * inputs work in major units). Mirrors the server-side backstop in
 * routes/ads.ts: campaigns need >= 50, ad groups >= 20.
 */
export const TIKTOK_MIN_CAMPAIGN_BUDGET = 50;
export const TIKTOK_MIN_ADGROUP_BUDGET = 20;

export interface BudgetIncrease {
  field: string;
  before: number;
  after: number;
  factor: number;
}

export function findLargeBudgetIncreases(
  changes: { field: string; before?: string | null; after?: string | null }[],
): BudgetIncrease[] {
  const out: BudgetIncrease[] = [];
  for (const c of changes) {
    if (!c.field.toLowerCase().includes("budget")) continue;
    const before = c.before != null ? Number(c.before) : NaN;
    const after = c.after != null ? Number(c.after) : NaN;
    if (!Number.isFinite(before) || !Number.isFinite(after) || before <= 0) continue;
    if (after >= before * LARGE_INCREASE_FACTOR) {
      out.push({ field: c.field, before, after, factor: after / before });
    }
  }
  return out;
}

const DATE_PRESETS = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "last_7d", label: "Last 7 days" },
  { value: "last_14d", label: "Last 14 days" },
  { value: "last_30d", label: "Last 30 days" },
  { value: "last_90d", label: "Last 90 days" },
  { value: "maximum", label: "All time" },
] as const;

function formatMoneyMinor(minor: number | null | undefined, currency: string | null) {
  if (minor == null) return "—";
  const major = minor / 100;
  return `${currency ? `${currency} ` : ""}${major.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

/** Convert a minor-units amount string (e.g. "1050") to a major-units input string ("10.5"). */
function minorStrToMajorStr(v: string): string {
  if (!v.trim()) return "";
  const n = Number(v);
  return Number.isFinite(n) ? String(n / 100) : "";
}

const BID_STRATEGY_LABELS: Record<string, string> = {
  LOWEST_COST_WITHOUT_CAP: "Lowest cost",
  LOWEST_COST_WITH_BID_CAP: "Bid cap",
  COST_CAP: "Cost cap",
};

/** Render a Meta ad set's current bid, e.g. "Cost cap · USD 2.50". */
function formatBid(
  strategy: string | null | undefined,
  amountMinor: number | null | undefined,
  currency: string | null,
) {
  if (!strategy && amountMinor == null) return "—";
  const label = strategy ? (BID_STRATEGY_LABELS[strategy] ?? strategy) : null;
  const amount = amountMinor != null ? formatMoneyMinor(amountMinor, currency) : null;
  if (label && amount) return `${label} · ${amount}`;
  return label ?? amount ?? "—";
}

function formatSpend(spend: number, currency: string | null) {
  return `${currency ? `${currency} ` : ""}${spend.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function formatScheduleDate(iso: string | null | undefined) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatScheduleRange(
  startIso: string | null | undefined,
  stopIso: string | null | undefined,
) {
  const start = formatScheduleDate(startIso);
  const stop = formatScheduleDate(stopIso);
  if (start === "—" && stop === "—") return "Runs continuously";
  if (stop === "—") return `${start} – no end date`;
  return `${start} – ${stop}`;
}

function statusBadge(status: string) {
  const s = status.toUpperCase();
  if (s === "ACTIVE") return <Badge data-testid={`badge-status-${status}`}>Active</Badge>;
  if (s === "PAUSED") {
    return (
      <Badge variant="secondary" data-testid={`badge-status-${status}`}>
        Paused
      </Badge>
    );
  }
  return (
    <Badge variant="outline" data-testid={`badge-status-${status}`}>
      {status}
    </Badge>
  );
}

// LinkedIn creatives that are still in review (or were rejected) can't accept
// status changes — surface the review state and block pointless drafts.
function linkedinReviewBlocksStatusChange(reviewStatus: string | null | undefined) {
  if (!reviewStatus) return false;
  return reviewStatus.toUpperCase() !== "APPROVED";
}

function reviewStatusBadge(reviewStatus: string | null | undefined, adId: string) {
  if (!reviewStatus) return null;
  const s = reviewStatus.toUpperCase();
  if (s === "APPROVED") return null;
  return (
    <Badge
      variant={s === "REJECTED" ? "destructive" : "outline"}
      data-testid={`badge-review-${adId}`}
    >
      {s === "PENDING"
        ? "In review"
        : s === "REJECTED"
          ? "Rejected"
          : `Review: ${reviewStatus}`}
    </Badge>
  );
}

function draftStatusBadge(status: string) {
  switch (status) {
    case "draft":
      return <Badge variant="secondary">Awaiting approval</Badge>;
    case "applied":
      return <Badge>Applied</Badge>;
    case "failed":
      return <Badge variant="destructive">Failed</Badge>;
    case "rejected":
      return <Badge variant="outline">Rejected</Badge>;
    case "expired":
      return <Badge variant="outline">Expired</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

interface DraftFormState {
  action: "create" | "update";
  targetType: string;
  targetId: string | null;
  currentName: string;
  name: string;
  status: string;
  dailyBudget: string;
  lifetimeBudget: string;
  startTime: string;
  stopTime: string;
  objective: string;
  bidAmount: string;
  bidStrategy: string;
}

const EMPTY_FORM: DraftFormState = {
  action: "create",
  targetType: "campaign",
  targetId: null,
  currentName: "",
  name: "",
  status: "",
  dailyBudget: "",
  lifetimeBudget: "",
  startTime: "",
  stopTime: "",
  objective: "OUTCOME_TRAFFIC",
  bidAmount: "",
  bidStrategy: "",
};

export function AdsPage() {
  const { toast } = useToast();
  const { data: me } = useGetMe();
  const { data: status, isLoading: statusLoading } = useGetAdsStatus();
  const { data: connections, isLoading: connectionsLoading } = useListAdConnections();
  const [pickedConnId, setPickedConnId] = useState<number | null>(null);

  const isOwner = !me?.team || me.team.role === "owner";
  const canManage = isOwner || me?.team?.role === "admin";

  const metaConn = connections?.find((c) => c.platform === "meta");
  const linkedinConn = connections?.find((c) => c.platform === "linkedin");
  const googleConn = connections?.find((c) => c.platform === "google");
  const tiktokConn = connections?.find((c) => c.platform === "tiktok");
  const connectedConns = (connections ?? []).filter((c) => c.status === "connected");
  const [activeConnId, setActiveConnId] = useState<number | null>(null);
  const connectedConn =
    connectedConns.find((c) => c.id === (activeConnId ?? pickedConnId)) ?? connectedConns[0];

  // Surface the OAuth redirect outcome once, then clean the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const google = params.get("google");
    const meta = params.get("meta");
    const linkedin = params.get("linkedin");
    if (!google && !meta && !linkedin) return;
    if (google === "connected" || meta === "connected" || linkedin === "connected") {
      toast({
        title: `${google ? "Google" : meta ? "Meta" : "LinkedIn"} Ads access granted`,
        description: "Now pick which ad account this workspace manages.",
      });
    } else if (google === "error" || meta === "error" || linkedin === "error") {
      const reason = params.get("reason");
      toast({
        variant: "destructive",
        title: `Could not connect ${google ? "Google" : meta ? "Meta" : "LinkedIn"} Ads`,
        description:
          reason === "no_refresh_token"
            ? "Google did not grant offline access. Remove the app's access in your Google account settings, then try connecting again."
            : reason ?? undefined,
      });
    }
    window.history.replaceState({}, "", window.location.pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (statusLoading || connectionsLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (status && !status.enabled) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <Megaphone className="h-12 w-12 text-muted-foreground mb-4" />
        <h1 className="text-2xl font-bold">Ads are turned off</h1>
        <p className="text-muted-foreground mt-2 max-w-md">
          Paid media features are currently turned off by the platform
          administrator.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-extrabold tracking-tight">Ads</h1>
        <p className="text-muted-foreground text-lg mt-1">
          Manage your paid campaigns. Every change is drafted first and only
          applied after the workspace owner approves it.
        </p>
      </div>

      <div className="space-y-4">
        <ConnectionSection
          metaConn={metaConn}
          metaAvailable={status?.platforms.find((p) => p.platform === "meta")?.available ?? false}
          googleConn={googleConn}
          googleAvailable={
            status?.platforms.find((p) => p.platform === "google")?.available ?? false
          }
          canManage={canManage}
        />
        <TiktokConnectionSection
          tiktokConn={tiktokConn}
          tiktokAvailable={
            status?.platforms.find((p) => p.platform === "tiktok")?.available ?? false
          }
          canManage={canManage}
        />
        <LinkedinConnectionSection
          linkedinConn={linkedinConn}
          available={
            status?.platforms.find((p) => p.platform === "linkedin")?.available ?? false
          }
          canManage={canManage}
        />
      </div>

      {connectedConns.length > 1 && connectedConn && (
        <div className="flex items-center gap-3">
          <Label>Viewing</Label>
          <Select
            value={String(connectedConn.id)}
            onValueChange={(v) => {
              setActiveConnId(Number(v));
              setPickedConnId(Number(v));
            }}
          >
            <SelectTrigger className="w-72" data-testid="select-active-connection">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {connectedConns.map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>
                  {c.platform === "google"
                    ? "Google Ads"
                    : c.platform === "meta"
                      ? "Meta Ads"
                      : c.platform === "tiktok"
                        ? "TikTok Ads"
                        : "LinkedIn Ads"}{" "}
                  — {c.adAccountName || c.adAccountId}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {connectedConn && <BudgetCapsCard isOwner={isOwner} currency={connectedConn.currency ?? null} />}

      {connectedConn && (
        <Tabs defaultValue="campaigns">
          <TabsList>
            <TabsTrigger value="campaigns" data-testid="tab-campaigns">
              Campaigns
            </TabsTrigger>
            <TabsTrigger value="approvals" data-testid="tab-approvals">
              Approvals
            </TabsTrigger>
            <TabsTrigger value="history" data-testid="tab-history">
              Change history
            </TabsTrigger>
          </TabsList>
          <TabsContent value="campaigns" className="mt-6">
            <CampaignsSection connection={connectedConn} canManage={canManage} />
          </TabsContent>
          <TabsContent value="approvals" className="mt-6">
            <DraftsSection
              isOwner={isOwner}
              canManage={canManage}
              currency={connectedConn.currency ?? null}
            />
          </TabsContent>
          <TabsContent value="history" className="mt-6">
            <ChangeLogSection />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

const PLATFORM_SETUP_INFO: Record<
  "meta" | "google" | "tiktok" | "linkedin",
  { label: string; credentialName: string; steps: string[] }
> = {
  meta: {
    label: "Meta Ads",
    credentialName: "Meta app credentials (App ID and App Secret)",
    steps: [
      "The platform administrator creates a Meta app at developers.facebook.com with the Marketing API product enabled.",
      "The administrator enters the App ID and App Secret in Admin settings under Platform credentials.",
      "Once saved, everyone returns to this page and connects their Meta ad account with the Connect button.",
    ],
  },
  google: {
    label: "Google Ads",
    credentialName: "Google Ads credentials (OAuth client and developer token)",
    steps: [
      "The platform administrator creates a Google Cloud OAuth application with the Google Ads API enabled.",
      "The administrator requests a Google Ads API developer token from their Google Ads manager account.",
      "The administrator enters the client ID, client secret, and developer token in Admin settings under Platform credentials.",
      "Once saved, everyone returns to this page and connects their Google Ads account with the Connect button.",
    ],
  },
  tiktok: {
    label: "TikTok Ads",
    credentialName: "TikTok app credentials (App ID and Secret)",
    steps: [
      "The platform administrator creates a developer app at business-api.tiktok.com with the Ads Management scope.",
      "The administrator enters the App ID and Secret in Admin settings under Platform credentials.",
      "Once saved, everyone returns to this page and connects their TikTok advertiser account with the Connect button.",
    ],
  },
  linkedin: {
    label: "LinkedIn Ads",
    credentialName: "LinkedIn app credentials (Client ID and Client Secret)",
    steps: [
      "The platform administrator creates a LinkedIn app at developer.linkedin.com with the Advertising API product.",
      "The administrator enters the Client ID and Client Secret in Admin settings under Platform credentials.",
      "Once saved, everyone returns to this page and connects their LinkedIn ad account with the Connect button.",
    ],
  },
};

function PlatformUnavailableNotice({
  platform,
}: {
  platform: "meta" | "google" | "tiktok" | "linkedin";
}) {
  const { data: me } = useGetMe();
  const [open, setOpen] = useState(false);
  const info = PLATFORM_SETUP_INFO[platform];

  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        {info.label} is not yet available. The platform administrator has not
        configured {info.credentialName.split(" (")[0].toLowerCase()} yet.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setOpen(true)}
          data-testid={`button-setup-steps-${platform}`}
        >
          How to enable
        </Button>
        {me?.isSuperadmin && (
          <Button
            size="sm"
            onClick={() => navigate("/admin?tab=credentials")}
            data-testid={`button-open-admin-credentials-${platform}`}
          >
            Configure now
          </Button>
        )}
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-testid={`dialog-setup-steps-${platform}`}>
          <DialogHeader>
            <DialogTitle>Enable {info.label}</DialogTitle>
            <DialogDescription>
              {info.label} needs a one-time platform setup: {info.credentialName}.
            </DialogDescription>
          </DialogHeader>
          <ol className="list-decimal pl-5 space-y-2 text-sm">
            {info.steps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
          {me?.isSuperadmin ? (
            <Button
              onClick={() => navigate("/admin?tab=credentials")}
              data-testid={`button-dialog-admin-credentials-${platform}`}
            >
              Open platform credentials
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">
              Only the platform administrator can add these credentials. Reach
              out to them with the steps above.
            </p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ConnectionSection({
  metaConn,
  metaAvailable,
  googleConn,
  googleAvailable,
  canManage,
}: {
  metaConn: AdAccountConnection | undefined;
  metaAvailable: boolean;
  googleConn: AdAccountConnection | undefined;
  googleAvailable: boolean;
  canManage: boolean;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const authUrl = useGetAdsMetaAuthUrl({
    query: { enabled: false, queryKey: getGetAdsMetaAuthUrlQueryKey() },
  });
  const fromFacebook = useConnectMetaAdsFromFacebook();
  const disconnect = useDeleteAdConnection();

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListAdConnectionsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetAdsBudgetCapsQueryKey() });
  };

  const startOAuth = async () => {
    const res = await authUrl.refetch();
    if (res.data?.url) {
      window.location.href = res.data.url;
    } else {
      toast({
        variant: "destructive",
        title: "Meta Ads sign-in unavailable",
        description:
          (res.error as { payload?: { error?: string } } | null)?.payload?.error ??
          "Could not start the Meta Ads sign-in. Try again later.",
      });
    }
  };

  const tryFromFacebook = () => {
    fromFacebook.mutate(undefined, {
      onSuccess: () => {
        invalidate();
        toast({
          title: "Facebook access works for ads",
          description: "Now pick which ad account this workspace manages.",
        });
      },
      onError: (err) => {
        toast({
          variant: "destructive",
          title: "Could not reuse the Facebook connection",
          description:
            (err as { payload?: { error?: string } }).payload?.error ??
            "Use the direct Meta Ads sign-in instead.",
        });
      },
    });
  };

  const handleDisconnect = (id: number) => {
    disconnect.mutate(
      { id },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Ad account disconnected" });
        },
      },
    );
  };

  return (
    <div className="space-y-4">
    <Card>
      <div className="flex flex-col lg:flex-row lg:items-center">
      <CardHeader className="lg:max-w-sm lg:shrink-0">
        <CardTitle className="flex items-center gap-2">
          <MetaIcon className="h-5 w-5" /> Meta Ads
        </CardTitle>
        <CardDescription>
          Connect the Meta ad account behind your Facebook and Instagram
          campaigns.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 lg:flex-1 lg:pt-6 lg:flex lg:flex-col lg:items-end">
        {!metaConn && (
          <div className="flex flex-col sm:flex-row gap-3">
            <Button
              onClick={startOAuth}
              disabled={!canManage || !metaAvailable || authUrl.isFetching}
              data-testid="button-connect-meta-ads"
            >
              {authUrl.isFetching && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Connect Meta Ads
            </Button>
            <Button
              variant="outline"
              onClick={tryFromFacebook}
              disabled={!canManage || !metaAvailable || fromFacebook.isPending}
              data-testid="button-connect-from-facebook"
            >
              {fromFacebook.isPending && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              Reuse Facebook connection
            </Button>
          </div>
        )}
        {!metaAvailable && !metaConn && <PlatformUnavailableNotice platform="meta" />}
        {metaConn?.status === "pending_selection" && (
          <AccountPicker canManage={canManage} />
        )}
        {metaConn?.status === "connected" && (
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              {metaConn.verifyStatus === "failed" ? (
                <AlertCircle className="h-5 w-5 text-destructive" />
              ) : (
                <CheckCircle2 className="h-5 w-5 text-green-600" />
              )}
              <div>
                <div className="font-medium" data-testid="text-ad-account-name">
                  {metaConn.adAccountName || metaConn.adAccountId}
                </div>
                <div className="text-sm text-muted-foreground">
                  {metaConn.adAccountId}
                  {metaConn.currency ? ` · ${metaConn.currency}` : ""}
                  {metaConn.verifyStatus === "failed"
                    ? " · Access lost — reconnect to continue"
                    : ""}
                </div>
              </div>
            </div>
            {canManage && (
              <div className="flex gap-2">
                {metaConn.verifyStatus === "failed" && (
                  <Button size="sm" onClick={startOAuth} data-testid="button-reconnect-meta-ads">
                    Reconnect
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleDisconnect(metaConn.id)}
                  disabled={disconnect.isPending}
                  data-testid="button-disconnect-meta-ads"
                >
                  Disconnect
                </Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
      </div>
    </Card>
    <GoogleConnectionCard
      googleConn={googleConn}
      googleAvailable={googleAvailable}
      canManage={canManage}
      onDisconnect={handleDisconnect}
      disconnectPending={disconnect.isPending}
    />
    </div>
  );
}

function GoogleConnectionCard({
  googleConn,
  googleAvailable,
  canManage,
  onDisconnect,
  disconnectPending,
}: {
  googleConn: AdAccountConnection | undefined;
  googleAvailable: boolean;
  canManage: boolean;
  onDisconnect: (id: number) => void;
  disconnectPending: boolean;
}) {
  const { toast } = useToast();
  const authUrl = useGetAdsGoogleAuthUrl({
    query: { enabled: false, queryKey: getGetAdsGoogleAuthUrlQueryKey() },
  });

  const startOAuth = async () => {
    const res = await authUrl.refetch();
    if (res.data?.url) {
      window.location.href = res.data.url;
    } else {
      toast({
        variant: "destructive",
        title: "Google Ads sign-in unavailable",
        description:
          (res.error as { payload?: { error?: string } } | null)?.payload?.error ??
          "Could not start the Google Ads sign-in. Try again later.",
      });
    }
  };

  return (
    <Card>
      <div className="flex flex-col lg:flex-row lg:items-center">
      <CardHeader className="lg:max-w-sm lg:shrink-0">
        <CardTitle className="flex items-center gap-2">
          <GoogleIcon className="h-5 w-5" /> Google Ads
        </CardTitle>
        <CardDescription>
          Connect the Google Ads account (or a client account under your
          manager account) this workspace manages.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 lg:flex-1 lg:pt-6 lg:flex lg:flex-col lg:items-end">
        {!googleConn && (
          <Button
            onClick={startOAuth}
            disabled={!canManage || !googleAvailable || authUrl.isFetching}
            data-testid="button-connect-google-ads"
          >
            {authUrl.isFetching && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Connect Google Ads
          </Button>
        )}
        {!googleAvailable && !googleConn && <PlatformUnavailableNotice platform="google" />}
        {googleConn?.status === "pending_selection" && (
          <GoogleAccountPicker canManage={canManage} />
        )}
        {googleConn?.status === "connected" && (
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              {googleConn.verifyStatus === "failed" ? (
                <AlertCircle className="h-5 w-5 text-destructive" />
              ) : (
                <CheckCircle2 className="h-5 w-5 text-green-600" />
              )}
              <div>
                <div className="font-medium" data-testid="text-google-account-name">
                  {googleConn.adAccountName || googleConn.adAccountId}
                </div>
                <div className="text-sm text-muted-foreground">
                  {googleConn.adAccountId}
                  {googleConn.currency ? ` · ${googleConn.currency}` : ""}
                  {googleConn.verifyStatus === "failed"
                    ? " · Access lost — reconnect to continue"
                    : ""}
                </div>
              </div>
            </div>
            {canManage && (
              <div className="flex gap-2">
                {googleConn.verifyStatus === "failed" && (
                  <Button
                    size="sm"
                    onClick={startOAuth}
                    data-testid="button-reconnect-google-ads"
                  >
                    Reconnect
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onDisconnect(googleConn.id)}
                  disabled={disconnectPending}
                  data-testid="button-disconnect-google-ads"
                >
                  Disconnect
                </Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
      </div>
    </Card>
  );
}

function GoogleAccountPicker({ canManage }: { canManage: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: choices, isLoading, error } = useListGoogleAdCustomerChoices();
  const select = useSelectGoogleAdAccount();
  const [picked, setPicked] = useState("");

  const confirm = () => {
    if (!picked) return;
    const choice = (choices ?? []).find((c) => c.customerId === picked);
    select.mutate(
      {
        data: {
          customerId: picked,
          loginCustomerId: choice?.loginCustomerId ?? null,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListAdConnectionsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListNotificationsQueryKey() });
          toast({ title: "Google Ads account connected" });
        },
        onError: (err) => {
          toast({
            variant: "destructive",
            title: "Could not select that Google Ads account",
            description:
              (err as { payload?: { error?: string } }).payload?.error ?? undefined,
          });
        },
      },
    );
  };

  if (isLoading) return <Skeleton className="h-10 w-full" />;
  if (error) {
    return (
      <p className="text-sm text-destructive">
        Could not list your Google Ads accounts. Reconnect Google Ads and try
        again.
      </p>
    );
  }
  const pickable = (choices ?? []).filter((c) => !c.manager);
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Access granted. Pick which Google Ads account this workspace manages
        (client accounts under a manager account are included):
      </p>
      {pickable.length === 0 && (
        <p className="text-sm text-destructive">
          No advertising accounts are reachable with this Google sign-in.
          Manager (MCC) accounts themselves cannot run campaigns.
        </p>
      )}
      <div className="flex flex-col sm:flex-row gap-3">
        <Select value={picked} onValueChange={setPicked}>
          <SelectTrigger className="sm:w-96" data-testid="select-google-account">
            <SelectValue placeholder="Choose a Google Ads account" />
          </SelectTrigger>
          <SelectContent>
            {pickable.map((c) => (
              <SelectItem key={c.customerId} value={c.customerId}>
                {c.name} ({c.customerId}
                {c.currency ? `, ${c.currency}` : ""}
                {c.loginCustomerId ? ", via manager" : ""})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          onClick={confirm}
          disabled={!canManage || !picked || select.isPending}
          data-testid="button-select-google-account"
        >
          {select.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          Use this account
        </Button>
      </div>
    </div>
  );
}

function LinkedinConnectionSection({
  linkedinConn,
  available,
  canManage,
}: {
  linkedinConn: AdAccountConnection | undefined;
  available: boolean;
  canManage: boolean;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const authUrl = useGetAdsLinkedinAuthUrl({
    query: { enabled: false, queryKey: getGetAdsLinkedinAuthUrlQueryKey() },
  });
  const disconnect = useDeleteAdConnection();

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListAdConnectionsQueryKey() });

  const startOAuth = async () => {
    const res = await authUrl.refetch();
    if (res.data?.url) {
      window.location.href = res.data.url;
    } else {
      toast({
        variant: "destructive",
        title: "LinkedIn Ads sign-in unavailable",
        description:
          (res.error as { payload?: { error?: string } } | null)?.payload?.error ??
          "Could not start the LinkedIn Ads sign-in. Try again later.",
      });
    }
  };

  const handleDisconnect = (id: number) => {
    disconnect.mutate(
      { id },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Ad account disconnected" });
        },
      },
    );
  };

  return (
    <Card>
      <div className="flex flex-col lg:flex-row lg:items-center">
      <CardHeader className="lg:max-w-sm lg:shrink-0">
        <CardTitle className="flex items-center gap-2">
          <LinkedinIcon className="h-5 w-5" /> LinkedIn Ads
        </CardTitle>
        <CardDescription>
          Connect the LinkedIn ad account behind your sponsored campaigns.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 lg:flex-1 lg:pt-6 lg:flex lg:flex-col lg:items-end">
        {!linkedinConn && (
          <Button
            onClick={startOAuth}
            disabled={!canManage || !available || authUrl.isFetching}
            data-testid="button-connect-linkedin-ads"
          >
            {authUrl.isFetching && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Connect LinkedIn Ads
          </Button>
        )}
        {!available && !linkedinConn && <PlatformUnavailableNotice platform="linkedin" />}
        {linkedinConn?.status === "pending_selection" && (
          <LinkedinAccountPicker canManage={canManage} />
        )}
        {linkedinConn?.status === "connected" && (
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              {linkedinConn.verifyStatus === "failed" ? (
                <AlertCircle className="h-5 w-5 text-destructive" />
              ) : (
                <CheckCircle2 className="h-5 w-5 text-green-600" />
              )}
              <div>
                <div className="font-medium" data-testid="text-linkedin-ad-account-name">
                  {linkedinConn.adAccountName || linkedinConn.adAccountId}
                </div>
                <div className="text-sm text-muted-foreground">
                  {linkedinConn.adAccountId}
                  {linkedinConn.currency ? ` · ${linkedinConn.currency}` : ""}
                  {linkedinConn.verifyStatus === "failed"
                    ? " · Access lost — reconnect to continue"
                    : ""}
                </div>
              </div>
            </div>
            {canManage && (
              <div className="flex gap-2">
                {linkedinConn.verifyStatus === "failed" && (
                  <Button
                    size="sm"
                    onClick={startOAuth}
                    data-testid="button-reconnect-linkedin-ads"
                  >
                    Reconnect
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleDisconnect(linkedinConn.id)}
                  disabled={disconnect.isPending}
                  data-testid="button-disconnect-linkedin-ads"
                >
                  Disconnect
                </Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
      </div>
    </Card>
  );
}

function LinkedinAccountPicker({ canManage }: { canManage: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: choices, isLoading, error } = useListLinkedinAdAccountChoices();
  const select = useSelectLinkedinAdAccount();
  const [picked, setPicked] = useState("");

  const confirm = () => {
    if (!picked) return;
    select.mutate(
      { data: { adAccountId: picked } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListAdConnectionsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListNotificationsQueryKey() });
          toast({ title: "Ad account connected" });
        },
        onError: (err) => {
          toast({
            variant: "destructive",
            title: "Could not select that ad account",
            description:
              (err as { payload?: { error?: string } }).payload?.error ?? undefined,
          });
        },
      },
    );
  };

  if (isLoading) return <Skeleton className="h-10 w-full" />;
  if (error) {
    return (
      <p className="text-sm text-destructive">
        Could not list your ad accounts. Reconnect LinkedIn Ads and try again.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Access granted. Pick which ad account this workspace manages:
      </p>
      <div className="flex flex-col sm:flex-row gap-3">
        <Select value={picked} onValueChange={setPicked}>
          <SelectTrigger className="sm:w-96" data-testid="select-linkedin-ad-account">
            <SelectValue placeholder="Choose an ad account" />
          </SelectTrigger>
          <SelectContent>
            {(choices ?? []).map((c) => (
              <SelectItem key={c.adAccountId} value={c.adAccountId}>
                {c.name} ({c.adAccountId}
                {c.currency ? `, ${c.currency}` : ""})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          onClick={confirm}
          disabled={!canManage || !picked || select.isPending}
          data-testid="button-select-linkedin-ad-account"
        >
          {select.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          Use this account
        </Button>
      </div>
    </div>
  );
}

function AccountPicker({ canManage }: { canManage: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: choices, isLoading, error } = useListMetaAdAccountChoices();
  const select = useSelectMetaAdAccount();
  const [picked, setPicked] = useState("");

  const confirm = () => {
    if (!picked) return;
    select.mutate(
      { data: { adAccountId: picked } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListAdConnectionsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListNotificationsQueryKey() });
          toast({ title: "Ad account connected" });
        },
        onError: (err) => {
          toast({
            variant: "destructive",
            title: "Could not select that ad account",
            description:
              (err as { payload?: { error?: string } }).payload?.error ?? undefined,
          });
        },
      },
    );
  };

  if (isLoading) return <Skeleton className="h-10 w-full" />;
  if (error) {
    return (
      <p className="text-sm text-destructive">
        Could not list your ad accounts. Reconnect Meta Ads and try again.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Access granted. Pick which ad account this workspace manages:
      </p>
      <div className="flex flex-col sm:flex-row gap-3">
        <Select value={picked} onValueChange={setPicked}>
          <SelectTrigger className="sm:w-96" data-testid="select-ad-account">
            <SelectValue placeholder="Choose an ad account" />
          </SelectTrigger>
          <SelectContent>
            {(choices ?? []).map((c) => (
              <SelectItem key={c.adAccountId} value={c.adAccountId}>
                {c.name} ({c.adAccountId}
                {c.currency ? `, ${c.currency}` : ""})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          onClick={confirm}
          disabled={!canManage || !picked || select.isPending}
          data-testid="button-select-ad-account"
        >
          {select.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          Use this account
        </Button>
      </div>
    </div>
  );
}

function BudgetCapsCard({
  isOwner,
  currency,
}: {
  isOwner: boolean;
  currency: string | null;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: caps, isLoading } = useGetAdsBudgetCaps();
  const update = useUpdateAdsBudgetCaps();
  const [editing, setEditing] = useState(false);
  const [daily, setDaily] = useState("");
  const [lifetime, setLifetime] = useState("");

  const startEditing = () => {
    setDaily(caps?.maxDailyBudget != null ? String(caps.maxDailyBudget / 100) : "");
    setLifetime(caps?.maxLifetimeBudget != null ? String(caps.maxLifetimeBudget / 100) : "");
    setEditing(true);
  };

  const save = () => {
    const parse = (v: string): number | null | undefined => {
      if (!v.trim()) return null;
      const major = Number(v);
      if (!Number.isFinite(major) || major <= 0) return undefined;
      const minor = Math.round(major * 100);
      return minor > 0 ? minor : undefined;
    };
    const maxDailyBudget = parse(daily);
    const maxLifetimeBudget = parse(lifetime);
    if (maxDailyBudget === undefined || maxLifetimeBudget === undefined) {
      toast({
        variant: "destructive",
        title: "Invalid cap",
        description: `Caps must be positive amounts${currency ? ` in ${currency}` : ""} (e.g. 500 or 500.00), or left empty for no cap.`,
      });
      return;
    }
    update.mutate(
      { data: { maxDailyBudget, maxLifetimeBudget } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetAdsBudgetCapsQueryKey() });
          setEditing(false);
          toast({ title: "Budget caps saved" });
        },
        onError: (err) => {
          toast({
            variant: "destructive",
            title: "Could not save the budget caps",
            description:
              (err as { payload?: { error?: string } }).payload?.error ?? undefined,
          });
        },
      },
    );
  };

  const fmtCap = (v: number | null | undefined) =>
    v != null ? formatMoneyMinor(v, currency) : "No cap";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wallet className="h-5 w-5" /> Budget caps
        </CardTitle>
        <CardDescription>
          Optional spend guardrails. Drafts proposing a daily or lifetime budget
          above these caps are rejected before they ever reach approval.
          {!isOwner && " Only the workspace owner can change them."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : editing ? (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="cap-daily">
                  Max daily budget{currency ? ` (${currency})` : ""}
                </Label>
                <Input
                  id="cap-daily"
                  type="number"
                  min="0.01"
                  step="0.01"
                  placeholder="No cap"
                  value={daily}
                  onChange={(e) => setDaily(e.target.value)}
                  data-testid="input-cap-daily"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cap-lifetime">
                  Max lifetime budget{currency ? ` (${currency})` : ""}
                </Label>
                <Input
                  id="cap-lifetime"
                  type="number"
                  min="0.01"
                  step="0.01"
                  placeholder="No cap"
                  value={lifetime}
                  onChange={(e) => setLifetime(e.target.value)}
                  data-testid="input-cap-lifetime"
                />
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={save} disabled={update.isPending} data-testid="button-save-caps">
                {update.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Save caps
              </Button>
              <Button variant="outline" size="sm" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-1 text-sm">
              <div>
                <span className="text-muted-foreground">Daily: </span>
                <span className="font-medium" data-testid="text-cap-daily">
                  {fmtCap(caps?.maxDailyBudget)}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">Lifetime: </span>
                <span className="font-medium" data-testid="text-cap-lifetime">
                  {fmtCap(caps?.maxLifetimeBudget)}
                </span>
              </div>
            </div>
            {isOwner && (
              <Button variant="outline" size="sm" onClick={startEditing} data-testid="button-edit-caps">
                <Pencil className="h-4 w-4 mr-2" /> Edit caps
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TiktokConnectionSection({
  tiktokConn,
  tiktokAvailable,
  canManage,
}: {
  tiktokConn: AdAccountConnection | undefined;
  tiktokAvailable: boolean;
  canManage: boolean;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const authUrl = useGetAdsTiktokAuthUrl({
    query: { enabled: false, queryKey: getGetAdsTiktokAuthUrlQueryKey() },
  });
  const disconnect = useDeleteAdConnection();

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListAdConnectionsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetAdsBudgetCapsQueryKey() });
  };

  const startOAuth = async () => {
    const res = await authUrl.refetch();
    if (res.data?.url) {
      window.location.href = res.data.url;
    } else {
      toast({
        variant: "destructive",
        title: "TikTok Ads sign-in unavailable",
        description:
          (res.error as { payload?: { error?: string } } | null)?.payload?.error ??
          "Could not start the TikTok Ads sign-in. Try again later.",
      });
    }
  };

  const handleDisconnect = (id: number) => {
    disconnect.mutate(
      { id },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Advertiser account disconnected" });
        },
      },
    );
  };

  return (
    <Card>
      <div className="flex flex-col lg:flex-row lg:items-center">
      <CardHeader className="lg:max-w-sm lg:shrink-0">
        <CardTitle className="flex items-center gap-2">
          <TiktokIcon className="h-5 w-5" /> TikTok Ads
        </CardTitle>
        <CardDescription>
          Connect the TikTok for Business advertiser account behind your TikTok
          campaigns.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 lg:flex-1 lg:pt-6 lg:flex lg:flex-col lg:items-end">
        {!tiktokConn && (
          <div className="flex flex-col sm:flex-row gap-3">
            <Button
              onClick={startOAuth}
              disabled={!canManage || !tiktokAvailable || authUrl.isFetching}
              data-testid="button-connect-tiktok-ads"
            >
              {authUrl.isFetching && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Connect TikTok Ads
            </Button>
          </div>
        )}
        {!tiktokAvailable && !tiktokConn && <PlatformUnavailableNotice platform="tiktok" />}
        {tiktokConn?.status === "pending_selection" && (
          <TiktokAdvertiserPicker canManage={canManage} />
        )}
        {tiktokConn?.status === "connected" && (
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              {tiktokConn.verifyStatus === "failed" ? (
                <AlertCircle className="h-5 w-5 text-destructive" />
              ) : (
                <CheckCircle2 className="h-5 w-5 text-green-600" />
              )}
              <div>
                <div className="font-medium" data-testid="text-tiktok-advertiser-name">
                  {tiktokConn.adAccountName || tiktokConn.adAccountId}
                </div>
                <div className="text-sm text-muted-foreground">
                  {tiktokConn.adAccountId}
                  {tiktokConn.currency ? ` · ${tiktokConn.currency}` : ""}
                  {tiktokConn.verifyStatus === "failed"
                    ? " · Access lost — reconnect to continue"
                    : ""}
                </div>
              </div>
            </div>
            {canManage && (
              <div className="flex gap-2">
                {tiktokConn.verifyStatus === "failed" && (
                  <Button
                    size="sm"
                    onClick={startOAuth}
                    data-testid="button-reconnect-tiktok-ads"
                  >
                    Reconnect
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleDisconnect(tiktokConn.id)}
                  disabled={disconnect.isPending}
                  data-testid="button-disconnect-tiktok-ads"
                >
                  Disconnect
                </Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
      </div>
    </Card>
  );
}

function TiktokAdvertiserPicker({ canManage }: { canManage: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: choices, isLoading, error } = useListTiktokAdvertiserChoices();
  const select = useSelectTiktokAdvertiser();
  const [picked, setPicked] = useState("");

  const confirm = () => {
    if (!picked) return;
    select.mutate(
      { data: { adAccountId: picked } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListAdConnectionsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListNotificationsQueryKey() });
          toast({ title: "Advertiser account connected" });
        },
        onError: (err) => {
          toast({
            variant: "destructive",
            title: "Could not select that advertiser account",
            description:
              (err as { payload?: { error?: string } }).payload?.error ?? undefined,
          });
        },
      },
    );
  };

  if (isLoading) return <Skeleton className="h-10 w-full" />;
  if (error) {
    return (
      <p className="text-sm text-destructive">
        Could not list your advertiser accounts. Reconnect TikTok Ads and try
        again.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Access granted. Pick which advertiser account this workspace manages:
      </p>
      <div className="flex flex-col sm:flex-row gap-3">
        <Select value={picked} onValueChange={setPicked}>
          <SelectTrigger className="sm:w-96" data-testid="select-tiktok-advertiser">
            <SelectValue placeholder="Choose an advertiser account" />
          </SelectTrigger>
          <SelectContent>
            {(choices ?? []).map((c) => (
              <SelectItem key={c.adAccountId} value={c.adAccountId}>
                {c.name} ({c.adAccountId}
                {c.currency ? `, ${c.currency}` : ""})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          onClick={confirm}
          disabled={!canManage || !picked || select.isPending}
          data-testid="button-select-tiktok-advertiser"
        >
          {select.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          Use this account
        </Button>
      </div>
    </div>
  );
}

function CampaignsSection({
  connection,
  canManage,
}: {
  connection: AdAccountConnection;
  canManage: boolean;
}) {
  const [datePreset, setDatePreset] = useState("last_30d");
  const { data, isLoading, error } = useListAdCampaigns({
    connectionId: connection.id,
    datePreset: datePreset as never,
  });
  useRefreshConnectionsOnAuthLoss(error);
  const [draftForm, setDraftForm] = useState<DraftFormState | null>(null);
  const [detailCampaignId, setDetailCampaignId] = useState<string | null>(null);
  const [creativeCampaign, setCreativeCampaign] = useState<{ id: string; name: string } | null>(null);
  const [targetingCampaign, setTargetingCampaign] = useState<{ id: string; name: string } | null>(null);

  const isLinkedin = connection.platform === "linkedin";
  const currency = data?.currency ?? connection.currency ?? null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <Select value={datePreset} onValueChange={setDatePreset}>
          <SelectTrigger className="w-44" data-testid="select-date-preset">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DATE_PRESETS.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {canManage && (
          <Button
            onClick={() =>
              setDraftForm({
                ...EMPTY_FORM,
                action: "create",
                objective:
                  connection.platform === "google" ? "SEARCH" : "OUTCOME_TRAFFIC",
              })
            }
            data-testid="button-new-campaign"
          >
            <Plus className="h-4 w-4 mr-2" /> Draft new campaign
          </Button>
        )}
      </div>

      {isLoading && <Skeleton className="h-48 w-full" />}
      {error && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-destructive">
            {(error as { payload?: { error?: string } }).payload?.error ??
              "Could not load campaigns."}
          </CardContent>
        </Card>
      )}
      {data && data.campaigns.length === 0 && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No campaigns in this ad account yet.
          </CardContent>
        </Card>
      )}
      {data && data.campaigns.length > 0 && (
        <Card>
          <CardContent className="pt-6 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Campaign</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Schedule</TableHead>
                  <TableHead className="text-right">Budget</TableHead>
                  <TableHead className="text-right">Impressions</TableHead>
                  <TableHead className="text-right">Clicks</TableHead>
                  <TableHead className="text-right">CTR</TableHead>
                  <TableHead className="text-right">Spend</TableHead>
                  <TableHead className="text-right">Results</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.campaigns.map((c) => (
                  <TableRow key={c.id} data-testid={`row-campaign-${c.id}`}>
                    <TableCell>
                      <button
                        className="font-medium text-left hover:underline"
                        onClick={() => setDetailCampaignId(c.id)}
                        data-testid={`link-campaign-${c.id}`}
                      >
                        {c.name}
                      </button>
                      {c.objective && (
                        <div className="text-xs text-muted-foreground">{c.objective}</div>
                      )}
                    </TableCell>
                    <TableCell>{statusBadge(c.effectiveStatus)}</TableCell>
                    <TableCell
                      className="whitespace-nowrap text-sm text-muted-foreground"
                      data-testid={`text-campaign-schedule-${c.id}`}
                    >
                      {formatScheduleDate(c.startTime)} – {formatScheduleDate(c.stopTime)}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {c.dailyBudget != null
                        ? `${formatMoneyMinor(c.dailyBudget, currency)}/day`
                        : formatMoneyMinor(c.lifetimeBudget, currency)}
                    </TableCell>
                    <TableCell className="text-right">
                      {c.metrics.impressions.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right">
                      {c.metrics.clicks.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right">
                      {c.metrics.ctr.toFixed(2)}%
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {formatSpend(c.metrics.spend, currency)}
                    </TableCell>
                    <TableCell className="text-right">
                      {c.metrics.results.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {canManage && isLinkedin && (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            title="Add creative"
                            onClick={() => setCreativeCampaign({ id: c.id, name: c.name })}
                            data-testid={`button-add-creative-${c.id}`}
                          >
                            <ImagePlus className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            title="Edit targeting"
                            onClick={() => setTargetingCampaign({ id: c.id, name: c.name })}
                            data-testid={`button-edit-targeting-${c.id}`}
                          >
                            <MapPin className="h-4 w-4" />
                          </Button>
                        </>
                      )}
                      {canManage && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setDraftForm({
                              ...EMPTY_FORM,
                              action: "update",
                              targetType: "campaign",
                              targetId: c.id,
                              currentName: c.name,
                              name: c.name,
                              status: c.status,
                              dailyBudget: c.dailyBudget != null ? String(c.dailyBudget) : "",
                              lifetimeBudget:
                                c.lifetimeBudget != null ? String(c.lifetimeBudget) : "",
                              startTime: c.startTime ?? "",
                              stopTime: c.stopTime ?? "",
                            })
                          }
                          data-testid={`button-edit-campaign-${c.id}`}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {connection.platform === "linkedin" && (
        <LinkedinGroupsCard
          connectionId={connection.id}
          datePreset={datePreset}
          currency={currency}
          canManage={canManage}
          onEdit={(form) => setDraftForm(form)}
        />
      )}

      {detailCampaignId && (
        <CampaignDetailDialog
          connectionId={connection.id}
          platform={connection.platform}
          campaignId={detailCampaignId}
          datePreset={datePreset}
          currency={currency}
          canManage={canManage}
          onEdit={(form) => setDraftForm(form)}
          onClose={() => setDetailCampaignId(null)}
        />
      )}

      {draftForm && (
        <DraftDialog
          connectionId={connection.id}
          platform={connection.platform}
          currency={currency}
          form={draftForm}
          onClose={() => setDraftForm(null)}
        />
      )}

      {creativeCampaign && (
        <CreativeDraftDialog
          connectionId={connection.id}
          campaign={creativeCampaign}
          onClose={() => setCreativeCampaign(null)}
        />
      )}

      {targetingCampaign && (
        <TargetingDraftDialog
          connectionId={connection.id}
          campaign={targetingCampaign}
          onClose={() => setTargetingCampaign(null)}
        />
      )}
    </div>
  );
}

export function CampaignDetailDialog({
  connectionId,
  platform,
  campaignId,
  datePreset,
  currency,
  canManage,
  onEdit,
  onClose,
}: {
  connectionId: number;
  platform: string;
  campaignId: string;
  datePreset: string;
  currency: string | null;
  canManage: boolean;
  onEdit: (form: DraftFormState) => void;
  onClose: () => void;
}) {
  const { data, isLoading, error } = useGetAdCampaignDetail({
    campaignId,
    connectionId,
    datePreset: datePreset as never,
  });
  useRefreshConnectionsOnAuthLoss(error);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createDraft = useCreateAdDraft();
  const isLinkedin = platform === "linkedin";
  const isMeta = platform === "meta";
  // LinkedIn "ads" are creatives; Meta/Google/TikTok "ads" are ad objects.
  // Both are status-only drafts here (activate/pause, plus archive where the
  // platform supports it).
  const [creativeStatusDraft, setCreativeStatusDraft] = useState<{
    id: string;
    name: string;
    status: "ACTIVE" | "PAUSED" | "ARCHIVED";
    targetType: "creative" | "ad";
  } | null>(null);

  const submitCreativeStatus = () => {
    if (!creativeStatusDraft) return;
    createDraft.mutate(
      {
        data: {
          connectionId,
          targetType: creativeStatusDraft.targetType,
          action: "update",
          targetId: creativeStatusDraft.id,
          status: creativeStatusDraft.status,
          idempotencyKey: crypto.randomUUID(),
        } as never,
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListAdDraftsQueryKey() });
          toast({
            title: "Draft created",
            description:
              "The status change is saved as a draft. The workspace owner can review and approve it under Approvals.",
          });
          setCreativeStatusDraft(null);
        },
        onError: (err) => {
          toast({
            variant: "destructive",
            title: "Could not create the draft",
            description:
              (err as { payload?: { error?: string } }).payload?.error ?? undefined,
          });
        },
      },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{data?.campaign.name ?? "Campaign"}</DialogTitle>
          <DialogDescription>
            Ad sets and ads with their delivery for the selected period.
          </DialogDescription>
        </DialogHeader>
        {isLoading && <Skeleton className="h-40 w-full" />}
        {error && (
          <p className="text-sm text-destructive">
            {(error as { payload?: { error?: string } }).payload?.error ??
              "Could not load the campaign."}
          </p>
        )}
        {data && (
          <div className="space-y-6">
            <div>
              <h3 className="font-semibold mb-2">Ad sets</h3>
              {data.adSets.length === 0 ? (
                <p className="text-sm text-muted-foreground">No ad sets.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Schedule</TableHead>
                      <TableHead className="text-right">
                        {platform === "google" ? "Default CPC bid" : "Budget"}
                      </TableHead>
                      {platform === "meta" && (
                        <TableHead className="text-right">Bid</TableHead>
                      )}
                      <TableHead className="text-right">Impressions</TableHead>
                      <TableHead className="text-right">Spend</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.adSets.map((s) => (
                      <TableRow key={s.id} data-testid={`row-adset-${s.id}`}>
                        <TableCell className="font-medium">{s.name}</TableCell>
                        <TableCell>{statusBadge(s.effectiveStatus)}</TableCell>
                        <TableCell
                          className="whitespace-nowrap"
                          data-testid={`text-adset-schedule-${s.id}`}
                        >
                          {formatScheduleRange(s.startTime, s.stopTime)}
                        </TableCell>
                        <TableCell className="text-right whitespace-nowrap">
                          {platform === "google"
                            ? formatMoneyMinor(s.dailyBudget, currency)
                            : s.dailyBudget != null
                              ? `${formatMoneyMinor(s.dailyBudget, currency)}/day`
                              : formatMoneyMinor(s.lifetimeBudget, currency)}
                        </TableCell>
                        {platform === "meta" && (
                          <TableCell
                            className="text-right whitespace-nowrap"
                            data-testid={`text-adset-bid-${s.id}`}
                          >
                            {formatBid(s.bidStrategy, s.bidAmount, currency)}
                          </TableCell>
                        )}
                        <TableCell className="text-right">
                          {s.metrics.impressions.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right whitespace-nowrap">
                          {formatSpend(s.metrics.spend, currency)}
                        </TableCell>
                        <TableCell className="text-right">
                          {canManage && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                onEdit({
                                  ...EMPTY_FORM,
                                  action: "update",
                                  targetType: "adset",
                                  targetId: s.id,
                                  currentName: s.name,
                                  name: s.name,
                                  status: s.status,
                                  dailyBudget:
                                    s.dailyBudget != null ? String(s.dailyBudget) : "",
                                  lifetimeBudget:
                                    s.lifetimeBudget != null ? String(s.lifetimeBudget) : "",
                                  startTime: s.startTime ?? "",
                                  stopTime: s.stopTime ?? "",
                                  bidAmount:
                                    s.bidAmount != null ? String(s.bidAmount) : "",
                                  bidStrategy: s.bidStrategy ?? "",
                                })
                              }
                              data-testid={`button-edit-adset-${s.id}`}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
            <div>
              <h3 className="font-semibold mb-2">Ads</h3>
              {data.ads.length === 0 ? (
                <p className="text-sm text-muted-foreground">No ads.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Impressions</TableHead>
                      <TableHead className="text-right">Clicks</TableHead>
                      <TableHead className="text-right">Spend</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.ads.map((a) => (
                      <TableRow key={a.id} data-testid={`row-ad-${a.id}`}>
                        <TableCell className="font-medium">
                          <div className="flex items-start gap-3">
                            {a.imageUrl && (
                              <img
                                src={a.imageUrl}
                                alt="Ad creative"
                                className="h-12 w-12 rounded object-cover shrink-0"
                                data-testid={`img-ad-preview-${a.id}`}
                                onError={(e) => {
                                  // Signed thumbnail URLs expire; hide the
                                  // image instead of showing a broken icon.
                                  e.currentTarget.style.display = "none";
                                }}
                              />
                            )}
                            <div className="min-w-0">
                              <div>{a.name}</div>
                              {a.text && (
                                <p
                                  className="text-xs text-muted-foreground font-normal line-clamp-2 max-w-xs whitespace-pre-line"
                                  data-testid={`text-ad-copy-${a.id}`}
                                >
                                  {a.text}
                                </p>
                              )}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap items-center gap-1">
                            {statusBadge(a.effectiveStatus)}
                            {isLinkedin && reviewStatusBadge(a.reviewStatus, a.id)}
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          {a.metrics.impressions.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right">
                          {a.metrics.clicks.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right whitespace-nowrap">
                          {formatSpend(a.metrics.spend, currency)}
                        </TableCell>
                        <TableCell className="text-right">
                          {canManage && isLinkedin && (() => {
                            const reviewBlocked = linkedinReviewBlocksStatusChange(a.reviewStatus);
                            const blockedTitle =
                              a.reviewStatus?.toUpperCase() === "REJECTED"
                                ? "LinkedIn rejected this creative — status changes aren't possible."
                                : "This creative is still in LinkedIn review — status changes aren't possible yet.";
                            return (
                              <div className="flex items-center justify-end gap-1">
                                {a.status !== "ARCHIVED" && (
                                  <span title={reviewBlocked ? blockedTitle : undefined}>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      disabled={reviewBlocked}
                                      onClick={() =>
                                        setCreativeStatusDraft({
                                          id: a.id,
                                          name: a.name,
                                          status: a.status === "ACTIVE" ? "PAUSED" : "ACTIVE",
                                          targetType: "creative",
                                        })
                                      }
                                      data-testid={`button-toggle-creative-${a.id}`}
                                    >
                                      {a.status === "ACTIVE" ? "Pause" : "Activate"}
                                    </Button>
                                  </span>
                                )}
                                {a.status !== "ARCHIVED" && (
                                  <span title={reviewBlocked ? blockedTitle : undefined}>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="text-destructive hover:text-destructive"
                                      disabled={reviewBlocked}
                                      onClick={() =>
                                        setCreativeStatusDraft({
                                          id: a.id,
                                          name: a.name,
                                          status: "ARCHIVED",
                                          targetType: "creative",
                                        })
                                      }
                                      data-testid={`button-archive-creative-${a.id}`}
                                    >
                                      Archive
                                    </Button>
                                  </span>
                                )}
                              </div>
                            );
                          })()}
                          {canManage && !isLinkedin && (
                            <div className="flex items-center justify-end gap-1">
                              {a.status !== "ARCHIVED" && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() =>
                                    setCreativeStatusDraft({
                                      id: a.id,
                                      name: a.name,
                                      status: a.status === "ACTIVE" ? "PAUSED" : "ACTIVE",
                                      targetType: "ad",
                                    })
                                  }
                                  data-testid={`button-toggle-ad-${a.id}`}
                                >
                                  {a.status === "ACTIVE" ? "Pause" : "Activate"}
                                </Button>
                              )}
                              {isMeta && a.status !== "ARCHIVED" && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="text-destructive hover:text-destructive"
                                  onClick={() =>
                                    setCreativeStatusDraft({
                                      id: a.id,
                                      name: a.name,
                                      status: "ARCHIVED",
                                      targetType: "ad",
                                    })
                                  }
                                  data-testid={`button-archive-ad-${a.id}`}
                                >
                                  Archive
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  onEdit({
                                    ...EMPTY_FORM,
                                    action: "update",
                                    targetType: "ad",
                                    targetId: a.id,
                                    currentName: a.name,
                                    name: a.name,
                                    status: a.status,
                                  })
                                }
                                data-testid={`button-edit-ad-${a.id}`}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          </div>
        )}
        {creativeStatusDraft && (
          <Dialog open onOpenChange={(open) => !open && setCreativeStatusDraft(null)}>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>
                  {creativeStatusDraft.status === "ARCHIVED"
                    ? `Archive this ${creativeStatusDraft.targetType === "ad" ? "ad" : "creative"}?`
                    : creativeStatusDraft.status === "PAUSED"
                      ? `Pause this ${creativeStatusDraft.targetType === "ad" ? "ad" : "creative"}?`
                      : `Activate this ${creativeStatusDraft.targetType === "ad" ? "ad" : "creative"}?`}
                </DialogTitle>
                <DialogDescription>
                  {creativeStatusDraft.status === "ARCHIVED"
                    ? creativeStatusDraft.targetType === "ad"
                      ? `"${creativeStatusDraft.name}" will be archived and stop delivering once the change is applied.`
                      : `"${creativeStatusDraft.name}" will be archived on LinkedIn. Archiving is permanent — the creative cannot be reactivated afterwards.`
                    : creativeStatusDraft.status === "PAUSED"
                      ? `"${creativeStatusDraft.name}" will stop delivering once the change is applied.`
                      : `"${creativeStatusDraft.name}" will resume delivering once the change is applied.`}{" "}
                  Nothing touches your ad account yet — this creates a draft the
                  workspace owner must approve first.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setCreativeStatusDraft(null)}
                  data-testid="button-cancel-creative-status"
                >
                  Cancel
                </Button>
                <Button
                  variant={
                    creativeStatusDraft.status === "ARCHIVED" ? "destructive" : "default"
                  }
                  onClick={submitCreativeStatus}
                  disabled={createDraft.isPending}
                  data-testid="button-confirm-creative-status"
                >
                  {createDraft.isPending && (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  )}
                  Create draft
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </DialogContent>
    </Dialog>
  );
}

function LinkedinGroupsCard({
  connectionId,
  datePreset,
  currency,
  canManage,
  onEdit,
}: {
  connectionId: number;
  datePreset: string;
  currency: string | null;
  canManage: boolean;
  onEdit: (form: DraftFormState) => void;
}) {
  const { data, isLoading, error } = useListLinkedinCampaignGroups({
    connectionId,
    datePreset: datePreset as never,
  });
  useRefreshConnectionsOnAuthLoss(error);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Campaign groups</CardTitle>
        <CardDescription>
          Rename, pause, or adjust a group's lifetime budget — every change is
          drafted for the workspace owner to approve first.
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {isLoading && <Skeleton className="h-24 w-full" />}
        {error && (
          <p className="text-sm text-destructive">
            {(error as { payload?: { error?: string } }).payload?.error ??
              "Could not load campaign groups."}
          </p>
        )}
        {data && data.groups.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No campaign groups in this ad account yet.
          </p>
        )}
        {data && data.groups.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Group</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Lifetime budget</TableHead>
                <TableHead className="text-right">Impressions</TableHead>
                <TableHead className="text-right">Clicks</TableHead>
                <TableHead className="text-right">Spend</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.groups.map((g) => (
                <TableRow key={g.id} data-testid={`row-campaign-group-${g.id}`}>
                  <TableCell className="font-medium">{g.name}</TableCell>
                  <TableCell>{statusBadge(g.status)}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {formatMoneyMinor(g.lifetimeBudget ?? null, currency)}
                  </TableCell>
                  <TableCell className="text-right">
                    {g.metrics.impressions.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right">
                    {g.metrics.clicks.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {formatSpend(g.metrics.spend, currency)}
                  </TableCell>
                  <TableCell className="text-right">
                    {canManage && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          onEdit({
                            ...EMPTY_FORM,
                            action: "update",
                            targetType: "campaign_group",
                            targetId: g.id,
                            currentName: g.name,
                            name: g.name,
                            status: g.status,
                            lifetimeBudget:
                              g.lifetimeBudget != null ? String(g.lifetimeBudget) : "",
                          })
                        }
                        data-testid={`button-edit-campaign-group-${g.id}`}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export function DraftDialog({
  connectionId,
  platform,
  currency = null,
  form,
  onClose,
}: {
  connectionId: number;
  platform: string;
  currency?: string | null;
  form: DraftFormState;
  onClose: () => void;
}) {
  const isGoogle = platform === "google";
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createDraft = useCreateAdDraft();
  const isTiktok = platform === "tiktok";
  // Money fields arrive from the API in minor units; the inputs work in the
  // ad account's currency (major units) and convert back on submit.
  const [state, setState] = useState(() => {
    const base =
      isTiktok && form.action === "create" && form.objective === "OUTCOME_TRAFFIC"
        ? { ...form, objective: "TRAFFIC" }
        : { ...form };
    base.dailyBudget = minorStrToMajorStr(base.dailyBudget);
    base.lifetimeBudget = minorStrToMajorStr(base.lifetimeBudget);
    base.bidAmount = minorStrToMajorStr(base.bidAmount);
    return base;
  });
  const [campaignGroupId, setCampaignGroupId] = useState("");
  const idempotencyKey = useMemo(() => crypto.randomUUID(), []);

  const isCreate = state.action === "create";
  const isGroupCreate = state.targetType === "campaign_group";
  const targetLabel =
    state.targetType === "adset"
      ? "ad set"
      : state.targetType === "ad"
        ? "ad"
        : isGroupCreate
          ? "campaign group"
          : "campaign";
  const showBudgets =
    state.targetType === "campaign" || isGroupCreate || state.targetType === "adset";
  const showDailyBudget = showBudgets && !isGroupCreate;
  // TikTok schedules live on ad groups, not campaigns. Meta ad sets carry
  // their own schedule (end_time) alongside the campaign-level one; other
  // platforms' ad-set-level objects stay name/status/budget only.
  const showSchedule = isTiktok
    ? state.targetType === "adset"
    : state.targetType === "campaign" ||
      (state.targetType === "adset" && platform === "meta");
  // Bid tuning (amount + strategy) is a Meta ad-set update knob only.
  const showBids =
    platform === "meta" && state.targetType === "adset" && !isCreate;
  // Google ad groups have no budget; the money knob there is the default
  // max CPC bid (still sent as dailyBudget in minor units). Google ads can
  // only be paused/activated — renaming is not supported.
  const isGoogleAdGroup = isGoogle && state.targetType === "adset";
  const nameLocked = isGoogle && state.targetType === "ad";

  // TikTok campaigns and ad groups hold a single budget_mode: daily OR
  // lifetime (total) — campaigns can also carry no budget at all
  // (BUDGET_MODE_INFINITE, i.e. unlimited). Drafting a budget in another mode
  // silently switches the mode on apply, so surface the current mode and warn
  // about the flip. `form` (not `state`) reflects the target's current
  // budgets at open time.
  const tiktokBudgetModeTarget =
    isTiktok &&
    state.action === "update" &&
    (state.targetType === "adset" || state.targetType === "campaign");
  const tiktokTargetNoun =
    state.targetType === "campaign" ? "campaign" : "ad group";
  const currentTiktokMode: "daily" | "lifetime" | "none" | null =
    !tiktokBudgetModeTarget
      ? null
      : form.dailyBudget
        ? "daily"
        : form.lifetimeBudget
          ? "lifetime"
          : state.targetType === "campaign"
            ? "none"
            : null;
  // The server-side apply prefers a daily budget when both are sent.
  const draftedTiktokMode: "daily" | "lifetime" | null = !tiktokBudgetModeTarget
    ? null
    : state.dailyBudget.trim()
      ? "daily"
      : state.lifetimeBudget.trim()
        ? "lifetime"
        : null;
  const tiktokModeFlips =
    currentTiktokMode != null &&
    draftedTiktokMode != null &&
    draftedTiktokMode !== currentTiktokMode;
  const tiktokModeLabel = (m: "daily" | "lifetime" | "none") =>
    m === "daily" ? "daily" : m === "lifetime" ? "lifetime (total)" : "no";

  // TikTok enforces platform budget minimums (campaign >= 50, ad group >= 20
  // in the account's currency). Validate inline so an invalid budget is
  // caught before the draft is even created; the server rejects it too as a
  // backstop.
  const tiktokMinBudget =
    isTiktok && state.targetType === "campaign"
      ? TIKTOK_MIN_CAMPAIGN_BUDGET
      : isTiktok && state.targetType === "adset"
        ? TIKTOK_MIN_ADGROUP_BUDGET
        : null;
  const belowTiktokMin = (v: string) => {
    if (tiktokMinBudget == null || !v.trim()) return false;
    const n = Number(v);
    return Number.isFinite(n) && n < tiktokMinBudget;
  };
  const tiktokDailyTooLow = belowTiktokMin(state.dailyBudget);
  const tiktokLifetimeTooLow = belowTiktokMin(state.lifetimeBudget);
  const tiktokBudgetError =
    tiktokDailyTooLow || tiktokLifetimeTooLow
      ? `TikTok requires a ${tiktokTargetNoun} ${
          tiktokDailyTooLow && tiktokLifetimeTooLow
            ? "daily and lifetime budget"
            : tiktokDailyTooLow
              ? "daily budget"
              : "lifetime budget"
        } of at least ${tiktokMinBudget}${currency ? ` ${currency}` : ""}.${
          state.targetType === "campaign"
            ? " Leave the budget blank for an unlimited campaign budget."
            : ""
        }`
      : null;

  const isLinkedin = platform === "linkedin";
  const { data: groupData } = useListLinkedinCampaignGroups(
    { connectionId },
    {
      query: {
        enabled: isLinkedin && isCreate,
        queryKey: getListLinkedinCampaignGroupsQueryKey({ connectionId }),
      },
    },
  );
  const groups = groupData?.groups ?? [];

  const submit = () => {
    const data: Record<string, unknown> = {
      connectionId,
      targetType: state.targetType,
      action: state.action,
      idempotencyKey,
    };
    if (!isCreate) data.targetId = state.targetId;
    if (!nameLocked && (isCreate || state.name !== state.currentName)) {
      data.name = state.name;
    }
    if (state.status) data.status = state.status;
    if (isCreate && !isLinkedin && !isGroupCreate && state.objective) {
      data.objective = state.objective;
    }
    if (isCreate && isLinkedin && !isGroupCreate && campaignGroupId) {
      data.campaignGroupId = campaignGroupId;
    }
    const toMinor = (v: string) => Math.round(Number(v) * 100);
    if (showDailyBudget && state.dailyBudget) data.dailyBudget = toMinor(state.dailyBudget);
    if (showBudgets && state.lifetimeBudget) {
      data.lifetimeBudget = toMinor(state.lifetimeBudget);
    }
    // Clearing a LinkedIn campaign group's lifetime budget means "remove the
    // cap" — surface that as an explicit removal rather than silently ignoring it.
    if (
      state.targetType === "campaign_group" &&
      !isCreate &&
      !state.lifetimeBudget.trim() &&
      form.lifetimeBudget.trim()
    ) {
      data.removeLifetimeBudget = true;
    }
    if (showSchedule && state.startTime) data.startTime = state.startTime;
    if (showSchedule && state.stopTime) data.stopTime = state.stopTime;
    // Bid fields are prefilled from the ad set's live values so the user can
    // see the current strategy/amount; only draft a bid change when something
    // actually differs from those prefills. When the strategy changes to a
    // capped one, the unchanged amount is still sent because the server
    // requires an amount alongside bid-cap/cost-cap strategies.
    if (showBids) {
      const strategyChanged = state.bidStrategy !== form.bidStrategy;
      const amountChanged = state.bidAmount !== minorStrToMajorStr(form.bidAmount);
      const strategyNeedsAmount =
        strategyChanged && state.bidStrategy !== "" && state.bidStrategy !== "LOWEST_COST_WITHOUT_CAP";
      if (state.bidAmount && (amountChanged || strategyNeedsAmount)) {
        data.bidAmount = toMinor(state.bidAmount);
      }
      if (state.bidStrategy && strategyChanged) data.bidStrategy = state.bidStrategy;
    }

    createDraft.mutate(
      { data: data as never },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListAdDraftsQueryKey() });
          toast({
            title: "Draft created",
            description:
              "The change is saved as a draft. The workspace owner can now review and approve it under Approvals.",
          });
          onClose();
        },
        onError: (err) => {
          toast({
            variant: "destructive",
            title: "Could not create the draft",
            description:
              (err as { payload?: { error?: string } }).payload?.error ?? undefined,
          });
        },
      },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isCreate
              ? isGroupCreate
                ? "Draft a new campaign group"
                : "Draft a new campaign"
              : `Draft changes to ${targetLabel} "${state.currentName}"`}
          </DialogTitle>
          <DialogDescription>
            Nothing touches your ad account yet — this creates a draft the
            workspace owner must approve first.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="draft-name">Name</Label>
            <Input
              id="draft-name"
              value={state.name}
              onChange={(e) => setState({ ...state, name: e.target.value })}
              disabled={nameLocked}
              data-testid="input-draft-name"
            />
            {nameLocked && (
              <p className="text-xs text-muted-foreground">
                Google ads can only be paused or activated here — renaming is
                not supported.
              </p>
            )}
          </div>
          {isCreate && isLinkedin && !isGroupCreate && (
            <div className="space-y-2">
              <Label>Campaign group</Label>
              <Select
                value={campaignGroupId}
                onValueChange={(v) => {
                  if (v === "__create_new__") {
                    setCampaignGroupId("");
                    setState({ ...state, targetType: "campaign_group" });
                  } else {
                    setCampaignGroupId(v);
                  }
                }}
              >
                <SelectTrigger data-testid="select-draft-campaign-group">
                  <SelectValue
                    placeholder={
                      groups.length === 0
                        ? "No campaign groups yet"
                        : "Choose a campaign group"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {groups.map((g) => (
                    <SelectItem key={g.id} value={g.id}>
                      {g.name}
                    </SelectItem>
                  ))}
                  <SelectItem
                    value="__create_new__"
                    data-testid="option-create-campaign-group"
                  >
                    Create a new campaign group…
                  </SelectItem>
                </SelectContent>
              </Select>
              {groups.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  This ad account has no campaign groups yet. Pick "Create a new
                  campaign group" to draft one — the workspace owner approves it
                  like any other change.
                </p>
              )}
            </div>
          )}
          {isCreate && isLinkedin && isGroupCreate && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">
                This drafts a new LinkedIn campaign group with the name, status,
                and optional lifetime budget above. Once it is approved and
                applied, draft your campaign inside it.
              </p>
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0"
                onClick={() => setState({ ...state, targetType: "campaign" })}
                data-testid="button-back-to-campaign"
              >
                Back to drafting a campaign
              </Button>
            </div>
          )}
          {isCreate && !isLinkedin && (
            <div className="space-y-2">
              <Label>Objective</Label>
              <Select
                value={state.objective}
                onValueChange={(v) => setState({ ...state, objective: v })}
              >
                <SelectTrigger data-testid="select-draft-objective">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {isTiktok ? (
                    <>
                      <SelectItem value="TRAFFIC">Traffic</SelectItem>
                      <SelectItem value="REACH">Reach</SelectItem>
                      <SelectItem value="VIDEO_VIEWS">Video views</SelectItem>
                      <SelectItem value="LEAD_GENERATION">Lead generation</SelectItem>
                      <SelectItem value="CONVERSIONS">Conversions</SelectItem>
                      <SelectItem value="APP_PROMOTION">App promotion</SelectItem>
                    </>
                  ) : isGoogle ? (
                    <>
                      <SelectItem value="SEARCH">Search</SelectItem>
                      <SelectItem value="DISPLAY">Display</SelectItem>
                      <SelectItem value="VIDEO">Video</SelectItem>
                      <SelectItem value="SHOPPING">Shopping</SelectItem>
                      <SelectItem value="PERFORMANCE_MAX">Performance Max</SelectItem>
                    </>
                  ) : (
                    <>
                      <SelectItem value="OUTCOME_TRAFFIC">Traffic</SelectItem>
                      <SelectItem value="OUTCOME_AWARENESS">Awareness</SelectItem>
                      <SelectItem value="OUTCOME_ENGAGEMENT">Engagement</SelectItem>
                      <SelectItem value="OUTCOME_LEADS">Leads</SelectItem>
                      <SelectItem value="OUTCOME_SALES">Sales</SelectItem>
                      <SelectItem value="OUTCOME_APP_PROMOTION">App promotion</SelectItem>
                    </>
                  )}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-2">
            <Label>Status</Label>
            <Select
              value={state.status || undefined}
              onValueChange={(v) => setState({ ...state, status: v })}
            >
              <SelectTrigger data-testid="select-draft-status">
                <SelectValue placeholder={isCreate ? "Paused (default)" : "Keep current"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ACTIVE">Active</SelectItem>
                <SelectItem value="PAUSED">Paused</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {showBudgets && (
            <div className="grid grid-cols-2 gap-4">
              {showDailyBudget && (
                <div className="space-y-2">
                  <Label htmlFor="draft-daily-budget">
                    {isGoogleAdGroup
                      ? `Default CPC bid${currency ? ` (${currency})` : ""}`
                      : `Daily budget${currency ? ` (${currency})` : ""}`}
                  </Label>
                  <Input
                    id="draft-daily-budget"
                    type="number"
                    min="0"
                    step="0.01"
                    value={state.dailyBudget}
                    onChange={(e) => setState({ ...state, dailyBudget: e.target.value })}
                    data-testid="input-draft-daily-budget"
                  />
                </div>
              )}
              {!isGoogle && (
                <div className="space-y-2">
                  <Label htmlFor="draft-lifetime-budget">
                    Lifetime budget{currency ? ` (${currency})` : ""}
                  </Label>
                  <Input
                    id="draft-lifetime-budget"
                    type="number"
                    min="0"
                    step="0.01"
                    value={state.lifetimeBudget}
                    onChange={(e) => setState({ ...state, lifetimeBudget: e.target.value })}
                    data-testid="input-draft-lifetime-budget"
                  />
                </div>
              )}
            </div>
          )}
          {tiktokBudgetError && (
            <p
              className="text-xs font-medium text-destructive"
              data-testid="text-tiktok-budget-min-error"
            >
              {tiktokBudgetError}
            </p>
          )}
          {tiktokBudgetModeTarget && currentTiktokMode != null && (
            <p
              className="text-xs text-muted-foreground"
              data-testid="text-tiktok-budget-mode"
            >
              {currentTiktokMode === "none"
                ? `This TikTok ${tiktokTargetNoun} currently has no budget (unlimited).`
                : `This TikTok ${tiktokTargetNoun} currently uses a ${tiktokModeLabel(currentTiktokMode)} budget.`}
            </p>
          )}
          {tiktokModeFlips && currentTiktokMode != null && draftedTiktokMode != null && (
            <Alert data-testid="alert-tiktok-budget-mode-flip">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                {currentTiktokMode === "none"
                  ? `Applying this draft will give this campaign a ${tiktokModeLabel(draftedTiktokMode)} budget. It currently has no budget (unlimited), so spend will become capped by the new budget.`
                  : `Applying this draft will switch the ${tiktokTargetNoun}'s budget type from ${tiktokModeLabel(currentTiktokMode)} to ${tiktokModeLabel(draftedTiktokMode)}. TikTok ${tiktokTargetNoun}s keep a single budget type, so the current ${tiktokModeLabel(currentTiktokMode)} budget stops applying.`}
              </AlertDescription>
            </Alert>
          )}
          {showBids && (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Bid strategy</Label>
                <Select
                  value={state.bidStrategy || undefined}
                  onValueChange={(v) => setState({ ...state, bidStrategy: v })}
                >
                  <SelectTrigger data-testid="select-draft-bid-strategy">
                    <SelectValue placeholder="Keep current" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="LOWEST_COST_WITHOUT_CAP">
                      Lowest cost (no cap)
                    </SelectItem>
                    <SelectItem value="LOWEST_COST_WITH_BID_CAP">Bid cap</SelectItem>
                    <SelectItem value="COST_CAP">Cost cap</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="draft-bid-amount">
                  Bid amount{currency ? ` (${currency})` : ""}
                </Label>
                <Input
                  id="draft-bid-amount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={state.bidAmount}
                  onChange={(e) => setState({ ...state, bidAmount: e.target.value })}
                  disabled={state.bidStrategy === "LOWEST_COST_WITHOUT_CAP"}
                  data-testid="input-draft-bid-amount"
                />
                <p className="text-xs text-muted-foreground">
                  Required for bid cap and cost cap; leave blank to keep the
                  current bid. Only applies when the ad set holds its own
                  budget.
                </p>
              </div>
            </div>
          )}
          {showSchedule && (
            <div className="grid grid-cols-2 gap-4">
              <DateTimeField
                label="Start (optional)"
                value={state.startTime}
                onChange={(v) => setState({ ...state, startTime: v })}
                testId="input-draft-start"
              />
              <DateTimeField
                label="End (optional)"
                value={state.stopTime}
                onChange={(v) => setState({ ...state, stopTime: v })}
                testId="input-draft-stop"
              />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={
              createDraft.isPending ||
              (isCreate && !state.name.trim()) ||
              (isCreate && isLinkedin && !isGroupCreate && !campaignGroupId) ||
              tiktokBudgetError != null
            }
            data-testid="button-submit-draft"
          >
            {createDraft.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Save draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CreativeDraftDialog({
  connectionId,
  campaign,
  onClose,
}: {
  connectionId: number;
  campaign: { id: string; name: string };
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createDraft = useCreateAdDraft();
  const idempotencyKey = useMemo(() => crypto.randomUUID(), []);
  const [text, setText] = useState("");
  const [landingUrl, setLandingUrl] = useState("");
  const [imagePath, setImagePath] = useState<string | null>(null);

  const { data: content } = useListContent();
  const imageItems = (content ?? []).filter((i) => i.imagePath);

  const submit = () => {
    createDraft.mutate(
      {
        data: {
          connectionId,
          targetType: "creative",
          action: "create",
          idempotencyKey,
          campaignId: campaign.id,
          text: text.trim(),
          imagePath: imagePath ?? undefined,
          landingUrl: landingUrl.trim() || undefined,
        } as never,
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListAdDraftsQueryKey() });
          toast({
            title: "Creative draft created",
            description:
              "The creative is saved as a draft. The workspace owner can review and approve it under Approvals.",
          });
          onClose();
        },
        onError: (err) => {
          toast({
            variant: "destructive",
            title: "Could not create the draft",
            description:
              (err as { payload?: { error?: string } }).payload?.error ?? undefined,
          });
        },
      },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a creative to "{campaign.name}"</DialogTitle>
          <DialogDescription>
            The ad text and image are saved as a draft the workspace owner must
            approve before anything reaches LinkedIn.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="creative-text">Ad text</Label>
            <textarea
              id="creative-text"
              className="w-full min-h-24 rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={3000}
              placeholder="What should this sponsored post say?"
              data-testid="input-creative-text"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="creative-landing">Landing page URL (optional, https)</Label>
            <Input
              id="creative-landing"
              placeholder="https://example.com/offer"
              value={landingUrl}
              onChange={(e) => setLandingUrl(e.target.value)}
              data-testid="input-creative-landing"
            />
          </div>
          <div className="space-y-2">
            <Label>Image from your content library (optional)</Label>
            {imageItems.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No images in your library yet. Generate one in the studio first,
                or draft the creative as text-only.
              </p>
            ) : (
              <div className="grid grid-cols-4 gap-2 max-h-48 overflow-y-auto">
                {imageItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`relative rounded-md border-2 overflow-hidden ${
                      imagePath === item.imagePath
                        ? "border-primary"
                        : "border-transparent hover:border-muted-foreground/40"
                    }`}
                    onClick={() =>
                      setImagePath(
                        imagePath === item.imagePath ? null : (item.imagePath ?? null),
                      )
                    }
                    data-testid={`button-creative-image-${item.id}`}
                  >
                    <img
                      src={`/api/storage${item.imagePath}`}
                      alt=""
                      className="h-20 w-full object-cover"
                    />
                    {imagePath === item.imagePath && (
                      <span className="absolute top-1 right-1 rounded-full bg-primary text-primary-foreground p-0.5">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={createDraft.isPending || !text.trim()}
            data-testid="button-submit-creative-draft"
          >
            {createDraft.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Save draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const TARGETING_FACETS = [
  {
    key: "locations",
    label: "Locations",
    placeholder: "Type a country, region, or city",
    empty: "No locations selected yet.",
  },
  {
    key: "industries",
    label: "Industries",
    placeholder: "Type an industry, e.g. Software",
    empty: "No industries selected yet.",
  },
  {
    key: "jobFunctions",
    label: "Job functions",
    placeholder: "Type a job function, e.g. Marketing",
    empty: "No job functions selected yet.",
  },
  {
    key: "titles",
    label: "Job titles",
    placeholder: "Type a job title, e.g. Product Manager",
    empty: "No job titles selected yet.",
  },
] as const;

type TargetingFacetKey = (typeof TARGETING_FACETS)[number]["key"];

export function TargetingDraftDialog({
  connectionId,
  campaign,
  onClose,
}: {
  connectionId: number;
  campaign: { id: string; name: string };
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createDraft = useCreateAdDraft();
  const idempotencyKey = useMemo(() => crypto.randomUUID(), []);
  const [facet, setFacet] = useState<TargetingFacetKey>("locations");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<
    Record<TargetingFacetKey, AdsTargetingLocation[]>
  >({ locations: [], industries: [], jobFunctions: [], titles: [] });
  const [preloaded, setPreloaded] = useState(false);
  const [edited, setEdited] = useState(false);
  // Facets the user actually changed. An untouched facet is omitted from the
  // draft ("leave as is"); a touched-and-emptied facet is sent as an explicit
  // empty array ("clear this facet") — except locations, which LinkedIn
  // requires, so the last location can never be removed once preloaded.
  const [touched, setTouched] = useState<Record<TargetingFacetKey, boolean>>({
    locations: false,
    industries: false,
    jobFunctions: false,
    titles: false,
  });
  const [preloadedFacets, setPreloadedFacets] = useState<
    Record<TargetingFacetKey, boolean>
  >({ locations: false, industries: false, jobFunctions: false, titles: false });

  const {
    data: currentTargeting,
    isLoading: isLoadingCurrent,
    error: currentError,
  } = useGetLinkedinCampaignTargeting(
    { connectionId, campaignId: campaign.id },
    {
      query: {
        queryKey: getGetLinkedinCampaignTargetingQueryKey({
          connectionId,
          campaignId: campaign.id,
        }),
        staleTime: 0,
      },
    },
  );
  useRefreshConnectionsOnAuthLoss(currentError);

  useEffect(() => {
    // Never clobber selections the user already made before the fetch landed.
    if (preloaded || edited || !currentTargeting) return;
    setSelected({
      locations: currentTargeting.locations,
      industries: currentTargeting.industries,
      jobFunctions: currentTargeting.jobFunctions,
      titles: currentTargeting.titles,
    });
    setPreloadedFacets({
      locations: currentTargeting.locations.length > 0,
      industries: currentTargeting.industries.length > 0,
      jobFunctions: currentTargeting.jobFunctions.length > 0,
      titles: currentTargeting.titles.length > 0,
    });
    setPreloaded(true);
  }, [currentTargeting, preloaded, edited]);

  const activeFacet = TARGETING_FACETS.find((f) => f.key === facet)!;
  const trimmed = query.trim();
  const { data: searchData, isFetching, error: searchError } = useSearchLinkedinTargeting(
    { connectionId, facet, q: trimmed },
    {
      query: {
        enabled: trimmed.length >= 2,
        queryKey: getSearchLinkedinTargetingQueryKey({ connectionId, facet, q: trimmed }),
      },
    },
  );
  useRefreshConnectionsOnAuthLoss(searchError);

  const addEntity = (loc: AdsTargetingLocation) => {
    setEdited(true);
    setTouched((prev) => (prev[facet] ? prev : { ...prev, [facet]: true }));
    setSelected((prev) =>
      prev[facet].some((s) => s.urn === loc.urn)
        ? prev
        : { ...prev, [facet]: [...prev[facet], loc] },
    );
    setQuery("");
  };

  const removeEntity = (key: TargetingFacetKey, urn: string) => {
    if (
      key === "locations" &&
      preloadedFacets.locations &&
      selected.locations.length <= 1
    ) {
      // LinkedIn requires every campaign to target at least one location, so
      // a preloaded location facet can never be emptied.
      toast({
        variant: "destructive",
        title: "At least one location is required",
        description:
          "LinkedIn campaigns must target at least one location. Add a replacement location before removing this one.",
      });
      return;
    }
    setEdited(true);
    setTouched((prev) => (prev[key] ? prev : { ...prev, [key]: true }));
    setSelected((prev) => ({
      ...prev,
      [key]: prev[key].filter((s) => s.urn !== urn),
    }));
  };

  const totalSelected = TARGETING_FACETS.reduce(
    (n, f) => n + selected[f.key].length,
    0,
  );

  const submit = () => {
    createDraft.mutate(
      {
        data: {
          connectionId,
          targetType: "campaign",
          action: "update",
          targetId: campaign.id,
          idempotencyKey,
          // Locations: never sent empty (LinkedIn requires at least one; the
          // UI blocks removing the last preloaded location).
          ...(selected.locations.length > 0
            ? { targetingLocations: selected.locations }
            : {}),
          // Other facets: non-empty selections replace the facet. A facet the
          // user emptied out (touched + preloaded non-empty) is sent as an
          // explicit empty array, which the server treats as "clear this
          // facet". Untouched empty facets stay omitted ("leave as is").
          ...(selected.industries.length > 0 ||
          (touched.industries && preloadedFacets.industries)
            ? { targetingIndustries: selected.industries }
            : {}),
          ...(selected.jobFunctions.length > 0 ||
          (touched.jobFunctions && preloadedFacets.jobFunctions)
            ? { targetingJobFunctions: selected.jobFunctions }
            : {}),
          ...(selected.titles.length > 0 ||
          (touched.titles && preloadedFacets.titles)
            ? { targetingTitles: selected.titles }
            : {}),
        } as never,
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListAdDraftsQueryKey() });
          toast({
            title: "Targeting draft created",
            description:
              "The targeting change is saved as a draft. The workspace owner can review and approve it under Approvals.",
          });
          onClose();
        },
        onError: (err) => {
          toast({
            variant: "destructive",
            title: "Could not create the draft",
            description:
              (err as { payload?: { error?: string } }).payload?.error ?? undefined,
          });
        },
      },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit targeting for "{campaign.name}"</DialogTitle>
          <DialogDescription>
            Pick the audience this campaign should target. The change is saved
            as a draft the workspace owner must approve; each facet you set
            replaces that part of the campaign's current targeting.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {isLoadingCurrent && (
            <p
              className="text-sm text-muted-foreground"
              data-testid="text-targeting-loading"
            >
              Loading the campaign's current targeting...
            </p>
          )}
          {!isLoadingCurrent && currentError != null && (
            <p
              className="text-sm text-muted-foreground"
              data-testid="text-targeting-load-error"
            >
              Could not load the campaign's current targeting. You can still
              pick a new audience below.
            </p>
          )}
          <div className="flex flex-wrap gap-1">
            {TARGETING_FACETS.map((f) => (
              <Button
                key={f.key}
                type="button"
                size="sm"
                variant={facet === f.key ? "default" : "outline"}
                onClick={() => {
                  setFacet(f.key);
                  setQuery("");
                }}
                data-testid={`button-facet-${f.key}`}
              >
                {f.label}
                {selected[f.key].length > 0 && ` (${selected[f.key].length})`}
              </Button>
            ))}
          </div>
          <div className="space-y-2">
            <Label htmlFor="targeting-search">Search {activeFacet.label.toLowerCase()}</Label>
            <Input
              id="targeting-search"
              placeholder={activeFacet.placeholder}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              data-testid="input-targeting-search"
            />
            {trimmed.length >= 2 && (
              <div className="rounded-md border max-h-40 overflow-y-auto">
                {isFetching && (
                  <div className="p-2 text-sm text-muted-foreground">Searching...</div>
                )}
                {!isFetching && (searchData?.results ?? []).length === 0 && (
                  <div className="p-2 text-sm text-muted-foreground">No matches.</div>
                )}
                {(searchData?.results ?? []).map((loc) => (
                  <button
                    key={loc.urn}
                    type="button"
                    className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted"
                    onClick={() => addEntity(loc)}
                    data-testid={`button-targeting-result-${loc.urn}`}
                  >
                    {loc.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          {facet === "locations" && (
            <p
              className="text-xs text-muted-foreground"
              data-testid="text-locations-required-note"
            >
              LinkedIn requires every campaign to target at least one location,
              so locations can be replaced but never emptied. Add a replacement
              before removing the last one.
            </p>
          )}
          {TARGETING_FACETS.map((f) => (
            <div key={f.key} className="space-y-2">
              <Label>Selected {f.label.toLowerCase()}</Label>
              {selected[f.key].length === 0 ? (
                <p className="text-sm text-muted-foreground">{f.empty}</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {selected[f.key].map((loc) => (
                    <Badge key={loc.urn} variant="secondary" className="gap-1">
                      {loc.name}
                      <button
                        type="button"
                        onClick={() => removeEntity(f.key, loc.urn)}
                        data-testid={`button-remove-targeting-${loc.urn}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={createDraft.isPending || totalSelected === 0}
            data-testid="button-submit-targeting-draft"
          >
            {createDraft.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Save draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DraftsSection({
  isOwner,
  canManage,
  currency = null,
}: {
  isOwner: boolean;
  canManage: boolean;
  currency?: string | null;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: drafts, isLoading } = useListAdDrafts();
  const approve = useApproveAdDraft();
  const reject = useRejectAdDraft();
  const [confirming, setConfirming] = useState<AdsDraft | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListAdDraftsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListAdsChangeLogQueryKey() });
    queryClient.invalidateQueries({
      predicate: (q) =>
        Array.isArray(q.queryKey) &&
        typeof q.queryKey[0] === "string" &&
        (q.queryKey[0].includes("/ads/campaigns") ||
          q.queryKey[0].includes("/ads/campaign-detail") ||
          q.queryKey[0].includes("/ads/linkedin/campaign-groups")),
    });
  };

  const handleApprove = (draft: AdsDraft) => {
    approve.mutate(
      { id: draft.id },
      {
        onSuccess: (res) => {
          invalidate();
          setConfirming(null);
          if (res.status === "applied") {
            toast({
              title: "Change applied",
              description:
                res.verifyStatus === "verified"
                  ? "The change was applied and verified on the ad platform."
                  : "The change was applied. Verification will catch up shortly.",
            });
          } else if (res.status === "expired") {
            toast({
              variant: "destructive",
              title: "Draft expired",
              description:
                res.failureReason ??
                "The target changed on the ad platform since this draft was created.",
            });
          } else {
            // A revoked/expired grant marks the connection failed server-side;
            // refetch connections so the Reconnect prompt appears immediately.
            if (res.authLost) {
              queryClient.invalidateQueries({
                queryKey: getListAdConnectionsQueryKey(),
              });
            }
            toast({
              variant: "destructive",
              title: "Change failed",
              description: res.failureReason ?? "The ad platform rejected the change.",
            });
          }
        },
        onError: (err) => {
          setConfirming(null);
          toast({
            variant: "destructive",
            title: "Could not apply the change",
            description:
              (err as { payload?: { error?: string } }).payload?.error ?? undefined,
          });
        },
      },
    );
  };

  const handleReject = (draft: AdsDraft) => {
    reject.mutate(
      { id: draft.id },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Draft rejected" });
        },
      },
    );
  };

  if (isLoading) return <Skeleton className="h-40 w-full" />;

  const pending = (drafts ?? []).filter((d) => d.status === "draft");
  const past = (drafts ?? []).filter((d) => d.status !== "draft");

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" /> Awaiting approval
          </CardTitle>
          <CardDescription>
            {isOwner
              ? "Review each change carefully — approving applies it to your live ad account."
              : "Only the workspace owner can approve these changes."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {pending.length === 0 ? (
            <p className="text-sm text-muted-foreground">No drafts waiting for approval.</p>
          ) : (
            <div className="space-y-4">
              {pending.map((d) => (
                <div
                  key={d.id}
                  className="border rounded-lg p-4 space-y-3"
                  data-testid={`card-draft-${d.id}`}
                >
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="font-medium">
                      {d.action === "create" ? "Create" : "Update"} {d.targetType.replace("_", " ")}:{" "}
                      {d.targetName}
                    </div>
                    {draftStatusBadge(d.status)}
                  </div>
                  <DiffList changes={d.changes} />
                  <div className="text-xs text-muted-foreground">
                    Drafted by {d.createdByEmail ?? "a teammate"} on{" "}
                    {new Date(d.createdAt).toLocaleString()}
                  </div>
                  {canManage && (
                    <div className="flex gap-2">
                      {isOwner && (
                        <Button
                          size="sm"
                          onClick={() => setConfirming(d)}
                          disabled={approve.isPending}
                          data-testid={`button-approve-draft-${d.id}`}
                        >
                          Approve and apply
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleReject(d)}
                        disabled={reject.isPending}
                        data-testid={`button-reject-draft-${d.id}`}
                      >
                        Reject
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {past.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Recent drafts</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {past.slice(0, 20).map((d) => (
              <div
                key={d.id}
                className="flex items-center justify-between gap-3 border-b last:border-b-0 pb-3 last:pb-0"
              >
                <div className="min-w-0">
                  <div className="font-medium truncate">
                    {d.action === "create" ? "Create" : "Update"} {d.targetType.replace("_", " ")}:{" "}
                    {d.targetName}
                  </div>
                  {d.failureReason && (
                    <div className="text-xs text-destructive truncate">{d.failureReason}</div>
                  )}
                </div>
                {draftStatusBadge(d.status)}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {confirming && (
        <ApproveConfirmDialog
          draft={confirming}
          currency={currency}
          applying={approve.isPending}
          onCancel={() => setConfirming(null)}
          onConfirm={() => handleApprove(confirming)}
        />
      )}
    </div>
  );
}

function ApproveConfirmDialog({
  draft,
  currency,
  applying,
  onCancel,
  onConfirm,
}: {
  draft: AdsDraft;
  currency: string | null;
  applying: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const increases = useMemo(
    () => findLargeBudgetIncreases(draft.changes),
    [draft.changes],
  );
  const [acknowledged, setAcknowledged] = useState(false);
  const needsAck = increases.length > 0;

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Apply this change to your ad account?</DialogTitle>
          <DialogDescription>
            This will {draft.action === "create" ? "create" : "modify"}{" "}
            "{draft.targetName}" on{" "}
            {draft.platform === "meta" ? "Meta" : draft.platform}. The change is
            verified after it is applied and recorded in the change history.
          </DialogDescription>
        </DialogHeader>
        <DiffList changes={draft.changes} />
        {needsAck && (
          <div
            className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 space-y-3"
            data-testid="warning-budget-increase"
          >
            <div className="flex items-start gap-2">
              <TrendingUp className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-sm font-semibold text-destructive">
                  Large budget increase
                </p>
                {increases.map((inc) => (
                  <p key={inc.field} className="text-sm">
                    {inc.field.replace(" (minor units)", "")} jumps from{" "}
                    {formatMoneyMinor(inc.before, currency)} to{" "}
                    {formatMoneyMinor(inc.after, currency)} — about{" "}
                    {Math.round(inc.factor * 10) / 10}x the current budget.
                  </p>
                ))}
                <p className="text-sm text-muted-foreground">
                  Double-check the amount before applying — an extra digit here
                  spends real money.
                </p>
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
              <Checkbox
                checked={acknowledged}
                onCheckedChange={(v) => setAcknowledged(v === true)}
                data-testid="checkbox-acknowledge-budget-increase"
              />
              I have checked the new budget and want to spend this much
            </label>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            disabled={applying || (needsAck && !acknowledged)}
            data-testid="button-confirm-approve"
          >
            {applying && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Approve and apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DiffList({
  changes,
}: {
  changes: {
    field: string;
    before?: string | null;
    after?: string | null;
    afterDetail?: string | null;
  }[];
}) {
  return (
    <div className="space-y-1">
      {changes.map((c, i) => (
        <div key={i} className="text-sm flex items-center gap-2 flex-wrap">
          <span className="text-muted-foreground w-52 shrink-0">{c.field}</span>
          <span className={c.before == null ? "text-muted-foreground italic" : ""}>
            {c.before ?? "(new)"}
          </span>
          <ArrowRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="font-medium">{c.after ?? "—"}</span>
          {c.afterDetail && (
            <span className="text-xs text-muted-foreground">{c.afterDetail}</span>
          )}
        </div>
      ))}
    </div>
  );
}

function ChangeLogSection() {
  const { data: entries, isLoading } = useListAdsChangeLog();

  if (isLoading) return <Skeleton className="h-40 w-full" />;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Change history</CardTitle>
        <CardDescription>
          Every applied advertising change, who approved it, and whether the
          platform confirmed it. This log cannot be edited.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {(entries ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No changes applied yet.</p>
        ) : (
          <div className="space-y-4">
            {(entries ?? []).map((e) => (
              <div
                key={e.id}
                className="border rounded-lg p-4 space-y-2"
                data-testid={`card-log-${e.id}`}
              >
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="font-medium">
                    {e.action === "create" ? "Created" : "Updated"} {e.targetType.replace("_", " ")}:{" "}
                    {e.targetName}
                  </div>
                  <div className="flex gap-2">
                    {e.outcome === "applied" ? (
                      <Badge>Applied</Badge>
                    ) : (
                      <Badge variant="destructive">Failed</Badge>
                    )}
                    {e.verifyStatus === "verified" && (
                      <Badge variant="outline">Verified</Badge>
                    )}
                    {e.verifyStatus === "mismatch" && (
                      <Badge variant="destructive">Verify mismatch</Badge>
                    )}
                  </div>
                </div>
                <DiffList changes={e.changes} />
                {e.failureReason && (
                  <p className="text-xs text-destructive">{e.failureReason}</p>
                )}
                <div className="text-xs text-muted-foreground">
                  Approved by {e.approvedByEmail ?? "the workspace owner"} on{" "}
                  {new Date(e.createdAt).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
