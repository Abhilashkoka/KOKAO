import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
  useGenerateCaption,
  useGenerateImage,
  useGenerateCampaign,
  useSuggestTopics,
  useSummarizeUrl,
  useCreateContent,
  useListBrandKits,
  getListContentQueryKey,
  type CampaignPost,
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
import { Wand2, Image as ImageIcon, Save, Loader2, Lightbulb, Link2, Layers } from "lucide-react";
import { navigate } from "wouter/use-browser-location";
import { CampaignPostCard } from "@/components/campaign-post-card";
import { TWEET_MAX_LENGTH, isOverTweetLimit, tweetOverBy } from "@workspace/social-limits";

const schema = z.object({
  prompt: z.string().min(3, "Prompt must be at least 3 characters"),
  platform: z.string().optional(),
  brandKitId: z.coerce.number().optional().or(z.literal(0)),
  tone: z.string().optional(),
  size: z.enum(["1024x1024", "1536x1024", "1024x1536"]).optional(),
});

const CAMPAIGN_PLATFORMS = [
  { value: "instagram", label: "Instagram" },
  { value: "facebook", label: "Facebook" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "twitter", label: "Twitter / X" },
];

export function StudioPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [captionResult, setCaptionResult] = useState<{ caption: string; hashtags: string[] } | null>(null);
  const [imageResult, setImageResult] = useState<{ imagePath: string; b64Json: string } | null>(null);
  const [campaignPosts, setCampaignPosts] = useState<CampaignPost[] | null>(null);

  const [niche, setNiche] = useState("");
  const [topicIdeas, setTopicIdeas] = useState<string[]>([]);
  const [articleUrl, setArticleUrl] = useState("");
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
  const createContent = useCreateContent();

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

  const onGenerateCaption = (data: z.infer<typeof schema>) => {
    generateCaption.mutate(
      { data: { prompt: data.prompt, platform: data.platform, brandKitId: data.brandKitId || undefined, tone: data.tone } },
      {
        onSuccess: (res) => {
          setCampaignPosts(null);
          setCaptionResult(res);
          toast({ title: "Caption generated!" });
        },
        onError: handleError,
      },
    );
  };

  const onGenerateImage = (data: z.infer<typeof schema>) => {
    generateImage.mutate(
      { data: { prompt: data.prompt, size: data.size as any, brandKitId: data.brandKitId || undefined } },
      {
        onSuccess: (res) => {
          setCampaignPosts(null);
          setImageResult(res);
          toast({ title: "Image generated!" });
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
          setImageResult(null);
          setCampaignPosts(res.posts);
          toast({ title: "Campaign generated!", description: `${res.posts.length} platform variants ready.` });
        },
        onError: handleError,
      },
    );
  };

  const handleSave = () => {
    if (!captionResult?.caption && !imageResult?.imagePath) {
      toast({ title: "Nothing to save", variant: "destructive" });
      return;
    }

    const values = form.getValues();
    createContent.mutate(
      {
        data: {
          title: values.prompt.slice(0, 30) + "...",
          caption: captionResult?.caption || undefined,
          imagePath: imageResult?.imagePath || undefined,
          imagePrompt: imageResult ? values.prompt : undefined,
          platform: values.platform,
          status: "draft",
          brandKitId: values.brandKitId || undefined,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
          toast({ title: "Saved to library!" });
          navigate("/library");
        },
        onError: (err) => {
          toast({ title: "Failed to save", description: (err as any).message, variant: "destructive" });
        },
      },
    );
  };

  const isPending =
    generateCaption.isPending ||
    generateImage.isPending ||
    generateCampaign.isPending ||
    createContent.isPending;

  const selectedBrandKitId = form.watch("brandKitId") || undefined;
  const currentPrompt = form.watch("prompt");
  const hasSingleResult = captionResult || imageResult;

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-6xl mx-auto">
      <div>
        <h1 className="text-3xl font-extrabold tracking-tight">AI Content Studio</h1>
        <p className="text-muted-foreground text-lg mt-1">
          Brainstorm, research, and generate on-brand content across every platform.
        </p>
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
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="ideas">
                    <Lightbulb className="mr-2 h-4 w-4" /> Topic ideas
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
                                  {bk.name}
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
                />
              ))}
            </div>
          ) : (
            <Card className="border-border shadow-md flex-1 flex flex-col overflow-hidden">
              <CardHeader className="border-b bg-muted/30">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle>Results</CardTitle>
                    <CardDescription>Review and save your generated content.</CardDescription>
                  </div>
                  {hasSingleResult && (
                    <Button onClick={handleSave} disabled={isPending} size="sm">
                      {createContent.isPending ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Save className="mr-2 h-4 w-4" />
                      )}
                      Save to Library
                    </Button>
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
                      <div className="p-6 flex items-center justify-center bg-card">
                        <img
                          src={`data:image/png;base64,${imageResult.b64Json}`}
                          alt="Generated"
                          className="max-h-[400px] rounded-lg shadow-lg border border-border object-contain"
                        />
                      </div>
                    )}
                    {captionResult && (
                      <div className="p-6 bg-card flex-1">
                        <h4 className="font-medium text-sm text-muted-foreground mb-3 uppercase tracking-wider">
                          Caption
                        </h4>
                        <p className="whitespace-pre-wrap text-lg">{captionResult.caption}</p>
                        {(() => {
                          const tweetText = (captionResult.caption ?? "").trim();
                          const overLimit = isOverTweetLimit(tweetText);
                          return (
                            <p className={`mt-3 text-xs ${overLimit ? "text-destructive font-medium" : "text-muted-foreground"}`}>
                              {tweetText.length} / {TWEET_MAX_LENGTH} characters for X
                              {overLimit && ` \u2014 ${tweetOverBy(tweetText)} over; will be trimmed when posting to X (other platforms allow more)`}
                            </p>
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
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
