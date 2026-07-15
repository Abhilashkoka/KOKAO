import { useState } from "react";
import {
  useGenerateImage,
  useCreateContent,
  getListContentQueryKey,
  type CampaignPost,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Image as ImageIcon, Save, Loader2, Check } from "lucide-react";
import { TWEET_MAX_LENGTH, isOverTweetLimit, tweetOverBy } from "@workspace/social-limits";

const PLATFORM_LABELS: Record<string, string> = {
  instagram: "Instagram",
  twitter: "Twitter / X",
  linkedin: "LinkedIn",
  facebook: "Facebook",
};

interface CampaignPostCardProps {
  post: CampaignPost;
  brandKitId?: number;
  brief: string;
}

export function CampaignPostCard({ post, brandKitId, brief }: CampaignPostCardProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const generateImage = useGenerateImage();
  const createContent = useCreateContent();

  const [image, setImage] = useState<{ imagePath: string; b64Json: string } | null>(null);
  const [saved, setSaved] = useState(false);

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

  const onGenerateImage = () => {
    generateImage.mutate(
      { data: { prompt: post.imagePrompt || post.caption, brandKitId: brandKitId || undefined } },
      {
        onSuccess: (res) => {
          setImage(res);
          toast({ title: `Image generated for ${PLATFORM_LABELS[post.platform] ?? post.platform}` });
        },
        onError: handleError,
      },
    );
  };

  const onSave = () => {
    createContent.mutate(
      {
        data: {
          title: `${PLATFORM_LABELS[post.platform] ?? post.platform}: ${brief.slice(0, 40)}`,
          caption: post.caption || undefined,
          imagePath: image?.imagePath || undefined,
          imagePrompt: post.imagePrompt || undefined,
          platform: post.platform,
          status: "draft",
          brandKitId: brandKitId || undefined,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
          setSaved(true);
          toast({ title: "Saved to library!" });
        },
        onError: handleError,
      },
    );
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
              onClick={onGenerateImage}
              disabled={generateImage.isPending}
            >
              {generateImage.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <ImageIcon className="mr-2 h-4 w-4" />
              )}
              {image ? "Regenerate" : "Image"}
            </Button>
            <Button type="button" size="sm" onClick={onSave} disabled={createContent.isPending || saved}>
              {createContent.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
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
        {image && (
          <img
            src={`data:image/png;base64,${image.b64Json}`}
            alt={`Generated for ${post.platform}`}
            className="max-h-[280px] w-full rounded-lg border border-border object-contain bg-muted/30"
          />
        )}
        <p className="whitespace-pre-wrap text-sm">{post.caption}</p>
        {post.platform === "twitter" && (() => {
          const tweetText = (post.caption ?? "").trim();
          const overLimit = isOverTweetLimit(tweetText);
          return (
            <p className={`text-xs ${overLimit ? "text-destructive font-medium" : "text-muted-foreground"}`}>
              {tweetText.length} / {TWEET_MAX_LENGTH} characters for X
              {overLimit && ` \u2014 ${tweetOverBy(tweetText)} over; will post as a thread on X (other platforms allow more)`}
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
    </Card>
  );
}
