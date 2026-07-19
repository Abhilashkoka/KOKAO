import { useMemo, useState } from "react";
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
  getListAdDraftsQueryKey,
  getListAdsChangeLogQueryKey,
  type AdsDraft,
  type AdAccountConnection,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
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
  ArrowRight,
  Pencil,
  Plus,
  ShieldCheck,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";

/**
 * Budget diff fields produced by the server ("Daily budget (minor units)" /
 * "Lifetime budget (minor units)"). A change counts as a LARGE increase when
 * the new budget is at least 2x the current one.
 */
const LARGE_INCREASE_FACTOR = 2;

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

function formatSpend(spend: number, currency: string | null) {
  return `${currency ? `${currency} ` : ""}${spend.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
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
};

export function AdsPage() {
  const { data: me } = useGetMe();
  const { data: status, isLoading: statusLoading } = useGetAdsStatus();
  const { data: connections, isLoading: connectionsLoading } = useListAdConnections();

  const isOwner = !me?.team || me.team.role === "owner";
  const canManage = isOwner || me?.team?.role === "admin";

  const metaConn = connections?.find((c) => c.platform === "meta");
  const linkedinConn = connections?.find((c) => c.platform === "linkedin");
  const tiktokConn = connections?.find((c) => c.platform === "tiktok");
  const connectedConns = (connections ?? []).filter((c) => c.status === "connected");
  const [activeConnId, setActiveConnId] = useState<number | null>(null);
  const connectedConn =
    connectedConns.find((c) => c.id === activeConnId) ?? connectedConns[0];

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

      <div className="grid gap-4 lg:grid-cols-2">
        <ConnectionSection
          metaConn={metaConn}
          metaAvailable={status?.platforms.find((p) => p.platform === "meta")?.available ?? false}
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
          <Label>Manage platform</Label>
          <Select
            value={String(connectedConn.id)}
            onValueChange={(v) => setActiveConnId(Number(v))}
          >
            <SelectTrigger className="w-72" data-testid="select-active-connection">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {connectedConns.map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>
                  {c.platform === "meta"
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
            <DraftsSection isOwner={isOwner} canManage={canManage} />
          </TabsContent>
          <TabsContent value="history" className="mt-6">
            <ChangeLogSection />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

function ConnectionSection({
  metaConn,
  metaAvailable,
  canManage,
}: {
  metaConn: AdAccountConnection | undefined;
  metaAvailable: boolean;
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
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Megaphone className="h-5 w-5" /> Meta Ads
        </CardTitle>
        <CardDescription>
          Connect the Meta ad account behind your Facebook and Instagram
          campaigns.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
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
        {!metaAvailable && !metaConn && (
          <p className="text-sm text-muted-foreground">
            Meta Ads is not yet available. The platform administrator has not
            configured Meta app credentials.
          </p>
        )}
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
    </Card>
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
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Megaphone className="h-5 w-5" /> LinkedIn Ads
        </CardTitle>
        <CardDescription>
          Connect the LinkedIn ad account behind your sponsored campaigns.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
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
        {!available && !linkedinConn && (
          <p className="text-sm text-muted-foreground">
            LinkedIn Ads is not yet available. The platform administrator has
            not configured LinkedIn app credentials.
          </p>
        )}
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
    setDaily(caps?.maxDailyBudget != null ? String(caps.maxDailyBudget) : "");
    setLifetime(caps?.maxLifetimeBudget != null ? String(caps.maxLifetimeBudget) : "");
    setEditing(true);
  };

  const save = () => {
    const parse = (v: string): number | null | undefined => {
      if (!v.trim()) return null;
      const n = Number(v);
      return Number.isInteger(n) && n > 0 ? n : undefined;
    };
    const maxDailyBudget = parse(daily);
    const maxLifetimeBudget = parse(lifetime);
    if (maxDailyBudget === undefined || maxLifetimeBudget === undefined) {
      toast({
        variant: "destructive",
        title: "Invalid cap",
        description: "Caps must be positive whole amounts in minor units, or left empty for no cap.",
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
    v != null ? `${formatMoneyMinor(v, currency)} (${v.toLocaleString()} minor units)` : "No cap";

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
                <Label htmlFor="cap-daily">Max daily budget (minor units)</Label>
                <Input
                  id="cap-daily"
                  type="number"
                  min="1"
                  placeholder="No cap"
                  value={daily}
                  onChange={(e) => setDaily(e.target.value)}
                  data-testid="input-cap-daily"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cap-lifetime">Max lifetime budget (minor units)</Label>
                <Input
                  id="cap-lifetime"
                  type="number"
                  min="1"
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
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TrendingUp className="h-5 w-5" /> TikTok Ads
        </CardTitle>
        <CardDescription>
          Connect the TikTok for Business advertiser account behind your TikTok
          campaigns.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
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
        {!tiktokAvailable && !tiktokConn && (
          <p className="text-sm text-muted-foreground">
            TikTok Ads is not yet available. The platform administrator has not
            configured TikTok app credentials.
          </p>
        )}
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
  const [draftForm, setDraftForm] = useState<DraftFormState | null>(null);
  const [detailCampaignId, setDetailCampaignId] = useState<string | null>(null);

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
            onClick={() => setDraftForm({ ...EMPTY_FORM, action: "create" })}
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
                    <TableCell className="text-right">
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

      {detailCampaignId && (
        <CampaignDetailDialog
          connectionId={connection.id}
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
          form={draftForm}
          onClose={() => setDraftForm(null)}
        />
      )}
    </div>
  );
}

function CampaignDetailDialog({
  connectionId,
  campaignId,
  datePreset,
  currency,
  canManage,
  onEdit,
  onClose,
}: {
  connectionId: number;
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
                      <TableHead className="text-right">Budget</TableHead>
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
                        <TableCell className="text-right whitespace-nowrap">
                          {s.dailyBudget != null
                            ? `${formatMoneyMinor(s.dailyBudget, currency)}/day`
                            : formatMoneyMinor(s.lifetimeBudget, currency)}
                        </TableCell>
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
                        <TableCell className="font-medium">{a.name}</TableCell>
                        <TableCell>{statusBadge(a.effectiveStatus)}</TableCell>
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
                          {canManage && (
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
      </DialogContent>
    </Dialog>
  );
}

function DraftDialog({
  connectionId,
  platform,
  form,
  onClose,
}: {
  connectionId: number;
  platform: string;
  form: DraftFormState;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createDraft = useCreateAdDraft();
  const isTiktok = platform === "tiktok";
  const [state, setState] = useState(() =>
    isTiktok && form.action === "create" && form.objective === "OUTCOME_TRAFFIC"
      ? { ...form, objective: "TRAFFIC" }
      : form,
  );
  const [campaignGroupId, setCampaignGroupId] = useState("");
  const idempotencyKey = useMemo(() => crypto.randomUUID(), []);

  const isCreate = state.action === "create";
  const targetLabel =
    state.targetType === "adset" ? "ad set" : state.targetType === "ad" ? "ad" : "campaign";
  const showBudgets = state.targetType !== "ad";
  const showSchedule = state.targetType === "campaign";

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

  const submit = () => {
    const data: Record<string, unknown> = {
      connectionId,
      targetType: state.targetType,
      action: state.action,
      idempotencyKey,
    };
    if (!isCreate) data.targetId = state.targetId;
    if (isCreate || state.name !== state.currentName) data.name = state.name;
    if (state.status) data.status = state.status;
    if (isCreate && !isLinkedin && state.objective) data.objective = state.objective;
    if (isCreate && isLinkedin && campaignGroupId) data.campaignGroupId = campaignGroupId;
    if (showBudgets && state.dailyBudget) data.dailyBudget = Number(state.dailyBudget);
    if (showBudgets && state.lifetimeBudget) {
      data.lifetimeBudget = Number(state.lifetimeBudget);
    }
    if (!isTiktok && showSchedule && state.startTime) data.startTime = state.startTime;
    if (!isTiktok && showSchedule && state.stopTime) data.stopTime = state.stopTime;

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
              ? "Draft a new campaign"
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
              data-testid="input-draft-name"
            />
          </div>
          {isCreate && isLinkedin && (
            <div className="space-y-2">
              <Label>Campaign group</Label>
              <Select value={campaignGroupId} onValueChange={setCampaignGroupId}>
                <SelectTrigger data-testid="select-draft-campaign-group">
                  <SelectValue placeholder="Choose a campaign group" />
                </SelectTrigger>
                <SelectContent>
                  {(groupData?.groups ?? []).map((g) => (
                    <SelectItem key={g.id} value={g.id}>
                      {g.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
              <div className="space-y-2">
                <Label htmlFor="draft-daily-budget">Daily budget (minor units)</Label>
                <Input
                  id="draft-daily-budget"
                  type="number"
                  min="0"
                  value={state.dailyBudget}
                  onChange={(e) => setState({ ...state, dailyBudget: e.target.value })}
                  data-testid="input-draft-daily-budget"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="draft-lifetime-budget">Lifetime budget (minor units)</Label>
                <Input
                  id="draft-lifetime-budget"
                  type="number"
                  min="0"
                  value={state.lifetimeBudget}
                  onChange={(e) => setState({ ...state, lifetimeBudget: e.target.value })}
                  data-testid="input-draft-lifetime-budget"
                />
              </div>
            </div>
          )}
          {!isTiktok && showSchedule && (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="draft-start">Start (ISO time, optional)</Label>
                <Input
                  id="draft-start"
                  placeholder="2026-08-01T00:00:00+0000"
                  value={state.startTime}
                  onChange={(e) => setState({ ...state, startTime: e.target.value })}
                  data-testid="input-draft-start"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="draft-stop">End (ISO time, optional)</Label>
                <Input
                  id="draft-stop"
                  placeholder="2026-08-31T00:00:00+0000"
                  value={state.stopTime}
                  onChange={(e) => setState({ ...state, stopTime: e.target.value })}
                  data-testid="input-draft-stop"
                />
              </div>
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
              (isCreate && isLinkedin && !campaignGroupId)
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

function DraftsSection({
  isOwner,
  canManage,
}: {
  isOwner: boolean;
  canManage: boolean;
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
          q.queryKey[0].includes("/ads/campaign-detail")),
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
                      {d.action === "create" ? "Create" : "Update"} {d.targetType}:{" "}
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
                    {d.action === "create" ? "Create" : "Update"} {d.targetType}:{" "}
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
  applying,
  onCancel,
  onConfirm,
}: {
  draft: AdsDraft;
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
                    {inc.before.toLocaleString()} to {inc.after.toLocaleString()}{" "}
                    minor units — about {Math.round(inc.factor * 10) / 10}x the
                    current budget.
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
  changes: { field: string; before?: string | null; after?: string | null }[];
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
                    {e.action === "create" ? "Created" : "Updated"} {e.targetType}:{" "}
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
