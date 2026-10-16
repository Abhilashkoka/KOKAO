import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getAdminListQuickCreatePresetsQueryKey,
  getListQuickCreatePresetsQueryKey,
  useAdminCreateQuickCreatePreset,
  useAdminDeleteQuickCreatePreset,
  useAdminListQuickCreatePresets,
  useAdminUpdateQuickCreatePreset,
  type QuickCreatePreset,
  type QuickCreatePresetInput,
} from "@workspace/api-client-react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { QUICK_CREATE_PRESETS, QUICK_CREATE_VERTICALS } from "@/lib/quick-create-presets";

const LENGTHS = [5, 10, 15, 30] as const;
const ASPECTS = ["9:16", "1:1", "16:9"] as const;

const EMPTY: QuickCreatePresetInput = {
  label: "",
  vertical: "fashion",
  prompt: "",
  durationSec: 10,
  aspect: "9:16",
  photoHint: null,
  musicPrompt: null,
  published: false,
  sortOrder: 0,
};

function toInput(preset: QuickCreatePreset): QuickCreatePresetInput {
  const { id: _id, durationSec, ...rest } = preset;
  const snapped = LENGTHS.includes(durationSec as (typeof LENGTHS)[number]) ? durationSec : 10;
  return { ...rest, durationSec: snapped as QuickCreatePresetInput["durationSec"] };
}

function verticalLabel(id: string): string {
  return QUICK_CREATE_VERTICALS.find((v) => v.id === id)?.label ?? id;
}

/**
 * Superadmin editor for the starters shown on Quick Create. Until at least
 * one starter is published, tenants see the built-in list instead.
 */
