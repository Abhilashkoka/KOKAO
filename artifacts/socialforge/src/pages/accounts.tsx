import { useState, useEffect } from "react";
import { 
  useListAccounts,
  useCreateAccount,
  useDeleteAccount,
  getListAccountsQueryKey,
  getLinkedinAuthUrl,
  useGetLinkedinStatus,
  useDisconnectLinkedin,
  useRetestLinkedin,
  getGetLinkedinStatusQueryKey,
  useGetFacebookCredentials,
  useSaveFacebookCredentials,
  useGetInstagramCredentials,
  useSaveInstagramCredentials,
  useDisconnectFacebook,
  useRetestFacebookCredentials,
  useDisconnectInstagram,
  useRetestInstagramCredentials,
  getTwitterAuthUrl,
  useGetTwitterStatus,
  useDisconnectTwitter,
  getGetFacebookCredentialsQueryKey,
  getGetInstagramCredentialsQueryKey,
  getGetTwitterStatusQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Share2, Plus, Trash2, CheckCircle2, Instagram, Facebook, Linkedin, Youtube, Loader2, Copy, ExternalLink, AlertCircle, Twitter } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

function StatusPill({ status }: { status?: string | null }) {
  if (status === "verified") {
    return (
      <span className="text-xs font-medium text-green-600 flex items-center gap-1 bg-green-600/10 px-2 py-0.5 rounded-full">
        <CheckCircle2 className="h-3 w-3" /> Verified
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="text-xs font-medium text-destructive flex items-center gap-1 bg-destructive/10 px-2 py-0.5 rounded-full">
        <AlertCircle className="h-3 w-3" /> Verification failed
      </span>
    );
  }
  return (
    <span className="text-xs font-medium text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
      Not connected
    </span>
  );
}

function FacebookCredentialsCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useGetFacebookCredentials();
  const save = useSaveFacebookCredentials();
  const disconnect = useDisconnectFacebook();
  const retest = useRetestFacebookCredentials();

  const [pageId, setPageId] = useState("");
  const [pageAccessToken, setPageAccessToken] = useState("");
  const [dirty, setDirty] = useState(false);

  const invalidateFacebook = () => {
    queryClient.invalidateQueries({ queryKey: getGetFacebookCredentialsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetInstagramCredentialsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListAccountsQueryKey() });
  };

  const handleDisconnect = () => {
    if (!confirm("Disconnect Facebook? This clears your stored Page token. Your Instagram connection will also stop working until you reconnect Facebook.")) return;
    disconnect.mutate(undefined, {
      onSuccess: () => {
        invalidateFacebook();
        setPageId("");
        setPageAccessToken("");
        setDirty(false);
        toast({ title: "Facebook disconnected", description: "Your stored Page credentials were cleared." });
      },
      onError: (err: any) => {
        toast({ variant: "destructive", title: "Could not disconnect", description: err?.response?.data?.error || "Please try again." });
      },
    });
  };

  const handleRetest = () => {
    retest.mutate(undefined, {
      onSuccess: (res) => {
        invalidateFacebook();
        if (res.verifyStatus === "verified") {
          toast({ title: "Still connected", description: "Your Facebook Page token is valid." });
        } else {
          toast({ variant: "destructive", title: "Verification failed", description: res.verifyError || "Your stored token no longer works. Re-enter a fresh Page access token." });
        }
      },
      onError: (err: any) => {
        toast({ variant: "destructive", title: "Could not re-test", description: err?.response?.data?.error || "Please try again." });
      },
    });
  };

  useEffect(() => {
    if (data && !dirty) {
      setPageId(data.pageId ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const handleSave = () => {
    if (!pageId.trim() || !pageAccessToken.trim()) return;
    save.mutate(
      { data: { pageId: pageId.trim(), pageAccessToken: pageAccessToken.trim() } },
      {
        onSuccess: (res) => {
          queryClient.invalidateQueries({ queryKey: getGetFacebookCredentialsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetInstagramCredentialsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListAccountsQueryKey() });
          setPageAccessToken("");
          setDirty(false);
          if (res.verifyStatus === "verified") {
            toast({ title: "Facebook Page verified", description: "You can now publish to this Page from the Content Library." });
          } else {
            toast({
              variant: "destructive",
              title: "Saved, but verification failed",
              description: res.verifyError || "Meta rejected these credentials. Check the Page ID and access token.",
            });
          }
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
    <Card className="overflow-hidden border-border">
      <CardContent className="p-6">
        <div className="flex items-start gap-4">
          <div className="h-12 w-12 rounded-xl flex items-center justify-center bg-blue-600/10 text-blue-600 shrink-0">
            <Facebook className="h-6 w-6" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-bold text-lg">Facebook Page Publishing</h3>
              {isLoading ? null : data?.saved ? (
                <StatusPill status={data.verifyStatus} />
              ) : !data?.appConfigured ? (
                <span className="text-xs font-medium text-amber-600 flex items-center gap-1 bg-amber-600/10 px-2 py-0.5 rounded-full">
                  <AlertCircle className="h-3 w-3" /> Needs admin setup
                </span>
              ) : (
                <span className="text-xs font-medium text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                  Not connected
                </span>
              )}
            </div>

            {isLoading ? (
              <div className="mt-3 space-y-3">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : !data?.appConfigured ? (
              <p className="mt-2 text-sm text-muted-foreground">
                Facebook publishing needs a one-time Meta app setup by a platform administrator before you can connect your Page.
              </p>
            ) : (
              <div className="mt-3 space-y-4">
                <p className="text-sm text-muted-foreground">
                  Paste your Facebook Page ID and a Page access token. We test them immediately and only store them encrypted. Get a Page access token from the Graph API Explorer or your Meta app with the pages_manage_posts and pages_read_engagement permissions.
                </p>
                {data?.verifyStatus === "failed" && (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 space-y-1">
                    <p className="text-sm font-semibold text-destructive flex items-center gap-1.5">
                      <AlertCircle className="h-4 w-4 shrink-0" /> Reconnect needed
                    </p>
                    <p className="text-sm text-destructive">
                      {data.verifyError || "Your Facebook Page connection stopped working."} Enter a fresh Page access token below to reconnect.
                    </p>
                  </div>
                )}
                <div className="space-y-2">
                  <label className="text-sm font-medium">Page ID</label>
                  <Input
                    value={pageId}
                    onChange={(e) => { setPageId(e.target.value); setDirty(true); }}
                    placeholder="1234567890"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Page access token</label>
                  <Input
                    type="password"
                    value={pageAccessToken}
                    onChange={(e) => { setPageAccessToken(e.target.value); setDirty(true); }}
                    placeholder={data?.saved ? "Enter to replace the saved token" : "EAAG..."}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button onClick={handleSave} disabled={save.isPending || !pageId.trim() || !pageAccessToken.trim()}>
                    {save.isPending ? (
                      <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Saving & testing...</>
                    ) : (
                      "Save and verify"
                    )}
                  </Button>
                  {data?.saved && (
                    <>
                      <Button variant="outline" onClick={handleRetest} disabled={retest.isPending}>
                        {retest.isPending ? (
                          <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Re-testing...</>
                        ) : (
                          "Re-test now"
                        )}
                      </Button>
                      <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={handleDisconnect} disabled={disconnect.isPending}>
                        {disconnect.isPending ? (
                          <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Disconnecting...</>
                        ) : (
                          <><Trash2 className="h-4 w-4 mr-2" /> Disconnect</>
                        )}
                      </Button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function InstagramCredentialsCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useGetInstagramCredentials();
  const { data: fb } = useGetFacebookCredentials();
  const save = useSaveInstagramCredentials();
  const disconnect = useDisconnectInstagram();
  const retest = useRetestInstagramCredentials();

  const [igUserId, setIgUserId] = useState("");
  const [dirty, setDirty] = useState(false);

  const invalidateInstagram = () => {
    queryClient.invalidateQueries({ queryKey: getGetInstagramCredentialsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListAccountsQueryKey() });
  };

  const handleDisconnect = () => {
    if (!confirm("Disconnect Instagram? This clears your stored Instagram account.")) return;
    disconnect.mutate(undefined, {
      onSuccess: () => {
        invalidateInstagram();
        setIgUserId("");
        setDirty(false);
        toast({ title: "Instagram disconnected", description: "Your stored Instagram account was cleared." });
      },
      onError: (err: any) => {
        toast({ variant: "destructive", title: "Could not disconnect", description: err?.response?.data?.error || "Please try again." });
      },
    });
  };

  const handleRetest = () => {
    retest.mutate(undefined, {
      onSuccess: (res) => {
        invalidateInstagram();
        if (res.verifyStatus === "verified") {
          toast({ title: "Still connected", description: "Your Instagram account is valid." });
        } else {
          toast({ variant: "destructive", title: "Verification failed", description: res.verifyError || "Your stored Instagram account no longer verifies. Re-enter your account ID." });
        }
      },
      onError: (err: any) => {
        toast({ variant: "destructive", title: "Could not re-test", description: err?.response?.data?.error || "Please try again." });
      },
    });
  };

  useEffect(() => {
    if (data && !dirty) {
      setIgUserId(data.igUserId ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const fbVerified = fb?.verifyStatus === "verified";

  const handleSave = () => {
    if (!igUserId.trim()) return;
    save.mutate(
      { data: { igUserId: igUserId.trim() } },
      {
        onSuccess: (res) => {
          queryClient.invalidateQueries({ queryKey: getGetInstagramCredentialsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListAccountsQueryKey() });
          setDirty(false);
          if (res.verifyStatus === "verified") {
            toast({ title: "Instagram account verified", description: "You can now publish to Instagram from the Content Library." });
          } else {
            toast({
              variant: "destructive",
              title: "Saved, but verification failed",
              description: res.verifyError || "Meta rejected this Instagram account ID.",
            });
          }
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
    <Card className="overflow-hidden border-border">
      <CardContent className="p-6">
        <div className="flex items-start gap-4">
          <div className="h-12 w-12 rounded-xl flex items-center justify-center bg-pink-600/10 text-pink-600 shrink-0">
            <Instagram className="h-6 w-6" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-bold text-lg">Instagram Publishing</h3>
              {isLoading ? null : data?.saved ? (
                <StatusPill status={data.verifyStatus} />
              ) : !data?.appConfigured ? (
                <span className="text-xs font-medium text-amber-600 flex items-center gap-1 bg-amber-600/10 px-2 py-0.5 rounded-full">
                  <AlertCircle className="h-3 w-3" /> Needs admin setup
                </span>
              ) : (
                <span className="text-xs font-medium text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                  Not connected
                </span>
              )}
            </div>

            {isLoading ? (
              <div className="mt-3 space-y-3">
                <Skeleton className="h-10 w-full" />
              </div>
            ) : !data?.appConfigured ? (
              <p className="mt-2 text-sm text-muted-foreground">
                Instagram publishing needs a one-time Meta app setup by a platform administrator before you can connect your account.
              </p>
            ) : !fbVerified ? (
              <div className="mt-2 space-y-4">
                <p className="text-sm text-muted-foreground">
                  Connect and verify your Facebook Page first. Instagram publishing uses your Facebook Page access token, so the Page must be linked to your Instagram Business account.
                </p>
                {data?.saved && (
                  <>
                    <p className="text-sm text-destructive">
                      Your Instagram account is still saved, but it cannot be verified or published while Facebook is disconnected. Reconnect Facebook, or disconnect Instagram below.
                    </p>
                    <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={handleDisconnect} disabled={disconnect.isPending}>
                      {disconnect.isPending ? (
                        <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Disconnecting...</>
                      ) : (
                        <><Trash2 className="h-4 w-4 mr-2" /> Disconnect Instagram</>
                      )}
                    </Button>
                  </>
                )}
              </div>
            ) : (
              <div className="mt-3 space-y-4">
                <p className="text-sm text-muted-foreground">
                  Enter your Instagram Business account ID (the numeric IG user ID linked to your Facebook Page). We verify it immediately using your Facebook Page token.
                </p>
                {data?.verifyStatus === "failed" && (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 space-y-1">
                    <p className="text-sm font-semibold text-destructive flex items-center gap-1.5">
                      <AlertCircle className="h-4 w-4 shrink-0" /> Reconnect needed
                    </p>
                    <p className="text-sm text-destructive">
                      {data.verifyError || "Your Instagram connection stopped working."} Re-enter your Instagram Business account ID below to reconnect.
                    </p>
                  </div>
                )}
                <div className="space-y-2">
                  <label className="text-sm font-medium">Instagram Business account ID</label>
                  <Input
                    value={igUserId}
                    onChange={(e) => { setIgUserId(e.target.value); setDirty(true); }}
                    placeholder="17841400000000000"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button onClick={handleSave} disabled={save.isPending || !igUserId.trim()}>
                    {save.isPending ? (
                      <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Saving & verifying...</>
                    ) : (
                      "Save and verify"
                    )}
                  </Button>
                  {data?.saved && (
                    <>
                      <Button variant="outline" onClick={handleRetest} disabled={retest.isPending}>
                        {retest.isPending ? (
                          <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Re-testing...</>
                        ) : (
                          "Re-test now"
                        )}
                      </Button>
                      <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={handleDisconnect} disabled={disconnect.isPending}>
                        {disconnect.isPending ? (
                          <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Disconnecting...</>
                        ) : (
                          <><Trash2 className="h-4 w-4 mr-2" /> Disconnect</>
                        )}
                      </Button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function TwitterCredentialsCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useGetTwitterStatus();
  const disconnect = useDisconnectTwitter();
  const [connecting, setConnecting] = useState(false);

  const refreshTwitter = () => {
    queryClient.invalidateQueries({ queryKey: getGetTwitterStatusQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListAccountsQueryKey() });
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get("twitter");
    if (!status) return;
    if (status === "connected") {
      toast({ title: "X connected", description: "You can now publish posts to X." });
      refreshTwitter();
    } else if (status === "error") {
      toast({
        variant: "destructive",
        title: "X connection failed",
        description:
          "We couldn't finish connecting your X account. Please try again.",
      });
    }
    params.delete("twitter");
    params.delete("reason");
    const qs = params.toString();
    window.history.replaceState({}, "", window.location.pathname + (qs ? `?${qs}` : ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleConnect = async () => {
    setConnecting(true);
    try {
      const { url } = await getTwitterAuthUrl();
      window.location.href = url;
    } catch (err: any) {
      setConnecting(false);
      toast({
        variant: "destructive",
        title: "Couldn't start X connection",
        description:
          err?.response?.data?.error ||
          "X isn't configured yet. Please try again later.",
      });
    }
  };

  const handleDisconnect = () => {
    if (!confirm("Disconnect X? This clears your stored X connection. You'll need to reconnect to publish again.")) return;
    disconnect.mutate(undefined, {
      onSuccess: () => {
        refreshTwitter();
        toast({ title: "X disconnected", description: "Your stored X connection was cleared." });
      },
      onError: (err: any) => {
        toast({ variant: "destructive", title: "Could not disconnect", description: err?.response?.data?.error || "Please try again." });
      },
    });
  };

  return (
    <Card className="overflow-hidden border-border">
      <CardContent className="p-6">
        <div className="flex items-start gap-4">
          <div className="h-12 w-12 rounded-xl flex items-center justify-center bg-sky-500/10 text-sky-500 shrink-0">
            <Twitter className="h-6 w-6" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-bold text-lg">X (Twitter) Publishing</h3>
              {isLoading ? null : data?.connected ? (
                <span className="text-xs font-medium text-green-600 flex items-center gap-1 bg-green-600/10 px-2 py-0.5 rounded-full">
                  <CheckCircle2 className="h-3 w-3" /> Connected
                </span>
              ) : data?.expired ? (
                <span className="text-xs font-medium text-destructive flex items-center gap-1 bg-destructive/10 px-2 py-0.5 rounded-full">
                  <AlertCircle className="h-3 w-3" /> Reconnect needed
                </span>
              ) : data?.configured ? (
                <span className="text-xs font-medium text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                  Not connected
                </span>
              ) : (
                <span className="text-xs font-medium text-amber-600 flex items-center gap-1 bg-amber-600/10 px-2 py-0.5 rounded-full">
                  <AlertCircle className="h-3 w-3" /> Needs admin setup
                </span>
              )}
            </div>

            {isLoading ? (
              <div className="mt-3 space-y-3">
                <Skeleton className="h-10 w-full" />
              </div>
            ) : !data?.configured ? (
              <p className="mt-2 text-sm text-muted-foreground">
                X publishing needs a one-time X app setup by a platform administrator before you can connect your account.
              </p>
            ) : data?.connected ? (
              <div className="mt-2 space-y-3">
                <p className="text-sm text-muted-foreground">
                  Posting as <span className="font-medium text-foreground">{data.accountName}</span>. You can publish content items to X from the Content Library.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="outline" size="sm" onClick={handleConnect} disabled={connecting}>
                    {connecting ? (
                      <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Reconnecting...</>
                    ) : (
                      "Reconnect"
                    )}
                  </Button>
                  <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={handleDisconnect} disabled={disconnect.isPending}>
                    {disconnect.isPending ? (
                      <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Disconnecting...</>
                    ) : (
                      <><Trash2 className="h-4 w-4 mr-2" /> Disconnect</>
                    )}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-2 space-y-3">
                {data?.expired ? (
                  <p className="text-sm text-destructive">
                    Your X connection is no longer valid, so publishing is paused. Reconnect your account to resume posting.
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Connect your X account to publish posts directly. You will be redirected to X to authorize access.
                  </p>
                )}
                <Button onClick={handleConnect} disabled={connecting}>
                  {connecting ? (
                    <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Connecting...</>
                  ) : (
                    "Connect X"
                  )}
                </Button>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

const ICONS: Record<string, any> = {
  instagram: { icon: Instagram, color: "text-pink-600", bg: "bg-pink-600/10" },
  facebook: { icon: Facebook, color: "text-blue-600", bg: "bg-blue-600/10" },
  linkedin: { icon: Linkedin, color: "text-blue-700", bg: "bg-blue-700/10" },
  youtube: { icon: Youtube, color: "text-red-600", bg: "bg-red-600/10" },
};

const HANDLE_HINTS: Record<string, { placeholder: string; hint: string }> = {
  instagram: {
    placeholder: "@yourbrand",
    hint: "Open the Instagram app or instagram.com and go to your profile. Your handle is the @username shown at the top of your profile.",
  },
  facebook: {
    placeholder: "Your Page name",
    hint: "Go to facebook.com and open your Page. The name appears at the top of the Page, and the @handle is shown under it (Page Settings > Username).",
  },
  linkedin: {
    placeholder: "Your name or company",
    hint: "On linkedin.com, open your profile or company page. Your public handle is in the URL, e.g. linkedin.com/in/your-handle or /company/your-company.",
  },
  youtube: {
    placeholder: "@yourchannel",
    hint: "On youtube.com, click your avatar > Your channel. Your handle is the @name shown under the channel title (or in Settings > Channel).",
  },
};

export function AccountsPage() {
  const { data: accounts, isLoading } = useListAccounts();
  const { data: linkedinStatus } = useGetLinkedinStatus();
  const createAccount = useCreateAccount();
  const deleteAccount = useDeleteAccount();
  const disconnectLinkedin = useDisconnectLinkedin();
  const retestLinkedin = useRetestLinkedin();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [open, setOpen] = useState(false);
  const [platform, setPlatform] = useState<string>("instagram");
  const [accountName, setAccountName] = useState("");
  const [linkedinConnecting, setLinkedinConnecting] = useState(false);

  const refreshLinkedin = () => {
    queryClient.invalidateQueries({ queryKey: getGetLinkedinStatusQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListAccountsQueryKey() });
  };

  const handleDisconnectLinkedin = () => {
    if (
      !confirm(
        "Disconnect LinkedIn? This clears your stored LinkedIn token and account. You'll need to reconnect to publish again.",
      )
    )
      return;
    disconnectLinkedin.mutate(undefined, {
      onSuccess: () => {
        toast({ title: "LinkedIn disconnected" });
        refreshLinkedin();
      },
      onError: (err: any) => {
        toast({
          variant: "destructive",
          title: "Couldn't disconnect LinkedIn",
          description: err?.response?.data?.error || "Please try again.",
        });
      },
    });
  };

  const handleRetestLinkedin = () => {
    retestLinkedin.mutate(undefined, {
      onSuccess: (data) => {
        if (data.connected) {
          toast({
            title: "LinkedIn still connected",
            description: "Your stored token is still valid.",
          });
        } else {
          toast({
            variant: "destructive",
            title: "LinkedIn token no longer valid",
            description: "We cleared the broken connection. Please reconnect.",
          });
        }
        refreshLinkedin();
      },
      onError: (err: any) => {
        toast({
          variant: "destructive",
          title: "Couldn't re-test LinkedIn",
          description: err?.response?.data?.error || "Please try again.",
        });
      },
    });
  };

  const copyRedirect = () => {
    if (!linkedinStatus?.redirectUri) return;
    navigator.clipboard.writeText(linkedinStatus.redirectUri);
    toast({ title: "Redirect URL copied" });
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get("linkedin");
    if (!status) return;
    if (status === "connected") {
      toast({ title: "LinkedIn connected", description: "You can now publish posts to LinkedIn." });
      queryClient.invalidateQueries({ queryKey: getListAccountsQueryKey() });
    } else if (status === "error") {
      toast({
        variant: "destructive",
        title: "LinkedIn connection failed",
        description:
          "We couldn't finish connecting your LinkedIn account. Please try again.",
      });
    }
    params.delete("linkedin");
    params.delete("reason");
    const qs = params.toString();
    window.history.replaceState({}, "", window.location.pathname + (qs ? `?${qs}` : ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleConnectLinkedin = async () => {
    setLinkedinConnecting(true);
    try {
      const { url } = await getLinkedinAuthUrl();
      window.location.href = url;
    } catch (err: any) {
      setLinkedinConnecting(false);
      toast({
        variant: "destructive",
        title: "Couldn't start LinkedIn connection",
        description:
          err?.response?.data?.error ||
          "LinkedIn isn't configured yet. Please try again later.",
      });
    }
  };

  const handleCreate = () => {
    if (!accountName) return;
    createAccount.mutate({
      data: { platform: platform as any, accountName }
    }, {
      onSuccess: () => {
        toast({ title: "Account connected!" });
        queryClient.invalidateQueries({ queryKey: getListAccountsQueryKey() });
        setOpen(false);
        setAccountName("");
      },
      onError: (err: any) => {
        toast({
          variant: "destructive",
          title: "Couldn't connect account",
          description: err?.response?.data?.message || err?.message || "Please try again.",
        });
      },
    });
  };

  const handleDelete = (id: number) => {
    if (!confirm("Disconnect this account?")) return;
    deleteAccount.mutate({ id }, {
      onSuccess: () => {
        toast({ title: "Account disconnected" });
        queryClient.invalidateQueries({ queryKey: getListAccountsQueryKey() });
      }
    });
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-48" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-24 rounded-xl" />)}
        </div>
      </div>
    );
  }

  const items = accounts || [];

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-4xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight">Connected Accounts</h1>
          <p className="text-muted-foreground text-lg mt-1">Manage your linked social media profiles.</p>
        </div>
        <Button onClick={() => setOpen(true)} className="shadow-md">
          <Plus className="h-4 w-4 mr-2" /> Connect
        </Button>
      </div>

      <Card className="overflow-hidden border-border">
        <CardContent className="p-6">
          <div className="flex items-start gap-4">
            <div className="h-12 w-12 rounded-xl flex items-center justify-center bg-blue-700/10 text-blue-700 shrink-0">
              <Linkedin className="h-6 w-6" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="font-bold text-lg">LinkedIn Publishing</h3>
                {linkedinStatus?.connected ? (
                  <span className="text-xs font-medium text-green-600 flex items-center gap-1 bg-green-600/10 px-2 py-0.5 rounded-full">
                    <CheckCircle2 className="h-3 w-3" /> Connected
                  </span>
                ) : linkedinStatus?.expired ? (
                  <span className="text-xs font-medium text-destructive flex items-center gap-1 bg-destructive/10 px-2 py-0.5 rounded-full">
                    <AlertCircle className="h-3 w-3" /> Reconnect needed
                  </span>
                ) : linkedinStatus?.configured ? (
                  <span className="text-xs font-medium text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                    Not connected
                  </span>
                ) : (
                  <span className="text-xs font-medium text-amber-600 flex items-center gap-1 bg-amber-600/10 px-2 py-0.5 rounded-full">
                    <AlertCircle className="h-3 w-3" /> Needs setup
                  </span>
                )}
              </div>

              {linkedinStatus?.connected ? (
                <div className="mt-2 space-y-3">
                  <p className="text-sm text-muted-foreground">
                    Posting as <span className="font-medium text-foreground">{linkedinStatus.accountName}</span>. You can publish content items to your LinkedIn feed from the Content Library.
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="outline" size="sm" onClick={handleRetestLinkedin} disabled={retestLinkedin.isPending}>
                      {retestLinkedin.isPending ? (
                        <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Re-testing...</>
                      ) : (
                        "Re-test now"
                      )}
                    </Button>
                    <Button variant="outline" size="sm" onClick={handleConnectLinkedin} disabled={linkedinConnecting}>
                      {linkedinConnecting ? (
                        <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Reconnecting...</>
                      ) : (
                        "Reconnect"
                      )}
                    </Button>
                    <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={handleDisconnectLinkedin} disabled={disconnectLinkedin.isPending}>
                      {disconnectLinkedin.isPending ? (
                        <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Disconnecting...</>
                      ) : (
                        <><Trash2 className="h-4 w-4 mr-2" /> Disconnect</>
                      )}
                    </Button>
                  </div>
                </div>
              ) : linkedinStatus?.configured ? (
                <div className="mt-2 space-y-3">
                  {linkedinStatus?.expired ? (
                    <p className="text-sm text-destructive">
                      Your LinkedIn access token has expired or been revoked, so publishing is paused. Reconnect your account to resume posting.
                    </p>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Connect your LinkedIn account to publish posts directly to your feed. You will be redirected to LinkedIn to authorize access.
                    </p>
                  )}
                  <Button onClick={handleConnectLinkedin} disabled={linkedinConnecting}>
                    {linkedinConnecting ? (
                      <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> {linkedinStatus?.expired ? "Reconnecting..." : "Connecting..."}</>
                    ) : (
                      <><Linkedin className="h-4 w-4 mr-2" /> {linkedinStatus?.expired ? "Reconnect LinkedIn" : "Connect LinkedIn"}</>
                    )}
                  </Button>
                </div>
              ) : (
                <div className="mt-3 space-y-4">
                  <p className="text-sm text-muted-foreground">
                    LinkedIn publishing requires a one-time setup by the workspace administrator. Once configured, every member can connect their own LinkedIn account and publish from the Content Library.
                  </p>
                  <div className="rounded-lg border border-border bg-muted/40 p-4 space-y-3 text-sm">
                    <p className="font-semibold">Administrator setup</p>
                    <ol className="list-decimal pl-5 space-y-2 text-muted-foreground">
                      <li>
                        Create a LinkedIn app at{" "}
                        <a
                          href="https://www.linkedin.com/developers/apps"
                          target="_blank"
                          rel="noreferrer"
                          className="text-blue-700 font-medium inline-flex items-center gap-1 hover:underline"
                        >
                          linkedin.com/developers/apps <ExternalLink className="h-3 w-3" />
                        </a>
                      </li>
                      <li>
                        In the app's <span className="font-medium text-foreground">Products</span> tab, add both{" "}
                        <span className="font-medium text-foreground">"Sign In with LinkedIn using OpenID Connect"</span> and{" "}
                        <span className="font-medium text-foreground">"Share on LinkedIn"</span> (grants posting permission).
                      </li>
                      <li>
                        In the <span className="font-medium text-foreground">Auth</span> tab, add this exact Authorized redirect URL:
                        <div className="mt-1.5 flex items-center gap-2">
                          <code className="flex-1 truncate rounded bg-background border border-border px-2 py-1.5 text-xs">
                            {linkedinStatus?.redirectUri ?? "Loading..."}
                          </code>
                          <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" onClick={copyRedirect}>
                            <Copy className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </li>
                      <li>
                        Copy the <span className="font-medium text-foreground">Client ID</span> and{" "}
                        <span className="font-medium text-foreground">Client Secret</span> from the Auth tab and add them as the secrets{" "}
                        <code className="text-xs bg-background border border-border rounded px-1 py-0.5">LINKEDIN_CLIENT_ID</code> and{" "}
                        <code className="text-xs bg-background border border-border rounded px-1 py-0.5">LINKEDIN_CLIENT_SECRET</code>.
                      </li>
                    </ol>
                  </div>
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <FacebookCredentialsCard />
      <InstagramCredentialsCard />
      <TwitterCredentialsCard />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {items.length === 0 && (
          <div className="col-span-full text-center py-20 bg-card rounded-2xl border border-border">
            <Share2 className="mx-auto h-12 w-12 text-muted mb-4" />
            <h3 className="text-xl font-bold">No Accounts Connected</h3>
            <p className="text-muted-foreground mt-2 mb-6">Connect your social accounts to enable direct scheduling.</p>
            <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4 mr-2" /> Connect Account</Button>
          </div>
        )}
        
        {items.map((acc, i) => {
          const config = ICONS[acc.platform] || { icon: Share2, color: "text-primary", bg: "bg-primary/10" };
          const Icon = config.icon;
          
          return (
            <Card key={acc.id} className="overflow-hidden border-border group transition-all duration-300 hover:shadow-md animate-in fade-in" style={{ animationDelay: `${i * 50}ms` }}>
              <CardContent className="p-6 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className={`h-12 w-12 rounded-xl flex items-center justify-center ${config.bg} ${config.color}`}>
                    <Icon className="h-6 w-6" />
                  </div>
                  <div>
                    <h3 className="font-bold text-lg">{acc.accountName}</h3>
                    <div className="flex items-center gap-1.5 text-sm text-muted-foreground mt-0.5">
                      <span className="capitalize">{acc.platform}</span>
                      <span className="text-muted-foreground/30">•</span>
                      {acc.canPublish ? (
                        <span className="text-green-600 flex items-center gap-1"><CheckCircle2 className="h-3 w-3" /> Ready to publish</span>
                      ) : (
                        <span className="text-green-600 flex items-center gap-1"><CheckCircle2 className="h-3 w-3" /> Connected</span>
                      )}
                    </div>
                  </div>
                </div>
                <Button variant="ghost" size="icon" className="text-destructive/50 hover:text-destructive hover:bg-destructive/10" onClick={() => handleDelete(acc.id)}>
                  <Trash2 className="h-5 w-5" />
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Connect Account</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Platform</label>
              <Select onValueChange={setPlatform} value={platform}>
                <SelectTrigger><SelectValue placeholder="Select platform" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="instagram"><div className="flex items-center gap-2"><Instagram className="text-pink-600"/> Instagram</div></SelectItem>
                  <SelectItem value="facebook"><div className="flex items-center gap-2"><Facebook className="text-blue-600"/> Facebook</div></SelectItem>
                  <SelectItem value="linkedin"><div className="flex items-center gap-2"><Linkedin className="text-blue-700"/> LinkedIn</div></SelectItem>
                  <SelectItem value="youtube"><div className="flex items-center gap-2"><Youtube className="text-red-600"/> YouTube</div></SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Account Handle / Name</label>
              <Input
                value={accountName}
                onChange={e => setAccountName(e.target.value)}
                placeholder={HANDLE_HINTS[platform]?.placeholder ?? "@yourbrand"}
              />
              <p className="text-xs text-muted-foreground leading-relaxed">
                {HANDLE_HINTS[platform]?.hint}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={createAccount.isPending}>Cancel</Button>
            <Button onClick={handleCreate} disabled={createAccount.isPending || !accountName}>
              {createAccount.isPending ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Connecting...</>
              ) : (
                "Connect"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}