import { useState } from "react";
import {
  useResendLinkedinComments,
  useResendThreadsPosts,
  useResendTwitterPosts,
  getListContentQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ToastAction } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import { AlertCircle, RotateCw, ExternalLink } from "lucide-react";

// The subset of a content item this warning block needs. Kept loose (any
// content list/detail shape satisfies it).
export interface PendingWarningItem {
  id: number;
  linkedinCommentsPending?: number | null;
  threadsPostsPending?: number | null;
  twitterPostsPending?: number | null;
}

export function hasPendingPosts(item: PendingWarningItem | null | undefined): boolean {
  if (!item) return false;
  return (
    (item.linkedinCommentsPending ?? 0) > 0 ||
    (item.threadsPostsPending ?? 0) > 0 ||
    (item.twitterPostsPending ?? 0) > 0
  );
}

/**
 * Shared resend actions for incomplete published chains: LinkedIn follow-up
 * comments, Threads thread pieces, and X thread pieces. Each handler posts
 * only the missing pieces (the server keeps the original numbering /
 * chains onto the last successfully posted piece), shows a toast with the
 * outcome, and refreshes the content list.
 */
export function usePendingResendActions() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const resendLinkedinComments = useResendLinkedinComments();
  const resendThreadsPosts = useResendThreadsPosts();
  const resendTwitterPosts = useResendTwitterPosts();
  const [resendingLinkedinId, setResendingLinkedinId] = useState<number | null>(null);
  const [resendingThreadsId, setResendingThreadsId] = useState<number | null>(null);
  const [resendingTwitterId, setResendingTwitterId] = useState<number | null>(null);

  const viewPostAction = (permalink: string | null | undefined) =>
    permalink ? (
      <ToastAction altText="View post" asChild>
        <a href={permalink} target="_blank" rel="noopener noreferrer">
          View post <ExternalLink className="h-3 w-3 ml-1" />
        </a>
      </ToastAction>
    ) : undefined;

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });

  const handleResendLinkedinComments = (itemId: number) => {
    setResendingLinkedinId(itemId);
    resendLinkedinComments.mutate(
      { id: itemId },
      {
        onSuccess: (res) => {
          if (res?.commentWarning) {
            toast({
              title: "Some comments are still missing",
              description: res.commentWarning,
              variant: "destructive",
              action: viewPostAction(res?.permalink),
            });
          } else {
            toast({
              title: "Comments resent",
              description: `All ${res?.commentsTotal ?? ""} follow-up comment(s) are now posted on LinkedIn.`,
              action: viewPostAction(res?.permalink),
            });
          }
          invalidate();
        },
        onError: (err: any) => {
          toast({
            title: "Resend failed",
            description:
              err?.response?.data?.error ||
              "Could not resend the LinkedIn comments. Try again.",
            variant: "destructive",
          });
        },
        onSettled: () => setResendingLinkedinId(null),
      },
    );
  };

  const handleResendThreadsPosts = (itemId: number) => {
    setResendingThreadsId(itemId);
    resendThreadsPosts.mutate(
      { id: itemId },
      {
        onSuccess: (res) => {
          if (res?.publishWarning) {
            toast({
              title: "Some posts are still missing",
              description: res.publishWarning,
              variant: "destructive",
              action: viewPostAction(res?.permalink),
            });
          } else {
            toast({
              title: "Thread completed",
              description: `All ${res?.postsTotal ?? ""} post(s) of the thread are now live on Threads.`,
              action: viewPostAction(res?.permalink),
            });
          }
          invalidate();
        },
        onError: (err: any) => {
          toast({
            title: "Resend failed",
            description:
              err?.response?.data?.error ||
              "Could not resend the missing Threads posts. Try again.",
            variant: "destructive",
          });
        },
        onSettled: () => setResendingThreadsId(null),
      },
    );
  };

  const handleResendTwitterPosts = (itemId: number) => {
    setResendingTwitterId(itemId);
    resendTwitterPosts.mutate(
      { id: itemId },
      {
        onSuccess: (res) => {
          if (res?.publishWarning) {
            toast({
              title: "Some posts are still missing",
              description: res.publishWarning,
              variant: "destructive",
              action: viewPostAction(res?.permalink),
            });
          } else {
            toast({
              title: "Thread completed",
              description: `All ${res?.postsTotal ?? ""} post(s) of the thread are now live on X.`,
              action: viewPostAction(res?.permalink),
            });
          }
          invalidate();
        },
        onError: (err: any) => {
          toast({
            title: "Resend failed",
            description:
              err?.response?.data?.error ||
              "Could not resend the missing X posts. Try again.",
            variant: "destructive",
          });
        },
        onSettled: () => setResendingTwitterId(null),
      },
    );
  };

  return {
    handleResendLinkedinComments,
    handleResendThreadsPosts,
    handleResendTwitterPosts,
    resendingLinkedinId,
    resendingThreadsId,
    resendingTwitterId,
  };
}

