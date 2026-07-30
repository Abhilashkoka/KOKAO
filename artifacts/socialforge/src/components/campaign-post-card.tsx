import { useState } from "react";
import { RippleSpinner } from "@/components/ui/ripple-spinner";
import {
  useGenerateImage,
  useCreateContent,
  useUpdateContent,
  useGetMe,
  getListContentQueryKey,
  getGetMeQueryKey,
  type CampaignPost,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Image as ImageIcon, Save, Check, Pencil } from "lucide-react";
import { LogoLoader } from "@/components/logo-loader";
import { ImageEditorDialog } from "@/components/image-editor";
import { IMAGE_TWEAKS } from "@workspace/studio-presets";
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

const PLATFORM_LABELS: Record<string, string> = {
  instagram: "Instagram",
  twitter: "Twitter / X",
  linkedin: "LinkedIn",
  facebook: "Facebook",
};

const PLATFORM_RATIOS: Record<string, { ratio: string; note: string }> = {
  instagram: { ratio: "1 / 1", note: "square 1:1" },
  facebook: { ratio: "1.91 / 1", note: "landscape 1.91:1" },
  linkedin: { ratio: "1.91 / 1", note: "landscape 1.91:1" },
  twitter: { ratio: "16 / 9", note: "landscape 16:9" },
  threads: { ratio: "1 / 1", note: "square 1:1" },
};

export interface GeneratedImage {
  imagePath: string;
  /** Base64 preview from a fresh generation; null when restored from a saved session (render from imagePath instead). */
  b64Json: string | null;
}

interface CampaignPostCardProps {
  post: CampaignPost;
  brandKitId?: number;
  brief: string;
  image?: GeneratedImage | null;
  onImageGenerated?: (platform: string, image: GeneratedImage) => void;
  /** Layer doc of the current image (controlled alongside `image`); lets the editor resume text/logo layers. */
  imageLayers?: Record<string, unknown> | null;
  /** Notifies the parent when the image was edited in the layer editor (replaces the image and its layer doc). */
  onImageEdited?: (platform: string, image: GeneratedImage, layers: Record<string, unknown>) => void;
  /** Id of the silently auto-saved draft for this post; Save updates it in place. */
  draftId?: number;
  /** Notifies the parent after a successful save so it can track progress. */
  onSaved?: (platform: string) => void;
}

