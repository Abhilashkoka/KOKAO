import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListVideoJobsQueryKey,
  getQuoteCreditsQueryKey,
  getListQuickCreatePresetsQueryKey,
  useGenerateImage,
  useGenerateVideo,
  useGetMe,
  useListQuickCreatePresets,
  useListVideoModels,
  getListVideoModelsQueryKey,
  useQuoteCredits,
  useRequestUploadUrl,
} from "@workspace/api-client-react";
import {
  ImagePlus,
  Loader2,
  Music2,
  Settings2,
  Sparkles,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useCreditFunding } from "@/components/credit-balance";
import { ShowcaseReel } from "@/components/showcase-reel";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { refreshCreditBalanceSafely } from "@/lib/refresh-credit-balance";
import { trackProjectEvent } from "@/lib/analytics";
import {
  QUICK_CREATE_LANGUAGES,
  QUICK_CREATE_PRESETS,
  QUICK_CREATE_VERTICALS,
  buildQuickCreatePrompt,
  presetGender,
  presetWearStyle,
  WEAR_STYLES,
  quickCreateEngine,
  QUICK_CREATE_NO_TEXT,
  quickCreateDefaultModel,
  type QuickCreateModelCatalog,
  type QuickCreateLanguage,
  type QuickCreatePreset,
  type QuickCreateVertical,
} from "@/lib/quick-create-presets";
import { cn } from "@/lib/utils";
import {
  previewOf,
  resetDraft,
  updateDraft,
  updateSingle,
  useCreateDraft,
} from "@/lib/create-draft";

const LENGTHS = [5, 10, 15, 30] as const;
const SHAPES = ["9:16", "1:1", "16:9"] as const;

function Chip({
  active,
  onClick,
  children,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      data-testid={testId}
      className={cn(
        "h-9 rounded-full px-4 text-sm font-semibold transition-colors",
        active
          ? "bg-foreground text-background"
          : "bg-muted text-foreground hover:bg-muted/70",
      )}
    >
      {children}
    </button>
  );
}

