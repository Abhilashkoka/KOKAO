import { WalletBalancePill } from "@/components/wallet-balance";
import { useEffect, useRef, useState } from "react";
import { RippleSpinner } from "@/components/ui/ripple-spinner";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
  useGenerateCaption,
  useGenerateImage,
  useGenerateCampaign,
  useGenerateCarousel,
  useGeneratePlatformPack,
  useSuggestTopics,
  useSummarizeUrl,
  useResearchTopic,
  useCreateContent,
  useUpdateContent,
  useRecordTasteSignal,
  useDeleteContent,
  useBillingRequestUpgrade,
  useListBrandKits,
  useGetMe,
  useGetFacebookCredentials,
  useGetInstagramCredentials,
  useGetLinkedinStatus,
  useGetTwitterStatus,
  useGetThreadsStatus,
  useCreateSchedule,
  getListSchedulesQueryKey,
  useRequestUploadUrl,
  useGetAiSpendRates,
  getListContentQueryKey,
  getGetMeQueryKey,
  getGetAiSpendRatesQueryKey,
  generateImageAsync,
  getImageJob,
  cancelImageJob,
  type BrandKit,
  type CampaignPost,
  type ResearchResult,
  type CaptionResult as CaptionResultType,
  type CampaignResult as CampaignResultType,
  type ImageRequest,
  type ImagePromptRecipe,
  type ImagePromptRecipePreset,
  type ImagePromptRecipeCamera,
  type ImagePromptRecipeLens,
  type ImagePromptRecipeAperture,
  type ImagePromptRecipeLighting,
  type PlatformPackItem,
} from "@workspace/api-client-react";
import { streamCaptionRequest } from "@/lib/captionStream";
import { streamCampaignRequest } from "@/lib/campaignStream";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { Wand2, Image as ImageIcon, Save, Lightbulb, Link2, Layers, Globe, ExternalLink, RefreshCw, Trash2, Infinity as InfinityIcon, Upload, X, GalleryHorizontalEnd, Clapperboard, CalendarClock, Camera } from "lucide-react";
import { VideoStudioPage } from "@/pages/video-studio";
import { navigate } from "wouter/use-browser-location";
import { CAPTION_TWEAKS, IMAGE_TWEAKS } from "@workspace/studio-presets";
import { CampaignPostCard, type GeneratedImage } from "@/components/campaign-post-card";
import { QuickPublishPanel, QUICK_PUBLISH_LABELS } from "@/components/studio-quick-publish";
import { GamificationCard } from "@/components/gamification-card";
import { VoiceNoteButton } from "@/components/voice-note-button";
import { LogoLoader } from "@/components/logo-loader";
import { track, trackFeatureUse } from "@/lib/analytics";
import { useFeatureFlags } from "@/lib/features";
import { SavedVisualPickerDialog } from "@/components/saved-visuals";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import {
  TWEET_MAX_LENGTH,
  isOverTweetLimit,
  tweetOverBy,
  splitIntoTweets,
  THREADS_MAX_LENGTH,
  chunkOnWhitespace,
  LINKEDIN_MAX_LENGTH,
  isOverLinkedinLimit,
  splitForLinkedin,
} from "@workspace/social-limits";

const schema = z.object({
  prompt: z.string().min(3, "Prompt must be at least 3 characters"),
  brandKitId: z.coerce.number().optional().or(z.literal(0)),
  tone: z.string().optional(),
});

// Per-platform default image size: Instagram favors square; the rest landscape.
const PLATFORM_IMAGE_SIZE: Record<string, "1024x1024" | "1536x1024" | "1024x1536"> = {
  instagram: "1024x1024",
  facebook: "1536x1024",
  linkedin: "1536x1024",
  twitter: "1536x1024",
};

// Look pills. The server owns the photographic wording; these are only the
// short labels for it, and each map is keyed by the generated union, so adding
// an id to the OpenAPI enum without labelling it here is a build error rather
// than a pill that quietly never appears.
const LOOK_PRESETS: Record<ImagePromptRecipePreset, string> = {
  product: "Product",
  food: "Food",
  fashion: "Fashion",
  lifestyle: "Lifestyle",
  architecture: "Architecture",
};
const LOOK_CAMERAS: Record<ImagePromptRecipeCamera, string> = {
  phone: "Phone",
  mirrorless: "Mirrorless",
  dslr: "DSLR",
  "medium-format": "Medium format",
  film35: "35mm film",
};
const LOOK_LENSES: Record<ImagePromptRecipeLens, string> = {
  "wide-24": "24mm wide",
  "reportage-35": "35mm",
  "natural-50": "50mm",
  "portrait-85": "85mm portrait",
  "macro-100": "100mm macro",
  "tele-135": "135mm tele",
};
const LOOK_APERTURES: Record<ImagePromptRecipeAperture, string> = {
  "f1.4": "f/1.4 · dreamy blur",
  "f2.8": "f/2.8 · soft blur",
  "f5.6": "f/5.6 · balanced",
  f8: "f/8 · all sharp",
  f16: "f/16 · deep focus",
};
const LOOK_LIGHTING: Record<ImagePromptRecipeLighting, string> = {
  softbox: "Softbox",
  window: "Window light",
  "golden-hour": "Golden hour",
  flash: "Direct flash",
  overcast: "Overcast",
  neon: "Neon",
};

/** "auto" means "leave it to the preset", so it is never sent to the server. */
const LOOK_AUTO = "auto";

const LOOK_GEAR_AXES = [
  { key: "camera", label: "Camera", options: LOOK_CAMERAS as Record<string, string> },
  { key: "lens", label: "Lens", options: LOOK_LENSES as Record<string, string> },
  { key: "aperture", label: "Depth of field", options: LOOK_APERTURES as Record<string, string> },
  { key: "lighting", label: "Lighting", options: LOOK_LIGHTING as Record<string, string> },
] as const;

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function kitSwatches(kit: BrandKit, max = 4): string[] {
  const palette = kit.activeVersion?.payload?.colors;
  if (!palette) return [];
  const out: string[] = [];
  for (const group of [palette.primary, palette.secondary, palette.neutral]) {
    for (const color of group ?? []) {
      const hex = color.hex?.trim();
      if (hex && HEX_RE.test(hex) && !out.includes(hex.toLowerCase())) {
        out.push(hex.toLowerCase());
        if (out.length >= max) return out;
      }
    }
  }
  return out;
}

function SwatchStrip({ hexes, size = 12 }: { hexes: string[]; size?: number }) {
  if (hexes.length === 0) return null;
  return (
    <span className="inline-flex items-center gap-[3px]" data-testid="swatch-strip">
      {hexes.map((hex, i) => (
        <span
          key={`${hex}-${i}`}
          className="inline-block rounded-full border border-black/20"
          style={{ width: size, height: size, backgroundColor: hex }}
        />
      ))}
    </span>
  );
}

/** One carousel slide as tracked in the Studio UI (image added after copy). */
interface CarouselSlideUi {
  heading: string;
  body: string;
  imagePrompt: string;
  imagePath: string | null;
  b64Json: string | null;
}

interface CarouselUiState {
  title: string;
  caption: string;
  hashtags: string[];
  slides: CarouselSlideUi[];
  carouselId?: string;
}

const CAMPAIGN_PLATFORMS = [
  { value: "instagram", label: "Instagram" },
  { value: "facebook", label: "Facebook" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "twitter", label: "Twitter / X" },
];

const PLATFORM_FITS = [
  { label: "Instagram", ratio: "1 / 1", note: "Square 1:1" },
  { label: "Facebook", ratio: "1.91 / 1", note: "Landscape 1.91:1" },
  { label: "LinkedIn", ratio: "1.91 / 1", note: "Landscape 1.91:1" },
  { label: "X", ratio: "16 / 9", note: "Landscape 16:9" },
  { label: "Threads", ratio: "1 / 1", note: "Square 1:1" },
] as const;

