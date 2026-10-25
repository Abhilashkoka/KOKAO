import { useEffect, useState } from "react";
import {
  useAdminGetGoodwillSettings,
  useAdminUpdateGoodwillSettings,
  useAdminGetGoodwillReport,
  getAdminGetGoodwillSettingsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { HeartHandshake } from "lucide-react";
import { apiErrorMessage } from "@/lib/apiErrorMessage";

const FIELDS = [
  { key: "freeImageRedosPerVideo", label: "Free storyboard image redos per video", max: 20 },
  { key: "freeSmartEditSeconds", label: "Free Smart Edit seconds (first picture edit per video)", max: 12 },
  { key: "monthlyBudgetCredits", label: "Monthly goodwill budget per workspace (credits)", max: 1_000_000 },
  { key: "dailyAlarmCredits", label: "Daily alarm, all workspaces (credits, 0 = off)", max: 100_000_000 },
] as const;

type FieldKey = (typeof FIELDS)[number]["key"];

function fmt(n: number): string {
  return n.toLocaleString("en-IN", { maximumFractionDigits: 1 });
}

/**
 * Superadmin control for free fixes. Every free fix is still metered at its
 * real cost; this decides how much KOKAO credits back, and shows what that
 * has cost today and this month.
 */
export function GoodwillCard() {
  const { data: settings, isLoading } = useAdminGetGoodwillSettings();
  const { data: report } = useAdminGetGoodwillReport();
  const update = useAdminUpdateGoodwillSettings();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [enabled, setEnabled] = useState(true);
  const [values, setValues] = useState<Record<FieldKey, string>>({
    freeImageRedosPerVideo: "1",
    freeSmartEditSeconds: "3",
    monthlyBudgetCredits: "50",
    dailyAlarmCredits: "500",
  });

  useEffect(() => {
    if (!settings) return;
    setEnabled(settings.enabled);
    setValues({
      freeImageRedosPerVideo: String(settings.freeImageRedosPerVideo),
      freeSmartEditSeconds: String(settings.freeSmartEditSeconds),
      monthlyBudgetCredits: String(settings.monthlyBudgetCredits),
      dailyAlarmCredits: String(settings.dailyAlarmCredits),
    });
  }, [settings]);

  const save = () => {
    const parsed = {} as Record<FieldKey, number>;
    for (const field of FIELDS) {
      const n = Math.trunc(Number(values[field.key]));
      if (!Number.isFinite(n) || n < 0 || n > field.max) {
        toast({
          title: "Check the numbers",
          description: `${field.label} must be 0–${fmt(field.max)}.`,
          variant: "destructive",
        });
        return;
      }
      parsed[field.key] = n;
    }
    update.mutate(
      { data: { enabled, ...parsed } },
      {
        onSuccess: () => {
          toast({ title: "Goodwill settings saved" });
          queryClient.invalidateQueries({ queryKey: getAdminGetGoodwillSettingsQueryKey() });
        },
        onError: (error) =>
          toast({
            title: "Could not save",
            description: apiErrorMessage(error, "Please try again."),
            variant: "destructive",
          }),
      },
    );
  };

  return (
    <Card className="border-border shadow-sm" data-testid="card-goodwill">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HeartHandshake className="h-5 w-5 text-primary" /> Goodwill (free fixes)
        </CardTitle>
        <CardDescription>
          So users never pay for the AI&apos;s mistakes. Free fixes are still
          metered at their real cost; only credit-paying workspaces get them.
          Aim to keep goodwill under 5% of revenue.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {report && (
          <div className="grid gap-3 sm:grid-cols-3" data-testid="goodwill-report">
            <div className="rounded-md border border-border p-3">
              <p className="text-xs text-muted-foreground">Today</p>
              <p className="text-lg font-semibold tabular-nums">{fmt(report.todayCredits)} credits</p>
            </div>
            <div className="rounded-md border border-border p-3">
              <p className="text-xs text-muted-foreground">This month</p>
              <p className="text-lg font-semibold tabular-nums">{fmt(report.monthCredits)} credits</p>
            </div>
            <div className="rounded-md border border-border p-3">
              <p className="text-xs text-muted-foreground">Free fixes this month</p>
              <p className="text-lg font-semibold tabular-nums">{fmt(report.monthFixes)}</p>
            </div>
          </div>
        )}
        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : (
          <>
            <div className="flex items-center gap-3">
              <Switch
                checked={enabled}
                onCheckedChange={setEnabled}
                data-testid="switch-goodwill-enabled"
              />
              <span className="text-sm">{enabled ? "Free fixes on" : "Off — every fix is charged"}</span>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {FIELDS.map((field) => (
                <div key={field.key} className="space-y-1.5">
                  <Label htmlFor={`goodwill-${field.key}`}>{field.label}</Label>
                  <Input
                    id={`goodwill-${field.key}`}
                    type="number"
                    min={0}
                    max={field.max}
                    value={values[field.key]}
                    onChange={(e) =>
                      setValues((current) => ({ ...current, [field.key]: e.target.value }))
                    }
                    data-testid={`input-goodwill-${field.key}`}
                  />
                </div>
              ))}
            </div>
            <Button onClick={save} disabled={update.isPending} data-testid="button-save-goodwill">
              {update.isPending ? "Saving..." : "Save"}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