export function QuickCreatePage() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { data: me, isLoading: meLoading } = useGetMe();
  const { creditFunded } = useCreditFunding();
  const isFreePlan = me?.tenant?.plan === "free";
  const draft = useCreateDraft();
  const { mode, single } = draft;
  const {
    vertical,
    presetId,
    description,
    photo,
    photoRole,
    gender,
    wearStyle,
    dressed,
    durationSec,
    aspect,
    musicPrompt,
    stage,
  } = single;
  const language = single.language as QuickCreateLanguage;
  const setMode = (next: "single" | "reel") =>
    updateDraft((d) => ({ ...d, mode: next }));
  // Open on the reel when linked with ?mode=reel.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("mode") === "reel") {
      setMode("reel");
    }
  }, []);
  // A draft belongs to one workspace: switching workspaces starts fresh.
  const tenantId = me?.tenant?.id ?? null;
  useEffect(() => {
    if (tenantId == null) return;
    if (draft.tenantId == null) updateDraft((d) => ({ ...d, tenantId }));
    else if (draft.tenantId !== tenantId) resetDraft({ tenantId });
  }, [tenantId, draft.tenantId]);
  // Requests outlive the page; only navigate if the user is still here.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const generateImage = useGenerateImage();
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const busy = stage !== "idle";

  const requestUploadUrl = useRequestUploadUrl();
  const generateVideo = useGenerateVideo();

  const quoteParams = { action: "video", durationSec, sceneCount: 1 };
  const { data: quote } = useQuoteCredits(quoteParams, {
    query: {
      queryKey: getQuoteCreditsQueryKey(quoteParams),
      enabled: creditFunded,
      staleTime: 30_000,
    },
  });

  // Admin-managed starters win; the built-in list covers an empty or
  // unreachable catalog so the page is never blank.
  const { data: adminPresets } = useListQuickCreatePresets({
    query: {
      queryKey: getListQuickCreatePresetsQueryKey(),
      staleTime: 5 * 60_000,
    },
  });
  const catalog = useMemo<QuickCreatePreset[]>(
    () =>
      adminPresets && adminPresets.length > 0
        ? adminPresets.map((p) => ({
            id: `admin-${p.id}`,
            label: p.label,
            vertical: p.vertical,
            prompt: p.prompt,
            durationSec: p.durationSec,
            aspect: p.aspect,
            photoHint: p.photoHint ?? undefined,
            musicPrompt: p.musicPrompt ?? undefined,
          }))
        : QUICK_CREATE_PRESETS,
    [adminPresets],
  );
  const verticals = useMemo(
    () =>
      QUICK_CREATE_VERTICALS.filter((v) =>
        catalog.some((p) => p.vertical === v.id),
      ),
    [catalog],
  );
  const activeVertical = verticals.some((v) => v.id === vertical)
    ? (vertical as QuickCreateVertical)
    : (verticals[0]?.id ?? (vertical as QuickCreateVertical));
  const preset = catalog.find((p) => p.id === presetId) ?? null;
  const presets = useMemo(
    () => catalog.filter((p) => p.vertical === activeVertical),
    [catalog, activeVertical],
  );
  const search = useSearch();
  const highlightPhoto = new URLSearchParams(search).get("photo") === "1";

  const [handoffFiles, setHandoffFiles] = useState<File[] | null>(null);
  const applyPreset = (next: QuickCreatePreset) => {
    // A showcase shows several outfits, so it opens the Showcase reel.
    const nextGender = presetGender(next);
    const nextWear = presetWearStyle(next);
    if (/showcase/i.test(`${next.id} ${next.label}`)) {
      updateDraft((d) => ({
        ...d,
        mode: "reel",
        reel: {
          ...d.reel,
          motion: next.prompt,
          shape: next.aspect,
          ...(nextGender ? { gender: nextGender } : {}),
          ...(nextWear ? { wearStyle: nextWear } : {}),
        },
      }));
      toast({
        title: "Showcase reel",
        description: "Add up to 6 outfits. Each one becomes a look in the reel.",
      });
      return;
    }
    updateSingle({
      presetId: next.id,
      description: next.prompt,
      durationSec: next.durationSec,
      aspect: next.aspect,
      musicPrompt: next.musicPrompt ?? "",
      ...(nextGender ? { gender: nextGender, dressed: null } : {}),
      ...(nextWear ? { wearStyle: nextWear, dressed: null } : {}),
    });
  };

  const onPickFiles = (files: FileList | null) => {
    const images = Array.from(files ?? []).filter((f) => f.type.startsWith("image/"));
    if (images.length > 1) {
      // Several outfits: that's a showcase reel, not a single video.
      setHandoffFiles(images);
      setMode("reel");
      if (fileInput.current) fileInput.current.value = "";
      return;
    }
    void onPickFile(files?.[0]);
  };

  const onPickFile = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast({ title: "Please choose an image", variant: "destructive" });
      return;
    }
    setUploading(true);
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
      updateSingle({
        photo: { objectPath, previewUrl: URL.createObjectURL(file), name: file.name },
        dressed: null,
      });
    } catch (error) {
      toast({
        title: "Could not upload the photo",
        description: apiErrorMessage(error, "Please try again."),
        variant: "destructive",
      });
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  // Sound comes from the video model itself (e.g. Wan with native audio), never
  // from a separate music service that may not be configured.
  const { data: videoModels } = useListVideoModels({
    query: { queryKey: getListVideoModelsQueryKey(), staleTime: 5 * 60_000 },
  });
  const defaultModel = quickCreateDefaultModel(
    videoModels as QuickCreateModelCatalog | undefined,
    photo ? "image" : "text",
  );
  const nativeAudio = Boolean(defaultModel?.canGenerateAudio);
  const wantsSound =
    nativeAudio && (musicPrompt.trim().length > 0 || language !== "None");
  const basePrompt = buildQuickCreatePrompt(
    description,
    language,
    nativeAudio ? musicPrompt : "",
  );
  const prompt = basePrompt ? `${basePrompt} ${QUICK_CREATE_NO_TEXT}` : "";
  // An outfit photo is put on a model first, inside the same Generate click.
  const needsTryOn = Boolean(photo) && photoRole === "model";
  const dressedLook =
    photo && dressed && dressed.forPhoto === photo.objectPath ? dressed.image : null;
  const canGenerate =
    !meLoading &&
    !isFreePlan &&
    !uploading &&
    !busy &&
    prompt.length > 0;

  const failToast = (title: string, error: unknown, fallback = "Please try again.") =>
    toast({ title, description: apiErrorMessage(error, fallback), variant: "destructive" });

  const onGenerate = async () => {
    if (!canGenerate) return;
    let startFrame: string | null = null;
    if (photo && !needsTryOn) startFrame = photo.objectPath;
    if (photo && needsTryOn) {
      if (dressedLook) {
        startFrame = dressedLook.objectPath;
      } else {
        updateSingle({ stage: "dressing" });
        try {
          const image = await generateImage.mutateAsync({
            data: {
              prompt: description,
              size:
                aspect === "16:9"
                  ? "1536x1024"
                  : aspect === "1:1"
                    ? "1024x1024"
                    : "1024x1536",
              tryOn: { outfitImagePath: photo.objectPath, gender, style: wearStyle },
            },
          });
          startFrame = image.imagePath;
          updateSingle({
            dressed: {
              forPhoto: photo.objectPath,
              image: { objectPath: image.imagePath, name: photo.name },
            },
          });
        } catch (error) {
          updateSingle({ stage: "idle" });
          failToast("Could not dress the model", error);
          return;
        } finally {
          refreshCreditBalanceSafely(queryClient);
        }
      }
    }

    updateSingle({ stage: "starting" });
    const engine = quickCreateEngine(Boolean(startFrame));
    try {
      const job = await generateVideo.mutateAsync({
        data: {
          engine,
          prompt,
          sourceImagePaths: startFrame ? [startFrame] : [],
          aspectRatio: aspect,
          durationSec,
          shotCount: 1,
          generateAudio: wantsSound ? true : null,
          visualsSource: "stock",
          // One shot from one sentence: nothing to review, render straight away.
          reviewStoryboard: false,
        },
      });
      trackProjectEvent("video_generation_started", { engine });
      void queryClient.invalidateQueries({ queryKey: getListVideoJobsQueryKey() });
      if (mounted.current) navigate(`/results?job=${job.id}`);
      else toast({ title: "Your video has started", description: "Find it in Results." });
    } catch (error) {
      const status = (error as { status?: number } | null)?.status;
      failToast(
        status === 402 ? "Not enough credits" : "Could not start the video",
        error,
        status === 402 ? "Top up credits and try again." : "Please try again.",
      );
    } finally {
      updateSingle({ stage: "idle" });
      refreshCreditBalanceSafely(queryClient);
    }
  };

  return (
    <div
      className="mx-auto max-w-6xl space-y-6"
      data-testid="quick-create-page"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Create a video</h1>
          <p className="text-muted-foreground">
            A photo and one sentence is enough. We handle the rest.
          </p>
        </div>
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => resetDraft({ tenantId: draft.tenantId, mode })}
            disabled={busy || draft.reel.starting}
            className="text-sm font-semibold text-muted-foreground hover:text-foreground"
            data-testid="qc-start-over"
          >
            Start over
          </button>
          <Link
            href="/studio?tab=video"
            className="inline-flex items-center gap-2 text-sm font-semibold text-primary hover:underline"
            data-testid="link-advanced-studio"
          >
            <Settings2 className="h-4 w-4" /> Advanced studio
          </Link>
        </div>
      </div>

      {isFreePlan && (
        <div
          className="rounded-2xl border border-amber-300/60 bg-amber-50 p-4 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-100"
          data-testid="quick-create-free-plan"
        >
          Quick Create uses AI video, which is not part of the free plan.{" "}
          <Link
            href="/settings?tab=billing"
            className="font-semibold underline"
          >
            Upgrade
          </Link>{" "}
          or use stock Topic to Video in the{" "}
          <Link href="/studio?tab=video" className="font-semibold underline">
            studio
          </Link>
          .
        </div>
      )}

      <div
        className="inline-flex rounded-full bg-muted p-1"
        role="tablist"
        aria-label="What to make"
      >
        {(
          [
            ["single", "Single video"],
            ["reel", "Showcase reel"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            onClick={() => setMode(value)}
            data-testid={`qc-mode-${value}`}
            className={
              mode === value
                ? "h-9 rounded-full bg-background px-5 text-sm font-semibold shadow-sm"
                : "h-9 rounded-full px-5 text-sm font-semibold text-muted-foreground hover:text-foreground"
            }
          >
            {label}
          </button>
        ))}
      </div>

      {mode === "reel" ? (
        <ShowcaseReel
          disabled={isFreePlan || meLoading}
          creditFunded={creditFunded}
          handoffFiles={handoffFiles}
          onHandoffTaken={() => setHandoffFiles(null)}
        />
      ) : (
        <>
          <section className="space-y-3" aria-labelledby="qc-templates">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="qc-templates" className="text-lg font-semibold">
                Start from a template{" "}
                <span className="text-sm font-normal text-muted-foreground">
                  (optional)
                </span>
              </h2>
              <div className="flex flex-wrap gap-2">
                {verticals.map((v) => (
                  <Chip
                    key={v.id}
                    active={activeVertical === v.id}
                    onClick={() => updateSingle({ vertical: v.id })}
                    testId={`qc-vertical-${v.id}`}
                  >
                    {v.label}
                  </Chip>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap gap-3">
              {presets.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => applyPreset(p)}
                  aria-pressed={preset?.id === p.id}
                  data-testid={`qc-preset-${p.id}`}
                  className={cn(
                    "flex min-w-[180px] flex-1 flex-col items-start gap-1 rounded-2xl border p-4 text-left transition-colors sm:flex-none",
                    preset?.id === p.id
                      ? "border-primary bg-primary/10"
                      : "border-border bg-card hover:bg-muted/60",
                  )}
                >
                  <span className="font-semibold">{p.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {p.durationSec}s · {p.aspect}
                  </span>
                </button>
              ))}
            </div>
          </section>

          <div className="flex flex-wrap items-start gap-6">
            <section className="min-w-0 flex-[999_1_460px] space-y-6 rounded-3xl border bg-card p-6">
              <div className="space-y-3">
                <div className="flex items-baseline justify-between">
                  <h2 className="font-semibold">Photo</h2>
                  <span className="text-xs text-muted-foreground">
                    {preset?.photoHint ?? "Product, outfit or you · optional"}
                  </span>
                </div>
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => onPickFiles(e.target.files)}
                  data-testid="qc-photo-input"
                />
                {photo && (
                  <div
                    className="flex flex-wrap gap-2"
                    role="radiogroup"
                    aria-label="How to use this photo"
                  >
                    <Chip
                      active={photoRole === "model"}
                      onClick={() => updateSingle({ photoRole: "model" })}
                      testId="qc-role-model"
                    >
                      Put it on a model
                    </Chip>
                    <Chip
                      active={photoRole === "as_is"}
                      onClick={() => updateSingle({ photoRole: "as_is" })}
                      testId="qc-role-as-is"
                    >
                      Animate this photo as is
                    </Chip>
                  </div>
                )}
                {photo && photoRole === "model" && (
                  <div
                    className="flex flex-wrap items-center gap-2"
                    role="radiogroup"
                    aria-label="Who models it"
                  >
                    <span className="text-sm font-semibold text-muted-foreground">Model</span>
                    {(
                      [
                        ["woman", "Woman"],
                        ["man", "Man"],
                      ] as const
                    ).map(([value, label]) => (
                      <Chip
                        key={value}
                        active={gender === value}
                        // A different model means a new look on the next Generate.
                        onClick={() =>
                          gender !== value && updateSingle({ gender: value, dressed: null })
                        }
                        testId={`qc-gender-${value}`}
                      >
                        {label}
                      </Chip>
                    ))}
                    <span className="ml-2 text-sm font-semibold text-muted-foreground">Style</span>
                    {WEAR_STYLES.map((w) => (
                      <Chip
                        key={w.id}
                        active={wearStyle === w.id}
                        onClick={() =>
                          wearStyle !== w.id && updateSingle({ wearStyle: w.id, dressed: null })
                        }
                        testId={`qc-wear-${w.id}`}
                      >
                        {w.label}
                      </Chip>
                    ))}
                  </div>
                )}
                {photo ? (
                  <div className="flex flex-wrap items-start gap-4">
                    <div className="relative h-40 w-32 overflow-hidden rounded-2xl border">
                      <img
                        src={previewOf(photo)}
                        alt={photo.name}
                        className="h-full w-full object-cover"
                      />
                      <button
                        type="button"
                        aria-label="Remove photo"
                        onClick={() => updateSingle({ photo: null, dressed: null })}
                        className="absolute right-2 top-2 rounded-full bg-background/90 p-1"
                        data-testid="qc-photo-remove"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                    {needsTryOn && (
                      <div className="flex flex-col gap-2" data-testid="qc-tryon">
                        {dressedLook ? (
                          <img
                            src={previewOf(dressedLook)}
                            alt="Model wearing your outfit"
                            className="h-40 w-32 rounded-2xl border object-cover"
                            data-testid="qc-tryon-image"
                          />
                        ) : (
                          <div className="flex h-40 w-32 items-center justify-center rounded-2xl border border-dashed bg-muted/40 p-2 text-center text-xs text-muted-foreground">
                            {stage === "dressing" ? (
                              <Loader2 className="h-5 w-5 animate-spin" />
                            ) : (
                              "A model wears this when you tap Generate"
                            )}
                          </div>
                        )}
                        {dressedLook && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => updateSingle({ dressed: null })}
                            disabled={busy}
                            data-testid="qc-tryon-reset"
                          >
                            New look next time
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => fileInput.current?.click()}
                    disabled={uploading}
                    className={cn(
                      "flex h-40 w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-primary/30 bg-pastel-lavender/40 text-sm font-semibold text-primary hover:bg-primary/5",
                      highlightPhoto && "border-primary ring-4 ring-primary/20",
                    )}
                    data-testid="qc-photo-add"
                  >
                    {uploading ? (
                      <Loader2 className="h-6 w-6 animate-spin" />
                    ) : (
                      <ImagePlus className="h-6 w-6" />
                    )}
                    {uploading ? "Uploading…" : "Add a photo"}
                    <span className="text-xs font-normal text-muted-foreground">
                      Pick several outfits to make a showcase reel
                    </span>
                  </button>
                )}
              </div>

              <div className="space-y-2">
                <Label
                  htmlFor="qc-description"
                  className="text-base font-semibold"
                >
                  Describe your video
                </Label>
                <Textarea
                  id="qc-description"
                  rows={3}
                  value={description}
                  onChange={(e) => updateSingle({ description: e.target.value })}
                  placeholder="e.g. Model wears this saree and sways gently to the music"
                  className="rounded-2xl text-base"
                  data-testid="qc-description"
                />
                <p className="text-xs text-muted-foreground">
                  Simple sentences work best.
                </p>
              </div>

              <div className="grid gap-5 sm:grid-cols-2">
                <div className="space-y-2">
                  <span className="text-sm font-semibold text-muted-foreground">
                    Length
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {LENGTHS.map((d) => (
                      <Chip
                        key={d}
                        active={durationSec === d}
                        onClick={() => updateSingle({ durationSec: d })}
                        testId={`qc-length-${d}`}
                      >
                        {d}s
                      </Chip>
                    ))}
                  </div>
                </div>
                <div className="space-y-2">
                  <span className="text-sm font-semibold text-muted-foreground">
                    Shape
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {SHAPES.map((s) => (
                      <Chip
                        key={s}
                        active={aspect === s}
                        onClick={() => updateSingle({ aspect: s })}
                        testId={`qc-shape-${s}`}
                      >
                        {s}
                      </Chip>
                    ))}
                  </div>
                </div>
                <div className="space-y-2">
                  <Label
                    htmlFor="qc-language"
                    className="text-sm font-semibold text-muted-foreground"
                  >
                    Language
                  </Label>
                  <Select
                    value={language}
                    onValueChange={(v) => updateSingle({ language: v })}
                  >
                    <SelectTrigger id="qc-language" data-testid="qc-language">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {QUICK_CREATE_LANGUAGES.map((l) => (
                        <SelectItem key={l} value={l}>
                          {l === "None" ? "No speech" : l}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label
                    htmlFor="qc-music"
                    className="flex items-center gap-1 text-sm font-semibold text-muted-foreground"
                  >
                    <Music2 className="h-4 w-4" /> Music
                  </Label>
                  <Input
                    id="qc-music"
                    value={musicPrompt}
                    onChange={(e) => updateSingle({ musicPrompt: e.target.value })}
                    placeholder={
                      nativeAudio
                        ? "e.g. soft sitar, festive"
                        : "Not available for this video model"
                    }
                    disabled={!nativeAudio}
                    data-testid="qc-music"
                  />
                  {!nativeAudio && (
                    <p
                      className="text-xs text-muted-foreground"
                      data-testid="qc-music-note"
                    >
                      This video model makes silent clips. Add a music track in
                      the{" "}
                      <Link
                        href="/studio?tab=video"
                        className="font-semibold text-primary hover:underline"
                      >
                        advanced studio
                      </Link>
                      .
                    </p>
                  )}
                </div>
              </div>
            </section>

            <aside className="w-full flex-[1_1_300px] space-y-4 rounded-3xl border bg-card p-6 sm:max-w-sm">
              <h2 className="font-semibold">Summary</h2>
              <dl className="grid grid-cols-2 gap-y-2 text-sm">
                <dt className="text-muted-foreground">Type</dt>
                <dd className="text-right font-semibold">
                  {!photo
                    ? "Text to video"
                    : needsTryOn
                      ? "Model wears your photo"
                      : "Animate photo"}
                </dd>
                <dt className="text-muted-foreground">Length · shape</dt>
                <dd className="text-right font-semibold">
                  {durationSec}s · {aspect}
                </dd>
                {creditFunded && quote && (
                  <>
                    <dt className="text-muted-foreground">Balance after</dt>
                    <dd
                      className={cn(
                        "text-right font-semibold",
                        !quote.sufficient && "text-destructive",
                      )}
                      data-testid="qc-balance-after"
                    >
                      {quote.balanceAfter.toLocaleString("en-IN")}
                    </dd>
                  </>
                )}
              </dl>
              <Button
                size="lg"
                className="h-14 w-full rounded-2xl text-base"
                onClick={() => void onGenerate()}
                disabled={
                  !canGenerate ||
                  (creditFunded && quote ? !quote.sufficient : false)
                }
                data-testid="qc-generate"
              >
                {busy ? (
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                ) : (
                  <Sparkles className="mr-2 h-5 w-5" />
                )}
                {stage === "dressing"
                  ? "Dressing the model…"
                  : stage === "starting"
                    ? "Starting…"
                    : "Generate"}
                {creditFunded && quote && (
                  <span
                    className="ml-2 rounded-full bg-white/20 px-2 py-0.5 text-sm"
                    data-testid="qc-cost"
                  >
                    {quote.credits.toLocaleString("en-IN")} credits
                  </span>
                )}
              </Button>
              {needsTryOn && !dressedLook && (
                <p className="text-sm text-muted-foreground" data-testid="qc-tryon-hint">
                  A model is dressed in your outfit first, then animated. One tap.
                </p>
              )}
              {creditFunded && quote && !quote.sufficient && (
                <p className="text-sm text-destructive">
                  Not enough credits.{" "}
                  <Link
                    href="/settings?tab=billing"
                    className="font-semibold underline"
                  >
                    Top up
                  </Link>
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Need characters, scenes or a storyboard review?{" "}
                <Link
                  href="/studio?tab=video"
                  className="font-semibold text-primary hover:underline"
                >
                  Open the advanced studio
                </Link>
                .
              </p>
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