/**
 * Amber warning blocks shown wherever a published content item appears when
 * part of its caption never went live (LinkedIn follow-up comments, Threads
 * or X thread pieces), each with a resend button that posts only the missing
 * pieces. Shared by the Content Library card, the edit dialog, and the
 * Schedule page so the warning is visible from any view.
 *
 * `idPrefix` keeps data-testids unique when the same item is rendered in
 * more than one place at once (e.g. library card + edit dialog).
 */
export function PendingPostsWarnings({
  item,
  idPrefix = "",
}: {
  item: PendingWarningItem;
  idPrefix?: string;
}) {
  const {
    handleResendLinkedinComments,
    handleResendThreadsPosts,
    handleResendTwitterPosts,
    resendingLinkedinId,
    resendingThreadsId,
    resendingTwitterId,
  } = usePendingResendActions();

  const linkedinPending = item.linkedinCommentsPending ?? 0;
  const threadsPending = item.threadsPostsPending ?? 0;
  const twitterPending = item.twitterPostsPending ?? 0;

  if (linkedinPending <= 0 && threadsPending <= 0 && twitterPending <= 0) {
    return null;
  }

  const resendingLinkedin = resendingLinkedinId === item.id;
  const resendingThreads = resendingThreadsId === item.id;
  const resendingTwitter = resendingTwitterId === item.id;

  return (
    <>
      {linkedinPending > 0 && (
        <div
          className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-700 dark:text-amber-400 mb-4 space-y-2"
          data-testid={`text-${idPrefix}linkedin-comments-pending-${item.id}`}
        >
          <div className="flex items-start gap-2">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>
              {linkedinPending} LinkedIn follow-up comment{linkedinPending === 1 ? "" : "s"} with the rest of the caption {linkedinPending === 1 ? "is" : "are"} still missing from the published post.
            </span>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            disabled={resendingLinkedin}
            onClick={() => handleResendLinkedinComments(item.id)}
            data-testid={`button-${idPrefix}resend-linkedin-comments-${item.id}`}
          >
            <RotateCw className={`h-3 w-3 mr-1 ${resendingLinkedin ? "animate-spin" : ""}`} />
            {resendingLinkedin ? "Resending..." : "Resend comments"}
          </Button>
        </div>
      )}

      {threadsPending > 0 && (
        <div
          className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-700 dark:text-amber-400 mb-4 space-y-2"
          data-testid={`text-${idPrefix}threads-posts-pending-${item.id}`}
        >
          <div className="flex items-start gap-2">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>
              {threadsPending} Threads follow-up post{threadsPending === 1 ? "" : "s"} with the rest of the caption {threadsPending === 1 ? "is" : "are"} still missing from the published thread.
            </span>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            disabled={resendingThreads}
            onClick={() => handleResendThreadsPosts(item.id)}
            data-testid={`button-${idPrefix}resend-threads-posts-${item.id}`}
          >
            <RotateCw className={`h-3 w-3 mr-1 ${resendingThreads ? "animate-spin" : ""}`} />
            {resendingThreads ? "Resending..." : "Resend posts"}
          </Button>
        </div>
      )}

      {twitterPending > 0 && (
        <div
          className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-700 dark:text-amber-400 mb-4 space-y-2"
          data-testid={`text-${idPrefix}twitter-posts-pending-${item.id}`}
        >
          <div className="flex items-start gap-2">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>
              {twitterPending} X follow-up post{twitterPending === 1 ? "" : "s"} with the rest of the caption {twitterPending === 1 ? "is" : "are"} still missing from the published thread.
            </span>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            disabled={resendingTwitter}
            onClick={() => handleResendTwitterPosts(item.id)}
            data-testid={`button-${idPrefix}resend-twitter-posts-${item.id}`}
          >
            <RotateCw className={`h-3 w-3 mr-1 ${resendingTwitter ? "animate-spin" : ""}`} />
            {resendingTwitter ? "Resending..." : "Resend posts"}
          </Button>
        </div>
      )}
    </>
  );
}
