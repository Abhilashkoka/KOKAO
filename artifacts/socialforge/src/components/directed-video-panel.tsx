import { useRef } from "react";
import { Clapperboard, ImagePlus, Plus, Type, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DIRECTED_MAX_ASSETS,
  DIRECTED_MAX_OVERLAYS,
  DIRECTED_OVERLAY_MAX_CHARS,
  classifyDirectedFile,
  type DirectedBrandOptions,
  type DirectedDraft,
} from "./directed-video";

type Props = {
  draft: DirectedDraft;
  onChange: (update: (prev: DirectedDraft) => DirectedDraft) => void;
  onToggle: (enabled: boolean) => void;
  durationSec: number;
  hasSelectedCast: boolean;
  hasCompatibleModel: boolean;
  castRestriction: string | null;
  brandKits: { id: number; name: string }[] | undefined;
  brandKitId: number | null;
  onBrandKitChange: (id: number | null) => void;
  brand: DirectedBrandOptions;
  brandLoading: boolean;
  uploadFile: (file: File) => Promise<string>;
  onUploadStart: () => void;
  onUploadEnd: () => void;
};

const num = (v: string) => (v === "" ? Number.NaN : Number(v));

export function DirectedVideoPanel(props: Props) {
  const { draft, onChange, durationSec, brand } = props;
  const fileRef = useRef<HTMLInputElement>(null);
  const retryFiles = useRef(new Map<string, File>());

  const startUpload = (key: string, file: File) => {
    props.onUploadStart();
    onChange((d) => ({
      ...d,
      assets: d.assets.map((a) =>
        a.key === key ? { ...a, status: "uploading", error: undefined } : a,
      ),
    }));
    props
      .uploadFile(file)
      .then((objectPath) => {
        retryFiles.current.delete(key);
        onChange((d) => ({
          ...d,
          assets: d.assets.map((a) =>
            a.key === key ? { ...a, status: "ready", objectPath } : a,
          ),
        }));
      })
      .catch((err: unknown) => {
        onChange((d) => ({
          ...d,
          assets: d.assets.map((a) =>
            a.key === key
              ? {
                  ...a,
                  status: "failed",
                  error: err instanceof Error ? err.message : "Upload failed",
                }
              : a,
          ),
        }));
      })
      .finally(props.onUploadEnd);
  };

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    const room = DIRECTED_MAX_ASSETS - draft.assets.length;
    Array.from(files)
      .slice(0, Math.max(0, room))
      .forEach((file) => {
        const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const check = classifyDirectedFile(file);
        const end = Math.min(durationSec, 2);
        onChange((d) => ({
          ...d,
          assets: [
            ...d.assets,
            {
              key,
              name: file.name,
              kind: "kind" in check ? check.kind : "image",
              status: "error" in check ? "failed" : "uploading",
              error: "error" in check ? check.error : undefined,
              objectPath: null,
              startSec: 0,
              endSec: end,
              placement: "corner",
            },
          ],
        }));
        if ("kind" in check) {
          retryFiles.current.set(key, file);
          startUpload(key, file);
        }
      });
  };

  const anyLogo = brand.logos.primary || brand.logos.secondary || brand.logos.icon_mark;

  return (
    <div
      className="space-y-3 rounded-md border border-border px-3 py-3"
      data-testid="panel-directed-video"
    >
      <div className="flex items-start gap-3">
        <Switch
          id="directed-video"
          checked={draft.enabled}
          onCheckedChange={props.onToggle}
          data-testid="switch-directed-video"
        />
        <div className="space-y-0.5">
          <Label htmlFor="directed-video" className="flex items-center gap-1.5">
            <Clapperboard className="h-4 w-4 text-primary" />
            Let KOKAO direct it (optional)
          </Label>
          <p className="text-xs text-muted-foreground">
            One video generation, then your exact text, assets and brand
            ending are added on top. Shot count and storyboard review are off
            while this is on.
          </p>
          <p className="text-xs text-muted-foreground">
            AI direction and video generation use credits. Real-person characters
            need approved references and permission for the selected provider.
            Uploaded recording audio is not used; short recordings hold their final frame.
          </p>
        </div>
      </div>

      {draft.enabled && props.castRestriction && (
        <p className="text-xs text-destructive" data-testid="text-directed-cast-restriction">
          {props.castRestriction}
        </p>
      )}
      {draft.enabled && !props.castRestriction && !props.hasCompatibleModel && (
        <p className="text-xs text-destructive" data-testid="text-directed-no-model">
          {props.hasSelectedCast
            ? "With a saved character this needs Atlas Wan 3.0 Standard or Prime Reference, which is not configured."
            : "Needs Atlas Wan 3.0 Standard or Prime Text-to-Video, which is not configured."}
        </p>
      )}
      {draft.enabled && props.hasSelectedCast && !props.castRestriction && (
        <p className="text-xs text-muted-foreground">
          Your character's approved reference sheet and outfit are sent
          directly as references.
        </p>
      )}

      {draft.enabled && (
        <div className="space-y-4 pt-1">
          {!props.hasSelectedCast && (
            <div className="space-y-1.5">
              <Label htmlFor="directed-fictional">
                Fictional actor (optional)
              </Label>
              <Textarea
                id="directed-fictional"
                rows={2}
                maxLength={1500}
                value={draft.fictionalCharacter}
                onChange={(e) =>
                  onChange((d) => ({ ...d, fictionalCharacter: e.target.value }))
                }
                placeholder="A woman in her thirties, short grey hair, linen apron, calm and direct"
                data-testid="input-directed-fictional"
              />
              <p className="text-xs text-muted-foreground">
                Describe someone invented for this one video, or pick a saved
                character above instead.
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="directed-branding">Branding notes (optional)</Label>
            <Textarea
              id="directed-branding"
              rows={2}
              maxLength={3000}
              value={draft.brandingInstructions}
              onChange={(e) =>
                onChange((d) => ({ ...d, brandingInstructions: e.target.value }))
              }
              placeholder="Teal and cream palette, product always label-forward"
              data-testid="input-directed-branding"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="directed-brand-kit">Brand kit</Label>
            <Select
              value={props.brandKitId === null ? "none" : String(props.brandKitId)}
              onValueChange={(v) =>
                props.onBrandKitChange(v === "none" ? null : Number(v))
              }
            >
              <SelectTrigger id="directed-brand-kit" data-testid="select-directed-brand-kit">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No brand kit</SelectItem>
                {props.brandKits?.map((kit) => (
                  <SelectItem key={kit.id} value={String(kit.id)}>
                    {kit.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {props.brandKitId !== null && props.brandLoading && (
              <div className="h-16 animate-pulse rounded-md bg-muted" />
            )}
            {props.brandKitId !== null && !props.brandLoading && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="directed-ending" className="text-xs">
                    Add a brand ending?
                  </Label>
                  <Select
                    value={draft.ending}
                    onValueChange={(v) =>
                      onChange((d) => ({ ...d, ending: v as DirectedDraft["ending"] }))
                    }
                  >
                    <SelectTrigger id="directed-ending" data-testid="select-directed-ending">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No ending</SelectItem>
                      <SelectItem value="logo" disabled={!brand.logos.primary}>
                        Logo card{brand.logos.primary ? "" : " (no primary logo)"}
                      </SelectItem>
                      <SelectItem value="animation" disabled={!brand.animation.available}>
                        Logo animation
                        {brand.animation.available ? "" : " (not set up)"}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  {draft.ending !== "none" && (
                    <p className="text-xs text-muted-foreground" data-testid="text-directed-ending-length">
                      Appended after the clip; adds{" "}
                      {draft.ending === "animation" && brand.animation.durationSec
                        ? `${brand.animation.durationSec} seconds`
                        : "2 to 5 seconds"}{" "}
                      to the {durationSec}s video.
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="directed-brand-image" className="text-xs">
                    Show a logo in the corner?
                  </Label>
                  <Select
                    value={draft.brandImage}
                    onValueChange={(v) =>
                      onChange((d) => ({ ...d, brandImage: v as DirectedDraft["brandImage"] }))
                    }
                  >
                    <SelectTrigger id="directed-brand-image" data-testid="select-directed-brand-image">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No logo overlay</SelectItem>
                      <SelectItem value="primary" disabled={!brand.logos.primary}>Primary logo</SelectItem>
                      <SelectItem value="secondary" disabled={!brand.logos.secondary}>Secondary logo</SelectItem>
                      <SelectItem value="icon_mark" disabled={!brand.logos.icon_mark}>Icon mark</SelectItem>
                    </SelectContent>
                  </Select>
                  {!anyLogo && (
                    <p className="text-xs text-muted-foreground">This kit has no logos yet.</p>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Your assets ({draft.assets.length}/{DIRECTED_MAX_ASSETS})</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={draft.assets.length >= DIRECTED_MAX_ASSETS}
                onClick={() => fileRef.current?.click()}
                data-testid="button-directed-add-asset"
              >
                <ImagePlus className="mr-1.5 h-3.5 w-3.5" />
                Add file
              </Button>
              <input
                ref={fileRef}
                type="file"
                hidden
                multiple
                accept="image/png,image/jpeg,image/webp,video/mp4,video/webm"
                onChange={(e) => {
                  addFiles(e.target.files);
                  e.target.value = "";
                }}
                data-testid="input-directed-asset-file"
              />
            </div>
            {draft.assets.length === 0 ? (
              <p className="text-xs text-muted-foreground" data-testid="text-directed-no-assets">
                No assets: KOKAO works from your brief and brand colours. An exact
                logo, product label, wording or app screen cannot be guaranteed
                from a prompt alone. Add the real file (PNG, JPEG, WebP up to 10 MB;
                MP4, WebM up to 40 MB) to place it exactly.
              </p>
            ) : (
              <ul className="space-y-2">
                {draft.assets.map((a, i) => (
                  <li
                    key={a.key}
                    className="flex flex-wrap items-end gap-2 rounded-md border border-border px-2 py-2"
                    data-testid={`row-directed-asset-${i}`}
                  >
                    <div className="min-w-32 flex-1">
                      <p className="truncate text-sm">{a.name}</p>
                      <p
                        className={`text-xs ${a.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}
                        data-testid={`status-directed-asset-${i}`}
                      >
                        {a.status === "uploading"
                          ? "Uploading"
                          : a.status === "failed"
                            ? (a.error ?? "Upload failed")
                            : a.kind === "video" ? "Recording ready" : "Image ready"}
                      </p>
                    </div>
                    <TimeField label="From" value={a.startSec} max={durationSec} testId={`input-directed-asset-start-${i}`}
                      onChange={(v) => onChange((d) => ({ ...d, assets: d.assets.map((x) => x.key === a.key ? { ...x, startSec: v } : x) }))} />
                    <TimeField label="To" value={a.endSec} max={durationSec} testId={`input-directed-asset-end-${i}`}
                      onChange={(v) => onChange((d) => ({ ...d, assets: d.assets.map((x) => x.key === a.key ? { ...x, endSec: v } : x) }))} />
                    <Select
                      value={a.placement}
                      onValueChange={(v) => onChange((d) => ({ ...d, assets: d.assets.map((x) => x.key === a.key ? { ...x, placement: v as typeof a.placement } : x) }))}
                    >
                      <SelectTrigger className="h-8 w-32" data-testid={`select-directed-asset-placement-${i}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="corner">Corner</SelectItem>
                        <SelectItem value="full_frame">Full frame</SelectItem>
                      </SelectContent>
                    </Select>
                    {a.status === "failed" && retryFiles.current.has(a.key) && (
                      <Button type="button" variant="outline" size="sm" className="h-8"
                        onClick={() => { const f = retryFiles.current.get(a.key); if (f) startUpload(a.key, f); }}
                        data-testid={`button-directed-asset-retry-${i}`}>
                        Retry
                      </Button>
                    )}
                    <Button type="button" variant="ghost" size="icon" className="h-8 w-8"
                      aria-label={`Remove ${a.name}`}
                      disabled={a.status === "uploading"}
                      onClick={() => { retryFiles.current.delete(a.key); onChange((d) => ({ ...d, assets: d.assets.filter((x) => x.key !== a.key) })); }}
                      data-testid={`button-directed-asset-remove-${i}`}>
                      <X className="h-4 w-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Exact on-screen text ({draft.overlays.length}/{DIRECTED_MAX_OVERLAYS})</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={draft.overlays.length >= DIRECTED_MAX_OVERLAYS}
                onClick={() =>
                  onChange((d) => ({
                    ...d,
                    overlays: [
                      ...d.overlays,
                      { key: `${Date.now()}-${d.overlays.length}`, text: "", startSec: 0, endSec: Math.min(durationSec, 2) },
                    ],
                  }))
                }
                data-testid="button-directed-add-text"
              >
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Add text
              </Button>
            </div>
            {draft.overlays.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Text is drawn after generation, character for character. The
                video model never writes it.
              </p>
            )}
            {draft.overlays.map((o, i) => (
              <div key={o.key} className="flex flex-wrap items-end gap-2" data-testid={`row-directed-text-${i}`}>
                <div className="min-w-40 flex-1 space-y-1">
                  <div className="relative">
                    <Type className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                    <Input
                      className="h-8 pl-7"
                      maxLength={DIRECTED_OVERLAY_MAX_CHARS}
                      value={o.text}
                      placeholder="Exact words to show"
                      onChange={(e) => onChange((d) => ({ ...d, overlays: d.overlays.map((x) => x.key === o.key ? { ...x, text: e.target.value } : x) }))}
                      data-testid={`input-directed-text-${i}`}
                    />
                  </div>
                  <p className="text-right text-[11px] text-muted-foreground">
                    {o.text.length}/{DIRECTED_OVERLAY_MAX_CHARS}
                  </p>
                </div>
                <TimeField label="From" value={o.startSec} max={durationSec} testId={`input-directed-text-start-${i}`}
                  onChange={(v) => onChange((d) => ({ ...d, overlays: d.overlays.map((x) => x.key === o.key ? { ...x, startSec: v } : x) }))} />
                <TimeField label="To" value={o.endSec} max={durationSec} testId={`input-directed-text-end-${i}`}
                  onChange={(v) => onChange((d) => ({ ...d, overlays: d.overlays.map((x) => x.key === o.key ? { ...x, endSec: v } : x) }))} />
                <Button type="button" variant="ghost" size="icon" className="mb-5 h-8 w-8"
                  aria-label={`Remove text ${i + 1}`}
                  onClick={() => onChange((d) => ({ ...d, overlays: d.overlays.filter((x) => x.key !== o.key) }))}
                  data-testid={`button-directed-text-remove-${i}`}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TimeField(p: {
  label: string;
  value: number;
  max: number;
  testId: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="space-y-1 text-[11px] text-muted-foreground">
      <span className="block">{p.label} (s)</span>
      <Input
        type="number"
        min={0}
        max={p.max}
        step={0.1}
        className="h-8 w-20"
        value={Number.isFinite(p.value) ? p.value : ""}
        onChange={(e) => p.onChange(num(e.target.value))}
        data-testid={p.testId}
      />
    </label>
  );
}
