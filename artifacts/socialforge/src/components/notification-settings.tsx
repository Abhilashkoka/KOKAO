import { useEffect, useState } from "react";
import {
  useGetNotificationSettings,
  useUpdateNotificationSettings,
  getGetNotificationSettingsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  CardFooter,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Bell, Mail, MonitorSmartphone, Info } from "lucide-react";

type PrefState = { inApp: boolean; email: boolean };

export function NotificationSettings() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useGetNotificationSettings();
  const update = useUpdateNotificationSettings();

  const [prefs, setPrefs] = useState<Record<string, PrefState>>({});

  useEffect(() => {
    if (data) {
      const next: Record<string, PrefState> = {};
      for (const t of data.types) {
        next[t.type] = { inApp: t.preference.inApp, email: t.preference.email };
      }
      setPrefs(next);
    }
  }, [data]);

  if (isLoading) {
    return (
      <Card className="border-border shadow-sm">
        <CardHeader>
          <Skeleton className="h-6 w-40" />
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (!data) return null;

  const memberScoped = data.scope === "member";

  const setPref = (type: string, patch: Partial<PrefState>) => {
    setPrefs((prev) => ({
      ...prev,
      [type]: { ...prev[type], ...patch },
    }));
  };

  const handleSave = () => {
    const preferences = data.types.map((t) => ({
      type: t.type,
      inApp: prefs[t.type]?.inApp ?? t.preference.inApp,
      email: prefs[t.type]?.email ?? t.preference.email,
    }));
    update.mutate(
      { data: { preferences } },
      {
        onSuccess: () => {
          toast({ title: "Notification preferences saved" });
          queryClient.invalidateQueries({
            queryKey: getGetNotificationSettingsQueryKey(),
          });
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
    <Card className="border-border shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bell className="h-5 w-5 text-primary" /> Notifications
        </CardTitle>
        <CardDescription>
          Choose how you want to be alerted for each kind of notification.
          In-app popups show inside the app; email reaches you even when the app
          is closed.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {memberScoped && (
          <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm">
            <Info className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
            <p className="text-muted-foreground">
              You're a team member of this workspace, so these choices apply
              only to you. Turning email off here stops emails sent to you
              without affecting the workspace owner or other teammates.
            </p>
          </div>
        )}
        {!data.emailConfigured && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm">
            <Info className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
            <p className="text-muted-foreground">
              Email delivery isn't connected yet, so email alerts won't send
              until an administrator sets it up. Your choices below are saved and
              take effect automatically once email is enabled.
            </p>
          </div>
        )}

        {data.types.map((t) => {
          const pref = prefs[t.type] ?? {
            inApp: t.preference.inApp,
            email: t.preference.email,
          };
          const emailLocked = t.emailPolicy !== "optional" || !t.enabled;
          const emailChecked =
            t.enabled &&
            (t.emailPolicy === "forced"
              ? true
              : t.emailPolicy === "off"
                ? false
                : pref.email);

          return (
            <div
              key={t.type}
              className={`rounded-xl border border-border p-4 space-y-4 ${
                !t.enabled ? "opacity-60" : ""
              }`}
            >
              <div>
                <p className="font-semibold text-sm">{t.label}</p>
                <p className="text-sm text-muted-foreground">{t.description}</p>
                {!t.enabled && (
                  <p className="text-xs text-muted-foreground mt-1">
                    This notification is turned off by your administrator.
                  </p>
                )}
              </div>

              {!memberScoped && (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm">
                  <MonitorSmartphone className="h-4 w-4 text-muted-foreground" />
                  <span>In-app popup</span>
                </div>
                <Switch
                  checked={t.enabled && pref.inApp}
                  disabled={!t.enabled}
                  onCheckedChange={(checked) =>
                    setPref(t.type, { inApp: checked })
                  }
                  aria-label={`Toggle in-app popup for ${t.label}`}
                />
              </div>
              )}

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm">
                  <Mail className="h-4 w-4 text-muted-foreground" />
                  <span>Email</span>
                  {t.emailPolicy === "forced" && (
                    <span className="text-xs text-muted-foreground">
                      (required by admin)
                    </span>
                  )}
                  {t.emailPolicy === "off" && (
                    <span className="text-xs text-muted-foreground">
                      (disabled by admin)
                    </span>
                  )}
                </div>
                <Switch
                  checked={emailChecked}
                  disabled={emailLocked}
                  onCheckedChange={(checked) =>
                    setPref(t.type, { email: checked })
                  }
                  aria-label={`Toggle email for ${t.label}`}
                />
              </div>
            </div>
          );
        })}
      </CardContent>
      <CardFooter className="bg-muted/30 border-t border-border px-6 py-4">
        <Button onClick={handleSave} disabled={update.isPending}>
          Save Changes
        </Button>
      </CardFooter>
    </Card>
  );
}
