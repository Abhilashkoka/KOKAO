import { useEffect, useMemo, useRef, useState } from "react";
import {
  useGenerateVideo,
  useGetMe,
  useBillingRequestUpgrade,
  useGetVideoJob,
  useListVideoJobs,
  useSaveVideoToLibrary,
  useUpdateVideoStoryboard,
  useInsertVideoStoryboardScene,
  useRegenerateStoryboardScenePreview,
  useApproveVideoStoryboard,
  useDiscardVideoStoryboard,
  useGetGoogleDriveStatus,
  useDisconnectGoogleDrive,
  useListGoogleDriveFiles,
  useImportGoogleDriveFiles,
  useRequestUploadUrl,
  useListContent,
  useListCharacters,
  useCreateCharacter,
  useDeleteCharacter,
  useCreateCharacterOutfit,
  useDeleteCharacterOutfit,
  useSearchMusicLibrary,
  useImportLibraryMusic,
  useGenerateHooks,
  useGetAiSpendRates,
  getGetAiSpendRatesQueryKey,
  useListBrandKits,
  useGetBrandKit,
  getGetBrandKitQueryKey,
  useListVideoStyles,
  useAnalyzeVideoStyle,
  useDeleteVideoStyle,
  getListVideoStylesQueryKey,
  getSearchMusicLibraryQueryKey,
  useWalletGetOverview,
  getWalletGetOverviewQueryKey,
  getGoogleDriveAuthUrl,
  getListVideoJobsQueryKey,
  getGetVideoJobQueryKey,
  getGetGoogleDriveStatusQueryKey,
  getListGoogleDriveFilesQueryKey,
  getListContentQueryKey,
  getListCharactersQueryKey,
  cancelVideoJob,
  type VideoJob,
  type VideoStoryboard,
  type VideoStoryboardScene,
  type GoogleDriveFile,
  type Character,
  type MusicTrack,
  type HookIdea,
  type VideoStyleProfile,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { RippleSpinner } from "@/components/ui/ripple-spinner";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import {
  Clapperboard,
  Download,
  Film,
  Image as ImageIcon,
  Images,
  Upload,
  X,
  Music,
  Save,
  Folder,
  HardDrive,
  ChevronLeft,
  Library,
  CheckCircle2,
  XCircle,
  Sparkles,
  Lightbulb,
  UserRound,
  Shirt,
  Trash2,
  Gauge,
  Plus,
  Braces,
  Copy,
  ScrollText,
} from "lucide-react";
import { navigate } from "wouter/use-browser-location";
import { SavedVisualPickerDialog } from "@/components/saved-visuals";
import { VoiceNoteButton } from "@/components/voice-note-button";
import { VIDEO_TOPIC_TEMPLATES } from "@/lib/viral-templates";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { useWalletBilling, ownerQuotaMessage, memberQuotaMessage, quotaToastTitle } from "@/lib/quotaCopy";
import { useFeatureFlags } from "@/lib/features";

type Engine = "text_to_video" | "image_to_video" | "slideshow" | "topic_to_video" | "lip_sync";
type Aspect = "16:9" | "9:16" | "1:1";
type Voice = "brand" | "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";

const VOICES: { value: Voice; label: string }[] = [
  { value: "brand", label: "Brand kit voice" },
  { value: "alloy", label: "Alloy · balanced" },
  { value: "nova", label: "Nova · bright" },
  { value: "shimmer", label: "Shimmer · warm" },
  { value: "echo", label: "Echo · deep" },
  { value: "onyx", label: "Onyx · bold" },
  { value: "fable", label: "Fable · storyteller" },
];

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
/** Reference-video uploads for style analysis. */
const REFERENCE_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"];
const MAX_REFERENCE_MB = 200;
const MUSIC_TYPES = ["audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/aac", "audio/wav"];
/** Lip-sync base videos (front-facing person, mouth clearly visible). */
const BASE_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"];
const MAX_BASE_VIDEO_MB = 100;
const MAX_PHOTOS = 20;

interface PickedPhoto {
  objectPath: string;
  /** Local object URL for fresh uploads; storage URL otherwise. */
  previewUrl: string;
  name: string;
}

function storageUrl(path: string): string {
  return `/api/storage${path}`;
}

/** Progress % from the job's REAL pipeline stage (reported by the server). */
const STAGE_PROGRESS: Record<string, number> = {
  "Getting started": 8,
  "Preparing your photos": 20,
  "Writing the script": 18,
  "Voicing the narration": 32,
  "Finding the right footage": 48,
  "Creating AI imagery": 48,
  "Filming your character": 48,
  "Sketching the storyboard": 55,
  "Saving the storyboard": 80,
  "Loading your storyboard": 12,
  "Animating your storyboard": 45,
  "Generating the video": 40,
  "Animating your image": 40,
  "Voicing your script": 30,
  "Syncing the lips": 60,
  "Composing the slideshow": 55,
  "Composing the video": 70,
  "Running quality checks": 88,
  "Saving to your library": 96,
};

function stageProgress(job: VideoJob): number {
  if (job.status === "queued") return 5;
  return STAGE_PROGRESS[job.stage ?? ""] ?? 60;
}

const ENGINE_META: Record<Engine, { title: string; blurb: string }> = {
  text_to_video: {
    title: "Text to Video",
    blurb: "Describe the clip and AI films it for you.",
  },
  image_to_video: {
    title: "Animate Photo",
    blurb: "Bring one photo to life with subtle AI motion.",
  },
  slideshow: {
    title: "Photo Slideshow",
    blurb: "Photos in, a polished video with crossfades out. No AI cost.",
  },
  topic_to_video: {
    title: "Topic to Video",
    blurb: "Give a topic — AI writes the script, narrates it, and cuts stock footage to match.",
  },
  lip_sync: {
    title: "Spokesperson",
    blurb:
      "Upload one video of yourself, type a script — AI speaks it (in your cloned brand voice when set up) and syncs your lips to match.",
  },
};

export function VideoStudioPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: me } = useGetMe();
  const requestUpgrade = useBillingRequestUpgrade();

  const [engine, setEngine] = useState<Engine>("text_to_video");
  const [prompt, setPrompt] = useState("");
  const [aspect, setAspect] = useState<Aspect>("9:16");
  const [durationSec, setDurationSec] = useState(5);
  const [slideDurationSec, setSlideDurationSec] = useState(3);
  const [overlayText, setOverlayText] = useState("");
  // "brand" = let the selected brand kit's voice (cloned or preset) narrate;
  // picking a named voice is an explicit override that always wins.
  const [voice, setVoice] = useState<Voice>("brand");
  const [stockSource, setStockSource] = useState<"auto" | "pexels" | "pixabay" | "wikimedia">(
    "auto",
  );
  const [paragraphCount, setParagraphCount] = useState(1);
  const [subtitles, setSubtitles] = useState(true);
  const [captionStyle, setCaptionStyle] = useState<"classic" | "dynamic">("dynamic");
  const [visuals, setVisuals] = useState<"stock" | "character" | "ai">("stock");
  /** Saved-plan reuse: a prior job's AI scene plan (editable JSON) that the
   * next topic video should follow instead of asking the model for a new one. */
  const [reusePlan, setReusePlan] = useState<{
    jobId: number;
    flow: "broll" | "character";
    planText: string;
  } | null>(null);
  const [planEditorOpen, setPlanEditorOpen] = useState(false);
  const [planDraft, setPlanDraft] = useState("");
  const [characterId, setCharacterId] = useState<number | null>(null);
  const [outfitId, setOutfitId] = useState<number | null>(null);
  const [wardrobeNotes, setWardrobeNotes] = useState("");
  const [charactersOpen, setCharactersOpen] = useState(false);
  const [photos, setPhotos] = useState<PickedPhoto[]>([]);
  const [music, setMusic] = useState<{ objectPath: string; name: string } | null>(null);
  const [baseVideo, setBaseVideo] = useState<{ objectPath: string; name: string } | null>(null);
  const [lipSyncConsent, setLipSyncConsent] = useState(false);
  const [musicPrompt, setMusicPrompt] = useState("");
  const [aiMusicDraft, setAiMusicDraft] = useState("");
  const [aiMusicOpen, setAiMusicOpen] = useState(false);
  const [musicLibraryOpen, setMusicLibraryOpen] = useState(false);
  const [clipMusic, setClipMusic] = useState(false);
  const [hooksOpen, setHooksOpen] = useState(false);
  const [hookIdeas, setHookIdeas] = useState<HookIdea[]>([]);
  const [brandKitId, setBrandKitId] = useState<number | null>(null);
  const [styleProfileId, setStyleProfileId] = useState<number | null>(null);
  const [stylesOpen, setStylesOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [reviewStoryboard, setReviewStoryboard] = useState(true);
  const [shotCount, setShotCount] = useState(1);
  const [activeJobId, setActiveJobId] = useState<number | null>(null);

  const [saveOpen, setSaveOpen] = useState(false);
  const [saveTitle, setSaveTitle] = useState("");
  const [saveCaption, setSaveCaption] = useState("");
  const [savePlatform, setSavePlatform] = useState("instagram");

  const [libraryOpen, setLibraryOpen] = useState(false);
  const [driveOpen, setDriveOpen] = useState(false);
  const [savedOpen, setSavedOpen] = useState(false);

  const photoInputRef = useRef<HTMLInputElement>(null);
  const musicInputRef = useRef<HTMLInputElement>(null);
  const baseVideoInputRef = useRef<HTMLInputElement>(null);

  const { flags } = useFeatureFlags();

  // "AI amount spent" display (kill-switch gated): admin-set per-video amount
  // with the platform fee already folded in, matching the caption/image line in
  // the Studio. Nothing renders while the rate is zero or the switch is off.
  const { data: aiSpendRates } = useGetAiSpendRates({
    query: {
      queryKey: getGetAiSpendRatesQueryKey(),
      staleTime: 60_000,
      enabled: flags.aiSpend,
    },
  });
  const videoSpendPaise = flags.aiSpend && aiSpendRates ? aiSpendRates.videoPaise : 0;

  const requestUploadUrl = useRequestUploadUrl();
  const generateVideo = useGenerateVideo();
  const generateHooks = useGenerateHooks();
  const saveToLibrary = useSaveVideoToLibrary();
  const { data: jobs } = useListVideoJobs({
    query: { queryKey: getListVideoJobsQueryKey() },
  });
  const { data: characters } = useListCharacters({
    query: { queryKey: getListCharactersQueryKey() },
  });
  const { data: brandKits } = useListBrandKits();
  // Saved lip-sync base videos live on the selected kit's active payload.
  const { data: lipSyncKit } = useGetBrandKit(brandKitId ?? 0, {
    query: {
      enabled: engine === "lip_sync" && brandKitId !== null,
      queryKey: getGetBrandKitQueryKey(brandKitId ?? 0),
    },
  });
  const savedBaseVideos =
    engine === "lip_sync" && brandKitId !== null
      ? (lipSyncKit?.activeVersion?.payload?.base_videos ?? [])
      : [];
  /** Which saved kit entry the current base video came from, if any. */
  const [savedVideoId, setSavedVideoId] = useState<string | null>(null);
  // A saved base video belongs to its kit: switching kits (or the entry
  // disappearing from the kit) must drop it so footage never pairs with the
  // wrong kit/voice.
  useEffect(() => {
    if (savedVideoId === null) return;
    const stillThere =
      brandKitId !== null &&
      (lipSyncKit === undefined || savedBaseVideos.some((v) => v.id === savedVideoId));
    if (!stillThere) {
      setSavedVideoId(null);
      setBaseVideo(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandKitId, savedVideoId, lipSyncKit]);
  const { data: styleProfiles } = useListVideoStyles({
    query: { queryKey: getListVideoStylesQueryKey(), enabled: flags.referenceStyles },
  });
  const activeCharacter = characters?.find((c) => c.id === characterId) ?? null;

  // Poll the active job until it settles; the server does the heavy lifting.
  const { data: activeJob } = useGetVideoJob(activeJobId ?? 0, {
    query: {
      queryKey: getGetVideoJobQueryKey(activeJobId ?? 0),
      enabled: activeJobId !== null,
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        return status === "queued" || status === "processing" ? 3000 : false;
      },
    },
  });

  // A storyboard waiting on the user survives a reload, but activeJobId does
  // not — so adopt the newest paused job on first load. Without this a plan the
  // user already paid for is invisible until they think to click its card, which
  // is exactly the "where is my storyboard?" trap.
  const adoptedRef = useRef(false);
  useEffect(() => {
    if (adoptedRef.current || activeJobId !== null || !jobs) return;
    const paused = jobs.find((job) => job.status === "awaiting_review");
    if (!paused) return;
    adoptedRef.current = true;
    setActiveJobId(paused.id);
  }, [jobs, activeJobId]);

  // Announce a finished storyboard once per job, and open it. Separate from
  // announcedRef so pausing for review does not consume the job's settle
  // announcement.
  const [boardOpen, setBoardOpen] = useState(false);
  const reviewAnnouncedRef = useRef<number | null>(null);
  useEffect(() => {
    if (!activeJob || activeJob.status !== "awaiting_review") return;
    if (reviewAnnouncedRef.current === activeJob.id) return;
    reviewAnnouncedRef.current = activeJob.id;
    setBoardOpen(true);
    toast({
      title: "Storyboard ready",
      description: "Edit any shot, then render it. Nothing else is charged until you do.",
    });
  }, [activeJob, toast]);

  // Announce settle exactly once per job.
  const announcedRef = useRef<number | null>(null);
  useEffect(() => {
    if (!activeJob || announcedRef.current === activeJob.id) return;
    if (activeJob.status === "succeeded") {
      announcedRef.current = activeJob.id;
      void queryClient.invalidateQueries({ queryKey: getListVideoJobsQueryKey() });
      toast({ title: "Video ready", description: "Preview it below, then save it to your library." });
    } else if (activeJob.status === "failed") {
      announcedRef.current = activeJob.id;
      void queryClient.invalidateQueries({ queryKey: getListVideoJobsQueryKey() });
      toast({
        title: "Video generation failed",
        description: activeJob.error ?? "Please try again.",
        variant: "destructive",
      });
    }
  }, [activeJob, queryClient, toast]);

  // Google Drive OAuth lands back here with ?drive=connected|error.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const drive = params.get("drive");
    if (!drive) return;
    if (drive === "connected") {
      toast({ title: "Google Drive connected", description: "Pick photos via 'From Google Drive'." });
      void queryClient.invalidateQueries({ queryKey: getGetGoogleDriveStatusQueryKey() });
    } else {
      toast({
        title: "Google Drive connection failed",
        description: params.get("reason") ?? undefined,
        variant: "destructive",
      });
    }
    params.delete("drive");
    params.delete("reason");
    const query = params.toString();
    window.history.replaceState(null, "", window.location.pathname + (query ? `?${query}` : ""));
  }, [queryClient, toast]);

  const uploadFile = async (file: File): Promise<string> => {
    const { uploadURL, objectPath } = await requestUploadUrl.mutateAsync({
      data: { name: file.name, size: file.size, contentType: file.type },
    });
    const put = await fetch(uploadURL, {
      method: "PUT",
      body: file,
      headers: { "Content-Type": file.type },
    });
    if (!put.ok) throw new Error(`Upload failed (${put.status})`);
    return objectPath;
  };

  const addPhotos = (picked: PickedPhoto[]) => {
    setPhotos((prev) => {
      const seen = new Set(prev.map((p) => p.objectPath));
      const fresh = picked.filter((p) => !seen.has(p.objectPath));
      return [...prev, ...fresh].slice(0, MAX_PHOTOS);
    });
  };

  const handlePhotoFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const accepted = [...files].filter((f) => IMAGE_TYPES.includes(f.type));
    if (accepted.length !== files.length) {
      toast({
        title: "Some files skipped",
        description: "Only PNG, JPEG, and WebP photos are supported.",
        variant: "destructive",
      });
    }
    const oversize = accepted.filter((f) => f.size > 10 * 1024 * 1024);
    if (oversize.length) {
      toast({ title: "Photo too large", description: "Photos must be under 10 MB.", variant: "destructive" });
    }
    const good = accepted.filter((f) => f.size <= 10 * 1024 * 1024);
    if (!good.length) return;
    setUploading(true);
    try {
      const uploaded: PickedPhoto[] = [];
      for (const file of good) {
        const objectPath = await uploadFile(file);
        uploaded.push({ objectPath, previewUrl: URL.createObjectURL(file), name: file.name });
      }
      addPhotos(uploaded);
    } catch {
      toast({ title: "Upload failed", description: "Could not upload photos. Please try again.", variant: "destructive" });
    } finally {
      setUploading(false);
      if (photoInputRef.current) photoInputRef.current.value = "";
    }
  };

  const handleBaseVideoFile = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (!BASE_VIDEO_TYPES.includes(file.type)) {
      toast({
        title: "Not a supported video file",
        description: "Use an MP4, MOV, or WebM video.",
        variant: "destructive",
      });
      return;
    }
    if (file.size > MAX_BASE_VIDEO_MB * 1024 * 1024) {
      toast({
        title: "Video too large",
        description: `The base video must be under ${MAX_BASE_VIDEO_MB} MB.`,
        variant: "destructive",
      });
      return;
    }
    setUploading(true);
    try {
      const objectPath = await uploadFile(file);
      setBaseVideo({ objectPath, name: file.name });
    } catch {
      toast({
        title: "Upload failed",
        description: "Could not upload the video. Please try again.",
        variant: "destructive",
      });
    } finally {
      setUploading(false);
      if (baseVideoInputRef.current) baseVideoInputRef.current.value = "";
    }
  };

  const handleMusicFile = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (!MUSIC_TYPES.includes(file.type)) {
      toast({ title: "Not a supported audio file", description: "Use MP3, M4A, AAC, or WAV.", variant: "destructive" });
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      toast({ title: "Track too large", description: "Music must be under 15 MB.", variant: "destructive" });
      return;
    }
    setUploading(true);
    try {
      const objectPath = await uploadFile(file);
      setMusic({ objectPath, name: file.name });
      setMusicPrompt("");
    } catch {
      toast({ title: "Upload failed", description: "Could not upload the track. Please try again.", variant: "destructive" });
    } finally {
      setUploading(false);
      if (musicInputRef.current) musicInputRef.current.value = "";
    }
  };

  const canGenerate = useMemo(() => {
    if (generateVideo.isPending || uploading) return false;
    if (engine === "topic_to_video") {
      if (visuals === "character" && characterId === null) return false;
      return prompt.trim().length >= 3;
    }
    if (engine === "text_to_video") return prompt.trim().length >= 3;
    if (engine === "lip_sync") {
      return prompt.trim().length >= 3 && baseVideo !== null && lipSyncConsent;
    }
    if (engine === "image_to_video") return photos.length >= 1;
    return photos.length >= 1;
  }, [
    engine,
    prompt,
    photos,
    generateVideo.isPending,
    uploading,
    visuals,
    characterId,
    baseVideo,
    lipSyncConsent,
  ]);

  const busy =
    activeJob != null &&
    activeJob.id === activeJobId &&
    (activeJob.status === "queued" || activeJob.status === "processing");

  // Live elapsed time while the job runs, anchored to the row's createdAt so
  // it survives a reload mid-generation.
  const [jobElapsed, setJobElapsed] = useState(0);
  useEffect(() => {
    if (!busy || !activeJob) {
      setJobElapsed(0);
      return;
    }
    const startedAt = new Date(activeJob.createdAt).getTime();
    const tick = () => setJobElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [busy, activeJob]);

  const [cancelling, setCancelling] = useState(false);
  const cancelRunningJob = async () => {
    if (!activeJob || cancelling) return;
    setCancelling(true);
    try {
      await cancelVideoJob(activeJob.id);
      setActiveJobId(null);
      void queryClient.invalidateQueries({ queryKey: getListVideoJobsQueryKey() });
      toast({
        title: "Video cancelled",
        description: "Nothing was charged — any reserved credit was returned.",
      });
    } catch (err) {
      const status = (err as { status?: number })?.status;
      toast({
        title: status === 409 ? "Too late to cancel" : "Couldn't cancel",
        description:
          status === 409
            ? "Generation already started, so it will finish normally."
            : "Something went wrong cancelling the job. It will finish normally.",
      });
    } finally {
      setCancelling(false);
    }
  };

  /** Whether this engine plans something worth looking at before it renders.
   * Stock topic footage is searched, not prompted, so there is nothing to edit. */
  const storyboardAvailable =
    engine !== "lip_sync" && (engine !== "topic_to_video" || visuals !== "stock");

  /** What the storyboard will show, per engine — the copy on the toggle. */
  const storyboardBlurb =
    engine === "slideshow"
      ? "See every photo with its own caption and length before the video is built."
      : engine === "image_to_video"
        ? "Check the photo and how long it animates for before anything is generated."
        : engine === "text_to_video"
          ? shotCount > 1
            ? "Read and reword every shot before any of them is generated."
            : "Read and reword the shot before it is generated."
          : "See every scene as a still, and reword any of them, before the video is filmed.";

  /** The active job is paused on an editable plan. Not "busy" (nothing is
   * running) but still unfinished, so it blocks starting another video. */
  const reviewing =
    activeJob != null &&
    activeJob.id === activeJobId &&
    activeJob.status === "awaiting_review" &&
    activeJob.storyboard != null;

  const isOwner = me?.team ? me.team.role === "owner" : true;
  // Wallet-billed (prepaid) workspaces get wallet-recharge quota copy instead
  // of upgrade / credit-pack advice they can't act on.
  const walletBilling = useWalletBilling();

  const onRequestUpgrade = () => {
    requestUpgrade.mutate(undefined, {
      onSuccess: () =>
        toast({
          title: "Request sent",
          description: "The workspace owner has been notified that you'd like an upgrade.",
        }),
      onError: (err: any) =>
        toast({
          title: "Could not send request",
          description: err?.message || "Please try again in a moment.",
          variant: "destructive",
        }),
    });
  };

  /** The visual style a saved plan was made for. */
  const reuseVisuals = reusePlan?.flow === "character" ? "character" : "ai";
  /** The saved plan rides along only when the form still matches it. */
  const reusePlanActive =
    reusePlan != null && engine === "topic_to_video" && visuals === reuseVisuals;

  /** Load a job's saved plan into the form, ready to generate with. */
  const startPlanReuse = (job: VideoJob) => {
    const aiPlan = job.storyboard?.aiPlan;
    if (!aiPlan) return;
    setEngine("topic_to_video");
    setVisuals(aiPlan.flow === "character" ? "character" : "ai");
    if (job.prompt) setPrompt(job.prompt);
    setReusePlan({
      jobId: job.id,
      flow: aiPlan.flow,
      planText: JSON.stringify(aiPlan.raw, null, 2),
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
    toast({
      title: "Saved plan loaded",
      description: "The next video will follow this plan. You can edit its JSON first.",
    });
  };

  const onGenerate = () => {
    // A reused plan is sent as the exact JSON shown in the editor; unparseable
    // edits stop here with a clear message instead of a failed job.
    let planSource: { jobId: number; plan: unknown } | null = null;
    if (reusePlanActive && reusePlan) {
      try {
        planSource = { jobId: reusePlan.jobId, plan: JSON.parse(reusePlan.planText) };
      } catch {
        toast({
          title: "The plan JSON is not valid",
          description: "Fix the edited plan (or remove it) and try again.",
          variant: "destructive",
        });
        return;
      }
    }
    generateVideo.mutate(
      {
        data: {
          engine,
          planSource,
          prompt: prompt.trim() || null,
          sourceImagePaths:
            engine === "text_to_video" || engine === "topic_to_video"
              ? []
              : engine === "image_to_video"
                ? photos.slice(0, 1).map((p) => p.objectPath)
                : photos.map((p) => p.objectPath),
          aspectRatio: aspect,
          durationSec,
          slideDurationSec,
          overlayText: engine === "slideshow" && overlayText.trim() ? overlayText.trim() : null,
          musicPath: musicEnabled ? (music?.objectPath ?? null) : null,
          musicPrompt: musicEnabled && !music && musicPrompt.trim() ? musicPrompt.trim() : null,
          // "brand" = no explicit choice: the server uses the selected brand
          // kit's voice (cloned or preset) and falls back to the default.
          voice: voice === "brand" ? undefined : voice,
          stockSource,
          subtitles,
          captionStyle,
          paragraphCount,
          visualsSource: engine === "topic_to_video" ? visuals : "stock",
          characterId:
            (engine === "topic_to_video" && visuals === "character") ||
            engine === "text_to_video"
              ? characterId
              : null,
          outfitId:
            (engine === "topic_to_video" && visuals === "character") ||
            engine === "text_to_video"
              ? outfitId
              : null,
          wardrobeNotes:
            engine === "topic_to_video" && visuals === "character" && wardrobeNotes.trim()
              ? wardrobeNotes.trim()
              : null,
          brandKitId:
            engine === "topic_to_video" || engine === "lip_sync" ? brandKitId : null,
          sourceVideoPath: engine === "lip_sync" ? (baseVideo?.objectPath ?? null) : null,
          lipSyncConsent: engine === "lip_sync" ? lipSyncConsent : false,
          styleProfileId: engine === "topic_to_video" ? styleProfileId : null,
          shotCount: engine === "text_to_video" ? shotCount : 1,
          // Every engine reviews except topic mode's stock branch, whose
          // visuals are searched rather than prompted.
          reviewStoryboard: storyboardAvailable ? reviewStoryboard : false,
        },
      },
      {
        onSuccess: (job) => {
          announcedRef.current = null;
          setActiveJobId(job.id);
          setReusePlan(null);
          void queryClient.invalidateQueries({ queryKey: getListVideoJobsQueryKey() });
        },
        onError: (error: any) => {
          if (error?.status === 402) {
            const canRequestUpgrade = !isOwner && flags.upgradeRequests;
            // Members can't upgrade the plan or buy credits, so never show
            // them the server's owner-directed advice — give them copy they
            // can act on (same behavior as the AI Studio's 402 handler).
            const memberDescription = memberQuotaMessage({
              walletBilling,
              canRequestUpgrade,
              quotaNoun: "video quota",
            });
            toast({
              title: quotaToastTitle(walletBilling, "Video quota reached"),
              description: isOwner
                ? ownerQuotaMessage({
                    walletBilling,
                    serverMessage: error?.message,
                    upgradeFallback: "Upgrade your plan or buy a credit pack.",
                  })
                : memberDescription,
              variant: "destructive",
              ...(canRequestUpgrade
                ? {
                    action: (
                      <ToastAction
                        altText="Ask the owner for an upgrade"
                        onClick={onRequestUpgrade}
                        data-testid="button-request-upgrade-toast"
                      >
                        Ask the owner for an upgrade
                      </ToastAction>
                    ),
                  }
                : {}),
            });
          } else {
            toast({
              title: "Could not start the video",
              description: error?.message || "Please try again.",
              variant: "destructive",
            });
          }
        },
      },
    );
  };

  const onSave = () => {
    if (!activeJob || !saveTitle.trim()) return;
    saveToLibrary.mutate(
      { jobId: activeJob.id, data: { title: saveTitle.trim(), caption: saveCaption, platform: savePlatform } },
      {
        onSuccess: () => {
          setSaveOpen(false);
          void queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
          toast({ title: "Saved to library", description: "Schedule or publish it from the Content Library." });
          navigate("/library");
        },
        onError: (error: any) =>
          toast({
            title: "Could not save",
            description: error?.message || "Please try again.",
            variant: "destructive",
          }),
      },
    );
  };

  const [downloading, setDownloading] = useState(false);
  const onDownload = async () => {
    if (!activeJob?.videoPath) return;
    const fileName = `kokao-video-${activeJob.id}.mp4`;
    setDownloading(true);
    try {
      const res = await fetch(storageUrl(activeJob.videoPath), { credentials: "include" });
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      // Blob download blocked or fetch failed — open the file in a new tab
      // with an attachment disposition so the browser saves it from there.
      const opened = window.open(
        `${storageUrl(activeJob.videoPath)}?download=${encodeURIComponent(fileName)}`,
        "_blank",
      );
      if (!opened) {
        toast({
          title: "Could not download",
          description: "Your browser blocked the download. Please try again.",
          variant: "destructive",
        });
      }
    } finally {
      setDownloading(false);
    }
  };

  const removePhoto = (objectPath: string) =>
    setPhotos((prev) => prev.filter((p) => p.objectPath !== objectPath));

  const needsPhotos = engine === "image_to_video" || engine === "slideshow";
  const meta = ENGINE_META[engine];
  const musicEnabled =
    engine === "slideshow" || engine === "topic_to_video" || clipMusic;

  // ---- Estimated wallet cost (wallet-billed workspaces only) ----
  // The wallet overview carries the per-unit video rate (fee included) and the
  // live balance; both are needed to price the configured video before the
  // 402 would.
  const { data: walletOverview } = useWalletGetOverview({
    query: { queryKey: getWalletGetOverviewQueryKey() },
  });

  /**
   * How many wallet units this configuration reserves — MUST mirror the
   * server's videoJobUnits (lib/videoGen/units.ts):
   * - text_to_video: one unit per shot (1..5)
   * - topic video with character visuals: 4 per paragraph (1..3 paragraphs)
   * - topic video with AI b-roll: 2 per paragraph
   * - everything else: 1
   * - +1 for an AI-composed music bed (only when no uploaded track wins)
   */
  const estimatedUnits = useMemo(() => {
    let units = 1;
    if (engine === "text_to_video") {
      units = Math.min(5, Math.max(1, Math.trunc(shotCount) || 1));
    } else if (engine === "topic_to_video" && visuals === "character") {
      units = 4 * Math.min(Math.max(Math.trunc(paragraphCount) || 1, 1), 3);
    } else if (engine === "topic_to_video" && visuals === "ai") {
      units = 2 * Math.min(Math.max(Math.trunc(paragraphCount) || 1, 1), 3);
    }
    if (musicEnabled && !music && musicPrompt.trim()) units += 1;
    return units;
  }, [engine, shotCount, visuals, paragraphCount, musicEnabled, music, musicPrompt]);

  const walletUnitPaise = walletOverview?.rates?.videoPaise ?? 0;
  const estimatedCostPaise = walletUnitPaise * estimatedUnits;
  // Nothing renders while the admin has not set a video rate (a 0 estimate is
  // meaningless) or the workspace is not wallet-billed.
  const showWalletEstimate =
    walletBilling && walletOverview != null && walletUnitPaise > 0;
  const walletShortfall =
    showWalletEstimate && estimatedCostPaise > (walletOverview?.balancePaise ?? 0);

  const rupees = (paise: number) =>
    (paise / 100).toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  const musicPicker = (
    <>
      {music ? (
        <div className="flex items-center gap-2 text-sm border border-border rounded-md px-3 py-2">
          <Music className="h-4 w-4 text-primary shrink-0" />
          <span className="truncate">{music.name}</span>
          <button type="button" aria-label="Remove music" onClick={() => setMusic(null)} className="ml-auto">
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : musicPrompt ? (
        <div
          className="flex items-center gap-2 text-sm border border-border rounded-md px-3 py-2"
          data-testid="chip-ai-music"
        >
          <Sparkles className="h-4 w-4 text-primary shrink-0" />
          <span className="truncate">AI: {musicPrompt}</span>
          <Badge variant="secondary" className="shrink-0">+1 unit</Badge>
          <button
            type="button"
            aria-label="Remove AI music"
            onClick={() => setMusicPrompt("")}
            className="ml-auto"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : aiMusicOpen ? (
        <div className="flex gap-2">
          <Input
            autoFocus
            placeholder="lofi chill beat, warm and mellow"
            maxLength={200}
            value={aiMusicDraft}
            onChange={(e) => setAiMusicDraft(e.target.value)}
            data-testid="input-ai-music"
          />
          <Button
            type="button"
            size="sm"
            disabled={!aiMusicDraft.trim()}
            onClick={() => {
              setMusicPrompt(aiMusicDraft.trim());
              setAiMusicOpen(false);
              setAiMusicDraft("");
            }}
            data-testid="button-set-ai-music"
          >
            Set
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={uploading}
            onClick={() => musicInputRef.current?.click()}
            data-testid="button-upload-music"
          >
            <Upload className="h-4 w-4 mr-1.5" /> Upload
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setMusicLibraryOpen(true)}
            data-testid="button-music-library"
          >
            <Library className="h-4 w-4 mr-1.5" /> Library
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setAiMusicOpen(true)}
            data-testid="button-ai-music"
          >
            <Sparkles className="h-4 w-4 mr-1.5" /> AI compose
          </Button>
        </div>
      )}
      <input
        ref={musicInputRef}
        type="file"
        accept={MUSIC_TYPES.join(",")}
        className="hidden"
        onChange={(e) => void handleMusicFile(e.target.files)}
      />
    </>
  );

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Clapperboard className="h-6 w-6 text-primary" /> Video Studio
        </h1>
        <p className="text-muted-foreground mt-1">
          Turn ideas and photos into scroll-stopping videos.
        </p>
      </div>

      <Tabs value={engine} onValueChange={(v) => setEngine(v as Engine)}>
        <TabsList
          className={`grid w-full grid-cols-2 ${flags.lipSync ? "sm:grid-cols-5" : "sm:grid-cols-4"}`}
        >
          <TabsTrigger value="text_to_video" data-testid="tab-text-to-video">
            <Sparkles className="h-4 w-4 mr-1.5" /> Text to Video
          </TabsTrigger>
          <TabsTrigger value="image_to_video" data-testid="tab-image-to-video">
            <ImageIcon className="h-4 w-4 mr-1.5" /> Animate Photo
          </TabsTrigger>
          <TabsTrigger value="slideshow" data-testid="tab-slideshow">
            <Images className="h-4 w-4 mr-1.5" /> Slideshow
          </TabsTrigger>
          <TabsTrigger value="topic_to_video" data-testid="tab-topic-to-video">
            <Lightbulb className="h-4 w-4 mr-1.5" /> Topic to Video
          </TabsTrigger>
          {flags.lipSync && (
            <TabsTrigger value="lip_sync" data-testid="tab-lip-sync">
              <UserRound className="h-4 w-4 mr-1.5" /> Spokesperson
            </TabsTrigger>
          )}
        </TabsList>
      </Tabs>

      <Card>
        <CardHeader>
          <CardTitle>{meta.title}</CardTitle>
          <CardDescription>{meta.blurb}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {engine !== "slideshow" && (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="video-prompt">
                  {engine === "text_to_video"
                    ? "Describe your video"
                    : engine === "topic_to_video"
                      ? "What's your video about?"
                      : engine === "lip_sync"
                        ? "What should you say?"
                        : "Motion hint (optional)"}
                </Label>
                <VoiceNoteButton
                  testId="button-voice-video-prompt"
                  onTranscript={(text) => setPrompt((prev) => (prev ? `${prev} ${text}` : text))}
                  disabled={generateVideo.isPending || busy}
                />
              </div>
              <Textarea
                id="video-prompt"
                data-testid="input-video-prompt"
                placeholder={
                  engine === "text_to_video"
                    ? "A steaming cup of chai on a rain-speckled window sill, cinematic close-up..."
                    : engine === "topic_to_video"
                      ? "5 morning habits that quietly transform your day..."
                      : engine === "lip_sync"
                        ? "Hey everyone! This week only, everything in our store is 20% off..."
                        : "Slow zoom in, gentle parallax..."
                }
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={3}
              />
              {engine === "topic_to_video" && flags.viralToolkit && (
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    value=""
                    onValueChange={(id) => {
                      const template = VIDEO_TOPIC_TEMPLATES.find((t) => t.id === id);
                      if (template) setPrompt(template.pattern);
                    }}
                  >
                    <SelectTrigger className="w-52" data-testid="select-topic-template">
                      <SelectValue placeholder="Start from a template" />
                    </SelectTrigger>
                    <SelectContent>
                      {VIDEO_TOPIC_TEMPLATES.map((template) => (
                        <SelectItem key={template.id} value={template.id}>
                          {template.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={prompt.trim().length < 4 || generateHooks.isPending}
                    onClick={() =>
                      generateHooks.mutate(
                        { data: { topic: prompt.trim().slice(0, 300) } },
                        {
                          onSuccess: (res) => {
                            setHookIdeas(res.hooks);
                            setHooksOpen(true);
                          },
                          onError: () =>
                            toast({
                              title: "Hook writing failed",
                              description: "Please try again in a moment.",
                              variant: "destructive",
                            }),
                        },
                      )
                    }
                    data-testid="button-hook-ideas"
                  >
                    {generateHooks.isPending ? (
                      <RippleSpinner className="mr-1.5 h-4 w-4" />
                    ) : (
                      <Lightbulb className="h-4 w-4 mr-1.5" />
                    )}
                    Hook ideas
                  </Button>
                </div>
              )}
            </div>
          )}

          {engine === "topic_to_video" && (
            <div className="space-y-3">
              <Label>Visuals</Label>
              <ToggleGroup
                type="single"
                variant="outline"
                value={visuals}
                onValueChange={(v) => v && setVisuals(v as "stock" | "character" | "ai")}
              >
                <ToggleGroupItem value="stock" data-testid="toggle-visuals-stock">
                  Stock footage
                </ToggleGroupItem>
                <ToggleGroupItem value="ai" data-testid="toggle-visuals-ai">
                  AI imagery
                </ToggleGroupItem>
                <ToggleGroupItem value="character" data-testid="toggle-visuals-character">
                  Your character
                </ToggleGroupItem>
              </ToggleGroup>
              {visuals === "ai" && (
                <p className="text-xs text-muted-foreground">
                  Every scene's visual is generated for your topic — fully owned,
                  no stock licensing. Costs 2 video units per paragraph.
                </p>
              )}
              {visuals === "character" && (
                <div className="space-y-3">
                  <CharacterPicker
                    characters={characters}
                    characterId={characterId}
                    outfitId={outfitId}
                    onCharacterChange={(id) => {
                      setCharacterId(id);
                      setOutfitId(null);
                    }}
                    onOutfitChange={setOutfitId}
                    onManage={() => setCharactersOpen(true)}
                  />
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <Label htmlFor="wardrobe-notes">Costume changes (optional)</Label>
                      <VoiceNoteButton
                        testId="button-voice-wardrobe-notes"
                        onTranscript={(text) =>
                          setWardrobeNotes((prev) => (prev ? `${prev} ${text}` : text))
                        }
                        disabled={generateVideo.isPending || busy}
                      />
                    </div>
                    <Input
                      id="wardrobe-notes"
                      data-testid="input-wardrobe-notes"
                      maxLength={500}
                      placeholder="Switch to gym wear for the workout scenes..."
                      value={wardrobeNotes}
                      onChange={(e) => setWardrobeNotes(e.target.value)}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Every scene is generated with your character — this video uses{" "}
                    {4 * paragraphCount} video units (one per scene).
                  </p>
                </div>
              )}

              {flags.brandVideo && (
              <div className="space-y-2">
                <Label htmlFor="brand-kit">Brand kit (optional)</Label>
                <Select
                  value={brandKitId === null ? "none" : String(brandKitId)}
                  onValueChange={(v) => setBrandKitId(v === "none" ? null : Number(v))}
                >
                  <SelectTrigger id="brand-kit" data-testid="select-brand-kit">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No branding</SelectItem>
                    {brandKits?.map((kit) => (
                      <SelectItem key={kit.id} value={String(kit.id)}>
                        {kit.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Writes the script in your brand voice, tints caption outlines with
                  your brand colour, and stamps your logo on every frame.
                </p>
              </div>
              )}

              {flags.referenceStyles && (
              <div className="space-y-2">
                <Label htmlFor="style-profile">Reference style (optional)</Label>
                <div className="flex gap-2">
                  <Select
                    value={styleProfileId === null ? "none" : String(styleProfileId)}
                    onValueChange={(v) => {
                      const id = v === "none" ? null : Number(v);
                      setStyleProfileId(id);
                      // Adopt the reference's caption treatment as a starting
                      // point; the switch above stays yours to change.
                      const picked = styleProfiles?.find((s) => s.id === id);
                      if (!picked) return;
                      if (picked.payload.captionStyle === "none") {
                        setSubtitles(false);
                      } else {
                        setSubtitles(true);
                        setCaptionStyle(picked.payload.captionStyle);
                      }
                    }}
                  >
                    <SelectTrigger id="style-profile" data-testid="select-style-profile">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No reference</SelectItem>
                      {styleProfiles?.map((s) => (
                        <SelectItem key={s.id} value={String(s.id)}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setStylesOpen(true)}
                    data-testid="button-manage-styles"
                  >
                    <Gauge className="h-4 w-4 mr-1.5" /> Styles
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Upload a video whose rhythm you like — its pacing, hook shape, and
                  caption treatment steer the script. Never its footage or wording.
                </p>
              </div>
              )}
            </div>
          )}

          {engine === "text_to_video" && (
            <CharacterPicker
              characters={characters}
              characterId={characterId}
              outfitId={outfitId}
              allowNone
              onCharacterChange={(id) => {
                setCharacterId(id);
                setOutfitId(null);
              }}
              onOutfitChange={setOutfitId}
              onManage={() => setCharactersOpen(true)}
            />
          )}

          {needsPhotos && (
            <div className="space-y-3">
              <Label>
                {engine === "image_to_video" ? "Photo to animate" : `Photos (up to ${MAX_PHOTOS}, in order)`}
              </Label>
              {photos.length > 0 && (
                <div className="flex flex-wrap gap-3">
                  {photos.map((photo) => (
                    <div key={photo.objectPath} className="relative group">
                      <img
                        src={photo.previewUrl}
                        alt={photo.name}
                        className="h-20 w-20 object-cover rounded-lg border border-border"
                      />
                      <button
                        type="button"
                        aria-label={`Remove ${photo.name}`}
                        onClick={() => removePhoto(photo.objectPath)}
                        className="absolute -top-2 -right-2 bg-background border border-border rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={uploading}
                  onClick={() => photoInputRef.current?.click()}
                  data-testid="button-upload-photos"
                >
                  <Upload className="h-4 w-4 mr-1.5" /> Upload
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setLibraryOpen(true)}
                  data-testid="button-pick-library"
                >
                  <Library className="h-4 w-4 mr-1.5" /> From Library
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setDriveOpen(true)}
                  data-testid="button-pick-drive"
                >
                  <HardDrive className="h-4 w-4 mr-1.5" /> From Google Drive
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setSavedOpen(true)}
                  data-testid="button-pick-saved"
                >
                  <Images className="h-4 w-4 mr-1.5" /> From saved
                </Button>
              </div>
              <input
                ref={photoInputRef}
                type="file"
                accept={IMAGE_TYPES.join(",")}
                multiple={engine === "slideshow"}
                className="hidden"
                onChange={(e) => void handlePhotoFiles(e.target.files)}
              />
            </div>
          )}

          {engine === "lip_sync" && (
            <div className="space-y-5">
              <div className="space-y-3">
                <Label>Base video</Label>
                {savedBaseVideos.length > 0 && (
                  <div className="space-y-1">
                    <Select
                      value={savedVideoId ?? ""}
                      onValueChange={(id) => {
                        const v = savedBaseVideos.find((x) => x.id === id);
                        if (!v) return;
                        setSavedVideoId(v.id);
                        setBaseVideo({ objectPath: v.video_path, name: v.label });
                        setVoice(
                          v.voice_mode === "cloned"
                            ? "brand"
                            : ((v.preset_voice as Voice) || "alloy"),
                        );
                      }}
                    >
                      <SelectTrigger className="w-64" data-testid="select-saved-base-video">
                        <SelectValue placeholder="Use a saved video from the brand kit" />
                      </SelectTrigger>
                      <SelectContent>
                        {savedBaseVideos.map((v) => (
                          <SelectItem key={v.id} value={v.id}>
                            {v.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      Picking a saved video also selects its default voice — you can
                      still change the voice below.
                    </p>
                  </div>
                )}
                {baseVideo ? (
                  <div className="flex items-center gap-2 text-sm border border-border rounded-md px-3 py-2">
                    <Film className="h-4 w-4 text-primary shrink-0" />
                    <span className="truncate" data-testid="text-base-video-name">
                      {baseVideo.name}
                    </span>
                    <button
                      type="button"
                      aria-label="Remove base video"
                      onClick={() => {
                        setBaseVideo(null);
                        setSavedVideoId(null);
                      }}
                      className="ml-auto"
                      data-testid="button-remove-base-video"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={uploading}
                    onClick={() => baseVideoInputRef.current?.click()}
                    data-testid="button-upload-base-video"
                  >
                    <Upload className="h-4 w-4 mr-1.5" /> Upload video
                  </Button>
                )}
                <input
                  ref={baseVideoInputRef}
                  type="file"
                  accept={BASE_VIDEO_TYPES.join(",")}
                  className="hidden"
                  onChange={(e) => void handleBaseVideoFile(e.target.files)}
                />
                <p className="text-xs text-muted-foreground">
                  A clip of one person facing the camera, mouth clearly visible. AI redraws the
                  mouth to speak your script — everything else stays as filmed. MP4, MOV, or
                  WebM, up to {MAX_BASE_VIDEO_MB} MB.
                </p>
              </div>

              <div className="flex flex-wrap items-end gap-5">
                <div className="space-y-2">
                  <Label>Voice</Label>
                  <Select value={voice} onValueChange={(v) => setVoice(v as Voice)}>
                    <SelectTrigger className="w-44" data-testid="select-lipsync-voice">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {VOICES.map((v) => (
                        <SelectItem key={v.value} value={v.value}>
                          {v.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Brand kit</Label>
                  <Select
                    value={brandKitId === null ? "none" : String(brandKitId)}
                    onValueChange={(v) => setBrandKitId(v === "none" ? null : Number(v))}
                  >
                    <SelectTrigger className="w-52" data-testid="select-lipsync-brand-kit">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No brand kit</SelectItem>
                      {brandKits?.map((kit) => (
                        <SelectItem key={kit.id} value={String(kit.id)}>
                          {kit.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Pick the brand kit whose cloned brand voice should speak — "Brand kit voice"
                above uses it automatically. No cloned voice set up? A stock voice narrates
                instead.
              </p>

              <label
                className="flex items-start gap-3 rounded-lg border border-border px-3 py-3 cursor-pointer"
                data-testid="label-lipsync-consent"
              >
                <Checkbox
                  checked={lipSyncConsent}
                  onCheckedChange={(checked) => setLipSyncConsent(checked === true)}
                  data-testid="checkbox-lipsync-consent"
                />
                <span className="text-sm text-muted-foreground">
                  This video shows me, or someone who gave me permission to use their likeness.
                  I understand the AI will make them appear to say my script.
                </span>
              </label>
            </div>
          )}

          <div className="flex flex-wrap items-end gap-5">
            {engine !== "lip_sync" && (
            <div className="space-y-2">
              <Label>Aspect ratio</Label>
              <ToggleGroup
                type="single"
                value={aspect}
                onValueChange={(v) => v && setAspect(v as Aspect)}
                variant="outline"
              >
                <ToggleGroupItem value="9:16" aria-label="Portrait 9:16">9:16</ToggleGroupItem>
                <ToggleGroupItem value="1:1" aria-label="Square 1:1">1:1</ToggleGroupItem>
                <ToggleGroupItem value="16:9" aria-label="Landscape 16:9">16:9</ToggleGroupItem>
              </ToggleGroup>
            </div>
            )}

            {engine === "text_to_video" || engine === "image_to_video" ? (
              <div className="space-y-2">
                <Label>Length</Label>
                <Select value={String(durationSec)} onValueChange={(v) => setDurationSec(Number(v))}>
                  <SelectTrigger className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="5">5 seconds</SelectItem>
                    <SelectItem value="8">8 seconds</SelectItem>
                    <SelectItem value="10">10 seconds</SelectItem>
                    <SelectItem value="15">15 seconds</SelectItem>
                    <SelectItem value="20">20 seconds</SelectItem>
                    <SelectItem value="30">30 seconds</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : engine === "topic_to_video" ? (
              <>
                <div className="space-y-2">
                  <Label>Length</Label>
                  <Select
                    value={String(paragraphCount)}
                    onValueChange={(v) => setParagraphCount(Number(v))}
                  >
                    <SelectTrigger className="w-36" data-testid="select-video-length">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">Short · ~30s</SelectItem>
                      <SelectItem value="2">Medium · ~60s</SelectItem>
                      <SelectItem value="3">Long · ~90s</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Voice</Label>
                  <Select value={voice} onValueChange={(v) => setVoice(v as Voice)}>
                    <SelectTrigger className="w-44" data-testid="select-video-voice">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {VOICES.map((v) => (
                        <SelectItem key={v.value} value={v.value}>
                          {v.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {visuals === "stock" && (
                  <div className="space-y-2">
                    <Label>Footage source</Label>
                    <Select
                      value={stockSource}
                      onValueChange={(v) => setStockSource(v as typeof stockSource)}
                    >
                      <SelectTrigger className="w-44" data-testid="select-stock-source">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">Auto</SelectItem>
                        <SelectItem value="pexels">Pexels</SelectItem>
                        <SelectItem value="pixabay">Pixabay</SelectItem>
                        {flags.archivalFootage && (
                          <SelectItem value="wikimedia">Commons (archival)</SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </>
            ) : (
              <div className="space-y-2">
                <Label>Seconds per photo</Label>
                <Select
                  value={String(slideDurationSec)}
                  onValueChange={(v) => setSlideDurationSec(Number(v))}
                >
                  <SelectTrigger className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[2, 3, 4, 5].map((s) => (
                      <SelectItem key={s} value={String(s)}>
                        {s} seconds
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {(engine === "slideshow" || engine === "topic_to_video") && (
            <div className="grid gap-4 sm:grid-cols-2">
              {engine === "slideshow" ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <Label htmlFor="overlay-text">Caption on video (optional)</Label>
                    <VoiceNoteButton
                      testId="button-voice-overlay-text"
                      onTranscript={(text) =>
                        setOverlayText((prev) => (prev ? `${prev} ${text}` : text))
                      }
                      disabled={generateVideo.isPending || busy}
                    />
                  </div>
                  <Input
                    id="overlay-text"
                    data-testid="input-overlay-text"
                    maxLength={120}
                    placeholder="Summer collection '26"
                    value={overlayText}
                    onChange={(e) => setOverlayText(e.target.value)}
                  />
                </div>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor="topic-subtitles">Subtitles</Label>
                  <div className="flex items-center gap-3 border border-border rounded-md px-3 py-2">
                    <Switch
                      id="topic-subtitles"
                      checked={subtitles}
                      onCheckedChange={setSubtitles}
                      data-testid="switch-subtitles"
                    />
                    <span className="text-sm text-muted-foreground">
                      Burn captions into the video
                    </span>
                  </div>
                  {subtitles && (
                    <Select
                      value={captionStyle}
                      onValueChange={(v) => setCaptionStyle(v as typeof captionStyle)}
                    >
                      <SelectTrigger className="w-full" data-testid="select-caption-style">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="dynamic">Dynamic — big word groups in sync</SelectItem>
                        <SelectItem value="classic">Classic — one sentence at a time</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                </div>
              )}
              <div className="space-y-2">
                <Label>Background music (optional)</Label>
                {musicPicker}
              </div>
            </div>
          )}

          {engine === "text_to_video" && (
            <div className="space-y-2">
              <Label htmlFor="shot-count">Shots</Label>
              <Select value={String(shotCount)} onValueChange={(v) => setShotCount(Number(v))}>
                <SelectTrigger id="shot-count" className="w-full" data-testid="select-shot-count">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <SelectItem key={n} value={String(n)} data-testid={`option-shots-${n}`}>
                      {n === 1 ? "1 shot — one continuous take" : `${n} shots — cut together`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground" data-testid="text-shot-cost">
                {shotCount === 1
                  ? "One clip, one video unit."
                  : `${shotCount} clips joined into one video — ${shotCount} video units.`}
              </p>
            </div>
          )}

          {reusePlan && engine === "topic_to_video" && (
            <div
              className={`flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 ${
                reusePlanActive ? "border-primary/50 bg-primary/5" : "border-amber-500/50 bg-amber-500/5"
              }`}
              data-testid="chip-reuse-plan"
            >
              <Braces className="h-4 w-4 shrink-0 text-primary" />
              <span className="text-sm flex-1 min-w-40">
                {reusePlanActive
                  ? `Following the saved plan from video #${reusePlan.jobId}.`
                  : `The saved plan from video #${reusePlan.jobId} needs the "${
                      reuseVisuals === "character" ? "Your character" : "AI imagery"
                    }" visual style — switch back or remove it.`}
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setPlanDraft(reusePlan.planText);
                  setPlanEditorOpen(true);
                }}
                data-testid="button-edit-reuse-plan"
              >
                Edit JSON
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setReusePlan(null)}
                aria-label="Remove the saved plan"
                data-testid="button-clear-reuse-plan"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          )}

          {storyboardAvailable && (
            <div className="space-y-2">
              <Label htmlFor="review-storyboard">Storyboard</Label>
              <div className="flex items-start gap-3 border border-border rounded-md px-3 py-2">
                <Switch
                  id="review-storyboard"
                  checked={reviewStoryboard}
                  onCheckedChange={setReviewStoryboard}
                  data-testid="switch-review-storyboard"
                />
                <span className="text-sm text-muted-foreground" data-testid="text-storyboard-blurb">
                  {storyboardBlurb} Free — nothing is generated twice.
                </span>
              </div>
            </div>
          )}

          {(engine === "text_to_video" || engine === "image_to_video") && (
            <div className="space-y-2">
              <Label htmlFor="clip-music">Background music</Label>
              <div className="flex items-center gap-3 border border-border rounded-md px-3 py-2">
                <Switch
                  id="clip-music"
                  checked={clipMusic}
                  onCheckedChange={(on) => {
                    setClipMusic(on);
                    if (!on) {
                      setMusic(null);
                      setMusicPrompt("");
                      setAiMusicOpen(false);
                      setAiMusicDraft("");
                    }
                  }}
                  data-testid="switch-clip-music"
                />
                <span className="text-sm text-muted-foreground">
                  Add a music bed to the clip
                </span>
              </div>
              {clipMusic && musicPicker}
            </div>
          )}

          {showWalletEstimate && (
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground" data-testid="text-wallet-estimate">
                Estimated wallet cost: {"\u20B9"}
                {rupees(estimatedCostPaise)}
                {estimatedUnits > 1 && (
                  <>
                    {" "}
                    ({estimatedUnits} generations {"\u00D7"} {"\u20B9"}
                    {rupees(walletUnitPaise)} each)
                  </>
                )}
                . Reserved up front, then settled to the actual cost.
              </p>
              {walletShortfall && (
                <p className="text-sm text-destructive" data-testid="text-wallet-estimate-shortfall">
                  Your wallet balance ({"\u20B9"}
                  {rupees(walletOverview?.balancePaise ?? 0)}) can't cover this estimate — recharge
                  your wallet before generating.
                </p>
              )}
            </div>
          )}

          <Button
            onClick={onGenerate}
            disabled={!canGenerate || busy || reviewing}
            className="w-full sm:w-auto"
            data-testid="button-generate-video"
          >
            {reviewing ? (
              <>
                <Clapperboard className="h-4 w-4 mr-2" /> Finish the storyboard below
              </>
            ) : generateVideo.isPending || busy ? (
              <>
                <RippleSpinner className="mr-2 h-4 w-4" /> Generating…
              </>
            ) : (
              <>
                <Film className="h-4 w-4 mr-2" /> Generate video
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {activeJob && (
        <Card data-testid="card-active-job">
          <CardContent className="pt-6 space-y-4">
            {busy && (
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <RippleSpinner className="h-5 w-5" />
                  <div>
                    <p className="font-medium" data-testid="text-job-stage">
                      {activeJob.status === "queued"
                        ? "Queued…"
                        : `${activeJob.stage ?? "Rendering your video"}…`}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {activeJob.engine === "slideshow"
                        ? "Stitching photos with crossfades."
                        : activeJob.engine === "topic_to_video"
                          ? "This can take a few minutes — the job keeps running if you leave."
                          : "AI video can take a few minutes. You can leave this page — the job keeps running."}
                    </p>
                  </div>
                </div>
                <Progress value={stageProgress(activeJob)} />
                {activeJob.aiPrompt && (
                  <details className="rounded-lg border border-border bg-muted/40 px-3 py-2">
                    <summary className="text-sm font-medium cursor-pointer select-none" data-testid="toggle-ai-prompt">
                      Prompt sent to the AI
                    </summary>
                    <p
                      className="mt-2 text-sm text-muted-foreground whitespace-pre-wrap"
                      data-testid="text-ai-prompt"
                    >
                      {activeJob.aiPrompt}
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      Your photo is sent along with this prompt, exactly as written — nothing is
                      added or rewritten. To change the result, edit your prompt and generate again.
                    </p>
                  </details>
                )}
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm text-muted-foreground" data-testid="text-video-job-elapsed">
                    {jobElapsed >= 60
                      ? `${Math.floor(jobElapsed / 60)}m ${jobElapsed % 60}s elapsed`
                      : `${jobElapsed}s elapsed`}
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={activeJob.status !== "queued" || cancelling}
                    title={
                      activeJob.status !== "queued"
                        ? "Generation already started and can no longer be cancelled."
                        : undefined
                    }
                    onClick={cancelRunningJob}
                    data-testid="button-cancel-video-job"
                  >
                    {cancelling ? (
                      <RippleSpinner className="mr-2 h-4 w-4" />
                    ) : (
                      <X className="mr-2 h-4 w-4" />
                    )}
                    Cancel
                  </Button>
                </div>
              </div>
            )}
            {reviewing && activeJob.storyboard && (
              <>
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex-1 min-w-48">
                    <p className="font-medium flex items-center gap-2">
                      <Clapperboard className="h-4 w-4 text-primary" />
                      Your storyboard is waiting
                    </p>
                    <p className="text-sm text-muted-foreground">
                      Nothing else is charged until you render it.
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    onClick={() => setBoardOpen(true)}
                    data-testid="button-open-storyboard"
                  >
                    Open storyboard
                  </Button>
                </div>
                <Dialog open={boardOpen} onOpenChange={setBoardOpen}>
                  <DialogContent className="sm:max-w-4xl max-h-[85vh] overflow-y-auto">
                    <DialogHeader>
                      {/* The review panel carries its own visible heading, so this
                          one only exists to name the dialog for screen readers. */}
                      <DialogTitle className="sr-only">Your storyboard</DialogTitle>
                    </DialogHeader>
                    <StoryboardReview job={activeJob} storyboard={activeJob.storyboard} />
                  </DialogContent>
                </Dialog>
              </>
            )}
            {activeJob.status === "succeeded" && activeJob.videoPath && (
              <div className="space-y-4">
                <video
                  controls
                  playsInline
                  preload="metadata"
                  poster={activeJob.thumbnailPath ? storageUrl(activeJob.thumbnailPath) : undefined}
                  src={storageUrl(activeJob.videoPath)}
                  className={`rounded-xl border border-border bg-black mx-auto max-h-[480px] ${
                    activeJob.aspectRatio === "16:9" ? "w-full" : ""
                  }`}
                  data-testid="video-preview"
                />
                {(flags.aiSpend
                  ? activeJob.spendPaise ??
                    (activeJob.chargedRatePaise ?? videoSpendPaise) *
                      Math.max(1, activeJob.units ?? 1)
                  : 0) > 0 && (
                  <p className="text-xs text-muted-foreground" data-testid="text-video-ai-spent">
                    AI amount spent: {"\u20B9"}
                    {/* Prefer the job's snapshotted TOTAL spend (real cost +
                        margin in cost_plus mode). Jobs without a snapshot fall
                        back to rate x units: the rate frozen at charge time,
                        or the current admin rate on legacy jobs. */}
                    {((activeJob.spendPaise ??
                      (activeJob.chargedRatePaise ?? videoSpendPaise) *
                        Math.max(1, activeJob.units ?? 1)) /
                      100).toLocaleString("en-IN", {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    onClick={() => {
                      setSaveTitle(activeJob.prompt?.slice(0, 60) || "New video");
                      setSaveOpen(true);
                    }}
                    data-testid="button-save-video"
                  >
                    <Save className="h-4 w-4 mr-2" /> Save to library
                  </Button>
                  {activeJob.engine === "topic_to_video" && activeJob.storyboard?.aiPlan && (
                    <Button
                      variant="outline"
                      onClick={() => startPlanReuse(activeJob)}
                      data-testid="button-reuse-plan"
                    >
                      <Braces className="h-4 w-4 mr-2" /> Reuse plan
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    onClick={() => void onDownload()}
                    disabled={downloading}
                    data-testid="button-download-video"
                  >
                    {downloading ? (
                      <>
                        <RippleSpinner className="mr-2 h-4 w-4" /> Downloading…
                      </>
                    ) : (
                      <>
                        <Download className="h-4 w-4 mr-2" /> Download
                      </>
                    )}
                  </Button>
                </div>
                {activeJob.engine === "text_to_video" && activeJob.storyboard && (
                  <FinalShotPrompts
                    scenes={activeJob.storyboard.scenes}
                    onUseAsBrief={(text) => {
                      setEngine("text_to_video");
                      setPrompt(text);
                      window.scrollTo({ top: 0, behavior: "smooth" });
                      toast({
                        title: "Brief prefilled",
                        description: "The polished prompt is in the Text to Video brief — tweak it and generate.",
                      });
                    }}
                  />
                )}
              </div>
            )}
            {activeJob.status === "failed" && (
              <div className="flex items-start gap-3 text-destructive">
                <XCircle className="h-5 w-5 mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium">Generation failed</p>
                  <p className="text-sm">{activeJob.error ?? "Please try again."}</p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {jobs && jobs.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">Recent videos</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {jobs.map((job: VideoJob) => (
              <button
                key={job.id}
                type="button"
                onClick={() => {
                  announcedRef.current = job.id;
                  setActiveJobId(job.id);
                }}
                className={`text-left rounded-xl border transition-colors overflow-hidden ${
                  job.id === activeJobId ? "border-primary" : "border-border hover:border-primary/50"
                }`}
                data-testid={`job-card-${job.id}`}
              >
                <div className="aspect-square bg-muted flex items-center justify-center overflow-hidden">
                  {job.thumbnailPath ? (
                    <img
                      src={storageUrl(job.thumbnailPath)}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <Film className="h-8 w-8 text-muted-foreground" />
                  )}
                </div>
                <div className="p-2.5 space-y-1">
                  <p className="text-xs font-medium truncate">
                    {job.prompt || ENGINE_META[job.engine as Engine]?.title || job.engine}
                  </p>
                  <Badge
                    variant={
                      job.status === "succeeded"
                        ? "secondary"
                        : job.status === "failed"
                          ? "destructive"
                          : "outline"
                    }
                  >
                    {job.status === "succeeded" && <CheckCircle2 className="h-3 w-3 mr-1" />}
                    {job.status}
                  </Badge>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      <Dialog open={planEditorOpen} onOpenChange={setPlanEditorOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit the saved plan (JSON)</DialogTitle>
            <DialogDescription>
              The next video follows this plan exactly. Consistency rules still apply — the
              character's costume stays locked and the shared look covers every scene.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={planDraft}
            onChange={(e) => setPlanDraft(e.target.value)}
            rows={16}
            className="font-mono text-xs"
            data-testid="input-plan-json"
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => setPlanEditorOpen(false)}
              data-testid="button-cancel-plan-json"
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                try {
                  JSON.parse(planDraft);
                } catch {
                  toast({
                    title: "Not valid JSON",
                    description: "Fix the syntax before saving the plan.",
                    variant: "destructive",
                  });
                  return;
                }
                setReusePlan((prev) => (prev ? { ...prev, planText: planDraft } : prev));
                setPlanEditorOpen(false);
              }}
              data-testid="button-save-plan-json"
            >
              Save plan
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save to Content Library</DialogTitle>
            <DialogDescription>
              The video becomes a draft you can schedule or publish.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="save-title">Title</Label>
              <Input
                id="save-title"
                data-testid="input-save-title"
                value={saveTitle}
                onChange={(e) => setSaveTitle(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="save-caption">Caption (optional)</Label>
                <VoiceNoteButton
                  testId="button-voice-save-caption"
                  onTranscript={(text) =>
                    setSaveCaption((prev) => (prev ? `${prev} ${text}` : text))
                  }
                  disabled={saveToLibrary.isPending}
                />
              </div>
              <Textarea
                id="save-caption"
                value={saveCaption}
                onChange={(e) => setSaveCaption(e.target.value)}
                rows={3}
              />
            </div>
            <div className="space-y-2">
              <Label>Platform</Label>
              <Select value={savePlatform} onValueChange={setSavePlatform}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="instagram">Instagram</SelectItem>
                  <SelectItem value="facebook">Facebook</SelectItem>
                  <SelectItem value="linkedin">LinkedIn</SelectItem>
                  <SelectItem value="twitter">X (Twitter)</SelectItem>
                  <SelectItem value="threads">Threads</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={onSave}
              disabled={!saveTitle.trim() || saveToLibrary.isPending}
              data-testid="button-confirm-save"
            >
              {saveToLibrary.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <LibraryPickerDialog
        open={libraryOpen}
        onOpenChange={setLibraryOpen}
        single={engine === "image_to_video"}
        onPick={(picked) => {
          if (engine === "image_to_video") setPhotos(picked.slice(0, 1));
          else addPhotos(picked);
          setLibraryOpen(false);
        }}
      />

      <GoogleDrivePickerDialog
        open={driveOpen}
        onOpenChange={setDriveOpen}
        single={engine === "image_to_video"}
        onImported={(picked) => {
          if (engine === "image_to_video") setPhotos(picked.slice(0, 1));
          else addPhotos(picked);
          setDriveOpen(false);
        }}
      />

      <SavedVisualPickerDialog
        open={savedOpen}
        onOpenChange={setSavedOpen}
        onPick={(imagePath, name) => {
          const picked = [{ objectPath: imagePath, previewUrl: `/api/storage${imagePath}`, name }];
          if (engine === "image_to_video") setPhotos(picked);
          else addPhotos(picked);
        }}
      />

      <CharacterManagerDialog open={charactersOpen} onOpenChange={setCharactersOpen} />

      <ReferenceStyleDialog
        open={stylesOpen}
        onOpenChange={setStylesOpen}
        onAnalyzed={(id) => setStyleProfileId(id)}
        onDeleted={(id) => setStyleProfileId((current) => (current === id ? null : current))}
      />

      <MusicLibraryDialog
        open={musicLibraryOpen}
        onOpenChange={setMusicLibraryOpen}
        onPick={(musicPath, title) => {
          setMusic({ objectPath: musicPath, name: title });
          setMusicPrompt("");
          setMusicLibraryOpen(false);
        }}
      />

      <Dialog open={hooksOpen} onOpenChange={setHooksOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Hook ideas</DialogTitle>
            <DialogDescription>
              Five ways to open the video — pick one and the script will start with it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {hookIdeas.map((hook, i) => (
              <button
                key={i}
                type="button"
                className="w-full text-left border border-border rounded-md px-3 py-2 hover:border-primary transition-colors"
                onClick={() => {
                  const base = prompt.replace(/ — open with this hook:.*$/s, "").trim();
                  setPrompt(`${base} — open with this hook: "${hook.text}"`);
                  setHooksOpen(false);
                }}
                data-testid={`button-use-hook-${i}`}
              >
                <Badge variant="secondary" className="mb-1 lowercase">
                  {hook.style}
                </Badge>
                <p className="text-sm">{hook.text}</p>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** A slide crossfade overlaps its two photos, so every join costs half a second
 * of the running total. Mirrors TRANSITION_SEC in the slideshow renderer. */
const SLIDE_CROSSFADE_SEC = 0.5;

/** Unsaved edits to one scene. Absent fields are untouched. */
type SceneDraft = { visual?: string; durationSec?: number; text?: string };

/**
 * What the finished video will run to. Mirrors the renderers: a recording wins
 * when there is one, slides lose half a second to every crossfade, and joined
 * clips simply add up.
 */
function storyboardTotalSec(storyboard: VideoStoryboard): number {
  if (storyboard.narration) return storyboard.narration.totalDurationSec;
  const sum = storyboard.scenes.reduce((total, scene) => total + scene.durationSec, 0);
  if (storyboard.visualsSource !== "slide") return sum;
  return Math.max(0, sum - Math.max(0, storyboard.scenes.length - 1) * SLIDE_CROSSFADE_SEC);
}

/**
 * The PATCH body for one scene, or null when nothing actually changed.
 *
 * On a slide plan `visual` is the caption burned over the photo, so emptying it
 * is a real edit. Everywhere else it is the generation prompt, and a prompt with
 * nothing in it has nothing to generate — there, blank means "leave it alone".
 */
function sceneEdit(
  scene: VideoStoryboardScene,
  draft: SceneDraft | undefined,
  slides: boolean,
  lengthEditable: boolean,
  narrated: boolean,
): SceneDraft | null {
  const edit: SceneDraft = {};
  const visual = draft?.visual?.trim();
  if (visual != null && visual !== scene.visual && (slides || visual.length > 0)) {
    edit.visual = visual;
  }
  if (lengthEditable && draft?.durationSec != null && draft.durationSec !== scene.durationSec) {
    edit.durationSec = draft.durationSec;
  }
  // Narration text: only on narrated boards, and never blanked — a scene with
  // no words has no length once the voiceover re-records.
  const text = draft?.text?.trim();
  if (narrated && text != null && text.length > 0 && text !== scene.text) {
    edit.text = text;
  }
  return Object.keys(edit).length > 0 ? edit : null;
}

/**
 * The storyboard review step. A paused job arrives with one planned shot per
 * beat; editing is free, re-rolling a preview is free but capped, and nothing
 * more is charged when the render finally runs.
 *
 * All five plan kinds land here and they differ in what is editable. Topic plans
 * are cut against a recording, so their text is narration and their lengths are
 * pinned to it; the other engines voice nothing, which is what frees the
 * timeline. Only generated stills can be redrawn — "photo" and "slide" previews
 * are the user's own uploads, and a "prompt" shot list has no still at all.
 */
/** Finished text_to_video jobs: the polished prompts the render actually used.
 * The approval pass (Prompt Kit video_scene_image) refines each approved shot
 * text into `renderVisual` before generating — showing both, clearly labeled,
 * lets the user see what really rendered and iterate on it. Renders nothing
 * when no polish was stored (older jobs, or plans rendered as approved). */
function FinalShotPrompts({
  scenes,
  onUseAsBrief,
}: {
  scenes: VideoStoryboardScene[];
  /** Prefill the text-to-video brief with this polished prompt. */
  onUseAsBrief: (text: string) => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const copyPrompt = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: "Prompt copied", description: "The polished prompt is on your clipboard." });
    } catch {
      toast({
        title: "Couldn't copy",
        description: "Clipboard access was blocked. Select the text and copy it manually.",
        variant: "destructive",
      });
    }
  };
  const polished = scenes
    .map((scene, i) => ({ scene, shot: i + 1 }))
    .filter(({ scene }) => (scene.renderVisual ?? "").trim().length > 0);
  if (polished.length === 0) return null;
  return (
    <div className="space-y-2" data-testid="final-shot-prompts">
      <p className="text-sm font-medium flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-primary" />
        Final shot prompts
      </p>
      <p className="text-xs text-muted-foreground">
        Your approved shot text was polished by AI into the exact prompt each shot rendered from.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {polished.map(({ scene, shot }) => (
          <div
            key={scene.id}
            className="rounded-lg border border-border bg-muted/30 p-3 space-y-2"
            data-testid={`final-prompt-scene-${scene.id}`}
          >
            <div className="flex items-center justify-between gap-2">
              <Badge variant="secondary">Shot {shot}</Badge>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setOpen((o) => ({ ...o, [scene.id]: !o[scene.id] }))}
                data-testid={`button-toggle-final-prompt-${scene.id}`}
              >
                {open[scene.id] ? "Hide final prompt" : "Show final prompt"}
              </Button>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Your approved text
              </p>
              <p className="text-xs whitespace-pre-wrap break-words">{scene.visual}</p>
            </div>
            {open[scene.id] && (
              <div data-testid={`text-final-prompt-${scene.id}`} className="space-y-2">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Final rendered prompt (AI-polished)
                </p>
                <p className="text-xs whitespace-pre-wrap break-words">{scene.renderVisual}</p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void copyPrompt(scene.renderVisual ?? "")}
                    data-testid={`button-copy-final-prompt-${scene.id}`}
                  >
                    <Copy className="h-3.5 w-3.5 mr-1.5" /> Copy
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onUseAsBrief(scene.renderVisual ?? "")}
                    data-testid={`button-use-final-prompt-${scene.id}`}
                  >
                    <Clapperboard className="h-3.5 w-3.5 mr-1.5" /> Use as new brief
                  </Button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
/**
 * The storyboard review step. A paused job arrives with one planned shot per
 * beat; editing is free, re-rolling a preview is free but capped, and nothing
 * more is charged when the render finally runs.
 *
 * All five plan kinds land here and they differ in what is editable. Topic plans
 * are cut against a recording, so their text is narration and their lengths are
 * pinned to it; the other engines voice nothing, which is what frees the
 * timeline. Only generated stills can be redrawn — "photo" and "slide" previews
 * are the user's own uploads, and a "prompt" shot list has no still at all.
 */
function StoryboardReview({
  job,
  storyboard,
}: {
  job: VideoJob;
  storyboard: VideoStoryboard;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  /** Local edits per scene, so typing doesn't round-trip on every keystroke. */
  const [drafts, setDrafts] = useState<Record<string, SceneDraft>>({});
  const [rollingScene, setRollingScene] = useState<string | null>(null);
  /** Add-scene dialog: closed, or where the new scene goes — after a scene id,
   * or "end". */
  const [addAfter, setAddAfter] = useState<string | null>(null);
  const [addText, setAddText] = useState("");
  const [addVisual, setAddVisual] = useState("");
  /** JSON details popup: null closed, "__plan__" for the whole plan, or a
   * scene id for that scene's record. */
  const [jsonFor, setJsonFor] = useState<string | null>(null);
  /** Full-script reading view: every scene expanded and readable at once. */
  const [scriptOpen, setScriptOpen] = useState(false);

  const update = useUpdateVideoStoryboard();
  const insertScene = useInsertVideoStoryboardScene();
  const regenerate = useRegenerateStoryboardScenePreview();
  const approve = useApproveVideoStoryboard();
  const discard = useDiscardVideoStoryboard();

  const settle = (updated: VideoJob) => {
    queryClient.setQueryData(getGetVideoJobQueryKey(job.id), updated);
    void queryClient.invalidateQueries({ queryKey: getListVideoJobsQueryKey() });
  };
  const fail = (title: string) => (error: unknown) =>
    toast({
      title,
      description: apiErrorMessage(error, "Please try again."),
      variant: "destructive",
    });

  const source = storyboard.visualsSource;
  /** Narrated (topic) boards: text is the script and re-records on render. */
  const narrated = storyboard.narration != null;
  /** Slide plans caption a photo rather than prompt for one. */
  const slides = source === "slide";
  /** Only generated stills can be redrawn; the rest are the user's own photos. */
  const drawn = source === "character" || source === "ai";
  /** A prompt plan is a shot list — there is no frame to show at all. */
  const framed = source !== "prompt";
  /** The range a length may be edited into. The server sends none when the
   * timeline is locked to a recording, and none on plans stored before lengths
   * were editable — either way there is nothing to offer. */
  const bounds = storyboard.durationBounds ?? null;
  /** Whole-second choices, so a length is picked rather than typed and parsed. */
  const lengths = bounds
    ? Array.from(
        { length: Math.max(1, Math.floor(bounds.maxSec) - Math.ceil(bounds.minSec) + 1) },
        (_, i) => Math.ceil(bounds.minSec) + i,
      )
    : [];

  const rollsLeft = Math.max(0, storyboard.scenes.length * 2 - storyboard.regenerations);
  const totalSec = Math.round(storyboardTotalSec(storyboard));
  const workingOn = update.isPending || approve.isPending || discard.isPending;
  const count = storyboard.scenes.length;

  /** What the JSON popup shows: one scene's stored record (plus its slice of
   * the AI's raw plan when it exists), or the whole plan. Read straight from
   * the storyboard the server keeps for the life of the job. */
  const jsonPayload = useMemo(() => {
    if (!jsonFor) return null;
    const aiPlan = storyboard.aiPlan ?? null;
    if (jsonFor === "__plan__") {
      return {
        title: "Scene plan (JSON)",
        data: {
          visualsSource: storyboard.visualsSource,
          model: storyboard.model,
          provider: storyboard.provider,
          scenes: storyboard.scenes,
          aiPlan,
        },
      };
    }
    const index = storyboard.scenes.findIndex((s) => s.id === jsonFor);
    const scene = storyboard.scenes[index];
    if (!scene) return null;
    const raw = aiPlan?.raw as
      | { prompts?: unknown[]; style?: unknown; scenes?: unknown[] }
      | null
      | undefined;
    const aiPlanForScene = aiPlan
      ? {
          flow: aiPlan.flow,
          capturedAt: aiPlan.capturedAt,
          ...(aiPlan.flow === "broll"
            ? { style: raw?.style ?? null, prompt: raw?.prompts?.[index] ?? null }
            : { scene: raw?.scenes?.[index] ?? null }),
        }
      : null;
    return {
      title: `Scene ${index + 1} details (JSON)`,
      data: { scene, aiPlan: aiPlanForScene },
    };
  }, [jsonFor, storyboard]);

  const copyJson = () => {
    if (!jsonPayload) return;
    void navigator.clipboard
      .writeText(JSON.stringify(jsonPayload.data, null, 2))
      .then(() => toast({ title: "Copied to clipboard" }))
      .catch(() => toast({ title: "Could not copy", variant: "destructive" }));
  };

  /** The whole script as plain text — what the reading view shows and copies.
   * Reads drafts first so unsaved edits are what gets reviewed. */
  const scriptText = storyboard.scenes
    .map((scene, i) => {
      const draft = drafts[scene.id];
      const said = (draft?.text ?? scene.text).trim();
      const shown = (draft?.visual ?? scene.visual).trim();
      const lines = [`Scene ${i + 1} · ${Math.round(draft?.durationSec ?? scene.durationSec)}s`];
      if (narrated && said) lines.push(`Narration: ${said}`);
      else if (said) lines.push(`Text: ${said}`);
      if (shown) lines.push(`${slides ? "Caption" : "Visual"}: ${shown}`);
      return lines.join("\n");
    })
    .join("\n\n");

  const copyScript = () => {
    void navigator.clipboard
      .writeText(scriptText)
      .then(() => toast({ title: "Script copied to clipboard" }))
      .catch(() => toast({ title: "Could not copy", variant: "destructive" }));
  };

  const blurb = storyboard.narration
    ? `${count} shots · ${totalSec}s narrated. Reword what's said or shown — the voiceover re-records to match when you render, and shot lengths follow it.`
    : slides
      ? `${count} ${count === 1 ? "photo" : "photos"} · about ${totalSec}s. Edit any caption and how long its photo holds, then render.`
      : source === "photo"
        ? `Your photo, about ${totalSec}s. Say what it should do and how long it animates, then render.`
        : `${count} ${count === 1 ? "shot" : "shots"} · about ${totalSec}s. Reword any shot${
            lengths.length > 1 ? " and how long it runs" : ""
          }, then render. Nothing is generated until you do.`;

  /** Push one scene's edits, then optionally re-roll its preview. */
  const saveScene = (scene: VideoStoryboardScene, thenRoll: boolean) => {
    const edit = sceneEdit(scene, drafts[scene.id], slides, lengths.length > 1, narrated);
    const roll = () => {
      if (!thenRoll) return;
      setRollingScene(scene.id);
      regenerate.mutate(
        { jobId: job.id, sceneId: scene.id },
        {
          onSuccess: settle,
          onError: fail("Could not redraw that shot"),
          onSettled: () => setRollingScene(null),
        },
      );
    };
    if (!edit) {
      roll();
      return;
    }
    update.mutate(
      { jobId: job.id, data: { scenes: [{ id: scene.id, ...edit }] } },
      {
        onSuccess: (updated) => {
          settle(updated);
          setDrafts((d) => {
            const { [scene.id]: _dropped, ...rest } = d;
            return rest;
          });
          roll();
        },
        onError: fail("Could not save that shot"),
      },
    );
  };

  /** Render, flushing every unsaved edit first. A prompt the user typed and then
   * watched get filmed without is the one outcome this whole step exists to
   * prevent, so Render never means "discard what is on screen". */
  const renderNow = () => {
    const scenes = storyboard.scenes.flatMap((scene) => {
      const edit = sceneEdit(scene, drafts[scene.id], slides, lengths.length > 1, narrated);
      return edit ? [{ id: scene.id, ...edit }] : [];
    });
    const start = () =>
      approve.mutate(
        { jobId: job.id },
        { onSuccess: settle, onError: fail("Could not start rendering") },
      );
    if (scenes.length === 0) {
      start();
      return;
    }
    update.mutate(
      { jobId: job.id, data: { scenes } },
      {
        onSuccess: (updated) => {
          settle(updated);
          setDrafts({});
          start();
        },
        onError: fail("Could not save your edits"),
      },
    );
  };

  return (
    <div className="space-y-4" data-testid="storyboard-review">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-medium flex items-center gap-2">
            <Clapperboard className="h-4 w-4 text-primary" />
            Your storyboard is ready
          </p>
          <p className="text-sm text-muted-foreground" data-testid="text-storyboard-summary">
            {blurb}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            title="Read the whole script in one readable view"
            onClick={() => setScriptOpen(true)}
            data-testid="button-read-script"
          >
            <ScrollText className="h-3.5 w-3.5 mr-1.5" />
            Read script
          </Button>
          <Button
            size="sm"
            variant="ghost"
            title="View the full scene plan as JSON"
            onClick={() => setJsonFor("__plan__")}
            data-testid="button-storyboard-json"
          >
            <Braces className="h-3.5 w-3.5 mr-1.5" />
            Plan JSON
          </Button>
          {drawn && (
            <Badge variant="secondary" data-testid="text-rolls-left">
              {rollsLeft} free redraws left
            </Badge>
          )}
        </div>
      </div>

      <Dialog open={jsonPayload != null} onOpenChange={(open) => !open && setJsonFor(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{jsonPayload?.title ?? "Details"}</DialogTitle>
            <DialogDescription>
              Stored with this video for auditing and later editing — it stays
              available after the video is rendered.
            </DialogDescription>
          </DialogHeader>
          <pre
            className="text-xs bg-muted/50 rounded-lg p-3 max-h-[50vh] overflow-auto whitespace-pre-wrap break-words"
            data-testid="text-scene-json"
          >
            {jsonPayload ? JSON.stringify(jsonPayload.data, null, 2) : ""}
          </pre>
          <DialogFooter>
            <Button variant="outline" onClick={copyJson} data-testid="button-copy-scene-json">
              <Copy className="h-3.5 w-3.5 mr-1.5" />
              Copy JSON
            </Button>
            <Button variant="ghost" onClick={() => setJsonFor(null)} data-testid="button-close-scene-json">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={scriptOpen} onOpenChange={setScriptOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Full script</DialogTitle>
            <DialogDescription>
              Every scene, expanded and readable — including edits you haven't saved yet.
              Review it here before you render.
            </DialogDescription>
          </DialogHeader>
          <div
            className="max-h-[60vh] overflow-y-auto space-y-4 pr-1"
            data-testid="text-full-script"
          >
            {storyboard.scenes.map((scene, i) => {
              const draft = drafts[scene.id];
              const said = (draft?.text ?? scene.text).trim();
              const shown = (draft?.visual ?? scene.visual).trim();
              return (
                <div
                  key={scene.id}
                  className="rounded-lg border border-border bg-muted/30 p-4 space-y-2"
                  data-testid={`script-scene-${scene.id}`}
                >
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">
                      Scene {i + 1} · {Math.round(draft?.durationSec ?? scene.durationSec)}s
                    </Badge>
                  </div>
                  {said && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                        {narrated ? "Narration" : "Text"}
                      </p>
                      <p className="text-sm leading-relaxed whitespace-pre-wrap">{said}</p>
                    </div>
                  )}
                  {shown && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                        {slides ? "Caption" : "Visual"}
                      </p>
                      <p className="text-sm leading-relaxed whitespace-pre-wrap">{shown}</p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={copyScript} data-testid="button-copy-script">
              <Copy className="h-3.5 w-3.5 mr-1.5" />
              Copy script
            </Button>
            <Button
              disabled={workingOn || rollingScene !== null}
              onClick={() => {
                setScriptOpen(false);
                renderNow();
              }}
              data-testid="button-render-from-script"
            >
              <Film className="h-4 w-4 mr-2" />
              Render this storyboard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {storyboard.scenes.map((scene, i) => {
          const draft = drafts[scene.id];
          const visual = draft?.visual ?? scene.visual;
          const seconds = Math.min(
            Math.max(Math.round(draft?.durationSec ?? scene.durationSec), lengths[0] ?? 0),
            lengths.at(-1) ?? 0,
          );
          const dirty = sceneEdit(scene, draft, slides, lengths.length > 1, narrated) !== null;
          const rolling = rollingScene === scene.id;
          return (
            <div
              key={scene.id}
              className="rounded-xl border border-border bg-muted/30 overflow-hidden flex flex-col"
              data-testid={`storyboard-scene-${scene.id}`}
            >
              {framed && (
                <div className="aspect-[3/4] bg-muted flex items-center justify-center overflow-hidden relative">
                  {scene.previewPath ? (
                    <img
                      src={storageUrl(scene.previewPath)}
                      alt={`Shot ${i + 1} preview`}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <ImageIcon className="h-8 w-8 text-muted-foreground" />
                  )}
                  {rolling && (
                    <div className="absolute inset-0 bg-background/70 flex items-center justify-center">
                      <RippleSpinner className="h-6 w-6" />
                    </div>
                  )}
                  <Badge className="absolute top-2 left-2" variant="secondary">
                    {i + 1} · {Math.round(scene.durationSec)}s
                  </Badge>
                </div>
              )}
              <div className="p-3 space-y-2 flex flex-col flex-1">
                {!framed && (
                  <Badge variant="secondary" className="self-start">
                    Shot {i + 1} · {Math.round(scene.durationSec)}s
                  </Badge>
                )}
                {narrated ? (
                  <>
                    <div className="flex items-center justify-between gap-2">
                      <Label
                        htmlFor={`narration-${scene.id}`}
                        className="text-xs text-muted-foreground"
                      >
                        What's said
                      </Label>
                      <VoiceNoteButton
                        testId={`button-voice-narration-${scene.id}`}
                        onTranscript={(text) =>
                          setDrafts((d) => {
                            const prev = d[scene.id]?.text ?? scene.text;
                            return {
                              ...d,
                              [scene.id]: {
                                ...d[scene.id],
                                text: prev ? `${prev} ${text}` : text,
                              },
                            };
                          })
                        }
                        disabled={rolling || workingOn}
                      />
                    </div>
                    <Textarea
                      id={`narration-${scene.id}`}
                      rows={2}
                      maxLength={600}
                      value={draft?.text ?? scene.text}
                      onChange={(e) =>
                        setDrafts((d) => ({
                          ...d,
                          [scene.id]: { ...d[scene.id], text: e.target.value },
                        }))
                      }
                      className="text-xs resize-none"
                      data-testid={`input-narration-${scene.id}`}
                    />
                  </>
                ) : (
                  scene.text.trim().length > 0 && (
                    <p className="text-xs text-muted-foreground line-clamp-3" title={scene.text}>
                      “{scene.text}”
                    </p>
                  )
                )}
                <div className="flex items-center justify-end gap-2">
                  <Label htmlFor={`shot-${scene.id}`} className="sr-only">
                    {slides
                      ? `Caption for photo ${i + 1}`
                      : source === "photo"
                        ? "What the photo should do"
                        : `What shot ${i + 1} shows`}
                  </Label>
                  <VoiceNoteButton
                    testId={`button-voice-shot-${scene.id}`}
                    onTranscript={(text) =>
                      setDrafts((d) => {
                        const prev = d[scene.id]?.visual ?? scene.visual;
                        return {
                          ...d,
                          [scene.id]: {
                            ...d[scene.id],
                            visual: prev ? `${prev} ${text}` : text,
                          },
                        };
                      })
                    }
                    disabled={rolling || workingOn}
                  />
                </div>
                <Textarea
                  id={`shot-${scene.id}`}
                  rows={3}
                  maxLength={1000}
                  value={visual}
                  placeholder={slides ? "No caption" : undefined}
                  onChange={(e) =>
                    setDrafts((d) => ({
                      ...d,
                      [scene.id]: { ...d[scene.id], visual: e.target.value },
                    }))
                  }
                  className="text-sm resize-none"
                  data-testid={`input-shot-${scene.id}`}
                />
                {lengths.length > 1 && (
                  <div className="flex items-center gap-2">
                    <Label
                      htmlFor={`length-${scene.id}`}
                      className="text-xs text-muted-foreground shrink-0"
                    >
                      {slides ? "Holds for" : "Runs for"}
                    </Label>
                    <Select
                      value={String(seconds)}
                      onValueChange={(v) =>
                        setDrafts((d) => ({
                          ...d,
                          [scene.id]: { ...d[scene.id], durationSec: Number(v) },
                        }))
                      }
                    >
                      <SelectTrigger
                        id={`length-${scene.id}`}
                        className="h-8 flex-1"
                        data-testid={`select-length-${scene.id}`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {lengths.map((n) => (
                          <SelectItem key={n} value={String(n)}>
                            {n}s
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div className="flex gap-2 mt-auto">
                  {drawn && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex-1"
                      disabled={rolling || workingOn || (rollsLeft === 0 && !dirty)}
                      onClick={() => saveScene(scene, true)}
                      data-testid={`button-redraw-${scene.id}`}
                    >
                      <Sparkles className="h-3.5 w-3.5 mr-1.5" />
                      {rolling ? "Redrawing…" : "Redraw"}
                    </Button>
                  )}
                  {dirty && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={rolling || workingOn}
                      onClick={() => saveScene(scene, false)}
                      data-testid={`button-save-shot-${scene.id}`}
                    >
                      Save
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    title="View this scene's details as JSON"
                    onClick={() => setJsonFor(scene.id)}
                    data-testid={`button-scene-json-${scene.id}`}
                  >
                    <Braces className="h-3.5 w-3.5" />
                  </Button>
                  {narrated && drawn && (
                    <Button
                      size="sm"
                      variant="ghost"
                      title="Add a scene after this one"
                      disabled={rolling || workingOn || insertScene.isPending}
                      onClick={() => {
                        setAddText("");
                        setAddVisual("");
                        setAddAfter(scene.id);
                      }}
                      data-testid={`button-add-after-${scene.id}`}
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {narrated && drawn && (
          <button
            type="button"
            className="rounded-xl border border-dashed border-border text-muted-foreground hover:text-foreground hover:border-foreground/40 flex flex-col items-center justify-center gap-2 min-h-32 p-4 text-sm"
            disabled={workingOn || insertScene.isPending}
            onClick={() => {
              setAddText("");
              setAddVisual("");
              setAddAfter("end");
            }}
            data-testid="button-add-scene-end"
          >
            <Plus className="h-5 w-5" />
            Add a scene at the end
            <span className="text-xs">Uses 1 video credit</span>
          </button>
        )}
      </div>

      <Dialog open={addAfter !== null} onOpenChange={(open) => !open && setAddAfter(null)}>
        <DialogContent data-testid="dialog-add-scene">
          <DialogHeader>
            <DialogTitle>Add a scene</DialogTitle>
            <DialogDescription>
              Uses 1 video credit. The voiceover re-records to include the new line when you
              render.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="add-scene-text">What's said</Label>
                <VoiceNoteButton
                  testId="button-voice-add-scene-text"
                  onTranscript={(text) =>
                    setAddText((prev) => (prev ? `${prev} ${text}` : text))
                  }
                  disabled={insertScene.isPending}
                />
              </div>
              <Textarea
                id="add-scene-text"
                rows={2}
                maxLength={600}
                value={addText}
                onChange={(e) => setAddText(e.target.value)}
                placeholder="The narration line this scene plays under"
                data-testid="input-add-scene-text"
              />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="add-scene-visual">What it shows (optional)</Label>
                <VoiceNoteButton
                  testId="button-voice-add-scene-visual"
                  onTranscript={(text) =>
                    setAddVisual((prev) => (prev ? `${prev} ${text}` : text))
                  }
                  disabled={insertScene.isPending}
                />
              </div>
              <Textarea
                id="add-scene-visual"
                rows={2}
                maxLength={1000}
                value={addVisual}
                onChange={(e) => setAddVisual(e.target.value)}
                placeholder="Defaults to the narration line"
                data-testid="input-add-scene-visual"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAddAfter(null)}>
              Cancel
            </Button>
            <Button
              disabled={addText.trim().length === 0 || insertScene.isPending}
              onClick={() =>
                insertScene.mutate(
                  {
                    jobId: job.id,
                    data: {
                      ...(addAfter !== "end" && addAfter !== null
                        ? { afterSceneId: addAfter }
                        : {}),
                      text: addText.trim(),
                      ...(addVisual.trim() ? { visual: addVisual.trim() } : {}),
                    },
                  },
                  {
                    onSuccess: (updated) => {
                      settle(updated);
                      setAddAfter(null);
                      toast({ title: "Scene added", description: "One video credit was used." });
                    },
                    onError: fail("Could not add that scene"),
                  },
                )
              }
              data-testid="button-confirm-add-scene"
            >
              {insertScene.isPending ? (
                <>
                  <RippleSpinner className="mr-2 h-4 w-4" /> Drawing it…
                </>
              ) : (
                "Add scene"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={workingOn || rollingScene !== null}
          onClick={renderNow}
          data-testid="button-approve-storyboard"
        >
          {approve.isPending ? (
            <>
              <RippleSpinner className="mr-2 h-4 w-4" /> Starting…
            </>
          ) : (
            <>
              <Film className="h-4 w-4 mr-2" /> Render this storyboard
            </>
          )}
        </Button>
        <Button
          variant="ghost"
          disabled={workingOn || rollingScene !== null}
          onClick={() =>
            discard.mutate(
              { jobId: job.id },
              {
                onSuccess: (updated) => {
                  settle(updated);
                  toast({
                    title: "Storyboard discarded",
                    description: "Nothing was charged.",
                  });
                },
                onError: fail("Could not discard it"),
              },
            )
          }
          data-testid="button-discard-storyboard"
        >
          <Trash2 className="h-4 w-4 mr-2" /> Discard
        </Button>
        <p className="text-xs text-muted-foreground">
          Unrendered storyboards are dropped after a day.
        </p>
      </div>
    </div>
  );
}

/** Search the built-in CC-licensed music library and import a pick. */
function MusicLibraryDialog({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (musicPath: string, title: string) => void;
}) {
  const { toast } = useToast();
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const importMusic = useImportLibraryMusic();
  const { data, isFetching } = useSearchMusicLibrary(
    { q: query },
    {
      query: {
        queryKey: getSearchMusicLibraryQueryKey({ q: query }),
        enabled: open && query.length >= 2,
      },
    },
  );
  const tracks: MusicTrack[] = data?.tracks ?? [];

  const pick = (track: MusicTrack) => {
    importMusic.mutate(
      { data: { audioUrl: track.audioUrl, title: track.title } },
      {
        onSuccess: (res) => onPick(res.musicPath, res.title),
        onError: () =>
          toast({
            title: "Import failed",
            description: "That track couldn't be imported. Try another one.",
            variant: "destructive",
          }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Music library</DialogTitle>
          <DialogDescription>
            Free Creative-Commons tracks, licensed for commercial use. The license travels
            with your pick.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(draft.trim());
          }}
        >
          <Input
            autoFocus
            placeholder="upbeat pop, lofi, cinematic…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            data-testid="input-music-search"
          />
          <Button type="submit" size="sm" disabled={draft.trim().length < 2}>
            Search
          </Button>
        </form>
        <div className="max-h-80 overflow-y-auto space-y-2">
          {isFetching && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
              <RippleSpinner className="h-4 w-4" /> Searching…
            </div>
          )}
          {!isFetching && query && tracks.length === 0 && (
            <p className="text-sm text-muted-foreground py-4">No tracks found — try another mood.</p>
          )}
          {tracks.map((track) => (
            <div
              key={track.id}
              className="border border-border rounded-md px-3 py-2 space-y-1.5"
              data-testid={`track-${track.id}`}
            >
              <div className="flex items-center gap-2 text-sm">
                <span className="truncate font-medium">{track.title}</span>
                {track.creator && (
                  <span className="text-muted-foreground truncate">· {track.creator}</span>
                )}
                <Badge variant="secondary" className="ml-auto shrink-0 uppercase">
                  {track.license}
                </Badge>
                {track.durationSec != null && (
                  <span className="text-xs text-muted-foreground shrink-0">
                    {Math.floor(track.durationSec / 60)}:
                    {String(track.durationSec % 60).padStart(2, "0")}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <audio controls preload="none" src={track.audioUrl} className="h-8 w-full" />
                <Button
                  type="button"
                  size="sm"
                  disabled={importMusic.isPending}
                  onClick={() => pick(track)}
                  data-testid={`button-pick-track-${track.id}`}
                >
                  Use
                </Button>
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Pick a locked character (and outfit) for identity-consistent videos. */
function CharacterPicker({
  characters,
  characterId,
  outfitId,
  allowNone = false,
  onCharacterChange,
  onOutfitChange,
  onManage,
}: {
  characters: Character[] | undefined;
  characterId: number | null;
  outfitId: number | null;
  allowNone?: boolean;
  onCharacterChange: (id: number | null) => void;
  onOutfitChange: (id: number | null) => void;
  onManage: () => void;
}) {
  const selected = characters?.find((c) => c.id === characterId) ?? null;
  if (!characters || characters.length === 0) {
    return (
      <div className="space-y-2">
        <Label>{allowNone ? "Character (optional)" : "Character"}</Label>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span>No characters yet — create one to lock the same face across videos.</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onManage}
            data-testid="button-manage-characters"
          >
            <UserRound className="h-4 w-4 mr-1.5" /> Create a character
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-end gap-4">
      <div className="space-y-2">
        <Label>{allowNone ? "Character (optional)" : "Character"}</Label>
        <Select
          value={characterId === null ? "none" : String(characterId)}
          onValueChange={(v) => onCharacterChange(v === "none" ? null : Number(v))}
        >
          <SelectTrigger className="w-44" data-testid="select-character">
            <SelectValue placeholder={allowNone ? "None" : "Pick a character"} />
          </SelectTrigger>
          <SelectContent>
            {allowNone && <SelectItem value="none">None</SelectItem>}
            {characters.map((c) => (
              <SelectItem key={c.id} value={String(c.id)}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {selected && selected.outfits.length > 0 && (
        <div className="space-y-2">
          <Label>Outfit</Label>
          <Select
            value={outfitId === null ? "default" : String(outfitId)}
            onValueChange={(v) => onOutfitChange(v === "default" ? null : Number(v))}
          >
            <SelectTrigger className="w-44" data-testid="select-outfit">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">
                {selected.outfits.find((o) => o.isDefault)?.name ?? "Default"} (default)
              </SelectItem>
              {selected.outfits
                .filter((o) => !o.isDefault)
                .map((o) => (
                  <SelectItem key={o.id} value={String(o.id)}>
                    {o.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onManage}
        data-testid="button-manage-characters"
      >
        <UserRound className="h-4 w-4 mr-1.5" /> Manage
      </Button>
    </div>
  );
}

/** Create and curate characters: references, outfits, deletions. */
function CharacterManagerDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  // Wallet-billed (prepaid) workspaces get wallet-recharge quota copy instead
  // of upgrade / credit-pack advice they can't act on.
  const walletBilling = useWalletBilling();
  const queryClient = useQueryClient();
  const requestUploadUrl = useRequestUploadUrl();
  const { data: characters } = useListCharacters({
    query: { queryKey: getListCharactersQueryKey(), enabled: open },
  });
  const createCharacter = useCreateCharacter();
  const deleteCharacter = useDeleteCharacter();
  const createOutfit = useCreateCharacterOutfit();
  const deleteOutfit = useDeleteCharacterOutfit();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [photoPath, setPhotoPath] = useState<string | null>(null);
  const [photoName, setPhotoName] = useState("");
  const [uploading, setUploading] = useState(false);
  const [outfitFor, setOutfitFor] = useState<number | null>(null);
  const [outfitName, setOutfitName] = useState("");
  const [outfitDescription, setOutfitDescription] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const photoRef = useRef<HTMLInputElement>(null);

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: getListCharactersQueryKey() });

  const onApiError = (error: any, fallbackTitle: string) => {
    if (error?.status === 402) {
      toast({
        title: quotaToastTitle(walletBilling, "Image quota reached"),
        description: ownerQuotaMessage({
          walletBilling,
          serverMessage: error?.message,
          upgradeFallback: "Character images fund like image generations.",
        }),
        variant: "destructive",
      });
    } else {
      toast({
        title: fallbackTitle,
        description: error?.message || "Please try again.",
        variant: "destructive",
      });
    }
  };

  const handlePhoto = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (!IMAGE_TYPES.includes(file.type)) {
      toast({
        title: "Not a supported image",
        description: "Use a PNG, JPEG, or WebP photo.",
        variant: "destructive",
      });
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast({ title: "Photo too large", description: "Photos must be under 10 MB.", variant: "destructive" });
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
      setPhotoPath(objectPath);
      setPhotoName(file.name);
    } catch {
      toast({ title: "Upload failed", description: "Please try again.", variant: "destructive" });
    } finally {
      setUploading(false);
      if (photoRef.current) photoRef.current.value = "";
    }
  };

  const onCreate = () => {
    createCharacter.mutate(
      {
        data: {
          name: name.trim(),
          description: description.trim() || null,
          sourceImagePath: photoPath,
        },
      },
      {
        onSuccess: () => {
          setName("");
          setDescription("");
          setPhotoPath(null);
          setPhotoName("");
          invalidate();
          toast({
            title: "Character created",
            description: "Pick them in Text to Video or Topic to Video to lock their identity.",
          });
        },
        onError: (error: any) => onApiError(error, "Could not create the character"),
      },
    );
  };

  const onAddOutfit = (characterId: number) => {
    createOutfit.mutate(
      {
        characterId,
        data: { name: outfitName.trim(), description: outfitDescription.trim() },
      },
      {
        onSuccess: () => {
          setOutfitFor(null);
          setOutfitName("");
          setOutfitDescription("");
          invalidate();
          toast({ title: "Outfit added", description: "Same character, new costume — ready to lock." });
        },
        onError: (error: any) => onApiError(error, "Could not add the outfit"),
      },
    );
  };

  const canCreate =
    name.trim().length >= 1 &&
    (description.trim().length >= 3 || photoPath !== null) &&
    !createCharacter.isPending &&
    !uploading;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Characters</DialogTitle>
          <DialogDescription>
            The same character, locked across every scene and video. Describe one and AI creates
            the reference, or upload a photo.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 border border-border rounded-lg p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="character-name">Name</Label>
              <Input
                id="character-name"
                data-testid="input-character-name"
                maxLength={80}
                placeholder="Maya"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Reference photo (optional)</Label>
              {photoPath ? (
                <div className="flex items-center gap-2 text-sm border border-border rounded-md px-3 py-2">
                  <ImageIcon className="h-4 w-4 text-primary shrink-0" />
                  <span className="truncate">{photoName}</span>
                  <button type="button" aria-label="Remove photo" onClick={() => setPhotoPath(null)} className="ml-auto">
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={uploading}
                  onClick={() => photoRef.current?.click()}
                  data-testid="button-upload-character-photo"
                >
                  <Upload className="h-4 w-4 mr-1.5" /> Upload
                </Button>
              )}
              <input
                ref={photoRef}
                type="file"
                accept={IMAGE_TYPES.join(",")}
                className="hidden"
                onChange={(e) => void handlePhoto(e.target.files)}
              />
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="character-description">Appearance</Label>
              <VoiceNoteButton
                testId="button-voice-character-description"
                onTranscript={(text) =>
                  setDescription((prev) => (prev ? `${prev} ${text}` : text))
                }
                disabled={uploading || createCharacter.isPending}
              />
            </div>
            <Textarea
              id="character-description"
              data-testid="input-character-description"
              rows={2}
              maxLength={1000}
              placeholder="A cheerful woman in her late 20s, shoulder-length black hair, warm brown eyes..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <Button
            onClick={onCreate}
            disabled={!canCreate}
            data-testid="button-create-character"
          >
            {createCharacter.isPending ? (
              <>
                <RippleSpinner className="mr-2 h-4 w-4" /> Creating…
              </>
            ) : (
              <>
                <UserRound className="h-4 w-4 mr-2" /> Create character
              </>
            )}
          </Button>
        </div>

        {characters && characters.length > 0 && (
          <div className="space-y-3">
            {characters.map((c) => (
              <div
                key={c.id}
                className="border border-border rounded-lg p-3 flex gap-3"
                data-testid={`character-card-${c.id}`}
              >
                <img
                  src={`/api/storage${c.referenceImagePath}`}
                  alt={c.name}
                  className="h-20 w-14 object-cover rounded-md border border-border shrink-0"
                />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex items-center gap-2">
                    <p className="font-medium truncate">{c.name}</p>
                    <button
                      type="button"
                      aria-label={`Delete ${c.name}`}
                      data-testid={`button-delete-character-${c.id}`}
                      className="ml-auto text-muted-foreground hover:text-destructive"
                      onClick={() => {
                        if (confirmDeleteId === c.id) {
                          deleteCharacter.mutate(
                            { characterId: c.id },
                            { onSuccess: invalidate },
                          );
                          setConfirmDeleteId(null);
                        } else {
                          setConfirmDeleteId(c.id);
                        }
                      }}
                    >
                      {confirmDeleteId === c.id ? (
                        <span className="text-xs text-destructive">Tap again to delete</span>
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {c.outfits.map((o) => (
                      <Badge key={o.id} variant={o.isDefault ? "secondary" : "outline"}>
                        <Shirt className="h-3 w-3 mr-1" />
                        {o.name}
                        {!o.isDefault && (
                          <button
                            type="button"
                            aria-label={`Remove outfit ${o.name}`}
                            className="ml-1"
                            onClick={() =>
                              deleteOutfit.mutate(
                                { characterId: c.id, outfitId: o.id },
                                { onSuccess: invalidate },
                              )
                            }
                          >
                            <X className="h-3 w-3" />
                          </button>
                        )}
                      </Badge>
                    ))}
                  </div>
                  {outfitFor === c.id ? (
                    <div className="space-y-2">
                      <Input
                        data-testid="input-outfit-name"
                        maxLength={80}
                        placeholder="Outfit name (Gym wear)"
                        value={outfitName}
                        onChange={(e) => setOutfitName(e.target.value)}
                      />
                      <Input
                        data-testid="input-outfit-description"
                        maxLength={500}
                        placeholder="Describe it: black leggings, teal sports top, white sneakers"
                        value={outfitDescription}
                        onChange={(e) => setOutfitDescription(e.target.value)}
                      />
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          disabled={
                            !outfitName.trim() ||
                            !outfitDescription.trim() ||
                            createOutfit.isPending
                          }
                          onClick={() => onAddOutfit(c.id)}
                          data-testid="button-save-outfit"
                        >
                          {createOutfit.isPending ? "Adding…" : "Add outfit"}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setOutfitFor(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setOutfitFor(c.id);
                        setOutfitName("");
                        setOutfitDescription("");
                      }}
                      data-testid={`button-add-outfit-${c.id}`}
                    >
                      <Shirt className="h-4 w-4 mr-1.5" /> Add outfit
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * "Make one like this": upload a reference video, analyze its structure once,
 * reuse the result as a style profile. Only the shape is stored — the reference
 * itself never appears in a generated video.
 */
function ReferenceStyleDialog({
  open,
  onOpenChange,
  onAnalyzed,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAnalyzed: (styleId: number) => void;
  onDeleted: (styleId: number) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const requestUploadUrl = useRequestUploadUrl();
  const { data: profiles } = useListVideoStyles({
    query: { queryKey: getListVideoStylesQueryKey(), enabled: open },
  });
  const analyzeStyle = useAnalyzeVideoStyle();
  const deleteStyle = useDeleteVideoStyle();

  const [name, setName] = useState("");
  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [videoName, setVideoName] = useState("");
  const [uploading, setUploading] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const videoRef = useRef<HTMLInputElement>(null);

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: getListVideoStylesQueryKey() });

  const handleVideo = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (!REFERENCE_VIDEO_TYPES.includes(file.type)) {
      toast({
        title: "Not a supported video",
        description: "Use an MP4, MOV, or WebM file.",
        variant: "destructive",
      });
      return;
    }
    if (file.size > MAX_REFERENCE_MB * 1024 * 1024) {
      toast({
        title: "Video too large",
        description: `Reference videos must be under ${MAX_REFERENCE_MB} MB.`,
        variant: "destructive",
      });
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
      setVideoPath(objectPath);
      setVideoName(file.name);
      if (!name.trim()) setName(file.name.replace(/\.[^.]+$/, "").slice(0, 80));
    } catch {
      toast({ title: "Upload failed", description: "Please try again.", variant: "destructive" });
    } finally {
      setUploading(false);
      if (videoRef.current) videoRef.current.value = "";
    }
  };

  const onAnalyze = () => {
    if (!videoPath) return;
    analyzeStyle.mutate(
      { data: { name: name.trim(), sourceVideoPath: videoPath } },
      {
        onSuccess: (profile) => {
          setName("");
          setVideoPath(null);
          setVideoName("");
          invalidate();
          onAnalyzed(profile.id);
          toast({
            title: "Style saved",
            description: `${profile.name} is now steering your topic videos.`,
          });
        },
        onError: (error: any) => {
          toast({
            title: error?.status === 402 ? "Caption quota reached" : "Could not analyze that video",
            description:
              error?.message ||
              "Analysis costs one caption unit. Try a shorter, clearer reference.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const canAnalyze = videoPath !== null && name.trim().length >= 1 && !analyzeStyle.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Reference styles</DialogTitle>
          <DialogDescription>
            Upload a video whose rhythm you want to borrow. We read its pacing, hook
            shape, and caption treatment — never its footage, audio, or wording — and
            save that as a reusable style. One caption unit per analysis.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 border border-border rounded-lg p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="style-name">Name</Label>
              <Input
                id="style-name"
                data-testid="input-style-name"
                maxLength={80}
                placeholder="Fast-cut explainer"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Reference video</Label>
              {videoPath ? (
                <div className="flex items-center gap-2 text-sm border border-border rounded-md px-3 py-2">
                  <Film className="h-4 w-4 text-primary shrink-0" />
                  <span className="truncate">{videoName}</span>
                  <button
                    type="button"
                    aria-label="Remove reference video"
                    onClick={() => setVideoPath(null)}
                    className="ml-auto"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={uploading}
                  onClick={() => videoRef.current?.click()}
                  data-testid="button-upload-reference"
                >
                  {uploading ? (
                    <>
                      <RippleSpinner className="mr-2 h-4 w-4" /> Uploading…
                    </>
                  ) : (
                    <>
                      <Upload className="h-4 w-4 mr-1.5" /> Upload video
                    </>
                  )}
                </Button>
              )}
              <input
                ref={videoRef}
                type="file"
                accept={REFERENCE_VIDEO_TYPES.join(",")}
                className="hidden"
                onChange={(e) => void handleVideo(e.target.files)}
              />
            </div>
          </div>
          <Button onClick={onAnalyze} disabled={!canAnalyze} data-testid="button-analyze-style">
            {analyzeStyle.isPending ? (
              <>
                <RippleSpinner className="mr-2 h-4 w-4" /> Reading the reference…
              </>
            ) : (
              <>
                <Gauge className="h-4 w-4 mr-2" /> Analyze style
              </>
            )}
          </Button>
          <p className="text-xs text-muted-foreground">
            We look at the first 3 minutes: the spoken pace, how many cuts, and how
            captions are handled.
          </p>
        </div>

        {profiles && profiles.length > 0 && (
          <div className="space-y-3">
            {profiles.map((profile) => (
              <div
                key={profile.id}
                className="border border-border rounded-lg p-3 space-y-2"
                data-testid={`style-card-${profile.id}`}
              >
                <div className="flex items-center gap-2">
                  <p className="font-medium truncate">{profile.name}</p>
                  <Badge variant="secondary">
                    {profile.payload.pacing.wordsPerMinute > 0
                      ? `${profile.payload.pacing.wordsPerMinute} wpm`
                      : "No narration"}
                  </Badge>
                  <Badge variant="outline">
                    {profile.payload.captionStyle === "none"
                      ? "No captions"
                      : `${profile.payload.captionStyle} captions`}
                  </Badge>
                  <button
                    type="button"
                    aria-label={`Delete ${profile.name}`}
                    data-testid={`button-delete-style-${profile.id}`}
                    className="ml-auto text-muted-foreground hover:text-destructive shrink-0"
                    onClick={() => {
                      if (confirmDeleteId === profile.id) {
                        deleteStyle.mutate(
                          { styleId: profile.id },
                          {
                            onSuccess: () => {
                              invalidate();
                              onDeleted(profile.id);
                            },
                          },
                        );
                        setConfirmDeleteId(null);
                      } else {
                        setConfirmDeleteId(profile.id);
                      }
                    }}
                  >
                    {confirmDeleteId === profile.id ? (
                      <span className="text-xs text-destructive">Tap again to delete</span>
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                  </button>
                </div>
                <p className="text-sm text-muted-foreground">{profile.payload.hookShape}</p>
                <p className="text-xs text-muted-foreground">
                  About {profile.payload.pacing.sceneCount} shots, ~
                  {profile.payload.pacing.avgSceneSec}s each · {profile.payload.energy}
                </p>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Pick previously generated/saved images from the content library. */
function LibraryPickerDialog({
  open,
  onOpenChange,
  single,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  single: boolean;
  onPick: (photos: PickedPhoto[]) => void;
}) {
  const { data: content, isLoading } = useListContent({
    query: { queryKey: getListContentQueryKey(), enabled: open },
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!open) setSelected(new Set());
  }, [open]);

  const images = (content ?? []).filter((item) => item.imagePath);

  const toggle = (path: string) => {
    setSelected((prev) => {
      if (single) return new Set(prev.has(path) ? [] : [path]);
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Pick from your library</DialogTitle>
          <DialogDescription>Images saved in your Content Library.</DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <div className="py-10 flex justify-center">
            <RippleSpinner className="h-6 w-6" />
          </div>
        ) : images.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No images in your library yet — generate some in AI Studio first.
          </p>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 max-h-[50vh] overflow-y-auto p-1">
            {images.map((item) => {
              const path = item.imagePath!;
              const isSelected = selected.has(path);
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => toggle(path)}
                  className={`relative rounded-lg overflow-hidden border-2 transition-colors ${
                    isSelected ? "border-primary" : "border-transparent hover:border-primary/40"
                  }`}
                >
                  <img
                    src={storageUrl(path)}
                    alt={item.title}
                    className="aspect-square object-cover w-full"
                  />
                  {isSelected && (
                    <CheckCircle2 className="absolute top-1.5 right-1.5 h-5 w-5 text-primary bg-background rounded-full" />
                  )}
                </button>
              );
            })}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={selected.size === 0}
            onClick={() =>
              onPick(
                [...selected].map((path) => ({
                  objectPath: path,
                  previewUrl: storageUrl(path),
                  name: path.split("/").pop() ?? "image",
                })),
              )
            }
          >
            Use {selected.size || ""} {selected.size === 1 ? "photo" : "photos"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Connect Google Drive, browse folders, and import selected photos. */
function GoogleDrivePickerDialog({
  open,
  onOpenChange,
  single,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  single: boolean;
  onImported: (photos: PickedPhoto[]) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: status, isLoading: statusLoading } = useGetGoogleDriveStatus({
    query: { queryKey: getGetGoogleDriveStatusQueryKey(), enabled: open },
  });
  const disconnect = useDisconnectGoogleDrive();
  const importFiles = useImportGoogleDriveFiles();

  // Folder navigation stack: [{id, name}]
  const [stack, setStack] = useState<{ id: string; name: string }[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [connecting, setConnecting] = useState(false);
  const folderId = stack[stack.length - 1]?.id;

  useEffect(() => {
    if (!open) {
      setStack([]);
      setSelected(new Set());
    }
  }, [open]);

  const connected = !!status?.connected;
  const { data: listing, isLoading: filesLoading } = useListGoogleDriveFiles(
    folderId ? { folderId } : {},
    {
      query: {
        queryKey: getListGoogleDriveFilesQueryKey(folderId ? { folderId } : {}),
        enabled: open && connected,
      },
    },
  );

  const onConnect = async () => {
    setConnecting(true);
    try {
      const { url } = await getGoogleDriveAuthUrl();
      window.location.assign(url);
    } catch (error: any) {
      setConnecting(false);
      toast({
        title: "Google Drive unavailable",
        description: error?.message || "Ask an administrator to configure Google credentials.",
        variant: "destructive",
      });
    }
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      if (single) return new Set(prev.has(id) ? [] : [id]);
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onImport = () => {
    importFiles.mutate(
      { data: { fileIds: [...selected] } },
      {
        onSuccess: (result) => {
          if (result.failed.length) {
            toast({
              title: `${result.failed.length} photo(s) skipped`,
              description: result.failed[0]?.reason,
              variant: "destructive",
            });
          }
          if (result.imported.length) {
            onImported(
              result.imported.map((f) => ({
                objectPath: f.objectPath,
                previewUrl: storageUrl(f.objectPath),
                name: f.name,
              })),
            );
            toast({
              title: "Photos imported",
              description: `${result.imported.length} photo(s) added from Google Drive.`,
            });
          }
        },
        onError: (error: any) =>
          toast({
            title: "Import failed",
            description: error?.message || "Please try again.",
            variant: "destructive",
          }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HardDrive className="h-5 w-5" /> Google Drive
          </DialogTitle>
          <DialogDescription>
            {connected
              ? `Connected as ${status?.accountName ?? "your Google account"}.`
              : "Connect your Google account to import photos."}
          </DialogDescription>
        </DialogHeader>

        {statusLoading ? (
          <div className="py-10 flex justify-center">
            <RippleSpinner className="h-6 w-6" />
          </div>
        ) : !connected ? (
          <div className="py-8 text-center space-y-4">
            <p className="text-sm text-muted-foreground max-w-sm mx-auto">
              {status?.configured
                ? status?.expired
                  ? "Your Google Drive access expired. Reconnect to continue."
                  : "KOKAO only gets read access to your Drive photos, and only imports what you pick."
                : "Google Drive is not configured yet. Ask an administrator to add Google credentials on the Admin page."}
            </p>
            <Button onClick={onConnect} disabled={!status?.configured || connecting} data-testid="button-connect-drive">
              {connecting ? "Redirecting…" : status?.expired ? "Reconnect Google Drive" : "Connect Google Drive"}
            </Button>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              {stack.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setStack((prev) => prev.slice(0, -1))}
                >
                  <ChevronLeft className="h-4 w-4" /> Back
                </Button>
              )}
              <span className="truncate">
                {stack.length ? stack.map((s) => s.name).join(" / ") : "My Drive"}
              </span>
            </div>
            {filesLoading ? (
              <div className="py-10 flex justify-center">
                <RippleSpinner className="h-6 w-6" />
              </div>
            ) : (
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 max-h-[45vh] overflow-y-auto p-1">
                {(listing?.files ?? []).map((file: GoogleDriveFile) =>
                  file.isFolder ? (
                    <button
                      key={file.id}
                      type="button"
                      onClick={() => setStack((prev) => [...prev, { id: file.id, name: file.name }])}
                      className="flex flex-col items-center justify-center gap-1.5 aspect-square rounded-lg border border-border hover:border-primary/40 transition-colors p-2"
                    >
                      <Folder className="h-7 w-7 text-primary/70" />
                      <span className="text-xs truncate w-full text-center">{file.name}</span>
                    </button>
                  ) : (
                    <button
                      key={file.id}
                      type="button"
                      onClick={() => toggle(file.id)}
                      className={`relative rounded-lg overflow-hidden border-2 transition-colors aspect-square bg-muted ${
                        selected.has(file.id)
                          ? "border-primary"
                          : "border-transparent hover:border-primary/40"
                      }`}
                    >
                      {file.thumbnailUrl ? (
                        <img
                          src={file.thumbnailUrl}
                          alt={file.name}
                          referrerPolicy="no-referrer"
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="h-full w-full flex items-center justify-center">
                          <ImageIcon className="h-6 w-6 text-muted-foreground" />
                        </div>
                      )}
                      {selected.has(file.id) && (
                        <CheckCircle2 className="absolute top-1.5 right-1.5 h-5 w-5 text-primary bg-background rounded-full" />
                      )}
                    </button>
                  ),
                )}
                {(listing?.files ?? []).length === 0 && (
                  <p className="col-span-full py-8 text-center text-sm text-muted-foreground">
                    No photos or folders here.
                  </p>
                )}
              </div>
            )}
          </>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          {connected ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() =>
                disconnect.mutate(undefined, {
                  onSuccess: () =>
                    void queryClient.invalidateQueries({
                      queryKey: getGetGoogleDriveStatusQueryKey(),
                    }),
                })
              }
            >
              Disconnect
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            {connected && (
              <Button
                disabled={selected.size === 0 || importFiles.isPending}
                onClick={onImport}
                data-testid="button-import-drive"
              >
                {importFiles.isPending
                  ? "Importing…"
                  : `Import ${selected.size || ""} ${selected.size === 1 ? "photo" : "photos"}`}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
