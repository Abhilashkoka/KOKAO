import { useState, useEffect } from "react";
import { RippleSpinner } from "@/components/ui/ripple-spinner";
import {
  useAdminGetMetaCredentials,
  useAdminSaveMetaCredentials,
  getAdminGetMetaCredentialsQueryKey,
  useAdminGetTwitterCredentials,
  useAdminSaveTwitterCredentials,
  getAdminGetTwitterCredentialsQueryKey,
  useAdminGetLinkedinCredentials,
  useAdminSaveLinkedinCredentials,
  getAdminGetLinkedinCredentialsQueryKey,
  useAdminGetYoutubeCredentials,
  useAdminSaveYoutubeCredentials,
  getAdminGetYoutubeCredentialsQueryKey,
  useAdminGetThreadsCredentials,
  useAdminSaveThreadsCredentials,
  getAdminGetThreadsCredentialsQueryKey,
  useAdminGetTiktokCredentials,
  useAdminSaveTiktokCredentials,
  getAdminGetTiktokCredentialsQueryKey,
  useAdminGetRazorpayCredentials,
  useAdminSaveRazorpayCredentials,
  getAdminGetRazorpayCredentialsQueryKey,
  useAdminGetCashfreeCredentials,
  useAdminSaveCashfreeCredentials,
  getAdminGetCashfreeCredentialsQueryKey,
  useAdminGetPaymentGateway,
  useAdminSavePaymentGateway,
  getAdminGetPaymentGatewayQueryKey,
  useAdminGetGoogleAdsCredentials,
  useAdminSaveGoogleAdsCredentials,
  getAdminGetGoogleAdsCredentialsQueryKey,
  useAdminGetSessionTimeout,
  useAdminGetInvoiceSettings,
  useAdminUpdateInvoiceSettings,
  getAdminGetInvoiceSettingsQueryKey,
  useAdminSaveSessionTimeout,
  getAdminGetSessionTimeoutQueryKey,
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
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { CheckCircle2, AlertCircle } from "lucide-react";
import { apiErrorMessage } from "@/lib/apiErrorMessage";

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
              apiErrorMessage(err, "Please try again."),
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
                  <RippleSpinner className="h-4 w-4 mr-2" /> Saving &
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

// Exported for tests (see credentials-tab.error-toast.test.tsx).
export function GoogleAdsCredentialsCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useAdminGetGoogleAdsCredentials();
  const save = useAdminSaveGoogleAdsCredentials();

  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [developerToken, setDeveloperToken] = useState("");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (data && !dirty) {
      setClientId(data.clientIdMasked ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const canSave =
    clientId.trim() && clientSecret.trim() && developerToken.trim();

  const handleSave = () => {
    if (!canSave) return;
    save.mutate(
      {
        data: {
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim(),
          developerToken: developerToken.trim(),
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getAdminGetGoogleAdsCredentialsQueryKey(),
          });
          setClientSecret("");
          setDeveloperToken("");
          setDirty(false);
          toast({
            title: "Google Ads credentials saved",
            description:
              "They will be verified the first time a workspace connects a Google Ads account.",
          });
        },
        onError: (err: any) => {
          toast({
            variant: "destructive",
            title: "Could not save",
            description: apiErrorMessage(err, "Please try again."),
          });
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Google Ads credentials</CardTitle>
        <CardDescription>
          One-time platform setup for paid media on Google. Enter the OAuth
          Client ID and Client Secret of a Google Cloud project with the Google
          Ads API enabled, plus your Google Ads API developer token. Each
          workspace then connects its own Google Ads account on the Ads page.
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
                {data.testStatus === "failed" ? (
                  <span className="text-destructive flex items-center gap-1">
                    <AlertCircle className="h-4 w-4" /> Verification failed
                    {data.testError ? `: ${data.testError}` : ""}
                  </span>
                ) : (
                  <span className="text-green-600 flex items-center gap-1">
                    <CheckCircle2 className="h-4 w-4" /> Saved — verified on
                    first workspace connect
                  </span>
                )}
              </div>
            )}
            <div className="space-y-2">
              <label className="text-sm font-medium">OAuth Client ID</label>
              <Input
                value={clientId}
                onChange={(e) => {
                  setClientId(e.target.value);
                  setDirty(true);
                }}
                placeholder="1234567890-abc.apps.googleusercontent.com"
                data-testid="input-google-ads-client-id"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">OAuth Client Secret</label>
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
                    : "Client Secret"
                }
                data-testid="input-google-ads-client-secret"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Developer token</label>
              <Input
                type="password"
                value={developerToken}
                onChange={(e) => {
                  setDeveloperToken(e.target.value);
                  setDirty(true);
                }}
                placeholder={
                  data?.configured
                    ? "Enter to replace the saved token"
                    : "Developer token"
                }
                data-testid="input-google-ads-developer-token"
              />
              <p className="text-xs text-muted-foreground">
                Create the OAuth client in the Google Cloud console (Web
                application; add /api/ads/google/auth/callback on your domain
                as an authorized redirect URI). The developer token is under
                API Center in your Google Ads manager account.
              </p>
            </div>
            <Button
              onClick={handleSave}
              disabled={save.isPending || !canSave}
              data-testid="button-save-google-ads-credentials"
            >
              {save.isPending ? (
                <>
                  <RippleSpinner className="h-4 w-4 mr-2" /> Saving...
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
            description: apiErrorMessage(err, "Please try again."),
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
                  <RippleSpinner className="h-4 w-4 mr-2" /> Saving...
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
            description: apiErrorMessage(err, "Please try again."),
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
                  <RippleSpinner className="h-4 w-4 mr-2" /> Saving...
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

function RazorpayCredentialsCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useAdminGetRazorpayCredentials();
  const saveRazorpay = useAdminSaveRazorpayCredentials();

  // The Key ID input intentionally starts EMPTY (the saved value is shown as
  // a placeholder only): prefilling the masked text would let an operator who
  // edits just the secrets accidentally save the masked placeholder as the
  // real Key ID. Saving always requires re-entering all three values.
  const [keyId, setKeyId] = useState("");
  const [keySecret, setKeySecret] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");

  const handleSave = () => {
    if (!keyId.trim() || !keySecret.trim() || !webhookSecret.trim()) return;
    saveRazorpay.mutate(
      {
        data: {
          keyId: keyId.trim(),
          keySecret: keySecret.trim(),
          webhookSecret: webhookSecret.trim(),
        },
      },
      {
        onSuccess: (result) => {
          queryClient.invalidateQueries({
            queryKey: getAdminGetRazorpayCredentialsQueryKey(),
          });
          setKeyId("");
          setKeySecret("");
          setWebhookSecret("");
          if (result.testStatus === "verified") {
            toast({
              title: "Razorpay connected",
              description:
                "Keys verified. Workspaces can now subscribe and buy credit packs.",
            });
          } else {
            toast({
              variant: "destructive",
              title: "Saved, but the key test failed",
              description:
                result.testError ||
                "Razorpay rejected the keys. Double-check the Key ID and Secret.",
            });
          }
        },
        onError: (err: any) => {
          toast({
            variant: "destructive",
            title: "Could not save",
            description: apiErrorMessage(err, "Please try again."),
          });
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Razorpay payment keys</CardTitle>
        <CardDescription>
          One-time platform setup for online billing. Enter the Key ID and Key
          Secret from your Razorpay dashboard (Settings → API Keys), plus the
          Webhook Secret you set when creating the webhook. Keys are tested on
          save, encrypted at rest, and never shown again.
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
                {data.testStatus === "verified" ? (
                  <span className="text-green-600 flex items-center gap-1">
                    <CheckCircle2 className="h-4 w-4" /> Connected
                  </span>
                ) : (
                  <span className="text-destructive flex items-center gap-1">
                    <AlertCircle className="h-4 w-4" />
                    {data.testError || "Key test failed"}
                  </span>
                )}
              </div>
            )}
            <div className="space-y-2">
              <label className="text-sm font-medium">Key ID</label>
              <Input
                value={keyId}
                onChange={(e) => setKeyId(e.target.value)}
                placeholder={
                  data?.configured && data.keyIdMasked
                    ? `Saved: ${data.keyIdMasked} — enter to replace`
                    : "rzp_live_..."
                }
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Key Secret</label>
              <Input
                type="password"
                value={keySecret}
                onChange={(e) => setKeySecret(e.target.value)}
                placeholder={
                  data?.configured
                    ? "Enter to replace the saved secret"
                    : "Razorpay Key Secret"
                }
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Webhook Secret</label>
              <Input
                type="password"
                value={webhookSecret}
                onChange={(e) => setWebhookSecret(e.target.value)}
                placeholder={
                  data?.configured
                    ? "Enter to replace the saved secret"
                    : "Webhook signing secret"
                }
              />
              <p className="text-xs text-muted-foreground">
                In the Razorpay dashboard, create a webhook pointing to
                /api/billing/razorpay-webhook on this app's domain, subscribed
                to subscription and payment events, and paste its secret here.
              </p>
            </div>
            <Button
              onClick={handleSave}
              disabled={
                saveRazorpay.isPending ||
                !keyId.trim() ||
                !keySecret.trim() ||
                !webhookSecret.trim()
              }
            >
              {saveRazorpay.isPending ? (
                <>
                  <RippleSpinner className="h-4 w-4 mr-2" /> Saving...
                </>
              ) : (
                "Save & test"
              )}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function CashfreeCredentialsCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useAdminGetCashfreeCredentials();
  const saveCashfree = useAdminSaveCashfreeCredentials();

  // The App ID input starts EMPTY (saved value shown as placeholder only), for
  // the same reason as Razorpay's Key ID: saving requires re-entering both the
  // App ID and Secret so a masked placeholder can never be saved as the real
  // value.
  const [appId, setAppId] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [mode, setMode] = useState<"sandbox" | "production">("sandbox");
  const [modeTouched, setModeTouched] = useState(false);

  // Reflect the saved mode once loaded (until the admin picks one themselves).
  useEffect(() => {
    if (data?.mode && !modeTouched) {
      setMode(data.mode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const handleSave = () => {
    if (!appId.trim() || !secretKey.trim()) return;
    saveCashfree.mutate(
      {
        data: {
          appId: appId.trim(),
          secretKey: secretKey.trim(),
          mode,
        },
      },
      {
        onSuccess: (result) => {
          queryClient.invalidateQueries({
            queryKey: getAdminGetCashfreeCredentialsQueryKey(),
          });
          queryClient.invalidateQueries({
            queryKey: getAdminGetPaymentGatewayQueryKey(),
          });
          setAppId("");
          setSecretKey("");
          if (result.testStatus === "verified") {
            toast({
              title: "Cashfree connected",
              description:
                "Keys verified. Workspaces can now subscribe and buy credit packs.",
            });
          } else {
            toast({
              variant: "destructive",
              title: "Saved, but the key test failed",
              description:
                result.testError ||
                "Cashfree rejected the keys. Double-check the App ID and Secret.",
            });
          }
        },
        onError: (err: any) => {
          toast({
            variant: "destructive",
            title: "Could not save",
            description: apiErrorMessage(err, "Please try again."),
          });
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cashfree payment keys</CardTitle>
        <CardDescription>
          One-time platform setup for online billing through Cashfree. Enter the
          App ID and Secret Key from your Cashfree dashboard (Developers → API
          Keys) and pick the environment. Keys are tested on save, encrypted at
          rest, and never shown again.
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
                {data.testStatus === "verified" ? (
                  <span className="text-green-600 flex items-center gap-1">
                    <CheckCircle2 className="h-4 w-4" /> Connected
                  </span>
                ) : (
                  <span className="text-destructive flex items-center gap-1">
                    <AlertCircle className="h-4 w-4" />
                    {data.testError || "Key test failed"}
                  </span>
                )}
              </div>
            )}
            <div className="space-y-2">
              <label className="text-sm font-medium">App ID</label>
              <Input
                value={appId}
                onChange={(e) => setAppId(e.target.value)}
                placeholder={
                  data?.configured && data.appIdMasked
                    ? `Saved: ${data.appIdMasked} — enter to replace`
                    : "Cashfree App ID"
                }
                data-testid="input-cashfree-app-id"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Secret Key</label>
              <Input
                type="password"
                value={secretKey}
                onChange={(e) => setSecretKey(e.target.value)}
                placeholder={
                  data?.configured
                    ? "Enter to replace the saved secret"
                    : "Cashfree Secret Key"
                }
                data-testid="input-cashfree-secret-key"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Mode</label>
              <Select
                value={mode}
                onValueChange={(value) => {
                  setMode(value as "sandbox" | "production");
                  setModeTouched(true);
                }}
              >
                <SelectTrigger data-testid="select-cashfree-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sandbox">Sandbox</SelectItem>
                  <SelectItem value="production">Production</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Sandbox = Cashfree test environment. Use Production only with
                live keys to charge real money.
              </p>
            </div>
            <Button
              onClick={handleSave}
              disabled={
                saveCashfree.isPending || !appId.trim() || !secretKey.trim()
              }
              data-testid="button-save-cashfree-credentials"
            >
              {saveCashfree.isPending ? (
                <>
                  <RippleSpinner className="h-4 w-4 mr-2" /> Saving...
                </>
              ) : (
                "Save & test"
              )}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ActivePaymentGatewayCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useAdminGetPaymentGateway();
  const saveGateway = useAdminSavePaymentGateway();

  const handleSelect = (gateway: "razorpay" | "cashfree") => {
    if (data?.activeGateway === gateway) return;
    saveGateway.mutate(
      { data: { activeGateway: gateway } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getAdminGetPaymentGatewayQueryKey(),
          });
          toast({
            title: "Payment gateway updated",
            description:
              gateway === "cashfree"
                ? "New payments will go through Cashfree."
                : "New payments will go through Razorpay.",
          });
        },
        onError: (err: any) => {
          toast({
            variant: "destructive",
            title: "Could not switch gateway",
            description: apiErrorMessage(err, "Please try again."),
          });
        },
      },
    );
  };

  const options: {
    id: "razorpay" | "cashfree";
    label: string;
    configured: boolean;
  }[] = [
    {
      id: "razorpay",
      label: "Razorpay",
      configured: !!data?.razorpayConfigured,
    },
    {
      id: "cashfree",
      label: "Cashfree",
      configured: !!data?.cashfreeConfigured,
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Active payment gateway</CardTitle>
        <CardDescription>
          Choose which gateway handles new subscriptions, credit-pack purchases
          and wallet top-ups. A gateway can only be selected once its keys are
          saved and verified below.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 max-w-xl">
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (
          <div className="space-y-2" role="radiogroup">
            {options.map((option) => {
              const selected = data?.activeGateway === option.id;
              const disabled =
                !option.configured || saveGateway.isPending || selected;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={disabled}
                  onClick={() => handleSelect(option.id)}
                  data-testid={`gateway-option-${option.id}`}
                  className={[
                    "flex w-full items-center justify-between rounded-lg border p-3 text-left transition-colors",
                    selected
                      ? "border-primary bg-primary/5"
                      : "border-border",
                    disabled && !selected
                      ? "cursor-not-allowed opacity-60"
                      : "hover:bg-muted/50",
                  ].join(" ")}
                >
                  <span className="flex items-center gap-2">
                    <span
                      className={[
                        "flex h-4 w-4 items-center justify-center rounded-full border",
                        selected
                          ? "border-primary"
                          : "border-muted-foreground",
                      ].join(" ")}
                    >
                      {selected && (
                        <span className="h-2 w-2 rounded-full bg-primary" />
                      )}
                    </span>
                    <span className="font-medium">{option.label}</span>
                  </span>
                  <span className="text-xs">
                    {option.configured ? (
                      <span className="text-green-600 flex items-center gap-1">
                        <CheckCircle2 className="h-3.5 w-3.5" /> Configured
                      </span>
                    ) : (
                      <span className="text-muted-foreground">
                        Not configured — add keys below
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
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
            description: apiErrorMessage(err, "Please try again."),
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
                  <RippleSpinner className="h-4 w-4 mr-2" /> Saving...
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
            description: apiErrorMessage(err, "Please try again."),
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
                  <RippleSpinner className="h-4 w-4 mr-2" /> Saving...
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

function TiktokCredentialsCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useAdminGetTiktokCredentials();
  const saveTiktok = useAdminSaveTiktokCredentials();

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
    saveTiktok.mutate(
      { data: { appId: appId.trim(), appSecret: appSecret.trim() } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getAdminGetTiktokCredentialsQueryKey(),
          });
          setAppSecret("");
          setDirty(false);
          toast({
            title: "TikTok credentials saved",
            description:
              "Workspaces can now connect their TikTok advertiser account on the Ads page.",
          });
        },
        onError: (err: any) => {
          toast({
            variant: "destructive",
            title: "Could not save",
            description: apiErrorMessage(err, "Please try again."),
          });
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>TikTok for Business app credentials</CardTitle>
        <CardDescription>
          One-time platform setup for TikTok Ads. Enter the App ID and Secret
          of a TikTok for Business developer app with the Ads Management scopes
          approved. Every workspace then connects their own advertiser account
          on the Ads page. Secrets are encrypted at rest and never shown again.
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
                  Callback URL (register this in the TikTok for Business app)
                </label>
                <div className="flex items-center gap-2">
                  <Input readOnly value={data.redirectUri} />
                  <Button type="button" variant="outline" onClick={copyRedirect}>
                    Copy
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Add this exact URL as the Advertiser redirect URL in your
                  TikTok for Business developer app settings.
                </p>
              </div>
            )}
            <div className="space-y-2">
              <label className="text-sm font-medium">TikTok App ID</label>
              <Input
                value={appId}
                onChange={(e) => {
                  setAppId(e.target.value);
                  setDirty(true);
                }}
                placeholder="TikTok App ID"
                data-testid="input-tiktok-app-id"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">TikTok App Secret</label>
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
                    : "TikTok App Secret"
                }
                data-testid="input-tiktok-app-secret"
              />
              <p className="text-xs text-muted-foreground">
                Find both values in the TikTok for Business developer portal
                under your app's Basic Information.
              </p>
            </div>
            <Button
              onClick={handleSave}
              disabled={
                saveTiktok.isPending || !appId.trim() || !appSecret.trim()
              }
              data-testid="button-save-tiktok-credentials"
            >
              {saveTiktok.isPending ? (
                <>
                  <RippleSpinner className="h-4 w-4 mr-2" /> Saving...
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

const TIMEOUT_MIN = 5;
const TIMEOUT_MAX = 480;
const WARNING_MIN = 10;
const WARNING_MAX = 300;

export function SessionTimeoutCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useAdminGetSessionTimeout();
  const save = useAdminSaveSessionTimeout();

  const [enabled, setEnabled] = useState(false);
  const [timeoutMinutes, setTimeoutMinutes] = useState("30");
  const [warningSeconds, setWarningSeconds] = useState("60");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (data && !hydrated) {
      setEnabled(data.enabled);
      setTimeoutMinutes(String(data.timeoutMinutes));
      setWarningSeconds(String(data.warningSeconds));
      setHydrated(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const minutesNum = Number(timeoutMinutes);
  const warningNum = Number(warningSeconds);

  const minutesValid =
    Number.isFinite(minutesNum) &&
    minutesNum >= TIMEOUT_MIN &&
    minutesNum <= TIMEOUT_MAX;
  const warningValid =
    Number.isFinite(warningNum) &&
    warningNum >= WARNING_MIN &&
    warningNum <= WARNING_MAX;
  // The warning must fire *before* the timeout, so it has to be shorter than
  // the whole idle window (expressed in seconds).
  const warningBeforeTimeout =
    minutesValid && warningValid && warningNum < minutesNum * 60;

  const validationError = !enabled
    ? null
    : !minutesValid
      ? `Timeout must be between ${TIMEOUT_MIN} and ${TIMEOUT_MAX} minutes.`
      : !warningValid
        ? `Warning must be between ${WARNING_MIN} and ${WARNING_MAX} seconds.`
        : !warningBeforeTimeout
          ? "Warning must be shorter than the timeout."
          : null;

  const canSave = !enabled || (validationError === null);

  const handleSave = () => {
    if (!canSave) return;
    save.mutate(
      {
        data: {
          enabled,
          timeoutMinutes: minutesNum,
          warningSeconds: warningNum,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getAdminGetSessionTimeoutQueryKey(),
          });
          toast({
            title: "Session timeout saved",
            description: enabled
              ? "Inactive users will now be signed out automatically."
              : "Automatic sign-out is turned off.",
          });
        },
        onError: (err: any) => {
          toast({
            variant: "destructive",
            title: "Could not save",
            description: apiErrorMessage(err, "Please try again."),
          });
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Session timeout</CardTitle>
        <CardDescription>
          Automatically sign users out after a period of inactivity. A warning
          with a countdown appears shortly before sign-out so active users can
          stay signed in. Applies to everyone across the app.
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
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="session-timeout-enabled">
                  Enable automatic sign-out
                </Label>
                <p className="text-xs text-muted-foreground">
                  When off, sessions never expire from inactivity.
                </p>
              </div>
              <Switch
                id="session-timeout-enabled"
                checked={enabled}
                onCheckedChange={setEnabled}
                data-testid="switch-session-timeout-enabled"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="session-timeout-minutes">
                Timeout (minutes)
              </Label>
              <Input
                id="session-timeout-minutes"
                type="number"
                min={TIMEOUT_MIN}
                max={TIMEOUT_MAX}
                value={timeoutMinutes}
                disabled={!enabled}
                onChange={(e) => setTimeoutMinutes(e.target.value)}
                data-testid="input-session-timeout-minutes"
              />
              <p className="text-xs text-muted-foreground">
                Between {TIMEOUT_MIN} and {TIMEOUT_MAX} minutes of inactivity.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="session-timeout-warning">
                Warning (seconds)
              </Label>
              <Input
                id="session-timeout-warning"
                type="number"
                min={WARNING_MIN}
                max={WARNING_MAX}
                value={warningSeconds}
                disabled={!enabled}
                onChange={(e) => setWarningSeconds(e.target.value)}
                data-testid="input-session-timeout-warning"
              />
              <p className="text-xs text-muted-foreground">
                How many seconds before sign-out the warning countdown appears
                ({WARNING_MIN}–{WARNING_MAX}).
              </p>
            </div>
            {validationError && (
              <p
                className="text-sm text-destructive flex items-center gap-1"
                data-testid="session-timeout-error"
              >
                <AlertCircle className="h-4 w-4" /> {validationError}
              </p>
            )}
            <Button
              onClick={handleSave}
              disabled={save.isPending || !canSave}
              data-testid="button-save-session-timeout"
            >
              {save.isPending ? (
                <>
                  <RippleSpinner className="h-4 w-4 mr-2" /> Saving...
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

/**
 * Seller details printed on every tenant invoice (legal name, GSTIN, address,
 * invoice-number prefix). Changes apply to FUTURE invoices only — issued
 * invoices keep their snapshot.
 */
export function InvoiceSettingsCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useAdminGetInvoiceSettings();
  const save = useAdminUpdateInvoiceSettings();

  const [legalName, setLegalName] = useState("");
  const [gstin, setGstin] = useState("");
  const [address, setAddress] = useState("");
  const [numberPrefix, setNumberPrefix] = useState("");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (data && !hydrated) {
      setLegalName(data.legalName);
      setGstin(data.gstin ?? "");
      setAddress(data.address ?? "");
      setNumberPrefix(data.numberPrefix);
      setHydrated(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const canSave = legalName.trim().length > 0 && numberPrefix.trim().length > 0;

  const handleSave = () => {
    if (!canSave) return;
    save.mutate(
      {
        data: {
          legalName: legalName.trim(),
          gstin: gstin.trim() || null,
          address: address.trim() || null,
          numberPrefix: numberPrefix.trim(),
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getAdminGetInvoiceSettingsQueryKey(),
          });
          toast({
            title: "Invoice details saved",
            description: "Future invoices will use these seller details.",
          });
        },
        onError: (err: any) => {
          toast({
            variant: "destructive",
            title: "Could not save",
            description: apiErrorMessage(err, "Please try again."),
          });
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Invoice details</CardTitle>
        <CardDescription>
          Your business details printed as the seller on every tenant invoice.
          Changes only affect invoices issued from now on.
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
            <div className="space-y-2">
              <Label htmlFor="invoice-legal-name">Legal business name</Label>
              <Input
                id="invoice-legal-name"
                value={legalName}
                maxLength={200}
                onChange={(e) => setLegalName(e.target.value)}
                data-testid="input-invoice-legal-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="invoice-seller-gstin">GSTIN (optional)</Label>
              <Input
                id="invoice-seller-gstin"
                value={gstin}
                maxLength={20}
                onChange={(e) => setGstin(e.target.value.toUpperCase())}
                data-testid="input-invoice-seller-gstin"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="invoice-seller-address">Registered address (optional)</Label>
              <Textarea
                id="invoice-seller-address"
                value={address}
                maxLength={600}
                rows={3}
                onChange={(e) => setAddress(e.target.value)}
                data-testid="input-invoice-seller-address"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="invoice-number-prefix">Invoice number prefix</Label>
              <Input
                id="invoice-number-prefix"
                value={numberPrefix}
                maxLength={12}
                onChange={(e) => setNumberPrefix(e.target.value)}
                data-testid="input-invoice-number-prefix"
              />
              <p className="text-xs text-muted-foreground">
                Numbers look like {numberPrefix || "AE"}2627-000000001 and restart
                each financial year. Keep the prefix to 2 characters — GST caps
                invoice numbers at 16 characters.
              </p>
            </div>
            <Button
              onClick={handleSave}
              disabled={save.isPending || !canSave}
              data-testid="button-save-invoice-settings"
            >
              {save.isPending ? (
                <>
                  <RippleSpinner className="h-4 w-4 mr-2" /> Saving...
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

export function CredentialsTab() {
  return (
    <div className="space-y-8">
      <SessionTimeoutCard />
      <InvoiceSettingsCard />
      <MetaCredentialsCard />
      <GoogleAdsCredentialsCard />
      <TwitterCredentialsCard />
      <LinkedinCredentialsCard />
      <YoutubeCredentialsCard />
      <ThreadsCredentialsCard />
      <TiktokCredentialsCard />
      <ActivePaymentGatewayCard />
      <RazorpayCredentialsCard />
      <CashfreeCredentialsCard />
    </div>
  );
}
