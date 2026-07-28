import { useState, useEffect } from "react";
import { RippleSpinner } from "@/components/ui/ripple-spinner";
import {
  useAdminGetEmailSettings,
  useAdminUpdateEmailSettings,
  useAdminSendTestEmail,
  getAdminGetEmailSettingsQueryKey,
  useAdminListNotificationPolicies,
  useAdminUpdateNotificationPolicies,
  getAdminListNotificationPoliciesQueryKey,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { CheckCircle2, AlertCircle } from "lucide-react";
import { apiErrorMessage } from "@/lib/apiErrorMessage";

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
            description: apiErrorMessage(err, "Please try again."),
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
            description: apiErrorMessage(err, "Please try again."),
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
                  <RippleSpinner className="h-4 w-4 mr-2" /> Saving...
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
                      <RippleSpinner className="h-4 w-4 mr-2" /> Sending...
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

export function NotificationsTab() {
  return (
    <div className="space-y-8">
      <EmailDeliveryCard />
      <NotificationPoliciesCard />
    </div>
  );
}
