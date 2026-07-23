import { useEffect, useRef, useState } from "react";
import { RippleSpinner } from "@/components/ui/ripple-spinner";
import {
  useRequestUploadUrl,
  useListBrandKits,
  useCreateBrandKit,
  useUpdateBrandKit,
  useDeleteBrandKit,
  useSetDefaultBrandKit,
  useCreateBrandKitVersion,
  useDraftBrandKit,
  getListBrandKitsQueryKey,
  type BrandKit,
  type BrandKitPayload,
  type BrandColor,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Palette, Plus, Trash2, Star, Pencil, Wand2, Upload, X } from "lucide-react";
import { SavedVisualsSection } from "@/components/saved-visuals";

function commaList(input: string): string[] {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function lineList(input: string): string[] {
  return input
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function swatches(payload: BrandKitPayload | null | undefined): string[] {
  if (!payload) return [];
  return [...payload.colors.primary, ...payload.colors.secondary, ...payload.colors.neutral]
    .map((c) => c.hex)
    .filter(Boolean)
    .slice(0, 6);
}

function brandLogoUrl(payload: BrandKitPayload | null | undefined): string | null {
  if (!payload?.logos) return null;
  return (
    payload.logos.primary?.url ||
    payload.logos.icon_mark?.url ||
    payload.logos.favicon?.url ||
    null
  );
}

/** Logo tile with a letter-mark fallback when there is no (or a broken) logo. */
function BrandLogo({
  url,
  name,
  accent,
}: {
  url: string | null;
  name: string;
  accent: string;
}) {
  const [failed, setFailed] = useState(false);
  // A previously broken logo URL latches `failed`; clear it whenever the URL
  // changes so a newly pulled (working) logo gets a fresh load attempt.
  useEffect(() => {
    setFailed(false);
  }, [url]);
  const showImage = url && !failed;
  return (
    <div className="h-16 w-16 rounded-xl bg-white border border-border shadow-md flex items-center justify-center overflow-hidden shrink-0">
      {showImage ? (
        <img
          src={url}
          alt={`${name} logo`}
          className="h-full w-full object-contain p-1.5"
          onError={() => setFailed(true)}
        />
      ) : (
        <span
          className="text-2xl font-extrabold"
          style={{ color: accent }}
          aria-hidden="true"
        >
          {(name.trim()[0] ?? "?").toUpperCase()}
        </span>
      )}
    </div>
  );
}

const COLOR_GROUPS = [
  { key: "primary", label: "Primary" },
  { key: "secondary", label: "Secondary" },
  { key: "neutral", label: "Neutral" },
] as const;

/** A small editor for one color group (primary/secondary/neutral). */
function ColorGroupEditor({
  label,
  colors,
  onChange,
}: {
  label: string;
  colors: BrandColor[];
  onChange: (next: BrandColor[]) => void;
}) {
  const update = (i: number, patch: Partial<BrandColor>) => {
    onChange(colors.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  };
  const remove = (i: number) => onChange(colors.filter((_, idx) => idx !== i));
  const add = () => onChange([...colors, { name: "", hex: "#000000", usage: "" }]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{label}</span>
        <Button type="button" variant="outline" size="sm" onClick={add}>
          <Plus className="h-3.5 w-3.5 mr-1" /> Add
        </Button>
      </div>
      {colors.length === 0 ? (
        <p className="text-xs text-muted-foreground">No colors yet.</p>
      ) : (
        <div className="space-y-2">
          {colors.map((c, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                type="color"
                value={/^#[0-9a-fA-F]{6}$/.test(c.hex) ? c.hex : "#000000"}
                onChange={(e) => update(i, { hex: e.target.value })}
                className="w-11 p-1 h-9 shrink-0"
              />
              <Input
                value={c.hex}
                onChange={(e) => update(i, { hex: e.target.value })}
                placeholder="#000000"
                className="w-28 shrink-0"
              />
              <Input
                value={c.name}
                onChange={(e) => update(i, { name: e.target.value })}
                placeholder="Name"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="text-muted-foreground shrink-0"
                onClick={() => remove(i)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function BrandKitsPage() {
  const { data: kits, isLoading } = useListBrandKits();
  const createBrandKit = useCreateBrandKit();
  const updateBrandKit = useUpdateBrandKit();
  const deleteBrandKit = useDeleteBrandKit();
  const setDefaultBrandKit = useSetDefaultBrandKit();
  const createVersion = useCreateBrandKitVersion();
  const draftBrandKit = useDraftBrandKit();
  const requestUploadUrl = useRequestUploadUrl();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const logoFileRef = useRef<HTMLInputElement>(null);
  const [logoUploading, setLogoUploading] = useState(false);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListBrandKitsQueryKey() });

  // --- Create dialog state ---
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [brandType, setBrandType] = useState<"primary" | "sub_brand">("primary");
  const [isDefault, setIsDefault] = useState(false);
  const [draftUrl, setDraftUrl] = useState("");
  const [draftNotes, setDraftNotes] = useState("");
  const [creating, setCreating] = useState(false);

  const resetCreate = () => {
    setName("");
    setBrandType("primary");
    setIsDefault(false);
    setDraftUrl("");
    setDraftNotes("");
  };

  const handleCreate = async () => {
    if (!name.trim()) return;
    setCreating(true);
    try {
      let payload: BrandKitPayload | null = null;
      if (draftUrl.trim() || draftNotes.trim()) {
        try {
          const draft = await draftBrandKit.mutateAsync({
            data: {
              url: draftUrl.trim() || undefined,
              notes: draftNotes.trim() || undefined,
              brandName: name.trim(),
            },
          });
          payload = draft.payload;
        } catch {
          toast({
            title: "AI draft unavailable",
            description: "Creating a blank brand you can fill in.",
          });
        }
      }
      const created = await createBrandKit.mutateAsync({
        data: { name: name.trim(), brandType, isDefault, payload },
      });
      invalidate();
      setCreateOpen(false);
      resetCreate();
      if (payload) {
        const colorCount =
          payload.colors.primary.length +
          payload.colors.secondary.length +
          payload.colors.neutral.length;
        const capturedLogo = brandLogoUrl(payload) ? "the logo, " : "";
        toast({
          title: "Brand created from AI draft",
          description: `Captured ${capturedLogo}${colorCount} color${colorCount === 1 ? "" : "s"}, ${payload.voice.traits.length} voice trait${payload.voice.traits.length === 1 ? "" : "s"}, ${payload.identity.audience.length} audience group${payload.identity.audience.length === 1 ? "" : "s"}. Review and adjust below.`,
        });
        // Open the editor so the user can see exactly what the AI extracted.
        openEdit(created);
      } else {
        toast({ title: "Brand created" });
      }
    } catch (err) {
      const status = (err as { status?: number })?.status;
      toast({
        title: status === 402 ? "Plan limit reached" : "Could not create brand",
        description:
          status === 402 ? "Upgrade your plan to add more brands." : undefined,
        variant: "destructive",
      });
    } finally {
      setCreating(false);
    }
  };

  // --- Edit dialog state ---
  const [editKit, setEditKit] = useState<BrandKit | null>(null);
  const [editName, setEditName] = useState("");
  const [draft, setDraft] = useState<BrandKitPayload | null>(null);
  // Text-field mirrors for list-based payload fields.
  const [audience, setAudience] = useState("");
  const [traits, setTraits] = useState("");
  const [dos, setDos] = useState("");
  const [donts, setDonts] = useState("");
  const [imagery, setImagery] = useState("");
  // Pull-from-website inside the edit dialog.
  const [pullUrl, setPullUrl] = useState("");
  const [pulling, setPulling] = useState(false);

  const handlePullFromWebsite = async () => {
    if (!pullUrl.trim() || !draft) return;
    setPulling(true);
    try {
      const pulled = await draftBrandKit.mutateAsync({
        data: { url: pullUrl.trim(), brandName: editName.trim() || undefined },
      });
      const p = pulled.payload;
      const pulledColors =
        p.colors.primary.length +
        p.colors.secondary.length +
        p.colors.neutral.length;
      const pulledLogo = brandLogoUrl(p);
      setDraft((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          identity: {
            ...prev.identity,
            tagline: prev.identity.tagline || p.identity.tagline,
            description: prev.identity.description || p.identity.description,
            industry: prev.identity.industry || p.identity.industry,
          },
          colors: pulledColors > 0 ? p.colors : prev.colors,
          logos: pulledLogo
            ? {
                ...prev.logos,
                primary: p.logos.primary ?? prev.logos?.primary ?? null,
                icon_mark: p.logos.icon_mark ?? prev.logos?.icon_mark ?? null,
                favicon: p.logos.favicon ?? prev.logos?.favicon ?? null,
              }
            : prev.logos,
        };
      });
      if (!audience.trim() && p.identity.audience.length > 0) {
        setAudience(p.identity.audience.join(", "));
      }
      if (!traits.trim() && p.voice.traits.length > 0) {
        setTraits(p.voice.traits.join(", "));
      }
      if (pulledColors > 0 || pulledLogo) {
        toast({
          title: "Pulled from website",
          description: `Found ${pulledLogo ? "the logo and " : ""}${pulledColors} color${pulledColors === 1 ? "" : "s"}. Review the Colors tab, then save.`,
        });
      } else {
        toast({
          title: "Nothing usable found",
          description:
            "The website could not be read or had no detectable logo or colors.",
          variant: "destructive",
        });
      }
    } catch {
      toast({
        title: "Could not pull from website",
        description: "Check the URL and try again.",
        variant: "destructive",
      });
    } finally {
      setPulling(false);
    }
  };

  const openEdit = (kit: BrandKit) => {
    const p = kit.activeVersion?.payload ?? null;
    if (!p) {
      toast({
        title: "No active version",
        description: "This brand has no editable version yet.",
        variant: "destructive",
      });
      return;
    }
    // Deep clone so edits don't mutate cached query data, then fill any
    // missing sections defensively so the editor never crashes on a
    // partial payload.
    const raw = JSON.parse(JSON.stringify(p)) as Partial<BrandKitPayload>;
    const clone: BrandKitPayload = {
      ...raw,
      identity: {
        brand_name: kit.name,
        brand_slug: "",
        tagline: "",
        description: "",
        industry: "",
        audience: [],
        ...(raw.identity ?? {}),
      },
      voice: {
        traits: [],
        dos: [],
        donts: [],
        caption_style: "",
        cta_style: "",
        ...(raw.voice ?? {}),
      },
      colors: {
        primary: [],
        secondary: [],
        neutral: [],
        ...(raw.colors ?? {}),
      },
      logos: {
        primary: null,
        secondary: null,
        icon_mark: null,
        favicon: null,
        usage_rules: [],
        ...(raw.logos ?? {}),
      },
      visual_style: {
        imagery_style: [],
        icon_style: "",
        illustration_style: "",
        motion_style: "",
        ...(raw.visual_style ?? {}),
      },
    } as BrandKitPayload;
    setEditKit(kit);
    setEditName(kit.name);
    setPullUrl("");
    setDraft(clone);
    setAudience((clone.identity.audience ?? []).join(", "));
    setTraits((clone.voice.traits ?? []).join(", "));
    setDos((clone.voice.dos ?? []).join("\n"));
    setDonts((clone.voice.donts ?? []).join("\n"));
    setImagery((clone.visual_style.imagery_style ?? []).join(", "));
  };

  const closeEdit = () => {
    setEditKit(null);
    setDraft(null);
  };

  const handleSaveEdit = async () => {
    if (!editKit || !draft) return;
    const payload: BrandKitPayload = {
      ...draft,
      identity: { ...draft.identity, audience: commaList(audience) },
      voice: {
        ...draft.voice,
        traits: commaList(traits),
        dos: lineList(dos),
        donts: lineList(donts),
      },
      visual_style: {
        ...draft.visual_style,
        imagery_style: commaList(imagery),
      },
    };
    try {
      if (editName.trim() && editName.trim() !== editKit.name) {
        await updateBrandKit.mutateAsync({
          id: editKit.id,
          data: { name: editName.trim() },
        });
      }
      await createVersion.mutateAsync({
        id: editKit.id,
        data: {
          payload,
          sourceType: "manual",
          approvalStatus: "approved",
          activate: true,
        },
      });
      toast({ title: "Brand updated" });
      invalidate();
      closeEdit();
    } catch {
      toast({ title: "Could not save brand", variant: "destructive" });
    }
  };

  const handleSetDefault = (id: number) => {
    setDefaultBrandKit.mutate(
      { id },
      {
        onSuccess: () => {
          toast({ title: "Default brand updated" });
          invalidate();
        },
        onError: () =>
          toast({ title: "Could not set default", variant: "destructive" }),
      },
    );
  };

  // window.confirm is blocked inside the sandboxed preview iframe, so we use
  // a proper dialog for archive confirmation.
  const [archiveTarget, setArchiveTarget] = useState<BrandKit | null>(null);

  const confirmArchive = () => {
    if (!archiveTarget) return;
    deleteBrandKit.mutate(
      { id: archiveTarget.id },
      {
        onSuccess: () => {
          toast({ title: "Brand archived" });
          invalidate();
          setArchiveTarget(null);
        },
        onError: () => {
          toast({ title: "Could not archive brand", variant: "destructive" });
          setArchiveTarget(null);
        },
      },
    );
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-48" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-64 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  const items = kits ?? [];

  const patchDraft = (fn: (p: BrandKitPayload) => BrandKitPayload) => {
    setDraft((prev) => (prev ? fn(prev) : prev));
  };

  const handleLogoUpload = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      toast({
        title: "Not an image",
        description: "Please pick an image file (PNG, JPG, SVG, or WebP).",
        variant: "destructive",
      });
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast({
        title: "File too large",
        description: "Logo images must be under 5 MB.",
        variant: "destructive",
      });
      return;
    }
    setLogoUploading(true);
    try {
      const { uploadURL, objectPath } = await requestUploadUrl.mutateAsync({
        data: { name: file.name, size: file.size, contentType: file.type },
      });
      const put = await fetch(uploadURL, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type },
      });
      if (!put.ok) throw new Error(`Upload failed (${put.status})`);
      const servedUrl = `/api/storage${objectPath}`;
      patchDraft((p) => ({
        ...p,
        logos: {
          ...p.logos,
          primary: { url: servedUrl, type: "uploaded" },
        },
      }));
      toast({
        title: "Logo uploaded",
        description: "Save the brand to keep this logo.",
      });
    } catch (err) {
      toast({
        title: "Upload failed",
        description: err instanceof Error ? err.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setLogoUploading(false);
      if (logoFileRef.current) logoFileRef.current.value = "";
    }
  };

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight">Brand Kits</h1>
          <p className="text-muted-foreground text-lg mt-1">
            Manage brand identity, colors, and voice used across AI generation.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)} className="shadow-md">
          <Plus className="h-4 w-4 mr-2" /> New Brand
        </Button>
      </div>

      {items.length === 0 ? (
        <div className="text-center py-24 bg-card rounded-2xl border border-border shadow-sm">
          <Palette className="mx-auto h-16 w-16 text-muted mb-4" />
          <h3 className="text-xl font-bold">No Brands Yet</h3>
          <p className="text-muted-foreground mt-2 mb-6">
            Create your first brand to keep AI content consistent and on-brand.
          </p>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4 mr-2" /> Create Brand
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {items.map((kit, i) => {
            const payload = kit.activeVersion?.payload ?? null;
            const displayName = payload?.identity.brand_name?.trim() || kit.name;
            const colors = swatches(payload);
            const logoUrl = brandLogoUrl(payload);
            const accent = colors[0] ?? "hsl(255 85% 55%)";
            const gradient =
              colors.length >= 3
                ? `linear-gradient(135deg, ${colors[0]} 0%, ${colors[1]} 50%, ${colors[2]} 100%)`
                : colors.length === 2
                  ? `linear-gradient(135deg, ${colors[0]} 0%, ${colors[1]} 100%)`
                  : colors.length === 1
                    ? `linear-gradient(135deg, ${colors[0]} 0%, ${colors[0]} 100%)`
                    : null;
            return (
              <Card
                key={kit.id}
                className="overflow-hidden flex flex-col group hover:shadow-lg transition-all duration-300 border-border animate-in fade-in"
                style={{ animationDelay: `${i * 50}ms` }}
              >
                <CardContent className="flex-1 p-5 flex flex-col gap-4 relative">
                  {kit.isDefault && (
                    <span className="absolute top-3 right-3 inline-flex items-center gap-1 text-xs font-semibold bg-muted text-foreground px-2 py-0.5 rounded-full border border-border">
                      <Star className="h-3 w-3 fill-current" /> Default
                    </span>
                  )}
                  <div className="flex items-end justify-between gap-3">
                    <BrandLogo url={logoUrl} name={displayName} accent={accent} />
                    <div className={`flex gap-1 pb-1 ${kit.isDefault ? "mr-20" : ""}`}>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => openEdit(kit)}
                        title="Edit"
                        data-testid={`button-edit-kit-${kit.id}`}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive/60 hover:text-destructive hover:bg-destructive/10"
                        onClick={() => setArchiveTarget(kit)}
                        title="Archive"
                        data-testid={`button-archive-kit-${kit.id}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>

                  <div className="min-w-0">
                    <h3 className="font-bold text-xl truncate">{displayName}</h3>
                    <p className="text-xs text-muted-foreground truncate">
                      {payload?.identity.tagline ||
                        payload?.identity.industry ||
                        (kit.brandType === "sub_brand" ? "Sub-brand" : "Primary brand")}
                    </p>
                  </div>

                  {payload &&
                    COLOR_GROUPS.some((g) => payload.colors[g.key].length > 0) && (
                      <div className="space-y-2.5">
                        {COLOR_GROUPS.map((g) => {
                          const group = payload.colors[g.key].filter((c) => c.hex);
                          if (group.length === 0) return null;
                          const shown = group.slice(0, 4);
                          return (
                            <div key={g.key}>
                              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">
                                {g.label}
                              </p>
                              <div className="flex flex-wrap gap-1.5">
                                {shown.map((c, idx) => (
                                  <div
                                    key={idx}
                                    className="flex items-center gap-1.5 rounded-md border border-border bg-muted/30 pl-1 pr-2 py-1"
                                    title={c.name || c.hex}
                                  >
                                    <span
                                      className="h-4 w-4 rounded border border-black/10 shrink-0"
                                      style={{ backgroundColor: c.hex }}
                                    />
                                    <span className="text-[10px] font-mono text-muted-foreground">
                                      {c.hex.toUpperCase()}
                                    </span>
                                  </div>
                                ))}
                                {group.length > shown.length && (
                                  <span className="text-[10px] text-muted-foreground self-center">
                                    +{group.length - shown.length} more
                                  </span>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                  {payload && payload.voice.traits.length > 0 && (
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">
                        Voice
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {payload.voice.traits.slice(0, 4).map((t) => (
                          <span
                            key={t}
                            className="text-xs bg-muted px-2 py-1 rounded-md font-medium"
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="mt-auto pt-1">
                    {!kit.isDefault && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full"
                        onClick={() => handleSetDefault(kit.id)}
                        disabled={setDefaultBrandKit.isPending}
                      >
                        <Star className="h-3.5 w-3.5 mr-1.5" /> Set as default
                      </Button>
                    )}
                  </div>
                </CardContent>
                <div
                  className={`h-20 w-full ${gradient ? "" : "bg-card border-t border-border"}`}
                  style={gradient ? { background: gradient } : undefined}
                />
              </Card>
            );
          })}
        </div>
      )}

      <SavedVisualsSection />

      {/* Archive confirmation dialog */}
      <Dialog
        open={!!archiveTarget}
        onOpenChange={(o) => !o && setArchiveTarget(null)}
      >
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Archive brand</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Archive "{archiveTarget?.name}"? It will be removed from your list
            and can no longer be used for new content.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setArchiveTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmArchive}
              disabled={deleteBrandKit.isPending}
              data-testid="button-confirm-archive"
            >
              {deleteBrandKit.isPending ? (
                <RippleSpinner className="mr-2 h-4 w-4" />
              ) : null}
              Archive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create dialog */}
      <Dialog
        open={createOpen}
        onOpenChange={(o) => {
          setCreateOpen(o);
          if (!o) resetCreate();
        }}
      >
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Create Brand</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4 max-h-[60vh] overflow-y-auto px-1">
            <div className="space-y-2">
              <label className="text-sm font-medium">Brand name</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Acme Coffee"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Type</label>
                <Select
                  value={brandType}
                  onValueChange={(v) => setBrandType(v as "primary" | "sub_brand")}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="primary">Primary</SelectItem>
                    <SelectItem value="sub_brand">Sub-brand</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Default</label>
                <label className="flex items-center gap-2 h-10 text-sm">
                  <input
                    type="checkbox"
                    checked={isDefault}
                    onChange={(e) => setIsDefault(e.target.checked)}
                    className="h-4 w-4"
                  />
                  Use as default brand
                </label>
              </div>
            </div>

            <div className="rounded-lg border border-border p-3 space-y-3 bg-muted/20">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Wand2 className="h-4 w-4" /> Draft with AI (optional)
              </div>
              <p className="text-xs text-muted-foreground">
                Add a website or notes and we'll pre-fill colors, voice, and more.
              </p>
              <Input
                value={draftUrl}
                onChange={(e) => setDraftUrl(e.target.value)}
                placeholder="https://yourbrand.com"
              />
              <Textarea
                value={draftNotes}
                onChange={(e) => setDraftNotes(e.target.value)}
                placeholder="Describe voice, audience, colors..."
                className="resize-none"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={creating || !name.trim()}>
              {creating ? (
                <RippleSpinner className="mr-2 h-4 w-4" />
              ) : draftUrl.trim() || draftNotes.trim() ? (
                <Wand2 className="mr-2 h-4 w-4" />
              ) : null}
              Create Brand
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={!!editKit} onOpenChange={(o) => !o && closeEdit()}>
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>Edit Brand</DialogTitle>
          </DialogHeader>
          {draft && (
            <Tabs defaultValue="identity" className="w-full">
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="identity">Identity</TabsTrigger>
                <TabsTrigger value="voice">Voice</TabsTrigger>
                <TabsTrigger value="colors">Colors</TabsTrigger>
              </TabsList>

              <div className="max-h-[55vh] overflow-y-auto px-1 py-4">
                <TabsContent value="identity" className="space-y-4 mt-0">
                  <div className="rounded-lg border border-border p-3 space-y-2 bg-muted/20">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <Wand2 className="h-4 w-4" /> Pull from website
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Fetch the logo and real brand colors directly from a site.
                      Existing colors will be replaced; review before saving.
                    </p>
                    <div className="flex gap-2">
                      <Input
                        value={pullUrl}
                        onChange={(e) => setPullUrl(e.target.value)}
                        placeholder="https://yourbrand.com"
                        data-testid="input-pull-url"
                      />
                      <Button
                        variant="secondary"
                        onClick={handlePullFromWebsite}
                        disabled={pulling || !pullUrl.trim()}
                        data-testid="button-pull-website"
                      >
                        {pulling ? (
                          <RippleSpinner className="h-4 w-4" />
                        ) : (
                          "Pull"
                        )}
                      </Button>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Brand name</label>
                    <Input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Display name</label>
                    <Input
                      value={draft.identity.brand_name}
                      onChange={(e) =>
                        patchDraft((p) => ({
                          ...p,
                          identity: { ...p.identity, brand_name: e.target.value },
                        }))
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Tagline</label>
                    <Input
                      value={draft.identity.tagline}
                      onChange={(e) =>
                        patchDraft((p) => ({
                          ...p,
                          identity: { ...p.identity, tagline: e.target.value },
                        }))
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Logo</label>
                    <div className="flex items-center gap-2">
                      <input
                        ref={logoFileRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) void handleLogoUpload(file);
                        }}
                        data-testid="input-logo-file"
                      />
                      <Button
                        variant="secondary"
                        onClick={() => logoFileRef.current?.click()}
                        disabled={logoUploading}
                        data-testid="button-upload-logo"
                      >
                        {logoUploading ? (
                          <RippleSpinner className="h-4 w-4 mr-2" />
                        ) : (
                          <Upload className="h-4 w-4 mr-2" />
                        )}
                        Upload
                      </Button>
                      <span className="text-xs text-muted-foreground">
                        PNG, JPG, SVG, or WebP — up to 5 MB.
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      {brandLogoUrl(draft) && (
                        <img
                          src={brandLogoUrl(draft)!}
                          alt="Logo preview"
                          className="h-9 w-9 rounded-md border border-border object-contain bg-white p-0.5 shrink-0"
                          onError={(e) => {
                            e.currentTarget.style.display = "none";
                          }}
                        />
                      )}
                      <Input
                        value={draft.logos?.primary?.url ?? ""}
                        onChange={(e) => {
                          const url = e.target.value.trim();
                          patchDraft((p) => ({
                            ...p,
                            logos: {
                              ...p.logos,
                              primary: url ? { url, type: "external" } : null,
                            },
                          }));
                        }}
                        placeholder="https://yourbrand.com/logo.png"
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Shown on the brand card. Captured automatically when
                      drafting from a website.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Industry</label>
                    <Input
                      value={draft.identity.industry}
                      onChange={(e) =>
                        patchDraft((p) => ({
                          ...p,
                          identity: { ...p.identity, industry: e.target.value },
                        }))
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Description</label>
                    <Textarea
                      value={draft.identity.description}
                      onChange={(e) =>
                        patchDraft((p) => ({
                          ...p,
                          identity: { ...p.identity, description: e.target.value },
                        }))
                      }
                      className="resize-none"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">
                      Audience <span className="text-muted-foreground">(comma separated)</span>
                    </label>
                    <Input
                      value={audience}
                      onChange={(e) => setAudience(e.target.value)}
                      placeholder="e.g. young professionals, coffee lovers"
                    />
                  </div>
                </TabsContent>

                <TabsContent value="voice" className="space-y-4 mt-0">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">
                      Traits <span className="text-muted-foreground">(comma separated)</span>
                    </label>
                    <Input
                      value={traits}
                      onChange={(e) => setTraits(e.target.value)}
                      placeholder="e.g. friendly, bold, witty"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Caption style</label>
                    <Input
                      value={draft.voice.caption_style}
                      onChange={(e) =>
                        patchDraft((p) => ({
                          ...p,
                          voice: { ...p.voice, caption_style: e.target.value },
                        }))
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">CTA style</label>
                    <Input
                      value={draft.voice.cta_style}
                      onChange={(e) =>
                        patchDraft((p) => ({
                          ...p,
                          voice: { ...p.voice, cta_style: e.target.value },
                        }))
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">
                      Do's <span className="text-muted-foreground">(one per line)</span>
                    </label>
                    <Textarea
                      value={dos}
                      onChange={(e) => setDos(e.target.value)}
                      className="resize-none"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">
                      Don'ts <span className="text-muted-foreground">(one per line)</span>
                    </label>
                    <Textarea
                      value={donts}
                      onChange={(e) => setDonts(e.target.value)}
                      className="resize-none"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">
                      Imagery style <span className="text-muted-foreground">(comma separated)</span>
                    </label>
                    <Input
                      value={imagery}
                      onChange={(e) => setImagery(e.target.value)}
                      placeholder="e.g. warm tones, lifestyle, minimal"
                    />
                  </div>
                </TabsContent>

                <TabsContent value="colors" className="space-y-5 mt-0">
                  <ColorGroupEditor
                    label="Primary"
                    colors={draft.colors.primary}
                    onChange={(next) =>
                      patchDraft((p) => ({
                        ...p,
                        colors: { ...p.colors, primary: next },
                      }))
                    }
                  />
                  <ColorGroupEditor
                    label="Secondary"
                    colors={draft.colors.secondary}
                    onChange={(next) =>
                      patchDraft((p) => ({
                        ...p,
                        colors: { ...p.colors, secondary: next },
                      }))
                    }
                  />
                  <ColorGroupEditor
                    label="Neutral"
                    colors={draft.colors.neutral}
                    onChange={(next) =>
                      patchDraft((p) => ({
                        ...p,
                        colors: { ...p.colors, neutral: next },
                      }))
                    }
                  />
                </TabsContent>
              </div>
            </Tabs>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={closeEdit} disabled={logoUploading}>
              Cancel
            </Button>
            <Button
              onClick={handleSaveEdit}
              disabled={
                logoUploading || createVersion.isPending || updateBrandKit.isPending
              }
            >
              {createVersion.isPending || updateBrandKit.isPending ? (
                <RippleSpinner className="mr-2 h-4 w-4" />
              ) : null}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
