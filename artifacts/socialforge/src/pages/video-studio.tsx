import { useEffect, useMemo, useRef, useState } from "react";
import {
  useGenerateVideo,
  useRetryVideoJob,
  useRepairVideoJob,
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
  useGenerateSpokespersonScript,
  useLocalizeScript,
  useAnalyzeScriptIntake,
  useGetAiSpendRates,
  getGetAiSpendRatesQueryKey,
  useListBrandKits,
  useGetBrandKit,
  getGetBrandKitQueryKey,
  useListVideoMotionPresets,
  getListVideoMotionPresetsQueryKey,
  useListVideoCinematography,
  getListVideoCinematographyQueryKey,
  useListVideoModels,
  getListVideoModelsQueryKey,
  useListVideoStyles,
  useAnalyzeVideoStyle,
  useDeleteVideoStyle,
  useGetVideoCapabilities,
  getGetVideoCapabilitiesQueryKey,
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
  type VideoGenerateRequest,
  type VideoJob,
  type VideoStoryboard,
  type VideoStoryboardScene,
  type GoogleDriveFile,
  type Character,
  type MusicTrack,
  type HookIdea,
  type VideoStyleProfile,
  type ScriptVariant,
  type ScriptBeat,
  type ScriptMeta,
  type ScriptIntakeResult,
  type ScriptIntakeResultGapsItem,
  type VideoCapabilities,
  type VideoCostModel,
  type CharacterDialogueLocale,
  type BrandKit,
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
  SelectGroup,
  SelectItem,
  SelectLabel,
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
  RotateCcw,
  Wrench,
} from "lucide-react";
import { navigate } from "wouter/use-browser-location";
import { SavedVisualPickerDialog } from "@/components/saved-visuals";
import { VoiceNoteButton } from "@/components/voice-note-button";
import { VIDEO_TOPIC_TEMPLATES } from "@/lib/viral-templates";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { VIDEO_ASPECTS, type VideoAspect } from "@/lib/videoAspects";
import { useWalletBilling, ownerQuotaMessage, memberQuotaMessage, quotaToastTitle } from "@/lib/quotaCopy";
import { FeatureDisabledNotice, useFeatureFlags, type FeatureId } from "@/lib/features";

type Engine =
  | "text_to_video"
  | "image_to_video"
  | "slideshow"
  | "topic_to_video"
  | "lip_sync"
  | "dialogue_lip_sync";
type Aspect = VideoAspect;
type Voice = "brand" | "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";
type LipSyncQuality = "standard" | "high";
/**
 * The spokesperson flow. "type" and "clarify" are new: the first picks which
 * script rules apply, the second only appears when the intake pass found gaps
 * a human actually has to answer.
 */
type SpokespersonStep = "type" | "topic" | "clarify" | "review" | "setup";

type CharacterDialogueDraft = {
  v: 1;
  active: boolean;
  characterId: number | null;
  outfitId: number | null;
  brandKitId: number | null;
  locale: string;
  topic: string;
  sourceScript?: string;
  script: string;
  approvedScript: string | null;
  translationReady?: boolean;
  translationNeedsEdit?: boolean;
  translationSpendPaise?: number | null;
  step: SpokespersonStep;
  scriptVariant: ScriptVariant | null;
  scriptDuration: number;
  durationSec: number;
  aspect: Aspect;
  reviewStoryboard: boolean;
  lipSyncQuality: LipSyncQuality;
};

const MAX_TRANSLATION_CUE_CHARS = 1_800;

