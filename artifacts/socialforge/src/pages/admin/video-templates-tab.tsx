import { useState } from "react";
import {
  getAdminListVideoTemplatesQueryKey,
  getListVideoStylesQueryKey,
  useAdminCreateVideoTemplate,
  useAdminListVideoTemplates,
  useAdminSetVideoTemplatePublished,
  useAdminUpdateVideoTemplate,
  type AdminVideoTemplateInput,
  type VideoStyleProfile,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/apiErrorMessage";

type AspectRatio = "9:16" | "16:9" | "1:1";
type CaptionStyle = "classic" | "dynamic";
type VisualsSource = "stock" | "ai" | "ai_video" | "character";

interface TemplateDraft {
  name: string;
  summary: string;
  aspectRatio: AspectRatio;
  durationSec: string;
  paragraphCount: string;
  visualsSource: VisualsSource;
  captionStyle: CaptionStyle;
  needsBrandKit: boolean;
  needsPresenter: boolean;
}

const EMPTY_DRAFT: TemplateDraft = {
  name: "",
  summary: "",
  aspectRatio: "9:16",
  durationSec: "30",
  paragraphCount: "1",
  visualsSource: "stock",
  captionStyle: "dynamic",
  needsBrandKit: false,
  needsPresenter: false,
};

const formatPayload = (captionStyle: CaptionStyle, durationSec: number) => ({
  version: 1 as const,
  hookShape: "A concise, benefit-led opening in the first three seconds.",
  pacing: {
    sceneCount: Math.max(1, Math.round(durationSec / 10)),
    avgSceneSec: 10,
    wordsPerMinute: 140,
  },
  captionStyle,
  energy: "clear and confident",
  visualNotes: ["Keep key text inside the safe area.", "Use one visual idea per beat."],
  scriptGuidance: "Open with the audience benefit, explain one useful idea, and end with a direct next step.",
  sourceDurationSec: durationSec,
  transcriptExcerpt: "",
});

function draftFromTemplate(template: VideoStyleProfile): TemplateDraft {
  const defaults = template.jobDefaults;
  return {
    name: template.name,
    summary: template.summary ?? "",
    aspectRatio:
      defaults.aspectRatio === "16:9" || defaults.aspectRatio === "1:1"
        ? defaults.aspectRatio
        : "9:16",
    durationSec: String(Number(defaults.durationSec) || 30),
    paragraphCount: String(Number(defaults.paragraphCount) || 1),
    visualsSource:
      defaults.visualsSource === "ai" ||
      defaults.visualsSource === "ai_video" ||
      defaults.visualsSource === "character"
        ? defaults.visualsSource
        : "stock",
    captionStyle: defaults.captionStyle === "classic" ? "classic" : "dynamic",
    needsBrandKit: template.slots.some((slot) => slot.kind === "brand_kit" && slot.required),
    needsPresenter: template.slots.some(
      (slot) => slot.kind === "presenter_video" && slot.required,
    ),
  };
}

export function VideoTemplatesTab() {
  const { data: templates, isLoading } = useAdminListVideoTemplates();
  const createTemplate = useAdminCreateVideoTemplate();
  const updateTemplate = useAdminUpdateVideoTemplate();
  const setPublished = useAdminSetVideoTemplatePublished();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [draft, setDraft] = useState<TemplateDraft>(EMPTY_DRAFT);
  const [editing, setEditing] = useState<VideoStyleProfile | null>(null);

  const set = (patch: Partial<TemplateDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: getAdminListVideoTemplatesQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListVideoStylesQueryKey() });
  };

  const inputForDraft = (): AdminVideoTemplateInput => {
    const durationSec = Math.max(3, Math.min(30, Number(draft.durationSec) || 30));
    const paragraphCount = Math.max(
      1,
      Math.min(3, Math.round(Number(draft.paragraphCount) || 1)),
    );
    const slots = [
      ...(draft.needsPresenter
        ? [{
            kind: "presenter_video" as const,
            required: true,
            label: "A take of you talking to camera",
            hint: "60–90 seconds, one continuous take, framed with room for B-roll.",
          }]
        : [{
            kind: "script" as const,
            required: true,
            label: "Your topic or script",
            hint: "Add a clear topic or paste the words you want the video to cover.",
          }]),
      ...(draft.visualsSource === "character"
        ? [{
            kind: "character" as const,
            required: true,
            label: "A saved character",
            hint: "Choose the character who should appear in the generated scenes.",
          }]
        : []),
      ...(draft.needsBrandKit
        ? [{
            kind: "brand_kit" as const,
            required: true,
            label: "A brand kit",
            hint: "Choose the brand kit that should supply the visual identity.",
          }]
        : []),
    ];
    return {
      name: draft.name.trim(),
      summary: draft.summary.trim() || null,
      slots,
      jobDefaults: {
        aspectRatio: draft.aspectRatio,
        durationSec,
        subtitles: true,
        captionStyle: draft.captionStyle,
        paragraphCount,
        visualsSource: draft.visualsSource,
        stockSource: "auto",
      },
      payload: editing
        ? {
            ...editing.payload,
            captionStyle: draft.captionStyle,
            sourceDurationSec: durationSec,
          }
        : formatPayload(draft.captionStyle, durationSec),
    };
  };

  const save = () => {
    if (!draft.name.trim()) {
      toast({ title: "Name the template", description: "Give this format a clear name.", variant: "destructive" });
      return;
    }
    const data = inputForDraft();
    const options = {
      onSuccess: () => {
        toast({ title: editing ? "Template updated" : "Template created as draft" });
        setEditing(null);
        setDraft(EMPTY_DRAFT);
        refresh();
      },
      onError: (error: unknown) =>
        toast({
          title: "Could not save template",
          description: apiErrorMessage(error, "Check the format settings and try again."),
          variant: "destructive",
        }),
    };
    if (editing) {
      updateTemplate.mutate({ templateId: editing.id, data }, options);
    } else {
      createTemplate.mutate({ data }, options);
    }
  };

  const edit = (template: VideoStyleProfile) => {
    setEditing(template);
    setDraft(draftFromTemplate(template));
  };

  const togglePublished = (template: VideoStyleProfile) => {
    setPublished.mutate(
      { templateId: template.id, data: { published: !template.published } },
      {
        onSuccess: () => {
          toast({ title: template.published ? "Template unpublished" : "Template published" });
          refresh();
        },
        onError: (error) =>
          toast({
            title: "Could not update publication",
            description: apiErrorMessage(error, "Please try again."),
            variant: "destructive",
          }),
      },
    );
  };

  const saving = createTemplate.isPending || updateTemplate.isPending;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{editing ? `Edit ${editing.name}` : "Create a video template"}</CardTitle>
          <CardDescription>
            Templates are platform-wide formats. They can set presentation defaults but never a workspace’s assets, files, or IDs.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="template-name">Name</Label>
            <Input id="template-name" value={draft.name} onChange={(event) => set({ name: event.target.value })} maxLength={80} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="template-summary">Summary</Label>
            <Input id="template-summary" value={draft.summary} onChange={(event) => set({ summary: event.target.value })} maxLength={240} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="template-aspect">Aspect ratio</Label>
            <select id="template-aspect" className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={draft.aspectRatio} onChange={(event) => set({ aspectRatio: event.target.value as AspectRatio })}>
              <option value="9:16">Vertical (9:16)</option>
              <option value="16:9">Landscape (16:9)</option>
              <option value="1:1">Square (1:1)</option>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="template-duration">Seconds</Label>
              <Input id="template-duration" type="number" min={3} max={30} value={draft.durationSec} onChange={(event) => set({ durationSec: event.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="template-paragraphs">Script paragraphs</Label>
              <Input id="template-paragraphs" type="number" min={1} max={3} value={draft.paragraphCount} onChange={(event) => set({ paragraphCount: event.target.value })} />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="template-visuals">Visual treatment</Label>
            <select id="template-visuals" className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={draft.visualsSource} onChange={(event) => set({ visualsSource: event.target.value as VisualsSource })}>
              <option value="stock">Stock footage (1 unit)</option>
              <option value="ai">AI imagery (2 units per paragraph)</option>
              <option value="ai_video">Animated AI imagery (3 units per paragraph)</option>
              <option value="character">Saved character (4 units per paragraph)</option>
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="template-captions">Caption treatment</Label>
            <select id="template-captions" className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={draft.captionStyle} onChange={(event) => set({ captionStyle: event.target.value as CaptionStyle })}>
              <option value="dynamic">Dynamic</option>
              <option value="classic">Classic</option>
            </select>
          </div>
          <div className="flex flex-col gap-3 rounded-md border p-3">
            <p className="text-sm font-medium">Required inputs shown on the Studio card</p>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="template-script">Topic or script</Label>
              <Switch id="template-script" checked disabled />
            </div>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="template-brand-kit">Brand kit</Label>
              <Switch id="template-brand-kit" checked={draft.needsBrandKit} onCheckedChange={(needsBrandKit) => set({ needsBrandKit })} />
            </div>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="template-presenter">Presenter recording</Label>
              <Switch id="template-presenter" checked={draft.needsPresenter} onCheckedChange={(needsPresenter) => set({ needsPresenter })} />
            </div>
          </div>
          <div className="flex items-end gap-2 md:col-span-2">
            <Button type="button" onClick={save} disabled={saving} data-testid="button-save-video-template">
              {saving ? "Saving…" : editing ? "Save changes" : "Create draft"}
            </Button>
            {editing && (
              <Button type="button" variant="outline" onClick={() => { setEditing(null); setDraft(EMPTY_DRAFT); }}>
                Cancel
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <section className="space-y-3">
        <div>
          <h2 className="text-xl font-bold">Curated formats</h2>
          <p className="text-sm text-muted-foreground">Publish a format when it is ready to appear in every workspace’s Video Studio.</p>
        </div>
        {isLoading ? (
          <Skeleton className="h-36 w-full" />
        ) : templates?.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No video templates yet. Create a draft above.</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {templates?.map((template) => (
              <Card key={template.id} data-testid={`admin-video-template-${template.id}`}>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <CardTitle className="text-base">{template.name}</CardTitle>
                      {template.summary && <CardDescription>{template.summary}</CardDescription>}
                    </div>
                    <Badge variant={template.published ? "default" : "secondary"}>
                      {template.published ? "Published" : "Draft"}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    {template.estimatedUnits} estimated video {template.estimatedUnits === 1 ? "unit" : "units"} · {template.slots.filter((slot) => slot.required).map((slot) => slot.label).join(", ") || "No additional inputs"}
                  </p>
                  <div className="flex gap-2">
                    <Button type="button" size="sm" variant="outline" onClick={() => edit(template)}>
                      Edit
                    </Button>
                    <Button type="button" size="sm" onClick={() => togglePublished(template)} disabled={setPublished.isPending}>
                      {template.published ? "Unpublish" : "Publish"}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}