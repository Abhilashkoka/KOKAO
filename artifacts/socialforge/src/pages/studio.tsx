import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
  useGenerateCaption,
  useGenerateImage,
  useGenerateCampaign,
  useSuggestTopics,
  useSummarizeUrl,
  useResearchTopic,
  useCreateContent,
  useUpdateContent,
  useDeleteContent,
  useListBrandKits,
  useGetMe,
  getListContentQueryKey,
  getGetMeQueryKey,
  type BrandKit,
  type CampaignPost,
  type ResearchResult,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useToast } from "@/hooks/use-toast";
import { Wand2, Image as ImageIcon, Save, Loader2, Lightbulb, Link2, Layers, Globe, ExternalLink, RefreshCw, Trash2, Infinity as InfinityIcon } from "lucide-react";
import { navigate } from "wouter/use-browser-location";
import { CampaignPostCard, type GeneratedImage } from "@/components/campaign-post-card";
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
  platform: z.string().optional(),
  brandKitId: z.coerce.number().optional().or(z.literal(0)),
  tone: z.string().optional(),
  size: z.enum(["1024x1024", "1536x1024", "1024x1536"]).optional(),
});

const CAPTION_TWEAKS = [
  { label: "Shorter", instruction: "Make the caption shorter and more concise." },
  { label: "Punchier", instruction: "Make the caption punchier and more attention-grabbing." },
  { label: "More formal", instruction: "Make the caption more formal and professional." },
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

export function StudioPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [captionResult, setCaptionResult] = useState<{ caption: string; hashtags: string[] } | null>(null);
  const [captionPlatform, setCaptionPlatform] = useState<string | null>(null);
  const [captionTweak, setCaptionTweak] = useState<string | null>(null);
  const [imageResult, setImageResult] = useState<{ imagePath: string; b64Json: string } | null>(null);
  const [campaignPosts, setCampaignPosts] = useState<CampaignPost[] | null>(null);
  const [campaignImages, setCampaignImages] = useState<Record<string, GeneratedImage>>({});
  const [pendingCampaignImage, setPendingCampaignImage] = useState<{ platform: string; image: GeneratedImage } | null>(null);

  const [niche, setNiche] = useState("");
  const [topicIdeas, setTopicIdeas] = useState<string[]>([]);
  const [articleUrl, setArticleUrl] = useState("");
  const [researchQuery, setResearchQuery] = useState("");
  const [researchResult, setResearchResult] = useState<ResearchResult | null>(null);
  const [campaignPlatforms, setCampaignPlatforms] = useState<string[]>([
    "instagram",
    "facebook",
    "linkedin",
    "twitter",
  ]);

  const { data: brandKits } = useListBrandKits();

  const generateCaption = useGenerateCaption();
  const generateImage = useGenerateImage();
  const generateCampaign = useGenerateCampaign();
  const suggestTopics = useSuggestTopics();
  const summarizeUrl = useSummarizeUrl();
  const researchTopic = useResearchTopic();
  const createContent = useCreateContent();
  const updateContent = useUpdateContent();
  const deleteContent = useDeleteContent();
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
    caption: { caption: string } | null,
    image: { imagePath: string } | null,
  ) => {
    const values = form.getValues();
    return {
      title: values.prompt.trim().slice(0, 30) + (values.prompt.trim().length > 30 ? "..." : ""),
      caption: caption?.caption || undefined,
      imagePath: image?.imagePath || undefined,
      imagePrompt: image ? values.prompt : undefined,
      platform: values.platform,
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

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: {
      prompt: "",
      platform: "instagram",
      tone: "professional",
      size: "1024x1024",
    },
  });

  const handleError = (error: any) => {
    if (error?.status === 402 || error?.response?.status === 402) {
      toast({
        title: "Quota Reached",
        description: error?.message || "You've reached your monthly AI limit. Please upgrade your plan.",
        variant: "destructive",
      });
    } else {
      toast({ title: "Error", description: error?.message || "Failed to generate content.", variant: "destructive" });
    }
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
      ? ` ${CAPTION_TWEAKS.find((t) => t.label === tweak)?.instruction ?? ""}`
      : "";
    generateCaption.mutate(
      {
        data: {
          prompt: `${data.prompt.trim()}${tweakInstruction}`,
          platform: data.platform,
          brandKitId: data.brandKitId || undefined,
          tone: data.tone,
        },
      },
      {
        onSuccess: (res) => {
          setCampaignPosts(null);
          setCaptionResult(res);
          setCaptionPlatform(data.platform ?? null);
          refreshQuota();
          upsertDraft(res, imageResult);
          toast({ title: "Caption generated!", description: "Auto-saved to your library as a draft." });
        },
        onError: handleError,
      },
    );
  };

  const onGenerateCaption = (data: z.infer<typeof schema>) => runGenerateCaption(data, null);

  const onGenerateImage = (data: z.infer<typeof schema>) => {
    generateImage.mutate(
      { data: { prompt: data.prompt, size: data.size as any, brandKitId: data.brandKitId || undefined } },
      {
        onSuccess: (res) => {
          setCampaignPosts(null);
          setImageResult(res);
          refreshQuota();
          upsertDraft(captionResult, res);
          toast({ title: "Image generated!", description: "Auto-saved to your library as a draft." });
        },
        onError: handleError,
      },
    );
  };

  const onGenerateCampaign = (data: z.infer<typeof schema>) => {
    if (campaignPlatforms.length === 0) {
      toast({ title: "Select platforms", description: "Pick at least one platform.", variant: "destructive" });
      return;
    }
    generateCampaign.mutate(
      {
        data: {
          prompt: data.prompt,
          platforms: campaignPlatforms,
          brandKitId: data.brandKitId || undefined,
          tone: data.tone,
        },
      },
      {
        onSuccess: (res) => {
          setCaptionResult(null);
          setCaptionPlatform(null);
          setImageResult(null);
          setCampaignImages({});
          setPendingCampaignImage(null);
          setCampaignPosts(res.posts);
          setDraft(null);
          refreshQuota();
          toast({ title: "Campaign generated!", description: `${res.posts.length} platform variants ready.` });
        },
        onError: handleError,
      },
    );
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

  const handleSave = () => {
    if (!captionResult?.caption && !imageResult?.imagePath) {
      toast({ title: "Nothing to save", variant: "destructive" });
      return;
    }

    const data = buildDraftData(captionResult, imageResult);
    const onSaved = () => {
      queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
      setDraft(null);
      toast({ title: "Saved to library!" });
      navigate("/library");
    };
    const onSaveError = (err: unknown) => {
      toast({ title: "Failed to save", description: (err as any).message, variant: "destructive" });
    };

    if (draftId) {
      updateContent.mutate(
        { id: draftId, data },
        { onSuccess: onSaved, onError: onSaveError },
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
    generateImage.isPending ||
    generateCampaign.isPending ||
    researchTopic.isPending ||
    createContent.isPending ||
    updateContent.isPending ||
    deleteContent.isPending;

  const captionsLeft =
    me && me.limits.captions !== -1 ? Math.max(0, me.limits.captions - me.usage.captions) : null;
  const imagesLeft =
    me && me.limits.images !== -1 ? Math.max(0, me.limits.images - me.usage.images) : null;

  const selectedBrandKitId = form.watch("brandKitId") || undefined;
  const selectedBrandKit = selectedBrandKitId
    ? brandKits?.find((bk) => bk.id === selectedBrandKitId)
    : undefined;
  const selectedSwatches = selectedBrandKit ? kitSwatches(selectedBrandKit, 6) : [];
  const currentPrompt = form.watch("prompt");
  const hasSingleResult = captionResult || imageResult;

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-6xl mx-auto">
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
                captionsLeft === 0 ? "bg-destructive/10 text-destructive" : "bg-primary/10 text-primary"
              }`}
              data-testid="quota-captions"
            >
              <Wand2 className="h-3.5 w-3.5" />
              {captionsLeft === null ? (
                <>
                  <InfinityIcon className="h-3.5 w-3.5" /> captions
                </>
              ) : (
                `${captionsLeft} caption${captionsLeft === 1 ? "" : "s"} left`
              )}
            </span>
            <span
              className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium ${
                imagesLeft === 0 ? "bg-destructive/10 text-destructive" : "bg-primary/10 text-primary"
              }`}
              data-testid="quota-images"
            >
              <ImageIcon className="h-3.5 w-3.5" />
              {imagesLeft === null ? (
                <>
                  <InfinityIcon className="h-3.5 w-3.5" /> images
                </>
              ) : (
                `${imagesLeft} image${imagesLeft === 1 ? "" : "s"} left`
              )}
            </span>
            <span
              className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground"
              data-testid="quota-helpers"
            >
              <Lightbulb className="h-3.5 w-3.5" />
              Ideas, research &amp; briefs: unlimited
            </span>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        <div className="lg:col-span-5 space-y-6">
          <Card className="border-border shadow-md">
            <CardHeader>
              <CardTitle>Start with an idea</CardTitle>
              <CardDescription>Brainstorm topics or pull a brief from an article.</CardDescription>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue="ideas">
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
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Lightbulb className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
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
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Globe className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
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
                        <Loader2 className="h-4 w-4 animate-spin" />
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
                        <FormLabel>Prompt</FormLabel>
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

                  <div className="grid grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="platform"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Platform</FormLabel>
                          <Select onValueChange={field.onChange} defaultValue={field.value}>
                            <FormControl>
                              <SelectTrigger>
                                <SelectValue placeholder="Platform" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="instagram">Instagram</SelectItem>
                              <SelectItem value="twitter">Twitter / X</SelectItem>
                              <SelectItem value="linkedin">LinkedIn</SelectItem>
                              <SelectItem value="facebook">Facebook</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
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
                  </div>

                  <div className="grid grid-cols-2 gap-4">
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
                    <FormField
                      control={form.control}
                      name="size"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Image Size</FormLabel>
                          <Select onValueChange={field.onChange} defaultValue={field.value}>
                            <FormControl>
                              <SelectTrigger>
                                <SelectValue placeholder="Size" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="1024x1024">Square (1:1)</SelectItem>
                              <SelectItem value="1536x1024">Landscape (3:2)</SelectItem>
                              <SelectItem value="1024x1536">Portrait (2:3)</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  <div className="rounded-lg border border-border p-3 space-y-2">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <Layers className="h-4 w-4" /> Campaign platforms
                    </div>
                    <p className="text-xs text-muted-foreground">
                      For multi-platform generation, choose which platforms to tailor for.
                    </p>
                    <ToggleGroup
                      type="multiple"
                      variant="outline"
                      value={campaignPlatforms}
                      onValueChange={(val) => setCampaignPlatforms(val)}
                      className="flex flex-wrap justify-start gap-2"
                    >
                      {CAMPAIGN_PLATFORMS.map((p) => (
                        <ToggleGroupItem key={p.value} value={p.value} className="text-xs px-3">
                          {p.label}
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
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
                      disabled={isPending}
                      className="w-full"
                    >
                      {generateCampaign.isPending ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Layers className="mr-2 h-4 w-4" />
                      )}
                      Generate Campaign ({campaignPlatforms.length})
                    </Button>
                    <div className="grid grid-cols-2 gap-3">
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={form.handleSubmit(onGenerateCaption)}
                        disabled={isPending}
                      >
                        {generateCaption.isPending ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <Wand2 className="mr-2 h-4 w-4" />
                        )}
                        Caption
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={form.handleSubmit(onGenerateImage)}
                        disabled={isPending}
                      >
                        {generateImage.isPending ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <ImageIcon className="mr-2 h-4 w-4" />
                        )}
                        Image
                      </Button>
                    </div>
                  </div>
                </form>
              </Form>
            </CardContent>
          </Card>
        </div>

        <div className="lg:col-span-7 flex flex-col gap-6">
          {campaignPosts ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-xl font-bold">Campaign variants</h2>
                  <p className="text-sm text-muted-foreground">
                    Generate an image and save each platform variant to your library.
                  </p>
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
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="mr-2 h-4 w-4" />
                        )}
                        Discard
                      </Button>
                      <Button onClick={handleSave} disabled={isPending} size="sm" data-testid="button-save-draft">
                        {createContent.isPending || updateContent.isPending ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
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
                {!hasSingleResult ? (
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
                            src={`data:image/png;base64,${imageResult.b64Json}`}
                            alt="Generated"
                            className="max-h-[400px] rounded-lg shadow-lg border border-border object-contain"
                          />
                        </div>
                        <PlatformFitPreview src={`data:image/png;base64,${imageResult.b64Json}`} />
                      </div>
                    )}
                    {captionResult && (
                      <div className="p-6 bg-card flex-1">
                        <h4 className="font-medium text-sm text-muted-foreground mb-3 uppercase tracking-wider">
                          Caption
                        </h4>
                        <p className="whitespace-pre-wrap text-lg">{captionResult.caption}</p>
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
                            {generateCaption.isPending ? (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                              <RefreshCw className="mr-2 h-4 w-4" />
                            )}
                            Regenerate
                          </Button>
                        </div>
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
              src={`data:image/png;base64,${pendingCampaignImage.image.b64Json}`}
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
