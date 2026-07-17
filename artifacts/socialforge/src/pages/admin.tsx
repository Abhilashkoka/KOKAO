import { useState, useEffect } from "react";
import {
  useAdminListTenants,
  useAdminGetStats,
  useAdminUpdateTenantPlan,
  useAdminUpdateTenantSuperadmin,
  useAdminUpdateTenantDesignSkill,
  useAdminGetDesignSkill,
  useAdminUpdateDesignSkill,
  getAdminGetDesignSkillQueryKey,
  useAdminGetMetaCredentials,
  useAdminSaveMetaCredentials,
  useAdminGetTwitterCredentials,
  useAdminGetLinkedinCredentials,
  useAdminSaveLinkedinCredentials,
  getAdminGetLinkedinCredentialsQueryKey,
  useAdminGetYoutubeCredentials,
  useAdminSaveYoutubeCredentials,
  getAdminGetYoutubeCredentialsQueryKey,
  useAdminGetThreadsCredentials,
  useAdminSaveThreadsCredentials,
  getAdminGetThreadsCredentialsQueryKey,
  useAdminSaveTwitterCredentials,
  useAdminListNotificationPolicies,
  useAdminUpdateNotificationPolicies,
  useAdminGetEmailSettings,
  useAdminUpdateEmailSettings,
  useAdminSendTestEmail,
  useAdminListAuditLogs,
  useAdminRunSweep,
  useAdminListSeatRequests,
  useAdminDecideSeatRequest,
  getAdminListSeatRequestsQueryKey,
  getAdminListTenantsQueryKey,
  getAdminGetStatsQueryKey,
  getAdminGetMetaCredentialsQueryKey,
  getAdminGetTwitterCredentialsQueryKey,
  getAdminListNotificationPoliciesQueryKey,
  getAdminGetEmailSettingsQueryKey,
  getAdminListAuditLogsQueryKey,
  useListPlans,
  useAdminUpdatePlan,
  useAdminCreatePlan,
  useAdminDeletePlan,
  getListPlansQueryKey,
  useGetMe,
} from "@workspace/api-client-react";
import { useAdminAccessRevoked } from "@/lib/admin-guard";
import { Textarea } from "@/components/ui/textarea";
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
import { localDayStartISO, localDayEndISO } from "@/lib/auditDateRange";
import {
  Users,
  Layers,
  Calendar,
  Share2,
  ShieldAlert,
  RadioTower,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";

const PLAN_LABELS: Record<string, string> = {
  free: "Free",
  pro: "Pro",
  business: "Business",
};

/** The sweep runs every 15 minutes; call it stale after two missed cycles. */
const SWEEP_STALE_MS = 35 * 60 * 1000;

function isSweepStale(lastRunAt: string): boolean {
  return Date.now() - new Date(lastRunAt).getTime() > SWEEP_STALE_MS;
}

function formatSweepDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

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

function LinkedinCredentialsCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useAdminGetLinkedinCredentials();
  const saveLinkedin = useAdminSaveLinkedinCredentials();

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
    saveLinkedin.mutate(
      { data: { clientId: clientId.trim(), clientSecret: clientSecret.trim() } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getAdminGetLinkedinCredentialsQueryKey(),
          });
          setClientSecret("");
          setDirty(false);
          toast({
            title: "LinkedIn credentials saved",
            description:
              "Workspaces can now connect their LinkedIn account on the Accounts page.",
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
        <CardTitle>LinkedIn app credentials</CardTitle>
        <CardDescription>
          One-time platform setup. Enter the Client ID and Client Secret from
          your LinkedIn app's Auth tab. Every workspace then connects their own
          LinkedIn account through the sign-in flow on the Accounts page.
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
                  Callback URL (register this in your LinkedIn app)
                </label>
                <div className="flex items-center gap-2">
                  <Input readOnly value={data.redirectUri} />
                  <Button type="button" variant="outline" onClick={copyRedirect}>
                    Copy
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Add this exact URL to the "Authorized redirect URLs" list on
                  your LinkedIn app's Auth tab, and make sure the app has the
                  "Sign In with LinkedIn using OpenID Connect" and "Share on
                  LinkedIn" products enabled.
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
                placeholder="LinkedIn Client ID"
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
                    : "LinkedIn Client Secret"
                }
              />
              <p className="text-xs text-muted-foreground">
                Find both values on the Auth tab of your app at
                developer.linkedin.com under "Application credentials".
              </p>
            </div>
            <Button
              onClick={handleSave}
              disabled={
                saveLinkedin.isPending || !clientId.trim() || !clientSecret.trim()
              }
            >
              {saveLinkedin.isPending ? (
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

function YoutubeCredentialsCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useAdminGetYoutubeCredentials();
  const saveYoutube = useAdminSaveYoutubeCredentials();

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
    saveYoutube.mutate(
      { data: { clientId: clientId.trim(), clientSecret: clientSecret.trim() } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getAdminGetYoutubeCredentialsQueryKey(),
          });
          setClientSecret("");
          setDirty(false);
          toast({
            title: "YouTube credentials saved",
            description:
              "Workspaces can now connect their YouTube channel on the Accounts page.",
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
        <CardTitle>YouTube app credentials</CardTitle>
        <CardDescription>
          One-time platform setup. Enter the Client ID and Client Secret of a
          Google Cloud OAuth client (type "Web application") with the YouTube
          Data API v3 enabled. Every workspace then connects their own YouTube
          channel through Google sign-in on the Accounts page. Secrets are
          encrypted at rest and never shown again.
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
                  Callback URL (register this in your Google Cloud OAuth client)
                </label>
                <div className="flex items-center gap-2">
                  <Input readOnly value={data.redirectUri} />
                  <Button type="button" variant="outline" onClick={copyRedirect}>
                    Copy
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Add this exact URL to the "Authorized redirect URIs" list on
                  your OAuth client in the Google Cloud console, and make sure
                  the project has the YouTube Data API v3 enabled.
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
                placeholder="Google OAuth Client ID"
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
                    : "Google OAuth Client Secret"
                }
              />
              <p className="text-xs text-muted-foreground">
                Find both values under APIs &amp; Services, Credentials in the
                Google Cloud console.
              </p>
            </div>
            <Button
              onClick={handleSave}
              disabled={
                saveYoutube.isPending || !clientId.trim() || !clientSecret.trim()
              }
            >
              {saveYoutube.isPending ? (
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

function ThreadsCredentialsCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useAdminGetThreadsCredentials();
  const saveThreads = useAdminSaveThreadsCredentials();

  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (data && !dirty) {
      setAppId(data.appIdMasked ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const copyRedirect = () => {
    if (!data?.redirectUri) return;
    navigator.clipboard.writeText(data.redirectUri);
    toast({ title: "Callback URL copied" });
  };

  const handleSave = () => {
    if (!appId.trim() || !appSecret.trim()) return;
    saveThreads.mutate(
      { data: { appId: appId.trim(), appSecret: appSecret.trim() } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getAdminGetThreadsCredentialsQueryKey(),
          });
          setAppSecret("");
          setDirty(false);
          toast({
            title: "Threads credentials saved",
            description:
              "Workspaces can now connect their Threads profile on the Accounts page.",
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
        <CardTitle>Threads app credentials</CardTitle>
        <CardDescription>
          One-time platform setup. Enter the Threads App ID and Threads App
          Secret of a Meta app with the "Access the Threads API" use case
          added. These are different from the regular Facebook App ID and
          Secret, even inside the same Meta app. Every workspace then connects
          their own Threads profile on the Accounts page. Secrets are
          encrypted at rest and never shown again.
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
                  Callback URL (register this in the Meta app's Threads API settings)
                </label>
                <div className="flex items-center gap-2">
                  <Input readOnly value={data.redirectUri} />
                  <Button type="button" variant="outline" onClick={copyRedirect}>
                    Copy
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Add this exact URL as a Redirect Callback URL in the Threads
                  API settings of your Meta app (under the "Access the Threads
                  API" use case, Customize, Settings).
                </p>
              </div>
            )}
            <div className="space-y-2">
              <label className="text-sm font-medium">Threads App ID</label>
              <Input
                value={appId}
                onChange={(e) => {
                  setAppId(e.target.value);
                  setDirty(true);
                }}
                placeholder="Threads App ID"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Threads App Secret</label>
              <Input
                type="password"
                value={appSecret}
                onChange={(e) => {
                  setAppSecret(e.target.value);
                  setDirty(true);
                }}
                placeholder={
                  data?.configured
                    ? "Enter to replace the saved secret"
                    : "Threads App Secret"
                }
              />
              <p className="text-xs text-muted-foreground">
                Find both values in the Meta app under App settings, Basic —
                scroll to the Threads section (not the regular App ID/Secret at
                the top).
              </p>
            </div>
            <Button
              onClick={handleSave}
              disabled={
                saveThreads.isPending || !appId.trim() || !appSecret.trim()
              }
            >
              {saveThreads.isPending ? (
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

function EmailDeliveryCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useAdminGetEmailSettings();
  const save = useAdminUpdateEmailSettings();
  const sendTest = useAdminSendTestEmail();

  const [sendingEnabled, setSendingEnabled] = useState(false);
  const [fromEmail, setFromEmail] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [testTo, setTestTo] = useState("");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (data && !dirty) {
      setSendingEnabled(data.sendingEnabled);
      setFromEmail(data.fromEmail ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: getAdminGetEmailSettingsQueryKey(),
    });

  const handleSave = () => {
    save.mutate(
      {
        data: {
          sendingEnabled,
          fromEmail: fromEmail.trim(),
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        },
      },
      {
        onSuccess: () => {
          invalidate();
          setApiKey("");
          setDirty(false);
          toast({
            title: "Email settings saved",
            description: sendingEnabled
              ? "Email sending is enabled."
              : "Email sending is paused.",
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

  const handleTest = () => {
    if (!testTo.trim()) return;
    sendTest.mutate(
      { data: { to: testTo.trim() } },
      {
        onSuccess: (res) => {
          invalidate();
          if (res.ok) {
            toast({
              title: "Test email sent",
              description: `SendGrid accepted the message to ${testTo.trim()}.`,
            });
          } else {
            toast({
              variant: "destructive",
              title: "Test email failed",
              description:
                res.error ||
                "SendGrid did not accept the message. Check the credentials and sender.",
            });
          }
        },
        onError: (err: any) => {
          toast({
            variant: "destructive",
            title: "Could not send test",
            description: err?.response?.data?.error || "Please try again.",
          });
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Email delivery</CardTitle>
        <CardDescription>
          Controls transactional emails (like connection-breakage alerts).
          Sending is paused platform-wide until you enable it. You can either
          connect the SendGrid integration, or enter a SendGrid API key and
          verified sender here. The API key is encrypted at rest and never shown
          again. Use "Send test email" to confirm delivery before enabling.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 max-w-xl">
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 text-sm">
              {data?.connectorAvailable ? (
                <span className="text-green-600 flex items-center gap-1">
                  <CheckCircle2 className="h-4 w-4" /> SendGrid integration
                  connected
                </span>
              ) : data?.configured ? (
                <span className="text-green-600 flex items-center gap-1">
                  <CheckCircle2 className="h-4 w-4" /> API key configured
                </span>
              ) : (
                <span className="text-muted-foreground flex items-center gap-1">
                  <AlertCircle className="h-4 w-4" /> No SendGrid credentials yet
                </span>
              )}
            </div>

            <div className="flex items-center justify-between rounded-xl border border-border p-4">
              <div>
                <p className="text-sm font-semibold">Email sending</p>
                <p className="text-sm text-muted-foreground">
                  {sendingEnabled
                    ? "Enabled — emails will be delivered."
                    : "Paused — no emails are sent."}
                </p>
              </div>
              <Switch
                checked={sendingEnabled}
                onCheckedChange={(checked) => {
                  setSendingEnabled(checked);
                  setDirty(true);
                }}
                aria-label="Toggle email sending"
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Sender email (from)</label>
              <Input
                value={fromEmail}
                onChange={(e) => {
                  setFromEmail(e.target.value);
                  setDirty(true);
                }}
                placeholder="noreply@yourdomain.com"
              />
              <p className="text-xs text-muted-foreground">
                Must be a verified sender or domain in SendGrid, otherwise sends
                are rejected.
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">SendGrid API key</label>
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setDirty(true);
                }}
                placeholder={
                  data?.apiKeyMasked
                    ? `Saved (${data.apiKeyMasked}) — enter to replace`
                    : "SG.xxxxxxxx"
                }
              />
              <p className="text-xs text-muted-foreground">
                Optional if the SendGrid integration is connected. A key entered
                here overrides the integration.
              </p>
            </div>

            <Button onClick={handleSave} disabled={save.isPending}>
              {save.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Saving...
                </>
              ) : (
                "Save email settings"
              )}
            </Button>

            <div className="rounded-xl border border-border p-4 space-y-3">
              <div>
                <p className="text-sm font-semibold">Send test email</p>
                <p className="text-sm text-muted-foreground">
                  Sends a real message now to confirm delivery. Works even while
                  sending is paused.
                </p>
              </div>
              {data?.testStatus && (
                <div className="text-sm">
                  {data.testStatus === "verified" ? (
                    <span className="text-green-600 flex items-center gap-1">
                      <CheckCircle2 className="h-4 w-4" /> Last test delivered
                      {data.testedAt
                        ? ` (${new Date(data.testedAt).toLocaleString()})`
                        : ""}
                    </span>
                  ) : (
                    <span className="text-destructive flex items-center gap-1">
                      <AlertCircle className="h-4 w-4" /> Last test failed
                      {data.testError ? `: ${data.testError}` : ""}
                    </span>
                  )}
                </div>
              )}
              <div className="flex gap-2">
                <Input
                  value={testTo}
                  onChange={(e) => setTestTo(e.target.value)}
                  placeholder="you@example.com"
                />
                <Button
                  variant="secondary"
                  onClick={handleTest}
                  disabled={sendTest.isPending || !testTo.trim()}
                >
                  {sendTest.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Sending...
                    </>
                  ) : (
                    "Send test email"
                  )}
                </Button>
              </div>
            </div>
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

const AUDIT_ACTION_LABELS: Record<string, string> = {
  plan_change: "Plan change",
  superadmin_grant: "Superadmin granted",
  superadmin_revoke: "Superadmin revoked",
  plan_edit: "Plan limits edited",
  plan_create: "Plan created",
  plan_delete: "Plan deleted",
  notification_policy_change: "Notification policy changed",
  credential_change: "Platform credentials saved",
  app_brand_change: "App branding changed",
  email_settings_change: "Email settings changed",
  email_test_send: "Test email sent",
  sweep_run: "Manual sweep run",
};

interface PlanDraft {
  name: string;
  priceLabel: string;
  captions: string;
  images: string;
  brandKits: string;
  scheduledPosts: string;
  teamSeats: string;
  features: string;
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

const LIMIT_FIELDS: { key: keyof Pick<PlanDraft, "captions" | "images" | "brandKits" | "scheduledPosts">; label: string }[] = [
  { key: "captions", label: "AI captions / month" },
  { key: "images", label: "AI images / month" },
  { key: "brandKits", label: "Brand kits" },
  { key: "scheduledPosts", label: "Scheduled posts" },
];

const EMPTY_NEW_PLAN: PlanDraft = {
  name: "",
  priceLabel: "",
  captions: "",
  images: "",
  brandKits: "",
  scheduledPosts: "",
  teamSeats: "0",
  features: "",
};

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

function DesignSkillCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useAdminGetDesignSkill();
  const updateSettings = useAdminUpdateDesignSkill();

  const handleToggle = (enabled: boolean) => {
    updateSettings.mutate(
      { data: { enabled } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getAdminGetDesignSkillQueryKey(),
          });
          queryClient.invalidateQueries({
            queryKey: getAdminListAuditLogsQueryKey(),
          });
          toast({
            title: enabled ? "Design skill enabled" : "Design skill disabled",
            description: enabled
              ? "AI image prompts now go through the design skill for all users without an override."
              : "Users without an override now get plain image prompts.",
          });
        },
        onError: () => {
          toast({
            title: "Update failed",
            description: "Could not change the design skill setting.",
            variant: "destructive",
          });
        },
      },
    );
  };

  return (
    <Card data-testid="card-design-skill">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle>Design Skill</CardTitle>
          <CardDescription>
            When on, AI image generation first runs each prompt through a
            professional design pass (composition, typography, color) before
            creating the image. Brand kits are woven in automatically. You can
            override this per workspace in the tenants table below.
          </CardDescription>
        </div>
        {isLoading ? (
          <Skeleton className="h-6 w-11" />
        ) : (
          <Switch
            checked={settings?.enabled ?? true}
            disabled={updateSettings.isPending}
            onCheckedChange={handleToggle}
            aria-label="Toggle the design skill for all users"
            data-testid="switch-design-skill-global"
          />
        )}
      </CardHeader>
    </Card>
  );
}

function PlansCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: plans, isLoading } = useListPlans();
  const updatePlan = useAdminUpdatePlan();
  const createPlan = useAdminCreatePlan();
  const deletePlan = useAdminDeletePlan();

  const [drafts, setDrafts] = useState<Record<string, PlanDraft>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
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
      brandKits: parseLimit(draft.brandKits),
      scheduledPosts: parseLimit(draft.scheduledPosts),
    };
    const teamSeatsTrimmed = draft.teamSeats.trim();
    const teamSeats = teamSeatsTrimmed === "" ? 0 : Number(teamSeatsTrimmed);
    if (
      !draft.name.trim() ||
      !draft.priceLabel.trim() ||
      Object.values(limits).some((v) => v === null) ||
      !Number.isInteger(teamSeats) ||
      teamSeats < 0
    ) {
      toast({
        variant: "destructive",
        title: "Check the fields",
        description:
          'Limits must be whole numbers, or "unlimited". Team seats must be 0 or more. Name and price are required.',
      });
      return null;
    }
    return {
      name: draft.name.trim(),
      priceLabel: draft.priceLabel.trim(),
      teamSeats,
      limits: {
        captions: limits.captions!,
        images: limits.images!,
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

  const handleDelete = (planId: string, planName: string) => {
    if (
      !window.confirm(
        `Delete the "${planName}" plan? This cannot be undone. Plans still assigned to workspaces cannot be deleted.`,
      )
    ) {
      return;
    }
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
            captions: limitToInput(p.limits.captions),
            images: limitToInput(p.limits.images),
            brandKits: limitToInput(p.limits.brandKits),
            scheduledPosts: limitToInput(p.limits.scheduledPosts),
            teamSeats: String(p.teamSeats ?? 0),
            features: p.features.join("\n"),
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
                        onClick={() => handleDelete(p.id, p.name)}
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
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />{" "}
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
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />{" "}
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
    </Card>
  );
}

function formatAuditValue(action: string, value: string | null): string {
  if (value === null || value === "") return "—";
  if (action === "plan_change") return PLAN_LABELS[value] ?? value;
  if (action === "notification_policy_change") {
    try {
      const parsed = JSON.parse(value) as {
        type?: string;
        enabled?: boolean;
        emailPolicy?: string;
      };
      const parts: string[] = [];
      if (parsed.type) parts.push(parsed.type.replace(/_/g, " "));
      parts.push(parsed.enabled ? "enabled" : "disabled");
      if (parsed.emailPolicy) parts.push(`email: ${parsed.emailPolicy}`);
      return parts.join(", ");
    } catch {
      return value;
    }
  }
  if (action === "app_brand_change") {
    try {
      const parsed = JSON.parse(value) as {
        appName?: string | null;
        logoUrl?: string | null;
        iconUrl?: string | null;
        primaryColor?: string | null;
        backgroundColor?: string | null;
      };
      const parts: string[] = [];
      parts.push(`name: ${parsed.appName ?? "default"}`);
      parts.push(`logo: ${parsed.logoUrl ? "custom" : "default"}`);
      parts.push(`icon: ${parsed.iconUrl ? "custom" : "default"}`);
      parts.push(`primary: ${parsed.primaryColor ?? "default"}`);
      parts.push(`background: ${parsed.backgroundColor ?? "default"}`);
      return parts.join(", ");
    } catch {
      return value;
    }
  }
  if (action === "email_settings_change") {
    try {
      const parsed = JSON.parse(value) as {
        sendingEnabled?: boolean;
        fromEmail?: string | null;
        apiKeyMasked?: string | null;
      };
      const parts: string[] = [];
      parts.push(parsed.sendingEnabled ? "sending enabled" : "sending paused");
      if (parsed.fromEmail) parts.push(`from: ${parsed.fromEmail}`);
      if (parsed.apiKeyMasked) parts.push(`key: ${parsed.apiKeyMasked}`);
      return parts.join(", ");
    } catch {
      return value;
    }
  }
  if (action === "email_test_send") {
    try {
      const parsed = JSON.parse(value) as {
        recipient?: string;
        outcome?: string;
        error?: string | null;
      };
      const parts: string[] = [];
      if (parsed.recipient) parts.push(`to: ${parsed.recipient}`);
      if (parsed.outcome) parts.push(parsed.outcome);
      if (parsed.error) parts.push(parsed.error);
      return parts.join(", ") || value;
    } catch {
      return value;
    }
  }
  if (action === "sweep_run") {
    try {
      const parsed = JSON.parse(value) as { started?: boolean };
      return parsed.started
        ? "sweep completed"
        : "skipped (already running)";
    } catch {
      return value;
    }
  }
  if (action === "credential_change") {
    try {
      const parsed = JSON.parse(value) as {
        provider?: string;
        idMasked?: string | null;
      };
      const provider =
        parsed.provider === "twitter" ? "X (Twitter)" : parsed.provider;
      return [provider, parsed.idMasked].filter(Boolean).join(" ");
    } catch {
      return value;
    }
  }
  if (value === "true") return "Yes";
  if (value === "false") return "No";
  return value;
}

const AUDIT_PAGE_SIZE = 50;

export function AuditLogCard() {
  const { toast } = useToast();
  const [actionFilter, setActionFilter] = useState("all");
  const [actorInput, setActorInput] = useState("");
  const [targetInput, setTargetInput] = useState("");
  const [fromInput, setFromInput] = useState("");
  const [toInput, setToInput] = useState("");
  const [applied, setApplied] = useState<{
    action?: string;
    actor?: string;
    target?: string;
    from?: string;
    to?: string;
  }>({});
  const [offset, setOffset] = useState(0);

  const params = {
    limit: AUDIT_PAGE_SIZE,
    offset,
    ...(applied.action ? { action: applied.action as never } : {}),
    ...(applied.actor ? { actor: applied.actor } : {}),
    ...(applied.target ? { target: applied.target } : {}),
    ...(applied.from ? { from: applied.from } : {}),
    ...(applied.to ? { to: applied.to } : {}),
  };

  const { data, isLoading, isFetching } = useAdminListAuditLogs(params, {
    query: {
      queryKey: getAdminListAuditLogsQueryKey(params),
      placeholderData: (prev) => prev,
    },
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const hasFilters =
    actionFilter !== "all" || actorInput || targetInput || fromInput || toInput;

  const applyFilters = () => {
    setOffset(0);
    setApplied({
      action: actionFilter === "all" ? undefined : actionFilter,
      actor: actorInput.trim() || undefined,
      target: targetInput.trim() || undefined,
      from: fromInput ? localDayStartISO(fromInput) : undefined,
      to: toInput ? localDayEndISO(toInput) : undefined,
    });
  };

  const clearFilters = () => {
    setActionFilter("all");
    setActorInput("");
    setTargetInput("");
    setFromInput("");
    setToInput("");
    setOffset(0);
    setApplied({});
  };

  // Streams the export straight to disk via a browser-native download
  // (anchor navigation + server Content-Disposition) instead of buffering
  // the whole CSV into an in-memory Blob, which could freeze the tab for
  // very large audit histories. A HEAD preflight validates auth and filters
  // first so a rejected request surfaces as a toast instead of the browser
  // saving a JSON error body as a .csv file.
  const [exporting, setExporting] = useState(false);
  const downloadCsv = async () => {
    const search = new URLSearchParams();
    if (applied.action) search.set("action", applied.action);
    if (applied.actor) search.set("actor", applied.actor);
    if (applied.target) search.set("target", applied.target);
    if (applied.from) search.set("from", applied.from);
    if (applied.to) search.set("to", applied.to);
    const qs = search.toString();
    const url = `/api/admin/audit-logs/export${qs ? `?${qs}` : ""}`;

    setExporting(true);
    try {
      const preflight = await fetch(url, {
        method: "HEAD",
        credentials: "include",
      });
      if (!preflight.ok) {
        toast({
          title: "Export failed",
          description:
            preflight.status === 401 || preflight.status === 403
              ? "You no longer have access to the audit log. Try signing in again."
              : preflight.status === 400
                ? "The current filters are invalid. Adjust them and try again."
                : `The server rejected the export (error ${preflight.status}). Try again.`,
          variant: "destructive",
        });
        return;
      }
    } catch {
      toast({
        title: "Export failed",
        description: "Could not reach the server. Check your connection and try again.",
        variant: "destructive",
      });
      return;
    } finally {
      setExporting(false);
    }

    const link = document.createElement("a");
    link.href = url;
    link.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Audit trail</CardTitle>
        <CardDescription>
          Append-only record of privileged actions: plan overrides, superadmin
          grants/revokes, notification policy changes, and platform credential
          saves. Filter by action, actor, target, or date, and page through
          the full history.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="mb-4 flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Action</p>
            <Select value={actionFilter} onValueChange={setActionFilter}>
              <SelectTrigger className="w-[180px]" data-testid="select-audit-action">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All actions</SelectItem>
                {Object.entries(AUDIT_ACTION_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Actor</p>
            <Input
              className="w-[180px]"
              placeholder="Email or tenant #"
              value={actorInput}
              onChange={(e) => setActorInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && applyFilters()}
              data-testid="input-audit-actor"
            />
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Target</p>
            <Input
              className="w-[180px]"
              placeholder="Email or tenant #"
              value={targetInput}
              onChange={(e) => setTargetInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && applyFilters()}
              data-testid="input-audit-target"
            />
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">From</p>
            <Input
              type="date"
              className="w-[150px]"
              value={fromInput}
              onChange={(e) => setFromInput(e.target.value)}
              data-testid="input-audit-from"
            />
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">To</p>
            <Input
              type="date"
              className="w-[150px]"
              value={toInput}
              onChange={(e) => setToInput(e.target.value)}
              data-testid="input-audit-to"
            />
          </div>
          <Button size="sm" onClick={applyFilters} data-testid="button-audit-apply">
            Apply
          </Button>
          {hasFilters && (
            <Button
              size="sm"
              variant="ghost"
              onClick={clearFilters}
              data-testid="button-audit-clear"
            >
              Clear
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={downloadCsv}
            disabled={total === 0 || exporting}
            data-testid="button-audit-export"
          >
            Download CSV
          </Button>
        </div>
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {Object.keys(applied).some(
              (k) => applied[k as keyof typeof applied],
            )
              ? "No audit records match these filters."
              : "No admin actions have been recorded yet."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead>To</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((log) => (
                  <TableRow key={log.id}>
                    <TableCell className="text-muted-foreground whitespace-nowrap">
                      {new Date(log.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">
                        {AUDIT_ACTION_LABELS[log.action] ?? log.action}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {log.actorEmail ?? `#${log.actorTenantId}`}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {log.targetEmail ??
                        (log.targetTenantId != null
                          ? `#${log.targetTenantId}`
                          : "—")}
                    </TableCell>
                    <TableCell>
                      {formatAuditValue(log.action, log.oldValue ?? null)}
                    </TableCell>
                    <TableCell>
                      {formatAuditValue(log.action, log.newValue ?? null)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {!isLoading && total > 0 && (
          <div className="mt-4 flex items-center justify-between">
            <p className="text-sm text-muted-foreground" data-testid="text-audit-range">
              Showing {total === 0 ? 0 : offset + 1}–
              {Math.min(offset + AUDIT_PAGE_SIZE, total)} of {total}
            </p>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={offset === 0 || isFetching}
                onClick={() => setOffset(Math.max(0, offset - AUDIT_PAGE_SIZE))}
                data-testid="button-audit-prev"
              >
                Newer
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={offset + AUDIT_PAGE_SIZE >= total || isFetching}
                onClick={() => setOffset(offset + AUDIT_PAGE_SIZE)}
                data-testid="button-audit-next"
              >
                Older
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function AdminPage() {
  const { data: me } = useGetMe();
  const adminAccessRevoked = useAdminAccessRevoked();
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
  } = useAdminGetStats({
    query: {
      queryKey: getAdminGetStatsQueryKey(),
      // While a sweep is in flight the server reports sweepRunning=true;
      // poll so the Connection Sweep card refreshes as soon as it finishes.
      refetchInterval: (query) =>
        query.state.data?.sweepRunning ? 3000 : false,
    },
  });
  const { data: planCatalog } = useListPlans();
  const updatePlan = useAdminUpdateTenantPlan();
  const updateSuperadmin = useAdminUpdateTenantSuperadmin();
  const updateTenantDesignSkill = useAdminUpdateTenantDesignSkill();
  const runSweep = useAdminRunSweep();

  // Most recent manual sweep trigger (who clicked "Run now" and whether the
  // sweep actually started or was skipped because one was already in flight).
  const lastManualRunParams = { action: "sweep_run" as const, limit: 1 };
  const { data: lastManualRunPage } = useAdminListAuditLogs(
    lastManualRunParams,
    {
      query: {
        queryKey: getAdminListAuditLogsQueryKey(lastManualRunParams),
      },
    },
  );
  const lastManualRun = lastManualRunPage?.items?.[0];
  let lastManualRunStarted: boolean | null = null;
  if (lastManualRun?.newValue) {
    try {
      const parsed = JSON.parse(lastManualRun.newValue) as {
        started?: boolean;
      };
      if (typeof parsed.started === "boolean") {
        lastManualRunStarted = parsed.started;
      }
    } catch {
      // Leave outcome unknown for unparseable legacy rows.
    }
  }

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

  const handleRunSweep = () => {
    runSweep.mutate(undefined, {
      onSuccess: (result) => {
        queryClient.invalidateQueries({
          queryKey: getAdminGetStatsQueryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: getAdminListAuditLogsQueryKey(),
        });
        if (result.started) {
          toast({
            title: "Sweep started",
            description:
              "Re-checking all social connections in the background. Results will refresh here when it finishes.",
          });
        } else {
          toast({
            title: "Sweep already running",
            description:
              "A sweep is already in progress. Its results will appear shortly.",
          });
        }
      },
      onError: () => {
        toast({
          title: "Sweep failed",
          description: "Could not run the connection sweep.",
          variant: "destructive",
        });
      },
    });
  };

  const planNameById: Record<string, string> = {};
  for (const p of planCatalog ?? []) planNameById[p.id] = p.name;

  // Deny on the cached hint OR when the server authoritatively returns 403 —
  // the latter covers live revocation even while `me` is still stale-cached.
  const accessDenied =
    adminAccessRevoked ||
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
      { id: tenantId, data: { plan } },
      {
        onSuccess: () => {
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
          {Object.entries(stats.tenantsByPlan ?? {}).map(([planId, count]) => (
            <Badge key={planId} variant="secondary">
              {planNameById[planId] ?? PLAN_LABELS[planId] ?? planId}: {count}
            </Badge>
          ))}
        </div>
      )}

      <Card data-testid="card-connection-sweep">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2">
              <RadioTower className="h-5 w-5 text-muted-foreground" />
              Connection Sweep
            </CardTitle>
            <CardDescription>
              Background job that re-checks every workspace's social
              connections and alerts users when one breaks.
            </CardDescription>
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={handleRunSweep}
              disabled={runSweep.isPending || stats?.sweepRunning === true}
              data-testid="button-run-sweep"
            >
              {runSweep.isPending || stats?.sweepRunning ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Running...
                </>
              ) : (
                "Run now"
              )}
            </Button>
          {!statsLoading &&
            (stats?.sweepRunning ? (
              <Badge variant="secondary" data-testid="badge-sweep-running">
                Running
              </Badge>
            ) : stats?.connectionSweep ? (
              isSweepStale(stats.connectionSweep.lastRunAt) ? (
                <Badge
                  variant="destructive"
                  data-testid="badge-sweep-stale"
                >
                  Stale
                </Badge>
              ) : (
                <Badge variant="secondary" data-testid="badge-sweep-healthy">
                  Healthy
                </Badge>
              )
            ) : (
              <Badge variant="outline" data-testid="badge-sweep-never">
                Never ran
              </Badge>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          {lastManualRun && (
            <div
              className="mb-4 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm"
              data-testid="section-sweep-last-manual-run"
            >
              <span className="text-muted-foreground">Last manual run:</span>
              <span className="font-medium" data-testid="text-sweep-manual-actor">
                {lastManualRun.actorEmail ??
                  `Tenant #${lastManualRun.actorTenantId}`}
              </span>
              <span
                className="text-muted-foreground"
                data-testid="text-sweep-manual-time"
              >
                {new Date(lastManualRun.createdAt).toLocaleString()}
              </span>
              {lastManualRunStarted !== null &&
                (lastManualRunStarted ? (
                  <Badge
                    variant="secondary"
                    data-testid="badge-sweep-manual-started"
                  >
                    Started
                  </Badge>
                ) : (
                  <Badge
                    variant="outline"
                    data-testid="badge-sweep-manual-skipped"
                  >
                    Skipped (already running)
                  </Badge>
                ))}
            </div>
          )}
          {statsLoading ? (
            <Skeleton className="h-8 w-64" />
          ) : stats?.connectionSweep ? (
            <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
              <div>
                <div className="text-muted-foreground">Last run</div>
                <div className="font-medium" data-testid="text-sweep-last-run">
                  {new Date(stats.connectionSweep.lastRunAt).toLocaleString()}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Duration</div>
                <div className="font-medium">
                  {formatSweepDuration(stats.connectionSweep.durationMs)}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Accounts checked</div>
                <div className="font-medium">
                  {stats.connectionSweep.accountsChecked}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Errors</div>
                <div
                  className={
                    stats.connectionSweep.errorCount > 0
                      ? "font-medium text-destructive"
                      : "font-medium"
                  }
                  data-testid="text-sweep-errors"
                >
                  {stats.connectionSweep.errorCount}
                </div>
              </div>
              {stats.connectionSweep.errorCount > 0 &&
                stats.connectionSweep.lastError && (
                  <div className="w-full">
                    <div className="text-muted-foreground">Last error</div>
                    <div className="font-mono text-xs break-all">
                      {stats.connectionSweep.lastError}
                    </div>
                  </div>
                )}
              {(stats.connectionSweep.recentFailures?.length ?? 0) > 0 && (
                <div className="w-full" data-testid="section-sweep-failures">
                  <div className="text-muted-foreground mb-1">
                    Recent failed checks
                  </div>
                  <div className="space-y-1">
                    {stats.connectionSweep.recentFailures!.map((f, i) => (
                      <div
                        key={`${f.tenantId}-${f.platform}-${f.at}-${i}`}
                        className="rounded-md border px-3 py-2 text-xs"
                        data-testid={`row-sweep-failure-${i}`}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">
                            {f.tenantName ?? `Tenant #${f.tenantId}`}
                          </span>
                          <Badge variant="outline" className="capitalize">
                            {f.platform}
                          </Badge>
                          <span className="text-muted-foreground">
                            {new Date(f.at).toLocaleString()}
                          </span>
                        </div>
                        <div className="font-mono break-all text-muted-foreground mt-1">
                          {f.error}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              The sweep has not completed a run yet. It runs about a minute
              after the server starts and every 15 minutes after that.
            </p>
          )}
        </CardContent>
      </Card>

      <SeatRequestsCard />
      <DesignSkillCard />
      <PlansCard />
      <MetaCredentialsCard />
      <TwitterCredentialsCard />
      <LinkedinCredentialsCard />
      <YoutubeCredentialsCard />
      <ThreadsCredentialsCard />
      <EmailDeliveryCard />
      <NotificationPoliciesCard />
      <AuditLogCard />

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
