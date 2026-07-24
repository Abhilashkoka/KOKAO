import { useEffect, useState } from "react";
import {
  useUpdateContent,
  useGetFacebookCredentials,
  useGetInstagramCredentials,
  useGetLinkedinStatus,
  useGetTwitterStatus,
  useGetThreadsStatus,
  getListContentQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Send } from "lucide-react";
import { QuickPublishPanel } from "@/components/studio-quick-publish";
import { apiErrorMessage } from "@/lib/apiErrorMessage";

/**
 * The composer: one sheet that takes a library item to published (or
 * scheduled) on every selected platform without page hops or per-platform
 * dialogs. The publish/schedule mechanics are the SAME QuickPublishPanel the
 * Studio uses — one publisher, no drift — wrapped here with a media preview
 * and inline caption editing (persisted before the first platform posts, so
 * every platform posts the same text).
 */

export interface ComposerItem {
  id: number;
  title: string;
  caption: string;
  imagePath: string | null;
  videoPath?: string | null;
  videoThumbnailPath?: string | null;
  /** The item's primary platform; preselected when nothing is remembered. */
  platform?: string;
}

export function ComposerSheet({
  open,
  onOpenChange,
  item,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: ComposerItem | null;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const updateContent = useUpdateContent();

  const { data: fbStatus } = useGetFacebookCredentials();
  const { data: igStatus } = useGetInstagramCredentials();
  const { data: liStatus } = useGetLinkedinStatus();
  const { data: twStatus } = useGetTwitterStatus();
  const { data: thStatus } = useGetThreadsStatus();

  const [caption, setCaption] = useState("");
  useEffect(() => {
    if (open && item) setCaption(item.caption);
    // Intentionally only when the sheet (re)opens for an item.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item?.id]);

  // Same readiness rules the Studio applies.
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

  /** Persist caption edits before anything posts; abort the action on failure. */
  const saveCaptionFirst = async (): Promise<boolean> => {
    if (!item || caption === item.caption) return true;
    try {
      await updateContent.mutateAsync({ id: item.id, data: { caption } });
      queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
      return true;
    } catch (err) {
      toast({
        title: "Could not save the caption",
        description: apiErrorMessage(err, "Please try again."),
        variant: "destructive",
      });
      return false;
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto flex flex-col gap-5">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Send className="h-4 w-4 text-primary" /> Publish
          </SheetTitle>
          <SheetDescription>
            {item?.title ? `“${item.title}”` : "Pick platforms, post now or schedule."}
          </SheetDescription>
        </SheetHeader>

        {item && (
          <>
            {(item.imagePath || item.videoPath) && (
              <div className="rounded-lg overflow-hidden border border-border bg-muted max-h-52 flex items-center justify-center">
                {item.videoPath ? (
                  <video
                    src={`/api/storage${item.videoPath}`}
                    poster={
                      item.videoThumbnailPath
                        ? `/api/storage${item.videoThumbnailPath}`
                        : undefined
                    }
                    controls
                    playsInline
                    preload="metadata"
                    className="max-h-52 w-full object-contain bg-black"
                    data-testid="composer-video-preview"
                  />
                ) : (
                  <img
                    src={`/api/storage${item.imagePath}`}
                    alt={item.title}
                    className="max-h-52 object-contain"
                    data-testid="composer-image-preview"
                  />
                )}
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="composer-caption">Caption</Label>
              <Textarea
                id="composer-caption"
                data-testid="composer-caption"
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                rows={5}
              />
            </div>

            <QuickPublishPanel
              contentItemId={item.id}
              platformLive={platformLive}
              defaultSelected={item.platform ? [item.platform] : []}
              caption={caption}
              hasImage={!!item.imagePath}
              beforeAction={saveCaptionFirst}
              rememberSelection
              onPublished={() => onOpenChange(false)}
              onScheduled={() => onOpenChange(false)}
            />
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
