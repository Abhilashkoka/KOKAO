import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getAdminGetReelCostSettingsQueryKey,
  getGetReelSettingsQueryKey,
  useAdminGetReelCostSettings,
  useAdminUpdateReelCostSettings,
  type ReelCostSettingsInput,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/apiErrorMessage";

const QUALITY: { value: ReelCostSettingsInput["tryOnImageQuality"]; label: string; hint: string }[] = [
  { value: "low", label: "Low", hint: "≈ ₹1 per look" },
  { value: "medium", label: "Medium", hint: "≈ ₹4 per look · recommended" },
  { value: "high", label: "High", hint: "≈ ₹16 per look" },
  { value: "auto", label: "Auto (provider decides)", hint: "often High" },
];
const RESOLUTION: { value: ReelCostSettingsInput["reelResolution"]; label: string }[] = [
  { value: "480p", label: "480p · cheapest" },
  { value: "720p", label: "720p · recommended for reels" },
  { value: "1080p", label: "1080p · sharpest, costs most" },
];
const STYLE: { value: ReelCostSettingsInput["defaultReelStyle"]; label: string }[] = [
  { value: "hero", label: "Hero reel (1 AI clip + photos)" },
  { value: "video", label: "Video reel (AI clip per look)" },
  { value: "photo", label: "Photo reel (no AI video)" },
];

const FIELD_LABELS: Record<string, string> = {
  tryOnImageQuality: "Dressing quality",
  reelResolution: "Reel resolution",
  defaultBars: "Bars per look",
  heroModeEnabled: "Hero reel",
  defaultReelStyle: "Default reel type",
};

/** "Reel resolution: 1080p → 720p · Bars per look: 2 → 1" */
function describeChange(from: string | null, to: string | null): string {
  try {
    const a = JSON.parse(from ?? "{}") as Record<string, unknown>;
    const b = JSON.parse(to ?? "{}") as Record<string, unknown>;
    const parts = Object.keys(FIELD_LABELS)
      .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
      .map((k) => `${FIELD_LABELS[k]}: ${String(a[k] ?? "—")} → ${String(b[k])}`);
    return parts.length ? parts.join(" · ") : "Saved without changes";
  } catch {
    return "Settings changed";
  }
}

/**
 * Superadmin cost controls for Showcase reels. Saved platform-wide; every
 * change is written to the admin audit log and listed below.
 */
export function ReelCostSettingsCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading } = useAdminGetReelCostSettings();
  const save = useAdminUpdateReelCostSettings();
  const [form, setForm] = useState<ReelCostSettingsInput | null>(null);

  useEffect(() => {
    if (data?.settings && !form) {
      const { updatedAt: _a, updatedBy: _b, ...rest } = data.settings;
      setForm(rest);
    }
  }, [data, form]);

  const set = (patch: Partial<ReelCostSettingsInput>) =>
    setForm((prev) => (prev ? { ...prev, ...patch } : prev));

  const onSave = () => {
    if (!form) return;
    save.mutate(
      { data: form },
      {
        onSuccess: (result) => {
          queryClient.setQueryData(getAdminGetReelCostSettingsQueryKey(), result);
          void queryClient.invalidateQueries({ queryKey: getGetReelSettingsQueryKey() });
          toast({ title: "Reel cost settings saved" });
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
    <Card data-testid="reel-cost-settings">
      <CardHeader>
        <CardTitle>Reel cost settings</CardTitle>
        <CardDescription>
          Controls what a Showcase reel costs to make. Applies to every workspace from the next
          reel. Changes are recorded below.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {isLoading || !form ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <>
            <div className="grid gap-5 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Dressing image quality</Label>
                <Select
                  value={form.tryOnImageQuality}
                  onValueChange={(v) => set({ tryOnImageQuality: v as ReelCostSettingsInput["tryOnImageQuality"] })}
                >
                  <SelectTrigger data-testid="reel-cost-quality">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {QUALITY.map((q) => (
                      <SelectItem key={q.value} value={q.value}>
                        {q.label} — {q.hint}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Reel video resolution</Label>
                <Select
                  value={form.reelResolution}
                  onValueChange={(v) => set({ reelResolution: v as ReelCostSettingsInput["reelResolution"] })}
                >
                  <SelectTrigger data-testid="reel-cost-resolution">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RESOLUTION.map((r) => (
                      <SelectItem key={r.value} value={r.value}>
                        {r.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Default bars per look</Label>
                <Select
                  value={String(form.defaultBars)}
                  onValueChange={(v) => set({ defaultBars: Number(v) })}
                >
                  <SelectTrigger data-testid="reel-cost-bars">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">1 bar · shortest clips, cheapest</SelectItem>
                    <SelectItem value="2">2 bars</SelectItem>
                    <SelectItem value="3">3 bars · longest</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Default reel type</Label>
                <Select
                  value={form.defaultReelStyle}
                  onValueChange={(v) => set({ defaultReelStyle: v as ReelCostSettingsInput["defaultReelStyle"] })}
                >
                  <SelectTrigger data-testid="reel-cost-style">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STYLE.filter((s) => s.value !== "hero" || form.heroModeEnabled).map((s) => (
                      <SelectItem key={s.value} value={s.value}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex items-center justify-between rounded-2xl border p-4">
              <div>
                <p className="font-semibold">Offer Hero reel</p>
                <p className="text-sm text-muted-foreground">
                  One look is an AI video, the rest move as photos. Priced as one clip.
                </p>
              </div>
              <Switch
                checked={form.heroModeEnabled}
                onCheckedChange={(on) =>
                  set({
                    heroModeEnabled: on,
                    ...(!on && form.defaultReelStyle === "hero" ? { defaultReelStyle: "video" } : {}),
                  })
                }
                data-testid="reel-cost-hero"
              />
            </div>
            <div className="flex items-center gap-3">
              <Button onClick={onSave} disabled={save.isPending} data-testid="reel-cost-save">
                Save settings
              </Button>
              {data?.settings.updatedAt && (
                <span className="text-xs text-muted-foreground">
                  Last saved {new Date(data.settings.updatedAt).toLocaleString("en-IN")}
                  {data.settings.updatedBy ? ` by ${data.settings.updatedBy}` : ""}
                </span>
              )}
            </div>
            <div className="space-y-2">
              <p className="text-sm font-semibold">Change history</p>
              {data?.history.length ? (
                <ul className="space-y-1 text-sm" data-testid="reel-cost-history">
                  {data.history.map((h) => (
                    <li key={h.at} className="rounded-xl bg-muted/50 px-3 py-2">
                      <span className="text-muted-foreground">
                        {new Date(h.at).toLocaleString("en-IN")}
                        {h.by ? ` · ${h.by}` : ""}
                      </span>
                      <br />
                      {describeChange(h.from, h.to)}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No changes yet. Defaults are in use.</p>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
