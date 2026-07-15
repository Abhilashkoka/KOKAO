import { useState } from "react";
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
  getListContentQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { Edit, MoreVertical, Trash2, LayoutGrid, Facebook, Instagram, Linkedin, Twitter, ExternalLink, AtSign, AlertCircle, RotateCw } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { TWEET_MAX_LENGTH, isOverTweetLimit, tweetOverBy, LINKEDIN_MAX_LENGTH, isOverLinkedinLimit, splitForLinkedin, chunkOnWhitespace, splitIntoTweets, THREADS_MAX_LENGTH } from "@workspace/social-limits";

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

  const handlePublish = () => {
    if (!publishItem) return;
    publishContent.mutate(
      { id: publishItem.id },
      {
        onSuccess: (res) => {
          toast({
            title: "Published to Facebook",
            description: res?.permalink ? "Your post is live on Facebook." : undefined,
            action: viewPostAction(res?.permalink),
          });
          queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
          setPublishItem(null);
        },
        onError: (err: any) => {
          toast({
            title: "Publish failed",
            description:
              err?.response?.data?.error ||
              "Could not publish to Facebook. Connect and verify your Facebook Page on the Accounts page first.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const handlePublishInstagram = () => {
    if (!instagramItem) return;
    publishInstagram.mutate(
      { id: instagramItem.id },
      {
        onSuccess: () => {
          toast({
            title: "Publishing to Instagram",
            description:
              "Instagram is processing your image. This card will update to Published when it's live.",
          });
          queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
          setInstagramItem(null);
        },
        onError: (err: any) => {
          toast({
            title: "Publish failed",
            description:
              err?.response?.data?.error ||
              "Could not publish to Instagram. Connect and verify your Instagram account on the Accounts page first.",
            variant: "destructive",
          });
        },
      },
    );
  };

  // One-click retry for a failed publish. Re-uses the same Instagram publish
  // endpoint, which flips the item back to "publishing" and re-runs the
  // bounded background retry; the card then updates via the polling above.
  const handleRetry = (item: any) => {
    setRetryingId(item.id);
    publishInstagram.mutate(
      { id: item.id },
      {
        onSuccess: () => {
          toast({
            title: "Retrying publish",
            description:
              "Instagram is processing your image again. This card will update to Published when it's live.",
          });
          queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
        },
        onError: (err: any) => {
          toast({
            title: "Retry failed",
            description:
              err?.response?.data?.error ||
              "Could not publish to Instagram. Connect and verify your Instagram account on the Accounts page first.",
            variant: "destructive",
          });
        },
        onSettled: () => {
          setRetryingId(null);
        },
      },
    );
  };

  const handlePublishLinkedin = () => {
    if (!linkedinItem) return;
    publishLinkedin.mutate(
      { id: linkedinItem.id },
      {
        onSuccess: (res) => {
          if (res?.commentWarning) {
            toast({
              title: "Published, but some comments failed",
              description: res.commentWarning,
              variant: "destructive",
              action: viewPostAction(res?.permalink),
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
        onError: (err: any) => {
          toast({
            title: "Publish failed",
            description:
              err?.response?.data?.error ||
              "Could not publish to LinkedIn. Connect your LinkedIn account on the Accounts page and try again.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const handlePublishTwitter = () => {
    if (!twitterItem) return;
    publishTwitter.mutate(
      { id: twitterItem.id },
      {
        onSuccess: (res) => {
          toast({
            title: "Published to X",
            description: res?.permalink ? "Your post is live on X." : undefined,
          });
          queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
          setTwitterItem(null);
        },
        onError: (err: any) => {
          toast({
            title: "Publish failed",
            description:
              err?.response?.data?.error ||
              "Could not publish to X. Connect and verify your X account on the Accounts page first.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const handlePublishThreads = () => {
    if (!threadsItem) return;
    publishThreads.mutate(
      { id: threadsItem.id },
      {
        onSuccess: (res) => {
          if (res?.publishWarning) {
            toast({
              title: "Published, but some follow-up posts failed",
              description: res.publishWarning,
              variant: "destructive",
              action: viewPostAction(res?.permalink),
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
        onError: (err: any) => {
          toast({
            title: "Publish failed",
            description:
              err?.response?.data?.error ||
              "Could not publish to Threads. Connect your Threads profile on the Accounts page first.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleDelete = (id: number) => {
    if (!confirm("Are you sure you want to delete this content?")) return;
    deleteContent.mutate({ id }, {
      onSuccess: () => {
        toast({ title: "Content deleted" });
        queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
      }
    });
  };

  const openEdit = (item: any) => {
    setEditItem(item);
    setEditTitle(item.title);
    setEditCaption(item.caption || "");
  };

  const handleUpdate = () => {
    if (!editItem) return;
    updateContent.mutate({
      id: editItem.id,
      data: { title: editTitle, caption: editCaption }
    }, {
      onSuccess: () => {
        toast({ title: "Content updated" });
        queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
        setEditItem(null);
      }
    });
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
                      <DropdownMenuItem disabled={!fbReady} onClick={() => setPublishItem(item)}><Facebook className="h-4 w-4 mr-2" /> Publish to Facebook</DropdownMenuItem>
                      <DropdownMenuItem disabled={!igReady || item.status === 'publishing'} onClick={() => setInstagramItem(item)}><Instagram className="h-4 w-4 mr-2" /> Publish to Instagram</DropdownMenuItem>
                      <DropdownMenuItem disabled={!liReady} onClick={() => setLinkedinItem(item)}><Linkedin className="h-4 w-4 mr-2" /> Publish to LinkedIn</DropdownMenuItem>
                      <DropdownMenuItem disabled={!twReady} onClick={() => setTwitterItem(item)}><Twitter className="h-4 w-4 mr-2" /> Publish to X</DropdownMenuItem>
                      <DropdownMenuItem disabled={!thReady} onClick={() => setThreadsItem(item)}><AtSign className="h-4 w-4 mr-2" /> Publish to Threads</DropdownMenuItem>
                      <DropdownMenuItem className="text-destructive" onClick={() => handleDelete(item.id)}><Trash2 className="h-4 w-4 mr-2" /> Delete</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                
                {item.caption && (
                  <p className="text-muted-foreground text-sm line-clamp-3 mb-4">{item.caption}</p>
                )}

                {item.status === 'failed' && item.failureReason && (
                  <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive mb-4" data-testid={`text-failure-reason-${item.id}`}>
                    <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                    <span>{item.failureReason}</span>
                  </div>
                )}
              </CardContent>
              
              <CardFooter className="p-4 pt-0 bg-card flex justify-between items-center gap-2 text-xs text-muted-foreground">
                <span className="capitalize font-medium px-2 py-1 bg-muted rounded-md">{item.platform}</span>
                <div className="flex items-center gap-2">
                  {item.status === 'failed' && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-xs"
                      disabled={!igReady || !item.imagePath || retryingId === item.id}
                      onClick={() => handleRetry(item)}
                      title={
                        !igReady
                          ? "Connect and verify your Instagram account on the Accounts page first."
                          : !item.imagePath
                            ? "Instagram posts require an image."
                            : "Retry publishing to Instagram"
                      }
                    >
                      <RotateCw className={`h-3 w-3 mr-1 ${retryingId === item.id ? 'animate-spin' : ''}`} />
                      {retryingId === item.id ? "Retrying..." : "Retry"}
                    </Button>
                  )}
                  {item.status === 'published' && item.permalink && (
                    <a
                      href={item.permalink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                    >
                      View post <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
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
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Edit Content</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Title</label>
              <Input value={editTitle} onChange={e => setEditTitle(e.target.value)} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Caption</label>
              <Textarea 
                value={editCaption} 
                onChange={e => setEditCaption(e.target.value)} 
                className="min-h-[150px]"
              />
              {(() => {
                const tweetText = ((editCaption?.trim() || editTitle) ?? "").trim();
                const overLimit = isOverTweetLimit(tweetText);
                return (
                  <p className={`text-xs ${overLimit ? "font-medium" : ""} text-muted-foreground`}>
                    {tweetText.length} / {TWEET_MAX_LENGTH} characters for X
                    {overLimit && ` \u2014 ${tweetOverBy(tweetText)} over; will post as a thread on X (other platforms allow more)`}
                  </p>
                );
              })()}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditItem(null)}>Cancel</Button>
            <Button onClick={handleUpdate} disabled={updateContent.isPending}>Save Changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
            <Button onClick={handlePublish} disabled={publishContent.isPending}>
              {publishContent.isPending ? "Publishing..." : "Publish"}
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
              disabled={publishInstagram.isPending || !instagramItem?.imagePath}
            >
              {publishInstagram.isPending ? "Publishing..." : "Publish"}
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
            <Button onClick={handlePublishLinkedin} disabled={publishLinkedin.isPending}>
              {publishLinkedin.isPending ? "Publishing..." : "Publish"}
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
            <Button onClick={handlePublishTwitter} disabled={publishTwitter.isPending}>
              {publishTwitter.isPending ? "Publishing..." : "Publish"}
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
            <Button onClick={handlePublishThreads} disabled={publishThreads.isPending}>
              {publishThreads.isPending ? "Publishing..." : "Publish"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}