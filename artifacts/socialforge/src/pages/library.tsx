import { useState, useRef, useEffect } from "react";
import { RippleSpinner } from "@/components/ui/ripple-spinner";
import { useLocation, useSearch } from "wouter";
import { 
  useListContent, 
  useDeleteContent,
  useUpdateContent,
  usePublishContentToFacebook,
  usePublishContentToInstagram,
  usePublishContentToLinkedin,
  usePublishContentToTwitter,
  usePublishContentToThreads,
  useGetThreadsStatus,
  useGetFacebookCredentials,
  useGetInstagramCredentials,
  useGetTwitterStatus,
  useGetLinkedinStatus,
  useGenerateCaption,
  useGenerateImage,
  getListContentQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { Edit, MoreVertical, Trash2, LayoutGrid, Facebook, Instagram, Linkedin, Twitter, ExternalLink, AtSign, AlertCircle, RotateCw, Wand2, Image as ImageIcon, X } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { TWEET_MAX_LENGTH, isOverTweetLimit, tweetOverBy, LINKEDIN_MAX_LENGTH, isOverLinkedinLimit, splitForLinkedin, chunkOnWhitespace, splitIntoTweets, THREADS_MAX_LENGTH } from "@workspace/social-limits";
import { useRestartRetry } from "@workspace/api-client-react";
import { PendingPostsWarnings, usePendingResendActions } from "@/components/pending-posts-warning";
import { track } from "@/lib/analytics";

const PLATFORM_NAMES: Record<string, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  twitter: "X (Twitter)",
  linkedin: "LinkedIn",
  threads: "Threads",
};

