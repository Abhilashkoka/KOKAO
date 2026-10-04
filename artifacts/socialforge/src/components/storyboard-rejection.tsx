import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useRejectVideoStoryboard, useGetVideoJob, getGetVideoJobQueryKey,
  getListVideoJobsQueryKey, getListCharactersQueryKey, getGetGuidedStoryDraftQueryKey, type VideoJob,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { apiErrorMessage } from "@/lib/apiErrorMessage";

export function StoryboardRejectionControl({ job }: { job: VideoJob }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const client = useQueryClient();
  const reject = useRejectVideoStoryboard();
  const { data: latest } = useGetVideoJob(job.id, {
    query: {
      queryKey: getGetVideoJobQueryKey(job.id),
      enabled: job.storyboardRejection?.cleanupState === "pending",
      refetchInterval: (query) => query.state.data?.storyboardRejection?.cleanupState === "pending" ? 5000 : false,
    },
  });
  const rejection = latest?.storyboardRejection ?? job.storyboardRejection;
  if (rejection) return (
    <div role="status" className="rounded-lg border p-4 space-y-2" data-testid="storyboard-rejection-status">
      <p className="font-medium">Storyboard rejected</p>
      <p className="text-sm text-muted-foreground">
        {rejection.removedCharacterCount} unused character(s) and their outfits removed from KOKAO.
        {rejection.preservedCharacterCount > 0 && ` ${rejection.preservedCharacterCount} character(s) kept because another story/draft or active registration needs them.`}
      </p>
      <p className="text-sm text-muted-foreground">
        {rejection.cleanupState === "complete" ? "Provider cleanup complete."
          : rejection.cleanupMessage ?? "Provider cleanup is pending and will retry automatically."}
      </p>
      <p className="text-xs text-muted-foreground">Video history and any completed download are retained. Existing charges are unchanged. This storyboard cannot be retried.</p>
    </div>
  );
  if (!["failed", "succeeded"].includes(job.status)) return null;
  return <>
    <Button variant="destructive" onClick={() => { setError(null); setOpen(true); }} data-testid="button-reject-storyboard">
      Reject and delete unused characters
    </Button>
    <AlertDialog open={open} onOpenChange={(next) => { if (!reject.isPending) setOpen(next); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reject this storyboard and delete its unused characters?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently removes all characters used by this story—including existing library characters—and their outfits,
            unless another story, draft or active registration still needs them. Atlas cleanup runs automatically and waits for
            any active provider tasks. You cannot retry or rebuild this rejected storyboard.
            The completed video and billing history stay available; rejection does not refund completed work.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={reject.isPending}>Keep storyboard</AlertDialogCancel>
          <Button variant="destructive" disabled={reject.isPending} data-testid="button-confirm-reject-storyboard"
            onClick={() => reject.mutate({ jobId: job.id, data: { confirmDeleteUnusedCharacters: true } }, {
              onSuccess: (saved) => {
                client.setQueryData(getGetVideoJobQueryKey(job.id), saved);
                void client.invalidateQueries({ queryKey: getListVideoJobsQueryKey() });
                void client.invalidateQueries({ queryKey: getListCharactersQueryKey() });
                if (job.guidedStoryDraftId) void client.invalidateQueries({ queryKey: getGetGuidedStoryDraftQueryKey(job.guidedStoryDraftId) });
                setOpen(false);
              },
              onError: (e) => setError(apiErrorMessage(e, "Could not reject this storyboard. Please try again.")),
            })}>
            {reject.isPending ? "Rejecting…" : "Reject and delete characters"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}