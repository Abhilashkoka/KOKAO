import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListVideoJobsQueryKey,
  getQuoteCreditsQueryKey,
  useGenerateImage,
  useGenerateVideo,
  useQuoteCredits,
  useRequestUploadUrl,
} from "@workspace/api-client-react";
import {
  ImagePlus,
  Loader2,
  Music2,
  Sparkles,
  Trash2,
  UserRound,
  Wand2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { refreshCreditBalanceSafely } from "@/lib/refresh-credit-balance";
import { trackProjectEvent } from "@/lib/analytics";
import { analyzeMusicFile, lookTiming } from "@/lib/beat";
import {
  getDraft,
  previewOf,
  updateReel,
  useCreateDraft,
  type ReelLook,
  type Uploaded,
} from "@/lib/create-draft";
import { cn } from "@/lib/utils";

export const MAX_REEL_LOOKS = 6;
const SHAPES = ["9:16", "1:1", "16:9"] as const;
type Shape = (typeof SHAPES)[number];
const sizeFor = (shape: Shape) =>
  shape === "16:9" ? "1536x1024" : shape === "1:1" ? "1024x1024" : "1024x1536";

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

/**
 * Showcase Reel: several outfits on the same model, cut on the music's beat.
 * "Video reel" animates every look with AI; "Photo reel" moves between the
 * dressed photos (cheaper and faster).
 */
export function ShowcaseReel({
  disabled,
  creditFunded,
}: {
  disabled: boolean;
  creditFunded: boolean;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const requestUploadUrl = useRequestUploadUrl();
  const generateImage = useGenerateImage();
  const generateVideo = useGenerateVideo();

  // State lives in the Create draft store, so it survives leaving the page.
  const { model, looks, music, style, bars, shape, motion, starting } =
    useCreateDraft().reel;
  const [analyzing, setAnalyzing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const outfitInput = useRef<HTMLInputElement>(null);
  const modelInput = useRef<HTMLInputElement>(null);
  const musicInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const setLooks = (change: (prev: ReelLook[]) => ReelLook[]) =>
    updateReel((r) => ({ looks: change(r.looks) }));

  const upload = async (file: File): Promise<Uploaded> => {
    const { uploadURL, objectPath } = await requestUploadUrl.mutateAsync({
      data: { name: file.name, size: file.size, contentType: file.type },
    });
    const put = await fetch(uploadURL, {
      method: "PUT",
      body: file,
      headers: { "Content-Type": file.type },
    });
    if (!put.ok) throw new Error(`Upload failed (${put.status})`);
    return {
      objectPath,
      previewUrl: URL.createObjectURL(file),
      name: file.name,
    };
  };
  const fail = (title: string) => (error: unknown) =>
    toast({
      title,
      description: apiErrorMessage(error, "Please try again."),
      variant: "destructive",
    });

  const addOutfits = async (files: FileList | null) => {
    if (!files?.length) return;
    const room = MAX_REEL_LOOKS - getDraft().reel.looks.length;
    const picked = Array.from(files)
      .filter((f) => f.type.startsWith("image/"))
      .slice(0, room);
    if (files.length > room) {
      toast({
        title: `Up to ${MAX_REEL_LOOKS} outfits per reel`,
        description: "Extra photos were left out.",
      });
    }
    setUploading(true);
    try {
      for (const file of picked) {
        const outfit = await upload(file);
        setLooks((prev) => [
          ...prev,
          {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            outfit,
            dressed: null,
            pending: false,
          },
        ]);
      }
    } catch (error) {
      fail("Could not upload a photo")(error);
    } finally {
      setUploading(false);
      if (outfitInput.current) outfitInput.current.value = "";
    }
  };

  const pickModel = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const uploaded = await upload(file);
      updateReel({ model: uploaded });
      // A new face means every look must be dressed again to match it.
      setLooks((prev) => prev.map((look) => ({ ...look, dressed: null })));
    } catch (error) {
      fail("Could not upload the model photo")(error);
    } finally {
      setUploading(false);
      if (modelInput.current) modelInput.current.value = "";
    }
  };

  const pickMusic = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("audio/")) {
      toast({ title: "Please choose a music file", variant: "destructive" });
      return;
    }
    setAnalyzing(true);
    try {
      const [uploaded, beat] = await Promise.all([
        upload(file),
        analyzeMusicFile(file),
      ]);
      updateReel({ music: { ...uploaded, beat } });
      if (!beat) {
        toast({
          title: "Couldn't find a clear beat",
          description: "The reel will still use this music, with even cuts.",
        });
      }
    } catch (error) {
      fail("Could not upload the music")(error);
    } finally {
      setAnalyzing(false);
      if (musicInput.current) musicInput.current.value = "";
    }
  };

  /** The face every look must keep: the uploaded model, else the first dressed look. */
  const faceFor = (lookId: string): string | null => {
    const reel = getDraft().reel;
    if (reel.model) return reel.model.objectPath;
    const first = reel.looks.find((look) => look.dressed);
    return first && first.id !== lookId ? first.dressed!.objectPath : null;
  };

  const dress = async (
    look: ReelLook,
    face: string | null = faceFor(look.id),
  ): Promise<string | null> => {
    setLooks((prev) =>
      prev.map((l) => (l.id === look.id ? { ...l, pending: true } : l)),
    );
    try {
      const { motion: scene, shape: size } = getDraft().reel;
      const image = await generateImage.mutateAsync({
        data: {
          prompt: scene,
          size: sizeFor(size),
          tryOn: { outfitImagePath: look.outfit.objectPath, modelImagePath: face },
        },
      });
      setLooks((prev) =>
        prev.map((l) =>
          l.id === look.id
            ? {
                ...l,
                pending: false,
                dressed: { objectPath: image.imagePath, name: l.outfit.name },
              }
            : l,
        ),
      );
      return image.imagePath;
    } catch (error) {
      setLooks((prev) =>
        prev.map((l) => (l.id === look.id ? { ...l, pending: false } : l)),
      );
      fail("Could not dress the model")(error);
      return null;
    } finally {
      refreshCreditBalanceSafely(queryClient);
    }
  };

  /** Dress the remaining looks one by one, so the first sets the face for the rest. */
  const dressAll = async () => {
    const reel = getDraft().reel;
    let face: string | null =
      reel.model?.objectPath ??
      reel.looks.find((look) => look.dressed)?.dressed?.objectPath ??
      null;
    for (const look of reel.looks) {
      if (look.dressed || look.pending) continue;
      // Skip looks removed while earlier ones were being dressed.
      if (!getDraft().reel.looks.some((l) => l.id === look.id)) continue;
      const result = await dress(look, face);
      if (!face && result) face = result;
    }
  };

  const ready = looks.length >= 2 && looks.every((look) => look.dressed);
  const anyPending = looks.some((look) => look.pending);
  const timing = lookTiming(music?.beat ?? null, bars, style);
  const totalSec = Math.round(timing.onScreenSec * looks.length * 10) / 10;

  const quoteParams = {
    action: "video",
    durationSec: Math.max(1, timing.clipSec * looks.length),
    sceneCount: Math.max(1, looks.length),
  };
  const { data: quote } = useQuoteCredits(quoteParams, {
    query: {
      queryKey: getQuoteCreditsQueryKey(quoteParams),
      enabled: creditFunded && style === "video" && looks.length >= 2,
      staleTime: 30_000,
    },
  });

  const onGenerate = () => {
    if (!ready || disabled || starting) return;
    const photos = looks.map((look) => look.dressed!.objectPath);
    const beatSec = music?.beat?.barSec ?? null;
    const musicStartSec = music?.beat ? music.beat.firstBeatSec : null;
    const common = {
      sourceImagePaths: photos,
      aspectRatio: shape,
      musicPath: music?.objectPath ?? null,
      beatSec,
      musicStartSec,
      reviewStoryboard: false,
    };
    const data =
      style === "video"
        ? {
            ...common,
            engine: "image_to_video" as const,
            photoClips: true,
            prompt: `${motion.trim()}. No on-screen text, captions, logos or watermarks.`,
            durationSec: timing.clipSec,
            generateAudio: music ? false : null,
          }
        : {
            ...common,
            engine: "slideshow" as const,
            slideDurationSec: timing.onScreenSec,
          };
    updateReel({ starting: true });
    generateVideo
      .mutateAsync({ data })
      .then((job) => {
        trackProjectEvent("video_generation_started", { engine: data.engine });
        void queryClient.invalidateQueries({ queryKey: getListVideoJobsQueryKey() });
        if (mounted.current) navigate(`/results?job=${job.id}`);
        else toast({ title: "Your reel has started", description: "Find it in Results." });
      })
      .catch(fail("Could not start the reel"))
      .finally(() => {
        updateReel({ starting: false });
        refreshCreditBalanceSafely(queryClient);
      });
  };

  return (
    <div
      className="flex flex-wrap items-start gap-6"
      data-testid="showcase-reel"
    >
      <section className="min-w-0 flex-[999_1_460px] space-y-6 rounded-3xl border bg-card p-6">
        {/* Model */}
        <div className="space-y-2">
          <div className="flex items-baseline justify-between">
            <h2 className="font-semibold">Model</h2>
            <span className="text-xs text-muted-foreground">
              Optional · keeps the same face in every look
            </span>
          </div>
          <input
            ref={modelInput}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => void pickModel(e.target.files?.[0])}
            data-testid="reel-model-input"
          />
          <div className="flex items-center gap-3">
            {model ? (
              <img
                src={previewOf(model)}
                alt="Model"
                className="h-20 w-16 rounded-xl border object-cover"
              />
            ) : (
              <span className="flex h-20 w-16 items-center justify-center rounded-xl bg-pastel-lavender text-primary">
                <UserRound className="h-6 w-6" />
              </span>
            )}
            <div className="space-y-1 text-sm">
              <p className="text-muted-foreground">
                {model
                  ? "Every look uses this person."
                  : "No photo: an AI model is created from your first look."}
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => modelInput.current?.click()}
                  disabled={uploading}
                >
                  {model ? "Change" : "Add model photo"}
                </Button>
                {model && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => updateReel({ model: null })}
                  >
                    Remove
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Outfits */}
        <div className="space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="font-semibold">Outfits</h2>
            <span className="text-xs text-muted-foreground">
              {looks.length}/{MAX_REEL_LOOKS} · one photo per saree or dress
            </span>
          </div>
          <input
            ref={outfitInput}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => void addOutfits(e.target.files)}
            data-testid="reel-outfit-input"
          />
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
            {looks.map((look, index) => (
              <div
                key={look.id}
                className="space-y-2 rounded-2xl border p-2"
                data-testid={`reel-look-${index}`}
              >
                <div className="grid grid-cols-2 gap-1">
                  <img
                    src={previewOf(look.outfit)}
                    alt={`Outfit ${index + 1}`}
                    className="aspect-[3/4] w-full rounded-lg object-cover"
                  />
                  {look.dressed ? (
                    <img
                      src={previewOf(look.dressed)}
                      alt={`Model in outfit ${index + 1}`}
                      className="aspect-[3/4] w-full rounded-lg object-cover"
                      data-testid={`reel-dressed-${index}`}
                    />
                  ) : (
                    <span className="flex aspect-[3/4] w-full items-center justify-center rounded-lg bg-muted text-center text-[11px] text-muted-foreground">
                      {look.pending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        "Not dressed"
                      )}
                    </span>
                  )}
                </div>
                <div className="flex items-center justify-between gap-1">
                  <span className="text-xs font-semibold">
                    Look {index + 1}
                  </span>
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 px-2 text-xs"
                      onClick={() => void dress(look)}
                      disabled={look.pending}
                      data-testid={`reel-dress-${index}`}
                    >
                      {look.dressed ? "Retry" : "Dress"}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      aria-label={`Remove look ${index + 1}`}
                      onClick={() =>
                        setLooks((prev) => prev.filter((l) => l.id !== look.id))
                      }
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
            {looks.length < MAX_REEL_LOOKS && (
              <button
                type="button"
                onClick={() => outfitInput.current?.click()}
                disabled={uploading}
                className="flex aspect-[3/4] flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-primary/30 bg-pastel-lavender/40 text-sm font-semibold text-primary hover:bg-primary/5"
                data-testid="reel-add-outfits"
              >
                {uploading ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <ImagePlus className="h-5 w-5" />
                )}
                Add outfits
              </button>
            )}
          </div>
          {looks.length > 0 && (
            <Button
              variant="outline"
              onClick={() => void dressAll()}
              disabled={anyPending || looks.every((look) => look.dressed)}
              data-testid="reel-dress-all"
            >
              <Wand2 className="mr-2 h-4 w-4" /> Dress the model in all looks
            </Button>
          )}
        </div>

        {/* Music */}
        <div className="space-y-2">
          <h2 className="flex items-center gap-1 font-semibold">
            <Music2 className="h-4 w-4" /> Music
          </h2>
          <input
            ref={musicInput}
            type="file"
            accept="audio/*"
            className="hidden"
            onChange={(e) => void pickMusic(e.target.files?.[0])}
            data-testid="reel-music-input"
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              onClick={() => musicInput.current?.click()}
              disabled={analyzing}
            >
              {analyzing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {music ? "Change track" : "Upload a track"}
            </Button>
            {music && (
              <span className="text-sm" data-testid="reel-music-info">
                {music.name}
                {music.beat
                  ? ` · ${Math.round(music.beat.bpm)} BPM · cuts on the beat`
                  : " · even cuts"}
              </span>
            )}
          </div>
          {!music && (
            <p className="text-xs text-muted-foreground">
              Add a track to cut every look on its beat.
            </p>
          )}
        </div>

        {/* Motion */}
        <div className="space-y-2">
          <Label htmlFor="reel-motion" className="font-semibold">
            How the model moves
          </Label>
          <Textarea
            id="reel-motion"
            rows={2}
            value={motion}
            onChange={(e) => updateReel({ motion: e.target.value })}
            className="rounded-2xl"
            data-testid="reel-motion"
          />
        </div>

        <div className="grid gap-5 sm:grid-cols-3">
          <div className="space-y-2">
            <span className="text-sm font-semibold text-muted-foreground">
              Reel type
            </span>
            <div className="flex flex-wrap gap-2">
              <Chip
                active={style === "video"}
                onClick={() => updateReel({ style: "video" })}
                testId="reel-style-video"
              >
                Video
              </Chip>
              <Chip
                active={style === "photo"}
                onClick={() => updateReel({ style: "photo" })}
                testId="reel-style-photo"
              >
                Photo
              </Chip>
            </div>
          </div>
          <div className="space-y-2">
            <span className="text-sm font-semibold text-muted-foreground">
              Per look
            </span>
            {music?.beat ? (
              <div className="flex flex-wrap gap-2">
                {[1, 2, 3].map((b) => (
                  <Chip
                    key={b}
                    active={bars === b}
                    onClick={() => updateReel({ bars: b })}
                    testId={`reel-bars-${b}`}
                  >
                    {`${b} bar${b > 1 ? "s" : ""}`}
                  </Chip>
                ))}
              </div>
            ) : (
              <p className="pt-2 text-sm font-semibold">
                {timing.onScreenSec}s
              </p>
            )}
          </div>
          <div className="space-y-2">
            <span className="text-sm font-semibold text-muted-foreground">
              Shape
            </span>
            <div className="flex flex-wrap gap-2">
              {SHAPES.map((s) => (
                <Chip key={s} active={shape === s} onClick={() => updateReel({ shape: s })}>
                  {s}
                </Chip>
              ))}
            </div>
          </div>
        </div>
      </section>

      <aside className="w-full flex-[1_1_300px] space-y-4 rounded-3xl border bg-card p-6 sm:max-w-sm">
        <h2 className="font-semibold">Your reel</h2>
        <dl className="grid grid-cols-2 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Looks</dt>
          <dd className="text-right font-semibold">{looks.length}</dd>
          <dt className="text-muted-foreground">Each look</dt>
          <dd className="text-right font-semibold">{timing.onScreenSec}s</dd>
          <dt className="text-muted-foreground">Total</dt>
          <dd className="text-right font-semibold" data-testid="reel-total">
            ~{totalSec}s
          </dd>
          <dt className="text-muted-foreground">Type</dt>
          <dd className="text-right font-semibold">
            {style === "video" ? "AI video" : "Photo motion"}
          </dd>
        </dl>
        <Button
          size="lg"
          className="h-14 w-full rounded-2xl text-base"
          onClick={onGenerate}
          disabled={
            !ready ||
            disabled ||
            starting ||
            (creditFunded && style === "video" && quote
              ? !quote.sufficient
              : false)
          }
          data-testid="reel-generate"
        >
          {starting ? (
            <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          ) : (
            <Sparkles className="mr-2 h-5 w-5" />
          )}
          Make the reel
          {creditFunded && style === "video" && quote && (
            <span className="ml-2 rounded-full bg-white/20 px-2 py-0.5 text-sm">
              {quote.credits.toLocaleString("en-IN")} credits
            </span>
          )}
        </Button>
        {!ready && (
          <p className="text-sm text-muted-foreground" data-testid="reel-hint">
            {looks.length < 2
              ? "Add at least 2 outfits."
              : "Dress the model in every look, then make the reel."}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {style === "video"
            ? "Each look is its own AI clip, joined on the beat."
            : "Photos move gently and change on the beat. Faster and cheaper."}
        </p>
      </aside>
    </div>
  );
}
