import { useState, useEffect } from "react";
import {
  useAdminListTenants,
  useAdminGetStats,
  useAdminUpdateTenantPlan,
  useAdminUpdateTenantSuperadmin,
  useAdminGetMetaCredentials,
  useAdminSaveMetaCredentials,
  useAdminGetTwitterCredentials,
  useAdminSaveTwitterCredentials,
  useAdminListNotificationPolicies,
  useAdminUpdateNotificationPolicies,
  getAdminListTenantsQueryKey,
  getAdminGetStatsQueryKey,
  getAdminGetMetaCredentialsQueryKey,
  getAdminGetTwitterCredentialsQueryKey,
  getAdminListNotificationPoliciesQueryKey,
  useGetMe,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
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
import {
  Users,
  Layers,
  Calendar,
  Share2,
  ShieldAlert,
  CheckCircle2,
  AlertCircle,
  Loader2,
} from "lucide-react";

const PLAN_LABELS: Record<string, string> = {
  free: "Free",
  pro: "Pro",
  business: "Business",
};

function isForbidden(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: number }).status === 403
  );
}

function MetaCredentialsCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useAdminGetMetaCredentials();
  const saveMeta = useAdminSaveMetaCredentials();

  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [dirty, setDirty] = useState(false);

  // Prefill the App ID field with the masked value once loaded so admins can
  // see something is configured. Secret stays blank (write-only).
  useEffect(() => {
    if (data && !dirty) {
      setAppId(data.appIdMasked ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const handleSave = () => {
    if (!appId.trim() || !appSecret.trim()) return;
    saveMeta.mutate(
      { data: { appId: appId.trim(), appSecret: appSecret.trim() } },
      {
        onSuccess: (res) => {
          queryClient.invalidateQueries({
            queryKey: getAdminGetMetaCredentialsQueryKey(),
          });
          setAppSecret("");
          setDirty(false);
          if (res.testStatus === "verified") {
            toast({
              title: "Meta credentials verified",
              description: "The app keys were saved and tested successfully.",
            });
          } else {
            toast({
              variant: "destructive",
              title: "Saved, but verification failed",
              description:
                res.testError ||
                "The app keys were saved but Meta rejected them. Double-check the App ID and Secret.",
            });
          }
        },
        onError: (err: any) => {
          toast({
            variant: "destructive",
            title: "Could not save",
            description:
              err?.response?.data?.error || "Please try again.",
          });
        },
      },
    );
  };

  const status = data?.testStatus;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Meta (Facebook & Instagram) app credentials</CardTitle>
        <CardDescription>
          One-time platform setup. Enter your Meta app's App ID and App Secret.
          Every workspace then connects their own Facebook Page and Instagram
          account on the Accounts page. Secrets are encrypted at rest and never
          shown again.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 max-w-xl">
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (
          <>
            {data?.configured && (
              <div className="flex items-center gap-2 text-sm">
                {status === "verified" ? (
                  <span className="text-green-600 flex items-center gap-1">
                    <CheckCircle2 className="h-4 w-4" /> Verified with Meta
                  </span>
                ) : status === "failed" ? (
                  <span className="text-destructive flex items-center gap-1">
                    <AlertCircle className="h-4 w-4" /> Verification failed
                    {data.testError ? `: ${data.testError}` : ""}
                  </span>
                ) : (
                  <span className="text-muted-foreground">Saved</span>
                )}
              </div>
            )}
            <div className="space-y-2">
              <label className="text-sm font-medium">App ID</label>
              <Input
                value={appId}
                onChange={(e) => {
                  setAppId(e.target.value);
                  setDirty(true);
                }}
                placeholder="1234567890123456"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">App Secret</label>
              <Input
                type="password"
                value={appSecret}
                onChange={(e) => {
                  setAppSecret(e.target.value);
                  setDirty(true);
                }}
                placeholder={
                  data?.configured ? "Enter to replace the saved secret" : "App Secret"
                }
              />
              <p className="text-xs text-muted-foreground">
                Find both in the Meta app dashboard under Settings &gt; Basic at{" "}
                developers.facebook.com/apps.
              </p>
            </div>
            <Button
              onClick={handleSave}
              disabled={saveMeta.isPending || !appId.trim() || !appSecret.trim()}
            >
              {saveMeta.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Saving &
                  testing...
                </>
              ) : (
                "Save and test"
              )}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function TwitterCredentialsCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useAdminGetTwitterCredentials();
  const saveTwitter = useAdminSaveTwitterCredentials();

  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (data && !dirty) {
      setClientId(data.clientIdMasked ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const copyRedirect = () => {
    if (!data?.redirectUri) return;
    navigator.clipboard.writeText(data.redirectUri);
    toast({ title: "Callback URL copied" });
  };

  const handleSave = () => {
    if (!clientId.trim() || !clientSecret.trim()) return;
    saveTwitter.mutate(
      { data: { clientId: clientId.trim(), clientSecret: clientSecret.trim() } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getAdminGetTwitterCredentialsQueryKey(),
          });
          setClientSecret("");
          setDirty(false);
          toast({
            title: "X credentials saved",
            description:
              "Workspaces can now connect their X account on the Accounts page.",
          });
        },
        onError: (err: any) => {
          toast({
            variant: "destructive",
            title: "Could not save",
            description: err?.response?.data?.error || "Please try again.",
          });
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>X (Twitter) app credentials</CardTitle>
        <CardDescription>
          One-time platform setup. Enter your X app's OAuth 2.0 Client ID and
          Client Secret (a confidential client). Every workspace then connects
          their own X account through the OAuth 2.0 flow on the Accounts page.
          Secrets are encrypted at rest and never shown again.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 max-w-xl">
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (
          <>
            {data?.configured && (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-green-600 flex items-center gap-1">
                  <CheckCircle2 className="h-4 w-4" /> Saved
                </span>
              </div>
            )}
            {data?.redirectUri && (
              <div className="space-y-2">
                <label className="text-sm font-medium">
                  Callback URL (register this in your X app)
                </label>
                <div className="flex items-center gap-2">
                  <Input readOnly value={data.redirectUri} />
                  <Button type="button" variant="outline" onClick={copyRedirect}>
                    Copy
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Add this exact URL to your X app's OAuth 2.0 "Callback URI /
                  Redirect URL" list, and set the app type to a confidential
                  client with Read and Write permissions.
                </p>
              </div>
            )}
            <div className="space-y-2">
              <label className="text-sm font-medium">Client ID</label>
              <Input
                value={clientId}
                onChange={(e) => {
                  setClientId(e.target.value);
                  setDirty(true);
                }}
                placeholder="OAuth 2.0 Client ID"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Client Secret</label>
              <Input
                type="password"
                value={clientSecret}
                onChange={(e) => {
                  setClientSecret(e.target.value);
                  setDirty(true);
                }}
                placeholder={
                  data?.configured
                    ? "Enter to replace the saved secret"
                    : "OAuth 2.0 Client Secret"
                }
              />
              <p className="text-xs text-muted-foreground">
                Create an app in the X developer portal at developer.x.com,
                enable OAuth 2.0, and copy the Client ID and Client Secret from
                the app's Keys and tokens tab.
              </p>
            </div>
            <Button
              onClick={handleSave}
              disabled={
                saveTwitter.isPending || !clientId.trim() || !clientSecret.trim()
              }
            >
              {saveTwitter.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Saving...
                </>
              ) : (
                "Save"
              )}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

const EMAIL_POLICY_LABELS: Record<string, string> = {
  optional: "User choice",
  forced: "Always on",
  off: "Never",
};

function NotificationPoliciesCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useAdminListNotificationPolicies();
  const update = useAdminUpdateNotificationPolicies();

  const [state, setState] = useState<
    Record<string, { enabled: boolean; emailPolicy: string }>
  >({});

  useEffect(() => {
    if (data) {
      const next: Record<string, { enabled: boolean; emailPolicy: string }> = {};
      for (const p of data) {
        next[p.type] = { enabled: p.enabled, emailPolicy: p.emailPolicy };
      }
      setState(next);
    }
  }, [data]);

  const handleSave = () => {
    if (!data) return;
    const policies = data.map((p) => ({
      type: p.type,
      enabled: state[p.type]?.enabled ?? p.enabled,
      emailPolicy: (state[p.type]?.emailPolicy ??
        p.emailPolicy) as "optional" | "forced" | "off",
    }));
    update.mutate(
      { data: { policies } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getAdminListNotificationPoliciesQueryKey(),
          });
          toast({ title: "Notification policies saved" });
        },
        onError: () => {
          toast({
            variant: "destructive",
            title: "Could not save",
            description: "Please try again.",
          });
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Notification policies</CardTitle>
        <CardDescription>
          Platform-wide defaults for each notification type. Turn a type off to
          silence it for everyone, or set whether email is the user's choice,
          always sent, or never sent. Users adjust their own in-app and email
          preferences within these limits.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 max-w-2xl">
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : (
          <>
            {(data ?? []).map((p) => {
              const cur = state[p.type] ?? {
                enabled: p.enabled,
                emailPolicy: p.emailPolicy,
              };
              return (
                <div
                  key={p.type}
                  className="rounded-xl border border-border p-4 space-y-4"
                >
                  <div>
                    <p className="font-semibold text-sm">{p.label}</p>
                    <p className="text-sm text-muted-foreground">
                      {p.description}
                    </p>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm">Enabled</span>
                    <Switch
                      checked={cur.enabled}
                      onCheckedChange={(checked) =>
                        setState((prev) => ({
                          ...prev,
                          [p.type]: { ...cur, enabled: checked },
                        }))
                      }
                      aria-label={`Toggle ${p.label}`}
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm">Email delivery</span>
                    <Select
                      value={cur.emailPolicy}
                      disabled={!cur.enabled}
                      onValueChange={(value) =>
                        setState((prev) => ({
                          ...prev,
                          [p.type]: { ...cur, emailPolicy: value },
                        }))
                      }
                    >
                      <SelectTrigger className="w-40">
                        <SelectValue>
                          {EMAIL_POLICY_LABELS[cur.emailPolicy] ??
                            cur.emailPolicy}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="optional">User choice</SelectItem>
                        <SelectItem value="forced">Always on</SelectItem>
                        <SelectItem value="off">Never</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              );
            })}
            <Button onClick={handleSave} disabled={update.isPending}>
              Save policies
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function AdminPage() {
  const { data: me } = useGetMe();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const {
    data: tenants,
    isLoading: tenantsLoading,
    error: tenantsError,
  } = useAdminListTenants();
  const {
    data: stats,
    isLoading: statsLoading,
    error: statsError,
  } = useAdminGetStats();
  const updatePlan = useAdminUpdateTenantPlan();
  const updateSuperadmin = useAdminUpdateTenantSuperadmin();

  // Deny on the cached hint OR when the server authoritatively returns 403 —
  // the latter covers live revocation even while `me` is still stale-cached.
  const accessDenied =
    (me && !me.isSuperadmin) ||
    isForbidden(tenantsError) ||
    isForbidden(statsError);

  if (accessDenied) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <ShieldAlert className="h-12 w-12 text-muted-foreground mb-4" />
        <h1 className="text-2xl font-bold">Access denied</h1>
        <p className="text-muted-foreground mt-2">
          You do not have permission to view this page.
        </p>
      </div>
    );
  }

  const handlePlanChange = (tenantId: number, plan: string) => {
    updatePlan.mutate(
      { id: tenantId, data: { plan: plan as "free" | "pro" | "business" } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getAdminListTenantsQueryKey(),
          });
          queryClient.invalidateQueries({
            queryKey: getAdminGetStatsQueryKey(),
          });
          toast({ title: "Plan updated", description: "Tenant plan changed successfully." });
        },
        onError: () => {
          toast({
            title: "Update failed",
            description: "Could not update the tenant plan.",
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

  const statCards = [
    { label: "Total Tenants", value: stats?.totalTenants, icon: Users },
    { label: "Total Content", value: stats?.totalContent, icon: Layers },
    {
      label: "Scheduled Posts",
      value: stats?.totalScheduledPosts,
      icon: Calendar,
    },
    {
      label: "Connected Accounts",
      value: stats?.totalConnectedAccounts,
      icon: Share2,
    },
  ];

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-extrabold tracking-tight">Admin</h1>
        <p className="text-muted-foreground text-lg mt-1">
          Platform-wide view of all workspaces and usage.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        {statCards.map((card) => (
          <Card key={card.label}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {card.label}
              </CardTitle>
              <card.icon className="h-5 w-5 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {statsLoading ? (
                <Skeleton className="h-9 w-16" />
              ) : (
                <div className="text-3xl font-bold">{card.value ?? 0}</div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {stats && !statsLoading && (
        <div className="flex flex-wrap gap-3">
          <Badge variant="secondary">Free: {stats.tenantsByPlan.free}</Badge>
          <Badge variant="secondary">Pro: {stats.tenantsByPlan.pro}</Badge>
          <Badge variant="secondary">
            Business: {stats.tenantsByPlan.business}
          </Badge>
        </div>
      )}

      <MetaCredentialsCard />
      <TwitterCredentialsCard />
      <NotificationPoliciesCard />

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
                              {PLAN_LABELS[t.plan] ?? t.plan}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="free">Free</SelectItem>
                            <SelectItem value="pro">Pro</SelectItem>
                            <SelectItem value="business">Business</SelectItem>
                          </SelectContent>
                        </Select>
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
    </div>
  );
}
