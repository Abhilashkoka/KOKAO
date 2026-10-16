import { useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListVideoJobsQueryKey,
  getQuoteCreditsQueryKey,
  getListQuickCreatePresetsQueryKey,
  useGenerateVideo,
  useGetMe,
  useListQuickCreatePresets,
  useQuoteCredits,
  useRequestUploadUrl,
} from "@workspace/api-client-react";
import { ImagePlus, Loader2, Music2, Settings2, Sparkles, X } from "lucide-react";
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
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { refreshCreditBalanceSafely } from "@/lib/refresh-credit-balance";
import { trackProjectEvent } from "@/lib/analytics";
import {
  QUICK_CREATE_LANGUAGES,
  QUICK_CREATE_PRESETS,
  QUICK_CREATE_VERTICALS,
  buildQuickCreatePrompt,
  quickCreateEngine,
  type QuickCreateLanguage,
  type QuickCreatePreset,
  type QuickCreateVertical,
} from "@/lib/quick-create-presets";
import { cn } from "@/lib/utils";

const LENGTHS = [5, 10, 15, 30] as const;
const SHAPES = ["9:16", "1:1", "16:9"] as const;

type Photo = { objectPath: string; previewUrl: string; name: string };

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

  const [vertical, setVertical] = useState<QuickCreateVertical>("fashion");
  const [preset, setPreset] = useState<QuickCreatePreset | null>(null);
  const [description, setDescription] = useState("");
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [uploading, setUploading] = useState(false);
  const [durationSec, setDurationSec] = useState<number>(10);
  const [aspect, setAspect] = useState<(typeof SHAPES)[number]>("9:16");
  const [language, setLanguage] = useState<QuickCreateLanguage>("None");
  const [musicPrompt, setMusicPrompt] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

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
    query: { queryKey: getListQuickCreatePresetsQueryKey(), staleTime: 5 * 60_000 },
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
    () => QUICK_CREATE_VERTICALS.filter((v) => catalog.some((p) => p.vertical === v.id)),
    [catalog],
  );
  const activeVertical = verticals.some((v) => v.id === vertical)
    ? vertical
    : (verticals[0]?.id ?? vertical);
  const presets = useMemo(
    () => catalog.filter((p) => p.vertical === activeVertical),
    [catalog, activeVertical],
  );
  const search = useSearch();
  const highlightPhoto = new URLSearchParams(search).get("photo") === "1";

  const applyPreset = (next: QuickCreatePreset) => {
    setPreset(next);
    setDescription(next.prompt);
    setDurationSec(next.durationSec);
    setAspect(next.aspect);
    setMusicPrompt(next.musicPrompt ?? "");
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
      setPhoto({ objectPath, previewUrl: URL.createObjectURL(file), name: file.name });
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

  const prompt = buildQuickCreatePrompt(description, language);
  const canGenerate =
    !meLoading && !isFreePlan && !uploading && prompt.length > 0 && !generateVideo.isPending;

  const onGenerate = () => {
    if (!canGenerate) return;
    const engine = quickCreateEngine(Boolean(photo));
    generateVideo.mutate(
      {
        data: {
          engine,
          prompt,
          sourceImagePaths: photo ? [photo.objectPath] : [],
          aspectRatio: aspect,
          durationSec,
          shotCount: 1,
          musicPrompt: musicPrompt.trim() || null,
          visualsSource: "stock",
        },
      },
      {
        onSuccess: (job) => {
          trackProjectEvent("video_generation_started", { engine });
          void queryClient.invalidateQueries({ queryKey: getListVideoJobsQueryKey() });
          refreshCreditBalanceSafely(queryClient);
          navigate(`/results?job=${job.id}`);
        },
        onError: (error: unknown) => {
          refreshCreditBalanceSafely(queryClient);
          const status = (error as { status?: number } | null)?.status;
          toast({
            title: status === 402 ? "Not enough credits" : "Could not start the video",
            description: apiErrorMessage(
              error,
              status === 402 ? "Top up credits and try again." : "Please try again.",
            ),
            variant: "destructive",
          });
        },
      },
    );
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6" data-testid="quick-create-page">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Create a video</h1>
          <p className="text-muted-foreground">
            A photo and one sentence is enough. We handle the rest.
          </p>
        </div>
        <Link
          href="/studio?tab=video"
          className="inline-flex items-center gap-2 text-sm font-semibold text-primary hover:underline"
          data-testid="link-advanced-studio"
        >
          <Settings2 className="h-4 w-4" /> Advanced studio
        </Link>
      </div>

      {isFreePlan && (
        <div
          className="rounded-2xl border border-amber-300/60 bg-amber-50 p-4 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-100"
          data-testid="quick-create-free-plan"
        >
          Quick Create uses AI video, which is not part of the free plan.{" "}
          <Link href="/settings?tab=billing" className="font-semibold underline">
            Upgrade
          </Link>{" "}
          or use stock Topic to Video in the{" "}
          <Link href="/studio?tab=video" className="font-semibold underline">
            studio
          </Link>
          .
        </div>
      )}

      <section className="space-y-3" aria-labelledby="qc-templates">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="qc-templates" className="text-lg font-semibold">
            Start from a template <span className="text-sm font-normal text-muted-foreground">(optional)</span>
          </h2>
          <div className="flex flex-wrap gap-2">
            {verticals.map((v) => (
              <Chip
                key={v.id}
                active={activeVertical === v.id}
                onClick={() => setVertical(v.id)}
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
              className="hidden"
              onChange={(e) => void onPickFile(e.target.files?.[0])}
              data-testid="qc-photo-input"
            />
            {photo ? (
              <div className="relative h-40 w-32 overflow-hidden rounded-2xl border">
                <img src={photo.previewUrl} alt={photo.name} className="h-full w-full object-cover" />
                <button
                  type="button"
                  aria-label="Remove photo"
                  onClick={() => setPhoto(null)}
                  className="absolute right-2 top-2 rounded-full bg-background/90 p-1"
                  data-testid="qc-photo-remove"
                >
                  <X className="h-4 w-4" />
                </button>
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
              </button>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="qc-description" className="text-base font-semibold">
              Describe your video
            </Label>
            <Textarea
              id="qc-description"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Model wears this saree and sways gently to the music"
              className="rounded-2xl text-base"
              data-testid="qc-description"
            />
            <p className="text-xs text-muted-foreground">Simple sentences work best.</p>
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-2">
              <span className="text-sm font-semibold text-muted-foreground">Length</span>
              <div className="flex flex-wrap gap-2">
                {LENGTHS.map((d) => (
                  <Chip
                    key={d}
                    active={durationSec === d}
                    onClick={() => setDurationSec(d)}
                    testId={`qc-length-${d}`}
                  >
                    {d}s
                  </Chip>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <span className="text-sm font-semibold text-muted-foreground">Shape</span>
              <div className="flex flex-wrap gap-2">
                {SHAPES.map((s) => (
                  <Chip
                    key={s}
                    active={aspect === s}
                    onClick={() => setAspect(s)}
                    testId={`qc-shape-${s}`}
                  >
                    {s}
                  </Chip>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="qc-language" className="text-sm font-semibold text-muted-foreground">
                Language
              </Label>
              <Select value={language} onValueChange={(v) => setLanguage(v as QuickCreateLanguage)}>
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
              <Label htmlFor="qc-music" className="flex items-center gap-1 text-sm font-semibold text-muted-foreground">
                <Music2 className="h-4 w-4" /> Music
              </Label>
              <Input
                id="qc-music"
                value={musicPrompt}
                onChange={(e) => setMusicPrompt(e.target.value)}
                placeholder="e.g. soft sitar, festive"
                data-testid="qc-music"
              />
            </div>
          </div>
        </section>

        <aside className="w-full flex-[1_1_300px] space-y-4 rounded-3xl border bg-card p-6 sm:max-w-sm">
          <h2 className="font-semibold">Summary</h2>
          <dl className="grid grid-cols-2 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Type</dt>
            <dd className="text-right font-semibold">{photo ? "Animate photo" : "Text to video"}</dd>
            <dt className="text-muted-foreground">Length · shape</dt>
            <dd className="text-right font-semibold">
              {durationSec}s · {aspect}
            </dd>
            {creditFunded && quote && (
              <>
                <dt className="text-muted-foreground">Balance after</dt>
                <dd
                  className={cn("text-right font-semibold", !quote.sufficient && "text-destructive")}
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
            onClick={onGenerate}
            disabled={!canGenerate || (creditFunded && quote ? !quote.sufficient : false)}
            data-testid="qc-generate"
          >
            {generateVideo.isPending ? (
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
            ) : (
              <Sparkles className="mr-2 h-5 w-5" />
            )}
            Generate
            {creditFunded && quote && (
              <span className="ml-2 rounded-full bg-white/20 px-2 py-0.5 text-sm" data-testid="qc-cost">
                {quote.credits.toLocaleString("en-IN")} credits
              </span>
            )}
          </Button>
          {creditFunded && quote && !quote.sufficient && (
            <p className="text-sm text-destructive">
              Not enough credits.{" "}
              <Link href="/settings?tab=billing" className="font-semibold underline">
                Top up
              </Link>
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Need characters, scenes or a storyboard review?{" "}
            <Link href="/studio?tab=video" className="font-semibold text-primary hover:underline">
              Open the advanced studio
            </Link>
            .
          </p>
        </aside>
      </div>
    </div>
  );
}
