import { useEffect, useMemo, useRef, useState } from "react";
import {
  useGetLandingContent,
  getGetLandingContentQueryKey,
  useUpdateLandingContent,
  useCreateAppBrandUploadUrl,
  type LandingContent,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import {
  ChevronDown,
  ChevronUp,
  Plus,
  Trash2,
  Upload,
  X,
  ExternalLink,
} from "lucide-react";

/**
 * Superadmin CMS for the public landing page + privacy policy. Edits a local
 * copy of the whole document and saves it atomically with "Save & publish".
 */

// ---------- small generic helpers ----------

function moveItem<T>(arr: T[], from: number, to: number): T[] {
  if (to < 0 || to >= arr.length) return arr;
  const next = arr.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function ListControls({
  index,
  count,
  onMove,
  onRemove,
}: {
  index: number;
  count: number;
  onMove: (from: number, to: number) => void;
  onRemove: (index: number) => void;
}) {
  return (
    <div className="flex items-center gap-1 shrink-0">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        disabled={index === 0}
        onClick={() => onMove(index, index - 1)}
        aria-label="Move up"
      >
        <ChevronUp className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        disabled={index === count - 1}
        onClick={() => onMove(index, index + 1)}
        aria-label="Move down"
      >
        <ChevronDown className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-destructive"
        onClick={() => onRemove(index)}
        aria-label="Remove"
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  multiline,
  placeholder,
  testId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
  placeholder?: string;
  testId?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-semibold text-muted-foreground">{label}</Label>
      {multiline ? (
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={3}
          data-testid={testId}
        />
      ) : (
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          data-testid={testId}
        />
      )}
    </div>
  );
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-semibold text-muted-foreground">{label}</Label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : "#ffffff"}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-10 rounded border border-input cursor-pointer bg-transparent"
          aria-label={`${label} color picker`}
        />
        <Input value={value} onChange={(e) => onChange(e.target.value)} className="font-mono" />
      </div>
    </div>
  );
}

function SectionCard({
  title,
  children,
  testId,
}: {
  title: string;
  children: React.ReactNode;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Card data-testid={testId}>
      <CardHeader
        className="py-4 cursor-pointer select-none flex-row items-center justify-between space-y-0"
        onClick={() => setOpen((o) => !o)}
      >
        <CardTitle className="text-base">{title}</CardTitle>
        <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
      </CardHeader>
      {open && <CardContent className="space-y-4 pt-0">{children}</CardContent>}
    </Card>
  );
}

// ---------- the editor ----------

export function LandingTab() {
  const { data, isLoading } = useGetLandingContent();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const update = useUpdateLandingContent();
  const mintUploadUrl = useCreateAppBrandUploadUrl();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  // Local working copy; re-seeded whenever fresh server data arrives while
  // there are no unsaved edits.
  const [doc, setDoc] = useState<LandingContent | null>(null);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (data && !dirty) setDoc(structuredClone(data));
  }, [data, dirty]);

  const edit = useMemo(
    () => (mutate: (d: LandingContent) => void) => {
      setDoc((prev) => {
        if (!prev) return prev;
        const next = structuredClone(prev);
        mutate(next);
        return next;
      });
      setDirty(true);
    },
    [],
  );

  if (isLoading || !doc) {
    return <Skeleton className="h-64 w-full" data-testid="landing-tab-loading" />;
  }

  const handleLogoFile = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      toast({ title: "Please choose an image file", variant: "destructive" });
      return;
    }
    setUploading(true);
    try {
      const { uploadURL, servedPath } = await mintUploadUrl.mutateAsync({
        data: { contentType: file.type },
      });
      const put = await fetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!put.ok) throw new Error("Upload failed");
      edit((d) => {
        d.site.logo = servedPath;
      });
      toast({ title: "Logo uploaded", description: "Remember to Save & publish." });
    } catch (err) {
      toast({
        title: "Logo upload failed",
        description: apiErrorMessage(err, "Could not upload the logo."),
        variant: "destructive",
      });
    } finally {
      setUploading(false);
    }
  };

  const save = async () => {
    try {
      const saved = await update.mutateAsync({ data: doc });
      setDoc(structuredClone(saved));
      setDirty(false);
      await queryClient.invalidateQueries({ queryKey: getGetLandingContentQueryKey() });
      toast({ title: "Landing page published", description: "Changes are live." });
    } catch (err) {
      toast({
        title: "Save failed",
        description: apiErrorMessage(err, "Could not publish the landing page."),
        variant: "destructive",
      });
    }
  };

  const discard = () => {
    if (data) setDoc(structuredClone(data));
    setDirty(false);
  };

  return (
    <div className="space-y-4" data-testid="landing-tab">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">Landing Page</h2>
          <p className="text-sm text-muted-foreground">
            Everything on the public landing page and privacy policy is editable here.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a href="/" target="_blank" rel="noreferrer">
            <Button variant="outline" size="sm" data-testid="button-view-landing">
              <ExternalLink className="h-4 w-4 mr-1.5" />
              View page
            </Button>
          </a>
          {dirty && (
            <Button variant="ghost" size="sm" onClick={discard} data-testid="button-discard-landing">
              Discard changes
            </Button>
          )}
          <Button
            size="sm"
            onClick={save}
            disabled={!dirty || update.isPending}
            data-testid="button-save-landing"
          >
            {update.isPending ? "Publishing…" : "Save & publish"}
          </Button>
        </div>
      </div>

      <SectionCard title="Site & colors" testId="section-site">
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Brand name" value={doc.site.brand} onChange={(v) => edit((d) => (d.site.brand = v))} testId="input-site-brand" />
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-muted-foreground">Logo</Label>
            <div className="flex items-center gap-2">
              {doc.site.logo ? (
                <img src={doc.site.logo} alt="Logo" className="h-9 w-auto rounded border border-input bg-white px-1" />
              ) : (
                <span className="text-sm text-muted-foreground">Built-in mark</span>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={uploading}
                onClick={() => fileInputRef.current?.click()}
                data-testid="button-upload-logo"
              >
                <Upload className="h-4 w-4 mr-1.5" />
                {uploading ? "Uploading…" : "Upload"}
              </Button>
              {doc.site.logo && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => edit((d) => (d.site.logo = ""))}
                  aria-label="Remove logo"
                >
                  <X className="h-4 w-4" />
                </Button>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleLogoFile(f);
                  e.target.value = "";
                }}
              />
            </div>
          </div>
        </div>
        <Field label="SEO title" value={doc.site.meta_title} onChange={(v) => edit((d) => (d.site.meta_title = v))} />
        <Field label="SEO description" value={doc.site.meta_description} onChange={(v) => edit((d) => (d.site.meta_description = v))} multiline />
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <ColorField label="Background" value={doc.site.color_bg} onChange={(v) => edit((d) => (d.site.color_bg = v))} />
          <ColorField label="Text" value={doc.site.color_ink} onChange={(v) => edit((d) => (d.site.color_ink = v))} />
          <ColorField label="Accent 1" value={doc.site.color_accent1} onChange={(v) => edit((d) => (d.site.color_accent1 = v))} />
          <ColorField label="Accent 2" value={doc.site.color_accent2} onChange={(v) => edit((d) => (d.site.color_accent2 = v))} />
          <ColorField label="Accent 3" value={doc.site.color_accent3} onChange={(v) => edit((d) => (d.site.color_accent3 = v))} />
        </div>
      </SectionCard>

      <SectionCard title="Navigation" testId="section-nav">
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Button text" value={doc.nav.cta} onChange={(v) => edit((d) => (d.nav.cta = v))} />
          <Field label="Button link" value={doc.nav.cta_link} onChange={(v) => edit((d) => (d.nav.cta_link = v))} />
        </div>
        {doc.nav.links.map((l, i) => (
          <div key={i} className="flex items-end gap-2">
            <div className="grid grid-cols-2 gap-2 flex-1">
              <Field label="Label" value={l.label} onChange={(v) => edit((d) => (d.nav.links[i].label = v))} />
              <Field label="Link" value={l.href} onChange={(v) => edit((d) => (d.nav.links[i].href = v))} />
            </div>
            <ListControls
              index={i}
              count={doc.nav.links.length}
              onMove={(f, t) => edit((d) => (d.nav.links = moveItem(d.nav.links, f, t)))}
              onRemove={(idx) => edit((d) => d.nav.links.splice(idx, 1))}
            />
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={() => edit((d) => d.nav.links.push({ label: "New link", href: "#" }))}>
          <Plus className="h-4 w-4 mr-1.5" /> Add link
        </Button>
      </SectionCard>

      <SectionCard title="Hero" testId="section-hero">
        <Field label="Badge" value={doc.hero.badge} onChange={(v) => edit((d) => (d.hero.badge = v))} />
        <Field label="Title" value={doc.hero.title} onChange={(v) => edit((d) => (d.hero.title = v))} testId="input-hero-title" />
        <Field label="Subtitle" value={doc.hero.subtitle} onChange={(v) => edit((d) => (d.hero.subtitle = v))} multiline />
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Primary button text" value={doc.hero.cta_primary} onChange={(v) => edit((d) => (d.hero.cta_primary = v))} />
          <Field label="Primary button link" value={doc.hero.cta_primary_link} onChange={(v) => edit((d) => (d.hero.cta_primary_link = v))} />
          <Field label="Secondary button text" value={doc.hero.cta_secondary} onChange={(v) => edit((d) => (d.hero.cta_secondary = v))} />
          <Field label="Secondary button link" value={doc.hero.cta_secondary_link} onChange={(v) => edit((d) => (d.hero.cta_secondary_link = v))} />
          <Field label="Mock card prompt" value={doc.hero.card_prompt} onChange={(v) => edit((d) => (d.hero.card_prompt = v))} />
          <Field label="Mock card status" value={doc.hero.card_status} onChange={(v) => edit((d) => (d.hero.card_status = v))} />
        </div>
        <Label className="text-xs font-semibold text-muted-foreground">Stats</Label>
        {doc.hero.stats.map((s, i) => (
          <div key={i} className="flex items-end gap-2">
            <div className="grid grid-cols-2 gap-2 flex-1">
              <Field label="Number" value={s.num} onChange={(v) => edit((d) => (d.hero.stats[i].num = v))} />
              <Field label="Label" value={s.label} onChange={(v) => edit((d) => (d.hero.stats[i].label = v))} />
            </div>
            <ListControls
              index={i}
              count={doc.hero.stats.length}
              onMove={(f, t) => edit((d) => (d.hero.stats = moveItem(d.hero.stats, f, t)))}
              onRemove={(idx) => edit((d) => d.hero.stats.splice(idx, 1))}
            />
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={() => edit((d) => d.hero.stats.push({ num: "0", label: "New stat" }))}>
          <Plus className="h-4 w-4 mr-1.5" /> Add stat
        </Button>
      </SectionCard>

      <SectionCard title="Platforms strip" testId="section-platforms">
        <Field label="Title" value={doc.platforms.title} onChange={(v) => edit((d) => (d.platforms.title = v))} />
        {doc.platforms.items.map((p, i) => (
          <div key={i} className="flex items-end gap-2">
            <div className="flex-1">
              <Field label={`Platform ${i + 1}`} value={p} onChange={(v) => edit((d) => (d.platforms.items[i] = v))} />
            </div>
            <ListControls
              index={i}
              count={doc.platforms.items.length}
              onMove={(f, t) => edit((d) => (d.platforms.items = moveItem(d.platforms.items, f, t)))}
              onRemove={(idx) => edit((d) => d.platforms.items.splice(idx, 1))}
            />
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={() => edit((d) => d.platforms.items.push("New platform"))}>
          <Plus className="h-4 w-4 mr-1.5" /> Add platform
        </Button>
      </SectionCard>

      <SectionCard title="Features" testId="section-features">
        <Field label="Title" value={doc.features.title} onChange={(v) => edit((d) => (d.features.title = v))} />
        <Field label="Subtitle" value={doc.features.subtitle} onChange={(v) => edit((d) => (d.features.subtitle = v))} multiline />
        {doc.features.items.map((f, i) => (
          <div key={i} className="rounded-lg border p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold">Feature {i + 1}</span>
              <ListControls
                index={i}
                count={doc.features.items.length}
                onMove={(from, to) => edit((d) => (d.features.items = moveItem(d.features.items, from, to)))}
                onRemove={(idx) => edit((d) => d.features.items.splice(idx, 1))}
              />
            </div>
            <div className="grid sm:grid-cols-[80px_1fr] gap-2">
              <Field label="Icon (emoji)" value={f.icon} onChange={(v) => edit((d) => (d.features.items[i].icon = v))} />
              <Field label="Title" value={f.title} onChange={(v) => edit((d) => (d.features.items[i].title = v))} />
            </div>
            <Field label="Text" value={f.text} onChange={(v) => edit((d) => (d.features.items[i].text = v))} multiline />
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={() => edit((d) => d.features.items.push({ icon: "✨", title: "New feature", text: "" }))} data-testid="button-add-feature">
          <Plus className="h-4 w-4 mr-1.5" /> Add feature
        </Button>
      </SectionCard>

      <SectionCard title="How it works" testId="section-how">
        <Field label="Title" value={doc.how.title} onChange={(v) => edit((d) => (d.how.title = v))} />
        <Field label="Subtitle" value={doc.how.subtitle} onChange={(v) => edit((d) => (d.how.subtitle = v))} multiline />
        {doc.how.steps.map((s, i) => (
          <div key={i} className="rounded-lg border p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold">Step {i + 1}</span>
              <ListControls
                index={i}
                count={doc.how.steps.length}
                onMove={(from, to) => edit((d) => (d.how.steps = moveItem(d.how.steps, from, to)))}
                onRemove={(idx) => edit((d) => d.how.steps.splice(idx, 1))}
              />
            </div>
            <Field label="Title" value={s.title} onChange={(v) => edit((d) => (d.how.steps[i].title = v))} />
            <Field label="Text" value={s.text} onChange={(v) => edit((d) => (d.how.steps[i].text = v))} multiline />
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={() => edit((d) => d.how.steps.push({ title: "New step", text: "" }))}>
          <Plus className="h-4 w-4 mr-1.5" /> Add step
        </Button>
      </SectionCard>

      <SectionCard title="Pricing" testId="section-pricing">
        <Field label="Title" value={doc.pricing.title} onChange={(v) => edit((d) => (d.pricing.title = v))} />
        <Field label="Subtitle" value={doc.pricing.subtitle} onChange={(v) => edit((d) => (d.pricing.subtitle = v))} multiline />
        {doc.pricing.plans.map((p, i) => (
          <div key={i} className="rounded-lg border p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold">{p.name || `Plan ${i + 1}`}</span>
              <ListControls
                index={i}
                count={doc.pricing.plans.length}
                onMove={(from, to) => edit((d) => (d.pricing.plans = moveItem(d.pricing.plans, from, to)))}
                onRemove={(idx) => edit((d) => d.pricing.plans.splice(idx, 1))}
              />
            </div>
            <div className="grid sm:grid-cols-4 gap-2">
              <Field label="Name" value={p.name} onChange={(v) => edit((d) => (d.pricing.plans[i].name = v))} />
              <Field label="Price" value={p.price} onChange={(v) => edit((d) => (d.pricing.plans[i].price = v))} />
              <Field label="Period" value={p.period} onChange={(v) => edit((d) => (d.pricing.plans[i].period = v))} />
              <Field label="Tag" value={p.tag} onChange={(v) => edit((d) => (d.pricing.plans[i].tag = v))} placeholder="e.g. Most popular" />
            </div>
            <div className="grid sm:grid-cols-2 gap-2">
              <Field label="Button text" value={p.cta} onChange={(v) => edit((d) => (d.pricing.plans[i].cta = v))} />
              <Field label="Button link" value={p.cta_link} onChange={(v) => edit((d) => (d.pricing.plans[i].cta_link = v))} />
            </div>
            <div className="flex items-center gap-2 py-1">
              <Switch checked={p.featured} onCheckedChange={(v) => edit((d) => (d.pricing.plans[i].featured = v))} id={`plan-featured-${i}`} />
              <Label htmlFor={`plan-featured-${i}`} className="text-sm">Highlighted plan</Label>
            </div>
            <Field
              label="Plan features (one per line)"
              value={p.features.join("\n")}
              onChange={(v) => edit((d) => (d.pricing.plans[i].features = v.split("\n").filter((x) => x.trim() !== "")))}
              multiline
            />
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={() => edit((d) => d.pricing.plans.push({ name: "New plan", price: "$0", period: "/month", tag: "", cta: "Get started", cta_link: "/sign-up", featured: false, features: [] }))}>
          <Plus className="h-4 w-4 mr-1.5" /> Add plan
        </Button>
      </SectionCard>

      <SectionCard title="Testimonials" testId="section-testimonials">
        <Field label="Title" value={doc.testimonials.title} onChange={(v) => edit((d) => (d.testimonials.title = v))} />
        {doc.testimonials.items.map((t, i) => (
          <div key={i} className="rounded-lg border p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold">{t.name || `Testimonial ${i + 1}`}</span>
              <ListControls
                index={i}
                count={doc.testimonials.items.length}
                onMove={(from, to) => edit((d) => (d.testimonials.items = moveItem(d.testimonials.items, from, to)))}
                onRemove={(idx) => edit((d) => d.testimonials.items.splice(idx, 1))}
              />
            </div>
            <Field label="Quote" value={t.quote} onChange={(v) => edit((d) => (d.testimonials.items[i].quote = v))} multiline />
            <div className="grid sm:grid-cols-2 gap-2">
              <Field label="Name" value={t.name} onChange={(v) => edit((d) => (d.testimonials.items[i].name = v))} />
              <Field label="Role" value={t.role} onChange={(v) => edit((d) => (d.testimonials.items[i].role = v))} />
            </div>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={() => edit((d) => d.testimonials.items.push({ quote: "", name: "New person", role: "" }))}>
          <Plus className="h-4 w-4 mr-1.5" /> Add testimonial
        </Button>
      </SectionCard>

      <SectionCard title="FAQ" testId="section-faq">
        <Field label="Title" value={doc.faq.title} onChange={(v) => edit((d) => (d.faq.title = v))} />
        {doc.faq.items.map((f, i) => (
          <div key={i} className="rounded-lg border p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold">Question {i + 1}</span>
              <ListControls
                index={i}
                count={doc.faq.items.length}
                onMove={(from, to) => edit((d) => (d.faq.items = moveItem(d.faq.items, from, to)))}
                onRemove={(idx) => edit((d) => d.faq.items.splice(idx, 1))}
              />
            </div>
            <Field label="Question" value={f.q} onChange={(v) => edit((d) => (d.faq.items[i].q = v))} />
            <Field label="Answer" value={f.a} onChange={(v) => edit((d) => (d.faq.items[i].a = v))} multiline />
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={() => edit((d) => d.faq.items.push({ q: "New question?", a: "" }))} data-testid="button-add-faq">
          <Plus className="h-4 w-4 mr-1.5" /> Add question
        </Button>
      </SectionCard>

      <SectionCard title="Final call-to-action" testId="section-cta">
        <Field label="Title" value={doc.cta.title} onChange={(v) => edit((d) => (d.cta.title = v))} />
        <Field label="Subtitle" value={doc.cta.subtitle} onChange={(v) => edit((d) => (d.cta.subtitle = v))} multiline />
        <div className="grid sm:grid-cols-2 gap-2">
          <Field label="Button text" value={doc.cta.button} onChange={(v) => edit((d) => (d.cta.button = v))} />
          <Field label="Button link" value={doc.cta.link} onChange={(v) => edit((d) => (d.cta.link = v))} />
        </div>
      </SectionCard>

      <SectionCard title="Footer" testId="section-footer">
        <Field label="Copyright text" value={doc.footer.text} onChange={(v) => edit((d) => (d.footer.text = v))} />
        {doc.footer.links.map((l, i) => (
          <div key={i} className="flex items-end gap-2">
            <div className="grid grid-cols-2 gap-2 flex-1">
              <Field label="Label" value={l.label} onChange={(v) => edit((d) => (d.footer.links[i].label = v))} />
              <Field label="Link" value={l.href} onChange={(v) => edit((d) => (d.footer.links[i].href = v))} />
            </div>
            <ListControls
              index={i}
              count={doc.footer.links.length}
              onMove={(f, t) => edit((d) => (d.footer.links = moveItem(d.footer.links, f, t)))}
              onRemove={(idx) => edit((d) => d.footer.links.splice(idx, 1))}
            />
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={() => edit((d) => d.footer.links.push({ label: "New link", href: "#" }))}>
          <Plus className="h-4 w-4 mr-1.5" /> Add link
        </Button>
      </SectionCard>

      <SectionCard title="Privacy policy" testId="section-privacy">
        <div className="grid sm:grid-cols-2 gap-2">
          <Field label="Title" value={doc.privacy.title} onChange={(v) => edit((d) => (d.privacy.title = v))} />
          <Field label="Last updated line" value={doc.privacy.updated} onChange={(v) => edit((d) => (d.privacy.updated = v))} />
        </div>
        <Field label="Introduction" value={doc.privacy.intro} onChange={(v) => edit((d) => (d.privacy.intro = v))} multiline />
        {doc.privacy.sections.map((s, i) => (
          <div key={i} className="rounded-lg border p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold">{s.heading || `Section ${i + 1}`}</span>
              <ListControls
                index={i}
                count={doc.privacy.sections.length}
                onMove={(from, to) => edit((d) => (d.privacy.sections = moveItem(d.privacy.sections, from, to)))}
                onRemove={(idx) => edit((d) => d.privacy.sections.splice(idx, 1))}
              />
            </div>
            <Field label="Heading" value={s.heading} onChange={(v) => edit((d) => (d.privacy.sections[i].heading = v))} />
            <Field label="Body" value={s.body} onChange={(v) => edit((d) => (d.privacy.sections[i].body = v))} multiline />
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={() => edit((d) => d.privacy.sections.push({ heading: "New section", body: "" }))}>
          <Plus className="h-4 w-4 mr-1.5" /> Add section
        </Button>
      </SectionCard>
    </div>
  );
}