function splitTranslationSource(script: string): string[] {
  return script
    .split(/\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .flatMap((paragraph) => {
      const chunks: string[] = [];
      let remaining = paragraph;
      while (remaining.length > MAX_TRANSLATION_CUE_CHARS) {
        const window = remaining.slice(0, MAX_TRANSLATION_CUE_CHARS + 1);
        const sentenceBreak = Math.max(
          window.lastIndexOf(". "),
          window.lastIndexOf("! "),
          window.lastIndexOf("? "),
        );
        const wordBreak = window.lastIndexOf(" ");
        const splitAt =
          sentenceBreak >= Math.floor(MAX_TRANSLATION_CUE_CHARS * 0.55)
            ? sentenceBreak + 1
            : wordBreak > 0
              ? wordBreak
              : MAX_TRANSLATION_CUE_CHARS;
        chunks.push(remaining.slice(0, splitAt).trim());
        remaining = remaining.slice(splitAt).trim();
      }
      if (remaining) chunks.push(remaining);
      return chunks;
    });
}

function characterTranslationCues(script: string, durationSeconds: number) {
  const chunks = splitTranslationSource(script);
  const weights = chunks.map((chunk) => Math.max(1, chunk.split(/\s+/).length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const totalMs = Math.max(chunks.length * 1_000, Math.round(durationSeconds * 1_000));
  let cumulativeWeight = 0;

  return chunks.map((text, index) => {
    const startMs = Math.round((cumulativeWeight / totalWeight) * totalMs);
    cumulativeWeight += weights[index]!;
    const endMs =
      index === chunks.length - 1
        ? totalMs
        : Math.round((cumulativeWeight / totalWeight) * totalMs);
    return { index: index + 1, startMs, endMs, text };
  });
}

type VideoModelCostEstimate =
  | {
      available: true;
      totalPaise: number;
      operations: number;
      models: string[];
      durationSec: number;
    }
  | { available: false };

function estimateModelComponent(
  model: VideoCostModel | null,
  operations: number,
  totalDurationSec: number,
  criteria: Record<string, string | boolean>,
): number | null {
  if (!model || operations < 1) return null;
  const variants = [...(model.variants ?? [])].sort(
    (a, b) => Object.keys(b.criteria).length - Object.keys(a.criteria).length,
  );
  const matchingVariant = variants.length > 0
    ? variants.find((variant) =>
        Object.entries(variant.criteria).every(([key, value]) => criteria[key] === value),
      )
    : null;
  // A variant catalog is authoritative: never make an attractive but wrong
  // estimate from legacy/model-level rates when this request has no match.
  if (variants.length > 0 && !matchingVariant) return null;
  const paisePerSecond = matchingVariant?.paisePerSecond ?? model.paisePerSecond;
  const paisePerVideo = matchingVariant?.paisePerVideo ?? model.paisePerVideo;
  if (paisePerSecond !== null) {
    return paisePerSecond > 0
      ? Math.round(paisePerSecond * totalDurationSec)
      : null;
  }
  if (paisePerVideo !== null) {
    return paisePerVideo > 0 ? paisePerVideo * operations : null;
  }
  return null;
}

const SPOKESPERSON_STEPS: { key: SpokespersonStep; label: string }[] = [
  { key: "type", label: "Type" },
  { key: "topic", label: "Topic" },
  { key: "clarify", label: "Details" },
  { key: "review", label: "Review" },
  { key: "setup", label: "Setup" },
];

const VARIANT_META: Record<
  ScriptVariant,
  { title: string; blurb: string; defaultDurationSec: number }
> = {
  marketing: {
    title: "Marketing",
    blurb: "Promo or product video. Hooks on the problem, proves one claim, ends on one action.",
    defaultDurationSec: 45,
  },
  training: {
    title: "Training",
    blurb: "Internal how-to or onboarding. Objectives, numbered steps, the two common mistakes.",
    defaultDurationSec: 90,
  },
  social_short: {
    title: "Social short",
    blurb: "Vertical short. Survives a muted autoplay, turns on one surprise, loops at the end.",
    defaultDurationSec: 40,
  },
};

/** Duration presets, so the common cases are one tap. */
const DURATION_CHOICES = [15, 30, 45, 60, 90, 120] as const;
const DIALOGUE_DURATION_CHOICES = [5, 8, 10, 15, 20, 30] as const;
const MAX_DIALOGUE_DURATION_SEC = 30;
const MAX_CHARACTER_DIALOGUE_DURATION_SEC = 180;

/**
 * Keep the client gate deliberately aligned with the API's slow-speaking
 * estimate. A dialogue plate that is too short cuts the speaker off, while a
 * much longer plate leaves an awkward silent talking head at the end.
 */
function dialogueDurationBounds(dialogue: string): { minimum: number; maximum: number } {
  const words = dialogue.trim().split(/\s+/).filter(Boolean).length;
  const sentences = Math.max(1, dialogue.trim().split(/[.!?]+/).filter(Boolean).length);
  const minimum = Math.max(3, Math.ceil(words / 1.8 + Math.max(0, sentences - 1) * 0.25 + 0.6));
  return { minimum, maximum: Math.min(MAX_DIALOGUE_DURATION_SEC, Math.ceil(minimum * 1.25)) };
}

/** Mirrors the server's locale-aware Character Dialogue segmenter for estimates. */
function characterDialogueSceneCount(
  dialogue: string,
  locale?: Pick<CharacterDialogueLocale, "bcp47" | "script">,
): number {
  const segmenter = new Intl.Segmenter(locale?.bcp47 ?? "en", {
    granularity: "grapheme",
  });
  const graphemes = (value: string) =>
    [...segmenter.segment(value)].map((part) => part.segment);
  const compactScript =
    locale?.script === "Han" ||
    locale?.script === "Japanese" ||
    locale?.script === "Thai";
  const oversizedToken = (dialogue.match(/\S+/gu) ?? []).some(
    (token) => graphemes(token).length > 80,
  );
  if (compactScript || oversizedToken) {
    const parts = graphemes(dialogue);
    let offset = 0;
    let scenes = 0;
    while (offset < parts.length) {
      const limit = Math.min(parts.length, offset + 80);
      let end = limit;
      for (let i = limit - 1; i > offset; i--) {
        if (/[.!?。！？]/u.test(parts[i]!)) {
          end = i + 1;
          break;
        }
      }
      scenes += 1;
      offset = end;
    }
    return Math.max(1, scenes);
  }

  const tokens = dialogue.match(/\S+\s*/gu) ?? [];
  let offset = 0;
  let scenes = 0;
  while (offset < tokens.length) {
    const limit = Math.min(tokens.length, offset + 32);
    let end = limit;
    for (let i = limit - 1; i > offset; i--) {
      if (/[.!?。！？]\s*$/u.test(tokens[i]!)) {
        end = i + 1;
        break;
      }
    }
    scenes += 1;
    offset = end;
  }
  return Math.max(1, scenes);
}

/** Free-text answers to the clarify step, keyed by the gap they close. */
type ClarifyAnswers = Partial<Record<ScriptIntakeResultGapsItem, string>>;

const CLARIFY_QUESTIONS: Record<
  ScriptIntakeResultGapsItem,
  { prompt: string; placeholder: string; chips: string[] }
> = {
  audience: {
    prompt: "Who is this for?",
    placeholder: "e.g. ops managers at 20-200 person e-commerce brands",
    chips: ["Existing customers", "New prospects", "My team", "Everyone"],
  },
  desiredTakeaway: {
    prompt: "What should they remember afterwards?",
    placeholder: "One sentence they could repeat to a colleague",
    chips: [],
  },
  cta: {
    prompt: "What should they do next?",
    placeholder: "e.g. Start a free trial",
    chips: ["Book a demo", "Start a free trial", "Reply to this", "Nothing — just inform"],
  },
  toneNote: {
    prompt: "How should it sound?",
    placeholder: "e.g. warm and plainspoken",
    chips: ["Warm", "Direct", "Playful", "Authoritative"],
  },
  sourceFacts: {
    prompt: "Any facts it must get right?",
    placeholder: "One per line. Anything not listed here is flagged, never invented.",
    chips: [],
  },
};
type VideoResolution = NonNullable<VideoGenerateRequest["resolution"]>;
type VideoQuality = NonNullable<VideoGenerateRequest["quality"]>;

const VOICES: { value: Voice; label: string }[] = [
  { value: "brand", label: "Brand kit voice" },
  { value: "alloy", label: "Alloy · balanced" },
  { value: "nova", label: "Nova · bright" },
  { value: "shimmer", label: "Shimmer · warm" },
  { value: "echo", label: "Echo · deep" },
  { value: "onyx", label: "Onyx · bold" },
  { value: "fable", label: "Fable · storyteller" },
];

function clonedVoiceMetadata(kit: BrandKit): string | null {
  const voice = kit.activeVersion?.payload?.brand_voice;
  if (voice?.mode !== "cloned") return null;
  const gender =
    voice.cloned_gender === "female"
      ? "Female"
      : voice.cloned_gender === "male"
        ? "Male"
        : voice.cloned_gender === "non_binary"
          ? "Non-binary"
          : "Gender not specified";
  return `${voice.cloned_label ?? "Brand voice"} · ${gender}`;
}

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
/** Reference-video uploads for style analysis. */
const REFERENCE_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"];
const MAX_REFERENCE_MB = 200;
const MUSIC_TYPES = ["audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/aac", "audio/wav"];
/** Lip-sync base videos (front-facing person, mouth clearly visible). */
const BASE_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"];
const MAX_BASE_VIDEO_MB = 100;
/** Presenter footage required by selected curated topic-video templates. */
const PRESENTER_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"];
const MAX_PRESENTER_VIDEO_MB = 100;
/** Portrait lip sync: one headshot instead of filmed footage. */
const PORTRAIT_TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX_PORTRAIT_MB = 10;
/** A recorded voice track, used instead of synthesising the script. */
const VOICE_TRACK_TYPES = [
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/x-m4a",
  "audio/aac",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
  "audio/webm",
];
const MAX_VOICE_TRACK_MB = 25;
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
      "Share a topic, approve the script KOKAO writes, then turn it into a video spoken in your chosen voice.",
  },
  dialogue_lip_sync: {
    title: "AI Dialogue",
    blurb:
      "Describe an AI person, approve the dialogue KOKAO writes, then create a speaking video in your chosen voice.",
  },
};

const ENGINE_FEATURE: Partial<Record<Engine, FeatureId>> = {
  text_to_video: "videoTextToVideo",
  image_to_video: "videoAnimatePhoto",
  slideshow: "videoSlideshow",
  topic_to_video: "videoTopicToVideo",
  lip_sync: "lipSync",
  dialogue_lip_sync: "lipSync",
};

export function VideoStudioPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: me } = useGetMe();
  const requestUpgrade = useBillingRequestUpgrade();

  const [engine, setEngine] = useState<Engine>("text_to_video");
  const [prompt, setPrompt] = useState("");
  const [aspect, setAspect] = useState<Aspect>("9:16");
  // Camera move applied to every AI shot in the job. Null = the built-in
  // "subtle natural motion" instruction, which is what jobs did before
  // presets existed — so leaving this alone changes nothing.
  const [motionPreset, setMotionPreset] = useState<string | null>(null);
  // Optics. Motion presets say how the camera MOVES; this says what it IS,
  // and every axis is independently optional.
  const [camera, setCamera] = useState<string | null>(null);
  const [lens, setLens] = useState<string | null>(null);
  const [focalLengthMm, setFocalLengthMm] = useState<number | null>(null);
  const [aperture, setAperture] = useState<string | null>(null);
  const { data: opticsCatalog } = useListVideoCinematography({
    query: {
      queryKey: getListVideoCinematographyQueryKey(),
      staleTime: Infinity,
      gcTime: Infinity,
    },
  });
  const cinematography =
    camera || lens || focalLengthMm != null || aperture
      ? { camera, lens, focalLengthMm, aperture }
      : null;
  // The catalog is static per deploy and its ids never change, so it is
  // fetched once and kept for the session.
  const { data: motionCatalog } = useListVideoMotionPresets({
    query: {
      queryKey: getListVideoMotionPresetsQueryKey(),
      staleTime: Infinity,
      gcTime: Infinity,
    },
  });
  const [durationSec, setDurationSec] = useState(5);
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
  const [visuals, setVisuals] = useState<"stock" | "character" | "ai" | "ai_video">("stock");
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

  // Model choice. Null = the workspace's configured model, which is what
  // every job used before this picker existed and still costs one unit.
  const [modelId, setModelId] = useState<string | null>(null);
  const [resolution, setResolution] = useState<VideoResolution | null>(null);
  const [quality, setQuality] = useState<VideoQuality | null>(null);
  const [generateAudio, setGenerateAudio] = useState(false);
  // Depends on which provider keys an admin has saved, so it is refetched on
  // mount rather than cached forever like the preset catalog.
  const { data: videoModels } = useListVideoModels({
    query: { queryKey: getListVideoModelsQueryKey(), staleTime: 5 * 60 * 1000 },
  });
  // A model only appears once it can serve this engine: text_to_video without
  // a character is the only prompt-only mode; everything else animates a
  // frame, so it needs an image-capable model.
  const modelMode: "text" | "image" =
    engine === "text_to_video" && characterId == null ? "text" : "image";
  const availableModels = useMemo(
    () => (videoModels?.models ?? []).filter((m) => m.modes.includes(modelMode)),
    [videoModels, modelMode],
  );
  const selectedModel = availableModels.find((m) => m.id === modelId) ?? null;
  // Picking a model narrows every dependent control to what it can render.
  // A stale selection (switching from a 5/10s model to an 8s-only one) is
  // corrected here rather than being silently snapped at render time.
  useEffect(() => {
    if (modelId && !availableModels.some((m) => m.id === modelId)) setModelId(null);
  }, [availableModels, modelId]);
  useEffect(() => {
    if (!selectedModel) return;
    if (!selectedModel.durations.includes(durationSec)) {
      setDurationSec(
        selectedModel.durations.reduce((best, d) =>
          Math.abs(d - durationSec) < Math.abs(best - durationSec) ? d : best,
        ),
      );
    }
    if (
      resolution &&
      !(selectedModel.resolutions as readonly string[]).includes(resolution)
    ) {
      setResolution(null);
    }
    if (!selectedModel.hasQuality && quality) setQuality(null);
    if (!selectedModel.canGenerateAudio && generateAudio) setGenerateAudio(false);
    // durationSec is intentionally read, not depended on: this corrects the
    // selection when the MODEL changes, not on every length the user types.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedModel]);
  const [outfitId, setOutfitId] = useState<number | null>(null);
  const [wardrobeNotes, setWardrobeNotes] = useState("");
  const [charactersOpen, setCharactersOpen] = useState(false);
  const [photos, setPhotos] = useState<PickedPhoto[]>([]);
  const [music, setMusic] = useState<{ objectPath: string; name: string } | null>(null);
  const [baseVideo, setBaseVideo] = useState<{ objectPath: string; name: string } | null>(null);
  const [presenterVideo, setPresenterVideo] = useState<{ objectPath: string; name: string } | null>(
    null,
  );
  /** "video" = filmed footage (the original mode); "portrait" = one headshot. */
  const [lipSyncSource, setLipSyncSource] = useState<"video" | "portrait">("video");
  const [lipSyncQuality, setLipSyncQuality] = useState<LipSyncQuality>("standard");
  const [portrait, setPortrait] = useState<{ objectPath: string; name: string } | null>(null);
  /** An uploaded recording replaces text-to-speech when set. */
  const [voiceTrack, setVoiceTrack] = useState<{ objectPath: string; name: string } | null>(null);
  const [lipSyncConsent, setLipSyncConsent] = useState(false);
  const [aiPersonPrompt, setAiPersonPrompt] = useState("");
  const [aiPersonConsent, setAiPersonConsent] = useState(false);
  useEffect(() => {
    if (lipSyncSource === "portrait" && lipSyncQuality !== "standard") {
      setLipSyncQuality("standard");
    }
  }, [lipSyncQuality, lipSyncSource]);
  const [spokespersonStep, setSpokespersonStep] = useState<SpokespersonStep>("type");
  const [spokespersonTopic, setSpokespersonTopic] = useState("");
  const [spokespersonSourceScript, setSpokespersonSourceScript] = useState("");
  const [spokespersonScript, setSpokespersonScript] = useState("");
  const [approvedSpokespersonScript, setApprovedSpokespersonScript] = useState<string | null>(
    null,
  );
  const [teluguTranslationReady, setTeluguTranslationReady] = useState(false);
  const [teluguTranslationNeedsEdit, setTeluguTranslationNeedsEdit] = useState(false);
  const [translationSpendPaise, setTranslationSpendPaise] = useState<number | null>(null);
  const translationRequestRef = useRef(0);
  const [scriptVariant, setScriptVariant] = useState<ScriptVariant | null>(null);
  const [scriptDuration, setScriptDuration] = useState(45);
  const [intake, setIntake] = useState<ScriptIntakeResult | null>(null);
  const [clarify, setClarify] = useState<ClarifyAnswers>({});
  // Facts start as whatever the intake pass extracted and stay editable —
  // a bad extraction the user cannot remove would end up asserted as truth.
  const [sourceFacts, setSourceFacts] = useState<string[]>([]);
  const [scriptBeats, setScriptBeats] = useState<ScriptBeat[]>([]);
  const [scriptMeta, setScriptMeta] = useState<ScriptMeta | null>(null);
  const [musicPrompt, setMusicPrompt] = useState("");
  const [aiMusicDraft, setAiMusicDraft] = useState("");
  const [aiMusicOpen, setAiMusicOpen] = useState(false);
  const [musicLibraryOpen, setMusicLibraryOpen] = useState(false);
  const [clipMusic, setClipMusic] = useState(false);
  const [hooksOpen, setHooksOpen] = useState(false);
  const [hookIdeas, setHookIdeas] = useState<HookIdea[]>([]);
  const [characterMode, setCharacterMode] = useState<"story" | "dialogue">("story");
  const [characterDialogueLocale, setCharacterDialogueLocale] = useState<string>("");

  const [brandKitId, setBrandKitId] = useState<number | null>(null);
  const [styleProfileId, setStyleProfileId] = useState<number | null>(null);
  const [stylesOpen, setStylesOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [reviewStoryboard, setReviewStoryboard] = useState(true);
  const [shotCount, setShotCount] = useState(1);
  const [activeJobId, setActiveJobId] = useState<number | null>(null);
  const [repairOpen, setRepairOpen] = useState(false);
  const [repairStartError, setRepairStartError] = useState<string | null>(null);
  const [repairReason, setRepairReason] = useState<
    "narration" | "music" | "captions" | "scene_timing" | "audio_visual"
  >("audio_visual");
  const activeVideoJobKey = me?.tenant?.id
    ? `kokao-active-video-job-v1:${me.tenant.id}`
    : null;

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
  const presenterVideoInputRef = useRef<HTMLInputElement>(null);

  const characterDialogueDraftKey = me?.tenant?.id
    ? `kokao-character-dialogue-draft-v1:${me.tenant.id}`
    : null;
  const restoredCharacterDialogueDraftKeyRef = useRef<string | null>(null);
  const [hydratedCharacterDialogueDraftKey, setHydratedCharacterDialogueDraftKey] = useState<
    string | null
  >(null);

  useEffect(() => {
    if (
      !characterDialogueDraftKey ||
      restoredCharacterDialogueDraftKeyRef.current === characterDialogueDraftKey
    ) {
      return;
    }
    restoredCharacterDialogueDraftKeyRef.current = characterDialogueDraftKey;
    try {
      const raw = localStorage.getItem(characterDialogueDraftKey);
      if (!raw) return;
      const draft = JSON.parse(raw) as Partial<CharacterDialogueDraft>;
      if (draft.v !== 1) return;

      const topic = typeof draft.topic === "string" ? draft.topic : "";
      const sourceScript = typeof draft.sourceScript === "string" ? draft.sourceScript : "";
      const script = typeof draft.script === "string" ? draft.script : "";
      const approvedScript =
        typeof draft.approvedScript === "string" && draft.approvedScript === script
          ? draft.approvedScript
          : null;
      const validStep = SPOKESPERSON_STEPS.some(({ key }) => key === draft.step)
        ? draft.step!
        : "type";
      const restoredStep =
        approvedScript !== null
          ? "setup"
          : script
            ? validStep === "setup"
              ? "review"
              : validStep
            : topic
              ? "topic"
              : "type";

      setCharacterId(
        Number.isInteger(draft.characterId) && Number(draft.characterId) > 0
          ? Number(draft.characterId)
          : null,
      );
      setOutfitId(
        Number.isInteger(draft.outfitId) && Number(draft.outfitId) > 0
          ? Number(draft.outfitId)
          : null,
      );
      setBrandKitId(
        Number.isInteger(draft.brandKitId) && Number(draft.brandKitId) > 0
          ? Number(draft.brandKitId)
          : null,
      );
      setCharacterDialogueLocale(typeof draft.locale === "string" ? draft.locale : "");
      setLipSyncQuality(draft.lipSyncQuality === "high" ? "high" : "standard");
      setSpokespersonTopic(topic);
      setSpokespersonSourceScript(sourceScript);
      setSpokespersonScript(script);
      setApprovedSpokespersonScript(approvedScript);
      setTeluguTranslationReady(
        draft.translationReady === true || (sourceScript.length > 0 && script.length > 0),
      );
      setTeluguTranslationNeedsEdit(draft.translationNeedsEdit === true);
      setTranslationSpendPaise(
        typeof draft.translationSpendPaise === "number" &&
          Number.isFinite(draft.translationSpendPaise) &&
          draft.translationSpendPaise >= 0
          ? draft.translationSpendPaise
          : null,
      );
      setSpokespersonStep(restoredStep);
      setScriptVariant(
        draft.scriptVariant === "marketing" ||
          draft.scriptVariant === "training" ||
          draft.scriptVariant === "social_short"
          ? draft.scriptVariant
          : null,
      );
      if (
        typeof draft.scriptDuration === "number" &&
        draft.scriptDuration >= 3 &&
        draft.scriptDuration <= 180
      ) {
        setScriptDuration(draft.scriptDuration);
      }
      if (
        typeof draft.durationSec === "number" &&
        draft.durationSec >= 3 &&
        draft.durationSec <= 180
      ) {
        setDurationSec(draft.durationSec);
      }
      if (draft.aspect === "16:9" || draft.aspect === "9:16" || draft.aspect === "1:1") {
        setAspect(draft.aspect);
      }
      if (typeof draft.reviewStoryboard === "boolean") {
        setReviewStoryboard(draft.reviewStoryboard);
      }
      if (draft.active === true) {
        setEngine("topic_to_video");
        setVisuals("character");
        setCharacterMode("dialogue");
      }
      // Consent is intentionally per attempt and is never restored.
      setLipSyncConsent(false);
    } catch {
      // Corrupt or unavailable storage should never stop Video Studio loading.
    } finally {
      setHydratedCharacterDialogueDraftKey(characterDialogueDraftKey);
    }
  }, [characterDialogueDraftKey]);

  useEffect(() => {
    if (
      !characterDialogueDraftKey ||
      hydratedCharacterDialogueDraftKey !== characterDialogueDraftKey
    ) {
      return;
    }
    const hasDraft =
      characterId !== null ||
      outfitId !== null ||
      brandKitId !== null ||
      spokespersonTopic.trim() !== "" ||
      spokespersonSourceScript.trim() !== "" ||
      spokespersonScript.trim() !== "";
    try {
      if (!hasDraft) {
        localStorage.removeItem(characterDialogueDraftKey);
        return;
      }
      const draft: CharacterDialogueDraft = {
        v: 1,
        active:
          engine === "topic_to_video" &&
          visuals === "character" &&
          characterMode === "dialogue",
        characterId,
        outfitId,
        brandKitId,
        locale: characterDialogueLocale,
        topic: spokespersonTopic,
        sourceScript: spokespersonSourceScript,
        script: spokespersonScript,
        approvedScript:
          approvedSpokespersonScript === spokespersonScript ? approvedSpokespersonScript : null,
        translationReady: teluguTranslationReady,
        translationNeedsEdit: teluguTranslationNeedsEdit,
        translationSpendPaise,
        step: spokespersonStep,
        scriptVariant,
        scriptDuration,
        durationSec,
        aspect,
        reviewStoryboard,
        lipSyncQuality,
      };
      localStorage.setItem(characterDialogueDraftKey, JSON.stringify(draft));
    } catch {
      // Persistence is best-effort; the editor remains fully usable without it.
    }
  }, [
    characterDialogueDraftKey,
    hydratedCharacterDialogueDraftKey,
    engine,
    visuals,
    characterMode,
    characterId,
    outfitId,
    brandKitId,
    characterDialogueLocale,
    spokespersonTopic,
    spokespersonSourceScript,
    spokespersonScript,
    approvedSpokespersonScript,
    teluguTranslationReady,
    teluguTranslationNeedsEdit,
    translationSpendPaise,
    spokespersonStep,
    scriptVariant,
    scriptDuration,
    durationSec,
    aspect,
    reviewStoryboard,
    lipSyncQuality,
  ]);
  const portraitInputRef = useRef<HTMLInputElement>(null);
  const voiceTrackInputRef = useRef<HTMLInputElement>(null);

  const { flags } = useFeatureFlags();
  const availableEngines = useMemo(
    () =>
      (Object.keys(ENGINE_META) as Engine[]).filter((candidate) => {
        const feature = ENGINE_FEATURE[candidate];
        return feature ? flags[feature] : true;
      }),
    [flags],
  );

  // Flags can refresh while this page is open. Never leave the form on a mode
  // that has just been disabled; move to the first still-available mode.
  useEffect(() => {
    if (availableEngines.includes(engine)) return;
    const fallback = availableEngines[0];
    if (fallback) setEngine(fallback);
  }, [availableEngines, engine]);

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
  const retryVideo = useRetryVideoJob();
  const repairVideo = useRepairVideoJob();
  const generateHooks = useGenerateHooks();
  const draftSpokespersonScript = useGenerateSpokespersonScript();
  const translateScript = useLocalizeScript();
  const runScriptIntake = useAnalyzeScriptIntake();
  const saveToLibrary = useSaveVideoToLibrary();
  const { data: videoCapabilities } = useGetVideoCapabilities({
    query: {
      queryKey: getGetVideoCapabilitiesQueryKey(),
      enabled: flags.lipSync,
      staleTime: Infinity,
    },
  });
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
      enabled: (engine === "lip_sync" || engine === "dialogue_lip_sync") && brandKitId !== null,
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

  useEffect(() => {
    if (
      characterDialogueDraftKey &&
      hydratedCharacterDialogueDraftKey !== characterDialogueDraftKey
    ) {
      return;
    }
    if (videoCapabilities?.characterDialogueLocales?.[0] && !characterDialogueLocale) {
      setCharacterDialogueLocale(videoCapabilities.characterDialogueLocales[0].code);
    }
  }, [
    videoCapabilities,
    characterDialogueLocale,
    characterDialogueDraftKey,
    hydratedCharacterDialogueDraftKey,
  ]);

  useEffect(() => {
    if (
      videoCapabilities &&
      videoCapabilities.costModels?.lipSyncHigh == null &&
      lipSyncQuality === "high"
    ) {
      setLipSyncQuality("standard");
    }
  }, [lipSyncQuality, videoCapabilities]);

  const isCharacterDialogue =
    engine === "topic_to_video" && visuals === "character" && characterMode === "dialogue";
  const curatedTemplates = (styleProfiles ?? []).filter((profile) => profile.scope === "platform");
  const workspaceStyles = (styleProfiles ?? []).filter((profile) => profile.scope !== "platform");
  const selectedCuratedTemplate =
    curatedTemplates.find((profile) => profile.id === styleProfileId) ?? null;
  const selectedTemplate = selectedCuratedTemplate;
  const isHybridCharacterStory =
    engine === "topic_to_video" &&
    selectedTemplate?.jobDefaults.format === "hybrid_character_story";
  useEffect(() => {
    if (!isHybridCharacterStory || characterId !== null || !characters?.length) return;
    const selected = characters.find((character) =>
      character.outfits.some((outfit) => outfit.isDefault),
    ) ?? characters[0]!;
    setCharacterId(selected.id);
    setOutfitId(selected.outfits.find((outfit) => outfit.isDefault)?.id ?? null);
  }, [isHybridCharacterStory, characterId, characters]);
  const selectedWorkspaceStyle = workspaceStyles.find((profile) => profile.id === styleProfileId) ?? null;
  const selectedTemplateRuntimeMaxScenes = useMemo(() => {
    const defaults = selectedTemplate?.jobDefaults;
    if (!defaults) return null;
    const hasNativeRuntime = [
      "durationMode",
      "maxDurationSeconds",
      "speakingRateWpm",
      "scriptDetailLevel",
      "minSceneDurationSeconds",
      "maxSceneDurationSeconds",
      "minSceneCount",
      "maxSceneCount",
      "visualStrategy",
    ].some((key) => Object.prototype.hasOwnProperty.call(defaults, key));
    if (!hasNativeRuntime) return null;
    return typeof defaults.maxSceneCount === "number" &&
      Number.isFinite(defaults.maxSceneCount)
      ? Math.max(1, Math.trunc(defaults.maxSceneCount))
      : 20;
  }, [selectedTemplate]);
  const templatePlansBeforeVisualFunding =
    engine === "topic_to_video" &&
    selectedTemplateRuntimeMaxScenes != null &&
    (visuals === "character" || visuals === "ai" || visuals === "ai_video");
  const templateHasPresenterSlot =
    selectedTemplate?.slots.some((slot) => slot.kind === "presenter_video" && slot.required) ?? false;
  const characterFillsPresenterSlot =
    engine === "topic_to_video" && visuals === "character";
  const templateRequiresPresenterVideo =
    templateHasPresenterSlot && !characterFillsPresenterSlot;

  // Presenter footage belongs to a curated format, not the general topic form.
  // Do not carry it into another template, a workspace style, or no template.
  useEffect(() => {
    if (!templateHasPresenterSlot) setPresenterVideo(null);
  }, [templateHasPresenterSlot]);

  const applyStyleCaptionTreatment = (profile: VideoStyleProfile) => {
    // A template/style's caption treatment is a useful starting point, but the
    // dedicated subtitle controls remain editable after it is selected.
    if (profile.payload.captionStyle === "none") {
      setSubtitles(false);
    } else {
      setSubtitles(true);
      setCaptionStyle(profile.payload.captionStyle);
    }
  };

  const chooseVideoTemplate = (template: VideoStyleProfile) => {
    setCharacterMode("story");
    setStyleProfileId(template.id);
    applyStyleCaptionTreatment(template);

    // Curated templates may only preset safe, presentation-level options. The
    // server still owns identity and asset checks; this just makes the format's
    // intended framing and treatment visible in the Studio before generation.
    const defaults = template.jobDefaults;
    const nextAspect = defaults.aspectRatio;
    if (nextAspect === "16:9" || nextAspect === "9:16" || nextAspect === "1:1") {
      setAspect(nextAspect);
    }
    const nextDuration = Number(defaults.maxDurationSeconds ?? defaults.durationSec);
    if (Number.isFinite(nextDuration) && nextDuration >= 3 && nextDuration <= 600) {
      setDurationSec(nextDuration);
    }
    if (typeof defaults.subtitles === "boolean") setSubtitles(defaults.subtitles);
    if (defaults.captionStyle === "classic" || defaults.captionStyle === "dynamic") {
      setCaptionStyle(defaults.captionStyle);
    }
    const nextParagraphCount = Number(defaults.paragraphCount);
    if (Number.isInteger(nextParagraphCount) && nextParagraphCount >= 1 && nextParagraphCount <= 3) {
      setParagraphCount(nextParagraphCount);
    }
    if (
      (defaults.visualStrategy ?? defaults.visualsSource) === "stock" ||
      (defaults.visualStrategy ?? defaults.visualsSource) === "character" ||
      (defaults.visualStrategy ?? defaults.visualsSource) === "ai" ||
      (defaults.visualStrategy ?? defaults.visualsSource) === "ai_video"
    ) {
      setVisuals((defaults.visualStrategy ?? defaults.visualsSource)!);
    }
    if (
      defaults.stockSource === "auto" ||
      defaults.stockSource === "pexels" ||
      defaults.stockSource === "pixabay" ||
      defaults.stockSource === "wikimedia"
    ) {
      setStockSource(defaults.stockSource);
    }
  };
  const activeCharacter = characters?.find((c) => c.id === characterId) ?? null;
  const characterDialogueBrandKits = useMemo(
    () =>
      brandKits?.filter(
        (kit) =>
          kit.activeVersion?.payload?.brand_voice?.mode === "cloned" &&
          kit.activeVersion.payload.brand_voice.provider === "elevenlabs",
      ) ?? [],
    [brandKits],
  );

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

  // Recovery children remain selected across reloads and other navigation.
  // The list fallback below still handles another session creating the child.
  const restoredActiveJobKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeVideoJobKey || restoredActiveJobKeyRef.current === activeVideoJobKey) return;
    restoredActiveJobKeyRef.current = activeVideoJobKey;
    const saved = Number(localStorage.getItem(activeVideoJobKey));
    if (Number.isSafeInteger(saved) && saved > 0) setActiveJobId(saved);
  }, [activeVideoJobKey]);
  useEffect(() => {
    if (!activeVideoJobKey || activeJobId === null) return;
    localStorage.setItem(activeVideoJobKey, String(activeJobId));
  }, [activeJobId, activeVideoJobKey]);

  // A storyboard waiting on the user — or a job still generating — survives a
  // reload, but activeJobId does not. Adopt the newest such job on first load,
  // preferring one paused for review. Without this a plan or render the user
  // already paid for is invisible until they think to click its card, which is
  // exactly the "where is my video?" trap after logging back in.
  const adoptedRef = useRef(false);
  useEffect(() => {
    if (adoptedRef.current || activeJobId !== null || !jobs) return;
    const adoptable =
      jobs.find((job) => job.status === "awaiting_review") ??
      jobs.find((job) => job.status === "queued" || job.status === "processing") ??
      jobs.find(
        (job) =>
          job.recovery != null &&
          job.recovery.sourceJobId !== job.id,
      );
    if (!adoptable) return;
    adoptedRef.current = true;
    setActiveJobId(adoptable.id);
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

  /**
   * How many photos this engine takes right now.
   *
   * Animate Photo took exactly one; with a model that blends a start and an
   * end frame it takes two — "start here, end there", which is what makes a
   * product reveal or a before/after possible.
   */
  const photoLimit =
    engine === "slideshow"
      ? MAX_PHOTOS
      : engine === "image_to_video" && selectedModel?.supportsEndFrame
        ? 2
        : 1;

  const addPhotos = (picked: PickedPhoto[]) => {
    setPhotos((prev) => {
      const seen = new Set(prev.map((p) => p.objectPath));
      const fresh = picked.filter((p) => !seen.has(p.objectPath));
      return [...prev, ...fresh].slice(0, photoLimit);
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

  /** Shared uploader for the two optional lip-sync files. */
  const handleLipSyncFile = async (
    files: FileList | null,
    spec: {
      accept: string[];
      maxMb: number;
      inputRef: React.RefObject<HTMLInputElement | null>;
      set: (value: { objectPath: string; name: string } | null) => void;
      wrongTypeMessage: string;
      tooLargeTitle: string;
    },
  ) => {
    const file = files?.[0];
    if (!file) return;
    if (!spec.accept.includes(file.type)) {
      toast({
        title: "Unsupported file",
        description: spec.wrongTypeMessage,
        variant: "destructive",
      });
      return;
    }
    if (file.size > spec.maxMb * 1024 * 1024) {
      toast({
        title: spec.tooLargeTitle,
        description: `Keep it under ${spec.maxMb} MB.`,
        variant: "destructive",
      });
      return;
    }
    setUploading(true);
    try {
      const objectPath = await uploadFile(file);
      spec.set({ objectPath, name: file.name });
    } catch {
      toast({
        title: "Upload failed",
        description: "Could not upload the file. Please try again.",
        variant: "destructive",
      });
    } finally {
      setUploading(false);
      if (spec.inputRef.current) spec.inputRef.current.value = "";
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

  const handlePresenterVideoFile = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (!PRESENTER_VIDEO_TYPES.includes(file.type)) {
      toast({
        title: "Not a supported presenter video",
        description: "Use an MP4, MOV, or WebM video.",
        variant: "destructive",
      });
      return;
    }
    if (file.size > MAX_PRESENTER_VIDEO_MB * 1024 * 1024) {
      toast({
        title: "Presenter video too large",
        description: `The presenter video must be under ${MAX_PRESENTER_VIDEO_MB} MB.`,
        variant: "destructive",
      });
      return;
    }
    setUploading(true);
    try {
      const objectPath = await uploadFile(file);
      setPresenterVideo({ objectPath, name: file.name });
    } catch {
      toast({
        title: "Upload failed",
        description: "Could not upload the presenter video. Please try again.",
        variant: "destructive",
      });
    } finally {
      setUploading(false);
      if (presenterVideoInputRef.current) presenterVideoInputRef.current.value = "";
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

  const dialogueBounds = useMemo(
    () => dialogueDurationBounds(approvedSpokespersonScript ?? ""),
    [approvedSpokespersonScript],
  );
  const dialogueDurationIsValid =
    dialogueBounds.minimum <= MAX_DIALOGUE_DURATION_SEC &&
    durationSec >= dialogueBounds.minimum &&
    durationSec <= dialogueBounds.maximum;
  const dialogueDurationOptions = [
    ...new Set([
      ...DIALOGUE_DURATION_CHOICES,
      dialogueBounds.minimum,
      dialogueBounds.maximum,
      durationSec,
    ]),
  ]
    .filter(
      (seconds) =>
        (seconds >= dialogueBounds.minimum && seconds <= dialogueBounds.maximum) ||
        seconds === durationSec,
    )
    .sort((a, b) => a - b);

  const selectedCharacterDialogueLocale = videoCapabilities?.characterDialogueLocales.find(
    (locale) => locale.code === characterDialogueLocale,
  );
  const isTeluguCharacterDialogue =
    selectedCharacterDialogueLocale?.code === "te" ||
    selectedCharacterDialogueLocale?.bcp47.toLowerCase().startsWith("te-") === true;
  const characterDialogueMinimumDurationSec = dialogueDurationBounds(
    approvedSpokespersonScript ?? spokespersonScript,
  ).minimum;
  const characterDialogueDurationIsValid =
    scriptDuration >= characterDialogueMinimumDurationSec &&
    scriptDuration <= MAX_CHARACTER_DIALOGUE_DURATION_SEC;
  const characterDialogueDurationOptions = [
    ...new Set([
      ...DIALOGUE_DURATION_CHOICES,
      ...DURATION_CHOICES,
      characterDialogueMinimumDurationSec,
      scriptDuration,
      MAX_CHARACTER_DIALOGUE_DURATION_SEC,
    ]),
  ]
    .filter((seconds) => seconds >= 3 && seconds <= MAX_CHARACTER_DIALOGUE_DURATION_SEC)
    .sort((a, b) => a - b);

  const canGenerate = useMemo(() => {
    if (generateVideo.isPending || uploading) return false;
    if (engine === "topic_to_video") {
      if (isHybridCharacterStory && !lipSyncConsent) return false;
      if (visuals === "character") {
        if (characterId === null) return false;
        if (characterMode === "dialogue") {
          return (
            characterDialogueLocale.length > 0 &&
            spokespersonTopic.trim().length >= 3 &&
            characterDialogueBrandKits.some((kit) => kit.id === brandKitId) &&
            approvedSpokespersonScript !== null &&
            characterDialogueDurationIsValid &&
            lipSyncConsent
          );
        }
      }
      if (templateRequiresPresenterVideo && presenterVideo === null) return false;
      return prompt.trim().length >= 3;
    }
    if (engine === "text_to_video") return prompt.trim().length >= 3;
    if (engine === "lip_sync") {
      return (
        spokespersonStep === "setup" &&
        approvedSpokespersonScript !== null &&
        prompt.trim() === approvedSpokespersonScript &&
        (lipSyncSource === "portrait" ? portrait !== null : baseVideo !== null) &&
        lipSyncConsent
      );
    }
    if (engine === "dialogue_lip_sync") {
      return (
        spokespersonStep === "setup" &&
        approvedSpokespersonScript !== null &&
        aiPersonPrompt.trim().length >= 3 &&
        aiPersonConsent &&
        dialogueDurationIsValid &&
        (voice !== "brand" || brandKitId !== null)
      );
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
    portrait,
    lipSyncSource,
    lipSyncConsent,
    aiPersonPrompt,
    aiPersonConsent,
    voice,
    brandKitId,
    characterDialogueLocale,
    characterDialogueBrandKits,
    spokespersonTopic,
    dialogueDurationIsValid,
    spokespersonStep,
    approvedSpokespersonScript,
    characterDialogueDurationIsValid,
    isHybridCharacterStory,
    templateRequiresPresenterVideo,
    presenterVideo,
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
            ? "Generation already started, so it cannot be stopped safely and will finish normally."
            : "Something went wrong cancelling the job. It will finish normally.",
      });
    } finally {
      setCancelling(false);
    }
  };

  /** Whether this engine plans something worth looking at before it renders.
   * Stock topic footage is searched, not prompted, so there is nothing to edit. */
  const storyboardAvailable =
    engine !== "lip_sync" &&
    engine !== "dialogue_lip_sync" &&
    (engine !== "topic_to_video" || visuals !== "stock" || templateRequiresPresenterVideo);

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
           : templateRequiresPresenterVideo
              ? "Check every supporting B-roll scene before the presenter video is rendered."
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

  const resetSpokespersonFlow = () => {
    setSpokespersonStep("type");
    setSpokespersonTopic("");
    setSpokespersonSourceScript("");
    setSpokespersonScript("");
    setApprovedSpokespersonScript(null);
    setTeluguTranslationReady(false);
    setTeluguTranslationNeedsEdit(false);
    setTranslationSpendPaise(null);
    translationRequestRef.current += 1;
    setScriptVariant(null);
    setScriptDuration(45);
    setIntake(null);
    setClarify({});
    setSourceFacts([]);
    setScriptBeats([]);
    setScriptMeta(null);
    setPrompt("");
    setAiPersonPrompt("");
    setAiPersonConsent(false);
  };
  const clearedCompletedDialogueRef = useRef<number | null>(null);
  useEffect(() => {
    if (
      activeJob?.status !== "succeeded" ||
      activeJob.engine !== "dialogue_lip_sync" ||
      clearedCompletedDialogueRef.current === activeJob.id
    ) {
      return;
    }
    clearedCompletedDialogueRef.current = activeJob.id;
    resetSpokespersonFlow();
  }, [activeJob]);

  const chooseScriptVariant = (variant: ScriptVariant) => {
    setScriptVariant(variant);
    setScriptDuration(
      engine === "dialogue_lip_sync"
        ? Math.min(VARIANT_META[variant].defaultDurationSec, MAX_DIALOGUE_DURATION_SEC)
        : VARIANT_META[variant].defaultDurationSec,
    );
    setSpokespersonStep("topic");
  };

  /** Everything the script call needs beyond the topic itself. */
  const scriptRequestFields = () => {
    const facts = sourceFacts.map((f) => f.trim()).filter(Boolean);
    const typedFacts = (clarify.sourceFacts ?? "")
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
    return {
      ...(scriptVariant ? { variant: scriptVariant } : {}),
      durationSeconds: scriptDuration,
      ...(brandKitId ? { brandKitId } : {}),
      ...(styleProfileId ? { styleProfileId } : {}),
      ...(clarify.audience?.trim() ? { audience: clarify.audience.trim() } : {}),
      ...(clarify.cta?.trim() ? { cta: clarify.cta.trim() } : {}),
      ...(clarify.toneNote?.trim() ? { toneNote: clarify.toneNote.trim() } : {}),
      ...(() => {
        const takeaway =
          clarify.desiredTakeaway?.trim() || intake?.desiredTakeaway?.trim() || "";
        return takeaway ? { desiredTakeaway: takeaway } : {};
      })(),
      ...(() => {
        const all = [...facts, ...typedFacts].slice(0, 10);
        return all.length > 0 ? { sourceFacts: all } : {};
      })(),
    };
  };

  /**
   * Read the topic, then either ask about the gaps or go straight to writing.
   *
   * The intake pass is advisory: if it fails we still write the script, just
   * without pre-filled facts. Blocking the whole flow on an optional
   * enrichment call would be the wrong trade.
   */
  const startScriptFromTopic = () => {
    const topic = spokespersonTopic.trim();
    if (topic.length < 3 || runScriptIntake.isPending || draftSpokespersonScript.isPending) {
      return;
    }
    runScriptIntake.mutate(
      {
        data: {
          topic,
          ...(scriptVariant ? { variant: scriptVariant } : {}),
          ...(brandKitId ? { brandKitId } : {}),
        },
      },
      {
        onSuccess: (result) => {
          setIntake(result);
          setSourceFacts(result.extractedFacts ?? []);
          if (!scriptVariant) setScriptVariant(result.suggestedVariant);
          if ((result.gaps ?? []).length > 0) {
            setSpokespersonStep("clarify");
          } else {
            requestSpokespersonScript();
          }
        },
        onError: () => {
          // Advisory only — fall through to the script with what we have.
          setIntake(null);
          requestSpokespersonScript();
        },
      },
    );
  };

  const changeEngine = (next: Engine) => {
    if (
      engine === "lip_sync" ||
      engine === "dialogue_lip_sync" ||
      next === "lip_sync" ||
      next === "dialogue_lip_sync"
    ) {
      resetSpokespersonFlow();
    }
    setEngine(next);
  };

  const requestSpokespersonScript = () => {
    const topic = spokespersonTopic.trim();
    if (topic.length < 3 || draftSpokespersonScript.isPending) return;
    setApprovedSpokespersonScript(null);
    setPrompt("");
    draftSpokespersonScript.mutate(
      { data: { topic, ...scriptRequestFields() } },
      {
        onSuccess: ({ script, beats, meta }) => {
          setSpokespersonScript(script);
          setScriptBeats(beats ?? []);
          setScriptMeta(meta ?? null);
          setSpokespersonStep("review");
        },
        onError: (error) => {
          toast({
            title: "Couldn't write the script",
            description: apiErrorMessage(error, "Please try again in a moment."),
            variant: "destructive",
          });
        },
      },
    );
  };

  const translateCharacterDialogueToTelugu = () => {
    const source = spokespersonSourceScript.trim();
    if (source.length < 3 || translateScript.isPending) return;
    const cues = characterTranslationCues(source, scriptDuration);
    if (cues.length === 0) return;
    const requestId = translationRequestRef.current + 1;
    translationRequestRef.current = requestId;

    translateScript.mutate(
      { data: { cues, locales: ["te"] } },
      {
        onSuccess: (result) => {
          if (translationRequestRef.current !== requestId) return;
          const track = result.tracks.find((candidate) => candidate.locale === "te");
          const translated = track?.cues
            .slice()
            .sort((a, b) => a.index - b.index)
            .map((cue) => cue.text.trim())
            .filter(Boolean)
            .join("\n\n");
          if (!track || !translated || translated.length < 3) {
            toast({
              title: "Could not translate this script",
              description: "No usable Telugu draft was returned. Your English source is unchanged.",
              variant: "destructive",
            });
            return;
          }
          const incompleteOrBlocked =
            track.blocked ||
            track.cues.length !== cues.length ||
            track.cues.some(
              (cue) =>
                cue.text.trim().length === 0 ||
                [...cue.issues, ...cue.cueIssues].some((issue) => issue.severity === "error"),
            );
          setSpokespersonScript(translated);
          setApprovedSpokespersonScript(null);
          setSpokespersonStep("review");
          setTeluguTranslationReady(true);
          setTeluguTranslationNeedsEdit(incompleteOrBlocked);
          setTranslationSpendPaise(result.spendPaise ?? null);
          void queryClient.invalidateQueries({ queryKey: getWalletGetOverviewQueryKey() });
          toast({
            title: "Telugu draft ready",
            description:
              result.spendPaise != null
                ? `${incompleteOrBlocked ? "The draft needs an edit before approval. " : "Review and edit it before approval. "}Charged ₹${(result.spendPaise / 100).toLocaleString("en-IN", {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}.`
                : incompleteOrBlocked
                  ? "The draft needs an edit before approval."
                  : "Review and edit it before approval.",
          });
        },
        onError: (error) => {
          if (translationRequestRef.current !== requestId) return;
          toast({
            title: "Could not translate this script",
            description: apiErrorMessage(error, "Your English source is unchanged. Please try again."),
            variant: "destructive",
          });
        },
      },
    );
  };

  const approveSpokespersonScript = () => {
    const script = spokespersonScript.trim();
    if (script.length < 3) {
      toast({
        title: "Add a little more to the script",
        description: "The spokesperson needs something meaningful to say.",
        variant: "destructive",
      });
      return;
    }
    setSpokespersonScript(script);
    setApprovedSpokespersonScript(script);
    setPrompt(script);
    if (engine === "dialogue_lip_sync") setDurationSec(scriptDuration);
    setSpokespersonStep("setup");
  };

  /** The saved plan rides along only when the form still matches it. A b-roll
   * plan fits both b-roll flavours (Ken Burns "ai" and animated "ai_video"). */
  const reusePlanActive =
    reusePlan != null &&
    engine === "topic_to_video" &&
    (reusePlan.flow === "character"
      ? visuals === "character"
      : visuals === "ai" || visuals === "ai_video");

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
    if (isCharacterDialogue && !characterDialogueDurationIsValid) {
      toast({
        title: "Increase the video length",
        description: `This script needs at least ${characterDialogueMinimumDurationSec} seconds so the full dialogue can be spoken.`,
        variant: "destructive",
      });
      return;
    }
    const missingTemplateInputs =
      selectedTemplate?.slots.filter((slot) => {
          if (!slot.required) return false;
          if (slot.kind === "script") {
            return isCharacterDialogue
              ? !approvedSpokespersonScript?.trim()
              : !prompt.trim();
          }
          if (slot.kind === "brand_kit" || slot.kind === "logo") return brandKitId == null;
          if (slot.kind === "character" || slot.kind === "saved_character") {
            return characterId == null;
          }
          if (slot.kind === "music") return !music && !musicPrompt.trim();
          if (slot.kind === "presenter_video") {
            return characterId == null && !presenterVideo;
          }
          return true;
        }) ?? [];
    if (missingTemplateInputs.length > 0) {
      toast({
        title: "Add the template’s required inputs",
        description: missingTemplateInputs.map((slot) => slot.label).join(", "),
        variant: "destructive",
      });
      return;
    }
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
    const finalPrompt =
      engine === "lip_sync"
        ? (approvedSpokespersonScript ?? "")
        : isCharacterDialogue
          ? spokespersonTopic.trim()
          : engine === "dialogue_lip_sync"
            ? aiPersonPrompt.trim()
            : prompt.trim();

    const payloadEngine = isCharacterDialogue ? "dialogue_lip_sync" : engine;

    generateVideo.mutate(
      {
        data: {
          engine: payloadEngine,
          planSource,
          prompt: finalPrompt || null,
          sourceImagePaths:
            engine === "text_to_video" || engine === "topic_to_video"
              ? []
              : engine === "image_to_video"
                ? photos.slice(0, 1).map((p) => p.objectPath)
                : photos.map((p) => p.objectPath),
          aspectRatio: aspect,
          durationSec: isCharacterDialogue ? scriptDuration : durationSec,
          motionPreset: engine === "slideshow" ? null : motionPreset,
          cinematography: engine === "slideshow" ? null : cinematography,
          modelId: engine === "slideshow" ? null : modelId,
          resolution: engine === "slideshow" ? null : resolution,
          quality: engine === "slideshow" ? null : quality,
          generateAudio:
            engine === "slideshow" || !selectedModel?.canGenerateAudio ? null : generateAudio,
          // Slideshows retain the original default timing now that this is no
          // longer an end-user setting.
          slideDurationSec: 3,
          overlayText: engine === "slideshow" && overlayText.trim() ? overlayText.trim() : null,
          musicPath: musicEnabled ? (music?.objectPath ?? null) : null,
          musicPrompt: musicEnabled && !music && musicPrompt.trim() ? musicPrompt.trim() : null,
          // "brand" = no explicit choice: the server uses the selected brand
          // kit's voice (cloned or preset) and falls back to the default.
          voice: isCharacterDialogue ? undefined : (voice === "brand" ? undefined : voice),
          stockSource,
          subtitles: isCharacterDialogue ? true : subtitles,
          captionStyle,
          paragraphCount,
          visualsSource: isCharacterDialogue
            ? selectedTemplate?.jobDefaults.visualsSource === "ai" ||
              selectedTemplate?.jobDefaults.visualsSource === "ai_video"
              ? selectedTemplate.jobDefaults.visualsSource
              : "stock"
            : payloadEngine === "topic_to_video"
              ? visuals
              : "stock",
          characterId:
            isCharacterDialogue || (engine === "topic_to_video" && visuals === "character") ||
            engine === "text_to_video" || isHybridCharacterStory
              ? characterId
              : null,
          outfitId:
            isCharacterDialogue || isHybridCharacterStory || (engine === "topic_to_video" && visuals === "character") ||
            engine === "text_to_video"
              ? outfitId
              : null,
          wardrobeNotes:
            engine === "topic_to_video" && visuals === "character" && !isCharacterDialogue && wardrobeNotes.trim()
              ? wardrobeNotes.trim()
              : null,
          brandKitId:
            isCharacterDialogue ||
            engine === "topic_to_video" ||
            engine === "lip_sync" ||
            engine === "dialogue_lip_sync"
              ? brandKitId
              : null,
          sourceVideoPath:
            engine === "lip_sync" && lipSyncSource === "video"
              ? (baseVideo?.objectPath ?? null)
              : null,
          sourceImagePath:
            engine === "lip_sync" && lipSyncSource === "portrait"
              ? (portrait?.objectPath ?? null)
              : null,
          audioPath: engine === "lip_sync" ? (voiceTrack?.objectPath ?? null) : null,
          lipSyncQuality:
            payloadEngine === "lip_sync" || payloadEngine === "dialogue_lip_sync"
              ? lipSyncQuality
              : undefined,
          presenterVideoPath:
            engine === "topic_to_video" && !isCharacterDialogue && templateRequiresPresenterVideo
              ? (presenterVideo?.objectPath ?? null)
              : null,
          lipSyncConsent: isCharacterDialogue || isHybridCharacterStory ? lipSyncConsent : (engine === "lip_sync" ? lipSyncConsent : false),
          dialogue: isCharacterDialogue ? (approvedSpokespersonScript ?? "") : (engine === "dialogue_lip_sync" ? (approvedSpokespersonScript ?? "") : null),
          aiPersonConsent: isCharacterDialogue
            ? lipSyncConsent
            : engine === "dialogue_lip_sync"
              ? aiPersonConsent
              : false,
          characterDialogue: isCharacterDialogue ? { scriptApproved: true, locale: characterDialogueLocale } : null,
          styleProfileId: engine === "topic_to_video" ? styleProfileId : null,
          shotCount: engine === "text_to_video" ? shotCount : 1,
          // Every engine reviews except topic mode's stock branch, whose
          // visuals are searched rather than prompted.
          reviewStoryboard: storyboardAvailable ? reviewStoryboard : false,
          // Carried for every engine so the render half writes with the same
          // rules the draft was written under.
          scriptVariant: scriptVariant ?? null,
        },
      },
      {
        onSuccess: (job) => {
          announcedRef.current = null;
          setActiveJobId(job.id);
          setReusePlan(null);
          if (payloadEngine === "lip_sync") {
            resetSpokespersonFlow();
          }
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
    const downloadPath = activeJob?.currentVideoPath ?? activeJob?.videoPath;
    if (!activeJob || !downloadPath) return;
    const fileName = `kokao-video-${activeJob.id}.mp4`;
    setDownloading(true);
    try {
      const res = await fetch(storageUrl(downloadPath), { credentials: "include" });
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
        `${storageUrl(downloadPath)}?download=${encodeURIComponent(fileName)}`,
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
    query: {
      queryKey: getWalletGetOverviewQueryKey(),
      refetchInterval: 30_000,
      refetchOnWindowFocus: true,
    },
  });

  /**
   * How many wallet units this configuration reserves — MUST mirror the
   * server's videoJobUnits (lib/videoGen/units.ts):
   * - text_to_video: one unit per shot (1..5)
   * - topic video with character visuals: 4 per paragraph (1..3 paragraphs)
   * - topic video with AI b-roll: 2 per paragraph
   * - topic video with animated AI b-roll: 3 per paragraph
   * - AI Dialogue: 2
   * - everything else: 1
   * - +1 for an AI-composed music bed (only when no uploaded track wins)
   */
  const estimatedUnits = useMemo(() => {
    let units = 1;
    if (templatePlansBeforeVisualFunding) {
      // The server reserves one planning unit, then shows the exact immutable
      // scene count and any remaining shortfall on the storyboard.
      units = 1;
    } else if (isCharacterDialogue) {
      units = 2 * characterDialogueSceneCount(
        approvedSpokespersonScript ?? spokespersonScript,
        selectedCharacterDialogueLocale,
      );
    } else if (engine === "text_to_video") {
      // Auto (0): the server decides from the script at enqueue; estimate the
      // typical resolved count so the wallet preview is meaningful without
      // over-blocking (the server enforces the real reservation).
      units = shotCount === 0 ? 3 : Math.min(10, Math.max(1, Math.trunc(shotCount) || 1));
    } else if (engine === "topic_to_video" && visuals === "character") {
      units =
        selectedTemplateRuntimeMaxScenes ??
        4 * Math.min(Math.max(Math.trunc(paragraphCount) || 1, 1), 3);
    } else if (engine === "topic_to_video" && visuals === "ai") {
      units =
        selectedTemplateRuntimeMaxScenes ??
        2 * Math.min(Math.max(Math.trunc(paragraphCount) || 1, 1), 3);
    } else if (engine === "topic_to_video" && visuals === "ai_video") {
      units =
        selectedTemplateRuntimeMaxScenes != null
          ? selectedTemplateRuntimeMaxScenes * 2
          : 3 * Math.min(Math.max(Math.trunc(paragraphCount) || 1, 1), 3);
    } else if (engine === "dialogue_lip_sync") {
      units = 2;
    }
    // Mirrors videoModelMultiplier: a picked model multiplies the GENERATION
    // count, and the music bed is added afterwards because it runs on
    // MusicGen whichever video model was chosen.
    if (engine !== "slideshow") units *= selectedModel?.unitMultiplier ?? 1;
    if (musicEnabled && !music && musicPrompt.trim()) units += 1;
    return units;
  }, [
    engine,
    shotCount,
    visuals,
    paragraphCount,
    musicEnabled,
    music,
    musicPrompt,
    isCharacterDialogue,
    approvedSpokespersonScript,
    spokespersonScript,
    selectedCharacterDialogueLocale,
    selectedModel,
    selectedTemplateRuntimeMaxScenes,
    templatePlansBeforeVisualFunding,
  ]);

  const walletUnitPaise = walletOverview?.rates?.videoPaise ?? 0;
  const walletReservationPaise = walletUnitPaise * estimatedUnits;
  const templatePlanningCeilingUnits = useMemo(() => {
    if (!templatePlansBeforeVisualFunding || selectedTemplateRuntimeMaxScenes == null) return null;
    const visualBase = visuals === "ai_video"
      ? selectedTemplateRuntimeMaxScenes * 2
      : selectedTemplateRuntimeMaxScenes;
    const multiplier = selectedModel?.unitMultiplier ?? 1;
    return Math.max(
      1,
      visualBase * multiplier + (musicEnabled && !music && musicPrompt.trim() ? 1 : 0),
    );
  }, [
    templatePlansBeforeVisualFunding,
    selectedTemplateRuntimeMaxScenes,
    visuals,
    selectedModel,
    musicEnabled,
    music,
    musicPrompt,
  ]);
  const videoModelCostEstimate = useMemo<VideoModelCostEstimate | undefined>(() => {
    const costModels = videoCapabilities?.costModels;
    if (!costModels) return undefined;

    const components: {
      model: VideoCostModel | null;
      operations: number;
      totalDurationSec: number;
      inputMode: "video" | "non_video";
    }[] = [];
    if (isCharacterDialogue) {
      const scenes = characterDialogueSceneCount(
        approvedSpokespersonScript ?? spokespersonScript,
        selectedCharacterDialogueLocale,
      );
      components.push(
        {
          model: costModels.imageToVideo,
          operations: scenes,
          totalDurationSec: scriptDuration,
          inputMode: "non_video",
        },
        {
          model:
            lipSyncQuality === "high" ? costModels.lipSyncHigh : costModels.lipSync,
          operations: scenes,
          totalDurationSec: scriptDuration,
          inputMode: "video",
        },
      );
    } else if (engine === "dialogue_lip_sync") {
      components.push(
        {
          model: costModels.textToVideo,
          operations: 1,
          totalDurationSec: durationSec,
          inputMode: "non_video",
        },
        {
          model:
            lipSyncQuality === "high" ? costModels.lipSyncHigh : costModels.lipSync,
          operations: 1,
          totalDurationSec: durationSec,
          inputMode: "video",
        },
      );
    } else if (engine === "text_to_video") {
      const shots =
        shotCount === 0 ? 3 : Math.min(10, Math.max(1, Math.trunc(shotCount) || 1));
      components.push({
        model: costModels.textToVideo,
        operations: shots,
        totalDurationSec: durationSec * shots,
        inputMode: "non_video",
      });
    } else if (engine === "image_to_video") {
      components.push({
        model: costModels.imageToVideo,
        operations: 1,
        totalDurationSec: durationSec,
        inputMode: "non_video",
      });
    } else {
      // Topic-video clip lengths/models are not final until its storyboard is
      // planned. Slideshows are local renders. A confident rupee amount here
      // would be the same misleading flat-rate estimate this replaces.
      return { available: false };
    }

    const costs = components.map((component) =>
      estimateModelComponent(
        component.model,
        component.operations,
        component.totalDurationSec,
        {
          inputMode: component.inputMode,
          ...(resolution ? { resolution } : {}),
          ...(quality ? { quality } : {}),
          generateAudio,
        },
      ),
    );
    const knownCosts = costs.filter((cost): cost is number => cost !== null);
    if (knownCosts.length !== costs.length) return { available: false };
    return {
      available: true,
      totalPaise: knownCosts.reduce((total, cost) => total + cost, 0),
      operations: components.reduce((total, component) => total + component.operations, 0),
      models: [
        ...new Set(
          components
            .map((component) => component.model?.model)
            .filter((model): model is string => Boolean(model)),
        ),
      ],
      durationSec: isCharacterDialogue ? scriptDuration : durationSec,
    };
  }, [
    videoCapabilities?.costModels,
    isCharacterDialogue,
    approvedSpokespersonScript,
    spokespersonScript,
    selectedCharacterDialogueLocale,
    durationSec,
    scriptDuration,
    engine,
    shotCount,
    lipSyncQuality,
    resolution,
    quality,
    generateAudio,
  ]);
  // Nothing renders while the admin has not set a video rate (a 0 estimate is
  // meaningless) or the workspace is not wallet-billed.
  const showWalletEstimate =
    walletBilling && walletOverview != null && walletUnitPaise > 0;
  const walletShortfall =
    showWalletEstimate && walletReservationPaise > (walletOverview?.balancePaise ?? 0);

  const rupees = (paise: number) =>
    (paise / 100).toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  const lipSyncHighAvailable = videoCapabilities?.costModels?.lipSyncHigh != null;
  const lipSyncRateLabel = (model: VideoCostModel | null | undefined): string => {
    if (model?.paisePerSecond != null) return `₹${rupees(model.paisePerSecond)}/output second`;
    if (model?.paisePerVideo != null) return `₹${rupees(model.paisePerVideo)}/generation`;
    return "pricing unavailable";
  };
  const lipSyncQualityPicker = (
    <div className="space-y-2" data-testid="lipsync-quality-picker">
      <Label id="lipsync-quality-label">Lip-sync quality</Label>
      <ToggleGroup
        type="single"
        value={lipSyncQuality}
        onValueChange={(value) => value && setLipSyncQuality(value as LipSyncQuality)}
        aria-labelledby="lipsync-quality-label"
        className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2"
      >
        <ToggleGroupItem
          value="standard"
          aria-describedby="lipsync-quality-standard-description"
          className="group h-auto min-h-[92px] justify-start rounded-xl border border-border px-4 py-3 text-left shadow-sm transition-all hover:border-primary/50 hover:bg-primary/5 data-[state=on]:border-primary data-[state=on]:bg-primary/10 data-[state=on]:shadow-md"
          data-testid="toggle-lipsync-quality-standard"
        >
          <span className="flex w-full flex-col items-start gap-1">
            <span className="text-sm font-semibold">Standard</span>
            <span className="text-xs text-muted-foreground">LatentSync · dependable everyday lip-sync</span>
            <span className="grid w-full grid-rows-[0fr] text-xs text-muted-foreground opacity-0 transition-all duration-200 group-hover:grid-rows-[1fr] group-hover:opacity-100 group-focus-visible:grid-rows-[1fr] group-focus-visible:opacity-100">
              <span className="min-h-0 overflow-hidden pt-0.5">
                <span id="lipsync-quality-standard-description" data-testid="lipsync-quality-standard-description">
                  Reliable lip-sync at the lower provider cost. Works with portrait and video sources.
                </span>
              </span>
            </span>
          </span>
        </ToggleGroupItem>
        <ToggleGroupItem
          value="high"
          disabled={!lipSyncHighAvailable}
          aria-describedby="lipsync-quality-high-description"
          className="group h-auto min-h-[92px] justify-start rounded-xl border border-border px-4 py-3 text-left shadow-sm transition-all hover:border-primary/50 hover:bg-primary/5 data-[state=on]:border-primary data-[state=on]:bg-primary/10 data-[state=on]:shadow-md"
          data-testid="toggle-lipsync-quality-high"
        >
          <span className="flex w-full flex-col items-start gap-1">
            <span className="text-sm font-semibold">High Quality</span>
            <span className="text-xs text-muted-foreground">sync/lipsync-2 · higher mouth alignment</span>
            <span className="grid w-full grid-rows-[0fr] text-xs text-muted-foreground opacity-0 transition-all duration-200 group-hover:grid-rows-[1fr] group-hover:opacity-100 group-focus-visible:grid-rows-[1fr] group-focus-visible:opacity-100">
              <span className="min-h-0 overflow-hidden pt-0.5">
                <span id="lipsync-quality-high-description" data-testid="lipsync-quality-high-description">
                  Higher-quality lip-sync for video sources. It costs more per output second and unlocks when pricing is configured.
                </span>
              </span>
            </span>
          </span>
        </ToggleGroupItem>
      </ToggleGroup>
      <p className="text-xs text-muted-foreground" data-testid="text-lipsync-quality-price">
        {lipSyncQuality === "high"
          ? `sync/lipsync-2 · $0.05/output second provider rate · ${lipSyncRateLabel(videoCapabilities?.costModels?.lipSyncHigh)}`
          : `LatentSync · ${lipSyncRateLabel(videoCapabilities?.costModels?.lipSync)}`}
        {!lipSyncHighAvailable && " · High Quality will unlock when its Replicate price is available."}
      </p>
      <p className="text-xs text-muted-foreground" data-testid="text-lipsync-source-guidance">
        For clear mouth movement, use a well-lit, front-facing clip with one visible speaker
        already talking naturally. Still or closed-mouth footage may stay closed even in High Quality.
      </p>
    </div>
  );

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

  if (availableEngines.length === 0) {
    return <FeatureDisabledNotice label="Video Studio modes" />;
  }

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

      <Tabs value={engine} onValueChange={(v) => changeEngine(v as Engine)}>
        <TabsList
          className="grid w-full grid-cols-2 sm:grid-cols-3 lg:grid-cols-6"
        >
          {flags.videoTextToVideo && (
            <TabsTrigger value="text_to_video" data-testid="tab-text-to-video">
              <Sparkles className="h-4 w-4 mr-1.5" /> Text to Video
            </TabsTrigger>
          )}
          {flags.videoAnimatePhoto && (
            <TabsTrigger value="image_to_video" data-testid="tab-image-to-video">
              <ImageIcon className="h-4 w-4 mr-1.5" /> Animate Photo
            </TabsTrigger>
          )}
          {flags.videoSlideshow && (
            <TabsTrigger value="slideshow" data-testid="tab-slideshow">
              <Images className="h-4 w-4 mr-1.5" /> Slideshow
            </TabsTrigger>
          )}
          {flags.videoTopicToVideo && (
            <TabsTrigger value="topic_to_video" data-testid="tab-topic-to-video">
              <Lightbulb className="h-4 w-4 mr-1.5" /> Topic to Video
            </TabsTrigger>
          )}
          {flags.lipSync && (
            <TabsTrigger value="lip_sync" data-testid="tab-lip-sync">
              <UserRound className="h-4 w-4 mr-1.5" /> Spokesperson
            </TabsTrigger>
          )}
          {flags.lipSync && (
            <TabsTrigger value="dialogue_lip_sync" data-testid="tab-dialogue-lip-sync">
              <UserRound className="h-4 w-4 mr-1.5" /> AI Dialogue
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
          {(engine === "lip_sync" || engine === "dialogue_lip_sync") && (
            <div className="space-y-5" data-testid="spokesperson-script-flow">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {SPOKESPERSON_STEPS.filter(
                  // The clarify step only exists when the intake pass found
                  // something worth asking about; showing a step that never
                  // arrives makes the flow look longer than it is.
                  (step) =>
                    step.key !== "clarify" ||
                    spokespersonStep === "clarify" ||
                    (intake?.gaps?.length ?? 0) > 0,
                ).map((step, index, visible) => {
                  const active = spokespersonStep === step.key;
                  const currentIndex = visible.findIndex(
                    (candidate) => candidate.key === spokespersonStep,
                  );
                  const complete = currentIndex > index;
                  return (
                    <div key={step.key} className="flex items-center gap-2">
                      {index > 0 && <span className="text-muted-foreground">→</span>}
                      <Badge variant={active ? "default" : "outline"}>
                        {complete && <CheckCircle2 className="h-3 w-3 mr-1" />}
                        {index + 1}. {step.label}
                      </Badge>
                    </div>
                  );
                })}
              </div>

              {spokespersonStep === "type" && (
                <div className="space-y-3" data-testid="spokesperson-type-picker">
                  <div>
                    <Label>What kind of video is this?</Label>
                    <p className="text-xs text-muted-foreground mt-1">
                      It changes how the script is structured — the hook, the order of
                      ideas, and how it closes.
                    </p>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {(Object.keys(VARIANT_META) as ScriptVariant[]).map((variant) => (
                      <button
                        key={variant}
                        type="button"
                        onClick={() => chooseScriptVariant(variant)}
                        disabled={busy}
                        data-testid={`button-variant-${variant}`}
                        className="rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-primary hover:bg-accent/40 disabled:opacity-50"
                      >
                        <p className="text-sm font-medium">{VARIANT_META[variant].title}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {VARIANT_META[variant].blurb}
                        </p>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {spokespersonStep === "topic" && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <Label htmlFor="spokesperson-topic">What should your video be about?</Label>
                    <VoiceNoteButton
                      testId="button-voice-spokesperson-topic"
                      onTranscript={(text) =>
                        setSpokespersonTopic((previous) =>
                          previous ? `${previous} ${text}` : text,
                        )
                      }
                      disabled={draftSpokespersonScript.isPending || busy}
                    />
                  </div>
                  <Textarea
                    id="spokesperson-topic"
                    data-testid="input-spokesperson-topic"
                    placeholder="For example: Explain why small businesses should plan their social content one week ahead..."
                    value={spokespersonTopic}
                    onChange={(event) => setSpokespersonTopic(event.target.value)}
                    rows={4}
                    maxLength={2000}
                  />
                  <p className="text-xs text-muted-foreground">
                    Give KOKAO the topic, key points, offer, or audience. You can type it or
                    record a voice note.
                  </p>
                  <div className="space-y-2">
                    <Label>How long should it run?</Label>
                    <ToggleGroup
                      type="single"
                      value={String(scriptDuration)}
                      onValueChange={(value) => value && setScriptDuration(Number(value))}
                      className="justify-start flex-wrap"
                      data-testid="select-script-duration"
                    >
                      {(engine === "dialogue_lip_sync"
                        ? DURATION_CHOICES.filter((seconds) => seconds <= MAX_DIALOGUE_DURATION_SEC)
                        : DURATION_CHOICES
                      ).map((seconds) => (
                        <ToggleGroupItem key={seconds} value={String(seconds)}>
                          {seconds}s
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setSpokespersonStep("type")}
                      data-testid="button-back-to-spokesperson-type"
                    >
                      <ChevronLeft className="h-4 w-4 mr-1.5" /> Back
                    </Button>
                    <Button
                      type="button"
                      onClick={startScriptFromTopic}
                      disabled={
                        spokespersonTopic.trim().length < 3 ||
                        runScriptIntake.isPending ||
                        draftSpokespersonScript.isPending ||
                        busy
                      }
                      data-testid="button-generate-spokesperson-script"
                    >
                      {runScriptIntake.isPending ? (
                        <>
                          <RippleSpinner className="h-4 w-4 mr-2" /> Reading your topic…
                        </>
                      ) : draftSpokespersonScript.isPending ? (
                        <>
                          <RippleSpinner className="h-4 w-4 mr-2" /> Writing script…
                        </>
                      ) : (
                        <>
                          <Sparkles className="h-4 w-4 mr-2" /> Generate script
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              )}

              {spokespersonStep === "clarify" && (
                <div className="space-y-4" data-testid="spokesperson-clarify">
                  <div>
                    <Label>A couple of details</Label>
                    <p className="text-xs text-muted-foreground mt-1">
                      Everything else came from your brand kit. Skip any of these and
                      KOKAO uses its defaults.
                    </p>
                  </div>

                  {sourceFacts.length > 0 && (
                    <div className="space-y-2">
                      <Label className="text-xs">Facts KOKAO found in your topic</Label>
                      <div className="flex flex-wrap gap-1.5">
                        {sourceFacts.map((fact, index) => (
                          <Badge
                            key={`${fact}-${index}`}
                            variant="secondary"
                            className="gap-1 py-1"
                            data-testid={`chip-fact-${index}`}
                          >
                            {fact}
                            <button
                              type="button"
                              aria-label={`Remove fact: ${fact}`}
                              onClick={() =>
                                setSourceFacts((facts) =>
                                  facts.filter((_, i) => i !== index),
                                )
                              }
                              className="ml-0.5 text-muted-foreground hover:text-foreground"
                            >
                              ×
                            </button>
                          </Badge>
                        ))}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        These are the only claims the script will state as fact. Remove
                        anything wrong — the rest gets flagged for you to check, never
                        invented.
                      </p>
                    </div>
                  )}

                  {(intake?.gaps ?? []).map((gap) => {
                    const question = CLARIFY_QUESTIONS[gap];
                    if (!question) return null;
                    return (
                      <div key={gap} className="space-y-2">
                        <Label htmlFor={`clarify-${gap}`}>{question.prompt}</Label>
                        {question.chips.length > 0 && (
                          <div className="flex flex-wrap gap-1.5">
                            {question.chips.map((chip) => (
                              <Button
                                key={chip}
                                type="button"
                                size="sm"
                                variant={clarify[gap] === chip ? "default" : "outline"}
                                onClick={() =>
                                  setClarify((current) => ({
                                    ...current,
                                    [gap]: current[gap] === chip ? "" : chip,
                                  }))
                                }
                                data-testid={`chip-${gap}-${chip.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
                              >
                                {chip}
                              </Button>
                            ))}
                          </div>
                        )}
                        <Textarea
                          id={`clarify-${gap}`}
                          data-testid={`input-clarify-${gap}`}
                          value={clarify[gap] ?? ""}
                          onChange={(event) =>
                            setClarify((current) => ({
                              ...current,
                              [gap]: event.target.value,
                            }))
                          }
                          placeholder={question.placeholder}
                          rows={gap === "sourceFacts" ? 4 : 2}
                          maxLength={gap === "sourceFacts" ? 2000 : 500}
                        />
                      </div>
                    );
                  })}

                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setSpokespersonStep("topic")}
                      data-testid="button-back-to-spokesperson-topic-from-clarify"
                    >
                      <ChevronLeft className="h-4 w-4 mr-1.5" /> Back
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        setClarify({});
                        requestSpokespersonScript();
                      }}
                      disabled={draftSpokespersonScript.isPending || busy}
                      data-testid="button-skip-clarify"
                    >
                      Skip — use my defaults
                    </Button>
                    <Button
                      type="button"
                      onClick={requestSpokespersonScript}
                      disabled={draftSpokespersonScript.isPending || busy}
                      data-testid="button-clarify-continue"
                    >
                      {draftSpokespersonScript.isPending ? (
                        <>
                          <RippleSpinner className="h-4 w-4 mr-2" /> Writing script…
                        </>
                      ) : (
                        <>
                          <Sparkles className="h-4 w-4 mr-2" /> Write the script
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              )}

              {spokespersonStep === "review" && (
                <div className="space-y-3">
                  <div>
                    <Label htmlFor="spokesperson-script">Review your script</Label>
                    <p className="text-xs text-muted-foreground mt-1">
                       Read it aloud and make any changes. The approved text is exactly what
                       {engine === "dialogue_lip_sync" ? " your AI person will say." : " your spokesperson will say."}
                    </p>
                  </div>

                  {scriptMeta && (
                    <div
                      className="flex flex-wrap gap-2 text-xs text-muted-foreground"
                      data-testid="script-meta"
                    >
                      <Badge variant="outline">{scriptMeta.wordCount} words</Badge>
                      <Badge variant="outline">
                        about {Math.round(scriptMeta.estimatedDurationSec)}s
                      </Badge>
                      {scriptVariant && (
                        <Badge variant="outline">{VARIANT_META[scriptVariant].title}</Badge>
                      )}
                    </div>
                  )}

                  {(scriptMeta?.openItems?.length ?? 0) > 0 && (
                    <div
                      className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 space-y-1.5"
                      data-testid="script-open-items"
                    >
                      <p className="text-sm font-medium">Check these before you record</p>
                      <ul className="list-disc pl-5 text-xs text-muted-foreground space-y-1">
                        {scriptMeta!.openItems.map((item, index) => (
                          <li key={`${item}-${index}`}>{item}</li>
                        ))}
                      </ul>
                      <p className="text-xs text-muted-foreground">
                        KOKAO would not invent these. Confirm each one, or edit the script
                        to drop it.
                      </p>
                    </div>
                  )}
                  <Textarea
                    id="spokesperson-script"
                    data-testid="input-spokesperson-script"
                    value={spokespersonScript}
                    onChange={(event) => {
                      setSpokespersonScript(event.target.value);
                      setApprovedSpokespersonScript(null);
                      setPrompt("");
                    }}
                    rows={10}
                    // Matches the server's duration-scaled ceiling; the old
                    // 2000 silently truncated anything past ~45 seconds.
                    maxLength={8000}
                  />
                  {scriptBeats.length > 0 && (
                    <details
                      className="rounded-lg border border-border bg-muted/20 p-3"
                      data-testid="script-beats"
                    >
                      <summary className="cursor-pointer text-sm font-medium">
                        Production notes · {scriptBeats.length} beats
                      </summary>
                      <div className="mt-3 space-y-3">
                        {scriptBeats.map((beat, index) => (
                          <div
                            key={beat.id}
                            className="rounded-md border border-border/60 bg-background p-2.5 space-y-1"
                            data-testid={`beat-${beat.id}`}
                          >
                            <div className="flex flex-wrap items-center gap-2 text-xs">
                              <span className="font-medium">
                                {index + 1}. {beat.label}
                              </span>
                              <Badge variant="outline">{Math.round(beat.durationSec)}s</Badge>
                              <Badge variant="outline">{beat.framing}</Badge>
                            </div>
                            <p className="text-xs">{beat.spoken}</p>
                            {beat.onScreen && (
                              <p className="text-xs text-muted-foreground">
                                On screen: {beat.onScreen}
                              </p>
                            )}
                            {beat.bRoll && (
                              <p className="text-xs text-muted-foreground">
                                Visual: {beat.bRoll}
                              </p>
                            )}
                            {beat.note && (
                              <p className="text-xs text-muted-foreground italic">
                                {beat.note}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        Cues in square brackets are direction for you and your editor. They
                        are never spoken.
                      </p>
                    </details>
                  )}

                  {(scriptMeta?.pronunciations?.length ?? 0) > 0 && (
                    <div className="text-xs text-muted-foreground" data-testid="script-pronunciations">
                      <span className="font-medium">Say it as: </span>
                      {scriptMeta!.pronunciations
                        .map((p) => `${p.term} → ${p.saidAs}`)
                        .join(" · ")}
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setApprovedSpokespersonScript(null);
                        setPrompt("");
                        setSpokespersonStep("topic");
                      }}
                      data-testid="button-back-to-spokesperson-topic"
                    >
                      <ChevronLeft className="h-4 w-4 mr-1.5" /> Back to topic
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={requestSpokespersonScript}
                      disabled={draftSpokespersonScript.isPending || busy}
                      data-testid="button-regenerate-spokesperson-script"
                    >
                      {draftSpokespersonScript.isPending ? (
                        <>
                          <RippleSpinner className="h-4 w-4 mr-2" /> Rewriting…
                        </>
                      ) : (
                        <>
                          <Sparkles className="h-4 w-4 mr-2" /> Regenerate
                        </>
                      )}
                    </Button>
                    <Button
                      type="button"
                      onClick={approveSpokespersonScript}
                      disabled={spokespersonScript.trim().length < 3}
                      data-testid="button-approve-spokesperson-script"
                    >
                      <CheckCircle2 className="h-4 w-4 mr-1.5" /> Approve script
                    </Button>
                  </div>
                </div>
              )}

              {spokespersonStep === "setup" && approvedSpokespersonScript && (
                <div
                  className="rounded-lg border border-border bg-muted/30 p-4 space-y-3"
                  data-testid="approved-spokesperson-script"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-primary" />
                      <p className="font-medium text-sm">Script approved</p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setApprovedSpokespersonScript(null);
                        setPrompt("");
                        setSpokespersonStep("review");
                      }}
                      data-testid="button-edit-spokesperson-script"
                    >
                      Edit script
                    </Button>
                  </div>
                  <p className="text-sm whitespace-pre-wrap">{approvedSpokespersonScript}</p>
                </div>
              )}
            </div>
          )}

          {engine !== "slideshow" && engine !== "lip_sync" && engine !== "dialogue_lip_sync" && !isCharacterDialogue && (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="video-prompt">
                  {engine === "text_to_video"
                    ? "Describe your video"
                    : engine === "topic_to_video"
                      ? "What's your video about?"
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
              {flags.referenceStyles && (
                <section
                  className="rounded-xl border border-border bg-muted/20 p-4 space-y-4"
                  data-testid="video-templates-section"
                >
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Label className="text-base">Video templates</Label>
                      <Badge variant="secondary">Curated by KOKAO</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      Start with a proven format. You keep control of the topic, brand, and any
                      required assets.
                    </p>
                  </div>

                  {curatedTemplates.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-border bg-background/60 px-3 py-4 text-sm text-muted-foreground">
                      No curated templates are published yet. Your saved reference styles are
                      still available below.
                    </p>
                  ) : (
                    <div className="grid gap-3 sm:grid-cols-2">
                      {curatedTemplates.map((template) => {
                        const requiredSlots = template.slots.filter((slot) => slot.required);
                        const isSelected = selectedTemplate?.id === template.id;
                        return (
                          <Card
                            key={template.id}
                            className={isSelected ? "border-primary ring-1 ring-primary/30" : undefined}
                            data-testid={`video-template-${template.id}`}
                          >
                            <CardHeader className="space-y-1 pb-3">
                              <div className="flex items-start justify-between gap-3">
                                <CardTitle className="text-base">{template.name}</CardTitle>
                                {isSelected && <Badge>Selected</Badge>}
                              </div>
                              {template.summary && (
                                <CardDescription>{template.summary}</CardDescription>
                              )}
                            </CardHeader>
                            <CardContent className="space-y-3">
                              <p className="text-xs text-muted-foreground">
                                Estimated cost: {template.estimatedUnits} video{" "}
                                {template.estimatedUnits === 1 ? "unit" : "units"}
                              </p>
                              {requiredSlots.length > 0 && (
                                <div className="space-y-1.5">
                                  <p className="text-xs font-medium">You’ll need</p>
                                  <ul className="space-y-1 text-xs text-muted-foreground">
                                    {requiredSlots.map((slot) => (
                                      <li key={slot.kind}>
                                        <span className="font-medium text-foreground">{slot.label}</span>
                                        {slot.hint ? ` — ${slot.hint}` : ""}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                              <Button
                                type="button"
                                variant={isSelected ? "secondary" : "outline"}
                                size="sm"
                                className="w-full"
                                onClick={() => chooseVideoTemplate(template)}
                                data-testid={`button-use-video-template-${template.id}`}
                              >
                                {isSelected ? "Template selected" : "Use this template"}
                              </Button>
                            </CardContent>
                          </Card>
                        );
                      })}
                    </div>
                  )}
                </section>
              )}
              {isHybridCharacterStory && (
                <section className="rounded-xl border border-primary/30 bg-primary/5 p-4 space-y-3" data-testid="hybrid-character-consent">
                  <div>
                    <p className="font-medium">Hybrid character storyteller</p>
                    <p className="text-sm text-muted-foreground">
                      Your saved character opens and closes on camera. Story scenes use the same narration as voice-over.
                    </p>
                  </div>
                  <label className="flex items-start gap-3 text-sm cursor-pointer">
                    <Checkbox checked={lipSyncConsent} onCheckedChange={(checked) => setLipSyncConsent(checked === true)} data-testid="checkbox-hybrid-lipsync-consent" />
                    <span>I own this character or have permission to make them appear to say this approved script.</span>
                  </label>
                </section>
              )}

              {templateRequiresPresenterVideo && (
                <section
                  className="rounded-xl border border-primary/30 bg-primary/5 p-4 space-y-3"
                  data-testid="presenter-video-upload"
                >
                  <div className="space-y-1">
                    <Label className="text-base">Presenter video required</Label>
                    <p className="text-sm text-muted-foreground">
                      Upload a take with the presenter already speaking the script. This format uses
                      that recording’s real face, mouth movement, and voice — it does not generate or
                      lip-sync a character. We’ll verify the words, then cut it with the supporting
                      visuals you choose below.
                    </p>
                  </div>
                  {presenterVideo ? (
                    <div className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm">
                      <Film className="h-4 w-4 shrink-0 text-primary" />
                      <span className="truncate" data-testid="text-presenter-video-name">
                        {presenterVideo.name}
                      </span>
                      <button
                        type="button"
                        aria-label="Remove presenter video"
                        onClick={() => setPresenterVideo(null)}
                        className="ml-auto"
                        data-testid="button-remove-presenter-video"
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
                      onClick={() => presenterVideoInputRef.current?.click()}
                      data-testid="button-upload-presenter-video"
                    >
                      <Upload className="mr-1.5 h-4 w-4" /> Upload presenter video
                    </Button>
                  )}
                  <input
                    ref={presenterVideoInputRef}
                    type="file"
                    accept={PRESENTER_VIDEO_TYPES.join(",")}
                    className="hidden"
                    data-testid="input-presenter-video"
                    onChange={(e) => void handlePresenterVideoFile(e.target.files)}
                  />
                  <p className="text-xs text-muted-foreground">
                    MP4, MOV, or WebM, up to {MAX_PRESENTER_VIDEO_MB} MB.
                  </p>
                </section>
              )}

              <Label>Visuals</Label>
              <ToggleGroup
                type="single"
                variant="outline"
                value={visuals}
                onValueChange={(v) => v && setVisuals(v as "stock" | "character" | "ai" | "ai_video")}
              >
                <ToggleGroupItem value="stock" data-testid="toggle-visuals-stock">
                  Stock footage
                </ToggleGroupItem>
                <ToggleGroupItem value="ai" data-testid="toggle-visuals-ai">
                  AI imagery
                </ToggleGroupItem>
                <ToggleGroupItem value="ai_video" data-testid="toggle-visuals-ai-video">
                  Animated AI
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
              {visuals === "ai_video" && (
                <p className="text-xs text-muted-foreground">
                  Every scene's visual is generated for your topic, then animated
                  into a real AI motion clip — fully owned, no stock licensing.
                  Costs 3 video units per paragraph.
                </p>
              )}
              {(visuals === "character" || isHybridCharacterStory) && (
                <div className="space-y-4">
                  {!isHybridCharacterStory && <div className="flex items-center justify-between border-b border-border pb-3">
                    <Label className="text-base font-medium">Character Mode</Label>
                    <ToggleGroup
                      type="single"
                      variant="outline"
                      value={characterMode}
                      onValueChange={(v) => v && setCharacterMode(v as "story" | "dialogue")}
                    >
                      <ToggleGroupItem value="story" data-testid="toggle-character-mode-story">Story</ToggleGroupItem>
                      <ToggleGroupItem value="dialogue" data-testid="toggle-character-mode-dialogue">Character Dialogue</ToggleGroupItem>
                    </ToggleGroup>
                  </div>}
                  {isHybridCharacterStory && (
                    <p className="text-xs text-muted-foreground">
                      Hybrid story uses your locked character for speaking beats and AI animation for story beats.
                    </p>
                  )}
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
                  {!isHybridCharacterStory && characterMode === "story" && (
                    <div className="space-y-3">
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

                  {characterMode === "dialogue" && (
                    <div className="space-y-4 pt-1">
                      <div
                        className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground"
                        data-testid="character-dialogue-format-note"
                      >
                        Character Dialogue creates full-screen speaking-character scenes. Presenter
                        templates such as Expert Explainer use an uploaded talking presenter with
                        B-roll and are not combined with this mode.
                      </div>
                      {(() => {
                        const hasCharacter = characters && characters.length > 0;
                        if (!hasCharacter || characterDialogueBrandKits.length === 0) {
                          return (
                            <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 space-y-3" data-testid="dialogue-setup-guidance">
                              <div>
                                <p className="text-sm font-medium">Missing requirements</p>
                                <p className="text-xs text-muted-foreground mt-1">
                                  Character Dialogue requires a saved character and an active Brand Kit with an ElevenLabs cloned voice.
                                </p>
                              </div>
                              <div className="flex gap-3">
                                {!hasCharacter && (
                                  <Button variant="outline" size="sm" onClick={() => setCharactersOpen(true)}>Manage Characters</Button>
                                )}
                                {characterDialogueBrandKits.length === 0 && (
                                  <Button variant="outline" size="sm" onClick={() => navigate("/brand-kits")}>Manage Brand Kits</Button>
                                )}
                              </div>
                            </div>
                          );
                        }

                        return (
                          <div className="space-y-4">
                            <div className="grid sm:grid-cols-2 gap-4">
                              <div className="space-y-2">
                                <Label>Language</Label>
                                <Select
                                  value={characterDialogueLocale}
                                  onValueChange={(locale) => {
                                    setCharacterDialogueLocale(locale);
                                    setSpokespersonSourceScript("");
                                    setSpokespersonScript("");
                                    setApprovedSpokespersonScript(null);
                                    setSpokespersonStep("topic");
                                    setTeluguTranslationReady(false);
                                    setTeluguTranslationNeedsEdit(false);
                                    setTranslationSpendPaise(null);
                                    translationRequestRef.current += 1;
                                  }}
                                >
                                  <SelectTrigger data-testid="select-character-dialogue-locale">
                                    <SelectValue placeholder="Select a language" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {videoCapabilities?.characterDialogueLocales.map((loc) => (
                                      <SelectItem key={loc.code} value={loc.code}>
                                        {loc.label}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                              <div className="space-y-2">
                                <Label>Brand Voice (Cloned)</Label>
                                <Select value={brandKitId ? String(brandKitId) : ""} onValueChange={(v) => setBrandKitId(Number(v))}>
                                  <SelectTrigger data-testid="select-character-dialogue-brand-kit">
                                    <SelectValue placeholder="Select a Brand Kit" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {characterDialogueBrandKits.map((bk) => (
                                      <SelectItem key={bk.id} value={String(bk.id)}>
                                        <span>{bk.name}</span>
                                        <span className="text-muted-foreground">
                                          {" "}· {clonedVoiceMetadata(bk)}
                                        </span>
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                            </div>

                            <div className="space-y-2">
                              <div className="flex items-center justify-between gap-2">
                                <Label htmlFor="character-dialogue-topic">What should they say?</Label>
                                <VoiceNoteButton
                                  testId="button-voice-character-dialogue-topic"
                                  onTranscript={(text) =>
                                    setSpokespersonTopic((prev) => (prev ? `${prev} ${text}` : text))
                                  }
                                />
                              </div>
                              <Textarea
                                id="character-dialogue-topic"
                                data-testid="input-spokesperson-topic"
                                value={spokespersonTopic}
                                  onChange={(e) => {
                                    setSpokespersonTopic(e.target.value);
                                    setApprovedSpokespersonScript(null);
                                  }}
                                placeholder="Give KOKAO the topic, key points, offer, or audience..."
                                rows={4}
                              />
                              <div className="flex gap-2 items-end pt-1">
                                <div className="space-y-2">
                                  <Label htmlFor="character-dialogue-duration">Video length</Label>
                                  <Select
                                    value={String(scriptDuration)}
                                    onValueChange={(v) => {
                                      const seconds = Number(v);
                                      setScriptDuration(seconds);
                                      setDurationSec(seconds);
                                    }}
                                  >
                                    <SelectTrigger
                                      id="character-dialogue-duration"
                                      className="w-[140px]"
                                      data-testid="select-character-dialogue-duration"
                                      aria-invalid={!characterDialogueDurationIsValid}
                                    >
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {characterDialogueDurationOptions.map((d) => (
                                        <SelectItem key={d} value={String(d)}>
                                          {d} seconds
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </div>
                                <Button
                                  variant="secondary"
                                  onClick={() => {
                                    draftSpokespersonScript.mutate(
                                      {
                                        data: {
                                          topic: spokespersonTopic,
                                          durationSeconds: scriptDuration,
                                          ...(isTeluguCharacterDialogue
                                            ? {}
                                            : { targetLocale: characterDialogueLocale }),
                                        },
                                      },
                                      {
                                        onSuccess: (res) => {
                                          if (isTeluguCharacterDialogue) {
                                            setSpokespersonSourceScript(res.script);
                                            setSpokespersonScript("");
                                            setTeluguTranslationReady(false);
                                            setTeluguTranslationNeedsEdit(false);
                                            setTranslationSpendPaise(null);
                                          } else {
                                            setSpokespersonSourceScript("");
                                            setSpokespersonScript(res.script);
                                            setTeluguTranslationReady(false);
                                            setTeluguTranslationNeedsEdit(false);
                                          }
                                          setApprovedSpokespersonScript(null);
                                          setSpokespersonStep("review");
                                          translationRequestRef.current += 1;
                                        },
                                        onError: (error) => {
                                          toast({
                                            title: "Couldn't write the script",
                                            description: apiErrorMessage(
                                              error,
                                              "Please try again in a moment.",
                                            ),
                                            variant: "destructive",
                                          });
                                        },
                                      }
                                    );
                                  }}
                                  disabled={!spokespersonTopic.trim() || draftSpokespersonScript.isPending}
                                  data-testid="button-generate-spokesperson-script"
                                >
                                  {draftSpokespersonScript.isPending && <RippleSpinner className="w-4 h-4 mr-2" />}
                                  Draft Script
                                </Button>
                              </div>
                              {spokespersonScript.trim().length >= 3 &&
                                !characterDialogueDurationIsValid && (
                                  <p
                                    className="text-xs font-medium text-destructive"
                                    data-testid="text-character-dialogue-duration-error"
                                  >
                                    This script needs at least {characterDialogueMinimumDurationSec} seconds.
                                    Choose a longer video length or shorten the script.
                                  </p>
                                )}
                            </div>

                            {isTeluguCharacterDialogue &&
                              (spokespersonStep === "review" || spokespersonStep === "setup") && (
                              <div className="space-y-3 rounded-xl border border-border bg-muted/20 p-4">
                                <div>
                                  <Label htmlFor="spokesperson-source-script">English source</Label>
                                  <p className="text-xs text-muted-foreground mt-1">
                                    Edit the English draft first. Translating again replaces only the Telugu draft.
                                  </p>
                                </div>
                                <Textarea
                                  id="spokesperson-source-script"
                                  data-testid="input-spokesperson-source-script"
                                  value={spokespersonSourceScript}
                                  onChange={(e) => {
                                    setSpokespersonSourceScript(e.target.value);
                                    setSpokespersonScript("");
                                    setApprovedSpokespersonScript(null);
                                    setSpokespersonStep("review");
                                    setTeluguTranslationReady(false);
                                    setTeluguTranslationNeedsEdit(false);
                                    setTranslationSpendPaise(null);
                                    translationRequestRef.current += 1;
                                  }}
                                  rows={8}
                                />
                                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                                  <p className="text-xs text-muted-foreground">
                                    Translation is billed as one caption request.
                                  </p>
                                  <Button
                                    variant="secondary"
                                    onClick={translateCharacterDialogueToTelugu}
                                    disabled={
                                      spokespersonSourceScript.trim().length < 3 ||
                                      translateScript.isPending
                                    }
                                    data-testid="button-translate-spokesperson-script"
                                  >
                                    {translateScript.isPending && (
                                      <RippleSpinner className="w-4 h-4 mr-2" />
                                    )}
                                    {spokespersonScript ? "Translate Again" : "Translate to Telugu"}
                                  </Button>
                                </div>
                              </div>
                            )}

                            {(spokespersonScript ||
                              (isTeluguCharacterDialogue && teluguTranslationReady)) && (
                              <div className="space-y-3 rounded-xl border border-border bg-muted/20 p-4">
                                <div>
                                  <Label htmlFor="spokesperson-script">
                                    {isTeluguCharacterDialogue ? "Review the Telugu script" : "Review your script"}
                                  </Label>
                                  <p className="text-xs text-muted-foreground mt-1">
                                    {isTeluguCharacterDialogue
                                      ? "Edit the translation as needed. Only this approved Telugu text will be voiced."
                                      : "Read it aloud and make any changes. The approved text is exactly what your character will say."}
                                  </p>
                                  {isTeluguCharacterDialogue && translationSpendPaise !== null && (
                                    <p
                                      className="text-xs font-medium text-muted-foreground mt-1"
                                      data-testid="text-translation-spend"
                                    >
                                      Translation charged ₹{rupees(translationSpendPaise)}
                                    </p>
                                  )}
                                  {isTeluguCharacterDialogue && teluguTranslationNeedsEdit && (
                                    <p
                                      className="text-xs font-medium text-amber-600 mt-1"
                                      data-testid="text-translation-needs-edit"
                                    >
                                      This draft has a missing or blocked line. Edit the Telugu text before approval.
                                    </p>
                                  )}
                                </div>
                                <Textarea
                                  id="spokesperson-script"
                                  data-testid="input-spokesperson-script"
                                  value={spokespersonScript}
                                  onChange={(e) => {
                                    setSpokespersonScript(e.target.value);
                                    setApprovedSpokespersonScript(null);
                                    setTeluguTranslationNeedsEdit(false);
                                  }}
                                  rows={8}
                                />
                                <div className="flex items-center justify-between pt-1">
                                  <div className="flex flex-col gap-1">
                                    {(() => {
                                      const bounds = dialogueDurationBounds(spokespersonScript);
                                      return (
                                        <>
                                          <p className="text-xs font-medium text-muted-foreground" data-testid="text-character-dialogue-runtime">
                                            Estimated runtime: ~{bounds.minimum}s ·{" "}
                                            {characterDialogueSceneCount(spokespersonScript, selectedCharacterDialogueLocale)} scenes ·{" "}
                                            {characterDialogueSceneCount(spokespersonScript, selectedCharacterDialogueLocale) * 2} video units
                                          </p>
                                          {bounds.minimum > 30 && (
                                            <p className="text-xs text-amber-600" data-testid="text-character-dialogue-scene-count">
                                              Longer than 30s. The script will be split into short speaking scenes for reliable lip-sync.
                                            </p>
                                          )}
                                        </>
                                      );
                                    })()}
                                  </div>
                                  {!approvedSpokespersonScript ? (
                                    <Button
                                      onClick={() => {
                                        setApprovedSpokespersonScript(spokespersonScript);
                                        setDurationSec(scriptDuration);
                                        setSpokespersonStep("setup");
                                      }}
                                      disabled={
                                        spokespersonScript.trim().length < 3 ||
                                        teluguTranslationNeedsEdit ||
                                        !characterDialogueDurationIsValid
                                      }
                                      data-testid="button-approve-spokesperson-script"
                                    >
                                      Approve Script
                                    </Button>
                                  ) : (
                                    <Badge className="bg-green-500/10 text-green-600 border-green-500/20 py-1.5 px-3" data-testid="approved-spokesperson-script">
                                      <CheckCircle2 className="w-4 h-4 mr-1.5" />
                                      Approved
                                    </Badge>
                                  )}
                                </div>
                              </div>
                            )}

                            {approvedSpokespersonScript && (
                              <div className="space-y-4 pt-2">
                                {lipSyncQualityPicker}
                                <div className="flex items-start space-x-3">
                                <Checkbox
                                  id="character-dialogue-consent"
                                  checked={lipSyncConsent}
                                  onCheckedChange={(c) => setLipSyncConsent(c === true)}
                                  data-testid="checkbox-lipsync-consent"
                                />
                                <div className="space-y-1 leading-none">
                                  <Label htmlFor="character-dialogue-consent" className="font-medium text-sm">
                                    Authorization & Consent
                                  </Label>
                                  <p className="text-xs text-muted-foreground">
                                    I confirm I am authorized to generate video and audio with this character and Brand Voice.
                                  </p>
                                </div>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  )}
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
                <Label htmlFor="style-profile">Your reference style (optional)</Label>
                <div className="flex gap-2">
                  <Select
                    value={selectedWorkspaceStyle ? String(selectedWorkspaceStyle.id) : "none"}
                    onValueChange={(v) => {
                      const id = v === "none" ? null : Number(v);
                      setStyleProfileId(id);
                      const picked = workspaceStyles.find((style) => style.id === id);
                      if (picked) applyStyleCaptionTreatment(picked);
                    }}
                  >
                    <SelectTrigger id="style-profile" data-testid="select-style-profile">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No reference</SelectItem>
                      {workspaceStyles.map((s) => (
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
                {engine === "image_to_video"
                  ? photoLimit > 1
                    ? "Start frame, then end frame (optional)"
                    : "Photo to animate"
                  : `Photos (up to ${MAX_PHOTOS}, in order)`}
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
                multiple={photoLimit > 1}
                className="hidden"
                onChange={(e) => void handlePhotoFiles(e.target.files)}
              />
            </div>
          )}

          {engine === "lip_sync" && spokespersonStep === "setup" && (
            <div className="space-y-5">
              <div className="space-y-2">
                <Label>What are we animating?</Label>
                <ToggleGroup
                  type="single"
                  value={lipSyncSource}
                  onValueChange={(v) => v && setLipSyncSource(v as "video" | "portrait")}
                  variant="outline"
                >
                  <ToggleGroupItem value="video" data-testid="toggle-lipsync-video">
                    A video
                  </ToggleGroupItem>
                  <ToggleGroupItem value="portrait" data-testid="toggle-lipsync-portrait">
                    A photo
                  </ToggleGroupItem>
                </ToggleGroup>
                <p className="text-xs text-muted-foreground">
                  A photo turns one headshot into a talking video — no filming. It needs a
                  portrait model configured; if it is not set up yet you will be told before
                  anything is charged.
                </p>
              </div>

              {lipSyncSource === "video" && lipSyncQualityPicker}

              {lipSyncSource === "portrait" && (
                <div className="space-y-3">
                  <Label>Portrait</Label>
                  {portrait ? (
                    <div className="flex items-center gap-2 text-sm border border-border rounded-md px-3 py-2">
                      <ImageIcon className="h-4 w-4 text-primary shrink-0" />
                      <span className="truncate" data-testid="text-portrait-name">
                        {portrait.name}
                      </span>
                      <button
                        type="button"
                        aria-label="Remove portrait"
                        onClick={() => setPortrait(null)}
                        className="ml-auto"
                      >
                        <X className="h-4 w-4 text-muted-foreground" />
                      </button>
                    </div>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={uploading}
                      onClick={() => portraitInputRef.current?.click()}
                      data-testid="button-upload-portrait"
                    >
                      <Upload className="h-4 w-4 mr-1.5" /> Upload photo
                    </Button>
                  )}
                  <input
                    ref={portraitInputRef}
                    type="file"
                    accept={PORTRAIT_TYPES.join(",")}
                    className="hidden"
                    onChange={(e) =>
                      void handleLipSyncFile(e.target.files, {
                        accept: PORTRAIT_TYPES,
                        maxMb: MAX_PORTRAIT_MB,
                        inputRef: portraitInputRef,
                        set: setPortrait,
                        wrongTypeMessage: "Use a PNG, JPEG, or WebP photo.",
                        tooLargeTitle: "Photo too large",
                      })
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    One person facing the camera, mouth clearly visible. PNG, JPEG, or WebP,
                    up to {MAX_PORTRAIT_MB} MB.
                  </p>
                </div>
              )}

              <div className="space-y-3">
                <Label>Voice track (optional)</Label>
                {voiceTrack ? (
                  <div className="flex items-center gap-2 text-sm border border-border rounded-md px-3 py-2">
                    <Music className="h-4 w-4 text-primary shrink-0" />
                    <span className="truncate" data-testid="text-voice-track-name">
                      {voiceTrack.name}
                    </span>
                    <button
                      type="button"
                      aria-label="Remove voice track"
                      onClick={() => setVoiceTrack(null)}
                      className="ml-auto"
                    >
                      <X className="h-4 w-4 text-muted-foreground" />
                    </button>
                  </div>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={uploading}
                    onClick={() => voiceTrackInputRef.current?.click()}
                    data-testid="button-upload-voice-track"
                  >
                    <Upload className="h-4 w-4 mr-1.5" /> Upload a recording
                  </Button>
                )}
                <input
                  ref={voiceTrackInputRef}
                  type="file"
                  accept={VOICE_TRACK_TYPES.join(",")}
                  className="hidden"
                  onChange={(e) =>
                    void handleLipSyncFile(e.target.files, {
                      accept: VOICE_TRACK_TYPES,
                      maxMb: MAX_VOICE_TRACK_MB,
                      inputRef: voiceTrackInputRef,
                      set: setVoiceTrack,
                      wrongTypeMessage: "Use an MP3, M4A, WAV, or OGG file.",
                      tooLargeTitle: "Recording too large",
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Upload a real recording and it speaks instead of the AI voice — the script
                  above is then only for your own reference. MP3, M4A, WAV, or OGG, up to{" "}
                  {MAX_VOICE_TRACK_MB} MB.
                </p>
              </div>

              {lipSyncSource === "video" && (
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
              )}

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
                          <span>{kit.name}</span>
                          {clonedVoiceMetadata(kit) && (
                            <span className="text-muted-foreground">
                              {" "}· {clonedVoiceMetadata(kit)}
                            </span>
                          )}
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
          {engine === "dialogue_lip_sync" && spokespersonStep === "setup" && (
            <div className="space-y-5" data-testid="dialogue-lip-sync-setup">
              <div className="space-y-2">
                <Label htmlFor="ai-person-prompt">Describe the AI person</Label>
                <Textarea
                  id="ai-person-prompt"
                  data-testid="input-ai-person-prompt"
                  value={aiPersonPrompt}
                  onChange={(event) => setAiPersonPrompt(event.target.value)}
                  placeholder="For example: A friendly South Asian founder in her 30s, speaking to camera in a bright, modern home office..."
                  rows={4}
                  maxLength={2000}
                />
                <p className="text-xs text-muted-foreground">
                  Describe one original, front-facing AI person and their setting. Do not describe
                  a real person unless you are authorized to use their likeness.
                </p>
              </div>

              {lipSyncQualityPicker}

              <div className="space-y-2">
                <Label htmlFor="dialogue-video-duration">Dialogue video length</Label>
                <Select value={String(durationSec)} onValueChange={(v) => setDurationSec(Number(v))}>
                  <SelectTrigger
                    id="dialogue-video-duration"
                    className="w-40"
                    aria-label="AI Dialogue video length"
                    data-testid="select-dialogue-video-duration"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {dialogueDurationOptions.map((seconds) => (
                      <SelectItem key={seconds} value={String(seconds)}>
                        {seconds} seconds
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {dialogueBounds.minimum > MAX_DIALOGUE_DURATION_SEC ? (
                  <p className="text-xs text-destructive" data-testid="text-dialogue-duration-guidance">
                    This approved script needs about {dialogueBounds.minimum} seconds. AI Dialogue
                    supports up to {MAX_DIALOGUE_DURATION_SEC} seconds; shorten the script to continue.
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground" data-testid="text-dialogue-duration-guidance">
                    This approved script needs {dialogueBounds.minimum}–{dialogueBounds.maximum} seconds
                    to finish naturally. Choose a length in that range.
                  </p>
                )}
              </div>

              <div className="flex flex-wrap items-end gap-5">
                <div className="space-y-2">
                  <Label>Voice</Label>
                  <Select value={voice} onValueChange={(v) => setVoice(v as Voice)}>
                    <SelectTrigger
                      className="w-44"
                      aria-label="AI Dialogue voice"
                      data-testid="select-dialogue-lip-sync-voice"
                    >
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
                    <SelectTrigger
                      className="w-52"
                      aria-label="AI Dialogue brand kit"
                      data-testid="select-dialogue-lip-sync-brand-kit"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No brand kit</SelectItem>
                      {brandKits?.map((kit) => (
                        <SelectItem key={kit.id} value={String(kit.id)}>
                          <span>{kit.name}</span>
                          {clonedVoiceMetadata(kit) && (
                            <span className="text-muted-foreground">
                              {" "}· {clonedVoiceMetadata(kit)}
                            </span>
                          )}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Choose Brand kit voice with a brand kit, or select a named stock voice explicitly.
              </p>

              <label
                className="flex items-start gap-3 rounded-lg border border-border px-3 py-3 cursor-pointer"
                data-testid="label-ai-person-consent"
              >
                <Checkbox
                  checked={aiPersonConsent}
                  onCheckedChange={(checked) => setAiPersonConsent(checked === true)}
                  data-testid="checkbox-ai-person-consent"
                />
                <span className="text-sm text-muted-foreground">
                  I am authorized to create the described AI person or likeness and to make them
                  appear to speak this approved dialogue.
                </span>
              </label>
            </div>
          )}

          <div className="flex flex-wrap items-end gap-5">
            {engine !== "lip_sync" && engine !== "dialogue_lip_sync" && (
            <div className="space-y-2">
              <Label>Aspect ratio</Label>
              <ToggleGroup
                type="single"
                value={aspect}
                onValueChange={(v) => v && setAspect(v as Aspect)}
                variant="outline"
              >
                {VIDEO_ASPECTS.map((a) => (
                  <ToggleGroupItem
                    key={a.value}
                    value={a.value}
                    aria-label={`${a.label} — ${a.note}`}
                    title={a.note}
                    data-testid={`toggle-aspect-${a.value.replace(":", "-")}`}
                  >
                    {a.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
            )}

            {engine !== "slideshow" && engine !== "lip_sync" && availableModels.length > 0 && (
              <div className="space-y-2">
                <Label htmlFor="video-model">Model</Label>
                <Select
                  value={modelId ?? "default"}
                  onValueChange={(v) => setModelId(v === "default" ? null : v)}
                >
                  <SelectTrigger id="video-model" className="w-64" data-testid="select-video-model">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">Standard model (1 unit)</SelectItem>
                    {availableModels.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.label} ({m.unitMultiplier}
                        {m.unitMultiplier === 1 ? " unit" : " units"})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedModel && (
                  <p className="text-xs text-muted-foreground max-w-64">{selectedModel.blurb}</p>
                )}
              </div>
            )}

            {selectedModel && selectedModel.resolutions.length > 1 && (
              <div className="space-y-2">
                <Label htmlFor="video-resolution">Resolution</Label>
                <Select
                  value={resolution ?? "auto"}
                  onValueChange={(v) => setResolution(v === "auto" ? null : (v as VideoResolution))}
                >
                  <SelectTrigger id="video-resolution" className="w-32" data-testid="select-resolution">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Best</SelectItem>
                    {selectedModel.resolutions.map((r) => (
                      <SelectItem key={r} value={r}>
                        {r}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {selectedModel?.hasQuality && (
              <div className="space-y-2">
                <Label htmlFor="video-quality">Quality</Label>
                <Select
                  value={quality ?? "basic"}
                  onValueChange={(v) => setQuality(v as VideoQuality)}
                >
                  <SelectTrigger id="video-quality" className="w-32" data-testid="select-quality">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="basic">Basic</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {selectedModel?.canGenerateAudio && (
              <div className="space-y-2">
                <Label htmlFor="generate-audio">Sound</Label>
                <label className="flex h-9 items-center gap-2 text-sm" htmlFor="generate-audio">
                  <Checkbox
                    id="generate-audio"
                    checked={generateAudio}
                    onCheckedChange={(v) => setGenerateAudio(v === true)}
                    data-testid="checkbox-generate-audio"
                  />
                  Generate audio
                </label>
              </div>
            )}

            {engine !== "slideshow" && engine !== "lip_sync" && opticsCatalog && (
              <>
                {(
                  [
                    {
                      id: "camera",
                      label: "Camera",
                      value: camera,
                      set: setCamera,
                      width: "w-48",
                      items: opticsCatalog.cameras.map((o) => ({ value: o.id, label: o.label })),
                    },
                    {
                      id: "lens",
                      label: "Lens",
                      value: lens,
                      set: setLens,
                      width: "w-48",
                      items: opticsCatalog.lenses.map((o) => ({ value: o.id, label: o.label })),
                    },
                    {
                      id: "aperture",
                      label: "Aperture",
                      value: aperture,
                      set: setAperture,
                      width: "w-28",
                      items: opticsCatalog.apertures.map((o) => ({ value: o.id, label: o.label })),
                    },
                  ] as const
                ).map((axis) => (
                  <div className="space-y-2" key={axis.id}>
                    <Label htmlFor={`optics-${axis.id}`}>{axis.label}</Label>
                    <Select
                      value={axis.value ?? "any"}
                      onValueChange={(v) => axis.set(v === "any" ? null : v)}
                    >
                      <SelectTrigger
                        id={`optics-${axis.id}`}
                        className={axis.width}
                        data-testid={`select-optics-${axis.id}`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="any">Any</SelectItem>
                        {axis.items.map((item) => (
                          <SelectItem key={item.value} value={item.value}>
                            {item.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
                <div className="space-y-2">
                  <Label htmlFor="optics-focal">Focal length</Label>
                  <Select
                    value={focalLengthMm == null ? "any" : String(focalLengthMm)}
                    onValueChange={(v) => setFocalLengthMm(v === "any" ? null : Number(v))}
                  >
                    <SelectTrigger id="optics-focal" className="w-28" data-testid="select-optics-focal">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="any">Any</SelectItem>
                      {opticsCatalog.focalLengths.map((f) => (
                        <SelectItem key={f.mm} value={String(f.mm)}>
                          {f.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </>
            )}

            {engine !== "slideshow" && engine !== "lip_sync" && (
              <div className="space-y-2">
                <Label htmlFor="motion-preset">Camera move</Label>
                <Select
                  value={motionPreset ?? "none"}
                  onValueChange={(v) => setMotionPreset(v === "none" ? null : v)}
                >
                  <SelectTrigger id="motion-preset" className="w-56" data-testid="select-motion-preset">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Natural motion</SelectItem>
                    {(motionCatalog?.categories ?? []).map((category) => {
                      const presets = (motionCatalog?.presets ?? []).filter(
                        (preset) => preset.category === category.id,
                      );
                      if (presets.length === 0) return null;
                      return (
                        <SelectGroup key={category.id}>
                          <SelectLabel>{category.label}</SelectLabel>
                          {presets.map((preset) => (
                            <SelectItem key={preset.id} value={preset.id}>
                              {preset.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>
            )}

            {engine === "text_to_video" || engine === "image_to_video" ? (
              <div className="space-y-2">
                <Label>Length</Label>
                <Select value={String(durationSec)} onValueChange={(v) => setDurationSec(Number(v))}>
                  <SelectTrigger className="w-28" data-testid="select-duration">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {/* Only lengths the chosen model actually renders. Without
                        a model the old list stands, and the server snaps. */}
                    {(selectedModel?.durations ?? [5, 8, 10, 15, 20, 30]).map((d) => (
                      <SelectItem key={d} value={String(d)}>
                        {d} seconds
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : engine === "topic_to_video" && !isCharacterDialogue ? (
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
            ) : null}
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
                  <SelectItem value="0" data-testid="option-shots-auto">
                    Auto — let the script decide
                  </SelectItem>
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                    <SelectItem key={n} value={String(n)} data-testid={`option-shots-${n}`}>
                      {n === 1 ? "1 shot — one continuous take" : `${n} shots — cut together`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground" data-testid="text-shot-cost">
                {shotCount === 0
                  ? "AI reads your script and picks the shot count (1–10). Each shot costs one video unit."
                  : shotCount === 1
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
                      reusePlan.flow === "character" ? "Your character" : "AI imagery"
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

          {showWalletEstimate &&
            (engine !== "lip_sync" && engine !== "dialogue_lip_sync"
              ? true
              : spokespersonStep === "setup") && (
            <div className="space-y-1">
              {videoModelCostEstimate &&
                (videoModelCostEstimate.available ? (
                  <p
                    className="text-sm text-muted-foreground"
                    data-testid="text-video-model-estimate"
                  >
                    Approximate video-model cost: {"\u20B9"}
                    {rupees(videoModelCostEstimate.totalPaise)} (
                    {videoModelCostEstimate.operations} provider{" "}
                    {videoModelCostEstimate.operations === 1 ? "generation" : "generations"},{" "}
                    about {videoModelCostEstimate.durationSec}s output;{" "}
                    {videoModelCostEstimate.models.join(" + ")}). Narration, music, fallback
                    models, and final output duration can change the settled charge.
                  </p>
                ) : (
                  <p
                    className="text-sm text-muted-foreground"
                    data-testid="text-video-model-estimate-unavailable"
                  >
                    Approximate video-model cost is unavailable for this workflow or active
                    model. The final charge will be settled from actual provider usage.
                  </p>
                ))}
              <p className="text-sm text-muted-foreground" data-testid="text-wallet-estimate">
                {templatePlansBeforeVisualFunding ? "Planning reservation: " : "Up-front wallet reservation: "}{"\u20B9"}
                {rupees(walletReservationPaise)}
                {estimatedUnits > 1 && (
                  <>
                    {" "}
                    ({estimatedUnits} generations {"\u00D7"} {"\u20B9"}
                    {rupees(walletUnitPaise)} each)
                  </>
                )}
                . Reserved up front, then settled to the actual cost.
              </p>
              {templatePlansBeforeVisualFunding && templatePlanningCeilingUnits != null && (
                <p className="text-sm text-muted-foreground" data-testid="text-template-planning-ceiling">
                  Final hold uses the exact planned scenes (up to {templatePlanningCeilingUnits} video units
                  for this template and current settings).
                </p>
              )}
              {walletShortfall && (
                <p className="text-sm text-destructive" data-testid="text-wallet-estimate-shortfall">
                  Your wallet balance ({"\u20B9"}
                  {rupees(walletOverview?.balancePaise ?? 0)}) can't cover this estimate — recharge
                  your wallet before generating.
                </p>
              )}
            </div>
          )}

          {(engine !== "lip_sync" && engine !== "dialogue_lip_sync"
            ? true
            : spokespersonStep === "setup") && (
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
                  <Film className="h-4 w-4 mr-2" />{" "}
                  {engine === "lip_sync"
                    ? "Generate spokesperson video"
                    : engine === "dialogue_lip_sync"
                      ? "Generate AI dialogue video"
                      : "Generate video"}
                </>
              )}
            </Button>
          )}
        </CardContent>
      </Card>

      {activeJob && (
        <Card data-testid="card-active-job">
          <CardContent className="pt-6 space-y-4">
            <div
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/40 px-3 py-2"
              data-testid="active-video-job-number"
            >
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Generation job
              </span>
              <span className="font-mono text-base font-semibold tabular-nums text-foreground">
                Job #{activeJob.id}
              </span>
            </div>
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
                    disabled={cancelling}
                    title={
                      activeJob.status !== "queued"
                        ? "Check whether this generation can still be cancelled."
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
                      {activeJob.error
                        ? `Exact storyboard requirement: ${activeJob.requiredUnits ?? activeJob.units} video units; ${activeJob.units} currently funded. ${activeJob.error}`
                        : `Exact storyboard requirement: ${activeJob.requiredUnits ?? activeJob.units} video units. Nothing else is charged until you render it.`}
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
                {activeJob.repair && (
                  <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
                    <p className="text-sm font-medium">Repaired version</p>
                    <p className="text-xs text-muted-foreground">
                      This local-only repair is linked to original video #{activeJob.repair.sourceJobId}.
                      No AI quota or wallet balance was used.
                    </p>
                  </div>
                )}
                {!activeJob.repair &&
                  activeJob.currentVideoPath &&
                  activeJob.currentVideoPath !== activeJob.videoPath && (
                    <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
                      <p className="text-sm font-medium">Repaired version is current</p>
                      <p className="text-xs text-muted-foreground">
                        The original output is preserved on this job. Preview and download now use
                        the validated repaired version.
                      </p>
                    </div>
                  )}
                <video
                  controls
                  playsInline
                  preload="metadata"
                  poster={activeJob.thumbnailPath ? storageUrl(activeJob.thumbnailPath) : undefined}
                  src={storageUrl(activeJob.currentVideoPath ?? activeJob.videoPath)}
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
                  {activeJob.repairable && (
                    <Button
                      variant="outline"
                      onClick={() => setRepairOpen(true)}
                      data-testid="button-repair-video"
                    >
                      <Wrench className="h-4 w-4 mr-2" /> Repair video
                    </Button>
                  )}
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
            {activeJob.status === "failed" && activeJob.repair && (
              <div className="space-y-3">
                <div className="flex items-start gap-3 text-destructive">
                  <XCircle className="h-5 w-5 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium">Repair could not be completed</p>
                    <p className="text-sm">
                      {activeJob.error ??
                        "A saved asset could not be validated. The original video is still available."}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Original video #{activeJob.repair.sourceJobId} was not changed and no AI quota
                      or wallet balance was used.
                    </p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  onClick={() => setActiveJobId(activeJob.repair!.sourceJobId)}
                  data-testid="button-open-original-video"
                >
                  Open original video
                </Button>
              </div>
            )}
            {activeJob.status === "cancelled" && activeJob.repair && (
              <div className="space-y-3">
                <div>
                  <p className="font-medium">Repair cancelled</p>
                  <p className="text-sm text-muted-foreground">
                    Original video #{activeJob.repair.sourceJobId} is unchanged. You can open it and
                    start another no-charge repair.
                  </p>
                </div>
                <Button
                  variant="outline"
                  onClick={() => setActiveJobId(activeJob.repair!.sourceJobId)}
                  data-testid="button-open-original-video"
                >
                  Open original video
                </Button>
              </div>
            )}
            {activeJob.status === "failed" && !activeJob.repair && (
              <div className="space-y-3">
                <div className="flex items-start gap-3 text-destructive">
                  <XCircle className="h-5 w-5 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium">Generation failed</p>
                    <p className="text-sm">{activeJob.error ?? "Please try again."}</p>
                  </div>
                </div>
                {activeJob.storyboard &&
                  activeJob.storyboard.scenes.some((scene) => Boolean(scene.previewPath)) && (
                    <SavedStoryboardProgress storyboard={activeJob.storyboard} />
                  )}
                {activeJob.retryable && (
                  <div className="space-y-2 rounded-lg border p-3">
                    <p className="text-sm font-medium">
                      {activeJob.recovery?.mode === "resume"
                        ? "Resume generation"
                        : "Retry from saved inputs"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {activeJob.recovery?.mode === "resume"
                        ? `Reuse ${activeJob.recovery.reusable.join(", ")}. ${
                            activeJob.recovery.regenerated.length
                              ? `Rebuild ${activeJob.recovery.regenerated.join(", ")}.`
                              : ""
                          }`
                        : "Keep the original prompt, selected assets, template, character, and model settings, but regenerate provider work."}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        disabled={retryVideo.isPending}
                        onClick={() =>
                          retryVideo.mutate(
                            { jobId: activeJob.id },
                            {
                              onSuccess: (job) => {
                                announcedRef.current = null;
                                setActiveJobId(job.id);
                                if (activeVideoJobKey) {
                                  localStorage.setItem(activeVideoJobKey, String(job.id));
                                }
                                queryClient.setQueryData(getGetVideoJobQueryKey(job.id), job);
                                void queryClient.invalidateQueries({
                                  queryKey: getListVideoJobsQueryKey(),
                                });
                                toast({
                                  title:
                                    job.recovery?.mode === "resume"
                                      ? "Resume started"
                                      : "Retry started",
                                  description:
                                    job.units === 0
                                      ? "KOKAO is finalizing the saved completed work with no new provider generation."
                                      : `KOKAO reserved only ${job.units} missing provider operation${job.units === 1 ? "" : "s"}.`,
                                });
                              },
                              onError: (error) =>
                                toast({
                                  title: "Couldn't recover the video",
                                  description: apiErrorMessage(error, "Please try again."),
                                  variant: "destructive",
                                }),
                            },
                          )
                        }
                        data-testid="button-retry-video"
                      >
                        {retryVideo.isPending ? (
                          <RippleSpinner className="mr-2 h-4 w-4" />
                        ) : (
                          <RotateCcw className="mr-2 h-4 w-4" />
                        )}
                        {activeJob.recovery?.mode === "resume"
                          ? "Resume generation"
                          : "Retry from saved inputs"}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          if ((Object.keys(ENGINE_META) as string[]).includes(activeJob.engine)) {
                            setEngine(activeJob.engine as Engine);
                          }
                          setPrompt(activeJob.prompt ?? "");
                          setAspect((activeJob.aspectRatio as Aspect) ?? "9:16");
                          setActiveJobId(null);
                          window.scrollTo({ top: 0, behavior: "smooth" });
                        }}
                        data-testid="button-start-over-video"
                      >
                        Start over
                      </Button>
                    </div>
                  </div>
                )}
                {!activeJob.retryable && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      if ((Object.keys(ENGINE_META) as string[]).includes(activeJob.engine)) {
                        setEngine(activeJob.engine as Engine);
                      }
                      setPrompt(activeJob.prompt ?? "");
                      setAspect((activeJob.aspectRatio as Aspect) ?? "9:16");
                      setActiveJobId(null);
                      window.scrollTo({ top: 0, behavior: "smooth" });
                    }}
                    data-testid="button-start-over-video"
                  >
                    Start over
                  </Button>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Dialog open={repairOpen} onOpenChange={setRepairOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Repair video</DialogTitle>
            <DialogDescription>
              KOKAO will recompose this video from its saved narration, scenes, music, captions, and
              timing. It will not regenerate paid assets, use AI quota, or charge your wallet. The
              original stays preserved.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="repair-reason">What does not match?</Label>
            <Select
              value={repairReason}
              onValueChange={(value) => setRepairReason(value as typeof repairReason)}
            >
              <SelectTrigger id="repair-reason" data-testid="select-repair-reason">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="audio_visual">Audio and visuals are out of sync</SelectItem>
                <SelectItem value="narration">Narration is missing or mismatched</SelectItem>
                <SelectItem value="music">Music is missing or too early/late</SelectItem>
                <SelectItem value="captions">Captions do not match the narration</SelectItem>
                <SelectItem value="scene_timing">Scene timing does not match the audio</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRepairOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!activeJob || repairVideo.isPending}
              onClick={() => {
                if (!activeJob) return;
                repairVideo.mutate(
                  { jobId: activeJob.id, data: { reason: repairReason } },
                  {
                    onSuccess: (job) => {
                      setRepairOpen(false);
                      setRepairStartError(null);
                      announcedRef.current = null;
                      setActiveJobId(job.id);
                      if (activeVideoJobKey) localStorage.setItem(activeVideoJobKey, String(job.id));
                      queryClient.setQueryData(getGetVideoJobQueryKey(job.id), job);
                      void queryClient.invalidateQueries({ queryKey: getListVideoJobsQueryKey() });
                      toast({
                        title: "Repair started",
                        description:
                          "KOKAO is recomposing from saved assets with no AI quota or wallet charge.",
                      });
                    },
                    onError: (error) => {
                      const description = apiErrorMessage(
                        error,
                        "The original video is unchanged. Please try again.",
                      );
                      setRepairStartError(description);
                      toast({
                        title: "Couldn't start repair",
                        description,
                        variant: "destructive",
                      });
                    },
                  },
                );
              }}
              data-testid="button-confirm-repair-video"
            >
              {repairVideo.isPending && <RippleSpinner className="mr-2 h-4 w-4" />}
              Start no-charge repair
            </Button>
          </DialogFooter>
          {repairStartError && (
            <div
              className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
              role="alert"
              data-testid="repair-start-error"
            >
              <p className="font-medium">Repair could not start</p>
              <p>{repairStartError}</p>
              <p className="mt-1 text-xs">
                The original video is unchanged and no AI quota or wallet balance was used.
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>

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
                  <p
                    className="font-mono text-sm font-semibold tabular-nums text-foreground"
                    data-testid={`job-number-${job.id}`}
                  >
                    Job #{job.id}
                  </p>
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
type SceneDraft = {
  visual?: string;
  brollVisual?: string | null;
  durationSec?: number;
  text?: string;
};

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
  const brollVisual = draft?.brollVisual?.trim();
  if (
    scene.brollVisual != null &&
    draft?.brollVisual !== undefined &&
    brollVisual !== scene.brollVisual
  ) {
    edit.brollVisual = brollVisual || null;
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

function SavedStoryboardProgress({ storyboard }: { storyboard: VideoStoryboard }) {
  const saved = storyboard.scenes.filter((scene) => Boolean(scene.previewPath)).length;

  return (
    <div
      className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4"
      data-testid="saved-storyboard-progress"
    >
      <div>
        <p className="font-medium text-foreground">
          AI provider stopped after saving {saved} of {storyboard.scenes.length} storyboard images
        </p>
        <p className="text-sm text-muted-foreground">
          These images are safely stored and will be reused. Retry generates only the missing
          provider work; it does not start the storyboard from scratch.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {storyboard.scenes.map((scene, index) => {
          const events = scene.previewCheckpoint?.events ?? [];
          const selected =
            events.find((event) => event.eventId === scene.previewCheckpoint?.selectedEventId) ??
            events[events.length - 1];
          const provider = selected?.provider;
          return (
            <div
              key={scene.id}
              className="overflow-hidden rounded-lg border bg-background"
              data-testid={`saved-storyboard-scene-${scene.id}`}
            >
              <div className="aspect-[2/3] bg-muted">
                {scene.previewPath ? (
                  <img
                    src={storageUrl(scene.previewPath)}
                    alt={`Saved storyboard scene ${index + 1}`}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center p-2 text-center text-xs text-muted-foreground">
                    Waiting for AI provider
                  </div>
                )}
              </div>
              <div className="flex items-center justify-between gap-1 p-2">
                <span className="text-xs font-medium">Scene {index + 1}</span>
                <Badge variant={scene.previewPath ? "secondary" : "outline"} className="text-[10px]">
                  {scene.previewPath ? provider ?? "Saved" : "Missing"}
                </Badge>
              </div>
            </div>
          );
        })}
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
  const presenterBroll = storyboard.presenterBroll === true;
  const characterDialogue = storyboard.mode === "character_dialogue";
  const hybridStory = storyboard.mode === "hybrid_character_story";
  /** Character Story records after approval; its planned script is editable
   * even though narration is intentionally absent at review time. */
  const narrated =
    storyboard.narration != null || storyboard.mode === "character_story";
  /** Slide plans caption a photo rather than prompt for one. */
  const slides = source === "slide";
  /** Only generated stills can be redrawn; the rest are the user's own photos. */
  const drawn =
    !presenterBroll &&
    !hybridStory &&
    storyboard.mode !== "character_story" &&
    storyboard.mode !== "character_dialogue" &&
    (source === "character" || source === "ai" || source === "ai_video");
  /** A prompt plan is a shot list — there is no frame to show at all. */
  const framed = presenterBroll || source !== "prompt";
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
      const broll = (draft?.brollVisual ?? scene.brollVisual ?? "").trim();
      if (broll) lines.push(`Supporting B-roll: ${broll}`);
      return lines.join("\n");
    })
    .join("\n\n");

  const copyScript = () => {
    void navigator.clipboard
      .writeText(scriptText)
      .then(() => toast({ title: "Script copied to clipboard" }))
      .catch(() => toast({ title: "Could not copy", variant: "destructive" }));
  };

  const blurb = characterDialogue
    ? `${count} speaking ${count === 1 ? "scene" : "scenes"} · about ${totalSec}s. The approved dialogue is locked; review the character shot and supporting B-roll directions, then render. No media provider runs before approval.`
    : storyboard.mode === "character_story"
      ? `${count} character ${count === 1 ? "scene" : "scenes"} · about ${totalSec}s. Review the script and scene directions first. Narration and character frames are created only after approval.`
      : presenterBroll
    ? `${count} B-roll ${count === 1 ? "beat" : "beats"} · about ${totalSec}s. Review each resolved preview or reword its search prompt, then render against the fixed presenter take.`
    : storyboard.narration
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
                {hybridStory && (
                  <Badge variant="secondary" className="self-start">
                    {scene.beatType === "character_speaking" ? "Talking character" : "Story animation"}
                    {" · "}
                    {scene.hybridRole === "character_opening"
                      ? "Opening"
                      : scene.hybridRole === "character_closing"
                        ? "Closing"
                        : scene.hybridRole === "character_interlude"
                          ? "Interlude"
                          : "Story"}
                  </Badge>
                )}
                {characterDialogue ? (
                  <div
                    className="rounded-md border border-border bg-background px-3 py-2"
                    data-testid={`text-approved-dialogue-${scene.id}`}
                  >
                    <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      Approved dialogue · read only
                    </p>
                    <p className="mt-1 text-xs whitespace-pre-wrap">{scene.text}</p>
                  </div>
                ) : narrated && !hybridStory ? (
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
                {scene.brollVisual != null && (
                  <div className="space-y-1">
                    <Label
                      htmlFor={`broll-${scene.id}`}
                      className="text-xs text-muted-foreground"
                    >
                      Supporting B-roll
                    </Label>
                    <Textarea
                      id={`broll-${scene.id}`}
                      rows={2}
                      maxLength={1000}
                      value={draft?.brollVisual ?? scene.brollVisual}
                      onChange={(e) =>
                        setDrafts((d) => ({
                          ...d,
                          [scene.id]: {
                            ...d[scene.id],
                            brollVisual: e.target.value,
                          },
                        }))
                      }
                      className="text-xs resize-none"
                      data-testid={`input-broll-${scene.id}`}
                    />
                  </div>
                )}
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
                  {narrated && drawn && !hybridStory && (
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
  const [outfitPreview, setOutfitPreview] = useState<
    (Character["outfits"][number] & { characterId: number }) | null
  >(null);
  const [enlargedOutfitImage, setEnlargedOutfitImage] = useState<{
    src: string;
    alt: string;
  } | null>(null);
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
    const requestedName = outfitName.trim();
    const requestedDescription = outfitDescription.trim();
    createOutfit.mutate(
      {
        characterId,
        data: { name: requestedName, description: requestedDescription },
      },
      {
        onSuccess: (character) => {
          const generatedOutfit = [...character.outfits]
            .reverse()
            .find(
              (outfit) =>
                !outfit.isDefault &&
                outfit.name === requestedName &&
                outfit.description === requestedDescription,
            );
          if (generatedOutfit) {
            setOutfitPreview({ ...generatedOutfit, characterId });
          }
          setOutfitFor(null);
          setOutfitName("");
          setOutfitDescription("");
          invalidate();
          toast({
            title: "Outfit preview created",
            description: "Review the generated look below before locking it into a video.",
          });
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
    <>
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
                                 {
                                   onSuccess: () => {
                                     if (outfitPreview?.id === o.id) {
                                       setOutfitPreview(null);
                                     }
                                     invalidate();
                                   },
                                 },
                              )
                            }
                          >
                            <X className="h-3 w-3" />
                          </button>
                        )}
                      </Badge>
                    ))}
                  </div>
                   {outfitPreview?.characterId === c.id && (
                     <div
                       className="rounded-md border border-primary/30 bg-primary/5 p-2"
                       data-testid={`outfit-preview-${outfitPreview.id}`}
                     >
                       <div className="flex gap-3">
                          <button
                            type="button"
                            className="shrink-0 rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                            aria-label={`Enlarge ${c.name} wearing ${outfitPreview.name}`}
                            data-testid={`button-enlarge-outfit-preview-${outfitPreview.id}`}
                            onClick={() =>
                              setEnlargedOutfitImage({
                                src: `/api/storage${outfitPreview.referenceImagePath}`,
                                alt: `${c.name} wearing ${outfitPreview.name}`,
                              })
                            }
                          >
                            <img
                              src={`/api/storage${outfitPreview.referenceImagePath}`}
                              alt={`${c.name} wearing ${outfitPreview.name}`}
                              className="h-36 w-24 rounded-md border border-border object-cover transition-opacity hover:opacity-85"
                            />
                          </button>
                         <div className="min-w-0 space-y-1">
                           <p className="text-sm font-medium">New outfit preview</p>
                           <p className="text-sm">{outfitPreview.name}</p>
                           <p className="text-xs text-muted-foreground">
                             {outfitPreview.description}
                           </p>
                           <p className="text-xs text-muted-foreground">
                             This is the character wearing the saved outfit.
                           </p>
                         </div>
                       </div>
                     </div>
                   )}
                   <div className="space-y-1.5">
                     <p className="text-xs font-medium text-muted-foreground">Outfit previews</p>
                     <div className="flex flex-wrap gap-2">
                       {c.outfits.map((o) => (
                         <button
                           key={o.id}
                           type="button"
                           className="w-16 overflow-hidden rounded-md border border-border text-left transition-colors hover:border-primary focus:outline-none focus:ring-2 focus:ring-ring"
                           aria-label={`Preview ${c.name} wearing ${o.name}`}
                           onClick={() => setOutfitPreview({ ...o, characterId: c.id })}
                         >
                           <img
                             src={`/api/storage${o.referenceImagePath}`}
                             alt={`${c.name} wearing ${o.name}`}
                             className="h-20 w-16 object-cover"
                           />
                           <span className="block truncate px-1 py-1 text-[10px]">
                             {o.name}
                           </span>
                         </button>
                       ))}
                     </div>
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
                       <p className="text-xs text-muted-foreground">
                         We’ll generate a sample image of {c.name} wearing this outfit for you to review.
                       </p>
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
                          {createOutfit.isPending ? "Creating preview…" : "Add outfit"}
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
    <Dialog
      open={enlargedOutfitImage !== null}
      onOpenChange={(open) => {
        if (!open) setEnlargedOutfitImage(null);
      }}
    >
      <DialogContent
        className="max-w-4xl p-3 sm:p-5"
        data-testid="dialog-enlarged-outfit-preview"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Enlarged outfit preview</DialogTitle>
          <DialogDescription>Review the generated character outfit at full size.</DialogDescription>
        </DialogHeader>
        {enlargedOutfitImage && (
          <img
            src={enlargedOutfitImage.src}
            alt={enlargedOutfitImage.alt}
            className="max-h-[78vh] w-full rounded-md object-contain"
          />
        )}
      </DialogContent>
    </Dialog>
    </>
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