export function LibraryPage() {
  const { data: content, isLoading } = useListContent({
    query: {
      queryKey: getListContentQueryKey(),
      // While any item is publishing in the background (e.g. Instagram polls
      // the media container asynchronously), poll so the card flips to
      // published/failed without a manual refresh.
      refetchInterval: (query) =>
        (query.state.data ?? []).some((item) => item.status === "publishing")
          ? 4000
          : false,
    },
  });
  const deleteContent = useDeleteContent();
  const updateContent = useUpdateContent();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [editItem, setEditItem] = useState<any | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editCaption, setEditCaption] = useState("");
  const [editPlatform, setEditPlatform] = useState("instagram");
  const [editImagePath, setEditImagePath] = useState<string | null>(null);
  const [confirmReplaceOpen, setConfirmReplaceOpen] = useState(false);
  const [deleteItem, setDeleteItem] = useState<any | null>(null);
  const [editImagePrompt, setEditImagePrompt] = useState<string | null>(null);
  const [editImageB64, setEditImageB64] = useState<string | null>(null);
  const generateCaption = useGenerateCaption();
  const generateImage = useGenerateImage();

  const [publishItem, setPublishItem] = useState<any | null>(null);
  const publishContent = usePublishContentToFacebook();

  const [instagramItem, setInstagramItem] = useState<any | null>(null);
  const publishInstagram = usePublishContentToInstagram();
  const [retryingId, setRetryingId] = useState<number | null>(null);

  const [linkedinItem, setLinkedinItem] = useState<any | null>(null);
  const publishLinkedin = usePublishContentToLinkedin();

  const [twitterItem, setTwitterItem] = useState<any | null>(null);
  const publishTwitter = usePublishContentToTwitter();

  const [threadsItem, setThreadsItem] = useState<any | null>(null);
  const publishThreads = usePublishContentToThreads();

  // Keeps publish buttons disabled during the automatic one-shot retry
  // window (restart 503 / network blip), when no mutation is "pending" but a
  // second click would race the scheduled retry and could double-post.
  const { isRetrying: publishRetryPending, run: runPublishWithRetry } = useRestartRetry();

  // Synchronous in-flight guard: React state updates are async, so a rapid
  // double-click can fire a publish/retry handler twice before the disabled
  // re-render lands. The ref flips immediately on the first call, so the
  // second call in the same frame is a no-op and never reaches the server's
  // 409 guard. Keyed by action+itemId, mirroring usePendingResendActions.
  const publishInFlightRef = useRef<Set<string>>(new Set());

  // True while ANY publish request is in flight (or its automatic retry is
  // pending). Used to grey out every publish control so a fast double-click
  // never reaches the server's 409 "already in progress" guard.
  const publishBusy =
    publishContent.isPending ||
    publishInstagram.isPending ||
    publishLinkedin.isPending ||
    publishTwitter.isPending ||
    publishThreads.isPending ||
    publishRetryPending;

  // The item and platform currently being published, recorded at submit time
  // (not derived from dialog state, so the spinner survives the dialog being
  // closed while the request is still in flight). Only shown while
  // publishBusy is true, so it never lingers after the publish settles.
  const [publishTarget, setPublishTarget] = useState<{ id: number; platform: string } | null>(null);
  const activePublish = publishBusy ? publishTarget : null;

  // Shared resend actions for incomplete chains, used by the post-publish
  // warning toasts below (the cards/dialog render PendingPostsWarnings).
  const {
    handleResendLinkedinComments,
    handleResendThreadsPosts,
    handleResendTwitterPosts,
  } = usePendingResendActions();

  const { data: fbCreds } = useGetFacebookCredentials();
  const { data: igCreds } = useGetInstagramCredentials();
  const { data: twStatus } = useGetTwitterStatus();
  const { data: linkedinStatus } = useGetLinkedinStatus();
  const { data: threadsStatus } = useGetThreadsStatus();
  const fbReady = fbCreds?.verifyStatus === "verified";
  const igReady = igCreds?.verifyStatus === "verified";
  const twReady = !!twStatus?.connected;
  const liReady = !!linkedinStatus?.connected;
  const thReady = !!threadsStatus?.connected;

  const viewPostAction = (permalink: string | null | undefined) =>
    permalink
      ? (
          <ToastAction altText="View post" asChild>
            <a href={permalink} target="_blank" rel="noopener noreferrer">
              View post
            </a>
          </ToastAction>
        )
      : undefined;

  // Shown when a publish fails transiently (restart 503 or a network blip)
  // and we are about to retry it automatically. The restart 503 is issued
  // BEFORE any platform write, and every publish route dedupes server-side,
  // so the retry cannot create a duplicate post.
  const restartRetryToast = (platform: string, reason: "restart" | "network" = "restart") =>
    toast({
      title: reason === "network" ? "Connection hiccup" : "Server is restarting",
      description:
        reason === "network"
          ? `The request didn't go through. Retrying your ${platform} publish automatically in a moment...`
          : `Nothing was posted yet. Retrying your ${platform} publish automatically in a moment...`,
    });

  const publishErrorDescription = (err: any, fallback: string, retried: boolean) => {
    const serverMessage = err?.data?.error || err?.response?.data?.error;
    const base = serverMessage || fallback;
    return retried ? `The automatic retry also failed. ${base}` : base;
  };

  const handlePublish = () => {
    if (!publishItem) return;
    const guardKey = `publish:facebook:${publishItem.id}`;
    if (publishInFlightRef.current.has(guardKey)) return;
    publishInFlightRef.current.add(guardKey);
    setPublishTarget({ id: publishItem.id, platform: "facebook" });
    runPublishWithRetry(publishContent, { id: publishItem.id }, {
      onSuccess: (res) => {
        publishInFlightRef.current.delete(guardKey);
        track("post_published", { platform: "facebook" });
        toast({
          title: "Published to Facebook",
          description: res?.permalink ? "Your post is live on Facebook." : undefined,
          action: viewPostAction(res?.permalink),
        });
        queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
        setPublishItem(null);
      },
      onRetrying: (reason) => restartRetryToast("Facebook", reason),
      onError: (err: any, { retried }) => {
        publishInFlightRef.current.delete(guardKey);
        toast({
          title: "Publish failed",
          description: publishErrorDescription(
            err,
            "Could not publish to Facebook. Connect and verify your Facebook Page on the Accounts page first.",
            retried,
          ),
          variant: "destructive",
        });
      },
    });
  };

  const handlePublishInstagram = () => {
    if (!instagramItem) return;
    const guardKey = `publish:instagram:${instagramItem.id}`;
    if (publishInFlightRef.current.has(guardKey)) return;
    publishInFlightRef.current.add(guardKey);
    setPublishTarget({ id: instagramItem.id, platform: "instagram" });
    runPublishWithRetry(publishInstagram, { id: instagramItem.id }, {
      onSuccess: () => {
        publishInFlightRef.current.delete(guardKey);
        track("post_published", { platform: "instagram" });
        toast({
          title: "Publishing to Instagram",
          description:
            "Instagram is processing your image. This card will update to Published when it's live.",
        });
        queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
        setInstagramItem(null);
      },
      onRetrying: (reason) => restartRetryToast("Instagram", reason),
      onError: (err: any, { retried }) => {
        publishInFlightRef.current.delete(guardKey);
        toast({
          title: "Publish failed",
          description: publishErrorDescription(
            err,
            "Could not publish to Instagram. Connect and verify your Instagram account on the Accounts page first.",
            retried,
          ),
          variant: "destructive",
        });
      },
    });
  };

  // Per-platform config for the failed-state one-click Retry, so the retry
  // re-publishes to the platform the item actually failed on (not always
  // Instagram). Each publish endpoint flips the item's status server-side
  // and the card updates via the content list refetch.
  const retryTargets: Record<
    string,
    {
      label: string;
      mutation: { mutate: any; isPending: boolean };
      ready: boolean;
      needsImage: boolean;
      connectHint: string;
      errorFallback: string;
      successDescription: string;
    }
  > = {
    facebook: {
      label: "Facebook",
      mutation: publishContent,
      ready: fbReady,
      needsImage: false,
      connectHint: "Connect and verify your Facebook Page on the Accounts page first.",
      errorFallback:
        "Could not publish to Facebook. Connect and verify your Facebook Page on the Accounts page first.",
      successDescription: "Publishing to Facebook again. This card will update when it's live.",
    },
    instagram: {
      label: "Instagram",
      mutation: publishInstagram,
      ready: igReady,
      needsImage: true,
      connectHint: "Connect and verify your Instagram account on the Accounts page first.",
      errorFallback:
        "Could not publish to Instagram. Connect and verify your Instagram account on the Accounts page first.",
      successDescription:
        "Instagram is processing your image again. This card will update to Published when it's live.",
    },
    twitter: {
      label: "X",
      mutation: publishTwitter,
      ready: twReady,
      needsImage: false,
      connectHint: "Connect your X account on the Accounts page first.",
      errorFallback:
        "Could not publish to X. Connect and verify your X account on the Accounts page first.",
      successDescription: "Publishing to X again. This card will update when it's live.",
    },
    linkedin: {
      label: "LinkedIn",
      mutation: publishLinkedin,
      ready: liReady,
      needsImage: false,
      connectHint: "Connect your LinkedIn account on the Accounts page first.",
      errorFallback:
        "Could not publish to LinkedIn. Connect your LinkedIn account on the Accounts page and try again.",
      successDescription: "Publishing to LinkedIn again. This card will update when it's live.",
    },
    threads: {
      label: "Threads",
      mutation: publishThreads,
      ready: thReady,
      needsImage: false,
      connectHint: "Connect your Threads profile on the Accounts page first.",
      errorFallback:
        "Could not publish to Threads. Connect your Threads profile on the Accounts page first.",
      successDescription: "Publishing to Threads again. This card will update when it's live.",
    },
  };

  // Resolve the retry target for a failed item from its platform. Unknown or
  // missing platforms fall back to Instagram (the historical behavior).
  const retryTargetFor = (item: any) =>
    retryTargets[item?.platform as string] ?? retryTargets.instagram;

  // One-click retry for a failed publish. Re-uses the publish endpoint for
  // the platform the item failed on, which flips the item back through the
  // normal publish flow; the card then updates via the polling above.
  const handleRetry = (item: any) => {
    const target = retryTargetFor(item);
    const platformKey = retryTargets[item?.platform as string] ? item.platform : "instagram";
    const guardKey = `retry:${item.id}`;
    if (publishInFlightRef.current.has(guardKey)) return;
    publishInFlightRef.current.add(guardKey);
    setRetryingId(item.id);
    setPublishTarget({ id: item.id, platform: platformKey });
    runPublishWithRetry(target.mutation, { id: item.id }, {
      onSuccess: () => {
        publishInFlightRef.current.delete(guardKey);
        toast({
          title: "Retrying publish",
          description: target.successDescription,
        });
        queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
        setRetryingId(null);
      },
      onRetrying: (reason) => restartRetryToast(target.label, reason),
      onError: (err: any, { retried }) => {
        publishInFlightRef.current.delete(guardKey);
        toast({
          title: "Retry failed",
          description: publishErrorDescription(err, target.errorFallback, retried),
          variant: "destructive",
        });
        setRetryingId(null);
      },
    });
  };

  const handlePublishLinkedin = () => {
    if (!linkedinItem) return;
    const guardKey = `publish:linkedin:${linkedinItem.id}`;
    if (publishInFlightRef.current.has(guardKey)) return;
    publishInFlightRef.current.add(guardKey);
    setPublishTarget({ id: linkedinItem.id, platform: "linkedin" });
    runPublishWithRetry(publishLinkedin, { id: linkedinItem.id }, {
        onSuccess: (res) => {
          publishInFlightRef.current.delete(guardKey);
          track("post_published", { platform: "linkedin" });
          if (res?.commentWarning) {
            const itemId = linkedinItem.id;
            toast({
              title: "Published, but some comments failed",
              description: `${res.commentWarning} You can resend the missing comments from this card in the library.`,
              variant: "destructive",
              action: (
                <ToastAction
                  altText="Resend comments"
                  onClick={() => handleResendLinkedinComments(itemId)}
                >
                  Resend comments
                </ToastAction>
              ),
            });
          } else {
            const extra =
              res?.commentsPosted && res.commentsPosted > 0
                ? ` The rest of your caption was added as ${res.commentsPosted} comment(s).`
                : "";
            toast({
              title: "Published to LinkedIn",
              description: res?.permalink
                ? `Your post is live on LinkedIn.${extra}`
                : extra.trim() || undefined,
              action: viewPostAction(res?.permalink),
            });
          }
          queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
          setLinkedinItem(null);
        },
        onRetrying: (reason) => restartRetryToast("LinkedIn", reason),
        onError: (err: any, { retried }) => {
          publishInFlightRef.current.delete(guardKey);
          toast({
            title: "Publish failed",
            description: publishErrorDescription(
              err,
              "Could not publish to LinkedIn. Connect your LinkedIn account on the Accounts page and try again.",
              retried,
            ),
            variant: "destructive",
          });
        },
    });
  };

  const handlePublishTwitter = () => {
    if (!twitterItem) return;
    const guardKey = `publish:twitter:${twitterItem.id}`;
    if (publishInFlightRef.current.has(guardKey)) return;
    publishInFlightRef.current.add(guardKey);
    setPublishTarget({ id: twitterItem.id, platform: "twitter" });
    runPublishWithRetry(publishTwitter, { id: twitterItem.id }, {
      onSuccess: (res) => {
        publishInFlightRef.current.delete(guardKey);
        track("post_published", { platform: "twitter" });
        if (res?.publishWarning) {
          const itemId = twitterItem.id;
          toast({
            title: "Published, but some follow-up posts failed",
            description: `${res.publishWarning} You can resend the missing posts from this card in the library.`,
            variant: "destructive",
            action: (
              <ToastAction
                altText="Resend posts"
                onClick={() => handleResendTwitterPosts(itemId)}
              >
                Resend posts
              </ToastAction>
            ),
          });
        } else {
          toast({
            title: "Published to X",
            description: res?.permalink ? "Your post is live on X." : undefined,
          });
        }
        queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
        setTwitterItem(null);
      },
      onRetrying: (reason) => restartRetryToast("X", reason),
      onError: (err: any, { retried }) => {
        publishInFlightRef.current.delete(guardKey);
        toast({
          title: "Publish failed",
          description: publishErrorDescription(
            err,
            "Could not publish to X. Connect and verify your X account on the Accounts page first.",
            retried,
          ),
          variant: "destructive",
        });
      },
    });
  };

  const handlePublishThreads = () => {
    if (!threadsItem) return;
    const guardKey = `publish:threads:${threadsItem.id}`;
    if (publishInFlightRef.current.has(guardKey)) return;
    publishInFlightRef.current.add(guardKey);
    setPublishTarget({ id: threadsItem.id, platform: "threads" });
    runPublishWithRetry(publishThreads, { id: threadsItem.id }, {
        onSuccess: (res) => {
          publishInFlightRef.current.delete(guardKey);
          track("post_published", { platform: "threads" });
          if (res?.publishWarning) {
            const itemId = threadsItem.id;
            toast({
              title: "Published, but some follow-up posts failed",
              description: `${res.publishWarning} You can resend the missing posts from this card in the library.`,
              variant: "destructive",
              action: (
                <ToastAction
                  altText="Resend posts"
                  onClick={() => handleResendThreadsPosts(itemId)}
                >
                  Resend posts
                </ToastAction>
              ),
            });
          } else {
            const extra =
              res?.postsPublished && res.postsPublished > 1
                ? ` Your caption was posted as a chain of ${res.postsPublished} connected posts.`
                : "";
            toast({
              title: "Published to Threads",
              description: res?.permalink
                ? `Your post is live on Threads.${extra}`
                : extra.trim() || undefined,
              action: viewPostAction(res?.permalink),
            });
          }
          queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
          setThreadsItem(null);
        },
        onRetrying: (reason) => restartRetryToast("Threads", reason),
        onError: (err: any, { retried }) => {
          publishInFlightRef.current.delete(guardKey);
          toast({
            title: "Publish failed",
            description: publishErrorDescription(
              err,
              "Could not publish to Threads. Connect your Threads profile on the Accounts page first.",
              retried,
            ),
            variant: "destructive",
          });
        },
    });
  };

  const confirmDelete = () => {
    if (!deleteItem) return;
    deleteContent.mutate({ id: deleteItem.id }, {
      onSuccess: () => {
        toast({ title: "Content deleted" });
        queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
        setDeleteItem(null);
      },
      onError: (err: any) => {
        toast({ title: "Failed to delete", description: err?.message, variant: "destructive" });
      }
    });
  };

  const openEdit = (item: any) => {
    setEditItem(item);
    setEditTitle(item.title);
    setEditCaption(item.caption || "");
    setEditPlatform(item.platform || "instagram");
    setEditImagePath(item.imagePath ?? null);
    setEditImagePrompt(item.imagePrompt ?? null);
    setEditImageB64(null);
  };

  // Deep link from notifications: /library?item=<id> opens that post's edit
  // dialog once the list is loaded, then cleans the URL so refreshes don't
  // re-trigger it. Guarded per search string (not a one-shot latch) so a
  // second notification click while the page stays mounted still works.
  // Unknown ids (deleted items) just land on the library list.
  const search = useSearch();
  const [, setLocation] = useLocation();
  const handledDeepLinkRef = useRef<string | null>(null);
  useEffect(() => {
    if (!search) {
      // URL cleaned (or plain /library) — re-arm so clicking the same
      // notification again later still opens the dialog.
      handledDeepLinkRef.current = null;
      return;
    }
    if (!content || handledDeepLinkRef.current === search) return;
    const raw = new URLSearchParams(search).get("item");
    if (!raw) return;
    handledDeepLinkRef.current = search;
    const id = Number(raw);
    const item = Number.isInteger(id) && id > 0
      ? content.find((i: any) => i.id === id)
      : undefined;
    if (item) openEdit(item);
    setLocation("/library", { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, search]);

  const handleUpdate = () => {
    if (!editItem) return;
    updateContent.mutate({
      id: editItem.id,
      data: {
        title: editTitle,
        caption: editCaption,
        platform: editPlatform,
        imagePath: editImagePath,
        imagePrompt: editImagePrompt,
      }
    }, {
      onSuccess: () => {
        toast({ title: "Content updated" });
        queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
        setEditItem(null);
      },
      onError: (err: any) => {
        toast({ title: "Failed to save", description: err?.message, variant: "destructive" });
      }
    });
  };

  const handleRegenerateClick = () => {
    if (editImagePath) {
      setConfirmReplaceOpen(true);
      return;
    }
    doRegenerateImage();
  };

  const aiErrorToast = (title: string) => (err: any) => {
    const quota = err?.response?.status === 402 || err?.status === 402;
    toast({
      title,
      description: quota
        ? "You've reached your plan's monthly AI limit. Upgrade your plan to keep generating."
        : err?.message || "Please try again.",
      variant: "destructive",
    });
  };

  const handleRewriteCaption = () => {
    const base = (editCaption?.trim() || editTitle || "").trim();
    if (!base) {
      toast({ title: "Nothing to rewrite", description: "Add some caption text first.", variant: "destructive" });
      return;
    }
    generateCaption.mutate(
      {
        data: {
          prompt: `Rewrite and adapt the following social media caption so it fits the conventions, tone, and length requirements of ${PLATFORM_NAMES[editPlatform] ?? editPlatform}. Keep the core message. Original caption:\n\n${base}`,
          platform: editPlatform,
          brandKitId: editItem?.brandKitId ?? undefined,
        },
      },
      {
        onSuccess: (res) => {
          const tags = res.hashtags?.length ? `\n\n${res.hashtags.map((t: string) => (t.startsWith("#") ? t : `#${t}`)).join(" ")}` : "";
          setEditCaption(`${res.caption}${tags}`);
          toast({ title: `Caption adapted for ${PLATFORM_NAMES[editPlatform] ?? editPlatform}` });
        },
        onError: aiErrorToast("Could not rewrite the caption"),
      },
    );
  };

  const doRegenerateImage = () => {
    const prompt = (editCaption?.trim() || editTitle || editImagePrompt?.trim() || "").trim();
    if (!prompt) {
      toast({ title: "Nothing to generate from", description: "Add a caption or title first so the image has a subject.", variant: "destructive" });
      return;
    }
    generateImage.mutate(
      { data: { prompt, brandKitId: editItem?.brandKitId ?? undefined } },
      {
        onSuccess: (res) => {
          setEditImagePath(res.imagePath);
          setEditImagePrompt(prompt);
          setEditImageB64(res.b64Json);
          toast({ title: editImagePath ? "Image regenerated" : "Image generated", description: "Click Save Changes to keep it." });
        },
        onError: aiErrorToast("Could not generate the image"),
      },
    );
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-48" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {[1, 2, 3, 4, 5, 6].map(i => <Skeleton key={i} className="h-72 rounded-xl" />)}
        </div>
      </div>
    );
  }

  const items = content || [];

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight">Content Library</h1>
          <p className="text-muted-foreground text-lg mt-1">Manage your generated captions and images.</p>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="text-center py-20 bg-muted/30 rounded-2xl border border-border border-dashed">
          <LayoutGrid className="mx-auto h-12 w-12 text-muted-foreground/50 mb-4" />
          <h3 className="text-xl font-semibold">Library is empty</h3>
          <p className="text-muted-foreground mt-2 mb-6">You haven't saved any content yet.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {items.map((item, i) => (
            <Card key={item.id} className="overflow-hidden flex flex-col group hover:shadow-lg transition-all duration-300 border-border animate-in fade-in" style={{ animationDelay: `${i * 50}ms` }}>
              {item.imagePath ? (
                <div className="aspect-square w-full bg-muted relative overflow-hidden border-b">
                  <img src={`/api/storage${item.imagePath}`} alt={item.title} className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
              ) : (
                <div className="aspect-video w-full bg-primary/5 flex flex-col items-center justify-center p-6 border-b relative">
                  <LayoutGrid className="h-10 w-10 text-primary/30 mb-2" />
                  <p className="text-xs font-medium text-primary/50 uppercase tracking-widest">Text Only</p>
                </div>
              )}
              
              <CardContent className="flex-1 p-5">
                <div className="flex justify-between items-start gap-2 mb-3">
                  <h3 className="font-semibold text-lg line-clamp-1" title={item.title}>{item.title}</h3>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8 -mr-2 shrink-0">
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => openEdit(item)}><Edit className="h-4 w-4 mr-2" /> Edit</DropdownMenuItem>
                      <DropdownMenuItem disabled={!fbReady || publishBusy} onClick={() => setPublishItem(item)}><Facebook className="h-4 w-4 mr-2" /> Publish to Facebook</DropdownMenuItem>
                      <DropdownMenuItem disabled={!igReady || publishBusy || item.status === 'publishing'} onClick={() => setInstagramItem(item)}><Instagram className="h-4 w-4 mr-2" /> Publish to Instagram</DropdownMenuItem>
                      <DropdownMenuItem disabled={!liReady || publishBusy} onClick={() => setLinkedinItem(item)}><Linkedin className="h-4 w-4 mr-2" /> Publish to LinkedIn</DropdownMenuItem>
                      <DropdownMenuItem disabled={!twReady || publishBusy} onClick={() => setTwitterItem(item)}><Twitter className="h-4 w-4 mr-2" /> Publish to X</DropdownMenuItem>
                      <DropdownMenuItem disabled={!thReady || publishBusy} onClick={() => setThreadsItem(item)}><AtSign className="h-4 w-4 mr-2" /> Publish to Threads</DropdownMenuItem>
                      <DropdownMenuItem className="text-destructive" onClick={() => setDeleteItem(item)}><Trash2 className="h-4 w-4 mr-2" /> Delete</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                
                {item.caption && (
                  <p className="text-muted-foreground text-sm line-clamp-3 mb-4">{item.caption}</p>
                )}

                {(Object.keys(item.publishedPlatforms ?? {}).length > 0 || item.status === 'published') && (
                  <div className="flex flex-wrap items-center gap-1.5 mb-4" data-testid={`published-platforms-${item.id}`}>
                    <span className="text-xs text-muted-foreground">Published to:</span>
                    {(Object.keys(item.publishedPlatforms ?? {}).length > 0
                      ? Object.keys(item.publishedPlatforms ?? {})
                      : item.platform ? [item.platform] : []
                    ).map(p => (
                      <span key={p} className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium capitalize">
                        {p === "twitter" ? "X" : p}
                      </span>
                    ))}
                  </div>
                )}

                <PendingPostsWarnings item={item} />

                {item.status === 'failed' && item.failureReason && (
                  <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive mb-4" data-testid={`text-failure-reason-${item.id}`}>
                    <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                    <span>{item.failureReason}</span>
                  </div>
                )}
              </CardContent>
              
              <CardFooter className="p-4 pt-0 bg-card flex flex-col items-stretch gap-2 text-xs text-muted-foreground">
                <div className="flex flex-wrap gap-1.5">
                  {([
                    { key: "facebook", label: "Facebook", Icon: Facebook, ready: fbReady, open: () => setPublishItem(item), title: fbReady ? "Publish to Facebook" : "Connect and verify your Facebook Page on the Accounts page first." },
                    { key: "instagram", label: "Instagram", Icon: Instagram, ready: igReady && item.status !== "publishing", open: () => setInstagramItem(item), title: !igReady ? "Connect and verify your Instagram account on the Accounts page first." : item.status === "publishing" ? "This post is currently publishing to Instagram." : "Publish to Instagram" },
                    { key: "twitter", label: "X", Icon: Twitter, ready: twReady, open: () => setTwitterItem(item), title: twReady ? "Publish to X" : "Connect your X account on the Accounts page first." },
                    { key: "linkedin", label: "LinkedIn", Icon: Linkedin, ready: liReady, open: () => setLinkedinItem(item), title: liReady ? "Publish to LinkedIn" : "Connect your LinkedIn account on the Accounts page first." },
                    { key: "threads", label: "Threads", Icon: AtSign, ready: thReady, open: () => setThreadsItem(item), title: thReady ? "Publish to Threads" : "Connect your Threads profile on the Accounts page first." },
                  ] as const)
                    .slice()
                    .sort((a, b) => (a.key === item.platform ? -1 : b.key === item.platform ? 1 : 0))
                    .map(({ key, label, Icon, ready, open, title }) => {
                      const alreadyPublished = !!item.publishedPlatforms?.[key];
                      const isActivePublish =
                        activePublish?.id === item.id && activePublish.platform === key;
                      return (
                        <Button
                          key={key}
                          size="sm"
                          variant={alreadyPublished ? "default" : "outline"}
                          className="h-7 px-2 text-xs"
                          disabled={!ready || publishBusy}
                          onClick={open}
                          title={
                            isActivePublish
                              ? `Publishing to ${label}...`
                              : publishBusy
                                ? "Another publish is in progress. Wait for it to finish."
                                : alreadyPublished && ready
                                  ? `Republish to ${label}`
                                  : title
                          }
                          data-testid={`button-publish-${key}-${item.id}`}
                        >
                          {isActivePublish ? (
                            <>
                              <RippleSpinner className="h-3 w-3 mr-1" /> Publishing...
                            </>
                          ) : (
                            <>
                              <Icon className="h-3 w-3 mr-1" /> {alreadyPublished ? `Republish ${label}` : label}
                            </>
                          )}
                        </Button>
                      );
                    })}
                </div>
                <div className="flex justify-end items-center gap-2">
                  {item.status === 'failed' && (() => {
                    const target = retryTargetFor(item);
                    const missingImage = target.needsImage && !item.imagePath;
                    return (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-xs"
                        disabled={!target.ready || missingImage || publishBusy || retryingId === item.id}
                        onClick={() => handleRetry(item)}
                        title={
                          !target.ready
                            ? target.connectHint
                            : missingImage
                              ? `${target.label} posts require an image.`
                              : `Retry publishing to ${target.label}`
                        }
                      >
                        {retryingId === item.id ? <RippleSpinner className="h-3 w-3 mr-1" /> : <RotateCw className="h-3 w-3 mr-1" />}
                        {retryingId === item.id ? "Retrying..." : "Retry"}
                      </Button>
                    );
                  })()}
                  {item.status === 'published' && Object.keys(item.publishedPlatforms ?? {}).length > 0 ? (
                    Object.entries(item.publishedPlatforms ?? {}).map(([p, info]) =>
                      info.permalink ? (
                        <a
                          key={p}
                          href={info.permalink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 font-medium text-primary hover:underline capitalize"
                        >
                          {p === "twitter" ? "X" : p} <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : (
                        <span key={p} className="inline-flex items-center font-medium text-muted-foreground capitalize">
                          {p === "twitter" ? "X" : p}
                        </span>
                      ),
                    )
                  ) : item.status === 'published' && item.permalink ? (
                    <a
                      href={item.permalink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                    >
                      View post <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : null}
                  <span className={`px-2 py-1 rounded-md font-medium uppercase ${item.status === 'published' ? 'text-green-600 bg-green-600/10' : item.status === 'scheduled' ? 'text-blue-600 bg-blue-600/10' : item.status === 'publishing' ? 'text-amber-600 bg-amber-600/10 animate-pulse' : item.status === 'failed' ? 'text-destructive bg-destructive/10' : 'text-orange-600 bg-orange-600/10'}`}>
                    {item.status}
                  </span>
                </div>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={!!editItem} onOpenChange={(open) => !open && setEditItem(null)}>
        <DialogContent className="sm:max-w-[560px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Content</DialogTitle>
            <DialogDescription>
              Adjust the text and image, or let AI adapt them to the selected platform.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {editItem && (
              <PendingPostsWarnings
                item={content?.find((c) => c.id === editItem.id) ?? editItem}
                idPrefix="edit-"
              />
            )}
            <div className="space-y-2">
              <label className="text-sm font-medium">Platform</label>
              <Select value={editPlatform} onValueChange={setEditPlatform}>
                <SelectTrigger>
                  <SelectValue placeholder="Platform" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="instagram">Instagram</SelectItem>
                  <SelectItem value="facebook">Facebook</SelectItem>
                  <SelectItem value="twitter">X (Twitter)</SelectItem>
                  <SelectItem value="linkedin">LinkedIn</SelectItem>
                  <SelectItem value="threads">Threads</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Title</label>
              <Input value={editTitle} onChange={e => setEditTitle(e.target.value)} />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">Caption</label>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  onClick={handleRewriteCaption}
                  disabled={generateCaption.isPending}
                >
                  {generateCaption.isPending ? (
                    <RippleSpinner className="h-3 w-3 mr-1" />
                  ) : (
                    <Wand2 className="h-3 w-3 mr-1" />
                  )}
                  {generateCaption.isPending ? "Adapting..." : `Adapt for ${PLATFORM_NAMES[editPlatform] ?? editPlatform}`}
                </Button>
              </div>
              <Textarea 
                value={editCaption} 
                onChange={e => setEditCaption(e.target.value)} 
                className="min-h-[150px]"
              />
              {editPlatform === "twitter" && (() => {
                const tweetText = ((editCaption?.trim() || editTitle) ?? "").trim();
                const overLimit = isOverTweetLimit(tweetText);
                return (
                  <p className={`text-xs ${overLimit ? "font-medium" : ""} text-muted-foreground`}>
                    {tweetText.length} / {TWEET_MAX_LENGTH} characters for X
                    {overLimit && ` \u2014 ${tweetOverBy(tweetText)} over; will post as a thread on X`}
                  </p>
                );
              })()}
              {editPlatform === "linkedin" && (() => {
                const liText = ((editCaption?.trim() || editTitle) ?? "").trim();
                const overLimit = isOverLinkedinLimit(liText);
                const commentCount = overLimit ? splitForLinkedin(liText).comments.length : 0;
                return (
                  <p className={`text-xs ${overLimit ? "font-medium" : ""} text-muted-foreground`}>
                    {liText.length} / {LINKEDIN_MAX_LENGTH} characters for LinkedIn
                    {overLimit && ` \u2014 the rest will post as ${commentCount} follow-up comment${commentCount === 1 ? "" : "s"}`}
                  </p>
                );
              })()}
              {editPlatform === "threads" && (() => {
                const thText = ((editCaption?.trim() || editTitle) ?? "").trim();
                const overLimit = thText.length > THREADS_MAX_LENGTH;
                const chunkCount = overLimit ? chunkOnWhitespace(thText, THREADS_MAX_LENGTH).length : 0;
                return (
                  <p className={`text-xs ${overLimit ? "font-medium" : ""} text-muted-foreground`}>
                    {thText.length} / {THREADS_MAX_LENGTH} characters for Threads
                    {overLimit && ` \u2014 will post as a chain of ${chunkCount} connected posts`}
                  </p>
                );
              })()}
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">Image</label>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    onClick={handleRegenerateClick}
                    disabled={generateImage.isPending}
                  >
                    {generateImage.isPending ? (
                      <RippleSpinner className="h-3 w-3 mr-1" />
                    ) : (
                      <ImageIcon className="h-3 w-3 mr-1" />
                    )}
                    {generateImage.isPending ? "Generating..." : editImagePath ? "Regenerate" : "Generate image"}
                  </Button>
                  {editImagePath && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-xs"
                      onClick={() => { setEditImagePath(null); setEditImageB64(null); setEditImagePrompt(null); }}
                      disabled={generateImage.isPending}
                    >
                      <X className="h-3 w-3 mr-1" /> Remove
                    </Button>
                  )}
                </div>
              </div>
              {editImagePath ? (
                <img
                  src={editImageB64 ? `data:image/png;base64,${editImageB64}` : `/api/storage${editImagePath}`}
                  alt="Content"
                  className="w-full max-h-[260px] rounded-md border object-contain bg-muted/30"
                />
              ) : (
                <p className="text-xs text-muted-foreground">
                  No image attached.
                  {editPlatform === "instagram" && " Instagram posts require an image before you can publish."}
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditItem(null)}>Cancel</Button>
            <Button onClick={handleUpdate} disabled={updateContent.isPending || generateImage.isPending}>
              {updateContent.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmReplaceOpen} onOpenChange={setConfirmReplaceOpen}>
        <AlertDialogContent className="sm:max-w-[420px]">
          <AlertDialogHeader>
            <AlertDialogTitle>Replace the current image?</AlertDialogTitle>
            <AlertDialogDescription>
              {editItem?.title ? `"${editItem.title}" already has an image.` : "This post already has an image."} Generating a new one will replace it once you save, and the current image cannot be restored.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {editImagePath && (
            <img
              src={editImageB64 ? `data:image/png;base64,${editImageB64}` : `/api/storage${editImagePath}`}
              alt="Current image"
              className="w-full max-h-[180px] rounded-md border object-contain bg-muted/30"
            />
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Keep current image</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setConfirmReplaceOpen(false); doRegenerateImage(); }}>
              Replace image
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deleteItem} onOpenChange={(open) => !open && setDeleteItem(null)}>
        <AlertDialogContent className="sm:max-w-[420px]">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this post?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteItem?.title ? `"${deleteItem.title}" will be permanently deleted from your library.` : "This post will be permanently deleted from your library."} This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => { e.preventDefault(); confirmDelete(); }}
              disabled={deleteContent.isPending}
            >
              {deleteContent.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!publishItem} onOpenChange={(open) => !open && setPublishItem(null)}>
        <DialogContent className="sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>Publish to Facebook</DialogTitle>
            <DialogDescription>
              This posts the caption{publishItem?.imagePath ? " and image" : ""} to your connected Facebook Page{fbCreds?.accountName ? ` (${fbCreds.accountName})` : ""}.
            </DialogDescription>
          </DialogHeader>
          {publishItem && (
            <div className="space-y-2 py-2">
              <p className="font-medium">{publishItem.title}</p>
              {publishItem.caption && (
                <p className="text-sm text-muted-foreground line-clamp-4">{publishItem.caption}</p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPublishItem(null)}>Cancel</Button>
            <Button onClick={handlePublish} disabled={publishContent.isPending || publishRetryPending}>
              {publishContent.isPending ? "Publishing..." : publishRetryPending ? "Retrying..." : "Publish"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!instagramItem} onOpenChange={(open) => !open && setInstagramItem(null)}>
        <DialogContent className="sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>Publish to Instagram</DialogTitle>
            <DialogDescription>
              {instagramItem && !instagramItem.imagePath
                ? "Instagram posts require an image. Add an image to this content before publishing."
                : `This posts the image and caption to your connected Instagram account${igCreds?.accountName ? ` (${igCreds.accountName})` : ""}.`}
            </DialogDescription>
          </DialogHeader>
          {instagramItem && (
            <div className="space-y-2 py-2">
              <p className="font-medium">{instagramItem.title}</p>
              {instagramItem.caption && (
                <p className="text-sm text-muted-foreground line-clamp-4">{instagramItem.caption}</p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setInstagramItem(null)}>Cancel</Button>
            <Button
              onClick={handlePublishInstagram}
              disabled={publishInstagram.isPending || publishRetryPending || !instagramItem?.imagePath}
            >
              {publishInstagram.isPending ? "Publishing..." : publishRetryPending ? "Retrying..." : "Publish"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!linkedinItem} onOpenChange={(open) => !open && setLinkedinItem(null)}>
        <DialogContent className="sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>Publish to LinkedIn</DialogTitle>
            <DialogDescription>
              This posts the caption{linkedinItem?.imagePath ? " and image" : ""} to your connected LinkedIn feed. Make sure you've connected LinkedIn on the Accounts page.
            </DialogDescription>
          </DialogHeader>
          {linkedinItem && (() => {
            const liText = ((linkedinItem.caption?.trim() || linkedinItem.title) ?? "").trim();
            const overLimit = isOverLinkedinLimit(liText);
            const liSplit = splitForLinkedin(liText);
            const commentCount = liSplit.comments.length;
            return (
              <div className="space-y-2 py-2">
                <p className="font-medium">{linkedinItem.title}</p>
                {liText && (
                  <p className="text-sm text-muted-foreground line-clamp-4 whitespace-pre-wrap break-words">{liText}</p>
                )}
                <p className={`text-xs ${overLimit ? "font-medium" : ""} text-muted-foreground`}>
                  {liText.length} / {LINKEDIN_MAX_LENGTH} characters
                  {overLimit ? ` \u00b7 ${commentCount} follow-up comment${commentCount === 1 ? "" : "s"}` : ""}
                </p>
                {overLimit && (
                  <div className="rounded-md border p-3 text-sm text-muted-foreground">
                    Over {LINKEDIN_MAX_LENGTH} characters — the rest will be posted as {commentCount} follow-up comment{commentCount === 1 ? "" : "s"}. Your full message is preserved.
                  </div>
                )}
              </div>
            );
          })()}
          <DialogFooter>
            <Button variant="outline" onClick={() => setLinkedinItem(null)}>Cancel</Button>
            <Button onClick={handlePublishLinkedin} disabled={publishLinkedin.isPending || publishRetryPending}>
              {publishLinkedin.isPending ? "Publishing..." : publishRetryPending ? "Retrying..." : "Publish"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!twitterItem} onOpenChange={(open) => !open && setTwitterItem(null)}>
        <DialogContent className="sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>Publish to X</DialogTitle>
            <DialogDescription>
              This posts the caption{twitterItem?.imagePath ? " and image" : ""} to your connected X account{twStatus?.accountName ? ` (${twStatus.accountName})` : ""}.
            </DialogDescription>
          </DialogHeader>
          {twitterItem && (() => {
            const tweetText = ((twitterItem.caption?.trim() || twitterItem.title) ?? "").trim();
            const overLimit = isOverTweetLimit(tweetText);
            const threadTweets = splitIntoTweets(tweetText);
            return (
              <div className="space-y-2 py-2">
                <p className="font-medium">{twitterItem.title}</p>
                <p className="text-sm text-muted-foreground whitespace-pre-wrap break-words">{tweetText}</p>
                <p className={`text-xs ${overLimit ? "font-medium" : ""} text-muted-foreground`}>
                  {tweetText.length} characters
                  {overLimit ? ` \u00b7 ${threadTweets.length} tweets` : ` / ${TWEET_MAX_LENGTH}`}
                </p>
                {overLimit && (
                  <div className="rounded-md border p-3 text-sm text-muted-foreground">
                    This caption is over the {TWEET_MAX_LENGTH}-character limit, so it will be posted as a thread of {threadTweets.length} tweets chained as replies. Your full message is preserved{twitterItem.imagePath ? ", and the image goes on the first tweet" : ""}.
                  </div>
                )}
              </div>
            );
          })()}
          <DialogFooter>
            <Button variant="outline" onClick={() => setTwitterItem(null)}>Cancel</Button>
            <Button onClick={handlePublishTwitter} disabled={publishTwitter.isPending || publishRetryPending}>
              {publishTwitter.isPending ? "Publishing..." : publishRetryPending ? "Retrying..." : "Publish"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={!!threadsItem} onOpenChange={(open) => !open && setThreadsItem(null)}>
        <DialogContent className="sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>Publish to Threads</DialogTitle>
            <DialogDescription>
              This posts the caption{threadsItem?.imagePath ? " and image" : ""} to your connected Threads profile{threadsStatus?.accountName ? ` (${threadsStatus.accountName})` : ""}.
            </DialogDescription>
          </DialogHeader>
          {threadsItem && (() => {
            const thText = ((threadsItem.caption?.trim() || threadsItem.title) ?? "").trim();
            const overLimit = thText.length > THREADS_MAX_LENGTH;
            const chunks = chunkOnWhitespace(thText, THREADS_MAX_LENGTH);
            return (
              <div className="space-y-2 py-2">
                <p className="font-medium">{threadsItem.title}</p>
                <p className="text-sm text-muted-foreground line-clamp-4 whitespace-pre-wrap break-words">{thText}</p>
                <p className={`text-xs ${overLimit ? "font-medium" : ""} text-muted-foreground`}>
                  {thText.length} characters
                  {overLimit ? ` \u00b7 ${chunks.length} posts` : ` / ${THREADS_MAX_LENGTH}`}
                </p>
                {overLimit && (
                  <div className="rounded-md border p-3 text-sm text-muted-foreground">
                    This caption is over the {THREADS_MAX_LENGTH}-character limit, so it will be posted as a chain of {chunks.length} connected posts. Your full message is preserved{threadsItem.imagePath ? ", and the image goes on the first post" : ""}.
                  </div>
                )}
              </div>
            );
          })()}
          <DialogFooter>
            <Button variant="outline" onClick={() => setThreadsItem(null)}>Cancel</Button>
            <Button onClick={handlePublishThreads} disabled={publishThreads.isPending || publishRetryPending}>
              {publishThreads.isPending ? "Publishing..." : publishRetryPending ? "Retrying..." : "Publish"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}