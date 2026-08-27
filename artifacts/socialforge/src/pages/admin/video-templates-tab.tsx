import { useRef, useState } from "react";
import {
  getAdminListVideoTemplatesQueryKey,
  getListVideoStylesQueryKey,
  useDeleteAdminVideoTemplate,
  useAdminCreateVideoTemplate,
  useAdminListVideoTemplates,
  useAdminSetVideoTemplatePublished,
  useAdminUpdateVideoTemplate,
  type AdminVideoTemplateInput,
  type CreativeDirection,
  type VideoStyleProfile,
} from "@workspace/api-client-react";
import { CREATIVE_DIRECTION_PRESETS } from "@workspace/studio-presets";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { VIDEO_ASPECTS, type VideoAspect } from "@/lib/videoAspects";
import { Download, Trash2 } from "lucide-react";

type AspectRatio = VideoAspect;
type CaptionStyle = "classic" | "dynamic";
type VisualsSource = "stock" | "ai" | "ai_video" | "character";
type FormatType = "standard" | "presenter_broll";
type InputRequirement = "none" | "optional" | "required";

function downloadTemplateJson(template: VideoStyleProfile) {
  const safeName =
    template.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || `video-template-${template.id}`;
  const exportData = {
    format: "kokao-video-template",
    version: 1,
    template: {
      name: template.name,
      summary: template.summary ?? null,
      slots: template.slots,
      jobDefaults: template.jobDefaults,
      payload: template.payload,
    },
  };
  const blob = new Blob([`${JSON.stringify(exportData, null, 2)}\n`], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safeName}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

interface TemplateDraft {
  name: string;
  summary: string;
  aspectRatio: AspectRatio;
  durationSec: string;
  speakingRateWpm: string;
  scriptDetailLevel: "concise" | "standard" | "detailed";
  minSceneDurationSeconds: string;
  maxSceneDurationSeconds: string;
  minSceneCount: string;
  maxSceneCount: string;
  paragraphCount: string;
  visualsSource: VisualsSource;
  captionStyle: CaptionStyle;
  subtitles: boolean;
  formatType: FormatType;
  brandKitRequirement: InputRequirement;
  musicRequirement: InputRequirement;
  logoRequirement: InputRequirement;
  creativeDirection: CreativeDirection;
}

const initialCreativeDirection = (): CreativeDirection =>
  structuredClone(CREATIVE_DIRECTION_PRESETS[0].value) as CreativeDirection;

const EMPTY_DRAFT: TemplateDraft = {
  name: "",
  summary: "",
  aspectRatio: "9:16",
  durationSec: "30",
  speakingRateWpm: "140",
  scriptDetailLevel: "standard",
  minSceneDurationSeconds: "3",
  maxSceneDurationSeconds: "30",
  minSceneCount: "1",
  maxSceneCount: "20",
  paragraphCount: "1",
  visualsSource: "stock",
  captionStyle: "dynamic",
  subtitles: true,
  formatType: "standard",
  brandKitRequirement: "none",
  musicRequirement: "none",
  logoRequirement: "none",
  creativeDirection: initialCreativeDirection(),
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

function requirementFor(
  template: VideoStyleProfile,
  kind: "brand_kit" | "music" | "logo",
): InputRequirement {
  const slot = template.slots.find((candidate) => candidate.kind === kind);
  return slot ? (slot.required ? "required" : "optional") : "none";
}

function draftFromTemplate(template: VideoStyleProfile): TemplateDraft {
  const defaults = template.jobDefaults;
  return {
    name: template.name,
    summary: template.summary ?? "",
    aspectRatio:
      VIDEO_ASPECTS.some((aspect) => aspect.value === defaults.aspectRatio)
        ? (defaults.aspectRatio as AspectRatio)
        : "9:16",
    durationSec: String(Number(defaults.maxDurationSeconds ?? defaults.durationSec) || 30),
    speakingRateWpm: String(Number(defaults.speakingRateWpm) || 140),
    scriptDetailLevel:
      defaults.scriptDetailLevel === "concise" || defaults.scriptDetailLevel === "detailed"
        ? defaults.scriptDetailLevel
        : "standard",
    minSceneDurationSeconds: String(Number(defaults.minSceneDurationSeconds) || 3),
    maxSceneDurationSeconds: String(Number(defaults.maxSceneDurationSeconds) || 30),
    minSceneCount: String(Number(defaults.minSceneCount) || 1),
    maxSceneCount: String(Number(defaults.maxSceneCount) || 20),
    paragraphCount: String(Number(defaults.paragraphCount) || 1),
    visualsSource:
      (defaults.visualStrategy ?? defaults.visualsSource) === "ai" ||
      (defaults.visualStrategy ?? defaults.visualsSource) === "ai_video" ||
      (defaults.visualStrategy ?? defaults.visualsSource) === "character"
        ? (defaults.visualStrategy ?? defaults.visualsSource) as VisualsSource
        : "stock",
    captionStyle: defaults.captionStyle === "classic" ? "classic" : "dynamic",
    subtitles: defaults.subtitles !== false,
    formatType: template.slots.some(
      (slot) => slot.kind === "presenter_video" && slot.required,
    )
      ? "presenter_broll"
      : "standard",
    brandKitRequirement: requirementFor(template, "brand_kit"),
    musicRequirement: requirementFor(template, "music"),
    logoRequirement: requirementFor(template, "logo"),
    creativeDirection:
      template.payload.creativeDirection ?? initialCreativeDirection(),
  };
}

function lines(value: string): string[] {
  return value.split("\n").map((item) => item.trim()).filter(Boolean);
}

function creativeDirectionIssues(direction: CreativeDirection): string[] {
  const issues: string[] = [];
  const required = new Set(
    (direction.narrative?.requiredVocabulary ?? []).map((term) => term.trim().toLocaleLowerCase()),
  );
  for (const term of direction.narrative?.forbiddenVocabulary ?? []) {
    if (required.has(term.trim().toLocaleLowerCase())) issues.push(`“${term}” is both required and forbidden.`);
  }
  const scenes = direction.structure?.sceneCount;
  if (scenes && scenes.min > scenes.max) issues.push("Minimum scenes cannot exceed maximum scenes.");
  if ((direction.structure?.beats?.length ?? 0) === 0) issues.push("Add at least one production beat.");
  return issues;
}

export function VideoTemplatesTab() {
  const formRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const { data: templates, isLoading } = useAdminListVideoTemplates();
  const createTemplate = useAdminCreateVideoTemplate();
  const updateTemplate = useAdminUpdateVideoTemplate();
  const setPublished = useAdminSetVideoTemplatePublished();
  const deleteTemplate = useDeleteAdminVideoTemplate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [draft, setDraft] = useState<TemplateDraft>(EMPTY_DRAFT);
  const [editing, setEditing] = useState<VideoStyleProfile | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<VideoStyleProfile | null>(null);

  const set = (patch: Partial<TemplateDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const setDirection = (creativeDirection: CreativeDirection) => set({ creativeDirection });
  const setNarrative = (patch: NonNullable<CreativeDirection["narrative"]>) =>
    setDirection({
      ...draft.creativeDirection,
      narrative: { ...draft.creativeDirection.narrative, ...patch },
    });
  const setVisual = (patch: NonNullable<CreativeDirection["visual"]>) =>
    setDirection({
      ...draft.creativeDirection,
      visual: { ...draft.creativeDirection.visual, ...patch },
    });
  const setSonic = (patch: NonNullable<CreativeDirection["sonic"]>) =>
    setDirection({
      ...draft.creativeDirection,
      sonic: { ...draft.creativeDirection.sonic, ...patch },
    });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: getAdminListVideoTemplatesQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListVideoStylesQueryKey() });
  };

  const inputForDraft = (): AdminVideoTemplateInput => {
    const presenterFormat = draft.formatType === "presenter_broll";
    const durationSec = Number(draft.durationSec);
    const existingSlot = (kind: VideoStyleProfile["slots"][number]["kind"]) =>
      editing?.slots.find((slot) => slot.kind === kind);
    const configuredSlot = (
      kind: VideoStyleProfile["slots"][number]["kind"],
      required: boolean,
      label: string,
      hint: string,
    ) => {
      const existing = existingSlot(kind);
      return {
        kind,
        required,
        label: existing?.label ?? label,
        hint: existing?.hint ?? hint,
      };
    };
    const optionalSlot = (
      kind: "brand_kit" | "music" | "logo",
      requirement: InputRequirement,
      label: string,
      hint: string,
    ) =>
      requirement === "none"
        ? []
        : [configuredSlot(kind, requirement === "required", label, hint)];
    const slots = [
      configuredSlot(
        "script",
        true,
        presenterFormat ? "The script spoken in your recording" : "Your topic or script",
        presenterFormat
          ? "Paste the exact words spoken in the presenter recording."
          : "Add a clear topic or paste the words you want the video to cover.",
      ),
      ...(presenterFormat
        ? [
            configuredSlot(
              "presenter_video",
              true,
              "A take of you talking to camera",
              "Use one continuous take, framed with room for B-roll.",
            ),
          ]
        : []),
      ...(draft.visualsSource === "character"
        ? [
            configuredSlot(
              "character",
              true,
              "A saved character",
              "Choose the character who should appear in the generated scenes.",
            ),
          ]
        : []),
      ...optionalSlot(
        "brand_kit",
        draft.brandKitRequirement,
        "A brand kit",
        "Optionally use a brand kit to supply the visual identity.",
      ),
      ...optionalSlot(
        "music",
        draft.musicRequirement,
        "A music bed",
        "Optionally add music under the generated video.",
      ),
      ...optionalSlot(
        "logo",
        draft.logoRequirement,
        "A logo",
        "Optionally add a logo to the generated video.",
      ),
    ];
    return {
      name: draft.name.trim(),
      summary: draft.summary.trim() || null,
      slots,
      jobDefaults: {
        ...(editing?.jobDefaults ?? {}),
        aspectRatio: draft.aspectRatio,
        durationMode: "script_derived",
        maxDurationSeconds: durationSec,
        speakingRateWpm: Number(draft.speakingRateWpm),
        scriptDetailLevel: draft.scriptDetailLevel,
        minSceneDurationSeconds: Number(draft.minSceneDurationSeconds),
        maxSceneDurationSeconds: Number(draft.maxSceneDurationSeconds),
        minSceneCount: Number(draft.minSceneCount),
        maxSceneCount: Number(draft.maxSceneCount),
        visualStrategy: draft.visualsSource,
        subtitles: draft.subtitles,
        captionStyle: draft.captionStyle,
        visualsSource: draft.visualsSource,
        stockSource: editing?.jobDefaults.stockSource ?? "auto",
        // Native long-form AI scenes persist a reviewable plan/checkpoints
        // before any per-scene provider work.
        reviewStoryboard:
          draft.visualsSource === "stock"
            ? (editing?.jobDefaults.reviewStoryboard ?? true)
            : true,
      },
      payload: editing
        ? {
            ...editing.payload,
            captionStyle: draft.captionStyle,
            sourceDurationSec: durationSec,
            creativeDirection: draft.creativeDirection,
          }
        : {
            ...formatPayload(draft.captionStyle, durationSec),
            creativeDirection: draft.creativeDirection,
          },
    };
  };

  const save = () => {
    if (!draft.name.trim()) {
      toast({ title: "Name the template", description: "Give this format a clear name.", variant: "destructive" });
      return;
    }
    const maximum = Number(draft.durationSec);
    const rate = Number(draft.speakingRateWpm);
    const minSceneSec = Number(draft.minSceneDurationSeconds);
    const maxSceneSec = Number(draft.maxSceneDurationSeconds);
    const minScenes = Number(draft.minSceneCount);
    const maxScenes = Number(draft.maxSceneCount);
    if (
      !Number.isInteger(maximum) || maximum < 3 || maximum > 600 ||
      !Number.isInteger(rate) || rate < 80 || rate > 220 ||
      !Number.isFinite(minSceneSec) || minSceneSec < 1 || minSceneSec > 60 ||
      !Number.isFinite(maxSceneSec) || maxSceneSec < minSceneSec || maxSceneSec > 60 ||
      !Number.isInteger(minScenes) || minScenes < 1 || minScenes > 20 ||
      !Number.isInteger(maxScenes) || maxScenes < minScenes || maxScenes > 20 ||
      maxSceneSec * maxScenes < maximum
    ) {
      toast({
        title: "Check long-form settings",
        description:
          "Use 3–600 seconds, 80–220 WPM, valid ascending scene ranges (up to 20 scenes), and enough scene capacity for the maximum duration.",
        variant: "destructive",
      });
      return;
    }
    const directionIssues = creativeDirectionIssues(draft.creativeDirection);
    if (directionIssues.length > 0) {
      toast({ title: "Resolve Creative Direction", description: directionIssues.join(" "), variant: "destructive" });
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
    requestAnimationFrame(() => {
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      nameInputRef.current?.focus({ preventScroll: true });
    });
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

  const remove = () => {
    if (!confirmDelete) return;
    const template = confirmDelete;
    deleteTemplate.mutate(
      { templateId: template.id },
      {
        onSuccess: () => {
          toast({ title: "Template deleted" });
          if (editing?.id === template.id) {
            setEditing(null);
            setDraft(EMPTY_DRAFT);
          }
          setConfirmDelete(null);
          refresh();
        },
        onError: (error) =>
          toast({
            title: "Could not delete template",
            description: apiErrorMessage(error, "Please try again."),
            variant: "destructive",
          }),
      },
    );
  };

  const saving = createTemplate.isPending || updateTemplate.isPending;

  return (
    <div className="space-y-6">
      <Card ref={formRef}>
        <CardHeader>
          <CardTitle>{editing ? `Edit ${editing.name}` : "Create a video template"}</CardTitle>
          <CardDescription>
            Templates are platform-wide formats. They can set presentation defaults but never a workspace’s assets, files, or IDs.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="template-name">Name</Label>
            <Input ref={nameInputRef} id="template-name" value={draft.name} onChange={(event) => set({ name: event.target.value })} maxLength={80} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="template-summary">Summary</Label>
            <Input id="template-summary" value={draft.summary} onChange={(event) => set({ summary: event.target.value })} maxLength={240} />
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="template-type">Format type</Label>
            <select
              id="template-type"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={draft.formatType}
              onChange={(event) => {
                const formatType = event.target.value as FormatType;
                set({
                  formatType,
                  durationSec: String(
                    formatType === "presenter_broll"
                      ? Math.max(60, Number(draft.durationSec) || 60)
                      : Number(draft.durationSec) || 30,
                  ),
                  visualsSource:
                    formatType === "presenter_broll" && draft.visualsSource === "character"
                      ? "stock"
                      : draft.visualsSource,
                });
              }}
            >
              <option value="standard">Standard generated video</option>
              <option value="presenter_broll">Presenter + B-roll</option>
            </select>
            <p className="text-xs text-muted-foreground">
              {draft.formatType === "presenter_broll"
                ? "Uses a presenter recording as the base video and overlays planned B-roll."
                : "Generates the video from a topic or script without a presenter recording."}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="template-aspect">Aspect ratio</Label>
            <select id="template-aspect" className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={draft.aspectRatio} onChange={(event) => set({ aspectRatio: event.target.value as AspectRatio })}>
              {VIDEO_ASPECTS.map((aspect) => (
                <option key={aspect.value} value={aspect.value}>
                  {aspect.label} — {aspect.note}
                </option>
              ))}
            </select>
          </div>
          <div className={draft.formatType === "presenter_broll" ? "space-y-2" : "grid grid-cols-2 gap-3"}>
            <div className="space-y-2">
              <Label htmlFor="template-duration">
                Maximum duration (seconds)
              </Label>
              <Input
                id="template-duration"
                type="number"
                min={3}
                max={600}
                value={draft.durationSec}
                onChange={(event) => set({ durationSec: event.target.value })}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground md:col-span-2">
            Final duration comes from the voiced script and never exceeds this maximum.
          </p>
          <div className="grid gap-3 md:col-span-2 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="template-speaking-rate">Speaking rate (WPM)</Label>
              <Input id="template-speaking-rate" type="number" min={80} max={220} value={draft.speakingRateWpm} onChange={(event) => set({ speakingRateWpm: event.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="template-detail">Script detail</Label>
              <select id="template-detail" className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={draft.scriptDetailLevel} onChange={(event) => set({ scriptDetailLevel: event.target.value as TemplateDraft["scriptDetailLevel"] })}>
                <option value="concise">Concise</option>
                <option value="standard">Standard</option>
                <option value="detailed">Detailed</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label>Duration behavior</Label>
              <Input value="Script-derived (capped)" disabled />
            </div>
          </div>
          <div className="grid gap-3 md:col-span-2 sm:grid-cols-4">
            <div className="space-y-2">
              <Label htmlFor="template-min-scene-sec">Min scene seconds</Label>
              <Input id="template-min-scene-sec" type="number" min={1} max={60} step="0.5" value={draft.minSceneDurationSeconds} onChange={(event) => set({ minSceneDurationSeconds: event.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="template-max-scene-sec">Max scene seconds</Label>
              <Input id="template-max-scene-sec" type="number" min={1} max={60} step="0.5" value={draft.maxSceneDurationSeconds} onChange={(event) => set({ maxSceneDurationSeconds: event.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="template-min-scenes">Min scenes</Label>
              <Input id="template-min-scenes" type="number" min={1} max={20} value={draft.minSceneCount} onChange={(event) => set({ minSceneCount: event.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="template-max-scenes">Max scenes</Label>
              <Input id="template-max-scenes" type="number" min={1} max={20} value={draft.maxSceneCount} onChange={(event) => set({ maxSceneCount: event.target.value })} />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="template-visuals">Visual treatment</Label>
            <select id="template-visuals" className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={draft.visualsSource} onChange={(event) => set({ visualsSource: event.target.value as VisualsSource })}>
              <option value="stock">Stock footage (1 unit)</option>
              <option value="ai">AI imagery (one reserved unit per planned scene)</option>
              <option value="ai_video">Animated AI imagery (two reserved units per planned scene)</option>
              {draft.formatType === "standard" && (
                <option value="character">Saved character (one reserved unit per planned scene)</option>
              )}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="template-captions">Caption treatment</Label>
            <select id="template-captions" className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={draft.captionStyle} onChange={(event) => set({ captionStyle: event.target.value as CaptionStyle })}>
              <option value="dynamic">Dynamic</option>
              <option value="classic">Classic</option>
            </select>
            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <Label htmlFor="template-subtitles">Show subtitles</Label>
              <Switch
                id="template-subtitles"
                checked={draft.subtitles}
                onCheckedChange={(subtitles) => set({ subtitles })}
              />
            </div>
          </div>
          <section className="space-y-4 rounded-lg border p-4 md:col-span-2" data-testid="creative-direction-section">
            <div>
              <h3 className="font-semibold">Creative Direction</h3>
              <p className="text-xs text-muted-foreground">
                Reusable storytelling and production rules only. Workspace assets are supplied later.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="creative-preset">Preset pack</Label>
              <select
                id="creative-preset"
                data-testid="creative-direction-preset"
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={
                  CREATIVE_DIRECTION_PRESETS.find(
                    (preset) => JSON.stringify(preset.value) === JSON.stringify(draft.creativeDirection),
                  )?.id ?? ""
                }
                onChange={(event) => {
                  const preset = CREATIVE_DIRECTION_PRESETS.find((item) => item.id === event.target.value);
                  if (preset) setDirection(structuredClone(preset.value) as CreativeDirection);
                }}
              >
                <option value="" disabled>Choose a starting point…</option>
                {CREATIVE_DIRECTION_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>{preset.name} — {preset.description}</option>
                ))}
              </select>
            </div>

            <div className="grid gap-3 sm:grid-cols-4">
              {([
                ["Hook", "hookStyle", ["direct_claim", "question", "problem_first", "demonstration", "myth_bust", "story"]],
                ["Tone", "tone", ["authoritative", "conversational", "warm", "playful", "urgent", "inspirational", "skeptical"]],
                ["Pacing", "pacing", ["slow", "measured", "brisk", "rapid"]],
                ["Call to action", "ctaStyle", ["none", "soft", "direct"]],
              ] as const).map(([label, key, options]) => (
                <div className="space-y-1" key={key}>
                  <Label htmlFor={`creative-${key}`}>{label}</Label>
                  <select
                    id={`creative-${key}`}
                    className="flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                    value={draft.creativeDirection.narrative?.[key] ?? ""}
                    onChange={(event) => setNarrative({ [key]: event.target.value } as NonNullable<CreativeDirection["narrative"]>)}
                  >
                    <option value="">Unspecified</option>
                    {options.map((option) => <option key={option} value={option}>{option.replaceAll("_", " ")}</option>)}
                  </select>
                </div>
              ))}
            </div>
            <div className="space-y-1">
              <Label htmlFor="creative-guidance">Narrative guidance</Label>
              <textarea
                id="creative-guidance"
                className="min-h-20 w-full rounded-md border border-input bg-background p-3 text-sm"
                maxLength={800}
                value={draft.creativeDirection.narrative?.guidance ?? ""}
                onChange={(event) => setNarrative({ guidance: event.target.value || undefined })}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="creative-required">Required vocabulary (one per line)</Label>
                <textarea
                  id="creative-required"
                  className="min-h-20 w-full rounded-md border border-input bg-background p-3 text-sm"
                  value={(draft.creativeDirection.narrative?.requiredVocabulary ?? []).join("\n")}
                  onChange={(event) => setNarrative({ requiredVocabulary: lines(event.target.value) })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="creative-forbidden">Forbidden vocabulary (one per line)</Label>
                <textarea
                  id="creative-forbidden"
                  className="min-h-20 w-full rounded-md border border-input bg-background p-3 text-sm"
                  value={(draft.creativeDirection.narrative?.forbiddenVocabulary ?? []).join("\n")}
                  onChange={(event) => setNarrative({ forbiddenVocabulary: lines(event.target.value) })}
                />
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-5">
              {([
                ["Style", "style", ["documentary", "editorial", "cinematic", "commercial", "graphic", "natural"]],
                ["Lighting", "lighting", ["natural", "soft", "high_key", "low_key", "dramatic"]],
                ["Colour", "colorGrade", ["natural", "warm", "cool", "vibrant", "muted", "high_contrast"]],
                ["Composition", "composition", ["centered", "rule_of_thirds", "close_detail", "wide_context", "presenter_overlay"]],
                ["Motion", "motion", ["locked", "subtle", "handheld", "dynamic"]],
              ] as const).map(([label, key, options]) => (
                <div className="space-y-1" key={key}>
                  <Label htmlFor={`creative-${key}`}>{label}</Label>
                  <select
                    id={`creative-${key}`}
                    className="flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                    value={draft.creativeDirection.visual?.[key] ?? ""}
                    onChange={(event) => setVisual({ [key]: event.target.value } as NonNullable<CreativeDirection["visual"]>)}
                  >
                    <option value="">Unspecified</option>
                    {options.map((option) => <option key={option} value={option}>{option.replaceAll("_", " ")}</option>)}
                  </select>
                </div>
              ))}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="creative-palette">Palette terms (one per line)</Label>
                <textarea id="creative-palette" className="min-h-16 w-full rounded-md border border-input bg-background p-3 text-sm" value={(draft.creativeDirection.visual?.palette ?? []).join("\n")} onChange={(event) => setVisual({ palette: lines(event.target.value) })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="creative-negative">Visual exclusions (one per line)</Label>
                <textarea id="creative-negative" className="min-h-16 w-full rounded-md border border-input bg-background p-3 text-sm" value={(draft.creativeDirection.visual?.negativeTerms ?? []).join("\n")} onChange={(event) => setVisual({ negativeTerms: lines(event.target.value) })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="creative-subject-rule">Subject/framing rule</Label>
                <Input id="creative-subject-rule" maxLength={240} value={draft.creativeDirection.visual?.subjectRule ?? ""} onChange={(event) => setVisual({ subjectRule: event.target.value || undefined })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="creative-stock-rule">Stock search guidance</Label>
                <Input id="creative-stock-rule" maxLength={240} value={draft.creativeDirection.visual?.stockQueryGuidance ?? ""} onChange={(event) => setVisual({ stockQueryGuidance: event.target.value || undefined })} />
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-4">
              <div className="space-y-1">
                <Label htmlFor="creative-sonic-mood">Sonic mood</Label>
                <select id="creative-sonic-mood" className="flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={draft.creativeDirection.sonic?.mood ?? ""} onChange={(event) => setSonic({ mood: event.target.value as NonNullable<CreativeDirection["sonic"]>["mood"] })}>
                  <option value="">Unspecified</option>
                  {["none", "calm", "optimistic", "playful", "dramatic", "tense"].map((option) => <option key={option}>{option}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="creative-sonic-energy">Energy (1–5)</Label>
                <Input id="creative-sonic-energy" type="number" min={1} max={5} value={draft.creativeDirection.sonic?.energy ?? ""} onChange={(event) => setSonic({ energy: Number(event.target.value) as 1 | 2 | 3 | 4 | 5 })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="creative-sonic-rhythm">Rhythm</Label>
                <select id="creative-sonic-rhythm" className="flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={draft.creativeDirection.sonic?.rhythm ?? ""} onChange={(event) => setSonic({ rhythm: event.target.value as NonNullable<CreativeDirection["sonic"]>["rhythm"] })}>
                  <option value="">Unspecified</option>
                  {["sparse", "steady", "driving"].map((option) => <option key={option}>{option}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="creative-sonic-guidance">Audio guidance</Label>
                <Input id="creative-sonic-guidance" maxLength={240} value={draft.creativeDirection.sonic?.guidance ?? ""} onChange={(event) => setSonic({ guidance: event.target.value || undefined })} />
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">Production beats</p>
                  <p className="text-xs text-muted-foreground">Ordered story beats; weight is the relative runtime.</p>
                </div>
                <Button type="button" size="sm" variant="outline" onClick={() => setDirection({
                  ...draft.creativeDirection,
                  structure: {
                    ...draft.creativeDirection.structure,
                    beats: [...(draft.creativeDirection.structure?.beats ?? []), { purpose: "context", instruction: "Describe this beat.", weight: 1 }],
                  },
                })}>Add beat</Button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="creative-scenes-min">Minimum scenes</Label>
                  <Input id="creative-scenes-min" type="number" min={1} max={20} value={draft.creativeDirection.structure?.sceneCount?.min ?? ""} onChange={(event) => setDirection({ ...draft.creativeDirection, structure: { ...draft.creativeDirection.structure, sceneCount: { min: Number(event.target.value), max: draft.creativeDirection.structure?.sceneCount?.max ?? Number(event.target.value) } } })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="creative-scenes-max">Maximum scenes</Label>
                  <Input id="creative-scenes-max" type="number" min={1} max={20} value={draft.creativeDirection.structure?.sceneCount?.max ?? ""} onChange={(event) => setDirection({ ...draft.creativeDirection, structure: { ...draft.creativeDirection.structure, sceneCount: { min: draft.creativeDirection.structure?.sceneCount?.min ?? Number(event.target.value), max: Number(event.target.value) } } })} />
                </div>
              </div>
              {(draft.creativeDirection.structure?.beats ?? []).map((beat, index) => (
                <div className="grid gap-2 rounded-md border p-3 sm:grid-cols-[10rem_1fr_6rem_auto]" key={`${index}-${beat.purpose}`}>
                  <select className="h-9 rounded-md border border-input bg-background px-2 text-sm" aria-label={`Beat ${index + 1} purpose`} value={beat.purpose} onChange={(event) => {
                    const beats = [...(draft.creativeDirection.structure?.beats ?? [])];
                    beats[index] = { ...beat, purpose: event.target.value as typeof beat.purpose };
                    setDirection({ ...draft.creativeDirection, structure: { ...draft.creativeDirection.structure, beats } });
                  }}>
                    {["hook", "context", "problem", "demonstration", "evidence", "solution", "payoff", "cta"].map((purpose) => <option key={purpose}>{purpose}</option>)}
                  </select>
                  <Input aria-label={`Beat ${index + 1} instruction`} maxLength={240} value={beat.instruction} onChange={(event) => {
                    const beats = [...(draft.creativeDirection.structure?.beats ?? [])];
                    beats[index] = { ...beat, instruction: event.target.value };
                    setDirection({ ...draft.creativeDirection, structure: { ...draft.creativeDirection.structure, beats } });
                  }} />
                  <Input aria-label={`Beat ${index + 1} weight`} type="number" min={0.1} max={10} step={0.1} value={beat.weight ?? ""} onChange={(event) => {
                    const beats = [...(draft.creativeDirection.structure?.beats ?? [])];
                    beats[index] = { ...beat, weight: Number(event.target.value) };
                    setDirection({ ...draft.creativeDirection, structure: { ...draft.creativeDirection.structure, beats } });
                  }} />
                  <Button type="button" size="sm" variant="ghost" onClick={() => setDirection({ ...draft.creativeDirection, structure: { ...draft.creativeDirection.structure, beats: (draft.creativeDirection.structure?.beats ?? []).filter((_, beatIndex) => beatIndex !== index) } })}>Remove</Button>
                </div>
              ))}
            </div>
            {creativeDirectionIssues(draft.creativeDirection).length > 0 && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive" role="alert" data-testid="creative-direction-errors">
                {creativeDirectionIssues(draft.creativeDirection).map((issue) => <p key={issue}>{issue}</p>)}
              </div>
            )}
          </section>
          <div className="flex flex-col gap-3 rounded-md border p-3 md:col-span-2">
            <p className="text-sm font-medium">Inputs shown on the Studio card</p>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="template-script">
                {draft.formatType === "presenter_broll" ? "Spoken script" : "Topic or script"}
              </Label>
              <Switch id="template-script" checked disabled />
            </div>
            {draft.formatType === "presenter_broll" && (
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="template-presenter">Presenter recording</Label>
                <Switch id="template-presenter" checked disabled />
              </div>
            )}
            {draft.visualsSource === "character" && (
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="template-character">Saved character</Label>
                <Switch id="template-character" checked disabled />
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label htmlFor="template-brand-kit">Brand kit</Label>
                <select
                  id="template-brand-kit"
                  className="flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  value={draft.brandKitRequirement}
                  onChange={(event) =>
                    set({ brandKitRequirement: event.target.value as InputRequirement })
                  }
                >
                  <option value="none">Not shown</option>
                  <option value="optional">Optional</option>
                  <option value="required">Required</option>
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="template-music">Music</Label>
                <select
                  id="template-music"
                  className="flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  value={draft.musicRequirement}
                  onChange={(event) =>
                    set({ musicRequirement: event.target.value as InputRequirement })
                  }
                >
                  <option value="none">Not shown</option>
                  <option value="optional">Optional</option>
                  <option value="required">Required</option>
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="template-logo">Logo</Label>
                <select
                  id="template-logo"
                  className="flex h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  value={draft.logoRequirement}
                  onChange={(event) =>
                    set({ logoRequirement: event.target.value as InputRequirement })
                  }
                >
                  <option value="none">Not shown</option>
                  <option value="optional">Optional</option>
                  <option value="required">Required</option>
                </select>
              </div>
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
                  {(template.creativeDirectionIssues?.length ?? 0) > 0 && (
                    <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
                      Resolve before publishing: {template.creativeDirectionIssues?.join(", ")}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" variant="outline" onClick={() => edit(template)}>
                      Edit
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => downloadTemplateJson(template)}
                    >
                      <Download className="mr-1 h-4 w-4" />
                      Download JSON
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => togglePublished(template)}
                      disabled={
                        setPublished.isPending ||
                        (!template.published && (template.creativeDirectionIssues?.length ?? 0) > 0)
                      }
                    >
                      {template.published ? "Unpublish" : "Publish"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      onClick={() => setConfirmDelete(template)}
                      disabled={deleteTemplate.isPending}
                    >
                      <Trash2 className="mr-1 h-4 w-4" />
                      Delete
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>
      <AlertDialog
        open={Boolean(confirmDelete)}
        onOpenChange={(open) => {
          if (!open && !deleteTemplate.isPending) setConfirmDelete(null);
        }}
      >
        <AlertDialogContent data-testid="dialog-delete-video-template">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{confirmDelete?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the format from Video Studio. Existing video jobs are not changed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteTemplate.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={remove}
              disabled={deleteTemplate.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteTemplate.isPending ? "Deleting…" : "Delete template"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