export function CampaignPostCard({ post, brandKitId, brief, image: controlledImage, onImageGenerated, imageLayers: controlledLayers, onImageEdited, draftId, onSaved: onSavedProp }: CampaignPostCardProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const generateImage = useGenerateImage();
  const createContent = useCreateContent();
  const updateContent = useUpdateContent();
  const { data: me } = useGetMe();

  const imagesLeft =
    me && me.limits.images !== -1 ? Math.max(0, me.limits.images - me.usage.images) : null;
  const imageCredits = me?.credits?.imageCredits ?? 0;
  const imagesExhausted = imagesLeft === 0 && imageCredits === 0;
  const imageLimitHint = imagesExhausted
    ? "Monthly image limit reached. Upgrade your plan or buy credits to keep generating images."
    : undefined;

  const [localImage, setLocalImage] = useState<GeneratedImage | null>(null);
  const image = controlledImage !== undefined ? controlledImage : localImage;
  const [localLayers, setLocalLayers] = useState<Record<string, unknown> | null>(null);
  const imageLayers = controlledImage !== undefined ? (controlledLayers ?? null) : localLayers;
  const [editorOpen, setEditorOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [imageTweak, setImageTweak] = useState<string | null>(null);

  const handleError = (error: any) => {
    if (error?.status === 402 || error?.response?.status === 402) {
      toast({
        title: "Quota Reached",
        description: "You've reached your monthly AI limit. Please upgrade your plan.",
        variant: "destructive",
      });
    } else {
      toast({ title: "Error", description: error?.message || "Something went wrong.", variant: "destructive" });
    }
  };

  const runGenerateImage = (tweak: string | null) => {
    setImageTweak(tweak);
    const tweakInstruction = tweak
      ? ` ${IMAGE_TWEAKS.find((t) => t.label === tweak)?.instruction ?? ""}`
      : "";
    const basePrompt = (post.imagePrompt || post.caption).trim();
    generateImage.mutate(
      { data: { prompt: `${basePrompt}${tweakInstruction}`, brandKitId: brandKitId || undefined } },
      {
        onSuccess: (res) => {
          queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
          if (onImageGenerated) {
            onImageGenerated(post.platform, res);
          } else {
            setLocalImage(res);
            // A fresh generation replaces any edited image, so its layer doc
            // no longer applies.
            setLocalLayers(null);
          }
          toast({ title: `Image generated for ${PLATFORM_LABELS[post.platform] ?? post.platform}` });
        },
        onError: handleError,
      },
    );
  };

  const onSave = () => {
    const data = {
      title: `${PLATFORM_LABELS[post.platform] ?? post.platform}: ${brief.slice(0, 40)}`,
      caption: post.caption || undefined,
      imagePath: image?.imagePath || undefined,
      imagePrompt: post.imagePrompt || undefined,
      imageLayers: image ? (imageLayers ?? null) : null,
      platform: post.platform,
      status: "draft" as const,
      brandKitId: brandKitId || undefined,
    };
    const onSaved = () => {
      queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
      setSaved(true);
      toast({ title: "Saved to library!" });
      onSavedProp?.(post.platform);
    };
    if (draftId) {
      // The post was already auto-saved as a draft: update it in place so
      // Save never duplicates the library item.
      updateContent.mutate(
        { id: draftId, data },
        {
          onSuccess: onSaved,
          onError: (err: any) => {
            const status = err?.status ?? err?.response?.status;
            if (status === 404) {
              // Draft deleted elsewhere: fall back to creating a fresh item.
              createContent.mutate({ data }, { onSuccess: onSaved, onError: handleError });
              return;
            }
            handleError(err);
          },
        },
      );
      return;
    }
    createContent.mutate({ data }, { onSuccess: onSaved, onError: handleError });
  };

  return (
    <Card className="border-border shadow-sm">
      <CardHeader className="py-3 border-b bg-muted/30">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">{PLATFORM_LABELS[post.platform] ?? post.platform}</CardTitle>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => runGenerateImage(null)}
              disabled={generateImage.isPending || imagesExhausted}
              title={imageLimitHint}
              data-testid={`button-campaign-image-${post.platform}`}
            >
              {generateImage.isPending ? (
                <RippleSpinner className="mr-2 h-4 w-4" />
              ) : (
                <ImageIcon className="mr-2 h-4 w-4" />
              )}
              {image ? "Regenerate" : "Image"}
            </Button>
            <Button type="button" size="sm" onClick={onSave} disabled={createContent.isPending || updateContent.isPending || saved}>
              {createContent.isPending || updateContent.isPending ? (
                <RippleSpinner className="mr-2 h-4 w-4" />
              ) : saved ? (
                <Check className="mr-2 h-4 w-4" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              {saved ? "Saved" : "Save"}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-4 space-y-4">
        {imagesExhausted && (
          <p className="text-xs text-destructive" data-testid={`image-quota-hint-${post.platform}`}>
            {imageLimitHint}
          </p>
        )}
        {generateImage.isPending && (
          <div
            className="w-full max-w-[420px] rounded-lg border border-border bg-muted/30 flex items-center justify-center py-10"
            data-testid={`campaign-image-loading-${post.platform}`}
          >
            <LogoLoader size={56} label="Generating image..." />
          </div>
        )}
        {image && !generateImage.isPending && (
          <div className="space-y-1">
            <div
              className="w-full max-w-[420px] overflow-hidden rounded-lg border border-border bg-muted/30"
              style={{ aspectRatio: PLATFORM_RATIOS[post.platform]?.ratio ?? "1 / 1" }}
            >
              <img
                src={
                  image.b64Json
                    ? `data:image/png;base64,${image.b64Json}`
                    : `/api/storage${image.imagePath}`
                }
                alt={`Generated for ${post.platform}`}
                className="h-full w-full object-cover"
              />
            </div>
            <p className="text-[11px] text-muted-foreground">
              Shown cropped to {PLATFORM_LABELS[post.platform] ?? post.platform}'s recommended shape ({PLATFORM_RATIOS[post.platform]?.note ?? "1:1"}).
            </p>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="rounded-full"
                disabled={generateImage.isPending}
                onClick={() => setEditorOpen(true)}
                data-testid={`button-campaign-edit-image-${post.platform}`}
              >
                <Pencil className="mr-1.5 h-3.5 w-3.5" />
                Edit image
              </Button>
              {IMAGE_TWEAKS.map((t) => (
                <Button
                  key={t.label}
                  type="button"
                  size="sm"
                  variant={imageTweak === t.label ? "default" : "outline"}
                  className="rounded-full"
                  disabled={generateImage.isPending || imagesExhausted}
                  title={imageLimitHint}
                  onClick={() => runGenerateImage(t.label)}
                  data-testid={`button-campaign-image-tweak-${post.platform}-${t.label.toLowerCase().replace(/\s+/g, "-")}`}
                >
                  {t.label}
                </Button>
              ))}
            </div>
          </div>
        )}
        <p className="whitespace-pre-wrap text-sm">{post.caption}</p>
        {post.platform === "twitter" && (() => {
          const tweetText = (post.caption ?? "").trim();
          const overLimit = isOverTweetLimit(tweetText);
          return (
            <p className={`text-xs ${overLimit ? "text-destructive font-medium" : "text-muted-foreground"}`}>
              {tweetText.length} / {TWEET_MAX_LENGTH} characters for X
              {overLimit && ` \u2014 ${tweetOverBy(tweetText)} over; will post as a thread of ${splitIntoTweets(tweetText).length} tweets on X (other platforms allow more)`}
            </p>
          );
        })()}
        {post.platform === "threads" && (() => {
          const thText = (post.caption ?? "").trim();
          const overLimit = thText.length > THREADS_MAX_LENGTH;
          const chunks = overLimit ? chunkOnWhitespace(thText, THREADS_MAX_LENGTH) : [];
          return (
            <p className={`text-xs ${overLimit ? "text-destructive font-medium" : "text-muted-foreground"}`}>
              {thText.length} / {THREADS_MAX_LENGTH} characters for Threads
              {overLimit && ` \u2014 over; will post as a chain of ${chunks.length} connected posts on Threads`}
            </p>
          );
        })()}
        {post.platform === "linkedin" && (() => {
          const liText = (post.caption ?? "").trim();
          const overLimit = isOverLinkedinLimit(liText);
          const commentCount = overLimit ? splitForLinkedin(liText).comments.length : 0;
          return (
            <p className={`text-xs ${overLimit ? "text-destructive font-medium" : "text-muted-foreground"}`}>
              {liText.length} / {LINKEDIN_MAX_LENGTH} characters for LinkedIn
              {overLimit && ` \u2014 over; the rest will be posted as ${commentCount} follow-up comment${commentCount === 1 ? "" : "s"} on LinkedIn`}
            </p>
          );
        })()}
        {post.hashtags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {post.hashtags.map((tag) => (
              <span key={tag} className="text-xs font-medium text-primary bg-primary/10 px-2 py-0.5 rounded-md">
                {tag.startsWith("#") ? tag : `#${tag}`}
              </span>
            ))}
          </div>
        )}
        {post.imagePrompt && (
          <div className="border-t pt-3">
            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Image prompt</p>
            <p className="text-xs text-muted-foreground italic">{post.imagePrompt}</p>
          </div>
        )}
      </CardContent>
      {image && (
        <ImageEditorDialog
          open={editorOpen}
          onOpenChange={setEditorOpen}
          imagePath={image.imagePath}
          imageB64={image.b64Json}
          initialLayers={imageLayers}
          onSave={(result) => {
            const nextImage: GeneratedImage = { imagePath: result.imagePath, b64Json: result.b64 };
            const nextLayers = result.layers as unknown as Record<string, unknown>;
            if (onImageEdited) {
              onImageEdited(post.platform, nextImage, nextLayers);
            } else {
              setLocalImage(nextImage);
              setLocalLayers(nextLayers);
            }
            setSaved(false);
            toast({ title: "Image updated", description: "Your edits will be saved with this post." });
          }}
        />
      )}
    </Card>
  );
}
