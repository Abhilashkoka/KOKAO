import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListVideoJobsQueryKey,
  getQuoteCreditsQueryKey,
  useGenerateImage,
  useGenerateVideo,
  searchMusicLibrary,
  useImportLibraryMusic,
  useQuoteCredits,
  useRequestUploadUrl,
  type MusicTrack,
} from "@workspace/api-client-react";
import {
  Clapperboard,
  ImagePlus,
  Images,
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
import { uploadErrorMessage, uploadToStorage } from "@/lib/upload-file";
import { refreshCreditBalanceSafely } from "@/lib/refresh-credit-balance";
import { trackProjectEvent } from "@/lib/analytics";
import { analyzeMusicFile, lookTiming } from "@/lib/beat";
import { WEAR_STYLES } from "@/lib/quick-create-presets";
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
/** Quick searches in the built-in, commercially licensed music library. */
const MUSIC_MOODS = [
  "Indian festive",
  "Bollywood dance",
  "Sitar",
  "Fashion runway",
  "Upbeat pop",
] as const;
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
  handoffFiles,
  onHandoffTaken,
}: {
  disabled: boolean;
  creditFunded: boolean;
  /** Outfit photos picked elsewhere on Create (several at once) to add as looks. */
  handoffFiles?: File[] | null;
  onHandoffTaken?: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const requestUploadUrl = useRequestUploadUrl();
  const generateImage = useGenerateImage();
  const generateVideo = useGenerateVideo();

  // State lives in the Create draft store, so it survives leaving the page.
  const { model, gender, wearStyle, looks, music, style, bars, shape, motion, starting } =
    useCreateDraft().reel;
  const [analyzing, setAnalyzing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const outfitInput = useRef<HTMLInputElement>(null);
  const modelInput = useRef<HTMLInputElement>(null);
  const musicInput = useRef<HTMLInputElement>(null);
  const importMusic = useImportLibraryMusic();
  const [mood, setMood] = useState<string | null>(null);
  const [tracks, setTracks] = useState<MusicTrack[]>([]);
  const [searching, setSearching] = useState(false);
  const [importingId, setImportingId] = useState<string | null>(null);
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
    const { objectPath } = await uploadToStorage(requestUploadUrl.mutateAsync, file);
    return {
      objectPath,
      previewUrl: URL.createObjectURL(file),
      name: file.name,
    };
  };
  const fail = (title: string) => (error: unknown) =>
    toast({
      title,
      description: uploadErrorMessage(error),
      variant: "destructive",
    });

  const addOutfits = async (files: FileList | File[] | null) => {
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

  // Photos handed over from the single-video form become looks here.
  const takenHandoff = useRef<File[] | null>(null);
  useEffect(() => {
    if (!handoffFiles?.length || takenHandoff.current === handoffFiles) return;
    takenHandoff.current = handoffFiles;
    onHandoffTaken?.();
    void addOutfits(handoffFiles);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoffFiles]);

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

  const searchMusic = async (query: string) => {
    setMood(query);
    setSearching(true);
    try {
      const result = await searchMusicLibrary({ q: query });
      setTracks((result?.tracks ?? []).slice(0, 6));
    } catch (error) {
      setTracks([]);
      fail("Music search failed")(error);
    } finally {
      setSearching(false);
    }
  };

  /** Copy a library track into this workspace and find its beat. */
  const chooseTrack = async (track: MusicTrack) => {
    setImportingId(track.id);
    try {
      const { musicPath } = await importMusic.mutateAsync({
        data: { audioUrl: track.audioUrl, title: track.title },
      });
      let beat = null;
      try {
        const res = await fetch(`/api/storage${musicPath}`);
        const blob = await res.blob();
        beat = await analyzeMusicFile(
          new File([blob], track.title, { type: blob.type || "audio/mpeg" }),
        );
      } catch {
        // No beat found: the reel still uses the track, with even cuts.
      }
      updateReel({ music: { objectPath: musicPath, name: track.title, beat } });
      setTracks([]);
      setMood(null);
    } catch (error) {
      fail("Could not use that track")(error);
    } finally {
      setImportingId(null);
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
          tryOn: {
            outfitImagePath: look.outfit.objectPath,
            modelImagePath: face,
            gender: getDraft().reel.gender,
            style: getDraft().reel.wearStyle,
          },
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

  const ready =
    looks.length >= 2 && looks.every((look) => look.dressed) && Boolean(music);
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
      enabled: creditFunded && looks.length >= 2,
      staleTime: 30_000,
    },
  });

  // Low balance: start on the Photo reel (Video stays visible with a top-up
  // note). Only once, and never after the user picked a type themselves.
  const styleTouched = useRef(false);
  const videoUnaffordable = creditFunded && Boolean(quote) && !quote!.sufficient;
  useEffect(() => {
    if (videoUnaffordable && style === "video" && !styleTouched.current) {
      styleTouched.current = true;
      updateReel({ style: "photo" });
    }
  }, [videoUnaffordable, style]);
  const pickStyle = (next: "video" | "photo") => {
    styleTouched.current = true;
    updateReel({ style: next });
  };

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
            modelGender: gender,
            wearStyle,
            prompt: `${motion.trim()}. No on-screen text, captions, logos or watermarks.`,
            durationSec: timing.clipSec,
            // The reel's sound is the chosen track only: per-clip AI audio
            // would change at every cut.
            generateAudio: false,
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
              <div className="flex items-center gap-2" role="radiogroup" aria-label="Who models it">
                {(
                  [
                    ["woman", "Woman"],
                    ["man", "Man"],
                  ] as const
                ).map(([value, label]) => (
                  <Chip
                    key={value}
                    active={gender === value}
                    onClick={() => {
                      if (gender === value) return;
                      // Without a model photo the dressed looks show the
                      // other gender, so they are dressed again.
                      updateReel((r) => ({
                        gender: value,
                        looks: r.model
                          ? r.looks
                          : r.looks.map((l) => ({ ...l, dressed: null })),
                      }));
                    }}
                    testId={`reel-gender-${value}`}
                  >
                    {label}
                  </Chip>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Kind of outfits">
                {WEAR_STYLES.map((w) => (
                  <Chip
                    key={w.id}
                    active={wearStyle === w.id}
                    onClick={() => {
                      if (wearStyle === w.id) return;
                      // The backdrop is part of each dressed photo, so a new
                      // style means the looks are dressed again.
                      updateReel((r) => ({
                        wearStyle: w.id,
                        looks: r.looks.map((l) => ({ ...l, dressed: null })),
                      }));
                    }}
                    testId={`reel-wear-${w.id}`}
                  >
                    {w.label}
                  </Chip>
                ))}
              </div>
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
          <div className="flex flex-wrap gap-2">
            {MUSIC_MOODS.map((m) => (
              <Chip
                key={m}
                active={mood === m}
                onClick={() => void searchMusic(m)}
                testId={`reel-mood-${m.toLowerCase().replace(/\s+/g, "-")}`}
              >
                {m}
              </Chip>
            ))}
            <Button
              variant="outline"
              size="sm"
              className="h-9 rounded-full"
              onClick={() => musicInput.current?.click()}
              disabled={analyzing}
            >
              {analyzing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Upload my own
            </Button>
          </div>
          {searching && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Finding tracks…
            </p>
          )}
          {!searching && tracks.length > 0 && (
            <ul className="space-y-2" data-testid="reel-tracks">
              {tracks.map((track) => (
                <li
                  key={track.id}
                  className="flex flex-wrap items-center gap-3 rounded-2xl border p-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{track.title}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {track.creator ? `${track.creator} · ` : ""}CC {track.license}
                      {track.durationSec ? ` · ${track.durationSec}s` : ""}
                    </p>
                  </div>
                  <audio
                    controls
                    preload="none"
                    src={track.audioUrl}
                    className="h-9 w-full sm:w-56"
                  />
                  <Button
                    size="sm"
                    onClick={() => void chooseTrack(track)}
                    disabled={importingId !== null}
                    data-testid={`reel-use-track-${track.id}`}
                  >
                    {importingId === track.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      "Use"
                    )}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {music ? (
            <div className="space-y-2 rounded-2xl bg-pastel-mint/40 p-3">
              <p className="text-sm font-semibold" data-testid="reel-music-info">
                {music.name}
                {music.beat
                  ? ` · ${Math.round(music.beat.bpm)} BPM · cuts on the beat`
                  : " · even cuts"}
              </p>
              <audio controls preload="none" src={previewOf(music)} className="h-9 w-full" />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Pick a mood for free, licence-safe music, or upload your own. Every look is
              cut on its beat.
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

        <div className="grid gap-5 sm:grid-cols-2">
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
        </dl>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Reel type">
          <button
            type="button"
            role="radio"
            aria-checked={style === "video"}
            onClick={() => pickStyle("video")}
            data-testid="reel-style-video"
            className={cn(
              "flex flex-col gap-1 rounded-2xl border p-3 text-left transition-colors",
              style === "video"
                ? "border-primary bg-pastel-lavender/60 ring-2 ring-primary/20"
                : "hover:bg-muted/60",
            )}
          >
            <span className="flex items-center gap-1 text-sm font-semibold">
              <Clapperboard className="h-4 w-4" /> Video reel
            </span>
            <span className="text-xs text-muted-foreground">She twirls, walks and turns</span>
            <span className="text-xs font-semibold" data-testid="reel-video-price">
              ~3 min
              {creditFunded && quote ? ` · ${quote.credits.toLocaleString("en-IN")} cr` : ""}
            </span>
            {videoUnaffordable && (
              <span className="text-xs font-semibold text-destructive">Top up to unlock</span>
            )}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={style === "photo"}
            onClick={() => pickStyle("photo")}
            data-testid="reel-style-photo"
            className={cn(
              "flex flex-col gap-1 rounded-2xl border p-3 text-left transition-colors",
              style === "photo"
                ? "border-primary bg-pastel-mint/60 ring-2 ring-primary/20"
                : "hover:bg-muted/60",
            )}
          >
            <span className="flex items-center gap-1 text-sm font-semibold">
              <Images className="h-4 w-4" /> Photo reel
            </span>
            <span className="text-xs text-muted-foreground">Looks glide in on the beat</span>
            <span className="text-xs font-semibold" data-testid="reel-photo-price">
              ~20 s · no video credits
            </span>
          </button>
        </div>
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
              : !looks.every((look) => look.dressed)
                ? "Dress the model in every look."
                : "Pick a music track, then make the reel."}
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
