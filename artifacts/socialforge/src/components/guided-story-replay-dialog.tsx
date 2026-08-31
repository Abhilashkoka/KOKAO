import { useEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type VideoJob,
  type GuidedStoryDialogueReplayPreview,
  useConfirmGuidedStoryDialogueReplay,
  getListVideoJobsQueryKey,
  getGetVideoJobQueryKey,
  getWalletGetOverviewQueryKey,
} from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { RippleSpinner } from "@/components/ui/ripple-spinner";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { track, trackProjectEvent } from "@/lib/analytics";
import { Play, CheckCircle2, User, MicOff, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export function GuidedStoryReplayDialog({
  job,
  preview,
  open,
  onOpenChange,
  onSuccess,
}: {
  job: VideoJob;
  preview: GuidedStoryDialogueReplayPreview | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: (newJobId: number) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const confirmReplay = useConfirmGuidedStoryDialogueReplay();
  const trackedReviewFingerprint = useRef<string | null>(null);
  const idempotencyKey = useMemo(
    () => crypto.randomUUID(),
    [preview?.confirmationFingerprint],
  );

  useEffect(() => {
    if (
      !open ||
      !preview ||
      trackedReviewFingerprint.current === preview.confirmationFingerprint
    ) {
      return;
    }
    trackedReviewFingerprint.current = preview.confirmationFingerprint;
    const ownerlessNarration = preview.lines.some(
      (line) => line.speaker.type === "offscreen",
    );
    const dimensions = {
      line_count: preview.estimates.lineCount,
      operation_count: preview.estimates.units,
      has_ownerless_narration: ownerlessNarration,
    };
    track("dialogue_replay_review_opened", dimensions);
    trackProjectEvent("dialogue_replay_review_opened", dimensions);
  }, [open, preview]);

  if (!preview) return null;

  const roleLineCount = preview.lines.filter(
    (line) => line.speaker.type === "role",
  ).length;
  const offscreenLineCount = preview.lines.length - roleLineCount;

  const handleConfirm = () => {
    confirmReplay.mutate(
      {
        jobId: job.id,
        data: {
          confirmationFingerprint: preview.confirmationFingerprint,
          idempotencyKey,
        },
      },
      {
        onSuccess: (res) => {
          // res is { job, snapshot, operation }
          onOpenChange(false);

          // Invalidate wallet overview
          void queryClient.invalidateQueries({ queryKey: getWalletGetOverviewQueryKey() });
          // Invalidate jobs list
          void queryClient.invalidateQueries({ queryKey: getListVideoJobsQueryKey() });

          if (res.job) {
            trackProjectEvent("dialogue_replay_confirmed", {
              line_count: preview.estimates.lineCount,
              operation_count: preview.estimates.units,
              has_ownerless_narration: offscreenLineCount > 0,
            });
            queryClient.setQueryData(getGetVideoJobQueryKey(res.job.id), res.job);
            toast({
              title: "Dialogue replay started",
              description: `Job #${res.job.id} will synthesize lines and recompose the video.`,
            });
            onSuccess(res.job.id);
          }
        },
        onError: (error) => {
          toast({
            title: "Could not start replay",
            description: apiErrorMessage(error, "Please try again."),
            variant: "destructive",
          });
        },
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90dvh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Replay Native Dialogue</DialogTitle>
          <DialogDescription>
            Generate a new version of this video where the cast speaks their approved Telugu lines natively.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 -mx-6 px-6">
          <div className="space-y-6 py-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="rounded-lg border bg-card p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Original Job</span>
                  <Badge variant="outline">#{preview.sourceJobId}</Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Language</span>
                  <span className="text-sm font-medium">Telugu (Native)</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Subtitles</span>
                  <span className="text-sm font-medium">{preview.subtitles ? "Yes" : "No"}</span>
                </div>
              </div>
              
              <div className="rounded-lg border bg-primary/5 p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-primary">Lines to Generate</span>
                  <span className="text-sm font-bold text-primary">{preview.estimates.lineCount}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-primary/80">Estimated Duration</span>
                  <span className="text-sm font-medium text-primary">~{preview.estimates.durationSeconds}s</span>
                </div>
                <div className="flex items-center justify-between pt-2 border-t border-primary/10 mt-2">
                  <span className="text-sm font-medium text-primary">Units Required</span>
                  <span className="text-sm font-bold text-primary">{preview.estimates.units}</span>
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <h4 className="text-sm font-semibold flex items-center gap-2">
                <Play className="w-4 h-4" />
                Script Preview
              </h4>
              
              <div className="space-y-3">
                {preview.lines.map((line, idx) => (
                  <div key={line.lineId} className="rounded-md border bg-muted/30 p-3 flex gap-4">
                    <div className="flex-shrink-0 w-16 h-16 rounded overflow-hidden bg-black/10 relative">
                      <img
                        src={`/api/storage${line.preview.path}`}
                        alt={`Approved scene for ${line.sceneId}`}
                        className="w-full h-full object-cover"
                      />
                    </div>

                    <div className="flex-1 space-y-1">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 text-xs font-medium">
                          {line.speaker.type === "role" ? (
                            <span className="flex items-center gap-1 text-primary">
                              <User className="w-3 h-3" />
                              Role: {line.speaker.roleId}
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-muted-foreground">
                              <MicOff className="w-3 h-3" />
                              Offscreen
                            </span>
                          )}
                          <span className="text-muted-foreground ml-2">
                            {line.kind === "dialogue" ? "Dialogue" : "Narration"}
                          </span>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {Math.round(line.startMs / 1000)}s - {Math.round(line.endMs / 1000)}s
                        </div>
                      </div>
                      <p className="text-sm leading-relaxed" dir="auto">{line.text}</p>
                      {line.speaker.type === "role" && (
                        <p className="text-xs text-muted-foreground">
                          ElevenLabs voice: {line.speaker.voice.providerVoiceId}
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        Approved composition and backdrop reused from {line.sceneId}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-md bg-blue-50 dark:bg-blue-950/30 p-3 flex gap-3 text-sm text-blue-800 dark:text-blue-300">
              <Info className="w-5 h-5 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-medium mb-1">Expected Operations</p>
                <p>
                  This creates a new child job with {roleLineCount} separate
                  ElevenLabs voice calls, {roleLineCount} approved-frame
                  animations, and {roleLineCount} single-speaker lip-sync
                  operations. {offscreenLineCount > 0
                    ? `${offscreenLineCount} ownerless narration line${offscreenLineCount === 1 ? "" : "s"} will use off-screen audio only. `
                    : ""}
                  The visual work reserves {preview.estimates.units} video
                  units; voice synthesis is settled separately where applicable.
                  No images or subtitles will be generated.
                </p>
              </div>
            </div>
          </div>
        </ScrollArea>

        <DialogFooter className="mt-4 pt-4 border-t">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button 
            disabled={confirmReplay.isPending} 
            onClick={handleConfirm}
            className="min-w-[120px]"
          >
            {confirmReplay.isPending ? (
              <RippleSpinner className="w-4 h-4 mr-2" />
            ) : (
              <CheckCircle2 className="w-4 h-4 mr-2" />
            )}
            Confirm & Start
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}