function PlatformFitPreview({ src }: { src: string }) {
  return (
    <div className="space-y-2" data-testid="platform-fit-preview">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
        How it fits each platform
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {PLATFORM_FITS.map((p) => (
          <div key={p.label} className="space-y-1">
            <div
              className="w-full overflow-hidden rounded-md border border-border bg-muted/30"
              style={{ aspectRatio: p.ratio }}
            >
              <img src={src} alt={`${p.label} preview`} className="h-full w-full object-cover" />
            </div>
            <p className="text-[11px] leading-tight text-muted-foreground">
              <span className="font-medium text-foreground">{p.label}</span> · {p.note}
            </p>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">
        The same image is automatically cropped to each platform's recommended shape when displayed.
      </p>
    </div>
  );
}

function StudioHeader() {
  const { data: me } = useGetMe();
  const { flags } = useFeatureFlags();
  const captionsLeft =
    me && me.limits.captions !== -1 ? Math.max(0, me.limits.captions - me.usage.captions) : null;
  const imagesLeft =
    me && me.limits.images !== -1 ? Math.max(0, me.limits.images - me.usage.images) : null;
  const captionCredits = me?.credits?.captionCredits ?? 0;
  const imageCredits = me?.credits?.imageCredits ?? 0;
  // Video quota mirrors captions/images, but only renders when video
  // generation is enabled at all. limits.videos is optional (pre-video
  // plans); treat a missing limit like the feature being absent.
  const videoLimit = me?.limits.videos;
  const videosLeft =
    me && videoLimit !== undefined && videoLimit !== -1
      ? Math.max(0, videoLimit - (me.usage.videos ?? 0))
      : null;
  const videoCredits = me?.credits?.videoCredits ?? 0;
  const showVideos = flags.videoGen && videoLimit !== undefined;

  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-3xl font-extrabold tracking-tight">AI Content Studio</h1>
        <p className="text-muted-foreground text-lg mt-1">
          Brainstorm, research, and generate on-brand content across every platform.
        </p>
      </div>
      {me && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 shadow-sm"
          data-testid="quota-countdown"
        >
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider mr-1">
            This month
          </span>
          <span
            className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium ${
              captionsLeft === 0 && captionCredits === 0 ? "bg-destructive/10 text-destructive" : "bg-primary/10 text-primary"
            }`}
            data-testid="quota-captions"
          >
            <Wand2 className="h-3.5 w-3.5" />
            {captionsLeft === null ? (
              <>
                <InfinityIcon className="h-3.5 w-3.5" /> captions
              </>
            ) : (
              `${captionsLeft} caption${captionsLeft === 1 ? "" : "s"} left${
                captionCredits > 0 ? ` +${captionCredits} credits` : ""
              }`
            )}
          </span>
          <span
            className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium ${
              imagesLeft === 0 && imageCredits === 0 ? "bg-destructive/10 text-destructive" : "bg-primary/10 text-primary"
            }`}
            data-testid="quota-images"
          >
            <ImageIcon className="h-3.5 w-3.5" />
            {imagesLeft === null ? (
              <>
                <InfinityIcon className="h-3.5 w-3.5" /> images
              </>
            ) : (
              `${imagesLeft} image${imagesLeft === 1 ? "" : "s"} left${
                imageCredits > 0 ? ` +${imageCredits} credits` : ""
              }`
            )}
          </span>
          {showVideos && (
            <span
              className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium ${
                videosLeft === 0 && videoCredits === 0 ? "bg-destructive/10 text-destructive" : "bg-primary/10 text-primary"
              }`}
              data-testid="quota-videos"
            >
              <Clapperboard className="h-3.5 w-3.5" />
              {videosLeft === null ? (
                <>
                  <InfinityIcon className="h-3.5 w-3.5" /> videos
                </>
              ) : (
                `${videosLeft} video${videosLeft === 1 ? "" : "s"} left${
                  videoCredits > 0 ? ` +${videoCredits} credits` : ""
                }`
              )}
            </span>
          )}
          <span
            className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground"
            data-testid="quota-helpers"
          >
            <Lightbulb className="h-3.5 w-3.5" />
            Ideas, research &amp; briefs: unlimited
          </span>
          {/* Wallet workspaces also see their balance right where quotas live. */}
          <WalletBalancePill />
        </div>
      )}
    </div>
  );
}

export function StudioPage() {
  const { flags } = useFeatureFlags();
  const [mode, setMode] = useState<string>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("tab") === "video" || params.has("drive") ? "video" : "image";
  });

  if (!flags.videoGen) {
    return (
      <div className="space-y-8 max-w-6xl mx-auto">
        <StudioHeader />
        <GamificationCard />
        <ImageStudio />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <StudioHeader />
      <GamificationCard />
      <Tabs value={mode} onValueChange={setMode}>
        <TabsList data-testid="studio-mode-tabs">
          <TabsTrigger value="image" data-testid="tab-studio-image">
            <ImageIcon className="mr-2 h-4 w-4" /> Image
          </TabsTrigger>
          <TabsTrigger value="video" data-testid="tab-studio-video">
            <Clapperboard className="mr-2 h-4 w-4" /> Video
          </TabsTrigger>
        </TabsList>
        {/* forceMount + hidden keeps both studios alive across tab switches, so
            an in-flight generation or video job keeps polling in the background. */}
        <TabsContent value="image" forceMount className="mt-6 data-[state=inactive]:hidden">
          <ImageStudio />
        </TabsContent>
        <TabsContent value="video" forceMount className="mt-6 data-[state=inactive]:hidden">
          <VideoStudioPage />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ImageStudio() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [captionResult, setCaptionResult] = useState<{ caption: string; hashtags: string[]; title?: string } | null>(null);
  const [platformPack, setPlatformPack] = useState<{ title?: string; items: PlatformPackItem[] } | null>(null);
  const [packOpen, setPackOpen] = useState(false);
  const [briefQuestions, setBriefQuestions] = useState<string[] | null>(null);
  const [campaignTitle, setCampaignTitle] = useState<string | null>(null);
  const [captionPlatform, setCaptionPlatform] = useState<string | null>(null);
  const [captionTweak, setCaptionTweak] = useState<string | null>(null);
  const [imageResult, setImageResult] = useState<{ imagePath: string; b64Json: string | null } | null>(null);
  const [imageTweak, setImageTweak] = useState<string | null>(null);
  // True while the SSE caption stream is open (useGenerateCaption.isPending
  // only covers the JSON fallback path).
  const [captionStreaming, setCaptionStreaming] = useState(false);
  const [campaignStreaming, setCampaignStreaming] = useState(false);
  // True while a background image job is queued/running (imageJobs flag path).
  const [imageJobBusy, setImageJobBusy] = useState(false);
  // Live state of the background image job so the loader can show real
  // queued/processing status, elapsed time, and a cancel action.
  const [imageJobState, setImageJobState] = useState<{ id: number; status: string; startedAt: number } | null>(null);
  const [imageJobElapsed, setImageJobElapsed] = useState(0);
  const [imageJobCancelling, setImageJobCancelling] = useState(false);
  useEffect(() => {
    if (!imageJobState) {
      setImageJobElapsed(0);
      return;
    }
    const tick = () => setImageJobElapsed(Math.floor((Date.now() - imageJobState.startedAt) / 1000));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [imageJobState]);
  // True while "Generate all images" is running across campaign platforms.
  const [campaignBulkBusy, setCampaignBulkBusy] = useState(false);
  const [campaignPosts, setCampaignPosts] = useState<CampaignPost[] | null>(null);
  const [campaignImages, setCampaignImages] = useState<Record<string, GeneratedImage>>({});
  const [pendingCampaignImage, setPendingCampaignImage] = useState<{ platform: string; image: GeneratedImage } | null>(null);
  const [carousel, setCarousel] = useState<CarouselUiState | null>(null);
  const [carouselMode, setCarouselMode] = useState(false);
  const [carouselSlideCountText, setCarouselSlideCountText] = useState("5");
  const [carouselBusySlide, setCarouselBusySlide] = useState<number | "all" | null>(null);
  const [carouselSaving, setCarouselSaving] = useState(false);

  const [niche, setNiche] = useState("");
  const [topicIdeas, setTopicIdeas] = useState<string[]>([]);
  const [articleUrl, setArticleUrl] = useState("");
  const [researchQuery, setResearchQuery] = useState("");
  const [brainstormTab, setBrainstormTab] = useState("ideas");

  // Carry typed text between the Ideas and Research tabs so switching never
  // loses the topic; only prefill when the destination field is empty.
  const onBrainstormTabChange = (tab: string) => {
    if (tab === "research" && researchQuery.trim() === "" && niche.trim() !== "") {
      setResearchQuery(niche);
    } else if (tab === "ideas" && niche.trim() === "" && researchQuery.trim() !== "") {
      setNiche(researchQuery);
    }
    setBrainstormTab(tab);
  };
  const [researchResult, setResearchResult] = useState<ResearchResult | null>(null);
  const [campaignPlatforms, setCampaignPlatforms] = useState<string[]>([
    "instagram",
    "facebook",
    "linkedin",
    "twitter",
  ]);

  const { data: brandKits } = useListBrandKits();
  const { flags } = useFeatureFlags();

  // "AI amount spent" display (kill-switch gated): admin-set per-caption and
  // per-image amounts with the platform fee already folded in. One combined
  // number is shown; nothing renders while rates are zero or the switch is off.
  const { data: aiSpendRates } = useGetAiSpendRates({
    query: {
      queryKey: getGetAiSpendRatesQueryKey(),
      staleTime: 60_000,
      enabled: flags.aiSpend,
    },
  });
  const aiSpendPaise = (captions: number, images: number): number => {
    if (!flags.aiSpend || !aiSpendRates) return 0;
    return captions * aiSpendRates.captionPaise + images * aiSpendRates.imagePaise;
  };
  const AiSpentLine = ({ paise, testId }: { paise: number; testId: string }) =>
    paise > 0 ? (
      <p className="text-xs text-muted-foreground" data-testid={testId}>
        AI amount spent: {"\u20B9"}
        {(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </p>
    ) : null;

  // Reference image (optional, kill-switch gated): uploaded to object storage
  // up front; its path rides along with the generate-image request.
  const requestUploadUrl = useRequestUploadUrl();
  const referenceFileRef = useRef<HTMLInputElement>(null);
  const [referenceImagePath, setReferenceImagePath] = useState<string | null>(null);
  const [referencePreview, setReferencePreview] = useState<string | null>(null);
  const [referenceUploading, setReferenceUploading] = useState(false);
  const [savedPickerOpen, setSavedPickerOpen] = useState(false);

  // Look: a genre pill plus optional camera overrides. Deliberately not saved
  // with the draft — it is a choice about this shot, not about this brief.
  const [lookPreset, setLookPreset] = useState<string>("");
  const [lookGearOpen, setLookGearOpen] = useState(false);
  const [lookGear, setLookGear] = useState({
    camera: LOOK_AUTO,
    lens: LOOK_AUTO,
    aperture: LOOK_AUTO,
    lighting: LOOK_AUTO,
  });
  const lookGearSet = Object.values(lookGear).filter((v) => v !== LOOK_AUTO).length;

  /** undefined when nothing is chosen, so the request looks exactly as it used to. */
  const buildPromptRecipe = (): ImagePromptRecipe | undefined => {
    const recipe: ImagePromptRecipe = {};
    if (lookPreset) recipe.preset = lookPreset as ImagePromptRecipePreset;
    if (lookGear.camera !== LOOK_AUTO) recipe.camera = lookGear.camera as ImagePromptRecipeCamera;
    if (lookGear.lens !== LOOK_AUTO) recipe.lens = lookGear.lens as ImagePromptRecipeLens;
    if (lookGear.aperture !== LOOK_AUTO)
      recipe.aperture = lookGear.aperture as ImagePromptRecipeAperture;
    if (lookGear.lighting !== LOOK_AUTO)
      recipe.lighting = lookGear.lighting as ImagePromptRecipeLighting;
    return Object.keys(recipe).length > 0 ? recipe : undefined;
  };

  const clearReferenceImage = () => {
    setReferenceImagePath(null);
    setReferencePreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    if (referenceFileRef.current) referenceFileRef.current.value = "";
  };

  const handleReferenceUpload = async (file: File) => {
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      toast({
        title: "Not a supported image",
        description: "Please pick a PNG, JPEG, or WebP image.",
        variant: "destructive",
      });
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast({
        title: "Image too large",
        description: "Reference images must be under 10 MB.",
        variant: "destructive",
      });
      return;
    }
    setReferenceUploading(true);
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
      setReferencePreview((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(file);
      });
      setReferenceImagePath(objectPath);
      toast({ title: "Reference image added", description: "It will guide your next image generation." });
    } catch {
      toast({
        title: "Upload failed",
        description: "Could not upload the reference image. Please try again.",
        variant: "destructive",
      });
    } finally {
      setReferenceUploading(false);
    }
  };

  const { data: fbStatus, isLoading: fbLoading } = useGetFacebookCredentials();
  const { data: igStatus, isLoading: igLoading } = useGetInstagramCredentials();
  const { data: liStatus, isLoading: liLoading } = useGetLinkedinStatus();
  const { data: twStatus, isLoading: twLoading } = useGetTwitterStatus();
  const { data: thStatus, isLoading: thLoading } = useGetThreadsStatus();
  const connectionsLoading = fbLoading || igLoading || liLoading || twLoading || thLoading;
  const fbLive = !!fbStatus && fbStatus.appConfigured && fbStatus.verifyStatus === "verified";
  const platformLive: Record<string, boolean> = {
    facebook: fbLive,
    // Instagram publishing rides on the Facebook Page token, so it needs both.
    instagram:
      fbLive && !!igStatus && igStatus.appConfigured && igStatus.verifyStatus === "verified",
    linkedin: !!liStatus && liStatus.configured && liStatus.connected && !liStatus.expired,
    twitter: !!twStatus && twStatus.configured && twStatus.connected && !twStatus.expired,
    threads: !!thStatus && thStatus.configured && thStatus.connected && !thStatus.expired,
  };

  // Once connection statuses load, drop any preselected platform that isn't live.
  useEffect(() => {
    if (connectionsLoading) return;
    setCampaignPlatforms((prev) => prev.filter((p) => platformLive[p]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionsLoading, fbLive, platformLive.instagram, platformLive.linkedin, platformLive.twitter]);

  const generateCaption = useGenerateCaption();
  const generateImage = useGenerateImage();
  const generateCampaign = useGenerateCampaign();
  const generateCarousel = useGenerateCarousel();
  const generatePlatformPack = useGeneratePlatformPack();
  const suggestTopics = useSuggestTopics();
  const summarizeUrl = useSummarizeUrl();
  const researchTopic = useResearchTopic();
  const createContent = useCreateContent();
  const updateContent = useUpdateContent();
  const deleteContent = useDeleteContent();
  const createSchedule = useCreateSchedule();
  const recordTasteSignal = useRecordTasteSignal();
  const requestUpgrade = useBillingRequestUpgrade();
  const { data: me } = useGetMe();

  // Auto-saved draft: every generated caption/image is persisted immediately
  // as a library draft; "Save to Library" accepts it, "Discard" deletes it.
  const [draftId, setDraftId] = useState<number | null>(null);
  const draftIdRef = useRef<number | null>(null);
  const setDraft = (id: number | null) => {
    draftIdRef.current = id;
    setDraftId(id);
  };

  const refreshQuota = () => {
    queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
  };

  const buildDraftData = (
    caption: { caption: string; title?: string } | null,
    image: { imagePath: string } | null,
  ) => {
    const values = form.getValues();
    return {
      title:
        caption?.title?.trim() ||
        values.prompt.trim().slice(0, 30) + (values.prompt.trim().length > 30 ? "..." : ""),
      caption: caption?.caption || undefined,
      imagePath: image?.imagePath || undefined,
      imagePrompt: image ? values.prompt : undefined,
      platform: activePlatform,
      status: "draft" as const,
      brandKitId: values.brandKitId || undefined,
    };
  };

  const upsertDraft = (
    caption: { caption: string } | null,
    image: { imagePath: string } | null,
  ) => {
    const data = buildDraftData(caption, image);
    const id = draftIdRef.current;
    if (id) {
      updateContent.mutate(
        { id, data },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
          },
          onError: (err: any) => {
            const status = err?.status ?? err?.response?.status;
            if (status === 404) {
              // Draft was deleted elsewhere; recreate it.
              setDraft(null);
              createContent.mutate(
                { data },
                {
                  onSuccess: (item) => {
                    setDraft(item.id);
                    queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
                  },
                },
              );
            }
            // Other errors: keep the existing draft id — the user can still
            // save manually, and recreating here could duplicate the draft.
          },
        },
      );
    } else {
      createContent.mutate(
        { data },
        {
          onSuccess: (item) => {
            setDraft(item.id);
            queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
          },
          onError: () => {
            // Auto-save is best-effort; the user can still save manually.
          },
        },
      );
    }
  };

  // Campaign auto-save: every generated campaign post is silently persisted
  // as a library draft (one per platform) so nothing is ever lost and the
  // quick actions can publish/schedule without a manual save first.
  const [campaignDraftIds, setCampaignDraftIds] = useState<Record<string, number>>({});
  const campaignSyncedImagesRef = useRef<Record<string, string>>({});
  // Each campaign generation bumps this epoch; late auto-save responses from
  // a superseded generation are ignored so they can't bind stale draft ids.
  const campaignEpochRef = useRef(0);

  const buildCampaignDraftData = (post: CampaignPost, title: string | null, imagePath?: string) => {
    const values = form.getValues();
    const base = (title || values.prompt).trim();
    return {
      title: `${QUICK_PUBLISH_LABELS[post.platform] ?? post.platform}: ${base.slice(0, 40)}${base.length > 40 ? "..." : ""}`,
      caption: post.caption || undefined,
      imagePath: imagePath || undefined,
      imagePrompt: post.imagePrompt || undefined,
      platform: post.platform,
      status: "draft" as const,
      brandKitId: values.brandKitId || undefined,
    };
  };

  const autoSaveCampaignDrafts = (posts: CampaignPost[], title: string | null) => {
    const epoch = ++campaignEpochRef.current;
    setCampaignDraftIds({});
    campaignSyncedImagesRef.current = {};
    for (const post of posts) {
      // A fresh campaign has no images yet; the sync effect below adds them.
      createContent.mutate(
        { data: buildCampaignDraftData(post, title) },
        {
          onSuccess: (item) => {
            if (campaignEpochRef.current !== epoch) return;
            setCampaignDraftIds((prev) => ({ ...prev, [post.platform]: item.id }));
            queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
          },
          onError: () => {
            // Best-effort; the per-card Save button still works.
          },
        },
      );
    }
  };

  // Keep each campaign draft's image in sync as images are generated/applied.
  useEffect(() => {
    for (const [platform, img] of Object.entries(campaignImages)) {
      const id = campaignDraftIds[platform];
      if (!id || !img?.imagePath) continue;
      if (campaignSyncedImagesRef.current[platform] === img.imagePath) continue;
      campaignSyncedImagesRef.current[platform] = img.imagePath;
      updateContent.mutate(
        { id, data: { imagePath: img.imagePath } },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
          },
          onError: () => {
            // Best-effort: allow a later image change to retry.
            delete campaignSyncedImagesRef.current[platform];
          },
        },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignImages, campaignDraftIds]);

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: {
      prompt: "",
      tone: "professional",
    },
  });

  // --- Studio session persistence ------------------------------------------
  // Everything in progress (creative brief, ideas, research, generated
  // caption/image/campaign/carousel, reference image, draft link) is mirrored
  // to localStorage per workspace, so navigating away from the Studio never
  // loses work. Base64 image previews are not stored; images restore from
  // their saved server paths. The session clears itself when the user saves,
  // discards, or empties the studio.
  const sessionKey = me?.tenant?.id ? `kokao-studio-session-v1:${me.tenant.id}` : null;
  const restoredKeyRef = useRef<string | null>(null);
  const watchedValues = form.watch();

  const clearStudioSession = () => {
    if (!sessionKey) return;
    try {
      localStorage.removeItem(sessionKey);
    } catch {
      // Best-effort.
    }
  };

  useEffect(() => {
    if (!sessionKey || restoredKeyRef.current === sessionKey) return;
    restoredKeyRef.current = sessionKey;
    try {
      const raw = localStorage.getItem(sessionKey);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (!s || s.v !== 1) return;
      if (s.form) {
        form.reset({
          prompt: typeof s.form.prompt === "string" ? s.form.prompt : "",
          tone: typeof s.form.tone === "string" ? s.form.tone : "professional",
          brandKitId: typeof s.form.brandKitId === "number" ? s.form.brandKitId : undefined,
        });
      }
      if (s.captionResult) setCaptionResult(s.captionResult);
      if (typeof s.captionPlatform === "string") setCaptionPlatform(s.captionPlatform);
      if (Array.isArray(s.briefQuestions) && s.briefQuestions.length > 0) setBriefQuestions(s.briefQuestions);
      if (typeof s.imagePath === "string" && s.imagePath) setImageResult({ imagePath: s.imagePath, b64Json: null });
      if (Array.isArray(s.campaignPosts) && s.campaignPosts.length > 0) setCampaignPosts(s.campaignPosts);
      if (typeof s.campaignTitle === "string") setCampaignTitle(s.campaignTitle);
      if (s.campaignImages && typeof s.campaignImages === "object") {
        const imgs: Record<string, GeneratedImage> = {};
        for (const [platform, path] of Object.entries(s.campaignImages)) {
          if (typeof path === "string" && path) imgs[platform] = { imagePath: path, b64Json: null };
        }
        if (Object.keys(imgs).length > 0) setCampaignImages(imgs);
      }
      if (s.carousel && Array.isArray(s.carousel.slides)) setCarousel(s.carousel);
      if (typeof s.carouselMode === "boolean") setCarouselMode(s.carouselMode);
      if (typeof s.carouselSlideCountText === "string") setCarouselSlideCountText(s.carouselSlideCountText);
      if (Array.isArray(s.campaignPlatforms)) setCampaignPlatforms(s.campaignPlatforms);
      if (typeof s.niche === "string") setNiche(s.niche);
      if (Array.isArray(s.topicIdeas)) setTopicIdeas(s.topicIdeas);
      if (typeof s.articleUrl === "string") setArticleUrl(s.articleUrl);
      if (typeof s.researchQuery === "string") setResearchQuery(s.researchQuery);
      if (s.researchResult) setResearchResult(s.researchResult);
      if (typeof s.referenceImagePath === "string" && s.referenceImagePath) {
        setReferenceImagePath(s.referenceImagePath);
        setReferencePreview(`/api/storage${s.referenceImagePath}`);
      }
      if (typeof s.draftId === "number") setDraft(s.draftId);
      if (s.campaignDraftIds && typeof s.campaignDraftIds === "object") {
        const ids: Record<string, number> = {};
        for (const [platform, id] of Object.entries(s.campaignDraftIds)) {
          if (typeof id === "number") ids[platform] = id;
        }
        if (Object.keys(ids).length > 0) {
          setCampaignDraftIds(ids);
          // Images restored from the session were already synced to these
          // drafts before it was saved; don't re-PATCH them on restore.
          if (s.campaignImages && typeof s.campaignImages === "object") {
            for (const [platform, path] of Object.entries(s.campaignImages)) {
              if (typeof path === "string" && path) campaignSyncedImagesRef.current[platform] = path;
            }
          }
        }
      }
    } catch {
      // Corrupt or inaccessible storage: start fresh.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);

  useEffect(() => {
    if (!sessionKey || restoredKeyRef.current !== sessionKey) return;
    const timer = setTimeout(() => {
      const hasWork =
        watchedValues.prompt.trim() !== "" ||
        captionResult !== null ||
        imageResult !== null ||
        (campaignPosts?.length ?? 0) > 0 ||
        carousel !== null ||
        (briefQuestions?.length ?? 0) > 0 ||
        topicIdeas.length > 0 ||
        researchResult !== null ||
        niche.trim() !== "" ||
        articleUrl.trim() !== "" ||
        researchQuery.trim() !== "" ||
        referenceImagePath !== null;
      try {
        if (!hasWork) {
          localStorage.removeItem(sessionKey);
          return;
        }
        const campaignImagePaths: Record<string, string> = {};
        for (const [platform, img] of Object.entries(campaignImages)) {
          if (img?.imagePath) campaignImagePaths[platform] = img.imagePath;
        }
        localStorage.setItem(
          sessionKey,
          JSON.stringify({
            v: 1,
            form: {
              prompt: watchedValues.prompt,
              tone: watchedValues.tone,
              brandKitId: watchedValues.brandKitId || undefined,
            },
            captionResult,
            captionPlatform,
            briefQuestions,
            imagePath: imageResult?.imagePath ?? null,
            campaignPosts,
            campaignTitle,
            campaignImages: campaignImagePaths,
            carousel: carousel
              ? { ...carousel, slides: carousel.slides.map((sl) => ({ ...sl, b64Json: null })) }
              : null,
            carouselMode,
            carouselSlideCountText,
            campaignPlatforms,
            niche,
            topicIdeas,
            articleUrl,
            researchQuery,
            researchResult,
            referenceImagePath,
            draftId,
            campaignDraftIds,
          }),
        );
      } catch {
        // Storage full or unavailable: persistence is best-effort.
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [
    sessionKey,
    watchedValues.prompt,
    watchedValues.tone,
    watchedValues.brandKitId,
    captionResult,
    captionPlatform,
    briefQuestions,
    imageResult,
    campaignPosts,
    campaignTitle,
    campaignImages,
    campaignDraftIds,
    carousel,
    carouselMode,
    carouselSlideCountText,
    campaignPlatforms,
    niche,
    topicIdeas,
    articleUrl,
    researchQuery,
    researchResult,
    referenceImagePath,
    draftId,
  ]);

  // Platform now comes from the Campaign platforms selection (first pick wins);
  // falls back to Instagram when nothing is selected. Image size follows it.
  const activePlatform = campaignPlatforms[0] ?? "instagram";
  const activeImageSize = PLATFORM_IMAGE_SIZE[activePlatform] ?? "1024x1024";

  const isOwner = me?.team ? me.team.role === "owner" : true;

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

  const handleError = (error: any) => {
    if (error?.status === 402 || error?.response?.status === 402) {
      const canRequestUpgrade = !isOwner && flags.upgradeRequests;
      // Members can't upgrade the plan or buy credits, so never show them
      // the server's owner-directed advice — give them copy they can act on.
      const memberDescription = canRequestUpgrade
        ? "The workspace has run out of AI quota. Ask your workspace owner to upgrade."
        : "The workspace is out of AI quota.";
      toast({
        title: "Quota Reached",
        description: isOwner
          ? error?.message ||
            "You've reached your monthly AI limit. Please upgrade your plan."
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
      toast({ title: "Error", description: error?.message || "Failed to generate content.", variant: "destructive" });
    }
  };

  const onPlatformPack = (values: z.infer<typeof schema>) => {
    generatePlatformPack.mutate(
      { data: { brief: values.prompt, brandKitId: values.brandKitId || undefined } },
      {
        onSuccess: (res) => {
          setPlatformPack(res);
          setPackOpen(true);
          refreshQuota();
        },
        onError: handleError,
      },
    );
  };

  const onSuggestTopics = () => {
    if (niche.trim().length < 2) {
      toast({ title: "Enter a niche", description: "Tell us a topic area first.", variant: "destructive" });
      return;
    }
    const brandKitId = form.getValues().brandKitId;
    suggestTopics.mutate(
      { data: { niche, brandKitId: brandKitId || undefined } },
      {
        onSuccess: (res) => {
          setTopicIdeas(res.ideas);
          if (res.ideas.length === 0) {
            toast({ title: "No ideas returned", description: "Try a different niche.", variant: "destructive" });
          }
        },
        onError: handleError,
      },
    );
  };

  const onSummarizeUrl = () => {
    if (!/^https?:\/\//i.test(articleUrl.trim())) {
      toast({ title: "Invalid URL", description: "Enter a full http(s) link.", variant: "destructive" });
      return;
    }
    summarizeUrl.mutate(
      { data: { url: articleUrl.trim() } },
      {
        onSuccess: (res) => {
          form.setValue("prompt", res.summary);
          toast({ title: "Article summarized", description: res.title || "Brief filled in below." });
        },
        onError: handleError,
      },
    );
  };

  const onResearch = () => {
    if (researchQuery.trim().length < 3) {
      toast({ title: "Enter a topic", description: "Tell us what to research first.", variant: "destructive" });
      return;
    }
    const brandKitId = form.getValues().brandKitId;
    setResearchResult(null);
    researchTopic.mutate(
      { data: { topic: researchQuery.trim(), brandKitId: brandKitId || undefined } },
      {
        onSuccess: (res) => {
          setResearchResult(res);
          toast({ title: "Research complete", description: `${res.sources.length} sources found.` });
        },
        onError: handleError,
      },
    );
  };

  const useResearchAsBrief = () => {
    if (!researchResult) return;
    const findings = researchResult.keyFindings.length
      ? ` Key facts: ${researchResult.keyFindings.join(" | ")}`
      : "";
    form.setValue("prompt", `${researchResult.summary}${findings}`.slice(0, 4000));
    toast({ title: "Research added to brief" });
  };

  const runGenerateCaption = (data: z.infer<typeof schema>, tweak: string | null) => {
    setCaptionTweak(tweak);
    const tweakInstruction = tweak
      ? ` ${CAPTION_TWEAKS.find((t) => t.label === tweak)?.instruction ?? tweak}`
      : "";
    const body = {
      prompt: `${data.prompt.trim()}${tweakInstruction}`,
      platform: activePlatform,
      brandKitId: data.brandKitId || undefined,
      tone: data.tone,
    };
    const onCaptionSuccess = (res: CaptionResultType) => {
      setCampaignPosts(null);
      setCarousel(null);
      if (res.clarifyingQuestions && res.clarifyingQuestions.length > 0) {
        setBriefQuestions(res.clarifyingQuestions);
        setCaptionResult(null);
        toast({
          title: "A bit more detail needed",
          description: "Answer the questions shown in Results, then generate again. Nothing was charged.",
        });
        return;
      }
      setBriefQuestions(null);
      setCaptionResult(res);
      setCaptionPlatform(activePlatform);
      refreshQuota();
      upsertDraft(res, imageResult);
      track("caption_generated", { category: "content", outcome: "success" });
      trackFeatureUse("studio_caption");
      toast({ title: "Caption generated!", description: "Auto-saved to your library as a draft." });
    };
    // Prefer the SSE endpoint so text appears as it is generated; fall back
    // to the JSON endpoint if the stream route is unavailable.
    setCaptionStreaming(true);
    streamCaptionRequest(body, (textSoFar) => {
      setCampaignPosts(null);
      setCarousel(null);
      setBriefQuestions(null);
      setCaptionPlatform(activePlatform);
      setCaptionResult({ caption: textSoFar, hashtags: [] });
    })
      .then(onCaptionSuccess)
      .catch((err) => {
        if (err?.status === 404 || err?.status === 405) {
          generateCaption.mutate({ data: body }, { onSuccess: onCaptionSuccess, onError: handleError });
          return;
        }
        setCaptionResult(null);
        handleError(err);
      })
      .finally(() => setCaptionStreaming(false));
  };

  const onGenerateCaption = (data: z.infer<typeof schema>) => runGenerateCaption(data, null);

  const runGenerateImage = (data: z.infer<typeof schema>, tweak: string | null) => {
    if ((brandKits?.length ?? 0) > 1 && !data.brandKitId) {
      toast({
        title: "Pick a brand kit",
        description:
          "You have more than one brand kit. Choose which brand this image is for, or the design won't know which brand to follow.",
        variant: "destructive",
      });
      return;
    }
    setImageTweak(tweak);
    const tweakInstruction = tweak
      ? ` ${IMAGE_TWEAKS.find((t) => t.label === tweak)?.instruction ?? tweak}`
      : "";
    const body: ImageRequest = {
      prompt: `${data.prompt.trim()}${tweakInstruction}`,
      promptRecipe: buildPromptRecipe(),
      size: activeImageSize,
      brandKitId: data.brandKitId || undefined,
      referenceImagePath:
        flags.referenceImages && referenceImagePath ? referenceImagePath : undefined,
    };
    const onImageSuccess = (res: { imagePath: string; b64Json: string | null }) => {
      setCampaignPosts(null);
      setCarousel(null);
      setBriefQuestions(null);
      setImageResult(res);
      refreshQuota();
      upsertDraft(captionResult, res);
      track("image_generated", { category: "content", outcome: "success" });
      trackFeatureUse("studio_image");
      toast({ title: "Image generated!", description: "Auto-saved to your library as a draft." });
    };
    if (flags.imageJobs) {
      runImageJob(body)
        .then(onImageSuccess)
        .catch((err) => {
          if (err?.imageJobCancelled) {
            refreshQuota();
            toast({
              title: "Generation cancelled",
              description: "The image job was cancelled before it started. Nothing was charged.",
            });
            return;
          }
          if (err?.status === 404 || err?.status === 403) {
            // Async jobs disabled server-side (404 route-gated or 403
            // feature_disabled if flags drift) — fall back to the sync route.
            generateImage.mutate({ data: body }, { onSuccess: onImageSuccess, onError: handleError });
            return;
          }
          handleError(err);
        });
      return;
    }
    generateImage.mutate({ data: body }, { onSuccess: onImageSuccess, onError: handleError });
  };

  /**
   * Background image generation (imageJobs kill switch): enqueue the job,
   * then poll until it finishes. Metering/refunds happen server-side in the
   * job runner, so quota behavior matches the sync route exactly.
   */
  const runImageJob = async (body: ImageRequest): Promise<{ imagePath: string; b64Json: string | null }> => {
    setImageJobBusy(true);
    setImageJobCancelling(false);
    try {
      const job = await generateImageAsync(body);
      const startedAt = Date.now();
      setImageJobState({ id: job.id, status: job.status, startedAt });
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        const latest = await getImageJob(job.id);
        setImageJobState({ id: job.id, status: latest.status, startedAt });
        if (latest.status === "succeeded" && latest.imagePath) {
          return { imagePath: latest.imagePath, b64Json: null };
        }
        if (latest.status === "cancelled") {
          const cancelledErr = new Error("cancelled") as Error & { imageJobCancelled?: boolean };
          cancelledErr.imageJobCancelled = true;
          throw cancelledErr;
        }
        if (latest.status === "failed") {
          throw new Error(latest.error || "Image generation failed. Nothing was charged.");
        }
        if (Date.now() - startedAt > 5 * 60_000) {
          throw new Error("Image generation is taking longer than expected. Please try again.");
        }
      }
    } finally {
      setImageJobBusy(false);
      setImageJobState(null);
      setImageJobCancelling(false);
    }
  };

  /**
   * Cancel the in-flight background image job. Only still-queued jobs can be
   * cancelled server-side (credit funding is refunded there); if the job
   * already started, the server answers 409 and generation continues.
   */
  const cancelRunningImageJob = async () => {
    if (!imageJobState || imageJobCancelling) return;
    setImageJobCancelling(true);
    try {
      await cancelImageJob(imageJobState.id);
      // The poll loop notices the cancelled status and unwinds; the toast
      // fires from the catch handler so it also covers races.
    } catch (err) {
      setImageJobCancelling(false);
      const status = (err as { status?: number })?.status;
      toast({
        title: status === 409 ? "Too late to cancel" : "Couldn't cancel",
        description:
          status === 409
            ? "Generation already started, so it will finish normally."
            : "Something went wrong cancelling the job. It will finish normally.",
      });
    }
  };

  const onGenerateImage = (data: z.infer<typeof schema>) => runGenerateImage(data, null);

  const onGenerateCampaign = (data: z.infer<typeof schema>) => {
    if (campaignPlatforms.length === 0) {
      toast({ title: "Select platforms", description: "Pick at least one platform.", variant: "destructive" });
      return;
    }
    const body = {
      prompt: data.prompt,
      platforms: campaignPlatforms,
      brandKitId: data.brandKitId || undefined,
      tone: data.tone,
    };
    const onCampaignSuccess = (res: CampaignResultType) => {
      if (res.clarifyingQuestions && res.clarifyingQuestions.length > 0) {
        setBriefQuestions(res.clarifyingQuestions);
        setCampaignPosts(null);
        setCampaignTitle(null);
        toast({
          title: "A bit more detail needed",
          description: "Answer the questions shown in Results, then generate again. Nothing was charged.",
        });
        return;
      }
      setBriefQuestions(null);
      setCaptionResult(null);
      setCaptionPlatform(null);
      setImageResult(null);
      setCarousel(null);
      setCampaignImages({});
      setPendingCampaignImage(null);
      setCampaignPosts(res.posts);
      setCampaignTitle(res.title ?? null);
      setDraft(null);
      autoSaveCampaignDrafts(res.posts, res.title ?? null);
      refreshQuota();
      track("campaign_generated", {
        category: "content",
        outcome: "success",
        platform_count: res.posts.length,
      });
      trackFeatureUse("campaign_generator");
      toast({ title: "Campaign generated!", description: `${res.posts.length} platform variants ready.` });
    };
    if (!flags.campaignStreaming) {
      generateCampaign.mutate({ data: body }, { onSuccess: onCampaignSuccess, onError: handleError });
      return;
    }
    // Prefer the SSE endpoint so each platform's caption appears as it is
    // written; fall back to the JSON endpoint if the stream route is
    // unavailable (kill switch off server-side, old deploy, proxy quirks).
    setCampaignStreaming(true);
    setBriefQuestions(null);
    setCaptionResult(null);
    setCaptionPlatform(null);
    setImageResult(null);
    setCarousel(null);
    setCampaignImages({});
    setPendingCampaignImage(null);
    setDraft(null);
    setCampaignTitle(null);
    setCampaignPosts(
      campaignPlatforms.map((platform) => ({
        platform,
        caption: "",
        hashtags: [],
        imagePrompt: "",
      })),
    );
    streamCampaignRequest(body, (platform, textSoFar) => {
      setCampaignPosts((prev) =>
        prev
          ? prev.map((p) => (p.platform === platform ? { ...p, caption: textSoFar } : p))
          : prev,
      );
    })
      .then(onCampaignSuccess)
      .catch((err) => {
        if (err?.status === 404 || err?.status === 403 || err?.status === 405) {
          generateCampaign.mutate({ data: body }, { onSuccess: onCampaignSuccess, onError: handleError });
          return;
        }
        setCampaignPosts(null);
        handleError(err);
      })
      .finally(() => setCampaignStreaming(false));
  };

  // Effective slide count: empty box falls back to 5; clamped to 2-10.
  // Only applies when the Carousel checkbox is ticked; otherwise 5.
  const parsedSlideCount = parseInt(carouselSlideCountText, 10);
  const carouselSlideCount = !carouselMode || Number.isNaN(parsedSlideCount)
    ? 5
    : Math.min(10, Math.max(2, parsedSlideCount));

  const onGenerateCarousel = (data: z.infer<typeof schema>) => {
    generateCarousel.mutate(
      {
        data: {
          prompt: data.prompt,
          slideCount: carouselSlideCount,
          platform: "linkedin",
          brandKitId: data.brandKitId || undefined,
          tone: data.tone,
        },
      },
      {
        onSuccess: (res) => {
          if (res.clarifyingQuestions && res.clarifyingQuestions.length > 0) {
            setBriefQuestions(res.clarifyingQuestions);
            setCarousel(null);
            toast({
              title: "A bit more detail needed",
              description: "Answer the questions shown in Results, then generate again. Nothing was charged.",
            });
            return;
          }
          setBriefQuestions(null);
          setCaptionResult(null);
          setCaptionPlatform(null);
          setImageResult(null);
          setCampaignPosts(null);
          setCampaignTitle(null);
          setDraft(null);
          setCarousel({
            title: res.title ?? "",
            caption: res.caption ?? "",
            hashtags: res.hashtags ?? [],
            slides: res.slides.map((s) => ({ ...s, imagePath: s.imagePath ?? null, b64Json: null })),
            carouselId: res.carouselId,
          });
          refreshQuota();
          track("carousel_generated", { category: "content", outcome: "success", slide_count: res.slides.length });
          trackFeatureUse("carousel_generator");
          toast({ title: "Carousel generated!", description: `${res.slides.length} slides ready. Now generate each slide's image.` });
        },
        onError: handleError,
      },
    );
  };

  /** Generate the image for one slide (metered like any studio image). */
  const generateSlideImage = async (index: number) => {
    const slide = carousel?.slides[index];
    if (!slide || !slide.imagePrompt) return;
    const brandKitId = form.getValues().brandKitId || undefined;
    setCarouselBusySlide(index);
    try {
      const res = await generateImage.mutateAsync({
        data: { prompt: slide.imagePrompt, size: "1024x1024", brandKitId },
      });
      setCarousel((prev) => {
        if (!prev) return prev;
        const slides = prev.slides.map((s, i) =>
          i === index ? { ...s, imagePath: res.imagePath, b64Json: res.b64Json } : s,
        );
        return { ...prev, slides };
      });
      refreshQuota();
    } catch (err) {
      handleError(err);
    } finally {
      setCarouselBusySlide(null);
    }
  };

  /** Generate every missing slide image, one at a time (each is metered). */
  const generateAllSlideImages = async () => {
    if (!carousel) return;
    const brandKitId = form.getValues().brandKitId || undefined;
    setCarouselBusySlide("all");
    try {
      for (let i = 0; i < carousel.slides.length; i++) {
        const slide = carousel.slides[i];
        if (!slide || slide.imagePath || !slide.imagePrompt) continue;
        const res = await generateImage.mutateAsync({
          data: { prompt: slide.imagePrompt, size: "1024x1024", brandKitId },
        });
        setCarousel((prev) => {
          if (!prev) return prev;
          const slides = prev.slides.map((s, j) =>
            j === i ? { ...s, imagePath: res.imagePath, b64Json: res.b64Json } : s,
          );
          return { ...prev, slides };
        });
        refreshQuota();
      }
    } catch (err) {
      handleError(err);
    } finally {
      setCarouselBusySlide(null);
    }
  };

  const saveCarousel = () => {
    if (!carousel) return;
    const values = form.getValues();
    const hashtagText = carousel.hashtags.length
      ? `\n\n${carousel.hashtags.map((h) => `#${h}`).join(" ")}`
      : "";
    const firstImage = carousel.slides.find((s) => s.imagePath) ?? null;
    setCarouselSaving(true);
    createContent.mutate(
      {
        data: {
          title:
            carousel.title.trim() ||
            values.prompt.trim().slice(0, 30) + (values.prompt.trim().length > 30 ? "..." : ""),
          caption: `${carousel.caption}${hashtagText}`,
          imagePath: firstImage?.imagePath || undefined,
          imagePrompt: firstImage?.imagePrompt || undefined,
          carouselSlides: carousel.slides.map((s) => ({
            heading: s.heading,
            body: s.body,
            imagePrompt: s.imagePrompt,
            imagePath: s.imagePath,
          })),
          platform: "linkedin",
          status: "draft" as const,
          brandKitId: values.brandKitId || undefined,
        },
      },
      {
        onSuccess: (item) => {
          setCarouselSaving(false);
          if (item?.id) {
            recordTasteSignal.mutate({ data: { contentItemId: item.id, kind: "saved" } });
          }
          queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
          track("content_saved", { category: "content", outcome: "success" });
          toast({ title: "Carousel saved to library!" });
          // Saved to the library: reset the whole Studio to a fresh page.
          resetStudio();
          navigate("/library");
        },
        onError: (err: unknown) => {
          setCarouselSaving(false);
          toast({ title: "Failed to save", description: (err as any).message, variant: "destructive" });
        },
      },
    );
  };

  /**
   * Generate images for every campaign platform that doesn't have one yet,
   * up to 3 at a time. Each image is metered individually (same as clicking
   * the per-card button); results apply directly to their platform without
   * the "apply to all?" dialog.
   */
  const generateAllCampaignImages = async () => {
    if (!campaignPosts) return;
    const brandKitId = form.getValues().brandKitId || undefined;
    const targets = campaignPosts.filter((p) => !campaignImages[p.platform]);
    if (targets.length === 0) return;
    setCampaignBulkBusy(true);
    let failures = 0;
    let firstError: unknown = null;
    const queue = [...targets];
    const worker = async () => {
      for (;;) {
        const post = queue.shift();
        if (!post) return;
        try {
          const res = await generateImage.mutateAsync({
            data: {
              prompt: (post.imagePrompt || post.caption).trim(),
              brandKitId,
            },
          });
          setCampaignImages((prev) => ({ ...prev, [post.platform]: res }));
        } catch (err) {
          failures += 1;
          if (!firstError) firstError = err;
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(3, targets.length) }, worker));
    } finally {
      setCampaignBulkBusy(false);
    }
    refreshQuota();
    if (failures > 0) {
      handleError(firstError);
      if (failures < targets.length) {
        toast({
          title: "Some images finished",
          description: `${targets.length - failures} of ${targets.length} images were generated.`,
        });
      }
    } else {
      toast({ title: "All campaign images generated!" });
    }
  };

  const handleCampaignImageGenerated = (platform: string, image: GeneratedImage) => {
    if ((campaignPosts?.length ?? 0) <= 1) {
      setCampaignImages((prev) => ({ ...prev, [platform]: image }));
      return;
    }
    setPendingCampaignImage({ platform, image });
  };

  const applyPendingImage = (allPlatforms: boolean) => {
    if (!pendingCampaignImage) return;
    const { platform, image } = pendingCampaignImage;
    if (allPlatforms && campaignPosts) {
      const next: Record<string, GeneratedImage> = {};
      for (const post of campaignPosts) next[post.platform] = image;
      setCampaignImages(next);
      toast({ title: "Image applied to all platforms" });
    } else {
      setCampaignImages((prev) => ({ ...prev, [platform]: image }));
    }
    setPendingCampaignImage(null);
  };

  // "Schedule the week": auto-slot each campaign post into consecutive daily
  // time slots (starting tomorrow at 10:00 local) in one click.
  const [scheduleWeekBusy, setScheduleWeekBusy] = useState(false);

  const ensureCampaignDraft = async (post: CampaignPost): Promise<number> => {
    const existing = campaignDraftIds[post.platform];
    if (existing) return existing;
    const epoch = campaignEpochRef.current;
    const imagePath = campaignImages[post.platform]?.imagePath;
    const item = await createContent.mutateAsync({
      data: buildCampaignDraftData(post, campaignTitle, imagePath),
    });
    if (campaignEpochRef.current === epoch) {
      if (imagePath) campaignSyncedImagesRef.current[post.platform] = imagePath;
      setCampaignDraftIds((prev) => ({ ...prev, [post.platform]: item.id }));
    }
    return item.id;
  };

  const scheduleTheWeek = async () => {
    if (!campaignPosts || campaignPosts.length === 0) return;
    const targets = campaignPosts.filter((p) => platformLive[p.platform]);
    if (targets.length === 0) {
      toast({
        title: "No connected accounts",
        description: "Connect the campaign's social accounts to schedule these posts.",
        variant: "destructive",
      });
      return;
    }
    setScheduleWeekBusy(true);
    const scheduled: string[] = [];
    const failed: string[] = [];
    try {
      for (let i = 0; i < targets.length; i++) {
        const post = targets[i];
        const label = QUICK_PUBLISH_LABELS[post.platform] ?? post.platform;
        const when = new Date();
        when.setDate(when.getDate() + i + 1);
        when.setHours(10, 0, 0, 0);
        try {
          const id = await ensureCampaignDraft(post);
          await createSchedule.mutateAsync({
            data: { contentItemId: id, platform: post.platform, scheduledAt: when.toISOString() },
          });
          scheduled.push(
            `${label} (${when.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })})`,
          );
        } catch {
          failed.push(label);
        }
      }
    } finally {
      setScheduleWeekBusy(false);
    }
    queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListSchedulesQueryKey() });
    const skipped = campaignPosts.length - targets.length;
    if (failed.length === 0 && scheduled.length > 0) {
      track("campaign_week_scheduled", { category: "content", outcome: "success", post_count: scheduled.length });
      toast({
        title: "Week scheduled!",
        description:
          `${scheduled.join(", ")} — one per day at 10:00.` +
          (skipped > 0 ? ` ${skipped} platform${skipped === 1 ? "" : "s"} skipped (not connected).` : ""),
      });
      // Everything is scheduled: reset the Studio for the next idea.
      resetStudio();
    } else if (scheduled.length > 0) {
      toast({
        title: "Partially scheduled",
        description: `Scheduled ${scheduled.join(", ")}. Failed: ${failed.join(", ")}. You can schedule those from the Library.`,
        variant: "destructive",
      });
    } else {
      toast({
        title: "Scheduling failed",
        description: "Nothing could be scheduled. Try again or use the Library.",
        variant: "destructive",
      });
    }
  };

  /**
   * Full Studio reset after a successful save: the work now lives in the
   * library, so every input and result returns to a fresh page — prompt,
   * results, brainstorm/research fields, reference image, and the persisted
   * session.
   */
  const resetStudio = () => {
    setDraft(null);
    setCaptionResult(null);
    setCaptionPlatform(null);
    setCaptionTweak(null);
    setImageResult(null);
    setImageTweak(null);
    setBriefQuestions(null);
    setCampaignPosts(null);
    setCampaignTitle(null);
    setCampaignImages({});
    setCampaignDraftIds({});
    setPendingCampaignImage(null);
    setCarousel(null);
    setNiche("");
    setTopicIdeas([]);
    setArticleUrl("");
    setResearchQuery("");
    setResearchResult(null);
    setReferenceImagePath(null);
    setReferencePreview(null);
    form.reset({ prompt: "", tone: "professional", brandKitId: undefined });
    savedCampaignPlatformsRef.current = new Set();
    clearStudioSession();
  };

  // Tracks which campaign posts have been saved via their per-card Save
  // button; once every post is in the library the Studio resets itself.
  const savedCampaignPlatformsRef = useRef<Set<string>>(new Set());
  const handleCampaignPostSaved = (platform: string) => {
    savedCampaignPlatformsRef.current.add(platform);
    const allSaved =
      (campaignPosts?.length ?? 0) > 0 &&
      campaignPosts!.every((p) => savedCampaignPlatformsRef.current.has(p.platform));
    if (allSaved) {
      savedCampaignPlatformsRef.current = new Set();
      toast({
        title: "Campaign saved",
        description: "All posts are in your library. The Studio is ready for a new idea.",
      });
      resetStudio();
      navigate("/library");
    }
  };

  const handleSave = () => {
    if (!captionResult?.caption && !imageResult?.imagePath) {
      toast({ title: "Nothing to save", variant: "destructive" });
      return;
    }

    const data = buildDraftData(captionResult, imageResult);
    const onSaved = (saved?: { id?: number }) => {
      // Taste memory: an explicit "Save to Library" is an approval signal.
      // Fire-and-forget; a failure here must not affect the save flow.
      const savedId = saved?.id ?? draftId;
      if (savedId) {
        recordTasteSignal.mutate({ data: { contentItemId: savedId, kind: "saved" } });
      }
      queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
      track("content_saved", { category: "content", outcome: "success" });
      toast({ title: "Saved to library!" });
      // The work is now in the library: reset the whole Studio to a fresh
      // page so nothing lingers (or gets re-persisted) when it reopens.
      resetStudio();
      navigate("/library");
    };
    const onSaveError = (err: unknown) => {
      toast({ title: "Failed to save", description: (err as any).message, variant: "destructive" });
    };

    if (draftId) {
      updateContent.mutate(
        { id: draftId, data },
        {
          onSuccess: onSaved,
          onError: (err: any) => {
            const status = err?.status ?? err?.response?.status;
            if (status === 404) {
              // The auto-saved draft was deleted elsewhere (or a restored
              // session pointed at a stale id): recreate instead of failing.
              setDraft(null);
              createContent.mutate({ data }, { onSuccess: onSaved, onError: onSaveError });
              return;
            }
            onSaveError(err);
          },
        },
      );
    } else {
      createContent.mutate({ data }, { onSuccess: onSaved, onError: onSaveError });
    }
  };

  const handleDiscard = () => {
    const finish = () => {
      setDraft(null);
      setCaptionResult(null);
      setCaptionPlatform(null);
      setImageResult(null);
      setBriefQuestions(null);
      queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
      toast({ title: "Discarded", description: "The draft was removed from your library." });
    };
    if (draftId) {
      deleteContent.mutate(
        { id: draftId },
        {
          onSuccess: finish,
          onError: finish, // already gone — just clear locally
        },
      );
    } else {
      finish();
    }
  };

  const isPending =
    generateCaption.isPending ||
    captionStreaming ||
    campaignStreaming ||
    generateImage.isPending ||
    imageJobBusy ||
    campaignBulkBusy ||
    generateCampaign.isPending ||
    generateCarousel.isPending ||
    researchTopic.isPending ||
    createContent.isPending ||
    updateContent.isPending ||
    deleteContent.isPending;

  const captionsLeft =
    me && me.limits.captions !== -1 ? Math.max(0, me.limits.captions - me.usage.captions) : null;
  const imagesLeft =
    me && me.limits.images !== -1 ? Math.max(0, me.limits.images - me.usage.images) : null;
  const captionCredits = me?.credits?.captionCredits ?? 0;
  const imageCredits = me?.credits?.imageCredits ?? 0;
  const imagesExhausted = imagesLeft === 0 && imageCredits === 0;
  const imageLimitHint = imagesExhausted
    ? "Monthly image limit reached. Upgrade your plan or buy credits to keep generating images."
    : undefined;

  const selectedBrandKitId = form.watch("brandKitId") || undefined;
  const selectedBrandKit = selectedBrandKitId
    ? brandKits?.find((bk) => bk.id === selectedBrandKitId)
    : undefined;
  const selectedSwatches = selectedBrandKit ? kitSwatches(selectedBrandKit, 6) : [];
  const currentPrompt = form.watch("prompt");
  const hasSingleResult = captionResult || imageResult;

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-6xl mx-auto">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        <div className="lg:col-span-5 space-y-6">
          <Card className="border-border shadow-md">
            <CardHeader>
              <CardTitle>Start with an idea</CardTitle>
              <CardDescription>Brainstorm topics or pull a brief from an article.</CardDescription>
            </CardHeader>
            <CardContent>
              <Tabs value={brainstormTab} onValueChange={onBrainstormTabChange}>
                <TabsList className="grid w-full grid-cols-3">
                  <TabsTrigger value="ideas">
                    <Lightbulb className="mr-2 h-4 w-4" /> Ideas
                  </TabsTrigger>
                  <TabsTrigger value="research">
                    <Globe className="mr-2 h-4 w-4" /> Research
                  </TabsTrigger>
                  <TabsTrigger value="url">
                    <Link2 className="mr-2 h-4 w-4" /> From URL
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="ideas" className="space-y-3 pt-4">
                  <div className="flex gap-2">
                    <Input
                      placeholder="e.g. Fitness, AI, Travel Tips"
                      value={niche}
                      onChange={(e) => setNiche(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          onSuggestTopics();
                        }
                      }}
                    />
                    <Button type="button" variant="secondary" onClick={onSuggestTopics} disabled={suggestTopics.isPending}>
                      {suggestTopics.isPending ? (
                        <RippleSpinner className="h-4 w-4" />
                      ) : (
                        <Lightbulb className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                  <VoiceNoteButton
                    onTranscript={(text) => {
                      setNiche((prev) => (prev ? `${prev} ${text}` : text));
                      toast({ title: "Voice note added", description: "Your topic was filled in from the recording." });
                    }}
                    disabled={suggestTopics.isPending}
                  />
                  {topicIdeas.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs text-muted-foreground">Click an idea to use it as your brief:</p>
                      {topicIdeas.map((idea, i) => (
                        <button
                          key={i}
                          type="button"
                          onClick={() => {
                            form.setValue("prompt", idea);
                            toast({ title: "Idea added to brief" });
                          }}
                          className="w-full text-left text-sm rounded-md border border-border px-3 py-2 hover:bg-accent hover:border-primary/40 transition-colors"
                        >
                          {idea}
                        </button>
                      ))}
                    </div>
                  )}
                </TabsContent>
                <TabsContent value="research" className="space-y-3 pt-4">
                  <div className="flex gap-2">
                    <Input
                      placeholder="e.g. Latest Instagram algorithm changes"
                      value={researchQuery}
                      onChange={(e) => setResearchQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          onResearch();
                        }
                      }}
                      data-testid="input-research-topic"
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={onResearch}
                      disabled={researchTopic.isPending}
                      data-testid="button-research"
                    >
                      {researchTopic.isPending ? (
                        <RippleSpinner className="h-4 w-4" />
                      ) : (
                        <Globe className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                  <VoiceNoteButton
                    onTranscript={(text) => {
                      setResearchQuery((prev) => (prev ? `${prev} ${text}` : text));
                      toast({ title: "Voice note added", description: "Your research question was filled in from the recording." });
                    }}
                    disabled={researchTopic.isPending}
                  />
                  <p className="text-xs text-muted-foreground">
                    Searches the live web and builds a sourced brief with current facts.
                  </p>
                  {researchTopic.isPending && (
                    <p className="text-xs text-muted-foreground">
                      Searching the web, this can take up to a minute...
                    </p>
                  )}
                  {researchResult && (
                    <div className="space-y-3" data-testid="research-result">
                      <div className="rounded-md border border-border p-3 space-y-2">
                        <p className="text-sm whitespace-pre-wrap">{researchResult.summary}</p>
                        {researchResult.keyFindings.length > 0 && (
                          <ul className="text-xs text-muted-foreground list-disc pl-4 space-y-1">
                            {researchResult.keyFindings.map((f, i) => (
                              <li key={i}>{f}</li>
                            ))}
                          </ul>
                        )}
                        <Button type="button" size="sm" className="w-full" onClick={useResearchAsBrief} data-testid="button-use-research">
                          Use as brief
                        </Button>
                      </div>
                      {researchResult.sources.length > 0 && (
                        <div className="space-y-1">
                          <p className="text-xs font-medium">Sources</p>
                          {researchResult.sources.map((s, i) => (
                            <a
                              key={i}
                              href={s.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary transition-colors truncate"
                            >
                              <ExternalLink className="h-3 w-3 shrink-0" />
                              <span className="truncate">{s.title}</span>
                            </a>
                          ))}
                        </div>
                      )}
                      {researchResult.suggestedAngles.length > 0 && (
                        <div className="space-y-2">
                          <p className="text-xs text-muted-foreground">Or start from a suggested angle:</p>
                          {researchResult.suggestedAngles.map((angle, i) => (
                            <button
                              key={i}
                              type="button"
                              onClick={() => {
                                form.setValue("prompt", angle);
                                toast({ title: "Angle added to brief" });
                              }}
                              className="w-full text-left text-sm rounded-md border border-border px-3 py-2 hover:bg-accent hover:border-primary/40 transition-colors"
                            >
                              {angle}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </TabsContent>
                <TabsContent value="url" className="space-y-3 pt-4">
                  <div className="flex gap-2">
                    <Input
                      placeholder="https://example.com/blog/article"
                      value={articleUrl}
                      onChange={(e) => setArticleUrl(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          onSummarizeUrl();
                        }
                      }}
                    />
                    <Button type="button" variant="secondary" onClick={onSummarizeUrl} disabled={summarizeUrl.isPending}>
                      {summarizeUrl.isPending ? (
                        <RippleSpinner className="h-4 w-4" />
                      ) : (
                        <Link2 className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    We fetch the article and summarize it into your brief.
                  </p>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>

          <Card className="border-border shadow-md">
            <CardHeader>
              <CardTitle>Creative Brief</CardTitle>
              <CardDescription>Tell the AI what you want to create.</CardDescription>
            </CardHeader>
            <CardContent>
              <Form {...form}>
                <form className="space-y-4">
                  <FormField
                    control={form.control}
                    name="prompt"
                    render={({ field }) => (
                      <FormItem>
                        <div className="flex items-center justify-between">
                          <FormLabel>Prompt</FormLabel>
                          <VoiceNoteButton
                            onTranscript={(text) => {
                              const current = form.getValues("prompt");
                              form.setValue("prompt", current ? `${current.trim()} ${text}` : text, {
                                shouldValidate: true,
                              });
                            }}
                          />
                        </div>
                        <FormControl>
                          <Textarea
                            placeholder="e.g. A post announcing our new summer coffee blend, focus on the refreshing taste."
                            className="min-h-[120px] resize-none"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {flags.carousel && (
                    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3">
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id="carousel-mode"
                          checked={carouselMode}
                          onCheckedChange={(v) => setCarouselMode(v === true)}
                          data-testid="checkbox-carousel-mode"
                        />
                        <Label htmlFor="carousel-mode" className="text-sm font-medium cursor-pointer">
                          Carousel
                        </Label>
                      </div>
                      {carouselMode && (
                        <div className="flex items-center gap-2">
                          <Label htmlFor="carousel-slide-count" className="text-sm text-muted-foreground">
                            Slides
                          </Label>
                          <Input
                            id="carousel-slide-count"
                            type="number"
                            min={2}
                            max={10}
                            placeholder="5"
                            value={carouselSlideCountText}
                            onChange={(e) => setCarouselSlideCountText(e.target.value)}
                            onBlur={() => setCarouselSlideCountText(String(carouselSlideCount))}
                            className="h-8 w-20"
                            data-testid="input-carousel-slide-count"
                          />
                          <span className="text-xs text-muted-foreground">max 10 (empty = 5)</span>
                        </div>
                      )}
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="tone"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Tone</FormLabel>
                          <Select onValueChange={field.onChange} defaultValue={field.value}>
                            <FormControl>
                              <SelectTrigger>
                                <SelectValue placeholder="Tone" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="professional">Professional</SelectItem>
                              <SelectItem value="casual">Casual</SelectItem>
                              <SelectItem value="funny">Funny</SelectItem>
                              <SelectItem value="enthusiastic">Energetic</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="brandKitId"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Brand Kit</FormLabel>
                          <Select
                            onValueChange={(val) => field.onChange(val === "none" ? 0 : parseInt(val))}
                            value={field.value ? field.value.toString() : "none"}
                          >
                            <FormControl>
                              <SelectTrigger>
                                <SelectValue placeholder="None" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="none">None</SelectItem>
                              {brandKits?.map((bk) => (
                                <SelectItem key={bk.id} value={bk.id.toString()}>
                                  <span className="flex items-center gap-2">
                                    {bk.name}
                                    <SwatchStrip hexes={kitSwatches(bk)} size={10} />
                                  </span>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  {flags.referenceImages && (
                    <div className="rounded-lg border border-border p-3 space-y-2">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <ImageIcon className="h-4 w-4" /> Reference image (optional)
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Upload an image whose style, colors, and mood the generated image should
                        follow.
                      </p>
                      <input
                        ref={referenceFileRef}
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) void handleReferenceUpload(file);
                        }}
                        data-testid="input-reference-image"
                      />
                      {referenceImagePath && referencePreview ? (
                        <div className="flex items-center gap-3" data-testid="reference-image-preview">
                          <img
                            src={referencePreview}
                            alt="Reference"
                            className="h-14 w-14 rounded-md border border-border object-cover"
                          />
                          <div className="flex-1 text-xs text-muted-foreground">
                            This image will guide your next generation.
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={clearReferenceImage}
                            data-testid="button-remove-reference-image"
                          >
                            <X className="h-4 w-4 mr-1" /> Remove
                          </Button>
                        </div>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            disabled={referenceUploading}
                            onClick={() => referenceFileRef.current?.click()}
                            data-testid="button-upload-reference-image"
                          >
                            {referenceUploading ? (
                              <RippleSpinner className="h-4 w-4 mr-2" />
                            ) : (
                              <Upload className="h-4 w-4 mr-2" />
                            )}
                            Upload reference image
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setSavedPickerOpen(true)}
                            data-testid="button-pick-saved-reference"
                          >
                            Choose from saved
                          </Button>
                        </div>
                      )}
                      <SavedVisualPickerDialog
                        open={savedPickerOpen}
                        onOpenChange={setSavedPickerOpen}
                        onPick={(imagePath) => {
                          clearReferenceImage();
                          setReferenceImagePath(imagePath);
                          setReferencePreview(`/api/storage${imagePath}`);
                        }}
                      />
                    </div>
                  )}

                  {flags.imageLooks && (
                  <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <Camera className="h-4 w-4" /> Look
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Optional, images only. Picks the shoot so the model gets real
                      photographic direction instead of adjectives.
                    </p>
                    <ToggleGroup
                      type="single"
                      variant="outline"
                      value={lookPreset}
                      onValueChange={setLookPreset}
                      className="flex flex-wrap justify-start gap-2"
                    >
                      {(Object.keys(LOOK_PRESETS) as ImagePromptRecipePreset[]).map((id) => (
                        <ToggleGroupItem
                          key={id}
                          value={id}
                          data-testid={`toggle-look-${id}`}
                          className="text-xs px-3 cursor-pointer border-foreground/25 text-foreground shadow-sm hover:border-foreground/40 hover:bg-accent hover:text-accent-foreground data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:hover:bg-primary/90 data-[state=on]:hover:text-primary-foreground"
                        >
                          {LOOK_PRESETS[id]}
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                    <button
                      type="button"
                      onClick={() => setLookGearOpen((open) => !open)}
                      className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                      data-testid="button-toggle-look-gear"
                    >
                      {lookGearOpen
                        ? "Hide camera details"
                        : `Camera details${lookGearSet > 0 ? ` (${lookGearSet})` : ""}`}
                    </button>
                    {lookGearOpen && (
                      <div className="grid grid-cols-2 gap-2 pt-1">
                        {LOOK_GEAR_AXES.map((axis) => (
                          <div key={axis.key} className="space-y-1">
                            <Label
                              htmlFor={`look-${axis.key}`}
                              className="text-xs text-muted-foreground"
                            >
                              {axis.label}
                            </Label>
                            <Select
                              value={lookGear[axis.key]}
                              onValueChange={(value) =>
                                setLookGear((prev) => ({ ...prev, [axis.key]: value }))
                              }
                            >
                              <SelectTrigger
                                id={`look-${axis.key}`}
                                className="h-8 text-xs"
                                data-testid={`select-look-${axis.key}`}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value={LOOK_AUTO}>Auto</SelectItem>
                                {Object.entries(axis.options).map(([id, label]) => (
                                  <SelectItem key={id} value={id}>
                                    {label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  )}

                  <div className="rounded-lg border border-border p-3 space-y-2">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <Layers className="h-4 w-4" /> Campaign platforms
                    </div>
                    <p className="text-xs text-muted-foreground">
                      For multi-platform generation, choose which platforms to tailor for. Only
                      connected accounts can be selected.
                    </p>
                    <ToggleGroup
                      type="multiple"
                      variant="outline"
                      value={campaignPlatforms}
                      onValueChange={(val) => setCampaignPlatforms(val.filter((p) => platformLive[p]))}
                      className="flex flex-wrap justify-start gap-2"
                    >
                      {CAMPAIGN_PLATFORMS.map((p) => {
                        const live = platformLive[p.value];
                        const item = (
                          <ToggleGroupItem
                            key={p.value}
                            value={p.value}
                            disabled={connectionsLoading}
                            title={connectionsLoading ? "Checking connections..." : undefined}
                            onClick={(e) => {
                              if (!connectionsLoading && !live) {
                                e.preventDefault();
                                navigate("/accounts");
                              }
                            }}
                            data-testid={`toggle-campaign-${p.value}`}
                            className={
                              "text-xs px-3 cursor-pointer border-foreground/25 text-foreground shadow-sm hover:border-foreground/40 hover:bg-accent hover:text-accent-foreground data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:hover:bg-primary/90 data-[state=on]:hover:text-primary-foreground disabled:cursor-not-allowed disabled:opacity-40" +
                              (!connectionsLoading && !live ? " opacity-40 hover:opacity-70" : "")
                            }
                          >
                            {p.label}
                          </ToggleGroupItem>
                        );
                        if (connectionsLoading || live) return item;
                        return (
                          <Tooltip key={p.value}>
                            <TooltipTrigger asChild>{item}</TooltipTrigger>
                            <TooltipContent data-testid={`tooltip-connect-${p.value}`}>
                              Connect account to activate. Click to open Accounts.
                            </TooltipContent>
                          </Tooltip>
                        );
                      })}
                    </ToggleGroup>
                    {!connectionsLoading &&
                      CAMPAIGN_PLATFORMS.every((p) => !platformLive[p.value]) && (
                        <p className="text-xs text-muted-foreground" data-testid="text-no-campaign-platforms">
                          No social accounts are connected yet.{" "}
                          <a href="/accounts" className="underline" onClick={(e) => { e.preventDefault(); navigate("/accounts"); }}>
                            Connect accounts
                          </a>{" "}
                          to enable campaign generation.
                        </p>
                      )}
                  </div>

                  <div className="pt-2 flex flex-col gap-3">
                    {selectedBrandKit && selectedSwatches.length > 0 && (
                      <div
                        className="flex items-center gap-2 text-xs text-muted-foreground"
                        data-testid="active-brand-palette"
                      >
                        <span>Generating for {selectedBrandKit.name}</span>
                        <SwatchStrip hexes={selectedSwatches} size={14} />
                      </div>
                    )}
                    <Button
                      type="button"
                      onClick={form.handleSubmit(onGenerateCampaign)}
                      disabled={isPending || campaignPlatforms.length === 0}
                      className="w-full"
                      data-testid="button-generate-campaign"
                    >
                      {generateCampaign.isPending || campaignStreaming ? (
                        <RippleSpinner className="mr-2 h-4 w-4" />
                      ) : (
                        <Layers className="mr-2 h-4 w-4" />
                      )}
                      Generate Campaign ({campaignPlatforms.length})
                    </Button>
                    {flags.carousel && (
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={form.handleSubmit(onGenerateCarousel)}
                        disabled={isPending || generateCarousel.isPending}
                        className="w-full"
                        data-testid="button-generate-carousel"
                      >
                        {generateCarousel.isPending ? (
                          <RippleSpinner className="mr-2 h-4 w-4" />
                        ) : (
                          <GalleryHorizontalEnd className="mr-2 h-4 w-4" />
                        )}
                        Generate Carousel ({carouselSlideCount} slides)
                      </Button>
                    )}
                    <div className="grid grid-cols-2 gap-3">
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={form.handleSubmit(onGenerateCaption)}
                        disabled={isPending}
                        data-testid="button-generate-caption"
                      >
                        {generateCaption.isPending || captionStreaming ? (
                          <RippleSpinner className="mr-2 h-4 w-4" />
                        ) : (
                          <Wand2 className="mr-2 h-4 w-4" />
                        )}
                        Caption
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={form.handleSubmit(onGenerateImage)}
                        disabled={isPending || imagesExhausted}
                        title={imageLimitHint}
                        data-testid="button-generate-image"
                      >
                        {generateImage.isPending || imageJobBusy ? (
                          <RippleSpinner className="mr-2 h-4 w-4" />
                        ) : (
                          <ImageIcon className="mr-2 h-4 w-4" />
                        )}
                        Image
                      </Button>
                    </div>
                    {flags.viralToolkit && (
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={form.handleSubmit(onPlatformPack)}
                        disabled={isPending || generatePlatformPack.isPending}
                        className="w-full"
                        data-testid="button-platform-pack"
                      >
                        {generatePlatformPack.isPending ? (
                          <RippleSpinner className="mr-2 h-4 w-4" />
                        ) : (
                          <Layers className="mr-2 h-4 w-4" />
                        )}
                        Platform pack — one brief, every platform
                      </Button>
                    )}
                    {imagesExhausted && (
                      <p className="text-xs text-destructive" data-testid="image-quota-hint">
                        {imageLimitHint}
                      </p>
                    )}
                  </div>
                </form>
              </Form>
            </CardContent>
          </Card>

          <Dialog open={packOpen} onOpenChange={setPackOpen}>
            <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle data-testid="text-pack-title">
                  {platformPack?.title || "Platform pack"}
                </DialogTitle>
                <DialogDescription>
                  One brief, rewritten natively for each platform. Copy what you need.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                {platformPack?.items.map((item) => (
                  <div
                    key={item.platform}
                    className="border border-border rounded-md p-3 space-y-2"
                    data-testid={`pack-item-${item.platform}`}
                  >
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="capitalize">{item.platform}</Badge>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="ml-auto"
                        onClick={() => {
                          const tags = item.hashtags.map((h) => `#${h}`).join(" ");
                          void navigator.clipboard.writeText(
                            tags ? `${item.caption}\n\n${tags}` : item.caption,
                          );
                          toast({ title: "Copied", description: `${item.platform} caption copied.` });
                        }}
                        data-testid={`button-copy-pack-${item.platform}`}
                      >
                        Copy
                      </Button>
                    </div>
                    <p className="text-sm whitespace-pre-wrap">{item.caption}</p>
                    {item.hashtags.length > 0 && (
                      <p className="text-xs text-muted-foreground break-words">
                        {item.hashtags.map((h) => `#${h}`).join(" ")}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </DialogContent>
          </Dialog>
        </div>

        <div className="lg:col-span-7 flex flex-col gap-6 lg:sticky lg:top-6 lg:self-start lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto">
          {carousel ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-xl font-bold" data-testid="text-carousel-title">
                    {carousel.title || "Carousel"}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    Generate an image for each slide, then save the carousel to your library. On
                    LinkedIn it publishes as a swipeable document.
                  </p>
                  <AiSpentLine
                    paise={aiSpendPaise(1, carousel.slides.filter((s) => s.imagePath).length)}
                    testId="text-ai-spent-carousel"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setCarousel(null)}
                    disabled={carouselBusySlide !== null || carouselSaving}
                    data-testid="button-discard-carousel"
                  >
                    <Trash2 className="mr-2 h-4 w-4" /> Discard
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={saveCarousel}
                    disabled={carouselBusySlide !== null || carouselSaving}
                    data-testid="button-save-carousel"
                  >
                    {carouselSaving ? (
                      <RippleSpinner className="mr-2 h-4 w-4" />
                    ) : (
                      <Save className="mr-2 h-4 w-4" />
                    )}
                    Save to Library
                  </Button>
                </div>
              </div>
              {carousel.caption && (
                <Card className="border-border">
                  <CardContent className="pt-4 space-y-2">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Post caption
                    </p>
                    <p className="text-sm whitespace-pre-wrap" data-testid="text-carousel-caption">
                      {carousel.caption}
                    </p>
                    {carousel.hashtags.length > 0 && (
                      <p className="text-sm text-primary">
                        {carousel.hashtags.map((h) => `#${h}`).join(" ")}
                      </p>
                    )}
                  </CardContent>
                </Card>
              )}
              {carousel.slides.some((s) => !s.imagePath) && (
                <Button
                  type="button"
                  variant="secondary"
                  className="w-full"
                  onClick={generateAllSlideImages}
                  disabled={carouselBusySlide !== null || imagesExhausted}
                  title={imageLimitHint}
                  data-testid="button-generate-all-slide-images"
                >
                  {carouselBusySlide === "all" ? (
                    <RippleSpinner className="mr-2 h-4 w-4" />
                  ) : (
                    <ImageIcon className="mr-2 h-4 w-4" />
                  )}
                  Generate all slide images (
                  {carousel.slides.filter((s) => !s.imagePath).length} left, one image each)
                </Button>
              )}
              {carousel.slides.map((slide, i) => (
                <Card key={i} className="border-border" data-testid={`card-carousel-slide-${i}`}>
                  <CardContent className="pt-4 flex flex-col sm:flex-row gap-4">
                    <div className="sm:w-48 shrink-0">
                      {slide.b64Json ? (
                        <img
                          src={`data:image/png;base64,${slide.b64Json}`}
                          alt={`Slide ${i + 1}`}
                          className="w-full rounded-md border border-border object-cover aspect-square"
                        />
                      ) : slide.imagePath ? (
                        <img
                          src={`/api/storage${slide.imagePath}`}
                          alt={`Slide ${i + 1}`}
                          className="w-full rounded-md border border-border object-cover aspect-square"
                        />
                      ) : (
                        <div className="w-full aspect-square rounded-md border border-dashed border-border flex items-center justify-center bg-muted/30">
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => void generateSlideImage(i)}
                            disabled={carouselBusySlide !== null || imagesExhausted}
                            title={imageLimitHint}
                            data-testid={`button-generate-slide-image-${i}`}
                          >
                            {carouselBusySlide === i ? (
                              <RippleSpinner className="mr-2 h-4 w-4" />
                            ) : (
                              <ImageIcon className="mr-2 h-4 w-4" />
                            )}
                            Image
                          </Button>
                        </div>
                      )}
                    </div>
                    <div className="flex-1 space-y-1.5">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        Slide {i + 1} of {carousel.slides.length}
                      </p>
                      <h3 className="font-bold" data-testid={`text-slide-heading-${i}`}>
                        {slide.heading}
                      </h3>
                      <p className="text-sm whitespace-pre-wrap">{slide.body}</p>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : campaignPosts ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-xl font-bold" data-testid="text-campaign-title">
                    {campaignTitle || "Campaign variants"}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    Each platform below gets its own tailored version. Generate an image and save each one to your library.
                  </p>
                  <AiSpentLine
                    paise={aiSpendPaise(
                      campaignPosts.length,
                      Object.values(campaignImages).filter(Boolean).length,
                    )}
                    testId="text-ai-spent-campaign"
                  />
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {campaignPosts.some((p) => !campaignImages[p.platform]) && (
                    <Button
                      type="button"
                      size="sm"
                      disabled={isPending || imagesExhausted}
                      title={imageLimitHint}
                      onClick={generateAllCampaignImages}
                      data-testid="button-generate-all-campaign-images"
                    >
                      {campaignBulkBusy ? (
                        <RippleSpinner className="mr-2 h-4 w-4" />
                      ) : (
                        <ImageIcon className="mr-2 h-4 w-4" />
                      )}
                      Generate all images
                    </Button>
                  )}
                  {flags.studioQuickPublish && flags.scheduling && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={isPending || scheduleWeekBusy}
                      onClick={scheduleTheWeek}
                      data-testid="button-schedule-week"
                    >
                      {scheduleWeekBusy ? (
                        <RippleSpinner className="mr-2 h-4 w-4" />
                      ) : (
                        <CalendarClock className="mr-2 h-4 w-4" />
                      )}
                      Schedule the week
                    </Button>
                  )}
                </div>
              </div>
              {campaignPosts.map((post) => (
                <CampaignPostCard
                  key={post.platform}
                  post={post}
                  brandKitId={selectedBrandKitId}
                  brief={currentPrompt}
                  image={campaignImages[post.platform] ?? null}
                  onImageGenerated={handleCampaignImageGenerated}
                  draftId={campaignDraftIds[post.platform]}
                  onSaved={handleCampaignPostSaved}
                />
              ))}
            </div>
          ) : (
            <Card className="border-border shadow-md flex-1 flex flex-col overflow-hidden">
              <CardHeader className="border-b bg-muted/30">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle>Results</CardTitle>
                    <CardDescription>
                      {hasSingleResult
                        ? "Auto-saved as a draft. Keep it or discard it."
                        : "Review and save your generated content."}
                    </CardDescription>
                  </div>
                  {hasSingleResult && (
                    <div className="flex items-center gap-2">
                      <Button
                        onClick={handleDiscard}
                        disabled={isPending}
                        size="sm"
                        variant="outline"
                        data-testid="button-discard-draft"
                      >
                        {deleteContent.isPending ? (
                          <RippleSpinner className="mr-2 h-4 w-4" />
                        ) : (
                          <Trash2 className="mr-2 h-4 w-4" />
                        )}
                        Discard
                      </Button>
                      <Button onClick={handleSave} disabled={isPending} size="sm" data-testid="button-save-draft">
                        {createContent.isPending || updateContent.isPending ? (
                          <RippleSpinner className="mr-2 h-4 w-4" />
                        ) : (
                          <Save className="mr-2 h-4 w-4" />
                        )}
                        Save to Library
                      </Button>
                    </div>
                  )}
                </div>
              </CardHeader>
              <CardContent className="p-0 flex-1 bg-muted/10">
                {(generateCaption.isPending || captionStreaming || generateImage.isPending || imageJobBusy || generateCampaign.isPending || generateCarousel.isPending) &&
                !hasSingleResult ? (
                  <div className="h-full min-h-[400px] flex flex-col items-center justify-center gap-4 p-8">
                    <LogoLoader
                      label={
                        generateCarousel.isPending
                          ? "Generating your carousel..."
                          : generateCampaign.isPending
                            ? "Generating your campaign..."
                            : imageJobBusy && imageJobState
                              ? imageJobState.status === "queued"
                                ? "Waiting in queue..."
                                : "Generating your image..."
                              : generateImage.isPending || imageJobBusy
                                ? "Generating your image..."
                                : "Generating your caption..."
                      }
                    />
                    {imageJobBusy && imageJobState && (
                      <div className="flex flex-col items-center gap-2" data-testid="image-job-progress">
                        <p className="text-sm text-muted-foreground" data-testid="text-image-job-status">
                          {imageJobState.status === "queued"
                            ? "Your image is queued and will start shortly."
                            : "Your image is being generated in the background."}
                          {" "}
                          <span data-testid="text-image-job-elapsed">
                            {imageJobElapsed >= 60
                              ? `${Math.floor(imageJobElapsed / 60)}m ${imageJobElapsed % 60}s elapsed`
                              : `${imageJobElapsed}s elapsed`}
                          </span>
                        </p>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={imageJobState.status !== "queued" || imageJobCancelling}
                          title={
                            imageJobState.status !== "queued"
                              ? "Generation already started and can no longer be cancelled."
                              : undefined
                          }
                          onClick={cancelRunningImageJob}
                          data-testid="button-cancel-image-job"
                        >
                          {imageJobCancelling ? (
                            <RippleSpinner className="mr-2 h-4 w-4" />
                          ) : (
                            <X className="mr-2 h-4 w-4" />
                          )}
                          Cancel
                        </Button>
                      </div>
                    )}
                  </div>
                ) : briefQuestions && briefQuestions.length > 0 && !hasSingleResult ? (
                  <div className="p-6 bg-card space-y-3" data-testid="card-brief-questions">
                    <h3 className="font-bold text-base">Your brief needs a bit more detail</h3>
                    <p className="text-sm text-muted-foreground">
                      To write something specific instead of generic filler, answer these in your prompt and generate again. Nothing was charged for this attempt.
                    </p>
                    <ul className="list-disc pl-5 space-y-1.5 text-sm">
                      {briefQuestions.map((q, i) => (
                        <li key={i} data-testid={`text-brief-question-${i}`}>{q}</li>
                      ))}
                    </ul>
                  </div>
                ) : !hasSingleResult ? (
                  <div className="h-full min-h-[400px] flex flex-col items-center justify-center text-muted-foreground p-8 text-center">
                    <Wand2 className="h-12 w-12 text-muted mb-4" />
                    <p>Your generated content will appear here.</p>
                  </div>
                ) : (
                  <div className="flex flex-col h-full divide-y">
                    {imageResult && (
                      <div className="p-6 bg-card space-y-5">
                        <div className="flex items-center justify-center">
                          <img
                            src={
                              imageResult.b64Json
                                ? `data:image/png;base64,${imageResult.b64Json}`
                                : `/api/storage${imageResult.imagePath}`
                            }
                            alt="Generated"
                            className="max-h-[400px] rounded-lg shadow-lg border border-border object-contain"
                          />
                        </div>
                        <PlatformFitPreview
                          src={
                            imageResult.b64Json
                              ? `data:image/png;base64,${imageResult.b64Json}`
                              : `/api/storage${imageResult.imagePath}`
                          }
                        />
                        <AiSpentLine paise={aiSpendPaise(0, 1)} testId="text-ai-spent-image" />
                        <div className="flex flex-wrap items-center gap-2">
                          {IMAGE_TWEAKS.map((t) => (
                            <Button
                              key={t.label}
                              type="button"
                              size="sm"
                              variant={imageTweak === t.label ? "default" : "outline"}
                              className="rounded-full"
                              disabled={isPending || imagesExhausted}
                              title={imageLimitHint}
                              onClick={form.handleSubmit((data) => runGenerateImage(data, t.label))}
                              data-testid={`button-image-tweak-${t.label.toLowerCase().replace(/\s+/g, "-")}`}
                            >
                              {t.label}
                            </Button>
                          ))}
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            disabled={isPending || imagesExhausted}
                            title={imageLimitHint}
                            onClick={form.handleSubmit((data) => runGenerateImage(data, null))}
                            data-testid="button-regenerate-image"
                          >
                            {generateImage.isPending || imageJobBusy ? (
                              <RippleSpinner className="mr-2 h-4 w-4" />
                            ) : (
                              <RefreshCw className="mr-2 h-4 w-4" />
                            )}
                            Regenerate
                          </Button>
                          <VoiceNoteButton
                            disabled={isPending || imagesExhausted}
                            onTranscript={(text) => {
                              toast({ title: "Applying your change", description: `"${text}"` });
                              form.handleSubmit((data) => runGenerateImage(data, text))();
                            }}
                          />
                        </div>
                        {imagesExhausted && (
                          <p className="text-xs text-destructive" data-testid="image-quota-hint-result">
                            {imageLimitHint}
                          </p>
                        )}
                      </div>
                    )}
                    {captionResult && (
                      <div className="p-6 bg-card flex-1">
                        {captionResult.title && (
                          <h3 className="font-bold text-base mb-2" data-testid="text-brief-title">
                            {captionResult.title}
                          </h3>
                        )}
                        <h4 className="font-medium text-sm text-muted-foreground mb-3 uppercase tracking-wider">
                          Caption
                        </h4>
                        <p className="whitespace-pre-wrap text-lg">{captionResult.caption}</p>
                        <div className="mt-2">
                          <AiSpentLine paise={aiSpendPaise(1, 0)} testId="text-ai-spent-caption" />
                        </div>
                        {captionPlatform === "twitter" && (() => {
                          const tweetText = (captionResult.caption ?? "").trim();
                          const overLimit = isOverTweetLimit(tweetText);
                          const overThreads = tweetText.length > THREADS_MAX_LENGTH;
                          const threadsChunks = overThreads ? chunkOnWhitespace(tweetText, THREADS_MAX_LENGTH) : [];
                          const overLinkedin = isOverLinkedinLimit(tweetText);
                          const liComments = overLinkedin ? splitForLinkedin(tweetText).comments.length : 0;
                          return (
                            <div className="mt-3 space-y-1">
                              <p className={`text-xs ${overLimit ? "text-destructive font-medium" : "text-muted-foreground"}`}>
                                {tweetText.length} / {TWEET_MAX_LENGTH} characters for X
                                {overLimit && ` \u2014 ${tweetOverBy(tweetText)} over; will post as a thread of ${splitIntoTweets(tweetText).length} tweets on X`}
                              </p>
                              <p className={`text-xs ${overThreads ? "text-destructive font-medium" : "text-muted-foreground"}`}>
                                {tweetText.length} / {THREADS_MAX_LENGTH} characters for Threads
                                {overThreads && ` \u2014 over; will post as a chain of ${threadsChunks.length} connected posts on Threads`}
                              </p>
                              <p className={`text-xs ${overLinkedin ? "text-destructive font-medium" : "text-muted-foreground"}`}>
                                {tweetText.length} / {LINKEDIN_MAX_LENGTH} characters for LinkedIn
                                {overLinkedin && ` \u2014 over; the rest will be posted as ${liComments} follow-up comment${liComments === 1 ? "" : "s"} on LinkedIn`}
                              </p>
                            </div>
                          );
                        })()}
                        {captionResult.hashtags.length > 0 && (
                          <div className="mt-6 flex flex-wrap gap-2">
                            {captionResult.hashtags.map((tag) => (
                              <span
                                key={tag}
                                className="text-sm font-medium text-primary bg-primary/10 px-2 py-1 rounded-md"
                              >
                                {tag.startsWith("#") ? tag : `#${tag}`}
                              </span>
                            ))}
                          </div>
                        )}
                        <div className="mt-6 flex flex-wrap items-center gap-2">
                          {CAPTION_TWEAKS.map((t) => (
                            <Button
                              key={t.label}
                              type="button"
                              size="sm"
                              variant={captionTweak === t.label ? "default" : "outline"}
                              className="rounded-full"
                              disabled={isPending}
                              onClick={form.handleSubmit((data) => runGenerateCaption(data, t.label))}
                              data-testid={`button-tweak-${t.label.toLowerCase().replace(/\s+/g, "-")}`}
                            >
                              {t.label}
                            </Button>
                          ))}
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            disabled={isPending}
                            onClick={form.handleSubmit((data) => runGenerateCaption(data, null))}
                            data-testid="button-regenerate-caption"
                          >
                            {generateCaption.isPending || captionStreaming ? (
                              <RippleSpinner className="mr-2 h-4 w-4" />
                            ) : (
                              <RefreshCw className="mr-2 h-4 w-4" />
                            )}
                            Regenerate
                          </Button>
                          <VoiceNoteButton
                            disabled={isPending}
                            onTranscript={(text) => {
                              toast({ title: "Applying your change", description: `"${text}"` });
                              form.handleSubmit((data) => runGenerateCaption(data, text))();
                            }}
                          />
                        </div>
                      </div>
                    )}
                    {flags.studioQuickPublish && flags.connectedAccounts && draftId && (
                      <div className="p-6 bg-card">
                        <QuickPublishPanel
                          contentItemId={draftId}
                          platformLive={platformLive}
                          defaultSelected={campaignPlatforms}
                          disabled={isPending}
                          caption={captionResult?.caption}
                          hasImage={!!imageResult?.imagePath}
                          onPublished={() => {
                            // The draft is now a published item: reset the
                            // studio so Discard can't delete a live post.
                            setDraft(null);
                            setCaptionResult(null);
                            setCaptionPlatform(null);
                            setImageResult(null);
                            setBriefQuestions(null);
                            clearStudioSession();
                          }}
                          onScheduled={() => {
                            // A schedule now references this item: keep it in
                            // the library and reset the studio.
                            setDraft(null);
                            setCaptionResult(null);
                            setCaptionPlatform(null);
                            setImageResult(null);
                            setBriefQuestions(null);
                            clearStudioSession();
                          }}
                        />
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <AlertDialog
        open={!!pendingCampaignImage}
        onOpenChange={(open) => {
          if (!open) applyPendingImage(false);
        }}
      >
        <AlertDialogContent className="sm:max-w-[440px]">
          <AlertDialogHeader>
            <AlertDialogTitle>Use this image for all platforms?</AlertDialogTitle>
            <AlertDialogDescription>
              Your campaign content is consistent across platforms. Using the same image everywhere keeps the campaign visually consistent. You can also keep it only for{" "}
              {pendingCampaignImage
                ? (CAMPAIGN_PLATFORMS.find((p) => p.value === pendingCampaignImage.platform)?.label ?? pendingCampaignImage.platform)
                : "this platform"}
              .
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pendingCampaignImage && (
            <img
              src={
                pendingCampaignImage.image.b64Json
                  ? `data:image/png;base64,${pendingCampaignImage.image.b64Json}`
                  : `/api/storage${pendingCampaignImage.image.imagePath}`
              }
              alt="New image"
              className="w-full max-h-[220px] rounded-md border object-contain bg-muted/30"
            />
          )}
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => applyPendingImage(false)} data-testid="button-image-this-platform">
              Only this platform
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => applyPendingImage(true)} data-testid="button-image-all-platforms">
              Use for all platforms
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