export function QuickCreateTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: presets, isLoading } = useAdminListQuickCreatePresets();
  const create = useAdminCreateQuickCreatePreset();
  const update = useAdminUpdateQuickCreatePreset();
  const remove = useAdminDeleteQuickCreatePreset();
  const [editingId, setEditingId] = useState<number | "new" | null>(null);
  const [form, setForm] = useState<QuickCreatePresetInput>(EMPTY);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: getAdminListQuickCreatePresetsQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getListQuickCreatePresetsQueryKey() });
  };
  const fail = (title: string) => (error: unknown) =>
    toast({ title, description: apiErrorMessage(error, "Please try again."), variant: "destructive" });

  const startNew = () => {
    setForm(EMPTY);
    setEditingId("new");
  };
  const startEdit = (preset: QuickCreatePreset) => {
    setForm(toInput(preset));
    setEditingId(preset.id);
  };

  const save = () => {
    const data = { ...form, photoHint: form.photoHint || null, musicPrompt: form.musicPrompt || null };
    const done = {
      onSuccess: () => {
        refresh();
        setEditingId(null);
        toast({ title: "Starter saved" });
      },
      onError: fail("Could not save the starter"),
    };
    if (editingId === "new") create.mutate({ data }, done);
    else if (typeof editingId === "number") update.mutate({ presetId: editingId, data }, done);
  };

  const togglePublished = (preset: QuickCreatePreset, published: boolean) =>
    update.mutate(
      { presetId: preset.id, data: { ...toInput(preset), published } },
      { onSuccess: refresh, onError: fail("Could not update the starter") },
    );

  const importBuiltIns = async () => {
    try {
      for (const [index, p] of QUICK_CREATE_PRESETS.entries()) {
        await create.mutateAsync({
          data: {
            label: p.label,
            vertical: p.vertical,
            prompt: p.prompt,
            durationSec: p.durationSec as QuickCreatePresetInput["durationSec"],
            aspect: p.aspect,
            photoHint: p.photoHint ?? null,
            musicPrompt: p.musicPrompt ?? null,
            published: false,
            sortOrder: index,
          },
        });
      }
      refresh();
      toast({ title: "Built-in starters added as drafts" });
    } catch (error) {
      refresh();
      fail("Could not add the built-in starters")(error);
    }
  };

  const saving = create.isPending || update.isPending;

  return (
    <div className="space-y-6" data-testid="admin-quick-create-tab">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
          <div className="space-y-1">
            <CardTitle>Quick Create starters</CardTitle>
            <CardDescription>
              One-tap starters on the Create page. Each fills the prompt, length, shape and music.
              Until one is published, users see the built-in list.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            {presets && presets.length === 0 && (
              <Button variant="outline" onClick={importBuiltIns} disabled={create.isPending}>
                Import built-in starters
              </Button>
            )}
            <Button onClick={startNew} data-testid="qc-admin-new">
              <Plus className="mr-2 h-4 w-4" /> New starter
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : !presets || presets.length === 0 ? (
            <p className="text-sm text-muted-foreground">No starters yet.</p>
          ) : (
            presets.map((preset) => (
              <div
                key={preset.id}
                className="flex flex-wrap items-center gap-3 rounded-2xl border p-4"
                data-testid={`qc-admin-row-${preset.id}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{preset.label}</span>
                    <Badge variant="secondary">{verticalLabel(preset.vertical)}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {preset.durationSec}s · {preset.aspect}
                    </span>
                  </div>
                  <p className="truncate text-sm text-muted-foreground">{preset.prompt}</p>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <Switch
                    checked={preset.published}
                    onCheckedChange={(checked) => togglePublished(preset, checked)}
                    aria-label={`Publish ${preset.label}`}
                  />
                  Published
                </label>
                <Button variant="ghost" size="icon" aria-label={`Edit ${preset.label}`} onClick={() => startEdit(preset)}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Delete ${preset.label}`}
                  onClick={() =>
                    remove.mutate(
                      { presetId: preset.id },
                      { onSuccess: refresh, onError: fail("Could not delete the starter") },
                    )
                  }
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {editingId !== null && (
        <Card data-testid="qc-admin-form">
          <CardHeader>
            <CardTitle>{editingId === "new" ? "New starter" : "Edit starter"}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="qc-admin-label">Name</Label>
                <Input
                  id="qc-admin-label"
                  value={form.label}
                  maxLength={60}
                  onChange={(e) => setForm({ ...form, label: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="qc-admin-vertical">Business type</Label>
                <Select
                  value={form.vertical}
                  onValueChange={(v) => setForm({ ...form, vertical: v as QuickCreatePresetInput["vertical"] })}
                >
                  <SelectTrigger id="qc-admin-vertical">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {QUICK_CREATE_VERTICALS.map((v) => (
                      <SelectItem key={v.id} value={v.id}>
                        {v.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="qc-admin-prompt">Starter prompt</Label>
              <Textarea
                id="qc-admin-prompt"
                rows={3}
                maxLength={600}
                value={form.prompt}
                onChange={(e) => setForm({ ...form, prompt: e.target.value })}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-4">
              <div className="space-y-2">
                <Label htmlFor="qc-admin-length">Length</Label>
                <Select
                  value={String(form.durationSec)}
                  onValueChange={(v) =>
                    setForm({ ...form, durationSec: Number(v) as QuickCreatePresetInput["durationSec"] })
                  }
                >
                  <SelectTrigger id="qc-admin-length">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LENGTHS.map((d) => (
                      <SelectItem key={d} value={String(d)}>
                        {d} seconds
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="qc-admin-aspect">Shape</Label>
                <Select
                  value={form.aspect}
                  onValueChange={(v) => setForm({ ...form, aspect: v as QuickCreatePresetInput["aspect"] })}
                >
                  <SelectTrigger id="qc-admin-aspect">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ASPECTS.map((a) => (
                      <SelectItem key={a} value={a}>
                        {a}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="qc-admin-order">Order</Label>
                <Input
                  id="qc-admin-order"
                  type="number"
                  min={0}
                  max={1000}
                  value={form.sortOrder ?? 0}
                  onChange={(e) => setForm({ ...form, sortOrder: Math.max(0, Math.min(1000, Number(e.target.value) || 0)) })}
                />
              </div>
              <label className="flex items-end gap-2 pb-2 text-sm">
                <Switch
                  checked={Boolean(form.published)}
                  onCheckedChange={(checked) => setForm({ ...form, published: checked })}
                />
                Published
              </label>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="qc-admin-photo">Photo hint (optional)</Label>
                <Input
                  id="qc-admin-photo"
                  maxLength={80}
                  placeholder="Add a photo of the saree"
                  value={form.photoHint ?? ""}
                  onChange={(e) => setForm({ ...form, photoHint: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="qc-admin-music">Music (optional)</Label>
                <Input
                  id="qc-admin-music"
                  maxLength={200}
                  placeholder="Soft sitar, festive"
                  value={form.musicPrompt ?? ""}
                  onChange={(e) => setForm({ ...form, musicPrompt: e.target.value })}
                />
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                onClick={save}
                disabled={saving || !form.label.trim() || !form.prompt.trim()}
                data-testid="qc-admin-save"
              >
                Save
              </Button>
              <Button variant="outline" onClick={() => setEditingId(null)}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
